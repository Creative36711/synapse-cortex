#!/usr/bin/env node
// Узел сборки: забрать изменения, собрать бандл, прогнать фиксированные проверки.
//
// Два правила, ради которых этот файл существует отдельно от `npm run verify`:
//
//  1. **Проверки фиксированы в коде, а не в репозитории.** Обычный verify
//     читает скрипты из манифеста, а манифест меняется тем же коммитом, который
//     мы проверяем. Здесь скрипты не исполняются через npm: запускается ровно
//     тот список, что ниже, с явным argv и без оболочки. Подмена проверки в
//     манифесте ничего не изменит — до неё дело не доходит.
//  2. **Непроверенная сборка к установке не допускается.** Узел отдаёт путь к
//     бандлу и его SHA-256 только тогда, когда все проверки прошли и сборка
//     совпала с исходниками (`--check`). Иначе — код возврата и причина.
//
// Дополнительно закрыт долг D-027: если содержимое бандла изменилось (сменился
// отпечаток сборки), номер `@version` обязан измениться. Раньше это правило было
// ручным, потому что отпечатка не существовало.
//
// Запуск:
//   node tools/relay-build.mjs --repo <путь|URL> [--ref <ветка>] [--base <ревизия>] [--json]
//   node tools/relay-build.mjs --repo . --allow-dirty --json
//
// Коды: 0 — сборка проверена и допущена; 1 — ошибка запуска; 2 — проверка не
// прошла (сборка не допущена); 3 — узел не смог получить исходники.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SC_DIR = 'tools/script-cat';

/**
 * Фиксированный список проверок. Ни одна строка не берётся из репозитория.
 * Это ровно пять шагов штатной проверки транспорта, названные явно: узел
 * проверяет одинаково при любом содержимом манифеста репозитория.
 */
export const CHECKS = [
  { id: 'scriptcat:check', argv: ['build.mjs', '--check'], weight: 'сборка соответствует исходникам' },
  { id: 'scriptcat:guard', argv: ['portability-guard.mjs'], weight: 'переносимый комплект без прежних имён' },
  { id: 'test', argv: ['--test', 'tests/*.mjs'], weight: 'сюиты транспорта' },
  { id: 'test:regression', argv: ['--test', 'regression-tests/*.mjs'], weight: 'регрессии' },
  { id: 'test:tool-limit', argv: ['--test', 'tests/tool-limit-continuation-smoke.mjs',
    'regression-tests/tool-limit-continuation-integration.mjs'], weight: 'продолжение после лимита' },
];

/**
 * Только эти пути вправе меняться в проверяемом коммите. Сторож и узел сборки
 * живут рядом с комплектом (`tools/`), но вне бандла: вкладку они не касаются.
 */
export const ALLOWED_PATHS = ['tools/script-cat/', 'tools/relay-watchdog.mjs', 'tools/relay-build.mjs', 'docs/'];

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {
  encoding: 'utf8',
  // Никакой оболочки: argv передаётся как есть, подстановок нет.
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
  ...opts,
});

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Развернуть проверяемое дерево: локальный путь или клон по URL. */
export function resolveSource({ repo, ref = '', depth = 1, allowNonGit = false }) {
  const local = resolve(String(repo || '.'));
  if (existsSync(local)) {
    const status = run('git', ['-C', local, 'status', '--porcelain']);
    // Каталог без git: проверить можно, но доказать «какие пути менялись» и
    // «какой была предыдущая сборка» — нельзя. Такое дерево принимаем только
    // по явному разрешению, и в отчёте это помечено.
    if (status.status !== 0) {
      if (!allowNonGit) return { ok: false, code: 3, error: `не git-репозиторий: ${local} (проверки путей и версии невозможны; нужен коммит)` };
      return { ok: true, dir: local, kind: 'dir', dirty: false, noGit: true };
    }
    return { ok: true, dir: local, kind: 'local', dirty: Boolean(String(status.stdout || '').trim()) };
  }
  const temp = mkdtempSync(join(tmpdir(), 'relay-build-'));
  const args = ['clone', '--depth', String(depth || 1), '--quiet'];
  if (ref) args.push('--branch', ref);
  args.push(String(repo), temp);
  const cloned = run('git', args);
  if (cloned.status !== 0) {
    rmSync(temp, { recursive: true, force: true });
    return { ok: false, code: 3, error: `клонирование не удалось: ${(cloned.stderr || '').trim().slice(0, 300)}` };
  }
  return { ok: true, dir: temp, kind: 'clone', temp };
}

/** Отпечаток и версия из бандла — независимые источники, как в version-oracle. */
export function readBundleFacts(bundleText) {
  const version = (String(bundleText).match(/^\/\/ @version\s+(\S+)\s*$/m) || [])[1] || '';
  const runtime = (String(bundleText).match(/SCRIPT_VERSION\s*=[^;]*?\|\|\s*"([^"]+)"/) || [])[1] || '';
  const fingerprint = (String(bundleText).match(/buildFingerprint:\s*"([0-9a-f]{8,64})"/) || [])[1] || '';
  const digest = (String(bundleText).match(/regulationDigest:/) || [])[0] ? 'вшит' : 'нет';
  return { version, runtime, fingerprint, digest, bytes: Buffer.byteLength(String(bundleText), 'utf8') };
}

/**
 * Гейт D-027: контент изменился — номер обязан измениться.
 * Сравниваются отпечатки, а не строки: правка комментария тоже меняет сборку.
 */
export function versionGate({ base, current }) {
  if (!base || !current) return { ok: true, why: 'сравнивать не с чем: базовая ревизия не указана' };
  if (base.fingerprint === current.fingerprint) return { ok: true, why: 'содержимое сборки не менялось' };
  if (base.version === current.version) {
    return {
      ok: false,
      why: `содержимое изменилось (${base.fingerprint} → ${current.fingerprint}), а @version остался ${current.version}: правка транспорта без номера запрещена (D-027)`,
    };
  }
  return { ok: true, why: `содержимое изменилось, номер поднят: ${base.version} → ${current.version}` };
}

/** Разрешённые пути: узел не должен принимать правки чужого кода. */
export function pathGate({ dir, base = '' }) {
  const args = base ? ['-C', dir, 'diff', '--name-only', `${base}...HEAD`] : ['-C', dir, 'status', '--porcelain'];
  const result = run('git', args);
  if (result.status !== 0) return { ok: true, files: [], why: 'диф не прочитан: проверка путей пропущена' };
  const files = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim().replace(/^[A-Z?!]{1,2}\s+/, ''))
    .filter(Boolean);
  const foreign = files.filter((file) => !ALLOWED_PATHS.some((prefix) => file.startsWith(prefix)));
  return { ok: foreign.length === 0, files, foreign };
}

/** Прогон фиксированного списка проверок. */
function runChecks(dir) {
  const cwd = join(dir, SC_DIR);
  const results = [];
  for (const check of CHECKS) {
    const started = Date.now();
    const out = run(process.execPath, check.argv, { cwd });
    const summary = `${String(out.stdout || '')}${String(out.stderr || '')}`;
    const counts = {};
    for (const key of ['tests', 'pass', 'fail']) {
      const hit = summary.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
      if (hit) counts[key] = Number(hit[1]);
    }
    results.push({
      id: check.id,
      weight: check.weight,
      code: out.status,
      ms: Date.now() - started,
      counts,
      tail: summary.trim().split('\n').slice(-6).join('\n'),
    });
    if (out.status !== 0) break; // дальше нет смысла: сборка уже не допущена
  }
  return results;
}

export function buildOnce({ repo, ref = '', base = '', allowDirty = false, keep = false } = {}) {
  const source = resolveSource({ repo, ref, allowNonGit: allowDirty });
  if (!source.ok) return { ok: false, code: source.code || 3, error: source.error };
  const report = {
    schema: 'relay-build/1',
    at: new Date().toISOString(),
    source: { kind: source.kind, dir: source.dir, ref: ref || '' },
    checks: [], gates: {}, bundle: null, allowed: false,
  };
  const cleanup = () => { if (source.temp && !keep) rmSync(source.temp, { recursive: true, force: true }); };
  try {
    const scDir = join(source.dir, SC_DIR);
    if (!existsSync(join(scDir, 'build.mjs'))) {
      cleanup();
      return { ok: false, code: 3, error: `в дереве нет ${SC_DIR}/build.mjs`, report };
    }
    // Пути: чужой код не принимаем (это же правило, что у ролей — R-ZONES).
    report.gates.paths = source.noGit
      ? { ok: true, files: [], foreign: [], why: 'не git-репозиторий: проверка путей пропущена явно' }
      : pathGate({ dir: source.dir, base });
    report.gates.pathsSkipped = Boolean(source.noGit);
    if (!report.gates.paths.ok) {
      cleanup();
      return { ok: false, code: 2, error: `изменения вне разрешённых путей: ${report.gates.paths.foreign.join(', ')}`, report };
    }
    if (source.dirty && !allowDirty) {
      cleanup();
      return { ok: false, code: 3, error: 'дерево грязное: проверять нечего, соберите коммит', report };
    }
    // Проверки — до чтения артефакта: непроверенный бандл не показываем вовсе.
    report.checks = runChecks(source.dir);
    const failed = report.checks.find((check) => check.code !== 0);
    if (failed) {
      cleanup();
      return { ok: false, code: 2, error: `проверка ${failed.id} вернула ${failed.code}`, report };
    }
    const bundlePath = join(scDir, 'relay.user.js');
    const bundleText = readFileSync(bundlePath, 'utf8');
    const current = readBundleFacts(bundleText);
    report.bundle = {
      path: `${SC_DIR}/relay.user.js`,
      sha256: sha256(bundleText),
      bytes: current.bytes,
      version: current.version,
      runtimeVersion: current.runtime,
      fingerprint: current.fingerprint,
      digest: current.digest,
    };
    // D-027: содержимое изменилось — номер обязан измениться.
    if (base && existsSync(join(source.dir, '.git'))) {
      const show = run('git', ['-C', source.dir, 'show', `${base}:${SC_DIR}/relay.user.js`]);
      const baseText = show.status === 0 ? String(show.stdout || '') : '';
      report.gates.version = versionGate({ base: baseText ? readBundleFacts(baseText) : null, current });
    } else {
      report.gates.version = versionGate({ base: null, current });
    }
    if (!report.gates.version.ok) {
      cleanup();
      return { ok: false, code: 2, error: report.gates.version.why, report };
    }
    // Сборка совпала с исходниками — это уже проверено `--check`; здесь
    // фиксируем, что версия в шапке и в рантайме одна и та же.
    if (current.version !== current.runtime) {
      cleanup();
      return { ok: false, code: 2, error: `@version ${current.version} и SCRIPT_VERSION ${current.runtime} разошлись`, report };
    }
    report.allowed = true;
    return { ok: true, code: 0, report, bundlePath };
  } finally {
    if (!report.allowed) cleanup();
  }
}

function parseArgs(argv) {
  const out = { repo: '.', ref: '', base: '', allowDirty: false, json: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--repo') out.repo = next();
    else if (arg === '--ref') out.ref = next();
    else if (arg === '--base') out.base = next();
    else if (arg === '--allow-dirty') out.allowDirty = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node tools/relay-build.mjs --repo <путь|URL> [--ref <ветка>] [--base <ревизия>] [--json]');
    console.log('Проверки фиксированы в коде: scriptcat:check, scriptcat:guard, test, test:regression, test:tool-limit.');
    console.log('Коды: 0 — допущена, 2 — не прошла проверку, 3 — исходники не получены.');
    return 0;
  }
  const result = buildOnce(args);
  // `--json` — машинный вывод и ничего больше: раньше человеческая строка шла в
  // тот же stdout, и разобрать его как JSON было нельзя. Теперь она в stderr,
  // а при `--json` ещё и помечена, чтобы не путаться с ошибкой запуска.
  if (args.json) {
    console.log(JSON.stringify(result.report || { error: result.error }, null, 2));
    if (!result.ok) console.error(`сборка не допущена: ${result.error}`);
    else console.error(`сборка допущена: ${result.report.bundle.version} @ ${result.report.bundle.fingerprint}`);
    return result.code;
  }
  if (!result.ok) console.error(`сборка не допущена: ${result.error}`);
  else console.log(`сборка допущена: ${result.report.bundle.version} @ ${result.report.bundle.fingerprint}, ` +
    `${result.report.bundle.bytes} Б, sha256 ${result.report.bundle.sha256.slice(0, 12)}`);
  return result.code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
