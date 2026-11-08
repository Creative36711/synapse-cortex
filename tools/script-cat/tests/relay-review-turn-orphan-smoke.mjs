// D-055 (07.11.2026, 22:05): ход приёмки — не рабочая карточка.
//
// После хода Warden «ожидание без отметки отправки — это прошлый ход» цикл
// снял `K.expect` хода приёмки миссии как фантом и открыл страницу адресата.
// Очередь при этом осталась — и упёрлась в две проверки, написанные для старой
// рабочей выдачи роли с функцией Reviewer: «в очереди осталась рабочая карточка
// Reviewer» и «Очередь адресована Reviewer». Цикл встал до Мастера с советом
// «проверьте чат и Run ID», хотя ни карточки, ни Run ID у хода приёмки нет.
//
// Корень: `restoreMissingSendMark` доказывал доставку только по dispatch/run.
// У приёмки, ответа на вопрос и арбитража этих номеров нет — есть `turn_id`,
// напечатанный в самом задании. Поэтому живой ход не мог быть доказан и
// объявлялся фантомом.
//
// Проверяется настоящими блоками собранного скрипта и настоящими промптами
// компилятора (review/answer/arbiter), а не пересказом:
//   • доставку хода приёмки доказывает `turn_id` в чате адресата;
//   • доказанный ход не снимается как фантом и карточка не откатывается;
//   • чужой `turn_id`, чужой чат и капча доказательством не считаются;
//   • очередь хода приёмки не выдаёт паузу «адресована Reviewer»;
//   • рабочая карточка Reviewer по-прежнему блокируется (D-040/D-042);
//   • освободившаяся очередь хода приёмки восстанавливается сверкой, а не
//     отправкой наугад, и без читаемого `turn_id` — пауза.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, UUID, reviewRequest, answerRequest } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert.ok(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}

// Разбор ID и признак вида хода лежат рядом: один срез на оба, иначе
// объявление REVIEW_TURN_KINDS попало бы в тест дважды.
const idsBlock = cut('  function promptDispatchIds(text) {', '  /** Своё сообщение в транскрипте');
const reviewKinds = '';
const receiptsBlock = cut('  const DELIVERY_RECEIPT_KEY', '  /** Уведомление и время относятся только к той очереди');
const adoptBlock = cut('  async function roleAddress(', '  /**\n   * Досылает задание, сохранённое перед переходом');
const consumeBlock = cut('  async function consumePending(', '  // ───────────────────── следы прошлых попыток');
const ghostBlock = cut('  async function dropGhostHandoff(', '  /** Уведомление и время относятся только к той очереди');

// Срезы молча не бывают пустыми: пустой блок дал бы зелёный тест без проверки.
assert.match(idsBlock, /const REVIEW_TURN_KINDS = \["review", "answer", "arbiter"\]/, 'признак вида хода в срезе есть');
for (const [name, block] of Object.entries({ idsBlock, receiptsBlock, adoptBlock, consumeBlock, ghostBlock })) {
  assert.ok(block.length > 40, `${name}: срез непустой`);
}

const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const flat = (x) => String(x || '').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || ''));
const rt = (prop) => (prop?.rich_text || prop?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const idTime = (id) => {
  const ms = Number.parseInt(String(id || '').replace(/-/g, '').slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : 0;
};
const clone = (x) => (x === undefined ? undefined : structuredClone(x));

const K = {
  expect: 'cfn-expect', pending: 'cfn-pending', lastSend: 'cfn-last-send', deadSend: 'cfn-dead-send',
  log: 'cfn-console-log', pause: 'cfn-pause-context', paused: 'cfn-paused', step: 'cfn-step',
};
const WARDEN = {
  id: '01a19d0e-839f-7a23-89dc-93e4f2884cbb', name: 'Warden', fn: 'Reviewer',
  url: 'https://arena.ai/agent/warden', status: 'Активна',
};
const WORKER = {
  id: '01a19d2b-bd07-722f-bbdb-20ba2f90028b', name: 'Executor Core', fn: 'Executor',
  url: 'https://arena.ai/agent/exec', status: 'Активна',
};

// ── 1. Настоящий промпт приёмки несёт turn_id и НЕ несёт dispatch/run ───────
const reviewPrompt = PromptCompiler.compile(reviewRequest());
assert.ok(reviewPrompt.ok, 'боевой промпт приёмки собран');
const answerPrompt = PromptCompiler.compile(answerRequest());
assert.ok(answerPrompt.ok, 'боевой промпт ответа на вопрос собран');
const parseIds = new Function(`${idsBlock}\nreturn promptDispatchIds;`)();
for (const [name, prompt] of [['review', reviewPrompt], ['answer', answerPrompt]]) {
  assert.match(prompt.text, new RegExp(`turn_id"?\\s*[:=]\\s*"?${UUID.turn}\\b`), `${name}: номер хода в задании есть`);
  assert.equal(parseIds(prompt.text), null, `${name}: рабочей выдачи (dispatch/run) в задании нет`);
}

// ── 2. Стенд на настоящих блоках ───────────────────────────────────────────
function make({
  expect = null, pending = null, nodes = [], receipts = [], currentRole = WARDEN.id,
  owners = [WARDEN], captcha = false, deadSend = '',
} = {}) {
  const store = new Map([[K.expect, clone(expect)], [K.pending, clone(pending)], ['cfn-delivery-receipts-v1', clone(receipts)]]);
  if (deadSend) store.set(K.deadSend, deadSend);
  const calls = { pauses: [], logs: [], delivered: [], notices: [], reads: [], rollbacks: [], navigations: [] };
  const env = {
    K, norm, isUuid, rt, idTime, flat,
    C: { pendingTtlMs: 600_000, undeliveredTtlMs: 7_200_000, sendRetries: 3, tickMs: 10, insertRetries: 2 },
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, clone(v)),
    roleFromPath: () => currentRole,
    roleRows: async () => clone(owners),
    roles: async () => clone(owners.filter((r) => r.status === 'Активна')),
    navigateTo: async (role, why) => { calls.navigations.push({ role, why }); return true; },
    notion: async (method, path) => { calls.reads.push({ method, path }); throw new Error('у хода приёмки нет карточки'); },
    taskState: () => '', taskTitle: () => '',
    patch: async () => { throw new Error('карточку трогать нельзя'); },
    userMessages: () => clone(nodes), messageRaw: (n) => n.raw, nodeId: (n) => n.id,
    messages: () => clone(nodes), lastMessageId: () => 'm0',
    releaseUndelivered: async (...args) => { calls.rollbacks.push(args); return true; },
    pause: (text, ctx) => calls.pauses.push({ text, ctx }),
    log: (text, error, opts) => calls.logs.push({ text, error, opts }),
    nowIso: () => '2026-11-07T22:05:14.000Z',
    appReady: () => ({ ok: true }),
    pendingSay: (_p, text) => calls.notices.push(text),
    autoOn: () => true,
    sendKey: () => 'key', composerHolds: () => false, userSaysSince: () => null, lastUserSays: () => false,
    captchaDialog: () => captcha, busySettled: async () => null, busyLabel: () => '',
    ensureFreshBranch: async () => {}, ensureComposer: async () => ({ editor: {}, closed: 0 }), composerText: () => '',
    clearComposer: () => true, sleep: async () => {}, writePrompt: () => true,
    deliver: async (_e, text) => { calls.delivered.push(text); return { ok: true, msgId: 'sent-1' }; },
    isDispatchAssignment: () => false, dispatchDeliveryNtfy: () => ({ ntfy: false }), dbg: () => {},
    setTimeout: () => {}, tick: () => {},
    journalDelivery: () => {}, classifyArenaFailure: () => 'unknown',
    openDialog: () => null, domReport: () => ({}), console: { warn() {} }, Math,
  };
  const boot = new Function('env', `
    const {K, norm, isUuid, rt, idTime, flat, C, GM_getValue, GM_setValue, roleFromPath, roleRows, roles, navigateTo, notion, taskState,
      taskTitle, patch, userMessages, messageRaw, nodeId, messages, lastMessageId, releaseUndelivered, pause, log,
      nowIso, appReady, pendingSay, autoOn, sendKey, composerHolds, userSaysSince, lastUserSays, captchaDialog,
      busySettled, busyLabel, ensureFreshBranch, ensureComposer, composerText, clearComposer, sleep, writePrompt,
      deliver, isDispatchAssignment, dispatchDeliveryNtfy, dbg, setTimeout, tick, journalDelivery,
      classifyArenaFailure, openDialog, domReport, console, Math} = env;
    let pendingNoticeAt = 0, insertFail = {at: 0, count: 0};
    ${idsBlock}\n${receiptsBlock}\n${adoptBlock}\n${consumeBlock}\n${ghostBlock}
    return { consumePending, adoptOrphanReview, dropGhostHandoff, restoreMissingSendMark, reviewTurnInChat,
      dispatchPromptInChat, isReviewTurnKind };`);
  return { ...boot(env), store, calls };
}

const reviewExpect = (over = {}) => ({
  kind: 'review',
  roleId: WARDEN.id, roleName: 'Warden', roleFn: '', roleUrl: WARDEN.url,
  ref: UUID.mission, runId: '', missionId: UUID.mission, turnId: UUID.turn,
  title: 'приёмка миссии', text: reviewPrompt.text, watermark: '', seen: [],
  at: Date.now() - 60_000, tries: 0, ...over,
});
const reviewPending = (over = {}) => ({
  roleId: WARDEN.id, roleName: 'Warden', roleUrl: WARDEN.url,
  kind: 'review', ref: UUID.mission, missionId: UUID.mission, turnId: UUID.turn,
  title: 'приёмка миссии', text: reviewPrompt.text, at: Date.now() - 60_000, ...over,
});
const OUR_TURN = { id: 'm-review-1', raw: reviewPrompt.text };
const OTHER_TURN = { id: 'm-other', raw: reviewPrompt.text.replaceAll(UUID.turn, '09238d7a-4791-4ff0-ba7b-9bc29e493061') };

// ── 3. Доказательство доставки: turn_id в чате адресата ────────────────────
{
  const h = make({ expect: reviewExpect(), nodes: [OUR_TURN] });
  const proof = h.reviewTurnInChat(h.store.get(K.expect));
  assert.ok(proof, 'своя реплика приёмки найдена по номеру хода');
  assert.equal(proof.id, 'm-review-1');
  const restored = h.restoreMissingSendMark(h.store.get(K.expect));
  assert.ok(restored && Number(restored.sentAt) > 0, 'отметка отправки восстановлена');
  assert.equal(h.store.get(K.expect).verified, true, 'ожидание помечено проверенным');
}
{
  const h = make({ expect: reviewExpect(), nodes: [OTHER_TURN] });
  assert.equal(h.reviewTurnInChat(h.store.get(K.expect)), null, 'чужой номер хода не доказательство');
  assert.equal(h.restoreMissingSendMark(h.store.get(K.expect)), null, 'без доказательства отметка не ставится');
}
{
  const h = make({ expect: reviewExpect(), nodes: [OUR_TURN], currentRole: WORKER.id });
  assert.equal(h.reviewTurnInChat(h.store.get(K.expect)), null, 'на чужой странице доказательств не ищем');
}
{
  const h = make({ expect: reviewExpect(), nodes: [OUR_TURN], deadSend: 'm-review-1' });
  assert.equal(h.reviewTurnInChat(h.store.get(K.expect)), null, 'заведомо мёртвая реплика не доказательство');
}
{
  const h = make({ expect: reviewExpect({ captcha: true }), nodes: [OUR_TURN] });
  assert.equal(h.reviewTurnInChat(h.store.get(K.expect)), null, 'после капчи реплика не доказательство');
}
{
  // Рабочая карточка доказывается по dispatch/run, а не по номеру хода.
  const h = make({});
  const cardExpect = { kind: 'dispatch', ref: 'a709d6df-4698-4a98-b111-90d22de42894',
    runId: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d', turnId: '', roleId: WORKER.id };
  assert.equal(h.reviewTurnInChat(cardExpect), null, 'карточка не доказывается номером хода');
  assert.equal(h.isReviewTurnKind('dispatch'), false, 'dispatch — не ход приёмки');
  for (const kind of ['review', 'answer', 'arbiter']) assert.equal(h.isReviewTurnKind(kind), true, `${kind} — ход приёмки`);
}

// ── 4. Живой ход приёмки не снимается как фантом ───────────────────────────
{
  const h = make({ expect: reviewExpect(), nodes: [OUR_TURN] });
  const ghost = await h.dropGhostHandoff('задание не дошло: отметки отправки нет');
  assert.equal(ghost, null, 'D-055: доказанный ход приёмки — не фантом');
  assert.deepEqual(h.calls.rollbacks, [], 'карточка не откатывается');
  assert.ok(h.store.get(K.expect), 'ожидание осталось живым');
  assert.equal(h.store.get(K.expect).verified, true);
}
{
  // Настоящий фантом (ни реплики, ни квитанции) по-прежнему снимается, но
  // карточки у хода приёмки нет — откатывать нечего.
  const h = make({ expect: reviewExpect(), nodes: [] });
  const ghost = await h.dropGhostHandoff('задание не дошло: отметки отправки нет');
  assert.ok(ghost, 'фантом без доказательств снимается');
  assert.equal(h.store.get(K.expect), null);
  assert.deepEqual(h.calls.rollbacks.map((r) => r[0].ref), [UUID.mission], 'откат идёт по ref хода, а не по карточке');
}

// ── 5. Очередь хода приёмки не выдаёт паузу «адресована Reviewer» ──────────
{
  // Боевая запись ожидания приёмки: роль уже числится Reviewer, вид хода —
  // review. Проверка «адресат — Reviewer» такой ход останавливать не должна.
  const h = make({
    expect: reviewExpect({ roleFn: 'Reviewer' }),
    pending: reviewPending({ roleFn: 'Reviewer' }),
    nodes: [OTHER_TURN],
  });
  await h.consumePending(true);
  assert.deepEqual(h.calls.pauses, [], 'нет «Очередь адресована Reviewer» и нет «рабочая карточка Reviewer»');
}
{
  // Очередь освободилась после снятия фантома: ожидания нет, вид хода известен
  // только по маркеру в тексте задания.
  const h = make({ expect: null, pending: reviewPending(), nodes: [OUR_TURN] });
  await h.consumePending(true);
  assert.deepEqual(h.calls.pauses, [], 'осиротевшая очередь приёмки не будит Мастера');
  assert.deepEqual(h.calls.delivered, [], 'D-045/D-055: доказанную доставку не повторяем');
  assert.equal(h.store.get(K.pending), null, 'очередь снята: ход восстановлен, ответ читается');
  assert.equal(h.store.get(K.expect).turnId, UUID.turn, 'ожидание восстановлено с номером хода');
}
{
  // Доставка не доказана — ход восстанавливается и уходит ровно один раз.
  const h = make({ expect: null, pending: reviewPending(), nodes: [] });
  assert.equal(await h.consumePending(true), true, 'шаг занят отправкой');
  assert.deepEqual(h.calls.pauses, [], 'без паузы');
  assert.equal(h.calls.delivered.length, 1, 'одна отправка, не больше');
  assert.equal(h.calls.delivered[0], reviewPrompt.text, 'уходит тот же текст задания');
  assert.equal(h.store.get(K.pending), null, 'очередь снята после подтверждённой доставки');
  assert.equal(h.store.get(K.expect).kind, 'review', 'вид хода сохранён');
  assert.equal(h.store.get(K.expect).turnId, UUID.turn, 'номер хода сохранён');
}
{
  // Номер хода не читается — пауза вместо отправки наугад.
  const h = make({ expect: null, pending: reviewPending({ turnId: '' }), nodes: [] });
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-review', 'точная причина вместо общей паузы');
  assert.deepEqual(h.calls.delivered, [], 'ничего не отправлено');
  assert.equal(h.store.get(K.pending).turnId, '', 'очередь сохранена как есть');
}
{
  // Сверять чат на чужой странице нельзя — и открыть адресата обязан этот же
  // проход. D-068 (08.11, 17:45): раньше ветка только писала «открываю
  // страницу адресата» и возвращала шаг, а перехода не делал никто: цикл
  // повторял ту же строку пять часов.
  const h = make({ expect: null, pending: reviewPending(), nodes: [OUR_TURN], currentRole: WORKER.id });
  assert.equal(await h.consumePending(true), true);
  assert.deepEqual(h.calls.pauses, [], 'Мастера не будим');
  assert.equal(h.calls.navigations.length, 1, 'переход к адресату действительно сделан');
  assert.equal(h.calls.navigations[0].role.id, WARDEN.id, 'открывается страница адресата очереди');
  assert.match(String(h.calls.notices.at(-1)), /открываю «Warden»/, 'в журнале назван адресат');
  assert.ok(h.store.get(K.pending), 'очередь остаётся');
}
{
  // Адресата нет в базе и в очереди нет ссылки — тогда честная пауза, а не
  // тик, который вечно повторяет «открываю».
  const h = make({ expect: null, pending: reviewPending({ roleUrl: '' }), nodes: [OUR_TURN],
    currentRole: WORKER.id, owners: [] });
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.navigations.length, 0, 'идти некуда');
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-review', 'пауза называет причину');
  assert.match(String(h.calls.pauses.at(-1).text), /Agent URL/, 'Мастеру сказано, что проверить');
}

// ── 6. Рабочая карточка Reviewer по-прежнему блокируется ───────────────────
{
  const cardText = 'Карточка «SYN-2 · S-7» · dispatch a709d6df-4698-4a98-b111-90d22de42894 · run 8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d\n' +
    'Последней строкой: CF_AGENT_RESULT {"dispatch_id":"a709d6df-4698-4a98-b111-90d22de42894","run_id":"8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d"}';
  const workExpect = { kind: 'dispatch', roleId: WARDEN.id, roleName: 'Warden', roleFn: 'Reviewer',
    ref: 'a709d6df-4698-4a98-b111-90d22de42894', runId: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d',
    text: cardText, at: Date.now() };
  const workPending = { roleId: WARDEN.id, roleName: 'Warden', kind: 'dispatch',
    ref: workExpect.ref, runId: workExpect.runId, text: cardText, at: Date.now() };
  const h = make({ expect: workExpect, pending: workPending, nodes: [{ id: 'm1', raw: cardText }] });
  assert.equal(await h.consumePending(true), true);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'reviewer-task-pending', 'D-040/D-042: рабочая карточка Reviewer не уходит');
  assert.deepEqual(h.calls.delivered, []);
  assert.deepEqual(h.store.get(K.expect), workExpect, 'ожидание не подменено');
  assert.deepEqual(h.store.get(K.pending), workPending, 'очередь не снята');
}
{
  // Маркер приёмки в тексте очереди — не рабочая карточка, даже если адресат
  // уже числится Reviewer: вид хода берётся из очереди, когда ожидания нет.
  const h = make({ expect: null, pending: reviewPending({ text: `${reviewPrompt.text}\n\nCF_REVIEW_RESULT` }), nodes: [OUR_TURN] });
  await h.consumePending(true);
  assert.deepEqual(h.calls.pauses, []);
}

// ── 7. Порядок в consumePending: сверка хода приёмки идёт до просрочки ─────
{
  const adoptAt = consumeBlock.indexOf('await adoptOrphanReview(pending, me)');
  const ttlAt = consumeBlock.indexOf('pending.undelivered ? C.undeliveredTtlMs : C.pendingTtlMs');
  assert.ok(adoptAt > 0, 'сверка хода приёмки вызывается');
  assert.ok(adoptAt < ttlAt, 'сверка стоит до снятия просроченной очереди');
  assert.match(consumeBlock, /if \(await adoptOrphanReview\(pending, me\)\) return true;/, 'сверка занимает шаг');
  // Пауза «адресована Reviewer» и проверка «адресат не Executor/Auditor»
  // оставлены только для рабочей очереди: `!reviewQueue` перед каждой.
  const reviewerPauseAt = consumeBlock.indexOf('pause("Очередь адресована Reviewer');
  const guard = consumeBlock.slice(0, reviewerPauseAt);
  const lastIf = guard.slice(guard.lastIndexOf('if ('));
  assert.match(lastIf, /^if \(!reviewQueue && /, 'пауза «адресована Reviewer» обходится для хода приёмки');
  assert.match(consumeBlock, /if \(!reviewQueue && \(!owners\.length/, 'проверка функции адресата — тоже только для рабочей очереди');
  assert.match(consumeBlock, /const reviewQueue = isReviewTurnKind\(waitingForPolicy\?\.kind\)/, 'вид хода берётся из ожидания');
  assert.match(consumeBlock, /CF_\(REVIEW\|ANSWER\|ARBITER\)_RESULT/, 'и из маркера очереди, когда ожидания уже нет');
}

console.log('D-055: ход приёмки доказывается номером хода и не путается с рабочей карточкой');
