// Проба полного текста вопроса: заголовок режется с многоточием, тело — нет.
//
// История (27.10.2026): Мастер заметил, что в базе «Вопросы» текст вопроса
// обрывается. Причина — `oneLine(raw.text, 180)` в `parseQuestion`: заголовок
// резался молча, по символу, без многоточия, и второй копии текста не было
// вовсе (свойство «Карточка» хранит имя карточки, а не вопрос). Две длинные
// строки в базе имели ровно 180 символов и обрывались на «…(сейчас это да».
//
// Что проверяется здесь:
//   • короткий текст не меняется;
//   • длинный режется по границе слова и заканчивается многоточием;
//   • полный текст остаётся в `fullText` и пишется в тело страницы кусками
//     ≤ 1900 знаков (предел одного rich_text-объекта Notion — 2000);
//   • обе точки создания строки (сразу и из очереди) пишут тело.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Заголовок: код берём из самого скрипта, не копию ─────────────────────
const from = src.indexOf('  /** Одна строка без переводов');
const to = src.indexOf('  /**\n   * Разбор поля `question`');
assert.ok(from > 0 && to > from, 'блок oneLine + questionTitle на месте');
const block = src.slice(from, to);
assert.match(block, /const oneLine = /, 'oneLine');
assert.match(block, /const questionTitle = /, 'questionTitle');

const { questionTitle } = new Function(`${block}; return { questionTitle };`)();
const MAX = 180;

const short = 'Короткий вопрос без обрезки';
assert.equal(questionTitle(short, MAX), short, 'короткий текст не меняется');

const long =
  'Конфликт ТЗ: §4 требует на просмотренных кадрах ни «Фон сцены не загрузился», ' +
  'ни битых <img>, а §3.3/3.4 объявляют 27 отсутствующих картинок ash намеренной ' +
  'фикстурой, и этот текст заведомо длиннее ста восьмидесяти символов целиком';
const cut = questionTitle(long, MAX);
assert.ok(cut.length <= MAX, `заголовок не длиннее ${MAX}: ${cut.length}`);
assert.ok(cut.endsWith('…'), 'многоточие говорит, что текст длиннее');
const head = cut.slice(0, -1);
assert.ok(long.startsWith(head), 'начало совпадает с исходником');
assert.equal(long[head.length], ' ', 'рез ровно по границе слова, а не по букве');
assert.ok(!head.endsWith(' '), 'хвостовой пробел убран');

const noSpaces = 'x'.repeat(400);
assert.equal(questionTitle(noSpaces, MAX).length, MAX, 'без пробелов — режем по символу');

// ── 2. Полный текст остаётся в объекте вопроса ──────────────────────────────
assert.match(src, /const fullText = questionWithOptions\(raw\.text, allOptions\);/, 'parseQuestion хранит fullText');
assert.match(src, /return \{\s*\n\s*text,\s*\n\s*fullText,/, 'fullText уходит в объект вопроса');
assert.match(src, /fullText: questionWithOptions\(rawText, allOptions\)/, 'вопрос без default тоже с fullText');
assert.match(src, /questionTextFull: 12000/, 'предел полного текста задан в конфиге');

// ── 3. Тело страницы: куски ≤ 1900 знаков, свой запрос к Notion ─────────────
const bodyFrom = src.indexOf('  async function appendQuestionBody(row, q, ctx = {}) {');
const bodyTo = src.indexOf('  /**\n   * Записать вопрос в базу', bodyFrom);
assert.ok(bodyFrom > 0 && bodyTo > bodyFrom, 'appendQuestionBody на месте');
const body = src.slice(bodyFrom, bodyTo);
assert.match(body, /blocks\/\$\{row\.id\}\/children/, 'тело пишется в блоки страницы вопроса');
// 1.4.86: нарезка одна на весь файл — `richText`, а не свой цикл в этой функции.
assert.match(body, /const chunks = richText\(full\);/, 'куски режет общий richText');
assert.match(src, /function richText\(value, step = 1900\)/, 'шаг 1900 — меньше предела 2000');
assert.match(src, /parts\.length < 100/, 'не больше 100 частей — предел массива Notion');
assert.match(body, /heading_3/, 'тело подписано заголовком');
assert.match(body, /catch \(e\) \{\s*\n\s*dbg\([\s\S]*?return false/, 'ошибка сохраняет тело в очереди');
assert.match(body, /rememberQuestionBody\(row, q, ctx\)/, 'очередь сохраняется до записи');
assert.match(body, /notion\("PATCH", `blocks\//, 'используется append blocks API');
assert.match(body, /await questionBlocks\(row.id\)/, 'перед повтором проверяются уже записанные блоки');

// ── 4. Обе точки создания строки пишут полный текст ─────────────────────────
const ask = src.slice(src.indexOf('  async function askQuestion(q, ctx = {}) {'));
assert.match(
  ask.slice(0, ask.indexOf('  /** Отметить ответы доставленными')),
  /noteQuestionAsked\(row, q\);\s*\n\s*const bodySaved = await appendQuestionBody\(row, q, ctx\);\s*\n\s*if \(bodySaved === false\)/,
  'сразу после создания строки',
);
const flush = src.slice(src.indexOf('  async function flushQuestionQueue() {'));
assert.match(
  flush.slice(0, flush.indexOf('  /**\n   * Ссылки на решения')),
  /noteQuestionAsked\(row, item\.q\);\s*\n\s*const bodySaved = await appendQuestionBody\(row, item\.q, item\.ctx \|\| \{\}\);\s*\n\s*if \(bodySaved === false\)/,
  'и при записи из очереди',
);

console.log('✓ 1. Длинный заголовок режется по слову и помечается многоточием');
console.log('✓ 2. Полный текст вопроса хранится отдельно от заголовка');
console.log('✓ 3. Тело страницы пишется кусками ≤ 1900 знаков и не срывает вопрос');
console.log('✓ 4. Полный текст пишут обе точки создания строки');
