// Проба плашки «Эта задача была выполнена успешно?».
//
// 24.10 в 14:48 шаг принял давно законченный ход за живой: PR #34 был слит ещё
// в 11:26, а скрипт нажал «Create pull request» (запасной путь) и отправил в
// чат Build/Release реплику «Please open a pull request…». Через 23 секунды
// сторож снял блокировку с живого шага. Здесь проверяется:
//   • плашка находится по тексту и не путается с контейнером целого чата;
//   • пока плашка видна, агент считается свободным (`busyReason`), а её кнопки
//     не считаются PR-интерфейсом;
//   • при `merged: true` мерж принимается по маркеру до любого клика;
//   • плашку, которая закрывает поле ввода, скрипт убирает сам, до вставки.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Поиск плашки ────────────────────────────────────────────────────────
const plaqueFrom = src.indexOf('const COMPLETION_TEXT =');
const plaqueTo = src.indexOf('/** Кандидаты в панель завершения', plaqueFrom);
assert.ok(plaqueFrom > 0 && plaqueTo > plaqueFrom, 'completionPlaque на месте');
const plaqueBlock = src.slice(plaqueFrom, plaqueTo);
assert.match(plaqueBlock, /эта задача была выполнена успешно/, 'русский текст плашки');
assert.match(plaqueBlock, /was this task completed successfully/i, 'английский текст плашки');

const panel = (text, { transcript = false } = {}) => ({
  textContent: text,
  querySelector: (selector) => (transcript && /data-agent-transcript-message/.test(selector) ? {} : null),
});

function makePlaque(panels) {
  const fn = new Function('completionPanels', `${plaqueBlock}; return completionPlaque;`);
  return fn(() => panels);
}

{
  const found = panel('Эта задача была выполнена успешно?', {});
  assert.equal(makePlaque([found])(), found, 'плашка находится по тексту');
}
{
  const container = panel('Эта задача была выполнена успешно? переписка целиком', { transcript: true });
  assert.equal(makePlaque([container])(), null, 'контейнер с целым чатом плашкой не считается');
}
{
  const other = panel('Панель с другим текстом');
  assert.equal(makePlaque([other])(), null, 'посторонние панели не трогаем');
  assert.equal(makePlaque([])(), null, 'пустая страница — плашки нет');
}
{
  // Плашка ниже в списке, а сверху — посторонняя панель.
  const top = panel('Что-то ещё');
  const found = panel('Was this task completed successfully?', {});
  assert.equal(makePlaque([top, found])(), found, 'ищем среди всех кандидатов, а не только в первом');
}

// ── 2. Плашка — не PR-интерфейс ────────────────────────────────────────────
const prFrom = src.indexOf('const hasPrUi = () => {');
const prTo = src.indexOf('\n  };', prFrom) + '\n  };'.length;
assert.ok(prFrom > 0 && prTo > prFrom, 'hasPrUi на месте');
const prBlock = src.slice(prFrom, prTo);

function makeHasPrUi({ plaque = false, ui = { create: true } } = {}) {
  const fn = new Function(
    'completionPlaque', 'prSurface',
    `${prBlock}; return hasPrUi;`,
  );
  return fn(() => (plaque ? {} : null), () => ({ merged: false, closed: false, cont: null, create: null, merge: null, ...ui }));
}

assert.equal(makeHasPrUi({ plaque: true })(), false, 'кнопка из плашки — не PR-интерфейс');
assert.equal(makeHasPrUi({ plaque: false })(), true, 'без плашки та же кнопка считается PR-интерфейсом');
assert.equal(makeHasPrUi({ plaque: true, ui: { create: false } })(), false, 'пустая страница остаётся пустой');

// ── 3. Плашка = агент свободен ─────────────────────────────────────────────
const busyFrom = src.indexOf('function busyReason() {');
const busyHead = src.slice(busyFrom, busyFrom + 900);
assert.match(
  busyHead,
  /if \(completionPlaque\(\)\) return null;/,
  'пока плашка видна, агент не считается работающим',
);
assert.match(
  src,
  /Мастер: пока она на экране, задача не выполняется/,
  'причина записана рядом с кодом',
);

// ── 4. При merged: true кнопки PR не нажимаются ────────────────────────────
const mergedFrom = src.indexOf('async function ensureMerged(task, result) {');
const mergedTo = src.indexOf('async function finishMerge(', mergedFrom);
const mergedBlock = src.slice(mergedFrom, mergedTo);
const claimAt = mergedBlock.indexOf('if (hasMergedClaim(result)) {');
const createAt = mergedBlock.indexOf('const create = createPr();');
const graceAt = mergedBlock.indexOf('if (Date.now() > grace) {');
assert.ok(claimAt > 0 && createAt > claimAt, 'заявка о мерже проверяется раньше кнопки Create');
assert.ok(graceAt > claimAt, 'заявка решает и до истечения grace, а не после');
// 1.4.44: клика по Create/Merge нет, но Continue ждётся и нажимается —
// сам выход живёт в claimMerge.
assert.match(
  mergedBlock.slice(claimAt, graceAt),
  /return claimMerge\(/,
  'мерж по маркеру принимается без клика по Create/Merge',
);
const claimBlock = src.slice(src.indexOf('  async function claimMerge('), src.indexOf('  /**\n   * PR закрыт.'));
assert.match(claimBlock, /GM_setValue\(key, true\);/, 'без бейджа мерж всё равно запоминается');
assert.match(claimBlock, /проверить по GitHub не удалось/, 'и сказано, если проверка не удалась');
assert.match(mergedBlock, /кнопки Create\/Merge не нажимаю/, 'сказано, почему клика не было');
assert.doesNotMatch(
  mergedBlock.slice(0, claimAt),
  /createPr\(\)|mergePr\(\)/,
  'до проверки заявки кнопки не трогаются',
);

// ── 5. Плашку убирает скрипт — один раз и только по делу ───────────────────
// 1.4.45: «закрыть заранее» вырезано. Первая попытка не срабатывала (backend
// возвращал плашку при перерисовке), и в журнале появлялась вторая такая же
// строка — «Убрал плашку … (2 раза)». Мастер читал это как сбой.
const sendFrom = src.indexOf('async function consumePending(manual = false) {');
const sendBlock = src.slice(sendFrom, src.indexOf('async function submitExecutor(', sendFrom));
assert.doesNotMatch(sendBlock, /closeCompletionPlaque\(\)/, 'заранее плашку не закрываем');
const composerAt = sendBlock.indexOf('await ensureComposer()');
const plaqueLog = 'Убрал плашку «задача выполнена» — она закрывала поле ввода.';
const logAt = sendBlock.indexOf(plaqueLog);
assert.ok(composerAt > 0 && logAt > composerAt, 'одна строка журнала — после поиска поля, по факту');
assert.doesNotMatch(sendBlock, /раза\)/, 'счётчика «(2 раза)» больше нет');
assert.match(src, /function ensureComposer\(timeoutMs = 20000\)/, 'ensureComposer на месте');
assert.match(
  src,
  /editor: null, closed, polled, overlay: completionPanels\(\)\.length > 0/,
  'если плашка осталась и поле не нашлось — это видно в причине',
);

// ── 6. 1.4.63: «закрыл, а она открылась снова» — панелей больше одной ─────
// 24.10 в 20:15 шаг встал на «поле ввода пропало»: плашка закрылась и тут же
// появилась. Причина — не клик, а вторая панель: закрытие верхней показывает
// нижнюю. Теперь закрываются все видимые, и делается это до того, как ход
// снимается.
const multiFrom = src.indexOf('async function closeCompletionPanels(max = 4) {');
assert.ok(multiFrom > 0, 'closeCompletionPanels на месте');
const multiBlock = src.slice(multiFrom, src.indexOf('/** Плашка любым способом', multiFrom));
assert.match(multiBlock, /for \(const panel of panels\)/, 'закрываем каждую панель, а не первую');
assert.match(multiBlock, /pass < max/, 'проходы повторяются: вторая панель появляется после перерисовки');
assert.match(multiBlock, /await sleep\(350\)/, 'между проходами пауза');
assert.match(multiBlock, /data-agent-transcript-message/, 'контейнер с чатом панелью не считается');
assert.match(multiBlock, /captcha/, 'окно проверки не закрываем');

// ensureComposer закрывает панели, пока поле не вернётся (а не «два раза»).
const composerBlock = src.slice(
  src.indexOf('async function ensureComposer(timeoutMs = 20000) {'),
  src.indexOf('/** Короткая диагностика, почему поле не нашлось'),
);
assert.match(composerBlock, /await closeCompletionPanels\(\)/, 'ensureComposer убирает все панели');
assert.doesNotMatch(composerBlock, /closed >= 2\) break/, 'выхода «после второй попытки» больше нет');

// deliver: поле пропало посреди отправки — панели убираем, ход не снимаем.
const deliverFrom = src.indexOf('async function deliver(editor, text) {');
const deliverBlock = src.slice(deliverFrom, src.indexOf('async function send(', deliverFrom));
assert.match(deliverBlock, /await closeCompletionPanels\(\)/, 'deliver убирает панели, а не сдаётся сразу');
assert.match(deliverBlock, /поле ввода пропало — убрал панелей/, 'в причине видно, что панель была');
assert.match(
  deliverBlock,
  /waitFor\(composer, C\.composerGraceMs, 300\)/,
  'поле перечитывается после закрытия — и ждём его ВСЕГДА, даже если панель не закрылась (1.4.63)',
);
assert.match(deliverBlock, /writePrompt\(live, text\)/, 'текст вставляется в новое поле заново');
assert.match(deliverBlock, /панелей \$\{completionPanels\(\)\.length\}/, 'в отчёте об отказе — число панелей');

console.log('OK: relay 1.4.63 — плашка = агент свободен, закрываются все панели, поле возвращается');
