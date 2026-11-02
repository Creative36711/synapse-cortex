// Проба Continue: получит ли агент новую ветку после мержа.
//
// Вопрос Мастера (2026-10-23, 18:40): «Когда наступит его следующий код,
// ScriptCat должен нажать Continue, чтобы Архитектор получил новую ветку.
// Всё так и работает?»
//
// В 1.4.11 — не всегда:
//   • Continue искали один раз, в момент шага. Кнопка появляется чуть позже
//     бейджа Merged — и клика не было вовсе, молча;
//   • сравнение было строгим (`textContent === "Continue"`): иконка с <title>
//     даёт «ContinueContinue», и кнопка «не находилась»;
//   • в ветке «мерж принят по маркеру» (1.4.11) Continue не нажималась никогда.
// Здесь проверяется поведение 1.4.19.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Кнопка ищется по подписи, а не по точному тексту ─────────────────────
const from = src.indexOf('  /**\n   * Кнопка «Continue» — та, что после мержа');
const to = src.indexOf('  /** Что из PR-интерфейса видно прямо сейчас. */');
assert.ok(from > 0 && to > from, 'блок поиска Continue на месте');
const { continueButton, isContinueLabel } = new Function(
  'document', 'visible',
  `${src.slice(from, to)}; return { continueButton, isContinueLabel };`,
)(null, null);

assert.ok(isContinueLabel('Continue'), 'обычная подпись');
assert.ok(isContinueLabel('Continue '), 'пробелы не мешают');
assert.ok(isContinueLabel('Продолжить'), 'русская подпись');
assert.ok(isContinueLabel('ContinueContinue'), 'иконка с тем же <title> не ломает поиск');
assert.ok(!isContinueLabel('Cancel'), 'другие кнопки не путаются');
assert.ok(!isContinueLabel('Continue generating forever and ever'), 'длинная фраза не за кнопку');

const makeBtn = (text, { visible = true, disabled = false, aria = '', role = '' } = {}) => ({
  textContent: text,
  disabled,
  dataset: {},
  getAttribute: (name) => (name === 'aria-label' ? aria : name === 'aria-hidden' ? null : role),
  __visible: visible,
});
const buttons = [
  makeBtn('Cancel'),
  makeBtn('Continue', { disabled: true }),
  makeBtn('Continue', { visible: false }),
  makeBtn('Перевод', { aria: 'Continue' }),
];
const doc = { querySelectorAll: () => buttons };
const found = new Function(
  'document', 'visible',
  `${src.slice(from, to)}; return continueButton;`,
)(doc, (b) => b.__visible);
assert.equal(found(), buttons[3], 'первая доступная кнопка с подписью Continue');

// ── 2. finishMerge ждёт Continue и проверяет, что клик дошёл ────────────────
const fmFrom = src.indexOf('  async function finishMerge(task, key) {');
const fmTo = src.indexOf('  async function finishClosed(', fmFrom);
assert.ok(fmFrom > 0 && fmTo > fmFrom, 'finishMerge на месте');
const fmBlock = src.slice(fmFrom, fmTo);

function harness({ appearAfter = 0, removeAfterClick = true, never = false } = {}) {
  const logs = [];
  const patches = [];
  let checks = 0;
  let clicks = 0;
  const button = {
    click() {
      clicks += 1;
      if (removeAfterClick) present = false;
    },
  };
  let present = !never;
  const continueButton = () => {
    checks += 1;
    if (never) return null;
    if (checks <= appearAfter) return null;
    return present ? button : null;
  };
  const fn = new Function(
    'GM_setValue', 'K', 'C', 'log', 'waitFor', 'continueButton', 'sleep', 'branchName', 'patch', 'GM_getValue',
    // Проба идёт в видимой вкладке: ожидание не растягивается.
    `const patience = (ms) => ms;\n${fmBlock}; return finishMerge;`,
  );
  const finishMerge = fn(
    () => {},
    { branch: 'cfn-branch' },
    { continueWaitMs: 200 },
    (text, error) => logs.push({ text, error: Boolean(error) }),
    // В пробе свой темп: настоящие 700 мс и 8 с ожидания сделали бы её медленной.
    async (check, timeoutMs) => {
      const until = Date.now() + Math.min(Number(timeoutMs) || 0, 150);
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() >= until) return null;
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    continueButton,
    async () => {},
    () => 'arena/01a1-test-chronicle-forge',
    async (id, props) => patches.push({ id, props }),
    () => false,
  );
  return { finishMerge, logs, patches, get clicks() { return clicks; } };
}

// 2.1. Кнопка была сразу: клик, проверка, ветка записана.
{
  const h = harness();
  const state = await h.finishMerge({ id: 'card-1' }, 'cfn-merged:card-1');
  assert.equal(state, 'merged', 'мерж подтверждён');
  assert.equal(h.clicks, 1, 'Continue нажата ровно один раз');
  assert.ok(h.logs.some((l) => /нажата Continue — агент получит новую ветку/.test(l.text)), 'в журнале видно нажатие');
  assert.ok(h.logs.some((l) => /Continue принята/.test(l.text)), 'проверено, что клик дошёл');
  assert.deepEqual(h.patches[0].props.Branch.rich_text[0].text.content, 'arena/01a1-test-chronicle-forge', 'ветка записана в карточку');
}

// 2.2. Кнопка появилась позже бейджа: ждём и всё равно нажимаем.
{
  const h = harness({ appearAfter: 3 });
  await h.finishMerge({ id: 'card-2' }, 'cfn-merged:card-2');
  assert.equal(h.clicks, 1, 'Continue нажата, хотя появилась не сразу');
  assert.ok(h.logs.some((l) => /нажата Continue/.test(l.text)), 'нажатие видно в журнале');
}

// 2.3. Клик не сработал: вторая попытка и громкая запись.
{
  const h = harness({ removeAfterClick: false });
  await h.finishMerge({ id: 'card-3' }, 'cfn-merged:card-3');
  assert.equal(h.clicks, 2, 'вторая попытка клика');
  assert.ok(h.logs.some((l) => /нажал ещё раз/.test(l.text) && l.error), 'вторая попытка отмечена как ошибка');
  assert.ok(h.logs.some((l) => /клик не дошёл/.test(l.text) && l.error), 'Мастер увидит проблему');
}

// 2.4. Continue так и не появилась: честно сказано, без вранья.
{
  const h = harness({ never: true });
  const state = await h.finishMerge({ id: 'card-4' }, 'cfn-merged:card-4');
  assert.equal(state, 'merged', 'мерж всё равно засчитан');
  assert.equal(h.clicks, 0, 'кликов не было');
  assert.ok(h.logs.some((l) => /Continue не появилась/.test(l.text)), 'журнал объясняет, почему ветки нет');
  assert.ok(h.logs.some((l) => /Новая ветка появится, когда агент получит следующий ход/.test(l.text)), 'сказано, когда ветка появится');
}

// ── 3. Скрипт сначала ждёт PR-карточку, и только потом верит маркеру ────────
const emFrom = src.indexOf('  async function ensureMerged(task, result) {');
const emTo = src.indexOf('  async function finishMerge(', emFrom);
const emBlock = src.slice(emFrom, emTo);
assert.match(emBlock, /await waitFor\(hasPrUi, patience\(C\.prCardWaitMs\), 500\)/, 'карточка PR ожидается до решения по маркеру');
assert.match(emBlock, /if \(!prUi\) \{/, 'маркер — только если интерфейса нет совсем');
assert.match(src, /continueWaitMs: 20000/, 'ожидание Continue — 20 секунд');
assert.match(src, /prCardWaitMs: 8000/, 'ожидание карточки PR — 8 секунд');
assert.match(
  src,
  /Бейджа Merged и Continue на странице нет/,
  'в режиме «по маркеру» честно сказано про Continue',
);

// ── 4. Ветка читается осмысленно ────────────────────────────────────────────
const bnFrom = src.indexOf('  function branchName() {');
const bnTo = src.indexOf('  /**\n   * Ждём, что PR слит.');
const bn = new Function(
  'document',
  `${src.slice(bnFrom, bnTo)}; return branchName;`,
)({
  querySelectorAll: () => [
    { textContent: 'Relay — передача хода' },
    { textContent: 'arena/9bde7bd4-chronicle-forge' },
    { textContent: 'main' },
  ],
});
assert.equal(bn(), 'arena/9bde7bd4-chronicle-forge', 'выбрана ветка, а не заголовок чата');

console.log('OK: relay 1.4.63 — Continue ждётся после Merged, клик проверяется, ветка пишется в карточку');
