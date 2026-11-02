// Проба 1.4.74: ошибка Arena поверх задания не считается доставкой, а задание
// повторяется минимальным сообщением «прочитай карточку сам».
//
// 25.10 задание Architect (NAR-2.16) не принималось трижды — 21:24, 22:55 и
// 23:08: «Something went wrong. Please try again.» Один раз это были полные
// 7 586 символов, другой — 7 610 после повторной отправки. Дело не в длине и не
// в разметке: короткое сообщение тому же агенту проходило. Поэтому повтор — не
// пересказ задания, а просьба открыть карточку Notion: ссылка, номера выдачи и
// формат маркера. Второй отказ подряд — пауза, а не бесконечный повтор.
//
// Здесь проверяется:
//   1) после ошибки в очередь кладётся минимальное сообщение со ссылкой на
//      карточку, а не полный промпт; повтор идёт той же карточке и с тем же Run ID;
//   2) повторов ровно один: второй отказ — пауза;
//   3) id «мёртвого» сообщения запоминается, и `lastUserSays` не принимает
//      старую копию за доставку;
//   4) «Продолжить» после такой паузы снова ставит минимальное сообщение, а поле
//      ввода перед вставкой очищается — Arena возвращает туда отклонённый текст.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const has = (needle, why) => assert.ok(src.includes(needle), `в скрипте нет: ${why}`);

// ── 1. Минимальный повтор: текст, счётчик, метка мёртвого сообщения ────────
const fromRequeue = src.indexOf('  /**\n   * Минимальное сообщение вместо отклонённого задания.');
const toRequeue = src.indexOf('  /**\n   * Ждём ответ без маркера.');
assert.ok(fromRequeue > 0 && toRequeue > fromRequeue, 'блок повтора на месте');
const requeueBlock = src.slice(fromRequeue, toRequeue);

function makeRequeue() {
  const store = new Map();
  const logs = [];
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'log',
    `${requeueBlock}\nreturn { retryRejectedHandoff, minimalPrompt };`,
  );
  const api = fn(
    (key, def) => (store.has(key) ? store.get(key) : def),
    (key, value) => store.set(key, value),
    { deadSend: 'k-dead', pending: 'k-pending', expect: 'k-expect' },
    { arenaResendMax: 1, arenaRetryMs: 180000 },
    (text, error, opts) => logs.push({ text, error: Boolean(error), ntfy: opts?.ntfy }),
  );
  return { ...api, store, logs };
}

const fullPrompt =
  '=== CF_TECH v1 ===\n━━━ ТЕХНИЧЕСКАЯ ИНФОРМАЦИЯ · Architect ━━━\n' +
  'Задача NAR-2.16 · ADR 2.14 принят (dispatch 4046f0cf-5705-81bd-92ca-ed93c5a98eab, run d03f84ab).\n' +
  'ЦЕЛЬ И ГРАНИЦЫ\n'.padEnd(7000, 'правила хода и техблок ');

const expect = {
  roleId: 'agent-architect',
  roleName: 'Architect',
  roleUrl: 'https://arena.example/agent/architect',
  kind: 'dispatch',
  ref: '4046f0cf-5705-81bd-92ca-ed93c5a98eab',
  runId: 'd03f84ab-a1b7-4b52-9495-63ca54f7420e',
  title: 'NAR-2.16 · ADR 2.14 принят',
  watermark: 'chat-message-41',
  text: fullPrompt,
  sentAt: Date.now(),
  verified: true,
};

{
  const { retryRejectedHandoff, store, logs } = makeRequeue();
  const ok = retryRejectedHandoff(expect, { messageId: 'chat-message-42' }, 'Arena ответила «Something went wrong»');
  assert.equal(ok, true, 'повтор поставлен');

  const pending = store.get('k-pending');
  assert.equal(pending.roleId, expect.roleId, 'задание адресовано тому же агенту');
  assert.ok(pending.text.length < 900, 'повтор — минимальное сообщение, а не промпт');
  assert.ok(!pending.text.includes('ТЕХНИЧЕСКАЯ ИНФОРМАЦИЯ'), 'техблок не дублируется');
  assert.ok(pending.text.includes('Прочитай задание сам'), 'агента просят прочитать карточку');
  assert.ok(
    pending.text.includes('https://app.notion.com/p/4046f0cf570581bd92caed93c5a98eab'),
    'ссылка на карточку собрана из id',
  );
  assert.ok(pending.text.includes('"dispatch_id":"4046f0cf-5705-81bd-92ca-ed93c5a98eab"'), 'dispatch в маркере тот же');
  assert.ok(pending.text.includes('"run_id":"d03f84ab-a1b7-4b52-9495-63ca54f7420e"'), 'run в маркере тот же');
  assert.ok(pending.text.includes('gh pr merge --squash'), 'мерж PR остаётся за исполнителем');

  const next = store.get('k-expect');
  assert.equal(next.sentAt, null, 'отметка отправки снята: доставки не было');
  assert.equal(next.verified, false, 'подтверждение доставки снято');
  assert.equal(next.arenaResend, 1, 'повтор посчитан');
  assert.equal(next.text, pending.text, 'ожидание знает, какой текст уйдёт');
  assert.equal(store.get('k-dead'), 'chat-message-42', 'мёртвое сообщение запомнено по id');
  assert.ok(logs.some((l) => l.error && l.text.includes('минимальным сообщением')), 'в журнале видна причина повтора');
  assert.ok(logs.some((l) => l.text.includes('символов вместо')), 'в журнале видно длины: было и стало');
  assert.ok(!logs.some((l) => l.ntfy === 'loud'), 'громкого пуша нет: цикл не остановлен');
}

// ── 2. Повтор ровно один: второй отказ — пауза ─────────────────────────────
{
  const { retryRejectedHandoff, store } = makeRequeue();
  retryRejectedHandoff(expect, { messageId: 'm1' }, 'первая');
  const again = { ...store.get('k-expect'), sentAt: Date.now() };
  assert.equal(retryRejectedHandoff(again, { messageId: 'm2' }, 'вторая'), false, 'второй раз не повторяем');
  assert.equal(store.get('k-expect').arenaResend, 1, 'счётчик не растёт');
  assert.equal(store.get('k-dead'), 'm1', 'метка осталась на первом мёртвом сообщении');
}

// ── 3. Чужая и старая ошибка повтором не считается ─────────────────────────
{
  const { retryRejectedHandoff, store } = makeRequeue();
  assert.equal(retryRejectedHandoff({ ...expect, roleId: '' }, { messageId: 'm1' }, 'x'), false, 'без получателя повторять некуда');
  assert.equal(retryRejectedHandoff({ ...expect, sentAt: null }, { messageId: 'm1' }, 'x'), false, 'не отправляли — повторять нечего');
  assert.equal(retryRejectedHandoff({ ...expect, sentAt: Date.now() - 600000 }, { messageId: 'm1' }, 'x'), false, 'старая ошибка — не про эту отправку');
  assert.equal(store.has('k-pending'), false, 'очередь не создаётся зря');
}

// ── 4. lastUserSays: мёртвая копия — не доставка ───────────────────────────
const fromSays = src.indexOf('  function lastUserSays(key) {');
const toSays = src.indexOf('  /**\n   * Ждём подтверждение доставки');
assert.ok(fromSays > 0 && toSays > fromSays, 'блок lastUserSays на месте');
const saysBlock = src.slice(fromSays, toSays);

function says({ dead = '', lastId = 'chat-message-42', text = 'Задание 2.16 · NAR-2.16' } = {}) {
  const fn = new Function(
    'GM_getValue', 'K', 'userMessages', 'nodeId', 'flat',
    `${saysBlock}\nreturn { lastUserSays };`,
  );
  const { lastUserSays } = fn(
    (key, def) => (key === 'k-dead' ? dead : def),
    { deadSend: 'k-dead' },
    () => [{ id: lastId, textContent: text }],
    (node) => node.id,
    (value) => String(value || '').replace(/\s+/g, ' ').trim(),
  );
  return lastUserSays;
}

assert.equal(says({ dead: '' })('Задание 2.16'), true, 'обычная доставка видна');
assert.equal(says({ dead: 'chat-message-42' })('Задание 2.16'), false, 'мёртвая копия доставкой не считается');
assert.equal(says({ dead: 'chat-message-41' })('Задание 2.16'), true, 'другая метка доставку не ломает');
assert.equal(says({ dead: 'chat-message-42' })(''), false, 'пустой ключ ничего не подтверждает');

// ── 5. Проводка: ошибка ловится, повтор один, поле ввода чистится ──────────
has('arenaResendMax: 1,', 'повтор ровно один');
has('arenaRetryMs: 180000,', 'есть окно, в котором ошибка считается нашей');
has('if (retryRejectedHandoff(expect, alert, `Arena ответила «${alert.text || "ошибка без текста"}»`)) {', 'в тике ошибка сначала лечится минимальным повтором');
has('if (retryRejectedHandoff(expect, eaten, `Arena ответила «${eaten.text}»`)) {', 'в ожидании ответа — то же лечение');
has('Arena второй раз не приняла задание', 'второй отказ подряд останавливает цикл');
has('Минимальное сообщение тоже отклонено', 'причина паузы названа прямо');
has('const again = await consumePending(true);', 'повтор идёт в этом же шаге, без ручного сброса');
has('Переотправка на этой странице не началась', 'если отправка не пошла, это видно в журнале');
has('deadSend: "cfn-dead-send",', 'ключ хранилища для мёртвого сообщения');
has('GM_setValue(K.deadSend, "");', 'метка снимается после настоящей доставки');
has('if (paused && paused.kind === "arena-error") {', '«Продолжить» после ошибки Arena считается просьбой отправить заново');
has('GM_setValue(K.errSeen, "");', 'старая ошибка перестаёт быть «уже показанной»');
has('retryRejectedHandoff(\n          GM_getValue(K.expect, null),', '«Продолжить» ставит в очередь минимальное сообщение');
has('В поле ввода был текст (Arena возвращает туда отклонённое) — очистил перед вставкой задания.', 'поле ввода чистится перед вставкой');
has('function clearComposer(editor) {', 'очистка поля — отдельная функция');
has('символов` +', 'длина отправленного видна в журнале');
has('сообщение ${delivery.msgId}', 'id сообщения в журнале — «отправлено» можно проверить');
has('const TECH_OPEN = "=== CF_TECH v1 ===";', 'блок помечен обычным текстом, а не HTML-комментарием');
has('const TECH_CLOSE = "=== /CF_TECH ===";', 'закрывающая метка тоже текстовая');

console.log('arena-swallow: ok');
