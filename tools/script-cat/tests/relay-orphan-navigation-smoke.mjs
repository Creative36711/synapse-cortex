// Проба D-068: обещание «открываю страницу адресата» — это переход, а не строка.
//
// 08.11.2026, 17:45. Вопрос Координатора по ADR V-2 ушёл приёмке, но ожидание
// хода «ответ на вопрос» не записалось (запись `K.expect` и очередь `K.pending`
// пишутся до перехода, а после перезагрузки вкладки ожидание не дожило), и в
// очереди остался ход приёмки без хозяина.
//
// Дальше сработала ветка `adoptOrphanReview`: она писала в журнал
//   «Ход приёмки остался без ожидания: открываю страницу адресата…»
// и возвращала `true`. Перехода при этом не делал НИКТО: `navigateTo` в этой
// ветке не вызывался, а `consumePending` считается выполнившим шаг. На каждом
// тике повторялась та же строка, вкладка оставалась на странице Координатора —
// и цикл стоял с 17:45 до утра, хотя Warden работал в своей вкладке.
//
// Поэтому проверяется:
//   1) на чужой странице цикл действительно уходит к адресату очереди;
//   2) адресат ищется по id из базы «Роли», даже если роль уже не «Активна»
//      (очередь живёт дольше смены статуса), и по ссылке из очереди — как
//      последний довод;
//   3) адреса нет вовсе — пауза `orphan-review`, а не тик-пустышка;
//   4) доставка, доказанная номером хода, по-прежнему снимает очередь без
//      перехода и без отправки;
//   5) «вопрос передан приёмке» пишется только после того, как ход поставлен
//      в очередь: защитный отказ `sendToRole` больше не выдаётся за передачу.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { answerRequest, PromptCompiler, UUID } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (a, b) => {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert.ok(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
};

const adoptBlock = cut('  async function roleAddress(', '  /**\n   * Досылает задание, сохранённое перед переходом');
const answerBlock = cut('  async function startAnswer(', '  /** Ход приёмки по вопросу');
assert.ok(adoptBlock.length > 400, 'срез разбора очереди непустой');
assert.ok(answerBlock.length > 400, 'срез передачи вопроса непустой');

const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || ''));
const clone = (x) => (x === undefined ? undefined : structuredClone(x));
const K = { expect: 'cfn-expect', pending: 'cfn-pending' };

const WARDEN = { id: '01a19d0e-839f-7a23-89dc-93e4f2884cbb', name: 'Warden', fn: 'Reviewer', url: 'https://arena.ai/agent/warden', status: 'Активна' };
const WARDEN_PAUSED = { ...WARDEN, status: 'Ждёт' };
const COORDINATOR = { id: '01a19db6-fa65-7081-8bc9-787ce08ec3b6', name: 'Coordinator', fn: 'Coordinator', url: 'https://arena.ai/agent/coord', status: 'Активна' };

const answerPrompt = PromptCompiler.compile(answerRequest());
assert.ok(answerPrompt.ok, 'боевой промпт ответа на вопрос собран');

function makeOrphan({ pending, owners = [WARDEN], currentRole = COORDINATOR.id, me = currentRole, shell = true }) {
  const store = new Map([[K.expect, null], [K.pending, clone(pending)]]);
  const calls = { navigations: [], pauses: [], notices: [], logs: [] };
  const env = {
    K, norm, isUuid, clone,
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, clone(v)),
    roleFromPath: () => currentRole,
    roleRows: async () => clone(owners),
    roles: async () => clone(owners.filter((r) => r.status === 'Активна')),
    navigateTo: async (role, why) => { calls.navigations.push({ role, why }); return true; },
    appReady: () => (shell ? { ok: true } : { ok: false, why: 'транскрипт не отрисован' }),
    isReviewTurnKind: (kind) => ['review', 'answer', 'arbiter'].includes(String(kind || '')),
    pendingSay: (_p, text) => calls.notices.push(text),
    log: (text) => calls.logs.push(text),
    pause: (text, ctx) => calls.pauses.push({ text, ctx }),
  };
  const names = Object.keys(env);
  const factory = new Function(...names, `${adoptBlock}\nreturn { adoptOrphanReview, roleAddress };`);
  const api = factory(...names.map((n) => env[n]));
  // `me` передаётся в adoptOrphanReview явно: так проба говорит, на какой
  // странице стоит вкладка, не подменяя роль в пути.
  return { ...api, store, calls, ask: (p) => api.adoptOrphanReview(p, me) };
}

const answerPending = (over = {}) => ({
  roleId: WARDEN.id, roleName: 'Warden', roleFn: 'Reviewer', roleUrl: WARDEN.url,
  kind: 'answer', ref: UUID.question, missionId: UUID.mission, turnId: UUID.turn,
  questionId: UUID.question, title: 'ответ на вопрос агента', text: answerPrompt.text,
  at: Date.now() - 60_000, ...over,
});

// ── 1. Чужая страница: переход действительно делается ──────────────────────
{
  const h = makeOrphan({ pending: answerPending() });
  assert.equal(await h.ask(h.store.get(K.pending)), true, 'шаг занят разбором');
  assert.equal(h.calls.navigations.length, 1, 'переход к адресату сделан, а не обещан');
  assert.equal(h.calls.navigations[0].role.id, WARDEN.id, 'открывается страница адресата очереди');
  assert.match(String(h.calls.notices.at(-1)), /открываю «Warden»/, 'в журнале назван адресат');
  assert.deepEqual(h.calls.pauses, [], 'Мастера не будим, пока адрес известен');
  assert.ok(h.store.get(K.pending), 'очередь сохранена');
}

// ── 2. Роль уже не «Активна», но адрес есть: адресат всё равно находится ───
{
  // Ссылки в самой очереди нет: единственный путь к адресу — строка базы,
  // хотя роль уже не «Активна». Очередь живёт дольше смены статуса.
  const h = makeOrphan({ pending: answerPending({ roleUrl: '' }), owners: [WARDEN_PAUSED] });
  const who = await h.roleAddress(h.store.get(K.pending));
  assert.equal(who?.id, WARDEN.id, 'адрес берётся из строки базы, а не только из активных');
  assert.equal(await h.ask(h.store.get(K.pending)), true);
  assert.equal(h.calls.navigations.length, 1, 'переход сделан');
  assert.deepEqual(h.calls.pauses, [], 'паузы нет: адрес найден');
}
{
  // База пуста — последний довод ссылка из самой очереди.
  const h = makeOrphan({ pending: answerPending(), owners: [] });
  const who = await h.roleAddress(h.store.get(K.pending));
  assert.equal(who?.url, WARDEN.url, 'ссылка из очереди — запасной адрес');
  assert.equal(await h.ask(h.store.get(K.pending)), true);
  assert.equal(h.calls.navigations.length, 1);
}

// ── 3. Адреса нет вовсе: честная пауза, а не тик-пустышка ──────────────────
{
  const h = makeOrphan({ pending: answerPending({ roleUrl: '' }), owners: [] });
  assert.equal(await h.ask(h.store.get(K.pending)), true);
  assert.equal(h.calls.navigations.length, 0, 'идти некуда');
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-review', 'причина названа');
  assert.match(String(h.calls.pauses.at(-1).text), /Agent URL/, 'Мастеру сказано, что проверить');
  assert.match(String(h.calls.pauses.at(-1).text), /не отправляю/, 'отправки не было');
}

// ── 4. Номер хода не читается — прежняя пауза на месте ─────────────────────
{
  const h = makeOrphan({ pending: answerPending({ turnId: '' }) });
  assert.equal(await h.ask(h.store.get(K.pending)), true);
  assert.equal(h.calls.pauses.at(-1).ctx.kind, 'orphan-review');
  assert.match(String(h.calls.pauses.at(-1).text), /номер хода из него не читается/);
  assert.equal(h.calls.navigations.length, 0);
}

// ── 5. Мы уже на странице адресата, но она не отрисована: ждём ───────────
{
  const h = makeOrphan({ pending: answerPending(), currentRole: WARDEN.id, shell: false });
  assert.equal(await h.ask(h.store.get(K.pending)), true);
  assert.match(String(h.calls.notices.at(-1)), /страница ещё грузится/, 'причина ожидания названа');
  assert.equal(h.calls.navigations.length, 0, 'переход не подменяет ожидание отрисовки');
  assert.deepEqual(h.calls.pauses, [], 'недорисованная страница — не повод будить Мастера');
}

// ── 6. Настоящее ожидание — разбор не вмешивается ──────────────────────────
{
  const h = makeOrphan({ pending: answerPending() });
  h.store.set(K.expect, { kind: 'answer', roleId: WARDEN.id, turnId: UUID.turn });
  assert.equal(await h.ask(h.store.get(K.pending)), false, 'живой ход не перехватывается');
  assert.equal(h.calls.navigations.length, 0);
}

// ── 7. «Передан приёмке» — только после очереди ────────────────────────────
assert.match(src, /const queued = await sendToRole\(role, answerPrompt\(mission, role, item, turnId\), "answer", item\.id, \{/,
  'результат отправки сохраняется');
assert.match(answerBlock, /if \(!queued\) \{[\s\S]{0,400}?не передан приёмке/, 'отказ транспорта назван отказом');
assert.match(answerBlock, /return false;/, 'отказ возвращает false — вопрос остаётся «Ждёт»');
assert.ok(
  answerBlock.indexOf('const queued = await sendToRole') < answerBlock.indexOf('передан приёмке «${role.name}»'),
  'строка «передан» идёт после постановки в очередь',
);
// Старый порядок (лог до отправки) не вернулся: он и давал ложное «передан».
assert.ok(
  !/log\(`Вопрос «\$\{oneLine\(item\.text, 90\)\}» передан приёмке «\$\{role\.name\}»\.`, false, \{ ntfy: "quiet" \}\);\n    const queued/.test(answerBlock),
  'ложный порядок удалён',
);

console.log('OK: relay 1.12.19 — «открываю страницу адресата» это переход, а отказ транспорта не выдаётся за переданный вопрос');
