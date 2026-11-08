// Узел сборки (D-073, пункт 5): проверки фиксированы, непроверенная сборка не
// допускается.
//
// Главный тест — негативный: в проверяемом дереве подменяется `npm run verify`
// (и `test`) на команду, которая «проходит», ничего не проверяя. Узел обязан
// этого не заметить не потому, что «не доверяет», а потому, что он вообще не
// исполняет скрипты из package.json: список проверок записан в коде.
import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { versionGate, readBundleFacts, CHECKS, ALLOWED_PATHS } from '../../relay-build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scDir = join(here, '..');
const repoRoot = join(scDir, '..', '..');
const bundle = readFileSync(join(scDir, 'relay.user.js'), 'utf8');

// ── 1. Список проверок совпадает с npm run verify, но не читается из него ──
{
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const verify = pkg.scripts.verify;
  for (const check of CHECKS) {
    assert.ok(verify.includes(check.id), `npm run verify содержит ${check.id}`);
  }
  const node = readFileSync(join(repoRoot, 'tools', 'relay-build.mjs'), 'utf8');
  assert.doesNotMatch(node, /pkg\.scripts|scripts\.verify|npm\.run|child_process['"]\)\.exec/, 'узел не берёт список проверок из манифеста репозитория');
  assert.doesNotMatch(node, /readJson\([^)]*package\.json/, 'манифест репозитория узлом не читается');
  assert.match(node, /export const CHECKS = \[/, 'список проверок записан в коде');
  assert.match(node, /shell: false/, 'оболочки нет: argv передаётся как есть');
  assert.equal(ALLOWED_PATHS.includes('tools/script-cat/'), true, 'зона правок названа явно');
}

// ── 2. Факты бандла читаются из независимых источников ─────────────────────
{
  const facts = readBundleFacts(bundle);
  assert.match(facts.version, /^\d+\.\d+\.\d+$/, 'версия из шапки');
  assert.equal(facts.version, facts.runtime, '@version и SCRIPT_VERSION совпадают');
  assert.match(facts.fingerprint, /^[0-9a-f]{16}$/, 'отпечаток сборки вшит');
  assert.equal(facts.digest, 'вшит', 'краткий регламент вшит');
  assert.ok(facts.bytes > 1000000, `бандл ${facts.bytes} Б`);
}

// ── 3. Гейт D-027: контент изменился — номер обязан измениться ─────────────
{
  const base = { version: '1.12.21', fingerprint: 'aaaaaaaaaaaaaaaa', bytes: 1 };
  assert.equal(versionGate({ base, current: { ...base } }).ok, true, 'ничего не менялось — пропуск');
  const sameNumber = versionGate({ base, current: { version: '1.12.21', fingerprint: 'bbbbbbbbbbbbbbbb', bytes: 2 } });
  assert.equal(sameNumber.ok, false, 'изменилось содержимое без подъёма номера — не пропуск');
  assert.match(sameNumber.why, /D-027/, 'причина названа решением');
  const raised = versionGate({ base, current: { version: '1.13.0', fingerprint: 'bbbbbbbbbbbbbbbb', bytes: 2 } });
  assert.equal(raised.ok, true, 'номер поднят — пропуск');
  assert.match(raised.why, /1\.12\.21 → 1\.13\.0/, 'подъём назван числами');
  assert.equal(versionGate({ base: null, current: base }).ok, true, 'без базы сравнивать не с чем');
}

// ── 4. Негативный тест: подмена verify в проверяемом дереве не работает ────
{
  const temp = mkdtempSync(join(tmpdir(), 'relay-build-node-'));
  try {
    for (const path of ['tools/script-cat', 'tools/relay-build.mjs', 'package.json', 'docs']) {
      cpSync(join(repoRoot, path), join(temp, path), { recursive: true });
    }
    // Подменяем ИМЕННО то, чем прежняя проверка себя проверяла.
    const pkgPath = join(temp, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.scripts.verify = 'node -e "process.exit(0)"';
    pkg.scripts.test = 'node -e "process.exit(0)"';
    pkg.scripts['test:regression'] = 'node -e "process.exit(0)"';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    // И ломаем настоящую проверку: так видно, что узел исполняет код, а не package.json.
    const guardPath = join(temp, 'tools/script-cat/portability-guard.mjs');
    writeFileSync(guardPath, 'process.exit(7);\n', 'utf8');
    const run = spawnSync(process.execPath, [join(temp, 'tools/relay-build.mjs'), '--repo', temp, '--json', '--allow-dirty'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 2, 'подмена npm-скриптов не спасает: узел возвращает «не допущена»');
    const report = JSON.parse(run.stdout);
    assert.equal(report.allowed, false);
    const failed = report.checks.find((c) => c.code !== 0);
    assert.ok(failed, 'проваленная проверка названа');
    assert.equal(failed.id, 'scriptcat:guard', 'провалилась настоящая проверка, а не подменённая');
    assert.equal(failed.code, 7, 'код возврата проверки сохранён');
    assert.equal(report.bundle, null, 'непроверенная сборка к установке не отдаётся');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ── 5. Чужой код в коммите не принимается ─────────────────────────────────
{
  const temp = mkdtempSync(join(tmpdir(), 'relay-build-node-paths-'));
  try {
    for (const path of ['tools/script-cat', 'tools/relay-build.mjs', 'package.json']) {
      cpSync(join(repoRoot, path), join(temp, path), { recursive: true });
    }
    const git = (args) => spawnSync('git', ['-C', temp, ...args], { encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 'probe@example.invalid']);
    git(['config', 'user.name', 'probe']);
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(temp, 'src-hack.js'), '// чужой код\n', 'utf8');
    const run = spawnSync(process.execPath, [join(temp, 'tools/relay-build.mjs'), '--repo', temp, '--json', '--allow-dirty'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(run.status, 2, 'правка вне разрешённых путей не допускается');
    const report = JSON.parse(run.stdout);
    assert.deepEqual(report.gates.paths.foreign, ['src-hack.js'], 'чужой файл назван');
    assert.equal(report.bundle, null);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// ── 6. Коды возврата и справка: «локально работает» не выдаётся за проверку ─
{
  const help = spawnSync(process.execPath, [join(repoRoot, 'tools/relay-build.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Коды: 0 — допущена, 2 — не прошла проверку, 3 — исходники не получены/);
  const missing = mkdtempSync(join(tmpdir(), 'relay-build-node-empty-'));
  try {
    const run = spawnSync(process.execPath, [join(repoRoot, 'tools', 'relay-build.mjs'), '--repo', missing, '--json'],
      { encoding: 'utf8' });
    assert.equal(run.status, 3, 'дерево без сборки — «исходники не получены», а не «проверено»');
    assert.match(run.stderr, /сборка не допущена/);
  } finally {
    rmSync(missing, { recursive: true, force: true });
  }
  assert.ok(existsSync(join(repoRoot, 'tools/relay-watchdog.mjs')), 'сторож лежит рядом с узлом');
}

console.log('OK: relay-build — проверки фиксированы в коде, подмена package.json не проходит, ' +
  'чужой код и непроверенная сборка не допускаются, коды возврата названы');
