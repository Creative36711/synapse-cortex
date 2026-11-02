// Проба 1.4.40: капча («Security Verification») останавливает отправку.
//
// Случай Мастера (53), журнал 11:56:47:
//
//   11:56:44 План Координатора запрошен (1 Submitted, 0 Running, 0 Ready, 0 Rework).
//   11:56:44 «Coordinator» уже открыт — отправляю задание здесь.
//   11:56:47 Задание отправлено.
//
// Сообщение до Координатора не дошло: поверх чата висела reCAPTCHA. Скрипт
// считал отправку состоявшейся по косвенным признакам — поле опустело, в
// транскрипте на миг появилась реплика, — и дальше ждал ответа на вопрос,
// которого никто не получал.
//
// Здесь проверяется: капча распознаётся, любые признаки доставки при ней не
// считаются отправкой, пауза громкая и ждёт человека, а очередь остаётся —
// после решения капчи «Продолжить» отправит то же задание, а не начнёт ход
// заново.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim()}`);
  return src.slice(a, b);
};

// ── 1. Капча распознаётся по разметке и по заголовку ───────────────────────
const captchaSrc = cut('  const CAPTCHA_SELECTORS = [', '  /**\n   * Кнопка рядом с полем ввода.');

const visible = (el) => Boolean(el && el.isConnected !== false && el.rect !== false);

function findCaptcha({ dialogs = [], containers = [] } = {}) {
  const document = {
    querySelectorAll: (sel) => {
      if (sel.includes('role="dialog"')) return dialogs;
      if (sel === '.recaptcha-v2-container') return containers;
      return [];
    },
  };
  const fn = new Function('document', 'visible', `${captchaSrc}\nreturn { captchaDialog };`);
  return fn(document, visible).captchaDialog();
}

const dialogWith = (hit) => ({
  isConnected: true,
  rect: true,
  textContent: 'Security Verification',
  querySelector: (sel) => (hit(sel) ? { found: true } : null),
  contains: () => false,
});

// reCAPTCHA внутри диалога: узнаётся по контейнеру, по iframe и по textarea.
for (const sel of ['.recaptcha-v2-container', 'iframe[title="reCAPTCHA"]', 'iframe[src*="recaptcha"]', '#g-recaptcha-response']) {
  const dialog = dialogWith((s) => s === sel);
  assert.equal(findCaptcha({ dialogs: [dialog] }), dialog, `капча узнана по ${sel}`);
}

// Обычный диалог Arena капчей не считается.
{
  const plain = dialogWith(() => null);
  plain.textContent = 'Review changes?';
  assert.equal(findCaptcha({ dialogs: [plain] }), null, 'обычный диалог — не капча');
}

// Скрытый диалог не мешает: капча должна быть на экране.
{
  const hidden = { ...dialogWith((s) => s === '.recaptcha-v2-container'), rect: false };
  assert.equal(findCaptcha({ dialogs: [hidden] }), null, 'скрытое окно проверки не считается');
}

// Переверстка: заголовок Security Verification без известных селекторов.
{
  const textOnly = { ...dialogWith(() => null), textContent: 'Security Verification Please complete this quick security check' };
  assert.equal(findCaptcha({ dialogs: [textOnly] }), textOnly, 'капча узнаётся по заголовку');
}

// Контейнер без role=dialog тоже виден.
{
  const box = { isConnected: true, rect: true, closest: () => null };
  assert.equal(findCaptcha({ containers: [box] }), box, 'контейнер капчи без диалога');
}

// ── 2. При капче доставка не подтверждается ────────────────────────────────
const waitSrc = cut('  async function waitSent(', '  /**\n   * Текст задания всё ещё в поле ввода?');
function waitSentWith({ captcha, fresh = false, holds = false }) {
  const fn = new Function(
    'userSaysSince', 'composerHolds', 'captchaDialog', 'sleep', 'Date',
    `${waitSrc}\nreturn waitSent;`,
  );
  const run = fn(
    () => (fresh ? { id: 'm1', at: 0 } : null),
    () => holds,
    () => (captcha ? {} : null),
    async () => {},
    Date,
  );
  return run('ключ', ['m-old'], 10, 'текст задания', 0);
}

// Поле опустело, сообщение новое — но висит капча.
assert.equal(await waitSentWith({ captcha: true }), '', 'капча отменяет признаки доставки');
assert.equal(await waitSentWith({ captcha: true, fresh: true }), '', 'и свою реплику в транскрипте тоже');
// Без капчи доставку подтверждает только новое своё сообщение в чате.
const ok = await waitSentWith({ captcha: false, fresh: true });
assert.equal(ok && ok.id, 'm1', 'новое сообщение — доставка');
assert.equal(
  await waitSentWith({ captcha: false }),
  '',
  'старое сообщение и счётчик доставкой не считаются',
);
assert.equal(
  await waitSentWith({ captcha: false, fresh: true, holds: true }),
  '',
  'текст остался в поле ввода — отправки не было, даже если реплика видна',
);

// ── 3. Проверки в самой отправке ───────────────────────────────────────────
const deliverSrc = cut('  async function deliver(editor, text) {', '  /** Короткий хеш текста');
assert.match(deliverSrc, /if \(captchaDialog\(\)\) return blocked\(\);/, 'капча проверяется до клика');
assert.match(deliverSrc, /const blocked = \(\) => \(\{/, 'отказ по капче отдельный');
assert.match(deliverSrc, /captcha: true,/, 'признак капчи есть в результате');
assert.match(deliverSrc, /клик \$\{clicked\}: вместо отправки окно проверки/, 'причина называет клик');
assert.match(deliverSrc, /if \(captchaDialog\(\)\) return blocked\(\);\n        \/\/ Проверка не разовая/, 'капча проверяется и после доставки');
assert.match(deliverSrc, /if \(await captchaGuard\(\)\) return blocked\(\);/, 'и ещё раз — в карантине');

// ── 3a. Карантин: капча всплывает с задержкой ──────────────────────────────
const guardSrc = cut('  async function captchaGuard() {', '  /** Enter в поле ввода');
{
  const run = (dialogAt) => {
    let calls = 0;
    let now = 0;
    const fn = new Function('sleep', 'captchaDialog', 'C', 'Date', `${guardSrc}\nreturn captchaGuard;`)(
      async () => {
        now += 400;
      },
      () => {
        calls += 1;
        return calls >= dialogAt ? {} : null;
      },
      { captchaGuardMs: 8000 },
      { now: () => now },
    );
    return fn();
  };
  assert.equal(await run(1), true, 'капча сразу после отправки');
  assert.equal(await run(3), true, 'капча через пару секунд — тоже отказ');
  assert.equal(await run(999), false, 'тишина весь карантин — доставка');
}

// ── 3b. «Продолжить» после капчи: ответа на неотправленное не ждём ──────────
const verifySrc = cut('  async function verifyAfterCaptcha(ctx) {', '  function roleFromPath()');
assert.match(src, /const ctx = GM_getValue\(K\.pause, null\) \|\| \{\};/, 'вид паузы запоминается');
assert.match(src, /await verifyAfterCaptcha\(ctx\);\n\s+tick\(true\);/, 'проверка идёт до шага');
{
  const calls = { rolled: 0, cleared: 0 };
  let store = { expect: { kind: 'dispatch', ref: 'card-1', sentAt: Date.now(), watermark: 'm1', verified: true }, pending: null };
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'sleep', 'stillWorking', 'generating', 'messagesAfter',
    'releaseUndelivered', 'log', 'K',
    `${verifySrc}\nreturn verifyAfterCaptcha;`,
  )(
    (k) => (k === 'expect' ? store.expect : store.pending),
    (k, v) => { if (k === 'expect') { store.expect = v; calls.cleared += 1; } else store.pending = v; },
    async () => {},
    () => false,
    () => false,
    () => [],
    async () => { calls.rolled += 1; return true; },
    () => {},
    { expect: 'expect', pending: 'pending' },
  );
  assert.equal(await fn({ kind: 'send' }), false, 'обычная пауза — не наше дело');
  assert.equal(await fn({ kind: 'captcha' }), true, 'капча без хода — задание потеряно');
  assert.equal(calls.rolled, 1, 'карточка возвращается в Ready');
  assert.equal(store.expect, null, 'ожидание снято: ответа больше не ждём');
}
{
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'sleep', 'stillWorking', 'generating', 'messagesAfter',
    'releaseUndelivered', 'log', 'K',
    `${verifySrc}\nreturn verifyAfterCaptcha;`,
  )(
    () => ({ kind: 'dispatch', ref: 'card-1', sentAt: Date.now(), watermark: 'm1' }),
    () => {},
    async () => {},
    () => true,
    () => false,
    () => [],
    async () => { throw new Error('не должно вызываться'); },
    () => {},
    { expect: 'expect', pending: 'pending' },
  );
  assert.equal(await fn({ kind: 'captcha' }), false, 'агент уже работает — ход жив');
}
{
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'sleep', 'stillWorking', 'generating', 'messagesAfter',
    'releaseUndelivered', 'log', 'K',
    `${verifySrc}\nreturn verifyAfterCaptcha;`,
  )(
    () => ({ kind: 'dispatch', ref: 'card-1', sentAt: Date.now(), watermark: 'm1' }),
    () => {},
    async () => {},
    () => false,
    () => false,
    () => [{ id: 'm2', text: 'готово' }],
    async () => { throw new Error('не должно вызываться'); },
    () => {},
    { expect: 'expect', pending: 'pending' },
  );
  assert.equal(await fn({ kind: 'captcha' }), false, 'ответ уже пришёл — откат не нужен');
}

// ── 3c. Пауза по капче больше не врёт про доставку ─────────────────────────
const pauseCaptchaSrc = cut('  function captchaPause(extra = "") {', '  /**\n   * Кнопка рядом с полем ввода.');
assert.match(pauseCaptchaSrc, /captchaPause/, 'точка паузы одна');
assert.match(src, /if \(seen\?\.sentAt && seen\.verified !== false\) \{/, 'тик снимает «доставка подтверждена» при капче');
assert.match(src, /GM_setValue\(K\.expect, \{ \.\.\.seen, captcha: true, verified: false \}\);/, 'вид ожидания помечен как «ждёт человека»');

// ── 4. Очередь и карточка: откат отправки, но не хода ──────────────────────
const consumeSrc = cut('  async function consumePending(', '  // ───────────────────── следы прошлых попыток');
assert.match(consumeSrc, /if \(delivery\.captcha\) \{/, 'у капчи отдельная ветка');
const captchaBranch = consumeSrc.slice(consumeSrc.indexOf('if (delivery.captcha) {'), consumeSrc.indexOf('if (!delivery.ok) {'));
assert.doesNotMatch(captchaBranch, /releaseUndelivered/, 'карточка не откатывается: ход ждёт человека');
assert.doesNotMatch(captchaBranch, /GM_setValue\(K\.pending, null\);\n\s+captchaPause/, 'очередь не снимается молча');
assert.match(captchaBranch, /sentAt: null, verified: false/, 'отметка отправки снята — это и есть откат');
assert.match(captchaBranch, /captchaPause\(\)/, 'пауза ждёт человека');
assert.match(consumeSrc, /if \(captchaDialog\(\)\) \{\n\s+captchaPause\(\);\n\s+return true;/, 'капча до вставки тоже останавливает шаг');

// ── 5. Пауза громкая, свой заголовок пуша ──────────────────────────────────
const pauseSrc = cut('  function pause(reason, context = {}) {', '  /**\n   * Передача потерялась');
assert.match(pauseSrc, /title: context\.notifyTitle \|\| "Relay: пауза"/, 'заголовок пуша можно уточнить');
assert.match(pauseSrc, /priority: "5"/, 'пуш громкий');
assert.match(src, /notifyTitle: "Relay: капча — нужен человек"/, 'у капчи свой заголовок');
assert.match(src, /function captchaPause\(extra = ""\)/, 'одна точка паузы по капче');
assert.match(src, /задание осталось в очереди/, 'Мастеру сказано, что задание не потеряно');

// ── 6. Капча ловится и вне отправки, и не закрывается как плашка ───────────
const tickFrom = src.indexOf('  async function tick(fromToggle = false) {');
const tickBody = src.slice(tickFrom, src.indexOf('  // ───────────────────────────── старт', tickFrom));
assert.match(
  tickBody,
  /if \(captchaDialog\(\)\) \{[\s\S]{0,700}?captchaPause\(\);/,
  'тик останавливается на капче',
);
assert.match(tickBody, /verified: false/, 'и снимает ложное «отправлено»');
const closeSrc = cut('  function closeCompletionPanel() {', '  /** Плашка любым способом');
assert.match(closeSrc, /if \(captcha && \(panel === captcha \|\| panel\.contains\(captcha\)\)\) continue;/, 'окно проверки не закрывается как плашка');
assert.match(src, /captcha: \(\) => Boolean\(captchaDialog\(\)\)/, '__relay.captcha()');

console.log(
  'OK: relay 1.4.63 — капча останавливает отправку, откатывает отметку «отправлено» и ждёт человека с громким пушем',
);
