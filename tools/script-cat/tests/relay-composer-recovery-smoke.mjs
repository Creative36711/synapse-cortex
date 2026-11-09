// Проба 1.4.63: недорисованная страница адресата — это ожидание, а не пауза.
//
// Вопрос Мастера (102) от 25.10: «что случилось и почему опять всё поломалось».
// Журнал 14:57:36 → 14:57:52:
//   «Выдан ход Turn Runtime: NAR-2.11 …» → переход на страницу агента →
//   «Убрал плашку …» → пауза «Кнопка Send неактивна или не найдена — редактор
//   не принял текст (поле не найдено, в поле — симв., кнопка не найдена,
//   сообщений 0 → 15, своих 7, панелей 1, активной кнопки Send нет
//   (contenteditable 0, textarea 1, textbox 0, панель 1, skip нет…))».
//
// Вставка к этому моменту уже прошла: отказ случился внутри `deliver`. Поле
// ввода исчезло на перерисовке, а ожидание его возврата стояло ВНУТРИ
// `if (panels)`: панель нашлась, кнопки закрытия в ней не было,
// `closeCompletionPanels()` вернул 0 — и grace-пауза не выполнялась вовсе.
// Скрипт сдался через три секунды, вернул карточку в Ready и встал на паузу,
// хотя страница в этот момент дорисовывала транскрипт (0 → 15 сообщений).
//
// Здесь проверяется: ожидание поля не зависит от закрытия панели; клика не
// было — карточка не откатывается, а отправка повторяется следующим тиком;
// ожидание ограничено, дальше Мастер; диагностика объясняет чужое `textarea`.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 60)}`);
  return src.slice(a, b);
};

// ── 1. Ожидание поля ввода не спрятано в `if (panels)` ──────────────────────
const deliver = cut('  async function deliver(editor, text, turnId = "") {', '  /** Короткий хеш текста');
assert.ok(
  /if \(panels\) \{\n(?:[^\n]*\n)*?\s*\}\n\s*live = await waitFor\(composer, C\.composerGraceMs, 300\);/.test(deliver),
  'ожидание поля стоит ПОСЛЕ закрытия панелей, а не внутри if (panels)',
);
assert.ok(
  !deliver.includes('waitFor(composer, 4000, 300)'),
  'прежнее короткое ожидание только при закрытой панели убрано',
);
assert.ok(deliver.includes('writePrompt(live, text);'), 'после возврата поля текст вставляется заново');

// ── 2. Отказ без единого клика помечен как «повторить», а не как провал ─────
assert.ok(
  deliver.includes('retry: clicked === 0,'),
  'без единого клика — это retry, а не отказ доставки (1.4.63)',
);
assert.ok(/clicked \+= 1;/.test(deliver), 'счётчик кликов на месте: retry только при нуле');

// ── 3. Повтор отправки ограничен, карточка при нём не трогается ─────────────
assert.ok(/\n    sendRetries: \d+,/.test(src), 'предел повторов задан в C');
assert.ok(/\n    composerGraceMs: \d+,/.test(src), 'grace-пауза задана в C');

const retryBlock = cut('    if (delivery.retry) {', '    if (!delivery.ok) {');
const run = (pending, limit = 3) => {
  const out = { stored: null, logged: [], timers: [], ticked: false };
  const fn = new Function(
    'GM_setValue',
    'K',
    'C',
    'log',
    'setTimeout',
    'tick',
    'pending',
    'delivery',
    `return (function () {\n${retryBlock}\nreturn false; })();`,
  );
  const value = fn(
    (key, v) => {
      out.stored = { key, v };
    },
    { pending: 'cfn-pending' },
    { sendRetries: limit, tickMs: 15000 },
    (text, error, options) => out.logged.push({ text, error, options }),
    (fn2, ms) => out.timers.push(ms),
    () => {
      out.ticked = true;
    },
    pending,
    { retry: true },
  );
  return { value, ...out };
};

const first = run({ roleId: 'r', text: 'задание', at: 1000 });
assert.equal(first.value, true, 'первый повтор берёт ход, а не снимает его');
assert.equal(first.stored.key, 'cfn-pending', 'очередь сохранена в том же ключе');
assert.equal(first.stored.v.sendTries, 1, 'счётчик попыток вырос');
assert.equal(first.stored.v.undelivered, undefined, 'карточка НЕ помечена недошедшей');
assert.equal(first.stored.v.text, 'задание', 'текст задания остался в очереди');
assert.ok(first.stored.v.at > 1000, 'отметка времени обновлена — TTL не истечёт');
assert.deepEqual(first.timers, [15000], 'повтор назначен на следующий тик');
assert.equal(first.logged[0].options?.ntfy, false, 'ожидание не будит телефон');
assert.match(first.logged[0].text, /дорисовывается/);

const last = run({ roleId: 'r', text: 'задание', at: 1000, sendTries: 3 }, 3);
assert.equal(last.value, false, 'после предела повторов — обычный путь отказа (пауза)');
assert.equal(last.stored, null, 'очередь на последней попытке не переписывается');
assert.match(last.logged.at(-1).text, /не вернулось за 3 попыток/);
assert.equal(last.logged.at(-1).error, true, 'исчерпанное ожидание — ошибка, а не рутина');

const second = run({ text: 'задание', at: 1000, sendTries: 1 }, 3);
assert.equal(second.value, true, 'второй повтор тоже продолжает цикл');
assert.equal(second.stored.v.sendTries, 2);

// ── 4. Диагностика объясняет `textarea`, а не только считает ────────────────
const diag = cut('  function composerDiagnostics() {', '  /** Ждём активную кнопку Send (ниже');
const area = { tagName: 'TEXTAREA' };
const doc = {
  querySelectorAll: (sel) => {
    if (sel === 'textarea') return [area];
    if (sel.includes('textarea:not([readonly])')) return [area];
    return [];
  },
};
const diagFn = new Function(
  'document',
  'location',
  'inSidebar',
  'inOwnPanel',
  'isServiceField',
  'visible',
  'completionPanels',
  'skipCardButton',
  `${diag}\nreturn composerDiagnostics;`,
)(doc, { pathname: '/agent/01a16f4e' }, () => false, (el) => el === area, () => false, () => true, () => [], () => null);
const text = diagFn();
assert.match(text, /textarea 1/, 'чужое поле посчитано');
assert.match(text, /в своей панели 1/, 'и объяснено: это поле нашей панели');
assert.match(text, /путь \/agent\/01a16f4e/, 'путь в диагностике остался');

const sideFn = new Function(
  'document',
  'location',
  'inSidebar',
  'inOwnPanel',
  'isServiceField',
  'visible',
  'completionPanels',
  'skipCardButton',
  `${diag}\nreturn composerDiagnostics;`,
)(doc, { pathname: '/agent/x' }, (el) => el === area, () => false, () => false, () => true, () => [], () => null);
assert.match(sideFn(), /в сайдбаре 1/, 'поле сайдбара отличается от поля нашей панели');

console.log('relay-composer-recovery-smoke: ok');
