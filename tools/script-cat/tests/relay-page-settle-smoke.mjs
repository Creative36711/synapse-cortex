// Проба 1.4.63: на недогруженной странице скрипт не делает ничего.
//
// Журнал Мастера 25.10:
//   17:30:24 «Перехожу к Turn Runtime, чтобы отправить задание»;
//   17:30:44 «ПАУЗА: Кнопка Send неактивна или не найдена — редактор не принял
//            текст (поле в документе, в поле 9186 симв., кнопка «send message»,
//            сообщений 0 → 18, своих 8, панелей 0, активной кнопки Send нет…)»;
//   карточка NAR-2.12 возвращена в Ready.
//
// Поле и текст были на месте, а кнопка `Send` — ещё `disabled`: транскрипт в
// этот момент монтировался (сообщений 0 → 18). Скрипт ждал кнопку 1,5 с, потом
// ещё 3 с и сдался, хотя страница рисовалась.
//
// Здесь проверяется: готовность приложения проверяется до любых действий;
// `sendReady()` отличает «кнопка ещё неактивна» от «кнопка есть»; ожидание
// кнопки длится `sendReadyMs` и возвращает текст в поле; без единого клика
// карточка не откатывается; PR-кнопки не нажимаются заблокированными.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 60)}`);
  return src.slice(a, b);
};

// ── 1. Пороги в конфиге ─────────────────────────────────────────────────────
assert.match(src, /\n    sendReadyMs: 20000,/, 'ожидание активной кнопки Send — 20 с');
assert.match(src, /\n    clickReadyMs: 8000,/, 'ожидание доступной кнопки — 8 с');

// ── 2. `appReady()`: пока приложение не отрисовано, действий нет ────────────
const appReadySrc = cut(
  '  function appReady() {',
  '  /** Кнопка действительно готова: в документе, видима и не заблокирована. */',
);
const makeApp = (state, shell) =>
  new Function('document', `${appReadySrc}\nreturn appReady;`)({
    readyState: state,
    querySelector: () => shell,
  });

assert.equal(makeApp('loading', {})().ok, false, 'документ грузится — страница не готова');
assert.match(makeApp('loading', {})().why, /грузится/);
assert.equal(makeApp('complete', null)().ok, false, 'оболочки приложения нет — не готова');
assert.match(makeApp('complete', null)().why, /оболочка/);
assert.equal(makeApp('complete', {})().ok, true, 'оболочка на месте — работаем');

// ── 3. `sendReady()`: заблокированная кнопка — это «ещё не готово» ──────────
const sendReadySrc = cut(
  '  function sendReady(editor) {',
  '  /**\n   * Ждём активную кнопку Send, не снимая задание.',
);
const makeSendReady = ({ editor = {}, btn = {}, state = 'complete' } = {}) =>
  new Function(
    'document',
    'composer',
    'composerAlive',
    'sendButton',
    `${sendReadySrc}\nreturn sendReady;`,
  )({ readyState: state }, () => editor, () => true, () => btn);

assert.equal(makeSendReady({ editor: null })().ok, false, 'поля нет — не готово');
assert.match(makeSendReady({ editor: null })().why, /поле ввода не найдено/);
assert.equal(makeSendReady({ state: 'loading' })().ok, false, 'страница грузится — не готово');
assert.equal(makeSendReady({ btn: null })().ok, false, 'кнопка Send неактивна — не готово');
assert.match(makeSendReady({ btn: null })().why, /ещё неактивна/);
assert.equal(makeSendReady({ btn: 'SEND' })().ok, true, 'кнопка активна — можно отправлять');
assert.equal(makeSendReady({ btn: 'SEND' })().btn, 'SEND');

// ── 4. `waitSendReady()` ждёт столько, сколько рисуется страница ───────────
const waitSrc = cut(
  '  async function waitSendReady(editor, text, timeoutMs = C.sendReadyMs) {',
  '  /**\n   * Отличительная строка задания',
);
const runWait = async ({ readyAfter, budget = 900 }) => {
  const out = { prompts: [], logs: [], now: 0, calls: 0 };
  const wait = new Function(
    'sendReady',
    'writePrompt',
    'log',
    'sleep',
    'C',
    'Date',
    `${waitSrc}\nreturn waitSendReady;`,
  )(
    () => {
      out.calls += 1;
      return out.calls >= readyAfter
        ? { ok: true, btn: 'SEND' }
        : { ok: false, why: 'кнопка Send ещё неактивна', editor: {} };
    },
    (_editor, text) => out.prompts.push(text),
    (text) => out.logs.push(text),
    async (ms) => {
      out.now += ms;
    },
    { sendReadyMs: budget },
    { now: () => out.now },
  );
  const btn = await wait({}, 'задание NAR-2.12', budget);
  return { btn, ...out };
};

const slow = await runWait({ readyAfter: 8, budget: 6000 });
assert.equal(slow.btn, 'SEND', 'кнопка дождалась: страница успела отрисоваться');
assert.ok(slow.prompts.length > 0, 'пока страница рисуется, текст возвращается в поле');
assert.ok(
  slow.prompts.every((t) => t === 'задание NAR-2.12'),
  'в поле возвращается то же задание, а не пустая строка',
);

const never = await runWait({ readyAfter: 99_999, budget: 900 });
assert.equal(never.btn, null, 'если кнопка так и не появилась — ожидание заканчивается');

// Пустая настройка не превращает ожидание в NaN и мгновенный отказ.
const noBudget = await runWait({ readyAfter: 3, budget: undefined });
assert.equal(noBudget.btn, 'SEND', 'без числа в конфиге ожидание всё равно работает');

// ── 5. Отправка: без клика карточка не откатывается ────────────────────────
assert.match(
  src,
  /retry: clicked === 0,/,
  'нет ни одного клика — это не отказ доставки, а недорисованная страница',
);
assert.ok(
  !src.includes('retry: clicked === 0 && !now'),
  'прежнее условие «клика нет и поля нет» убрано: поле могло быть, а кнопка ещё disabled',
);
assert.match(
  src,
  /let btn = await waitSendReady\(live, text\);/,
  'в отправке кнопка ждётся одним длинным ожиданием, а не двумя короткими',
);
assert.ok(!src.includes('waitForSendReady(live, 1500)'), 'короткое ожидание 1,5 с из отправки убрано');
assert.ok(!src.includes('waitForSendReady(live, 3000)'), 'короткое ожидание 3 с из отправки убрано');

// ── 6. Стражи: шаг и очередь ждут отрисовку ────────────────────────────────
assert.match(src, /const shell = appReady\(\);/, 'шаг проверяет готовность приложения');
assert.match(src, /Страница ещё грузится \(\$\{shell\.why\}\) — ничего не делаю, жду\./, 'в журнале видно, что шаг ждёт');
assert.match(src, /Страница ещё грузится \(\$\{shell\.why\}\) — задание подождёт\./, 'очередь не отправляет на недогруженной странице');

// ── 7. Кнопки PR не нажимаются заблокированными ────────────────────────────
assert.match(src, /const pressable = \(b\) =>/, 'доступность кнопки проверяется отдельно');
assert.match(
  src,
  /button\[aria-label="Create pull request"\]'\)\]\.find\(pressable\)/,
  '«Create pull request» берётся только доступной',
);
assert.match(
  src,
  /button\[aria-label="Merge pull request"\]'\)\]\.find\(pressable\)/,
  '«Merge pull request» берётся только доступной',
);

console.log(
  'OK: relay 1.4.63 — на недогруженной странице скрипт не делает ничего: ждёт кнопку Send и не откатывает карточку',
);
