// Проба 1.4.74: вопрос к Мастеру видно на панели и слышно в телефоне.
//
// Случай Мастера (25.10): вопрос лежал в базе «Вопросы», но на панели рядом со
// знаком «?» не было ни числа, ни подсказки — вопрос легко пропустить. Плюс
// вопрос, заданный вместе с остановкой (`next:"blocked"`), вообще не доходил до
// базы: у него нет варианта по умолчанию, `parseQuestion` такие не принимает, и
// Мастер видел только «нужна роль».
//
// Здесь проверяется:
//   • счётчик открытых вопросов и подсказка со списком;
//   • тихое уведомление ровно один раз на новую запись (по id, а не по тексту);
//   • первый запуск не будит Мастера пачкой старых вопросов;
//   • вопрос при остановке получает прямой вариант по умолчанию и попадает в базу;
//   • опрос идёт отдельным сторожем и работает на паузе, а не только в тике.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];

const versionLine = (src.split('\n').find((line) => line.startsWith('// @version')) || '')
  .replace(/\s+/g, ' ')
  .trim();
assert.equal(versionLine, `// @version ${V}`, `версия ${V}`);

// ── 1. Панель: счётчик на кнопке вопросов ──────────────────────────────────
assert.match(src, /qBadge: "cfn-q-badge"/, 'у кнопки вопросов есть свой id');
assert.match(src, /💬 Обратная связь<span id="\$\{ui\.qBadge\}"/, 'счётчик стоит внутри единой кнопки');
assert.match(src, /badge\.textContent = list\.length \? String\(list\.length\) : ""/, 'счётчик показывает число открытых');
assert.match(src, /Открытых записей обратной связи: \$\{list\.length\}/, 'подсказка называет число словами');
assert.match(src, /Нажмите, чтобы открыть базу «Обратная связь»/, 'подсказка говорит, куда нажать');

// ── 2. Песочница: сам блок вопросов ────────────────────────────────────────
const from = src.indexOf('  const Q = {');
const to = src.indexOf('  async function questionBriefing(');
assert.ok(from > 0 && to > from, 'блок вопросов на месте');

const store = new Map();
const logs = [];
const api = new Function(
  'C', 'rt', 'sel', 'norm', 'GM_getValue', 'GM_setValue', 'notion', 'patch', 'log',
  `${src.slice(from, to)}
   return { notifyNewQuestions, noteQuestionAsked, paintQuestions, openQuestions, questionsSeen, Q };`,
)(
  { questionHours: 24, questionLineMax: 3, questionTextMax: 180, questionDefaultMax: 200, questionCheckMs: 600000, questions: 'ds-questions' },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (p) => p?.select?.name || '',
  (value) => String(value == null ? '' : value).trim().toLowerCase(),
  (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  (key, value) => store.set(key, value),
  async () => ({ id: 'row-1' }),
  async () => ({}),
  (text, error, options) => logs.push({ text, error, options }),
);

const row = (id, text, fallback) => ({ id, text, fallback });

// Первый запуск: старые вопросы не будим пачкой — только считаем.
assert.equal(api.notifyNewQuestions([row('q1', 'Роль Tools?', 'Активировать')]), 0, 'первый запуск молчит');
assert.deepEqual(store.get('cfn-q-seen'), ['q1'], 'первый запуск запомнил, что уже есть');
assert.equal(logs.filter((l) => l.options?.ntfy === 'loud').length, 0, 'пачки громких пушей на старте нет');
assert.match(logs.at(-1).text, /Открытых записей обратной связи: 1/, 'число видно в журнале');

// Новый вопрос — ровно одно тихое уведомление со смыслом вопроса.
logs.length = 0;
assert.equal(api.notifyNewQuestions([row('q1', 'Роль Tools?', 'Активировать'), row('q2', 'Принять ADR F3?', 'Принять')]), 1, 'новый вопрос найден');
const loud = logs.filter((l) => l.options?.ntfy === 'loud');
assert.equal(loud.length, 0, 'громкого пуша нет: вопросы закрывает приёмка');
const quiet = logs.filter((l) => l.options?.ntfy === 'quiet');
assert.equal(quiet.length, 1, 'строчка в журнале ровно одна');
assert.match(
  quiet[0].text,
  /Новая обратная связь: «Принять ADR F3\?» — по умолчанию: Принять\. Отвечает приёмка/,
  'в журнале текст, вариант по умолчанию и кто отвечает',
);
assert.match(quiet[0].options.title, /обратная связь/, 'заголовок говорит, что это вопрос');
assert.deepEqual(store.get('cfn-q-seen'), ['q1', 'q2'], 'оба id запомнены');

// Тот же список ещё раз — тишина.
logs.length = 0;
assert.equal(api.notifyNewQuestions([row('q1', 'Роль Tools?', 'Активировать'), row('q2', 'Принять ADR F3?', 'Принять')]), 0, 'повтор не будит');
assert.equal(logs.length, 0, 'лишних строк нет');

// Вопрос, который задал сам скрипт, тоже попадает в снимок и в память.
api.noteQuestionAsked({ id: 'q3', properties: { 'Срок': { date: { start: '2026-10-26T16:17:00.000Z' } } } }, { text: 'Выдать 2.15?', fallback: 'Да' });
const cache = api.openQuestions();
assert.ok(cache.rows.some((r) => r.id === 'q3' && r.text === 'Выдать 2.15?' && r.due), 'снимок для панели обновлён');
assert.ok(store.get('cfn-q-seen').includes('q3'), 'свой вопрос не придёт пушем второй раз');

// В Node панели нет — рисование не должно падать (пробы гоняют этот код).
assert.doesNotThrow(() => api.paintQuestions(cache.rows), 'без DOM рисование молчит');

// ── 3. Вопрос при остановке не выбрасывается ───────────────────────────────
assert.match(src, /if \(norm\(decision\.next\) !== "blocked"\)/, 'общий разбор вопроса не трогает остановку');
assert.match(src, /const rawAsk = decision\.question;/, 'в остановке вопрос читается отдельно');
assert.match(src, /Ответ Мастера: цикл уже остановлен и ждёт его/, 'прямой вариант по умолчанию — ждать Мастера');
assert.match(src, /hours: Number\(ask\.hours\) \|\| 168/, 'срок остановочного вопроса — неделя, а не сутки');
assert.match(src, /askRow = await askQuestion\(asked, \{/, 'вопрос записывается в базу «Вопросы»');
assert.match(src, /ask: askText, asked: Boolean\(askRow\)/, 'и попадает в текст паузы');
assert.match(src, /Координатор спрашивает: «\$\{ask\}»/, 'пауза называет суть вопроса словами Координатора');

// ── 4. Опрос идёт отдельно от тика и работает на паузе ─────────────────────
assert.match(src, /function watchQuestions\(\)/, 'сторож вопросов есть');
assert.match(src, /window\.setInterval\(\(\) => \{[\s\S]*?refreshQuestions\(\)/, 'опрос по таймеру');
assert.match(src, /C\.questionCheckMs\)/, 'частота — та же, что у проверки сроков');
assert.doesNotMatch(src, /cfn-q-check-at/, 'старый счётчик из тика убран');
assert.match(src, /paintQuestions\(openQuestions\(\)\.rows\);\n\s+watchQuestions\(\);/, 'панель показывает число сразу при сборке');

// Вопрос задан — он уходит тихо: отвечает приёмка, а не человек (1.4.80).
assert.match(
  src,
  /queueAnswer\(row, q, ctx\);\s*forgetQuestionIntent\(q, ctx\);\s*log\(`Вопрос записан:[\s\S]{0,260}?ntfy: "quiet"/,
  'создание вопроса не будит Мастера, а ставит его в очередь приёмки',
);

console.log(
  `OK: relay ${V} — открытые вопросы видны счётчиком на панели, новый вопрос уходит приёмке тихо, ` +
    'вопрос при остановке попадает в базу «Обратная связь» и в текст паузы',
);
