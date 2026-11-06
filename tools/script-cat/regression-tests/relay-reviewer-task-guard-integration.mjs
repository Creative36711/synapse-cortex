// Реальные блоки ScriptCat с локальными моделями Notion, Drive, хранилища и DOM.
// Новые рабочие карточки Reviewer запрещены; приёмка, ответы на вопросы и уже
// отправленные карточки остаются отдельными работающими путями.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promptShim } from '../tests/helpers/prompt-shim.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}
const routing = cut('  function decisionRoute(next,', '  // ───────────────────────────── вопросы к Мастеру');
const dispatch = cut('  async function dispatchTask(', '  // ───────────────────────────── цикл ───');
const send = cut('  async function sendToRole(', '  /** Перейти на страницу роли без задания');
const consume = cut('  async function consumePending(', '  // ───────────────────── следы прошлых попыток');
// D-045: разбор очереди без ожидания и опознавательные данные выдачи — тоже
// настоящие блоки, а не пересказ.
const orphanAdopt = cut('  async function adoptOrphanDispatch(', '  /**\n   * Досылает задание, сохранённое перед переходом');
const promptIds = cut('  function promptDispatchIds(', '  /** Своё сообщение в транскрипте');
const migrate = cut('  function migrateState() {', '  /**\n   * Кнопка ↺:');
const revive = cut('  function reviveUnverifiedHandoff() {', '  /**\n   * Один отложенный повтор');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const K = { pending: 'pending', expect: 'expect', lastSend: 'lastSend', deadSend: 'deadSend', stateV: 'stateV', paused: 'paused', pause: 'pause', errSeen: 'errSeen' };
const warden = { name: 'Warden', fn: 'Reviewer', id: 'rev-1', url: '/agent/rev-1', status: 'Активна' };
const reviewer = { name: 'Независимый приёмщик', fn: 'Reviewer', id: 'rev-2', url: '/agent/rev-2', status: 'Активна' };
const kernel = { name: 'Kernel', fn: 'Executor', id: 'exec-1', url: '/agent/exec-1', status: 'Активна', repo: 'Creative36711/synapse' };
const auditor = { name: 'Runtime Auditor', fn: 'Auditor', id: 'audit-1', url: '/agent/audit-1', status: 'Активна' };
const coordinator = { name: 'Coordinator', fn: 'Coordinator', id: 'coord-1', url: '/agent/coord-1', status: 'Активна' };
const all = [coordinator, warden, reviewer, kernel, auditor];
const decisionRoute = new Function('norm', `${routing}\nreturn decisionRoute;`)(norm);

for (const [name, directory, roles, ready] of [
  ['Warden', all, all, ['Warden']],
  ['warden', all, all, []],
  [reviewer.name, all, all, [reviewer.name]],
  [reviewer.name, all, [coordinator, kernel, auditor], [reviewer.name]], // неактивный Reviewer
  ['Alias', [...all, { ...kernel, id: reviewer.id, name: 'Alias' }], [{ ...kernel, id: reviewer.id, name: 'Alias' }], ['Alias']],
]) {
  const route = decisionRoute(name, { roles, directory, readyRoles: ready });
  assert.equal(route.kind, 'ask', `${name}: никакой dispatch`);
  assert.match(route.note, /Reviewer/);
  assert.match(route.note, /Auditor|Executor/);
  assert.match(route.note, /вопросы и предложения/);
  assert.match(route.note, /done/);
  assert.equal(decisionRoute(name, { roles, directory, readyRoles: ready, misses: 2 }).kind, 'pause', 'нет бесконечной петли');
}
assert.equal(decisionRoute('Kernel', { roles: all, directory: all, readyRoles: ['Kernel'] }).kind, 'dispatch');
assert.equal(decisionRoute('Runtime Auditor', { roles: all, directory: all, readyRoles: ['Runtime Auditor'] }).kind, 'dispatch');
assert.equal(decisionRoute('done', { roles: all, directory: all }).kind, 'done');
assert.equal(decisionRoute('Unknown fn', {
  roles: [{ name: 'Unknown fn', fn: '', id: 'unknown' }], readyRoles: ['Unknown fn'],
}).kind, 'ask', 'неизвестная функция не открывает обход');

const clone = (x) => structuredClone(x);
const rich = (text) => ({ rich_text: text ? [{ plain_text: text }] : [] });
const rt = (prop) => (prop?.rich_text || prop?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
function fixture(who = 'Kernel') {
  return { id: 'card-1', url: 'https://notion.example/card-1', properties: {
    'Запрос': { title: [{ plain_text: 'STAB-1.40 · тест роли' }] },
    'Кому': { select: { name: who } },
    'Dispatch State': { select: { name: 'Ready' } },
    'Submitted At': { date: null }, PR: { url: null },
    'Payload Drive File ID': rich(''), 'Output Drive File ID': rich(''),
  } };
}

function makeDispatch({ active = all, directory = all, freshCard = fixture(), directoryError = null, failCreateLog = false } = {}) {
  const storage = new Map();
  const calls = { patches: [], gateway: [], reads: [], sends: [], navigations: [], roleReads: [], logs: [], pauses: [], flushes: [] };
  const env = {
    roles: async () => clone(active),
    roleRows: async (opts) => {
      calls.roleReads.push(clone(opts));
      if (directoryError) throw new Error(directoryError);
      return clone(directory);
    },
    norm, rt, K, C: { repo: 'example/relay-fixture', branch: 'main' }, ACTIVE_PROFILE: { legacy: false, repo: 'example/relay-fixture', branch: 'main', repos: [{ repo: 'Creative36711/synapse', branch: 'main' }, { repo: 'example/relay-fixture', branch: 'main' }] },
    GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
    GM_setValue: (key, value) => storage.set(key, clone(value)),
    notion: async (method, path) => { calls.reads.push({ method, path }); return clone(freshCard); },
    patch: async (id, props) => calls.patches.push({ id, props: clone(props) }),
    gateway: async (action, fileId, payload = {}) => {
      calls.gateway.push({ action, fileId, payload: clone(payload) });
      if (action === 'read') return { content: 'свежий payload' };
      if (action === 'createLog') return failCreateLog ? { ok: true } : { fileId: 'NEW-LOG' };
      return { ok: true };
    },
    taskTitle: (p) => rt(p.properties['Запрос']),
    taskState: (p) => p.properties['Dispatch State']?.select?.name || '',
    taskRole: (p) => p.properties['Кому']?.select?.name || '',
    taskTargetRepository: (p, fallback) => p.properties?.Repository?.rich_text?.[0]?.plain_text || fallback,
    reworkSeen: () => true,
    profileSessionRepo: () => 'example/relay-fixture',
    canonicalTargetRepository: (value, fallback) => String(value || fallback || '').trim(),
    profileRepoBranch: () => 'main',
    redispatchClearProps: (p) => p.properties['Submitted At']?.date?.start ? { 'Submitted At': { date: null } } : null,
    redispatchWhy: () => 'ранее отвечена', noteRedispatch: () => 1, REDISPATCH_LIMIT: 3,
    answerStampKey: (id) => `stamp:${id}`, reworkKey: (id) => `rework:${id}`,
    pause: (message, options) => calls.pauses.push({ message, options }),
    log: (message, error, options) => calls.logs.push({ message, error, options }),
    uid: () => 'run-new', nowIso: () => '2026-11-01T00:00:00Z',
    taskLogEntry: (card, role, payload, run) => `journal:${card.id}:${role.name}:${payload}:${run}`,
    executorPrompt: (card, role, payload, logId, runId) => `assignment:${card.id}:${role.name}:${payload}:${logId}:${runId}`,
    releaseUndelivered: async () => { throw new Error('unexpected rollback'); },
    taskPreflight: async () => '', textHash: (text) => String(text), lastMessageId: () => '', messages: () => [], nodeId: (node) => node.id,
    dbg: () => {}, setStatus: () => {}, setTimeout: () => {}, tick: () => {},
    // D-045: транспорт ждёт подтверждения записей перед уходом со страницы.
    flushBeforeNavigate: async (keys) => { calls.flushes.push(clone(keys)); return true; },
    handoffKeys: () => ['expect', 'pending', 'lastSend'],
    recordPromptAttempt: () => {},
    location: { href: 'https://arena.ai/agent/coord-1', pathname: '/agent/coord-1', assign: (url) => calls.navigations.push(url) },
  };
  const make = new Function('env', `
    const {roles, roleRows, norm, rt, K, C, ACTIVE_PROFILE, GM_getValue, GM_setValue, notion, patch, gateway,
      taskTitle, taskState, taskRole, taskTargetRepository, reworkSeen, profileSessionRepo, canonicalTargetRepository, profileRepoBranch,
      redispatchClearProps, redispatchWhy, noteRedispatch, REDISPATCH_LIMIT,
      answerStampKey, reworkKey, pause, log, uid, nowIso, taskLogEntry, executorPrompt,
      releaseUndelivered, taskPreflight, textHash, lastMessageId, messages, nodeId, dbg, setStatus, setTimeout, tick, location,
      flushBeforeNavigate, handoffKeys, recordPromptAttempt} = env;
    ${send}\n${dispatch}\nreturn { sendToRole, dispatchTask };`);
  return { ...make(env), storage, calls, freshCard };
}

// Подмена маршрута прямым вызовом dispatchTask не обходит границу. В том числе
// старые следы ответа не очищаются и не создаётся Drive-файл.
for (const role of [warden, reviewer, { ...warden, fn: 'Executor' }, { ...reviewer, name: 'Неизвестная функция', fn: '' }, coordinator]) {
  const card = fixture(role.name);
  card.properties['Submitted At'] = { date: { start: '2026-10-30T12:00:00Z' } };
  const h = makeDispatch({ active: [role], directory: [role], freshCard: card });
  const result = await h.dispatchTask(card, role.name);
  assert.equal(typeof result, 'string', `${role.name}: отказ с причиной`);
  assert.equal(h.calls.reads.length, 0, 'даже карточка не перечитывается');
  assert.equal(h.calls.patches.length, 0, 'Notion не меняется');
  assert.equal(h.calls.gateway.length, 0, 'Drive не трогается');
  assert.equal(h.storage.size, 0, 'хранилище и ожидание не трогаются');
}

// Кеш уже устарел / сеть недоступна / Agent URL подменён: fail closed до
// чтения карточки и до её записи.
for (const directory of [
  [{ ...kernel, fn: 'Reviewer' }],
  [{ ...kernel, id: 'other-id' }],
  [{ ...kernel, status: 'Ждёт' }],
  [kernel, { ...reviewer, id: kernel.id, status: 'Ждёт' }],
  [],
]) {
  const h = makeDispatch({ active: [kernel], directory });
  const result = await h.dispatchTask(fixture(), 'Kernel');
  assert.equal(typeof result, 'string');
  assert.deepEqual(h.calls.roleReads, [{ fresh: true, requireFresh: true }]);
  assert.equal(h.calls.reads.length + h.calls.patches.length + h.calls.gateway.length, 0);
}
{
  const h = makeDispatch({ active: [kernel], directoryError: 'Notion offline' });
  await assert.rejects(() => h.dispatchTask(fixture(), 'Kernel'), /Notion offline/);
  assert.equal(h.calls.reads.length + h.calls.patches.length + h.calls.gateway.length, 0);
}
{
  const freshCard = fixture('Runtime Auditor');
  const h = makeDispatch({ freshCard });
  const result = await h.dispatchTask(fixture('Kernel'), 'Kernel');
  assert.match(result, /адресат карточки изменился/);
  assert.equal(h.calls.patches.length + h.calls.gateway.length, 0, 'не выдаём переназначенную карточку');
}

// Настоящие Executor и Auditor проходят тем же dispatchTask и sendToRole.
// Для Run создаётся новый лог, старый файл не используется для записи.
for (const role of [kernel, auditor]) {
  const freshCard = fixture(role.name);
  freshCard.properties['Output Drive File ID'] = rich('OLD-LOG');
  freshCard.properties['Payload Drive File ID'] = rich('ACTUAL-PAYLOAD');
  const staleCard = fixture(role.name);
  staleCard.properties['Payload Drive File ID'] = rich('STALE-PAYLOAD');
  const h = makeDispatch({ freshCard });
  assert.equal(await h.dispatchTask(staleCard, role.name, { id: 'mission-1' }), true);
  assert.deepEqual(h.calls.roleReads, [{ fresh: true, requireFresh: true }]);
  assert.equal(h.calls.gateway.find((c) => c.action === 'read').fileId, 'ACTUAL-PAYLOAD');
  const create = h.calls.gateway.find((c) => c.action === 'createLog');
  assert.deepEqual(create.payload, { dispatchId: 'card-1', runId: 'run-new' });
  const append = h.calls.gateway.find((c) => c.action === 'append');
  assert.equal(append.fileId, 'NEW-LOG');
  assert.match(append.payload.entry, /OLD-LOG/, 'старую ссылку не теряем');
  assert.match(append.payload.entry, /принадлежность не проверена/);
  assert.ok(!h.calls.gateway.some((c) => c.action === 'append' && c.fileId === 'OLD-LOG'));
  assert.equal(h.calls.patches[0].props['Output Drive File ID'].rich_text[0].text.content, 'NEW-LOG');
  assert.equal(h.storage.get(K.pending).roleId, role.id);
  assert.equal(h.storage.get(K.expect).kind, 'dispatch');
  if (role === kernel) assert.equal(h.storage.get(K.expect).targetRepo, 'Creative36711/synapse', 'live Notion role repo overrides stale default profile route');
  assert.match(h.storage.get(K.pending).text, /свежий payload/);
}
{
  const h = makeDispatch({ failCreateLog: true });
  await assert.rejects(() => h.dispatchTask(fixture(), 'Kernel'), /не вернул ID журнала/);
  assert.equal(h.calls.patches.length, 0);
  assert.equal(h.storage.has(K.pending), false);
}

// Последний барьер транспорта: нельзя напрямую создать новую рабочую очередь
// Reviewer. Реальные review/answer и проверенное напоминание к старому ходу
// проходят тем же sendToRole, а поддельное напоминание — нет.
{
  const h = makeDispatch();
  assert.equal(await h.sendToRole(warden, 'новая карточка', 'dispatch', 'card-1', { runId: 'run-1', force: true }), false);
  assert.equal(h.storage.size, 0);
  assert.equal(await h.sendToRole({ ...warden, fn: 'Executor' }, 'обход', 'dispatch', 'card-1'), false);
  assert.equal(h.storage.size, 0);
  assert.equal(await h.sendToRole(warden, 'поддельное напоминание', 'dispatch', 'card-1', { isDispatchReminder: true, runId: 'run-1' }), false);
  assert.equal(h.storage.size, 0);
}
for (const kind of ['review', 'answer']) {
  const h = makeDispatch();
  assert.equal(await h.sendToRole(warden, `${kind} текст`, kind, 'ref-1'), true);
  assert.equal(h.storage.get(K.pending).roleId, warden.id);
  assert.equal(h.storage.get(K.expect).kind, kind);
}
{
  const h = makeDispatch();
  h.storage.set(K.expect, { kind: 'dispatch', roleId: warden.id, ref: 'old-card', runId: 'old-run', sentAt: 123, verified: true });
  assert.equal(await h.sendToRole(warden, 'формат маркера', 'dispatch', 'old-card', { isDispatchReminder: true, runId: 'old-run', tries: 1 }), true);
  assert.equal(h.storage.get(K.expect).isDispatchReminder, true);
}
{
  const h = makeDispatch();
  h.storage.set(K.expect, { kind: 'dispatch', roleId: warden.id, ref: 'old-card', runId: 'old-run', sentAt: 123, verified: true });
  assert.equal(await h.sendToRole(warden, 'другой ход', 'dispatch', 'other-card', { isDispatchReminder: true, runId: 'old-run' }), false);
  assert.equal(h.storage.has(K.pending), false);
  assert.equal(h.storage.get(K.expect).ref, 'old-card');
}

function makeConsumer(expect, pending, owners = [warden]) {
  const storage = new Map([[K.expect, clone(expect)], [K.pending, clone(pending)]]);
  const calls = { paused: [], delivered: [], writes: [], roleReads: [] };
  const env = {
    K, norm, C: { pendingTtlMs: 60_000, undeliveredTtlMs: 120_000, sendRetries: 3, tickMs: 10, insertRetries: 2 },
    GM_getValue: (k, d) => storage.has(k) ? storage.get(k) : d,
    GM_setValue: (k, v) => { storage.set(k, clone(v)); calls.writes.push(k); },
    roleFromPath: () => pending.roleId, roleRows: async (options) => {
      calls.roleReads.push(options);
      if (owners instanceof Error) throw owners;
      return clone(owners);
    },
    pause: (message, options) => calls.paused.push({ message, options }),
    appReady: () => ({ ok: true }), pendingSay: () => {}, autoOn: () => true,
    dropGhostHandoff: async () => { throw new Error('unexpected rollback'); },
    notion: async () => { throw new Error('unexpected Notion'); }, patch: async () => { throw new Error('unexpected patch'); },
    taskState: () => 'Ready', nowIso: () => 'now', log: () => {},
    sendKey: (t) => t, flat: (t) => String(t), composerHolds: () => false, userSaysSince: () => null,
    lastUserSays: () => false, captchaDialog: () => false, busySettled: async () => null, busyLabel: () => '',
    ensureFreshBranch: async () => {}, ensureComposer: async () => ({ editor: {}, closed: 0 }), composerText: () => '',
    clearComposer: () => true, sleep: async () => {}, writePrompt: () => true,
    lastMessageId: () => '', messages: () => [], nodeId: (n) => n.id,
    deliver: async (_editor, text) => { calls.delivered.push(text); return { ok: true, msgId: 'sent-message' }; },
    isDispatchAssignment: () => false, dispatchDeliveryNtfy: () => ({ ntfy: false }), dbg: () => {},
    setTimeout: () => {}, tick: () => {},
    // D-045: сверка потерянного хода с карточкой. Доказательство доставки
    // проверяет отдельная проба D-045 на настоящем блоке квитанций.
    isUuid: (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || '')),
    rt, taskTitle: (p) => rt(p?.properties?.['Запрос']), restoreMissingSendMark: () => null,
  };
  const make = new Function('env', `
    const {K, norm, C, GM_getValue, GM_setValue, roleFromPath, roleRows, pause, appReady, pendingSay, autoOn,
      dropGhostHandoff, notion, patch, taskState, nowIso, log, sendKey, flat, composerHolds, userSaysSince,
      lastUserSays, captchaDialog, busySettled, busyLabel, ensureFreshBranch, ensureComposer, composerText,
      clearComposer, sleep, writePrompt, lastMessageId, messages, nodeId, deliver, isDispatchAssignment,
      dispatchDeliveryNtfy, dbg, setTimeout, tick,
      isUuid, rt, taskTitle, restoreMissingSendMark} = env;
    let pendingNoticeAt = 0, insertFail = {at: 0, count: 0};
    ${promptShim}\n${promptIds}\n${orphanAdopt}\n${consume}\nreturn consumePending;`);
  return { consumePending: make(env), storage, calls };
}
const pending = { roleId: warden.id, roleName: warden.name, text: 'текст карточки', at: Date.now() };
const oldExpect = { kind: 'dispatch', roleFn: 'Reviewer', roleId: warden.id, ref: 'old-card', runId: 'old-run', text: pending.text };
for (const extra of [{}, { undelivered: true }, { at: Date.now() - 999_999 }]) {
  const h = makeConsumer(oldExpect, { ...pending, ...extra });
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.paused.at(-1).options.kind, 'reviewer-task-pending');
  assert.equal(h.calls.delivered.length, 0);
  assert.deepEqual(h.storage.get(K.expect), oldExpect);
  assert.deepEqual(h.storage.get(K.pending), { ...pending, ...extra });
  assert.equal(h.calls.writes.length, 0, 'очередь и ожидание не сбрасываются');
}
{
  const orphan = { ...pending, text: 'CF_AGENT_RESULT {"dispatch_id":"card-1"}' };
  const h = makeConsumer(null, orphan);
  await h.consumePending(true);
  assert.equal(h.calls.paused.at(-1).options.kind, 'reviewer-task-pending');
  assert.equal(h.calls.delivered.length, 0);
  assert.deepEqual(h.storage.get(K.pending), orphan);
}
{
  const orphan = { ...pending, text: 'CF_AGENT_RESULT {"dispatch_id":"card-1"}' };
  const h = makeConsumer(null, orphan, []);
  await h.consumePending(true);
  assert.equal(h.calls.paused.at(-1).options.kind, 'reviewer-task-check');
  assert.equal(h.calls.delivered.length, 0, 'неизвестная роль не допускается');
}
for (const expect of [
  { kind: 'review', roleFn: 'Reviewer', roleId: warden.id, ref: 'mission-1' },
  { kind: 'answer', roleFn: 'Reviewer', roleId: warden.id, ref: 'question-1' },
  { ...oldExpect, isDispatchReminder: true, tries: 1 },
]) {
  const h = makeConsumer(expect, pending);
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.paused.length, 0);
  assert.deepEqual(h.calls.delivered, [pending.text]);
  assert.ok(h.storage.get(K.expect).sentAt > 0);
  assert.equal(h.storage.get(K.pending), null);
}

// При обновлении старый неотправленный ход Reviewer не обнуляется; доставленный
// ход продолжает жить и может быть принят существующим integration-тестом.
{
  const store = new Map([[K.stateV, '1.4.91'], [K.expect, oldExpect], [K.pending, pending]]);
  const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'SCRIPT_VERSION', 'log',
    `let ghostAfterUpdate = null; ${migrate}\nreturn migrateState;`)(
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K, '1.4.92', () => {},
  );
  assert.equal(fn(), '«rev-1», dispatch');
  assert.equal(store.get(K.pause).kind, 'update-recovery');
  assert.deepEqual(store.get(K.expect), oldExpect);
  assert.deepEqual(store.get(K.pending), pending);
}
for (const hasMessage of [false, true]) {
  const legacy = { ...oldExpect, sentAt: 1, verified: false, seen: [], watermark: '' };
  const store = new Map([[K.expect, clone(legacy)]]);
  const pauses = [];
  const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'messagesAfter', 'norm', 'pause', 'dbg', 'roleFromPath',
    `let droppedHandoff = null; ${revive}\nreturn reviveUnverifiedHandoff;`)(
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K,
    () => hasMessage ? [{ id: 'already-sent' }] : [], norm, (reason, opts) => pauses.push({ reason, opts }), () => {}, () => warden.id,
  );
  const result = fn();
  if (hasMessage) {
    assert.equal(result, '');
    assert.equal(store.get(K.expect).verified, true, 'подтверждённый ход сохраняется');
    assert.equal(pauses.length, 0);
  } else {
    assert.equal(result, 'reviewer-held');
    assert.deepEqual(store.get(K.expect), legacy);
    assert.equal(pauses[0].opts.kind, 'reviewer-task-pending');
  }
  assert.equal(store.has(K.pending), false, 'рабочая карточка не ставится в повторную отправку');
}


// Полная проверка прав перед фактической доставкой: устаревший кеш,
// перенастроенная роль и псевдоним одного Agent ID не обходят dispatchTask.
{
  const other = { ...kernel, id: 'exec-1' };
  const queued = { roleId: other.id, text: 'рабочее задание', at: Date.now() };
  const waiting = { kind: 'dispatch', roleId: other.id, roleName: other.name, roleFn: 'Executor', ref: 'card-1', runId: 'r1' };
  const h = makeConsumer(waiting, queued, [other]);
  await h.consumePending(true);
  assert.deepEqual(h.calls.roleReads, [{ fresh: true, requireFresh: true }]);
  assert.deepEqual(h.calls.delivered, [queued.text]);
}
for (const { waiting, owners } of [
  { waiting: { ...oldExpect, roleFn: '', roleName: 'Другой приёмщик' }, owners: [{ ...reviewer, id: warden.id }] },
  { waiting: { ...oldExpect, roleFn: 'Executor', roleName: 'Kernel' }, owners: [{ ...kernel, id: warden.id }, warden] },
  { waiting: { ...oldExpect, roleFn: 'Executor', roleName: 'Kernel' }, owners: [warden] },
  { waiting: { ...oldExpect, roleFn: 'Executor', roleName: 'Kernel' }, owners: new Error('Notion offline') },
]) {
  const h = makeConsumer(waiting, pending, owners);
  await h.consumePending(true);
  assert.equal(h.calls.delivered.length, 0);
  assert.equal(h.calls.writes.length, 0, 'ни ожидание, ни очередь не меняются');
  assert.deepEqual(h.calls.roleReads, [{ fresh: true, requireFresh: true }]);
  assert.ok(['reviewer-task-pending', 'reviewer-task-check'].includes(h.calls.paused[0].options.kind));
}
{
  const h = makeConsumer({ ...oldExpect, roleFn: 'Executor', roleName: 'Kernel', roleId: 'other-id' }, pending, [kernel]);
  await h.consumePending(true);
  assert.equal(h.calls.paused[0].options.kind, 'reviewer-task-check');
  assert.equal(h.calls.roleReads.length, 0);
  assert.equal(h.calls.writes.length, 0);
}
{
  const orphan = { ...pending, text: 'старый текст без маркера' };
  const h = makeConsumer(null, orphan);
  await h.consumePending(true);
  assert.equal(h.calls.paused[0].options.kind, 'reviewer-task-pending');
  assert.equal(h.calls.delivered.length, 0);
  assert.equal(h.calls.writes.length, 0);
}
{
  const reminder = { ...pending, text: 'Пожалуйста, добавь маркер CF_AGENT_RESULT.' };
  const expect = { ...oldExpect, tries: 1, dispatchSentAt: 123, text: reminder.text };
  const h = makeConsumer(expect, reminder);
  await h.consumePending(true);
  assert.deepEqual(h.calls.delivered, [reminder.text], 'старое подтверждённое напоминание по существующему ходу доставляется');
}

// После обновления ожидание старой выдачи не пропадает и при пустой очереди;
// неизвестная старая функция также не должна приводить к откату карточки.
for (const legacy of [oldExpect, { ...oldExpect, roleFn: '', roleName: 'Независимый приёмщик' }]) {
  const store = new Map([[K.stateV, '1.4.91'], [K.expect, legacy]]);
  const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'SCRIPT_VERSION', 'log',
    `let ghostAfterUpdate = null; ${migrate}\nreturn migrateState;`)(
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K, '1.4.92', () => {},
  );
  assert.match(fn(), /dispatch/);
  assert.equal(store.get(K.pause).kind, 'update-recovery');
  assert.deepEqual(store.get(K.expect), legacy);
  assert.equal(store.has(K.pending), false);
}
{
  const helper = cut('  async function holdLegacyUnsentDispatch() {', '  /**\n   * Один отложенный повтор');
  const tick = src.slice(src.indexOf('  async function tick('));
  assert.ok(tick.indexOf('await holdLegacyUnsentDispatch()') < tick.indexOf('await dropGhostHandoff("задание не дошло'));
  for (const [waiting, owners, expected] of [
    [oldExpect, [warden], true],
    [{ ...oldExpect, roleFn: '', roleName: 'Другой' }, [{ ...reviewer, id: warden.id }], true],
    [{ ...oldExpect, roleFn: '', roleName: 'Другой' }, [], true],
    [{ ...oldExpect, roleFn: '', roleName: 'Другой' }, new Error('offline'), true],
    [{ ...oldExpect, roleFn: 'Executor', roleName: 'Kernel' }, [{ ...kernel, id: warden.id }], false],
    [{ ...oldExpect, sentAt: 123 }, [warden], false],
  ]) {
    const store = new Map([[K.expect, clone(waiting)]]), pauses = [];
    const fn = new Function('GM_getValue', 'K', 'norm', 'roleRows', 'pause', `${helper}\nreturn holdLegacyUnsentDispatch;`)(
      (k, d) => store.has(k) ? store.get(k) : d, K, norm,
      async (opts) => { assert.deepEqual(opts, { fresh: true, requireFresh: true }); if (owners instanceof Error) throw owners; return owners; },
      (reason, options) => pauses.push({ reason, options }),
    );
    assert.equal(await fn(), expected);
    assert.deepEqual(store.get(K.expect), waiting);
    assert.equal(pauses.length, expected ? 1 : 0);
  }
}


{
  const h = makeDispatch();
  h.storage.set(K.expect, { kind: 'dispatch', roleId: warden.id, ref: 'old-card', runId: 'old-run', sentAt: 123, verified: false });
  assert.equal(await h.sendToRole(warden, 'неподтверждённое напоминание', 'dispatch', 'old-card', { isDispatchReminder: true, runId: 'old-run' }), false);
  assert.equal(h.storage.has(K.pending), false, 'одно sentAt не доказывает доставки');
}
{
  const legacy = { ...oldExpect, sentAt: 1, verified: false, seen: [], watermark: '' };
  const store = new Map([[K.expect, clone(legacy)]]), pauses = [];
  const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'messagesAfter', 'norm', 'pause', 'dbg', 'roleFromPath',
    `let droppedHandoff = null; ${revive}\nreturn reviveUnverifiedHandoff;`)(
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K,
    () => [{ id: 'unrelated-coordinator-message' }], norm, (reason, opts) => pauses.push({ reason, opts }), () => {}, () => 'coord-1',
  );
  assert.equal(fn(), 'reviewer-held');
  assert.deepEqual(store.get(K.expect), legacy, 'сообщение из чужого чата не становится подтверждением доставки');
  assert.equal(pauses[0].opts.kind, 'reviewer-task-pending');
}
{
  const resume = cut('  function resume(reason = "проверено Мастером") {', '  /**\n   * Проверка после капчи');
  const waiting = { ...oldExpect, sentAt: 123, verified: true };
  const store = new Map([[K.expect, clone(waiting)], [K.paused, 'Arena error'], [K.pause, { kind: 'arena-error', ref: 'm1' }]]);
  const pauses = [], retried = [];
  const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'pause', 'log', 'retryRejectedHandoff', `${resume}\nreturn resume;`)(
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K,
    (reason, options) => pauses.push({ reason, options }), () => {}, (...args) => retried.push(args),
  );
  fn();
  assert.deepEqual(store.get(K.expect), waiting);
  assert.equal(store.has(K.pending), false);
  assert.equal(retried.length, 0);
  assert.equal(pauses[0].options.kind, 'reviewer-task-pending');
}

// Консольная переотправка и обработчики ошибок не уничтожают связь с уже
// доставленной карточкой Reviewer. Повтор приёмки/ответа сохраняет её контекст.
{
  const debug = cut('    resend: () => {', '    step: () =>');
  for (const waiting of [oldExpect, { ...oldExpect, roleFn: '', roleName: 'Другой' }, { ...oldExpect, roleFn: 'Executor', roleName: 'Warden' }]) {
    const store = new Map([[K.expect, clone(waiting)]]);
    const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'forgetDeliveryReceipt', `return ({${debug}}).resend;`)(
      (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K, () => {},
    );
    assert.match(fn(), /не переотправляю/);
    assert.deepEqual(store.get(K.expect), waiting);
    assert.equal(store.has(K.pending), false);
  }
  for (const kind of ['review', 'answer']) {
    const waiting = { kind, roleFn: 'Reviewer', roleId: warden.id, text: 'исходный текст', ref: 'ref-1', sentAt: 123, verified: true };
    const store = new Map([[K.expect, clone(waiting)]]);
    const fn = new Function('GM_getValue', 'GM_setValue', 'K', 'forgetDeliveryReceipt', `return ({${debug}}).resend;`)(
      (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, clone(v)), K, () => {},
    );
    assert.equal(fn(), 'задание возвращено в очередь');
    assert.equal(store.get(K.expect).kind, kind);
    assert.equal(store.get(K.expect).ref, waiting.ref);
    assert.equal(store.get(K.pending).text, waiting.text);
  }
}
{
  const rejected = cut('  function retryRejectedHandoff(', '  /**\n   * Отказ из-за уже слитой ветки.');
  const stale = cut('  function retryStaleBranchHandoff(', '  /**');
  for (const block of [rejected, stale]) {
    const writes = [];
    const name = block.includes('retryRejectedHandoff') ? 'retryRejectedHandoff' : 'retryStaleBranchHandoff';
    const fn = new Function('GM_setValue', 'K', `${block}\nreturn ${name};`)((...args) => writes.push(args), K);
    assert.equal(fn({ ...oldExpect, sentAt: Date.now() }, { messageId: 'msg' }, 'error'), false);
    assert.equal(writes.length, 0);
  }
}

console.log('OK: новые Reviewer-карточки блокируются до побочных эффектов; приёмка, ответы и старые доставленные ходы сохранены');
