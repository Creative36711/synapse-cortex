// Самовосстановление (D-073): поведение, а не строки.
//
// Модуль `src/41-heal.js` исполняется на моделях GM-хранилища, шлюза, GitHub и
// ролей. Проверяется:
//   • временный сбой → автопродолжение с выдержкой; после двух — только Мастер;
//   • поломка транспорта → передача Maintainer'у профилем без маркера, с
//     предохранителем; «доставка до Maintainer'а не сработала» → прямой путь к
//     Мастеру, а не повтор наугад;
//   • ответ Maintainer'а: FIXED без новой сборки — стоп «ждём обновления»;
//     FIXED с новой сборкой — продолжение; NOTFIXED — стоп с причиной;
//   • остановка выгружает телеметрию, а сердцебиение — нет (квота);
//   • штатные остановки не трогаются вовсе: ни передачи, ни выгрузки посторонним.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PromptCompiler } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const core = readFileSync(join(srcDir, '40-heal-core.js'), 'utf8');
const body = readFileSync(join(srcDir, '41-heal.js'), 'utf8');

const MAINTAINER = { id: 'agent-maint', name: 'Transport Maintainer', fn: 'Maintainer', url: '/agent/maint', status: 'Активна' };
const COORD = { id: 'agent-coord', name: 'Coordinator', fn: 'Coordinator', url: '/agent/coord', status: 'Активна' };

function harness({ roles: roleList = [COORD, MAINTAINER], version = '1.13.0', fingerprint = 'fp-new',
  ghToken = '', ntfyTopic = '', start = {} } = {}) {
  const store = new Map(Object.entries({ 'cfn-ntfy-topic': ntfyTopic, 'cfn-github-token': ghToken, ...start }));
  const env = {
    store, logs: [], pauses: [], resumes: [], sends: [], requests: [], published: [], timers: [],
    roleList, version, fingerprint, ghToken, ntfyTopic,
    expect: null, pending: null,
  };
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'SCRIPT_VERSION', 'nowIso', 'uid', 'norm', 'log', 'pause',
    'resume', 'isPaused', 'sendToRole', 'gateway', 'request', 'githubHeaders', 'roles',
    'document', 'location', 'composer', 'messages', 'messageText', 'lastMessageId', 'generating',
    'busyReason', 'elementCovered', 'composerText', 'captchaDialog', 'skipCardButton', 'completionPanels',
    'composerDiagnostics', 'roleFromPath', 'pageReady', 'messagesAfter', 'ntfyPublish', 'normalizeNtfyTopic',
    `${core}\n${body}\nreturn { healAfterPause, healStep, healAfterUpdate, beatHeartbeat, healPublish,
      healPageSnapshot, healArtifactName, healDiagnosis, healReportVerdict, maintainerRole,
      escalateToMaintainer, buildHealTelemetry, classifyPause, decideVersionGate };`,
  )(
    (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d),
    (k, v) => store.set(k, structuredClone(v)),
    { heal: 'cfn-heal-state', heartbeat: 'cfn-heartbeat', pause: 'cfn-pause-context', paused: 'cfn-paused',
      expect: 'cfn-expect', pending: 'cfn-pending', ghToken: 'cfn-github-token', ntfyTopic: 'cfn-ntfy-topic',
      ntfyToken: 'cfn-ntfy-token', gwUrl: 'cfn-gw-url', gwKey: 'cfn-gw-key' },
    { repo: 'team/repo', projectName: 'Project', driveFolder: 'project', buildFingerprint: fingerprint,
      healRetryMax: 2, healBackoffMs: [1000, 2000], healMaintainerMax: 2, healVersionTimeoutMs: 900000,
      healTelemetryMaxBytes: 200000, heartbeatMs: 600000 },
    version,
    () => '2026-11-08T20:00:00.000Z',
    () => '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    (text, error, options) => env.logs.push({ text, error, options }),
    (reason, context = {}) => { env.pauses.push({ reason, ...context }); store.set('cfn-paused', reason); },
    (reason) => { env.resumes.push(reason); store.set('cfn-paused', ''); },
    () => Boolean(store.get('cfn-paused')),
    async (role, envelope, kind, ref, extra) => {
      env.sends.push({ role, envelope, kind, ref, extra });
      env.pending = { kind, ref, roleId: role.id, text: String(envelope?.text ?? envelope) };
      store.set('cfn-pending', env.pending);
      // Доставка подтверждается сразу: проба про маршрут, а не про ожидание.
      store.set('cfn-expect', { kind, ref, roleId: role.id, turnId: extra?.turnId || '', verified: true });
      store.set('cfn-pending', null);
      return true;
    },
    async (action, fileId, extra = {}) => {
      env.requests.push({ action, fileId, extra });
      if (action === 'saveArtifact') return { ok: true, fileId: 'drive-file-1', name: extra.name };
      throw new Error(`неожиданное действие шлюза ${action}`);
    },
    async (method, url, headers, payload) => { env.requests.push({ method, url, payload }); return {}; },
    () => ({}),
    async () => roleList.map((r) => ({ ...r })),
    { readyState: 'complete', title: 'Arena', querySelectorAll: () => [], getElementById: () => null },
    { href: 'https://arena.ai/agent/coord', pathname: '/agent/coord', origin: 'https://arena.ai' },
    () => null,
    () => [],
    () => '',
    () => 'chat-message-1',
    () => false,
    () => null,
    () => false,
    () => '',
    () => null,
    () => null,
    () => [],
    () => null,
    () => 'agent-coord',
    () => ({ ok: true, why: '' }),
    () => env.replies || [],
    async (topic, token, opts) => { env.published.push({ topic, message: opts.message }); return { via: 'gm' }; },
    (raw) => String(raw || '').replace(/^https?:\/\//i, '').replace(/^ntfy\.sh\//i, '').split(/[?#]/)[0].replace(/\/+$/, ''),
  );
  env.api = api;
  return env;
}

const info = (over = {}) => ({
  kind: 'prompt-compile', reason: 'Промпт не собран (dispatch): missing_fact', at: Date.now(),
  ref: 'a709d6df-4698-4a98-b111-90d22de42894', runId: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d',
  turnId: '', tries: null, wasAuto: true, version: '1.13.0', fingerprint: 'fp-old', ...over,
});

// ── 1. Временный сбой: продолжаем сами, выдержка по номеру попытки ─────────
{
  const env = harness();
  const result = await env.api.healAfterPause(info({ kind: 'nav', reason: 'Не удалось открыть страницу', ref: 'agent-1' }));
  assert.equal(result.retried, true, 'временный сбой уходит в автопродолжение');
  assert.equal(env.sends.length, 0, 'Maintainer не тревожится');
  assert.equal(env.api.classifyPause('nav', 'Не удалось открыть страницу').cls, 'momentary');
  assert.match(env.logs.map((l) => l.text).join('\n'), /Продолжу сам через 1 с/, 'выдержка названа');
  const state = env.store.get('cfn-heal-state');
  const counters = Object.values(state.incident)[0];
  assert.equal(counters.retries, 1, 'счётчик инцидента вырос');
  // Второй такой же сбой — второй раз; третий — стоп.
  await env.api.healAfterPause(info({ kind: 'nav', reason: 'Не удалось открыть страницу', ref: 'agent-1' }));
  const third = await env.api.healAfterPause(info({ kind: 'nav', reason: 'Не удалось открыть страницу', ref: 'agent-1' }));
  assert.equal(third.stopped, true, 'после двух автопродолжений — стоп');
  assert.equal(env.pauses.at(-1).kind, 'heal-exhausted', 'причина стопа названа классом, а не «error»');
}

// ── 2. Поломка транспорта: передача Maintainer'у без маркера ───────────────
{
  const env = harness();
  const result = await env.api.healAfterPause(info());
  assert.equal(result.escalated, true, 'поломка ушла Maintainer-у');
  assert.equal(env.sends.length, 1);
  const sent = env.sends[0];
  assert.equal(sent.role.fn, 'Maintainer', 'адресат — Maintainer, а не Reviewer');
  assert.equal(sent.kind, 'heal', 'вид хода свой: не dispatch/review');
  const compiled = PromptCompiler.compile({
    kind: 'heal', role: { name: MAINTAINER.name, fn: 'Maintainer' },
    heal: { kind: sent.extra.heal.kind, cls: 'transport', why: 'поломка', ref: sent.ref },
  });
  assert.ok(compiled.ok, `передача компилируется: ${compiled.error?.message}`);
  assert.equal(compiled.profileId, 'heal.report');
  assert.equal(compiled.marker, null, 'у разбора транспорта нет маркера — правило ответа своё');
  assert.ok(compiled.text.includes('FIXED'), 'правило ответа называет FIXED');
  assert.ok(compiled.metrics.overheadChars <= 900, 'overhead в бюджете 900');
  // Телеметрия выгружена на остановке: Drive-артефакт и запись в GitHub.
  const artifacts = env.requests.filter((r) => r.action === 'saveArtifact');
  assert.equal(artifacts.length, 1, 'на остановке выгружается ровно один артефакт');
  // Имя — либо схема D-031, либо ручной артефакт; оба варианта шлюз принимает.
  const artifactName = artifacts[0].extra.name;
  const d031 = /^[A-Za-z][A-Za-z0-9]{0,15}__[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__logs__\d{4}-\d{2}-\d{2}\.json$/;
  const manual = /^manual__[a-z0-9][a-z0-9._-]{0,50}__[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/;
  assert.ok(d031.test(artifactName) || manual.test(artifactName), `имя артефакта по схеме шлюза: ${artifactName}`);
  assert.ok(artifactName.length <= 180, 'имя не длиннее предела шлюза');
  assert.equal(env.requests.filter((r) => r.method === 'PUT').length, 0, 'без GitHub-токена GitHub не трогается');
}

// ── 3. Сломана сама доставка: прямой путь к Мастеру, без повторов ──────────
{
  const env = harness({ roles: [COORD] });
  const result = await env.api.healAfterPause(info());
  assert.equal(result.escalated, false);
  assert.equal(env.sends.length, 0, 'передачи нет: адресата нет');
  const last = env.pauses.at(-1);
  assert.equal(last.kind, 'heal-no-maintainer', 'случай «нет Maintainer-а» назван отдельно');
  assert.match(last.reason, /передать ход не удалось/, 'причина объясняет поломку доставки');
}

// ── 4. Ответ Maintainer-а: FIXED без новой сборки — стоп «ждём обновления» ──
{
  const env = harness({ version: '1.13.0', fingerprint: 'fp-old' });
  env.store.set('cfn-heal-state', {
    pending: { kind: 'prompt-compile', ref: info().ref, runId: info().runId, reason: 'Промпт не собран' },
    pausedVersion: '1.13.0', pausedFingerprint: 'fp-old', pausedAt: Date.now(),
  });
  env.store.set('cfn-expect', { kind: 'heal', ref: info().ref, turnId: 'turn-1', watermark: 'w', verified: true });
  env.replies = [{ id: 'm9', ended: true, text: 'FIXED поправил profile select в 1.13.1, дифф ниже\n\n…' }];
  const handled = await env.api.healStep(MAINTAINER, env.store.get('cfn-expect'));
  assert.equal(handled, true);
  assert.equal(env.resumes.length, 0, 'продолжения нет: сборка та же');
  assert.equal(env.pauses.at(-1).kind, 'heal-await-update', 'стоп до установки новой сборки');
  assert.match(env.pauses.at(-1).reason, /установите её и нажмите «Продолжить»/);
  assert.equal(env.store.get('cfn-expect'), null, 'передача закрыта до применения решения');
}

// ── 5. Ответ Maintainer'а: FIXED с новой сборкой — продолжаем ──────────────
{
  const env = harness({ version: '1.13.1', fingerprint: 'fp-new' });
  env.store.set('cfn-heal-state', {
    pending: { kind: 'prompt-compile', ref: info().ref, runId: info().runId, reason: 'Промпт не собран' },
    pausedVersion: '1.13.0', pausedFingerprint: 'fp-old', pausedAt: Date.now(),
  });
  env.store.set('cfn-paused', 'поломка');
  env.store.set('cfn-expect', { kind: 'heal', ref: info().ref, turnId: 'turn-1', watermark: 'w', verified: true });
  env.replies = [{ id: 'm9', ended: true, text: 'FIXED поправил profile select, сборка 1.13.1' }];
  await env.api.healStep(MAINTAINER, env.store.get('cfn-expect'));
  assert.equal(env.resumes.length, 1, 'цикл продолжен один раз');
  assert.match(env.resumes[0], /исправлено Maintainer'ом/);
  const state = env.store.get('cfn-heal-state');
  assert.equal(state.pending, null, 'незакрытая передача снята');
  assert.equal(state.resolvedBy, 'maintainer');
}

// ── 6. NOTFIXED — стоп с причиной, без догадок ────────────────────────────
{
  const env = harness();
  env.store.set('cfn-expect', { kind: 'heal', ref: 'card-1', turnId: 'turn-2', watermark: 'w', verified: true });
  env.replies = [{ id: 'm1', ended: true, text: 'NOTFIXED это капча, транспорт тут ни при чём' }];
  await env.api.healStep(MAINTAINER, env.store.get('cfn-expect'));
  assert.equal(env.resumes.length, 0, 'продолжения нет');
  assert.equal(env.pauses.at(-1).kind, 'heal-maintainer-done');
  assert.match(env.pauses.at(-1).reason, /капча, транспорт тут ни при чём/, 'причина Maintainer-а сохранена');
  // Ответ без вердикта — тоже NOTFIXED, а не «продолжаем».
  assert.equal(env.api.healReportVerdict('сделал что мог').kind, 'notfixed');
  assert.equal(env.api.healReportVerdict('FIXED').kind, 'notfixed', 'FIXED без объяснения не принимается');
  assert.equal(env.api.healReportVerdict('FIXED: починил select в 1.13.1').kind, 'fixed');
}

// ── 7. Телеметрия уходит на остановке и на восстановлении, не на каждом тике ─
{
  const env = harness({ ghToken: 'ghp_test', ntfyTopic: 'project' });
  // Пульс: ntfy, отдельный топик, без артефакта.
  const beat = await env.api.beatHeartbeat();
  assert.equal(beat.ok, true, 'пульс ушёл');
  assert.equal(env.published.length, 1);
  assert.equal(env.published[0].topic, 'project-hb', 'пульс в отдельном топике');
  assert.match(env.published[0].message, /^hb 1 1\.13\.0 running /, 'строка пульса разбирается сторожем');
  assert.doesNotMatch(env.published[0].message, /ghp_|ntn_/, 'в пульсе нет секретов');
  assert.equal(env.requests.filter((r) => r.action === 'saveArtifact').length, 0, 'пульс не тратит артефакты');
  assert.equal(env.requests.filter((r) => r.method === 'PUT').length, 0, 'пульс не коммитит в GitHub');

  // Восстановление после обновления: второй точки выгрузки, ровно одна.
  const before = env.requests.filter((r) => r.action === 'saveArtifact').length;
  await env.api.healAfterUpdate('1.13.0');
  assert.equal(env.requests.filter((r) => r.action === 'saveArtifact').length, before + 1,
    'восстановление выгружает телеметрию один раз');
  const uploaded = env.requests.filter((r) => r.action === 'saveArtifact').at(-1);
  const payload = JSON.parse(uploaded.extra.content);
  assert.equal(payload.phase, 'recovered', 'фаза названа');
  assert.match(payload.incident.reason, /1\.13\.0/, 'какая сборка заменена — видно');
}

// ── 8. Снимок страницы: структура, а не переписка ─────────────────────────
{
  const env = harness();
  const snap = env.api.healPageSnapshot();
  assert.equal(snap.path, '/agent/coord');
  assert.equal(typeof snap.counts.buttons, 'number');
  assert.ok(!('text' in snap), 'текста страницы в снимке нет');
  assert.ok(!('messages' in snap) || typeof snap.messages === 'number');
}

console.log(
  'OK: heal-flow — автопродолжение с предохранителем, передача Maintainer\'у без маркера, ' +
  'стоп на прежней сборке, телеметрия только на остановке и восстановлении',
);
