// Проба 1.14.19 (D-090): текст «возвращается в поле ввода» — это наш клик, а не сбой Arena.
//
// Журнал 09.11, 21:01: клик по Send прошёл, сообщение появилось в чате
// (6 → 8, своих 4), а поле ввода сохранило черновик. Транспорт считал «поле
// держит текст» отменой доставки, уходил на повтор, повтор вставлял текст заново —
// и Мастер видел одно и то же задание в поле на каждом круге.
//
// Причина не в Arena и не в возврате текста: Arena не всегда очищает редактор
// после успешной отправки, а гейт принимал этот остаток за доказательство «не ушло».
//
// Проверяется:
//   • решает совпадение текста реплики и поля, а не сам факт текста в поле;
//   • расхождение (в чате чужое, в поле наше) по-прежнему отменяет доставку;
//   • капча сильнее любого признака;
//   • черновик после подтверждённой доставки убирается и называется в журнале;
//   • в диагностике отказа видно, был ли клик, активна ли кнопка и отпечаток текста.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${String(from).trim().slice(0, 40)}`);
  return src.slice(a, b);
};

const flat = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const KEY = 'dispatch: 4136f0cf-5705-812b-af99-d4f982083fb9, run: 2f87f8f4';
const TEXT = `Задание · задача 4136f0cf-5705-812b-af99-d4f982083fb9 · ${KEY}`;

// ── 1. sameSubmission: сверка реплики и поля ────────────────────────────────
const sameSrc = cut('  function sameSubmission(', '  /**\n   * Капча после «отправлено».');
const makeSame = (bubbles, field) => new Function(
  'userMessages', 'composerText', 'composer', 'flat',
  `${sameSrc}\nreturn sameSubmission;`,
)(
  () => bubbles.map((text, i) => ({ id: `m-${i}`, textContent: text })),
  () => field,
  () => ({}),
  flat,
);

assert.equal(makeSame([TEXT], TEXT)({ id: 'm-0' }, KEY, TEXT), true,
  'реплика и поле — один и тот же промпт: это доставка');
assert.equal(makeSame(['Задание · другая карточка'], TEXT)({ id: 'm-0' }, KEY, TEXT), false,
  'в чате чужая реплика, в поле наш текст — доставки нет');
assert.equal(makeSame([TEXT], 'что-то другое')({ id: 'm-0' }, KEY, TEXT), false,
  'поле держит другой черновик — наша отправка не доказана');
assert.equal(makeSame([], TEXT)({ id: 'm-9' }, KEY, TEXT), false, 'несуществующая реплика ничего не доказывает');
assert.equal(makeSame([TEXT], TEXT)(null, KEY, TEXT), false, 'без находки сверять нечего');

// ── 2. waitSent: поле больше не одиночный veto ──────────────────────────────
const waitSrc = cut('  async function waitSent(', '  /**\n   * Текст задания всё ещё в поле ввода?');
const waitSent = (bubbles, field, same, { captcha = false } = {}) => new Function(
  'userSaysSince', 'composerHolds', 'sameSubmission', 'captchaDialog', 'sleep', 'Date',
  `${waitSrc}\nreturn waitSent;`,
)(
  () => (bubbles.length ? { id: 'm-0', at: 0 } : null),
  () => Boolean(field),
  () => same,
  () => (captcha ? {} : null),
  async () => {},
  Date,
)(KEY, ['m-old'], 20, TEXT, 0);

const incident = await waitSent([TEXT], TEXT, true);
assert.equal(incident && incident.id, 'm-0', 'инцидент 21:01: доставка признана');
assert.equal(incident && incident.draftLeft, true, 'и черновик отмечен как наш остаток');
assert.equal(await waitSent([TEXT], TEXT, true, { captcha: true }), '', 'капча сильнее всего');
assert.equal(await waitSent([], TEXT, true), '', 'нет новой реплики и поле не пусто — не доставка');
assert.equal(await waitSent([TEXT], '', false) && 'ok', 'ok', 'поле пусто и реплика есть — доставка');

// ── 3. Черновик убирается и называется в журнале ────────────────────────────
const deliverSrc = cut('  async function deliver(editor, text, turnId = "") {', '  /** Короткий хеш текста');
assert.match(deliverSrc, /const cleared = clearComposer\(composer\(\)\);/, 'черновик чистится тем же путём');
assert.match(deliverSrc, /черновик в поле ввода убрал сам/, 'успешная очистка названа в журнале');
assert.match(deliverSrc, /поле можно очистить вручную/, 'если не вышло — сказано честно');
assert.match(deliverSrc, /draftLeft: holds/, 'итог несёт признак оставшегося черновика');

// ── 4. Диагностика отказа: чем именно не сработало ──────────────────────────
assert.match(deliverSrc, /кнопка \$\{button \? \(button\.disabled \? "disabled" : "активна"\) : "нет"\}/,
  'в отказе видно, была ли кнопка активна — 21:01 она была');
assert.match(deliverSrc, /отпечаток \$\{String\(textHash\(text\)\)\}/,
  'в отказе есть отпечаток текста: по нему видно, тот ли это черновик');
assert.match(deliverSrc, /let dispatched = false;/, 'клик засчитывается только если он действительно прошёл');

// ── 5. Версия и решение ─────────────────────────────────────────────────────
assert.match(src, /@version\s+1\.(?:14\.(?:19|2[0-9]|3[0-9])|1[5-9]\.\d+)/, 'сборка 1.14.19');
const decisions = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');
assert.match(decisions, /## D-090/, 'решение D-090 записано');

console.log('ok 1 - tests/relay-draft-return-smoke.mjs');
