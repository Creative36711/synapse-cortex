// Проба 1.4.20: подтверждение отправки по сообщению и защита от повторной выдачи.
//
// Два случая Мастера (52) от 23.10:
//   21:06:08 «ПАУЗА: Send нажат, но сообщение не появилось — текст остался в
//   поле» — скрипт трижды кликнул Send и не смог сказать, что именно не
//   сработало;
//   NAR-1.7 выдана дважды (run 8abe7712 и run 9f22e42b) — вторая выдача по
//   уже отвеченной карточке, агент повторил ту же работу.
//
// Здесь проверяется, что доставка подтверждается появлением своего сообщения,
// что повторная выдача отсекается, а ответ без литерала маркера разбирается по
// тексту только после исчерпанных напоминаний.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim()}`);
  return src.slice(a, b);
};

// ── 1. Ключ сообщения ───────────────────────────────────────────────────────
const flatSrc = 'const flat = (x) => String(x || "").replace(/[\\s\\u00a0]+/g, " ").trim().toLowerCase();';
assert.ok(src.includes(flatSrc), 'flat() на месте');

const sendKeySrc = cut('  function sendKey(text) {', '  /** Своё сообщение в транскрипте');
const { sendKey } = new Function(`${flatSrc}\n${sendKeySrc}\nreturn { sendKey };`)();

const task = [
  'Технический блок: ветка-снимок …',
  'Задача NAR-1.8 · Крафт, торговля, встречи, мета (dispatch 4016f0cf-5705-81f4-8e07-d987ab5f34db, run 1fc527ed-3af9-4e09-9288-523ed62c5d24).',
  'ЦЕЛЬ И ГРАНИЦЫ',
].join('\n');
const key = sendKey(task);
assert.match(key, /dispatch 4016f0cf/, 'ключ задания — строка с dispatch id');
assert.match(key, /run 1fc527ed/, 'и с номером выдачи');
assert.ok(!key.includes('ветка-снимок'), 'общий технический блок в ключ не попадает');

// Главный случай 28.10, 19:38: ту же карточку выдали второй раз. Заголовок и
// номер карточки совпадают, отличается только выдача — ключ обязан отличаться,
// иначе прошлое сообщение сойдёт за новую отправку.
const sameCard = task.replace('1fc527ed-3af9-4e09-9288-523ed62c5d24', '9f22e42b-1b7e-4a37-9a1e-33bd6a0a5d11');
assert.notEqual(sendKey(sameCard), key, 'повторная выдача той же карточки — другой ключ');
assert.equal(
  sendKey(task.replace('1fc527ed-3af9-4e09-9288-523ed62c5d24', '')),
  'dispatch 4016f0cf-5705-81f4-8e07-d987ab5f34db',
  'без номера выдачи ключ держится на карточке',
);

const plan = 'Ход Координатора\nCF_COORDINATOR_RESULT {"mission_id":"m1","turn_id":"turn-777","status":"completed","next":"Kernel"}';
assert.equal(sendKey(plan), 'turn-777', 'ход Координатора опознаётся по номеру хода');
assert.notEqual(sendKey(plan), sendKey(plan.replace('turn-777', 'turn-888')), 'у разных ходов разные ключи');

const reminder = 'ТЕХНИЧЕСКОЕ НАПОМИНАНИЕ (2 из 2; это не задание и не новый ход).\nТвой предыдущий ответ …';
assert.equal(sendKey(reminder), 'техническое напоминание (2 из 2; это не задание и не новый ход).');
assert.equal(
  sendKey('короткая реплика'),
  'короткая реплика',
  'короткое сообщение опознаётся целиком',
);
assert.equal(
  sendKey(`${'длинный технический блок без опознавательных строк. '.repeat(6)}`),
  '',
  'длинный промпт без опознавательных строк ключа не даёт',
);

// ── 2. Своё сообщение в транскрипте ───────────────────────────────────────
const userSrc = cut('  /** Своё сообщение в транскрипте', '  /**\n   * Ждём подтверждение доставки');
const makeDoc = (nodes) => ({
  querySelectorAll: () => nodes,
});
const node = (text, { user = true, wrapper = null } = {}) => ({
  textContent: text,
  closest: (sel) => (sel.includes('data-agent-transcript-message') ? (user ? wrapper : null) : user ? null : null),
});
const wrapperNode = (text) => ({ textContent: text, closest: () => null });

const lastUserSays = (nodes, dead = '') => {
  const { lastUserSays: fn } = new Function(
    'document',
    'flat',
    'GM_getValue',
    'K',
    `${userSrc}\nreturn { lastUserSays };`,
  )(
    makeDoc(nodes),
    (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    (key) => (key === 'cfn-dead-send' ? dead : ''),
    { deadSend: 'cfn-dead-send' },
  );
  return fn;
};

const shown = lastUserSays([wrapperNode('прошлое сообщение'), wrapperNode(task)]);
assert.equal(shown(key), true, 'своё сообщение найдено по ключу');

const stale = lastUserSays([wrapperNode(task.replace('NAR-1.8', 'NAR-1.7').replace('1fc527ed', '8abe7712'))]);
assert.equal(stale(key), false, 'чужое (прошлое) сообщение за подтверждение не сходит');

const empty = lastUserSays([]);
assert.equal(empty(key), false, 'пустой транскрипт — не подтверждение');

// ── 3. deliver: подтверждение по сообщению, а не по счётчику ──────────────
const deliverSrc = cut('  async function deliver(editor, text) {', '  /** Короткий хеш текста');
assert.match(
  deliverSrc,
  /waitSent\(key, known, C\.sendVerifyMs, text, since\)/,
  'ждём новое сообщение, а не спи 1200 мс',
);
assert.match(deliverSrc, /const known = userNodeIds\(\)/, 'снимок своих реплик снят до клика');
assert.match(deliverSrc, /userSaysSince\(key, known, since\)/, 'доставка — только новое сообщение');
assert.match(deliverSrc, /pressEnter\(live\)/, 'второй канал отправки — Enter');
assert.match(deliverSrc, /composerAlive\(live\)/, 'редактор перечитывается из живого DOM');
assert.match(deliverSrc, /const latest = sendButton\(live\)/, 'кнопка пересчитывается перед самим кликом');
assert.match(deliverSrc, /текст в поле пропал/, 'пропавший текст вставляется заново, а не отправляется пустота');
assert.match(deliverSrc, /if \(composerHolds\(key, text\)\)/, 'после клика проверяется, что текст ушёл из поля');
assert.match(deliverSrc, /текст остался в поле ввода/, 'оставшийся текст называется причиной, а не успехом');
assert.ok(!/composerLeft/.test(deliverSrc), 'старый признак «поле опустело» больше не решает');
assert.ok(!/if \(after > before \|\|/.test(deliverSrc), 'старый счётчик сообщений больше не решает');

const verifySrc = cut('  async function waitSent(', '  /** Enter в поле ввода');
assert.match(verifySrc, /if \(!composerHolds\(key, text\)\)/, 'текст в поле отменяет доставку');
assert.match(
  verifySrc,
  /const sent = userSaysSince\(key, known, since\);\s*if \(sent\) return sent;/,
  'доставка — новое своё сообщение в чате',
);
assert.ok(!/"count"/.test(verifySrc), 'счётчик сообщений больше не подтверждает доставку');
assert.ok(!/"generating"/.test(verifySrc), 'пустое поле с кнопкой Stop больше не подтверждает доставку');
assert.match(verifySrc, /function composerHolds\(key, text\)/, 'проверка «текст остался в поле» на месте');

const consumeSrc = cut('  async function consumePending(', '  // ───────────────────── следы прошлых попыток');
assert.match(consumeSrc, /delivery\.detail/, 'пауза отправки объясняет, что видно на странице');

// ── 4. Один waitForSendReady ───────────────────────────────────────────────
const readyCount = (src.match(/async function waitForSendReady\(/g) || []).length;
assert.equal(readyCount, 1, 'определение waitForSendReady одно: мёртвый дубль убран');

// ── 5. Повторная выдача ───────────────────────────────────────────────────
const dispatchSrc = cut('  async function dispatchTask(card, roleName, mission = null) {', '  // ───────────────────────────── цикл');
assert.match(dispatchSrc, /notion\("GET", `pages\/\$\{card\.id\}`\)/, 'карточка перечитывается перед выдачей');
assert.match(dispatchSrc, /state !== "Ready" \|\| submittedAt \|\| prLink/, 'карточка не выдаётся, если она не в Ready');
assert.match(dispatchSrc, /redispatchClearProps\(fresh\)/, 'следы прошлого ответа снимаются перед выдачей');
assert.match(dispatchSrc, /noteRedispatch\(fresh\.id\)/, 'повторные выдачи одной карточки считаются');
assert.ok(!/ready\[0\]/.test(src), 'чужую карточку из Ready больше не подставляем');
const pickSrc = cut('  function pickReadyForRole(', '  /**\n   * Счётчик повторных выдач');
assert.match(pickSrc, /norm\(taskRole\(t\)\) === norm\(roleName\)/, 'карточка выбирается строго по роли');
assert.match(pickSrc, /find\(\(t\) => !answeredCard\(t\)\)/, 'свежая карточка идёт впереди отвеченной');
assert.match(src, /const card = pickReadyForRole\(ready, route\.roleName\)/, 'выдача берёт карточку через выбор по роли');

// ── 6. Ответ без литерала маркера ─────────────────────────────────────────
const looseSrc = cut('  function looseResult(raw, role, expect) {', '  /**\n   * Ждём ответ без маркера');
const { looseResult } = new Function(
  'norm',
  `${looseSrc}\nreturn { looseResult };`,
)((x) => String(x || '').replace(/-/g, '').toLowerCase());

const executor = { fn: 'Executor' };
const expect = { ref: '4016f0cf-5705-8106-ad46-c4b4cca19b90', runId: '8abe7712-9f32-42f0-babe-3c031fc335d2' };
const kernelText =
  'NAR-1.7 RESULT — dispatch `4016f0cf-5705-8106-ad46-c4b4cca19b90`; run `8abe7712-9f32-42f0-babe-3c031fc335d2`; PR #31 MERGED.';
const loose = looseResult(kernelText, executor, expect);
assert.ok(loose, 'ответ Kernel разобран по тексту');
assert.equal(loose.pr, 31, 'номер PR извлечён');
assert.equal(loose.merged, true, 'мерж извлечён');
assert.equal(loose.dispatch_id, expect.ref, 'выдача та же');
assert.equal(loose.run_id, expect.runId, 'run тот же');

assert.equal(looseResult('просто болтовня без номера PR', executor, expect), null, 'без PR — не результат');
assert.equal(
  looseResult('dispatch 4016f0cf-5705-8106-ad46-c4b4cca19b90; PR #31 MERGED', executor, { ref: 'другая-выдача', runId: 'r' }),
  null,
  'чужая выдача не принимается',
);
assert.equal(looseResult(kernelText, { fn: 'Auditor' }, expect), null, 'аудитору мягкий разбор не нужен');
const foreign = '11111111-1111-4111-8111-111111111111';
assert.equal(looseResult(`dispatch ${foreign}; run ${expect.runId}; PR #31; в цитате ${expect.ref}`, executor, expect), null,
  'упоминание ожидаемой карточки в цитате не подменяет чужой dispatch');
assert.equal(looseResult(`Карточка ${expect.ref}; run ${expect.runId}; PR #31`, executor, expect), null,
  'неподписанный UUID не является dispatch_id');
assert.equal(looseResult(`${kernelText} dispatch ${foreign}`, executor, expect), null,
  'противоречащий второй dispatch не игнорируется');
assert.equal(looseResult(`${kernelText} run ${foreign}`, executor, expect), null,
  'противоречащий второй run не игнорируется');
assert.equal(looseResult(`dispatch ${expect.ref}; PR #31`, executor, expect), null, 'отсутствующий run не восстанавливается');
assert.ok(looseResult(`dispatch_id: ${expect.ref}; run_id: ${expect.runId}; PR #31`, executor, expect),
  'подписанные канонические имена с точными ID принимаются');

const submitSrc = cut('  async function submitExecutor(', '  // ───────────────────────────── ход Координатора');
assert.match(
  submitSrc,
  /role\.fn !== "Reviewer" && last && Number\(expect\.tries\) >= C\.markerReminders\s*\? looseResult/,
  'мягкий разбор включается только после исчерпанных напоминаний и не подменяет вердикт Reviewer',
);

// ── 7. Координатору сказано, какие поля его, а какие движка ───────────────
// 1.4.40: прежняя строка «Ready ставит движок» читалась как запрет выдавать
// собственные черновики — Координатор архивировал Draft и создавал такой же
// новый. Теперь граница названа точно: движок — Running и Submitted.
assert.match(
  src,
  /Движок ставит Running и Submitted; Accepted, Rework и Ready ставишь ты/,
  'Координатор знает границу: Ready и приёмка — его, Running и Submitted — движка',
);
assert.doesNotMatch(
  src,
  /Dispatch State меняешь только на Accepted или Rework/,
  'запрета на собственные Ready больше нет',
);

console.log('send-confirm: 27 проверок — ok');
