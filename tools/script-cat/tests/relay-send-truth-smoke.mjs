// Проба 1.4.84: «Задание отправлено» пишется только тогда, когда сообщение
// действительно в чате.
//
// Случай Мастера (28.10, 19:08). Журнал:
//
//   Ход Pack Author: задание передано…
//   Задание отправлено (7829 символов).
//
// а текст остался в поле ввода и никуда не ушёл. Подтверждением доставки
// служили три признака, из которых два не доказывают ничего:
//   • вырос счётчик сообщений — страница в этот момент догружала транскрипт
//     (0 → 15 сообщений), и «новые» были чужими, старыми;
//   • поле опустело при работающей кнопке Stop — Stop висел от прошлой
//     генерации, а поле могло быть просто перерисовано;
//   • своё сообщение в чате — единственный настоящий признак, и он не сработал.
//
// Здесь проверяется: счётчик и Stop доставку не подтверждают, текст в поле
// ввода отменяет успех, а журнал о доставке стоит после проверки, а не вместо
// неё.

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

const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// ── 1. Текст в поле ввода — это отсутствие отправки ───────────────────────
const verifySrc = cut('  /**\n   * Ждём подтверждение доставки', '  /** Enter в поле ввода');
const makeHolds = new Function(
  'composer',
  'composerText',
  'flat',
  `${verifySrc}\nreturn composerHolds;`,
);

const holds = (text, key = 'Задание 5.4 · NAR-5.4 (dispatch 1fc527ed)') =>
  makeHolds(() => ({}), () => text, flat)(key);

assert.equal(holds('Задание 5.4 · NAR-5.4 (dispatch 1fc527ed)'), true, 'текст в поле — отправки не было');
assert.equal(holds(''), false, 'пустое поле — не признак отправки, но и не запрет');
assert.equal(
  makeHolds(() => null, () => 'что-то', flat)('ключ'),
  false,
  'без живого поля проверка не выдумывает текст',
);
assert.equal(
  makeHolds(() => ({}), () => 'полное задание без отличительной строки', flat)(
    '',
    'полное задание без отличительной строки',
  ),
  true,
  'без ключа проверка идёт по началу текста',
);

// ── 2. Ожидание доставки: только НОВОЕ своё сообщение ─────────────────────
// Только сама `waitSent`: `composerHolds` объявлена ниже в том же файле и
// перекрыла бы подставную функцию, если резать блок вместе с ней.
const waitOnly = cut('  async function waitSent(', '  /**\n   * Текст задания всё ещё в поле ввода?');
function waitSentWith({ fresh = false, holdsText = '', captcha = false } = {}) {
  const fn = new Function(
    'userSaysSince',
    'composerHolds',
    'captchaDialog',
    'sleep',
    'Date',
    `${waitOnly}\nreturn waitSent;`,
  );
  const run = fn(
    () => (fresh ? { id: 'm-new', at: 0 } : null),
    () => Boolean(holdsText),
    () => (captcha ? {} : null),
    async () => {},
    Date,
  );
  return run('dispatch 1fc527ed, run 8abe7712', ['m-old'], 10, 'Задание 5.4 …', 0);
}

const sent = await waitSentWith({ fresh: true });
assert.equal(sent && sent.id, 'm-new', 'новое сообщение — доставка, и видно, какое именно');
assert.equal(await waitSentWith({}), '', 'ничего нового в чате — доставки нет');
assert.equal(
  await waitSentWith({ fresh: true, holdsText: 'Задание 5.4 …' }),
  '',
  'текст остался в поле — не доставка',
);
assert.equal(await waitSentWith({ fresh: true, captcha: true }), '', 'капча отменяет и настоящий признак');

// Ни одного «слабого» признака в ожидании не осталось.
assert.ok(!/"count"\.test|return "count"/.test(verifySrc), 'ветки «счётчик» больше нет');
assert.ok(!/"generating"/.test(verifySrc), 'ветки «поле опустело + Stop» больше нет');

// ── 3. Проверка стоит после клика, до рапорта ─────────────────────────────
const deliverSrc = cut('  async function deliver(editor, text) {', '  /** Короткий хеш текста');
const clickAt = deliverSrc.indexOf('btn.click();');
const holdAt = deliverSrc.indexOf('if (composerHolds(key, text)) {');
const okAt = deliverSrc.indexOf('return { ok: true, via: "message", msgId: via.id || "" };');
assert.ok(clickAt > 0, 'клик по Send на месте');
assert.ok(holdAt > clickAt, 'после клика проверяется поле ввода');
assert.ok(okAt > holdAt, 'успех объявляется только после проверки');
assert.match(deliverSrc, /текст остался в поле ввода/, 'причина названа словами, а не кодом');
assert.match(deliverSrc, /const key = sendKey\(text\) \|\| flat\(text\)\.slice\(0, 60\);/, 'без отличительной строки ключ берётся из начала текста');

// Главный случай 1.4.84 (28.10, 19:38): в чате уже лежит СТАРОЕ сообщение с
// тем же ключом, а новое не ушло. Скрипт верил старому и через секунду писал
// «Задание отправлено». Теперь доставка — только сообщение, которого не было
// в снимке перед кликом.
assert.match(deliverSrc, /const known = userNodeIds\(\);/, 'снимок своих реплик до клика');
assert.match(deliverSrc, /const already = userSaysSince\(key, known, since\);/, 'до клика проверяется только новое сообщение');
assert.match(deliverSrc, /const meanwhile = userSaysSince\(key, known, since\);/, 'и после человеческой паузы — тоже');
assert.ok(
  !/if \(lastUserSays\(key\)\) return \{ ok: true/.test(deliverSrc),
  'старое сообщение больше не подтверждает отправку',
);

// ── 4. Журнал о доставке — в ветке успеха ────────────────────────────────
const pendingSrc = cut('  async function consumePending(manual = false) {', '  // ───────────────────── следы прошлых попыток (очистка)');
const okBranch = pendingSrc.indexOf('if (!delivery.ok) {');
const reportAt = pendingSrc.indexOf('`Задание отправлено (');
assert.ok(okBranch > 0 && reportAt > okBranch, 'рапорт стоит после ветки отказа');
assert.match(pendingSrc, /if \(delivery\.retry\) \{/, 'недорисованная страница не считается отказом доставки');
assert.match(pendingSrc, /«Продолжить» — оно уйдёт этой же карточке/, 'Мастеру сказано, что делать с неотправленным');

console.log('send-truth: 21 проверка — ok');
