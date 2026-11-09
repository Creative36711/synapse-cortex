// D-084 — «ответ без маркера» после всех напоминаний больше не зовёт Мастера.
//
// Боевой случай 09.11 (≈18:20): Warden дважды прислал маркер CF_ANSWER_RESULT
// прямо в тексте ответа (сообщения 01a1c0e3-70b4… и 01a1c0e6-5215…), а
// транспорт оба раза отрапортовал «без маркера» и поставил паузу
// «Нужен Мастер: проверьте страницу агента». Маркер был рядом — не хватало
// разбора, то есть чинил это транспорт, а не человек. Мастер в таких случаях
// не понадобился ни разу.
//
// Проверяется маршрут, а не строка:
//   • пауза `kind:"marker"` — класс transport, адресат Transport Maintainer;
//   • бриф разбора называет, чего именно не хватило (дефект, маркер, роль);
//   • дефект переживает передачу и остановку «ждём новой сборки»;
//   • предохранитель остаётся: два разбора на инцидент, дальше стоп;
//   • соседние виды пауз не сдвинулись: `marker-mismatch`, `review-marker`,
//     `answer-marker` по-прежнему за Мастером;
//   • в самом `markerMissing` слова «Нужен Мастер» больше нет.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const bundle = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(bundle);

const core = readFileSync(join(srcDir, '40-heal-core.js'), 'utf8');
const body = readFileSync(join(srcDir, '41-heal.js'), 'utf8');
const missing = readFileSync(join(srcDir, '14-missing-marker.js'), 'utf8');

const MAINTAINER = { id: 'agent-maint', name: 'Transport Maintainer', fn: 'Maintainer', url: '/agent/maint', status: 'Активна' };
const COORD = { id: 'agent-coord', name: 'Coordinator', fn: 'Coordinator', url: '/agent/coord', status: 'Активна' };

/** Модель окружения 41-heal: хранилище, роли, шлюз, отправка, пауза. */
function harness({ roles: roleList = [COORD, MAINTAINER], version = '1.14.12', fingerprint = 'fp-new' } = {}) {
  const store = new Map();
  const env = { store, logs: [], pauses: [], resumes: [], sends: [], requests: [], published: [], replies: [] };
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'SCRIPT_VERSION', 'nowIso', 'uid', 'norm', 'log', 'pause',
    'resume', 'isPaused', 'sendToRole', 'gateway', 'request', 'githubHeaders', 'roles',
    'document', 'location', 'composer', 'messages', 'messageText', 'lastMessageId', 'generating',
    'busyReason', 'elementCovered', 'composerText', 'captchaDialog', 'skipCardButton', 'completionPanels',
    'composerDiagnostics', 'roleFromPath', 'pageReady', 'messagesAfter', 'ntfyPublish', 'normalizeNtfyTopic',
    `${core}\n${body}\nreturn { healAfterPause, healStep, healDiagnosis, classifyPause, decideHeal,
      healIncidentKey, buildHealTelemetry, escalateToMaintainer, maintainerRole, healUpload };`,
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
    () => '2026-11-09T18:20:00.000Z',
    () => '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    (text, error, options) => env.logs.push({ text, error, options }),
    (reason, context = {}) => { env.pauses.push({ reason, ...context }); store.set('cfn-paused', reason); },
    (reason) => { env.resumes.push(reason); store.set('cfn-paused', ''); },
    () => Boolean(store.get('cfn-paused')),
    async (role, envelope, kind, ref, extra) => {
      env.sends.push({ role, envelope, kind, ref, extra });
      store.set('cfn-expect', { kind, ref, roleId: role.id, turnId: extra?.turnId || '', verified: true, heal: extra?.heal });
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
    () => null, () => [], () => '',
    () => 'chat-message-1',
    () => false,
    () => null, () => false, () => '', () => null, () => null, () => [], () => null, () => 'agent-coord',
    () => ({ ok: true, why: '' }),
    () => env.replies,
    async (topic, token, opts) => { env.published.push({ topic, message: opts.message }); return { via: 'gm' }; },
    (raw) => String(raw || '').replace(/^https?:\/\//i, '').replace(/^ntfy\.sh\//i, '').split(/[?#]/)[0].replace(/\/+$/, ''),
  );
  env.api = api;
  return env;
}

/** Остановка «ответ без маркера после всех напоминаний» с дефектом. */
const markerPause = (over = {}) => ({
  kind: 'marker', at: Date.now(),
  reason: 'Warden ответил без маркера CF_ANSWER_RESULT после 2 напоминаний. ' +
    'Это дефект разбора или доставки маркера, а не работа агента: передаю разбор транспорту — ' +
    'имени CF_ANSWER_RESULT в ответе нет — разобрать нечего. Копия ответа сохранена локально; ожидание не снято.',
  ref: 'a709d6df-4698-4a98-b111-90d22de42894', runId: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d',
  turnId: 'turn-9', tries: 2, wasAuto: true, version: '1.14.12', fingerprint: 'fp-old',
  defect: { kind: 'hint', hint: 'имени CF_ANSWER_RESULT в ответе нет — разобрать нечего',
    marker: 'CF_ANSWER_RESULT', role: 'Warden', tail: '…CF_ANSWER_RESULT {"verdict":"answer"}' },
  ...over,
});

// ── 1. Классификация: «нет маркера» — поломка транспорта, а не решение ─────
{
  const env = harness();
  const v = env.api.classifyPause('marker', markerPause().reason);
  assert.equal(v.cls, 'transport', 'маркер без разбора — класс transport');
  assert.equal(v.route, 'maintainer', 'маршрут — Transport Maintainer, а не Мастер');
  assert.equal(v.repair, 'maintainer', 'чинит транспорт');
  assert.equal(env.api.decideHeal(v, {}, {}).action, 'maintainer', 'первый разбор уходит Maintainer-у');
}

// ── 2. Передача: адресат, бриф, телеметрия ────────────────────────────────
{
  const env = harness();
  const result = await env.api.healAfterPause(markerPause());
  assert.equal(result.escalated, true, 'ход ушёл транспорту');
  assert.equal(env.pauses.length, 0, 'паузы «Нужен Мастер» нет');
  assert.equal(env.sends.length, 1, 'ровно одна передача');
  const sent = env.sends[0];
  assert.equal(sent.role.fn, 'Maintainer', 'адресат — Maintainer');
  assert.equal(sent.role.name, 'Transport Maintainer', 'имя роли из базы «Роли»');
  assert.equal(sent.kind, 'heal', 'вид хода свой, маркера не ждём');
  const text = String(typeof sent.envelope === 'object' && sent.envelope ? sent.envelope.text : sent.envelope ?? '');
  assert.match(text, /CF_ANSWER_RESULT/, 'бриф называет маркер, которого не разобрали');
  assert.match(text, /Warden/, 'бриф называет роль, чей ответ не разобрался');
  assert.match(text, /имени CF_ANSWER_RESULT в ответе нет/, 'бриф называет дефект словами разбора');
  assert.match(text, /Хвост ответа/, 'бриф говорит, где искать хвост');
  assert.ok(!/Нужен Мастер/.test(text), 'брифа для Мастера больше нет');
  assert.match(text, /FIXED/, 'правило ответа Maintainer-а на месте');
  // Дефект переживает передачу: иначе «FIXED» нечем проверить.
  const state = env.store.get('cfn-heal-state');
  assert.equal(state.pending.defect.marker, 'CF_ANSWER_RESULT', 'дефект лежит в состоянии передачи');
  assert.equal(sent.extra.heal.defect.marker, 'CF_ANSWER_RESULT', 'дефект едет и в ожидании хода');
  // Шаг передачи засчитан: предохранитель не обнуляется сам собой.
  const counters = Object.values(state.incident)[0];
  assert.equal(counters.escalations, 1, 'передача засчитана в счётчике инцидента');
}

// ── 3. Предохранитель: два разбора на инцидент, дальше стоп ───────────────
{
  const env = harness();
  const first = await env.api.healAfterPause(markerPause());
  assert.equal(first.escalated, true, 'первый разбор — транспорт');
  const second = await env.api.healAfterPause(markerPause());
  assert.equal(second.escalated, true, 'второй разбор — ещё транспорт');
  const third = await env.api.healAfterPause(markerPause());
  assert.notEqual(third.escalated, true, 'третий раз того же инцидента транспорту не уходит');
  assert.equal(third.stopped, true, 'третий раз — остановка, а не третья передача');
  assert.equal(env.sends.length, 2, 'больше двух передач на инцидент нет');
  assert.equal(env.pauses.at(-1).kind, 'heal-exhausted', 'исчерпание предохранителя названо своим видом');
  assert.equal(env.pauses.at(-1).quiet, true, 'после разбора телефон не звонит');
}

// ── 4. Дефект доезжает до остановки «ждём новой сборки» ───────────────────
{
  const env = harness({ version: '1.14.12', fingerprint: 'fp-old' });
  env.store.set('cfn-heal-state', {
    pending: { kind: 'marker', ref: markerPause().ref, runId: markerPause().runId, reason: 'маркера нет',
      defect: markerPause().defect },
    pausedVersion: '1.14.12', pausedFingerprint: 'fp-old', pausedAt: Date.now(),
  });
  env.store.set('cfn-expect', { kind: 'heal', ref: markerPause().ref, turnId: 'turn-h', watermark: 'w', verified: true });
  env.replies = [{ id: 'm9', ended: true, text: 'FIXED поправил разбор маркера в 1.14.13' }];
  await env.api.healStep(MAINTAINER, env.store.get('cfn-expect'), true);
  const last = env.pauses.at(-1);
  assert.equal(last.kind, 'heal-await-update', 'без новой сборки ход не продолжается');
  assert.equal(last.heal?.defect?.marker, 'CF_ANSWER_RESULT', 'дефект переехал в следующую остановку');
}

// ── 5. Ключ инцидента: разные дефекты — разные инциденты ──────────────────
{
  const env = harness();
  const a = env.api.healIncidentKey(markerPause({ defect: { kind: 'hint', marker: 'CF_ANSWER_RESULT' } }));
  const b = env.api.healIncidentKey(markerPause({ defect: { kind: 'hint', marker: 'CF_COORDINATOR_RESULT' } }));
  assert.notEqual(a, b, 'другой маркер — другой инцидент, предохранитель не сгорает на чужой поломке');
  const c = env.api.healIncidentKey(markerPause({ ref: 'other-card' }));
  assert.notEqual(a, c, 'другая карточка — другой инцидент');
}

// ── 6. Соседние виды пауз не сдвинулись ───────────────────────────────────
{
  const env = harness();
  for (const kind of ['marker-mismatch', 'review-marker', 'answer-marker', 'arbiter-marker']) {
    const v = env.api.classifyPause(kind, 'ожидание изменилось');
    assert.equal(v.cls, 'master', `${kind}: остаётся за Мастером`);
    assert.equal(v.route, 'master', `${kind}: маршрут к Мастеру`);
  }
}

// ── 7. Источник: лестница напоминаний больше не обещает Мастера ───────────
{
  const ladder = missing.slice(missing.indexOf('async function markerMissing('),
    missing.indexOf('// ───────────────────────── ошибка на экране'));
  assert.ok(ladder.length > 500, 'ветка напоминаний найдена в исходнике');
  assert.ok(!/Нужен Мастер/.test(ladder), 'в маркерной лестнице нет «Нужен Мастер»');
  assert.match(ladder, /kind: "marker"/, 'пауза остаётся видом marker — маршрут решает ядро');
  assert.match(ladder, /heal: \{[\s\S]{0,200}?hint: markerDefectHint\(/, 'пауза несёт дефект словами разбора');
  assert.match(ladder, /Копия ответа сохранена локально/, 'копия ответа сохраняется для разбора');
  assert.match(ladder, /markerName\b/, 'вид паузы знает, какой маркер не разобрали');
  // Слова «Нужен Мастер» остаются только там, где Мастер правда нужен.
  const masters = [...bundle.matchAll(/Нужен Мастер/g)].length;
  assert.ok(masters > 0, 'в других местах Мастер по-прежнему вызывается');
  assert.match(missing, /markerDefectHint\(why, defect, markerName\)/,
    'подсказка о дефекте — одна функция, а не пять копий текста');
}

// ── D-086: телеметрия не пишет в репозиторий проекта.
// 09.11 в main лежало 17 коммитов `telemetry:` — все прямые пуши мимо приёмки.
{
  const env = harness({ version: '1.14.15', fingerprint: 'fp-telemetry' });
  // Токен есть, репозиторий проекта есть, отдельного репозитория телеметрии нет.
  env.store.set('cfn-github-token', 'ghp_test');
  const built = env.api.buildHealTelemetry({
    phase: 'stop', at: '2026-11-09T18:20:00.000Z', version: '1.14.15', fingerprint: 'fp',
    incident: { kind: 'send', ref: '' }, verdict: {}, snapshot: {}, journal: [],
  }, 100000);
  const sent = await env.api.healUpload(built.payload, { kind: 'send', ref: '' });
  const puts = env.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 0, 'ни одного коммита в репозиторий проекта');
  assert.equal(sent.github.ok, false);
  assert.match(String(sent.github.skipped || ''), /не пишется/, 'причина названа словами');
  assert.ok(sent.drive.ok, 'на Drive телеметрия ушла как раньше');
}

console.log('OK: D-084 — исчерпание напоминаний уводит ход Transport Maintainer\'у: класс transport, ' +
  'бриф с дефектом маркера, предохранитель 2 разбора, соседние паузы за Мастером');
