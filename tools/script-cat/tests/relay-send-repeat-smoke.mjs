// Проба 1.4.84: повторная выдача той же карточки не выдаёт себя за отправку.
//
// Случай Мастера (28.10, 19:38). Журнал:
//
//   19:38:48 Убрал плашку «задача выполнена» — она закрывала поле ввода.
//   19:38:49 Задание отправлено (8043 символов).
//
// Между этими строками не было ни клика, ни ожидания: `deliver` увидел в чате
// своё сообщение с тем же ключом и вернул «отправлено» через секунду. Ключом
// была строка задания, обрезанная на 90 знаках, — у первой и второй выдачи
// одной карточки она одинаковая, а прошлая реплика из транскрипта не исчезает.
// Текст остался в поле ввода, агент задания не получал.
//
// Здесь проверяется:
//   1) ключ различает выдачи одной карточки (в нём есть номер run);
//   2) доставка — только сообщение, которого не было в снимке перед кликом;
//   3) мёртвая копия (Arena съела) и поздно доехавший старый транскрипт не в счёт;
//   4) в `deliver` старое сообщение больше не подтверждает отправку, а текст в
//      поле не приводит ко второму клику;
//   5) журнал называет id сообщения, которым подтверждена доставка.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${String(from).trim()}`);
  return src.slice(a, b);
};

const flatSrc = 'const flat = (x) => String(x || "").replace(/[\\s\\u00a0]+/g, " ").trim().toLowerCase();';
assert.ok(src.includes(flatSrc), 'flat() на месте');

// ── 1. Ключ: та же карточка, другая выдача ────────────────────────────────
const sendKeySrc = cut('  function sendKey(text, turnId = "") {', '  /** Своё сообщение в транскрипте');
const { sendKey } = new Function(`${flatSrc}\n${sendKeySrc}\nreturn { sendKey };`)();

const card = '4016f0cf-5705-81f4-8e07-d987ab5f34db';
const task = (run) =>
  [
    'Технический блок: ветка-снимок …',
    `Задача NAR-5.3 · Пак state-ui, часть 1: автомат состояний (dispatch ${card}, run ${run}).`,
    'ЦЕЛЬ И ГРАНИЦЫ',
  ].join('\n');

const first = sendKey(task('1fc527ed-3af9-4e09-9288-523ed62c5d24'));
const second = sendKey(task('9f22e42b-1b7e-4a37-9a1e-33bd6a0a5d11'));
assert.equal(first, `dispatch ${card}, run 1fc527ed-3af9-4e09-9288-523ed62c5d24`, 'ключ первой выдачи');
assert.notEqual(second, first, 'вторая выдача той же карточки — другой ключ');
assert.ok(second.includes('9f22e42b'), 'в ключе номер выдачи, а не только карточка');
assert.ok(!first.includes('narrative'), 'общий технический блок в ключ не попадает');

// ── 2. Доставка — только новое сообщение ─────────────────────────────────
const saysSrc = cut('  /** id «своих» реплик в транскрипте', '  /**\n   * Ждём подтверждение доставки');
const NODE_OLD = '0199a1c0-0000-7000-8000-00000000a001';
const NODE_NEW = '0199a1c0-0000-7000-8000-00000000a002';

function saysWith({ nodes, known = [], dead = '', times = {} } = {}) {
  const fn = new Function(
    'userMessages',
    'GM_getValue',
    'K',
    'idTime',
    `${flatSrc}\n${saysSrc}\nreturn { userNodeIds, userSaysSince };`,
  );
  return fn(
    () => nodes,
    (key) => (key === 'cfn-dead-send' ? dead : ''),
    { deadSend: 'cfn-dead-send' },
    (id) => times[id] || 0,
  );
}

const node = (id, text) => ({ id: `chat-message-${id}`, textContent: text });
const oldReply = node(NODE_OLD, `Задача NAR-5.3 … (${first}).`);
const newReply = node(NODE_NEW, `Задача NAR-5.3 … (${second}).`);

// Случай 19:38: в чате только прошлая выдача, новой нет.
const onlyOld = saysWith({ nodes: [oldReply], known: [NODE_OLD] });
assert.deepEqual(onlyOld.userNodeIds(), [NODE_OLD], 'снимок своих реплик — id без префикса');
assert.equal(
  onlyOld.userSaysSince(second, [NODE_OLD]),
  null,
  'новая выдача не подтверждается старым сообщением',
);

// Сообщение появилось после клика.
const fresh = saysWith({ nodes: [oldReply, newReply], known: [NODE_OLD] });
const found = fresh.userSaysSince(second, [NODE_OLD]);
assert.equal(found && found.id, NODE_NEW, 'доставка — новое сообщение');
assert.equal(
  fresh.userSaysSince(second, [NODE_OLD, NODE_NEW]),
  null,
  'то же сообщение второй раз доставкой не считается',
);

// Мёртвая копия: Arena съела сообщение ошибкой — агенту оно не ушло.
assert.equal(
  saysWith({ nodes: [newReply], known: [], dead: NODE_NEW }).userSaysSince(second, []),
  null,
  'мёртвая копия доставкой не считается',
);

// Старый транскрипт доехал после снимка: id-время выдаёт возраст реплики.
const since = 1_800_000_000_000;
assert.equal(
  saysWith({ nodes: [newReply], times: { [NODE_NEW]: since - 600_000 } }).userSaysSince(second, [], since),
  null,
  'поздно доехавшее старое сообщение доставкой не считается',
);
assert.equal(
  saysWith({ nodes: [newReply], times: { [NODE_NEW]: since - 1_000 } }).userSaysSince(second, [], since)?.id,
  NODE_NEW,
  'свежее сообщение принимается',
);
assert.equal(
  saysWith({ nodes: [newReply] }).userSaysSince(second, [], since)?.id,
  NODE_NEW,
  'если id не UUIDv7, проверка по времени просто не срабатывает',
);

// Узел без id (реплика потеряла обёртку) не роняет проверку.
assert.equal(
  saysWith({ nodes: [{ textContent: second }], known: [] }).userSaysSince(second, []),
  null,
  'узел без id не считается сообщением',
);
assert.equal(saysWith({ nodes: [newReply], known: [] }).userSaysSince('', []), null, 'пустой ключ ничего не даёт');

// ── 3. deliver: снимок до клика, старое сообщение не в счёт ───────────────
const deliverSrc = cut('  async function deliver(editor, text, turnId = "") {', '  /** Короткий хеш текста');
const snapshotAt = deliverSrc.indexOf('const known = userNodeIds();');
const loopAt = deliverSrc.indexOf('for (let attempt = 1; attempt <= 3; attempt += 1)');
const clickAt = deliverSrc.indexOf('btn.click();');
assert.ok(snapshotAt > 0 && snapshotAt < loopAt, 'снимок своих реплик снят до первой попытки');
assert.ok(clickAt > loopAt, 'клик — внутри попытки');
assert.match(deliverSrc, /const since = Date\.now\(\);/, 'время начала попытки записано');
assert.match(deliverSrc, /const already = userSaysSince\(key, known, since\);/, 'до клика — только новое сообщение');
assert.ok(
  !/if \(lastUserSays\(key\)\)/.test(deliverSrc),
  'старое сообщение в чате больше не подтверждает отправку',
);
assert.match(deliverSrc, /const accepted = \(found\) => \{/, 'успех оформлен одной функцией');
assert.match(deliverSrc, /повторно не отправляю/, 'если поле не очистилось, второго клика нет');
assert.match(deliverSrc, /draftLeft: holds/, 'оставленный черновик виден вызывающему коду');
assert.match(deliverSrc, /msgId: via\.id \|\| ""/, 'id подтвердившего сообщения уходит наверх');

// ── 4. Журнал: «отправлено» проверяемо ───────────────────────────────────
const pendingSrc = cut('  async function consumePending(manual = false) {', '  // ───────────────────── следы прошлых попыток (очистка)');
assert.match(pendingSrc, /сообщение \$\{delivery\.msgId\}/, 'в журнале есть id сообщения');
assert.match(
  pendingSrc,
  /const mark = delivery\.msgId \|\| watermark;/,
  'граница «после отправки» — id подтвердившего сообщения',
);
assert.match(
  pendingSrc,
  /const captchaSent =\s*captchaKnown && !composerHolds\(captchaKey, pending\.text\)\s*\? userSaysSince\(captchaKey, captchaKnown\)/,
  'после капчи доставка проверяется по новому сообщению, а не по последнему',
);
assert.match(pendingSrc, /if \(pending\.captcha && !captchaDialog\(\) && captchaSent\)/, 'ветка капчи использует эту проверку');

// ── 5. Пульт: снимок отправки для Мастера ────────────────────────────────
assert.match(src, /send: \(\) => \{/, 'в пульте есть снимок отправки');
assert.match(src, /__relay\.send\(\)/, 'Мастеру сказано, как его снять');

console.log('send-repeat: 26 проверок — ok');
