// D-045 · K-27: записи хода доживают до перехода, а потерянное ожидание
// восстанавливается сверкой, а не повторной отправкой.
//
// Боевой случай 06.11: карточка выдана Executor Core, журнал создан, вкладка
// ушла на его страницу — и `K.expect` в хранилище не оказалось, а `K.pending`
// остался. Очередь отправила задание, подтвердила его в чате и встала на
// `delivery-state-lost`; агент к тому моменту уже ответил.
//
// Проверяются НАСТОЯЩИЕ блоки собранного скрипта и НАСТОЯЩИЙ промпт боевого
// компилятора: прежняя проба D-044 была зелёной на скобочной фикстуре, которой
// в реальной выдаче не встречается.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, UUID, dispatchRequest, reminderRequest } from '../tests/helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert.ok(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}

const idsBlock = cut('  function promptDispatchIds(text) {', '  /** Своё сообщение в транскрипте');
const sendKeyBlock = cut('  function sendKey(text) {', '  /** Своё сообщение в транскрипте');
const flushBlock = cut('  async function flushBeforeNavigate(', '  const norm = (x) =>');
const receiptsBlock = cut('  const DELIVERY_RECEIPT_KEY', '  /** Уведомление и время относятся только к той очереди');
const adoptBlock = cut('  async function adoptOrphanReview(', '  /**\n   * Досылает задание, сохранённое перед переходом');
const sendBlock = cut('  async function sendToRole(', '  /** Перейти на страницу роли без задания');
const consumeBlock = cut('  async function consumePending(', '  // ───────────────────── следы прошлых попыток');

const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const flat = (x) => String(x || '').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || ''));
const rt = (prop) => (prop?.rich_text || prop?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const idTime = (id) => {
  const ms = Number.parseInt(String(id || '').replace(/-/g, '').slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : 0;
};
const clone = (x) => (x === undefined ? undefined : structuredClone(x));
const rich = (text) => ({ rich_text: text ? [{ plain_text: text }] : [] });

const ROLE = { id: '01a19d2b-bd07-722f-bbdb-20ba2f90028b', name: 'Executor Core', fn: 'Executor', url: 'https://arena.ai/agent/exec', status: 'Активна' };
const K = {
  expect: 'cfn-expect', pending: 'cfn-pending', lastSend: 'cfn-last-send', deadSend: 'cfn-dead-send',
  log: 'cfn-console-log', pause: 'cfn-pause-context', paused: 'cfn-paused', step: 'cfn-step',
};

// ── 1. Боевой промпт: разбор находит выдачу, а ключ доставки — подстрока ────
const compiled = PromptCompiler.compile(dispatchRequest());
assert.ok(compiled.ok, 'боевой промпт собран');
const REAL = compiled.text;
const parseIds = new Function(`${idsBlock}\nreturn promptDispatchIds;`)();
const sendKey = new Function('flat', `${sendKeyBlock}\nreturn sendKey;`)(flat);

{
  const ids = parseIds(REAL);
  assert.ok(ids, 'D-045: разбор видит ids в реальной строке выдачи');
  assert.equal(ids.dispatch, UUID.dispatch);
  assert.equal(ids.run, UUID.run);
  // Тот самый мёртвый regexp из D-044: на боевом формате он не находил ничего.
  assert.equal(REAL.match(/\(dispatch\s+([0-9a-f-]{36})\s*,\s*run\s+([0-9a-f-]{36})\s*\)/i), null,
    'скобочной формы в реальной выдаче нет — прежний разбор был мёртв');
}
{
  const key = sendKey(REAL);
  assert.ok(key, 'у боевой выдачи есть ключ доставки');
  assert.ok(flat(REAL).includes(key), 'ключ — подстрока самого сообщения, иначе доставка не подтвердится');
  assert.ok(key.includes(UUID.dispatch) && key.includes(UUID.run), 'ключ называет и карточку, и номер выдачи');
  // Повторная выдача той же карточки с новым Run обязана отличаться.
  const other = PromptCompiler.compile(dispatchRequest('Executor', { task: { ...dispatchRequest().task, runId: 'eeee0444-aaef-4a47-af9f-78d65150e53a' } }));
  assert.ok(other.ok);
  assert.notEqual(sendKey(other.text), key, 'новый Run — новый ключ, старая реплика не подтверждает новую выдачу');
  assert.ok(flat(other.text).includes(sendKey(other.text)));
}
{
  // Компактный повтор и продолжение несут ids в других формах.
  const compact = PromptCompiler.compile(dispatchRequest('Executor', { delivery: { tier: 'compact' } }));
  assert.ok(compact.ok && parseIds(compact.text), 'компактная выдача опознаётся');
  assert.equal(parseIds(`IDs прежние: dispatch_id=${UUID.dispatch}, run_id=${UUID.run}.`).run, UUID.run,
    'продолжение после лимита инструментов опознаётся');
  const reminder = PromptCompiler.compile(reminderRequest());
  assert.ok(reminder.ok);
  assert.equal(parseIds(reminder.text).dispatch, UUID.dispatch, 'напоминание опознаётся по примеру маркера');
  assert.notEqual(sendKey(reminder.text), sendKey(REAL), 'ключ напоминания не совпадает с ключом исходной выдачи');
  assert.equal(parseIds('Задача SYN-1 (dispatch a709d6df-4698-4a98-b111-90d22de42894, run 8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d)').run,
    UUID.run, 'прежняя скобочная форма плана продолжает работать');
  assert.equal(parseIds('обычный текст без опознавательных строк'), null);
  assert.equal(parseIds(''), null);
}

// ── 2. Барьер записи: ждём подтверждение, но не навсегда ────────────────────
function makeFlush({ withGM = true, ack = true, absent = [], fail = false, timeoutFires = false } = {}) {
  const store = new Map([[K.expect, { ref: 'card' }], [K.pending, { text: 'задание' }], ['empty', null]]);
  for (const key of absent) store.delete(key);
  const calls = { writes: [], sleeps: [], dbg: [] };
  const GM = withGM ? {
    setValue: async (key, value) => {
      calls.writes.push({ key, value: clone(value) });
      if (fail) throw new Error('storage offline');
      if (ack) store.set(key, clone(value));
      // Подтверждение может не прийти вовсе — тогда решает таймаут.
      if (!ack) return new Promise(() => {});
    },
  } : undefined;
  const fn = new Function('GM', 'GM_getValue', 'sleep', 'dbg', 'K',
    `${flushBlock}\nreturn { flushBeforeNavigate, handoffKeys };`)(
    GM,
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    // Модель часов: таймер либо срабатывает первым, либо записи успевают.
    // Короткая пауза менеджера без GM.setValue всегда completes.
    async (ms) => {
      calls.sleeps.push(ms);
      if (ms === 150 || timeoutFires) return;
      await new Promise(() => {});
    },
    (...args) => calls.dbg.push(args),
    K,
  );
  return { ...fn, store, calls };
}
{
  const h = makeFlush();
  assert.equal(await h.flushBeforeNavigate([K.expect, K.expect, K.pending]), true, 'запись подтверждена');
  assert.deepEqual(h.calls.writes.map((w) => w.key), [K.expect, K.pending], 'ключи не дублируются');
  assert.deepEqual(h.calls.writes[0].value, { ref: 'card' }, 'пишется текущее значение, а не заглушка');
  assert.equal(h.calls.sleeps.length, 1, 'ожидание ограничено таймаутом');
}
{
  const h = makeFlush();
  await h.flushBeforeNavigate([K.expect, 'нет-такого-ключа', '', null, undefined]);
  assert.deepEqual(h.calls.writes.map((w) => w.key), [K.expect], 'отсутствующий ключ не создаётся');
  assert.equal(h.store.has('нет-такого-ключа'), false);
}
{
  const h = makeFlush();
  assert.equal(await h.flushBeforeNavigate([]), true, 'пустой список не ждёт');
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.sleeps.length, 0);
}
{
  // Подтверждение не приходит: уходим по таймауту, а не виснем навсегда.
  const h = makeFlush({ ack: false, timeoutFires: true });
  assert.equal(await h.flushBeforeNavigate([K.expect], 4000), false, 'неподтверждённая запись не подвешивает шаг');
  assert.ok(h.calls.sleeps.includes(4000), 'ожидание ограничено переданным пределом');
  assert.ok(h.calls.dbg.length > 0, 'неполное подтверждение видно в отладке');
}
{
  const h = makeFlush({ fail: true, timeoutFires: true });
  assert.equal(await h.flushBeforeNavigate([K.expect]), false, 'отказ хранилища не бросается наружу');
}
{
  const h = makeFlush({ withGM: false });
  assert.equal(await h.flushBeforeNavigate([K.expect]), false, 'менеджер без GM.setValue получает короткую паузу');
  assert.deepEqual(h.calls.sleeps, [150]);
}
{
  const h = makeFlush();
  assert.deepEqual(h.handoffKeys(), [K.expect, K.pending, K.lastSend, K.log, 'cfn-me', 'cfn-nav', 'cfn-prompt-journal-v1'],
    'барьер накрывает всё, что теряется при переходе');
}

// ── 3. Транспорт: ожидание раньше очереди, уход — после подтверждения ──────
function makeSend({ samePage = false } = {}) {
  const store = new Map();
  const calls = { order: [], navigations: [], flushes: [], logs: [], pauses: [] };
  const env = {
    K, norm, C: { repo: 'example/relay-fixture' },
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => { store.set(k, clone(v)); calls.order.push(k); },
    projectRoleAllowed: () => true, textHash: (t) => String(t.length),
    lastMessageId: () => 'm0', messages: () => [], nodeId: (n) => n.id,
    profileSessionRepo: () => 'example/relay-fixture', profileRepoBranch: () => 'main',
    recordPromptAttempt: () => calls.order.push('prompt-journal'),
    dbg: () => {}, setStatus: () => {}, setTimeout: () => {}, tick: () => {},
    log: (text) => calls.logs.push(text),
    pause: (text, ctx) => calls.pauses.push({ text, ctx }),
    handoffKeys: () => [K.expect, K.pending, K.lastSend],
    flushBeforeNavigate: async (keys) => {
      calls.flushes.push({ keys: [...keys], expect: clone(store.get(K.expect)), pending: clone(store.get(K.pending)) });
      calls.order.push('flush');
      return true;
    },
    location: { href: 'https://arena.ai/agent/coord', pathname: samePage ? '/agent/exec' : '/agent/coord', assign: (url) => { calls.navigations.push(url); calls.order.push('assign'); } },
  };
  const make = new Function('env', `
    const {K, norm, C, GM_getValue, GM_setValue, projectRoleAllowed, textHash, lastMessageId, messages, nodeId,
      profileSessionRepo, profileRepoBranch, recordPromptAttempt, dbg, setStatus, setTimeout, tick, log, pause,
      handoffKeys, flushBeforeNavigate, location} = env;
    ${sendBlock}\nreturn sendToRole;`);
  return { sendToRole: make(env), store, calls };
}
{
  const h = makeSend();
  assert.equal(await h.sendToRole(ROLE, REAL, 'dispatch', UUID.dispatch, { runId: UUID.run, missionId: UUID.mission, logId: 'log-1', title: 'K-27' }), true);
  const order = h.calls.order;
  assert.ok(order.indexOf(K.expect) < order.indexOf(K.pending), 'D-045: ожидание пишется ДО очереди — усечение теряет очередь, а не хозяина хода');
  assert.ok(order.indexOf('flush') < order.indexOf('assign'), 'уход со страницы только после подтверждения записи');
  assert.deepEqual(h.calls.navigations, [ROLE.url]);
  assert.equal(h.calls.flushes.length, 1);
  assert.ok(h.calls.flushes[0].expect && h.calls.flushes[0].pending, 'к моменту подтверждения обе записи уже сделаны');
  const pending = h.store.get(K.pending);
  assert.equal(pending.ref, UUID.dispatch);
  assert.equal(pending.runId, UUID.run);
  assert.equal(pending.missionId, UUID.mission);
  assert.equal(pending.logId, 'log-1');
  assert.equal(pending.kind, 'dispatch');
  assert.equal(pending.text, REAL);
  assert.equal(h.store.get(K.expect).ref, UUID.dispatch, 'ожидание той же выдачи');
}
{
  const h = makeSend({ samePage: true });
  assert.equal(await h.sendToRole(ROLE, REAL, 'dispatch', UUID.dispatch, { runId: UUID.run }), true);
  assert.deepEqual(h.calls.navigations, [], 'своя страница не перезагружается');
  assert.equal(h.calls.flushes.length, 0, 'без перехода барьер не нужен');
}

// ── 4. Потерянное ожидание: сверка вместо повторной отправки ────────────────
const MSG = '01a1af93-3a0c-79ea-b456-263d4d41def7';
function card(over = {}) {
  return {
    id: UUID.dispatch, url: 'https://notion.so/card',
    properties: {
      'Запрос': { title: [{ plain_text: 'SYN-1 · K-27' }] },
      'Dispatch State': { select: { name: 'Running' } },
      'Run ID': rich(UUID.run),
      'Mission ID': rich(UUID.mission),
      'Recipient Agent ID': rich(ROLE.id),
      'Output Drive File ID': rich('log-1'),
      ...over,
    },
  };
}
function makeAdopt({ page = card(), notionFails = false, nodes = [], receipts = [], pendingOver = {}, currentRole = ROLE.id } = {}) {
  const pending = {
    roleId: ROLE.id, roleName: ROLE.name, roleUrl: ROLE.url, roleFn: 'Executor', kind: 'dispatch',
    ref: UUID.dispatch, runId: UUID.run, missionId: UUID.mission, logId: 'log-1', title: 'SYN-1 · K-27',
    url: 'https://notion.so/card', sessionRepo: 'example/relay-fixture', targetRepo: 'Creative36711/synapse',
    targetBranch: 'main', text: REAL, at: Date.now(), ...pendingOver,
  };
  const store = new Map([[K.pending, clone(pending)], [K.expect, null], ['cfn-delivery-receipts-v1', clone(receipts)]]);
  const calls = { logs: [], pauses: [], reads: [], rollbacks: [], delivered: [] };
  const env = {
    K, norm, isUuid, rt, idTime,
    C: { pendingTtlMs: 600_000, undeliveredTtlMs: 7_200_000, sendRetries: 3, tickMs: 10, insertRetries: 2 },
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, clone(v)),
    roleFromPath: () => currentRole,
    roleRows: async () => [clone(ROLE)],
    notion: async (method, path) => { calls.reads.push({ method, path }); if (notionFails) throw new Error('Notion offline'); return clone(page); },
    taskState: (p) => p.properties['Dispatch State']?.select?.name || '',
    taskTitle: (p) => rt(p.properties['Запрос']),
    patch: async () => { throw new Error('карточка не должна меняться'); },
    userMessages: () => clone(nodes), messageRaw: (n) => n.raw, nodeId: (n) => n.id,
    releaseUndelivered: async (...args) => { calls.rollbacks.push(args); return true; },
    pause: (text, ctx) => calls.pauses.push({ text, ctx }),
    log: (text, error, opts) => calls.logs.push({ text, error, opts }),
    nowIso: () => '2026-11-06T06:36:46.179Z',
    appReady: () => ({ ok: true }), pendingSay: () => {}, autoOn: () => true,
    dropGhostHandoff: async () => null,
    sendKey: () => 'key', flat, composerHolds: () => false, userSaysSince: () => null, lastUserSays: () => false,
    captchaDialog: () => false, busySettled: async () => null, busyLabel: () => '',
    ensureFreshBranch: async () => {}, ensureComposer: async () => ({ editor: {}, closed: 0 }), composerText: () => '',
    clearComposer: () => true, sleep: async () => {}, writePrompt: () => true,
    lastMessageId: () => 'm0', messages: () => [], deliver: async (_e, text) => { calls.delivered.push(text); return { ok: true, msgId: 'sent-2' }; },
    isDispatchAssignment: () => false, dispatchDeliveryNtfy: () => ({ ntfy: false }), dbg: () => {},
    setTimeout: () => {}, tick: () => {},
    journalDelivery: () => {}, classifyArenaFailure: () => 'unknown',
    openDialog: () => null, domReport: () => ({}), console: { warn() {} }, Math,
  };
  const make = new Function('env', `
    const {K, norm, isUuid, rt, idTime, C, GM_getValue, GM_setValue, roleFromPath, roleRows, notion, taskState,
      taskTitle, patch, userMessages, messageRaw, nodeId, releaseUndelivered, pause, log, nowIso, appReady, pendingSay,
      autoOn, sendKey, flat, composerHolds, userSaysSince, lastUserSays, captchaDialog, busySettled,
      busyLabel, ensureFreshBranch, ensureComposer, composerText, clearComposer, sleep, writePrompt, lastMessageId,
      messages, deliver, isDispatchAssignment, dispatchDeliveryNtfy, dbg, setTimeout, tick, journalDelivery,
      classifyArenaFailure, openDialog, domReport, console, Math} = env;
    let pendingNoticeAt = 0, insertFail = {at: 0, count: 0};
    ${idsBlock}\n${receiptsBlock}\n${adoptBlock}\n${consumeBlock}
    return { adoptOrphanDispatch, consumePending, dispatchPromptInChat, restoreMissingSendMark };`);
  return { ...make(env), store, calls, pending };
}
{
  // Реплика выдачи уже в чате: ход восстановлен, второй отправки нет.
  const h = makeAdopt({ nodes: [{ id: MSG, raw: REAL }] });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, [], 'D-045: подтверждённая выдача не отправляется вторично');
  assert.equal(h.store.get(K.pending), null, 'очередь снята');
  const live = h.store.get(K.expect);
  assert.equal(live.ref, UUID.dispatch);
  assert.equal(live.runId, UUID.run);
  assert.equal(live.missionId, UUID.mission);
  assert.equal(live.watermark, MSG, 'граница ответа — сама реплика выдачи');
  assert.ok(Number(live.sentAt) > 0 && live.verified === true);
  assert.equal(h.calls.pauses.length, 0, 'живой ход не будит Мастера');
  assert.deepEqual(h.calls.rollbacks, [], 'карточка не возвращается в Ready');
  assert.match(h.calls.logs.at(-1).text, /восстановлен из очереди/);
}
{
  // Квитанция D-044 работает и без реплики в разметке.
  const h = makeAdopt({
    receipts: [{
      key: `dispatch|${norm(UUID.dispatch)}|${norm(UUID.run)}|||${norm(ROLE.id)}`,
      kind: 'dispatch', ref: UUID.dispatch, runId: UUID.run, roleId: ROLE.id,
      messageId: MSG, sentAt: 1762374524000, watermark: MSG, seen: [],
    }],
  });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, []);
  assert.equal(h.store.get(K.expect).sentAt, 1762374524000);
  assert.equal(h.store.get(K.pending), null);
}
{
  // Карточка Running, реплики нет: ожидание восстановлено, отправка ровно одна.
  const h = makeAdopt();
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, [REAL], 'задание уходит один раз');
  const live = h.store.get(K.expect);
  assert.equal(live.runId, UUID.run);
  assert.equal(live.adoptedFromQueue, true);
  assert.ok(Number(live.sentAt) > 0, 'после отправки отметка стоит');
  assert.equal(h.store.get(K.pending), null);
  assert.equal(h.calls.pauses.length, 0);
}
{
  // Старая очередь без полей нового формата: ids берутся из самого текста.
  const h = makeAdopt({ nodes: [{ id: MSG, raw: REAL }], pendingOver: { kind: undefined, ref: '', runId: '', missionId: '', logId: '', title: '' } });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, [], 'текст выдачи сам называет карточку и Run');
  assert.equal(h.store.get(K.expect).runId, UUID.run);
  assert.equal(h.store.get(K.expect).logId, 'log-1', 'журнал взят из карточки');
}
for (const [why, over] of [
  ['не Running', { 'Dispatch State': { select: { name: 'Submitted' } } }],
  ['чужой Run', { 'Run ID': rich('eeee0444-aaef-4a47-af9f-78d65150e53a') }],
  ['пустой Run', { 'Run ID': rich('') }],
  ['другой адресат', { 'Recipient Agent ID': rich('01a19d29-b5c1-7368-8eba-1492816dda30') }],
  ['другая миссия', { 'Mission ID': rich('11111111-2222-4333-8444-555555555555') }],
  ['миссия не UUID', { 'Mission ID': rich('не-uuid') }],
]) {
  const h = makeAdopt({ page: card(over), nodes: [{ id: MSG, raw: REAL }] });
  assert.equal(await h.consumePending(true), true, why);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-dispatch', why);
  assert.deepEqual(h.calls.delivered, [], `${why}: отправки нет`);
  assert.equal(h.store.get(K.pending).text, REAL, `${why}: очередь сохранена`);
  assert.equal(h.store.get(K.expect), null, `${why}: ожидание не выдумывается`);
  assert.deepEqual(h.calls.rollbacks, [], `${why}: карточка не тронута`);
}
{
  const h = makeAdopt({ notionFails: true, nodes: [{ id: MSG, raw: REAL }] });
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-dispatch');
  assert.match(h.calls.pauses.at(-1).text, /Notion offline/);
  assert.deepEqual(h.calls.delivered, [], 'без сверки отправки нет');
  assert.ok(h.store.get(K.pending));
}
{
  // K-27 пролежал бы в очереди часы. Просрочка не должна снимать доказанный
  // ход: сверка идёт ДО разбора TTL, иначе ответ агента снова потеряется.
  const h = makeAdopt({ nodes: [{ id: MSG, raw: REAL }], pendingOver: { at: Date.now() - 6 * 3600_000 } });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, [], 'просроченная, но доказанная выдача не отправляется вторично');
  assert.equal(h.store.get(K.pending), null, 'очередь снята сверкой, а не как просроченная');
  assert.ok(Number(h.store.get(K.expect).sentAt) > 0);
  assert.deepEqual(h.calls.rollbacks, [], 'карточка не возвращена в Ready');
  assert.ok(!h.calls.logs.some((row) => /просроченную отправку/.test(row.text)), 'ход не назван остатком прошлой попытки');
}
{
  // Чужая страница: квитанция работает, а без доказательства цикл открывает
  // страницу адресата и не отправляет задание отсюда.
  const h = makeAdopt({ nodes: [{ id: MSG, raw: REAL }], currentRole: '01a19d29-b5c1-7368-8eba-1492816dda30' });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.delivered, [], 'с чужой страницы задание не уходит');
  assert.equal(h.store.get(K.pending).text, REAL, 'очередь сохранена для страницы адресата');
  assert.equal(h.store.get(K.expect), null, 'ожидание по чужому чату не выдумывается');
}
{
  // Нечитаемые ids — пауза, а не отправка наугад.
  const h = makeAdopt({ pendingOver: { ref: '', runId: '', text: 'CF_AGENT_RESULT {"dispatch_id":"битый"}' } });
  assert.equal(await h.adoptOrphanDispatch(h.pending, ROLE.id), true);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-dispatch');
  assert.deepEqual(h.calls.reads, [], 'карточка не читается по битому номеру');
}
{
  // План и приёмка не сводятся к карточке: их разбирает свой порядок.
  const h = makeAdopt({ pendingOver: { kind: 'plan', ref: '', runId: '', text: 'план, пожалуйста' } });
  assert.equal(await h.adoptOrphanDispatch(h.pending, ROLE.id), false);
  assert.deepEqual(h.calls.reads, []);
  assert.equal(h.calls.pauses.length, 0);
}
{
  // Живое ожидание не пересобирается из очереди.
  const h = makeAdopt();
  h.store.set(K.expect, { kind: 'dispatch', ref: UUID.dispatch, runId: UUID.run, roleId: ROLE.id, sentAt: 5 });
  assert.equal(await h.adoptOrphanDispatch(h.pending, ROLE.id), false);
  assert.deepEqual(h.calls.reads, []);
  assert.equal(h.store.get(K.expect).sentAt, 5);
}

// ── 5. Проводка: барьер стоит перед каждым уходом со страницы ───────────────
{
  const nav = cut('  async function navigateTo(role, why) {', '  /**\n   * Отправка без подтверждения');
  assert.match(nav, /await flushBeforeNavigate\(handoffKeys\(\)\);\s*location\.assign\(role\.url\);/, 'переход ждёт записи');
  const cycle = readFileSync(new URL('../src/28-cycle.js', import.meta.url), 'utf8');
  assert.match(cycle, /await flushBeforeNavigate\(\[K\.expect, K\.log\]\);\s*location\.reload\(\);/, 'перечитывание страницы ждёт записи');
  const missing = readFileSync(new URL('../src/14-missing-marker.js', import.meta.url), 'utf8');
  assert.match(missing, /await flushBeforeNavigate\(\[reloadKey, K\.expect, K\.pending, K\.log\]\);\s*location\.reload\(\);/,
    'счётчик перезагрузок переживает перезагрузку');
  const pilot = readFileSync(new URL('../src/pilot-transport.js', import.meta.url), 'utf8');
  assert.match(pilot, /flushBeforeNavigate\(\[K\.pilotWait \+ id, K\.pilots, K\.log\]\)\.then\(\(\) => location\.assign\(pilot\.url\)\);/,
    'пилот уходит после подтверждения');
  assert.equal((src.match(/location\.reload\(\)/g) || []).length, 4, 'число перезагрузок не изменилось');
  assert.match(src, /@grant\s+GM\.setValue/, 'менеджеру заявлен promise-вариант записи');
}
{
  // Квитанция пишется и при потерянном ожидании — до паузы.
  const lostAt = consumeBlock.indexOf('kind: "delivery-state-lost"');
  const receiptAt = consumeBlock.indexOf('// D-045: квитанция пишется и тогда, когда ожидание потеряно.');
  assert.ok(receiptAt > 0 && lostAt > receiptAt, 'факт доставки сохраняется раньше паузы');
  assert.match(consumeBlock, /if \(!expect \|\| norm\(expect\.roleId\) !== norm\(me\)\) \{\s*pause\(/, 'потерянное ожидание по-прежнему не называется успехом');
  assert.match(consumeBlock, /if \(await adoptOrphanDispatch\(pending, me\)\) return true;/, 'сверка стоит до отправки');
  const deliverAt = consumeBlock.indexOf('const delivery = await deliver(');
  const adoptAt = consumeBlock.indexOf('await adoptOrphanDispatch(');
  assert.ok(adoptAt < deliverAt, 'сверка раньше доставки');
  assert.ok(adoptAt < consumeBlock.indexOf('if (age > (pending.undelivered'),
    'сверка раньше разбора просрочки: залежавшийся ход K-27 не снимается как остаток прошлой попытки');
  const pause = readFileSync(new URL('../src/06-pause-panel.js', import.meta.url), 'utf8');
  assert.match(pause, /paused\.kind === "delivery-state-lost"[\s\S]{0,200}сначала сверю чат и карточку/, '«Продолжить» не обещает дубль');
}

console.log('OK: relay D-045 — записи хода доживают до перехода, боевой промпт опознаётся, потерянное ожидание восстанавливается сверкой без повторной отправки');
