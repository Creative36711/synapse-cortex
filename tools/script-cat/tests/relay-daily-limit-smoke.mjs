// D-106 (1.14.33): дневной лимит токенов Arena останавливает цикл.
//
// Мастер показал HTML кнопки из поля ввода Arena:
//   <button aria-label="Daily usage limit reached" data-severity="blocked" …>
// Это не отказ доставки и не tool-call limit: суточная квота исчерпана,
// отправка заблокирована целиком. Проба проверяет четыре вещи:
//   1) детектор называет метку UI из этой кнопки и ставит паузу `daily-limit`;
//   2) тик проверяет лимит РАНЬШЕ продолжения хода и общей ошибки на экране —
//      ни продолжение, ни новое задание не уходят в заблокированную отправку;
//   3) вид паузы классифицирован: класс `master`, пункт закрытого списка `money`
//      (квота и деньги аккаунта решает только Мастер);
//   4) цикл действительно стоит: `healHoldsCycle` истинен, адресат — Мастер.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healApi } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const src = (name) => readFileSync(join(srcDir, name), 'utf8');

// ── 1. Детектор: метка UI из кнопки индикатора ─────────────────────────────
const visibleErrors = src('15-visible-errors.js');
assert.match(visibleErrors, /daily usage limit/i,
  'детектор распознаёт метку aria-label кнопки «Daily usage limit reached»');
assert.match(visibleErrors, /function monitorDailyLimit/,
  'monitorDailyLimit вынесен отдельной функцией тика');
assert.match(visibleErrors, /kind:\s*"daily-limit"/,
  'детектор ставит паузу вида daily-limit');
assert.match(visibleErrors, /Дневной лимит токенов Arena исчерпан/,
  'причина паузы называет лимит словами для журнала и панели');
assert.match(visibleErrors, /querySelectorAll\("button\[aria-label\]"\)/,
  'поиск идёт по кнопкам с aria-label, а не по тексту сообщений');

// ── 2. Тик: лимит раньше продолжения хода и общей ошибки ───────────────────
const cycle = src('28-cycle.js');
const atLimit = cycle.indexOf('monitorDailyLimit()');
const atToolLimit = cycle.indexOf('handleToolCallLimit()');
const atVisible = cycle.indexOf('monitorVisibleErrors()');
assert.ok(atLimit > 0, 'тик вызывает monitorDailyLimit');
assert.ok(atLimit < atToolLimit,
  'дневной лимит проверяется раньше продолжения хода: в заблокированную отправку не уходим');
assert.ok(atLimit < atVisible,
  'дневной лимит проверяется раньше общей ошибки на экране');

// ── 3–4. Классификация: решает только Мастер, цикл стоит ───────────────────
const {
  MASTER_ONLY, HEAL_MASTER_ONLY, HEAL_PAUSE_CLASS, HEAL_HOLDING,
  classifyPause, healHoldsCycle,
} = healApi;

assert.equal(HEAL_PAUSE_CLASS['daily-limit'], 'master',
  'вид daily-limit назван в таблице классов: класс master');
assert.equal(HEAL_MASTER_ONLY['daily-limit'], 'money',
  'адресат — пункт закрытого списка money: квота и деньги аккаунта');
assert.ok(MASTER_ONLY.includes('money'), 'пункт money в закрытом списке');
assert.ok(HEAL_HOLDING.includes('daily-limit'),
  'daily-limit входит в HEAL_HOLDING: вид остановки сам говорит, что цикл стоит');

const verdict = classifyPause('daily-limit', 'Дневной лимит токенов Arena исчерпан');
assert.equal(verdict.cls, 'master', 'класс — master, а не транспорт и не сбой сайта');
assert.equal(verdict.with, 'master', 'адресат рассуждения — Мастер');
assert.equal(verdict.unknown, false, 'вид остановки распознан, а не нераспознанный');
assert.equal(healHoldsCycle('daily-limit', 'Дневной лимит токенов Arena исчерпан'), true,
  'цикл останавливается: без сброса лимита продолжать нечего');

// Сопротивление тексту причины: класс не подменяется HEAL_TEXT_RULES
// (капча/вход/5xx) и не уходит Maintainer'у как поломка транспорта.
assert.notEqual(verdict.route, 'maintainer', 'Maintainer не зовётся: чинить нечего');
assert.equal(verdict.route, 'master', 'маршрут — решение, а не повтор или передача');
