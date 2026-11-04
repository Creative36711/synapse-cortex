// Проба 1.4.84: вопрос и предложение доходят до приёмки, а не висят в базе.
//
// Случай Мастера (28.10, вечер): «Сейчас висит 1 открытый вопрос и 1
// предложение (/docs/decisions), ни то ни то не ушло к тебе, исправить!»
//
// Вопрос лежал в «Вопросах» с 15:41 с пустым «Ответом»: он совпал по ссылке на
// ADR с прежним вопросом, скрипт решил, что «Мастер уже ответил», и не поставил
// его в очередь приёмки. Предложение `proposed` рисовало счётчик «⚖», но строки
// в «Вопросах» не появлялось вовсе — приёмка о нём не знала.
//
// Здесь проверяется транспортная половина: висящая строка передаётся приёмке,
// нерешённое предложение превращается в вопрос со ссылкой на файл, а решённым
// оно считается по имени файла, а не по любому упоминанию номера миссии.

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

const rt = (p) =>
  (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');

// ── 1. Строка «Ждёт» без ответа уходит приёмке ────────────────────────────
const rowBlock = cut('  /** Варианты из строки «Вопросов»', '  async function sameQuestionRow(text, {');
const {
  handWaitingRow,
  questionFromRow,
  answerHandoffKey,
} = new Function(
  'GM_getValue',
  'GM_setValue',
  'Q',
  'rt',
  'sel',
  'queueAnswer',
  'questionMaterial',
  `${rowBlock}\nreturn { handWaitingRow, questionFromRow, answerHandoffKey };`,
)(
  () => 0,
  () => {},
  { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт' },
  rt,
  (p) => p?.select?.name || '',
  () => ({ queued: true }),
  (url) => url || '',
);

const waiting = {
  id: 'row-wait',
  properties: {
    'Вопрос': { title: [{ plain_text: 'NAR-5: как разорвать круг caps.json и caps.ts?' }] },
    'Статус': { select: { name: 'Ждёт' } },
    'Ответ': { rich_text: [] },
    'По умолчанию': { rich_text: [{ plain_text: 'оставить как есть' }] },
    'Варианты': { rich_text: [{ plain_text: 'A · B · C' }] },
  },
};
const answered = {
  id: 'row-done',
  properties: {
    'Вопрос': { title: [{ plain_text: 'старый' }] },
    'Статус': { select: { name: 'Решено' } },
    'Ответ': { rich_text: [{ plain_text: 'принять' }] },
  },
};

assert.equal(handWaitingRow(waiting), true, '«Ждёт» без ответа передаётся приёмке');
assert.equal(handWaitingRow(answered), false, 'решённую строку не переспрашиваем');
assert.equal(
  handWaitingRow({ id: 'row-x', properties: { 'Статус': { select: { name: 'Ждёт' } } } }),
  true,
  'даже без «Вопроса» строка не глотается молча',
);

const asQuestion = questionFromRow(waiting);
assert.equal(asQuestion.text, 'NAR-5: как разорвать круг caps.json и caps.ts?', 'вопрос берётся из строки');
assert.equal(asQuestion.fallback, 'оставить как есть', 'вариант по умолчанию сохранён');
assert.deepEqual(asQuestion.options, ['A', 'B', 'C'], 'варианты из строки разбираются');
assert.match(asQuestion.fullText, /Вариант по умолчанию: оставить как есть/, 'полный текст самодостаточен');
assert.equal(answerHandoffKey('row-wait'), 'cfn-q-handoff:row-wait', 'отметка о передаче привязана к строке');

// ── 2. askQuestion не глушит висящую строку ───────────────────────────────
const askSrc = cut('  async function askQuestion(q, ctx = {}) {', '  /** Отметить ответы доставленными');
assert.match(askSrc, /if \(status === Q\.wait && !answer\) \{/, 'различаются «Ждёт без ответа» и «решено»');
assert.match(askSrc, /const complete = await questionFromRowComplete\(same\.row\);[\s\S]*?handWaitingRow\(same\.row, complete, ctx\);/, 'висящая строка ставится в очередь приёмки');
assert.match(askSrc, /return same\.row;/, 'строка возвращается вызывающему, а не теряется');
assert.match(askSrc, /приёмка уже ответила/, 'в журнале сказано, кто отвечает');

const flushSrc = cut('  async function flushQuestionQueue() {', '  /**\n   * Ссылки на решения в тексте вопроса');
assert.match(flushSrc, /complete = await questionFromRowComplete\(same\.row\);[\s\S]*?const handled = handWaitingRow\(same\.row, complete, item\.ctx \|\| \{\}\);/, 'очередь тоже передаёт висящую строку');
assert.match(src, /const adopted = mine\.filter\(/, 'загрузка страницы подбирает строки, созданные прошлыми версиями');
assert.match(src, /!GM_getValue\(answerHandoffKey\(row\.id\), 0\)/, 'повторно вопрос не гоняется');

// ── 3. Предложение: ключ файла и вопрос приёмке ───────────────────────────
const adrBlock = cut('  function adrKeysOf(text) {', '  async function refreshDecisions(');
const { adrKeysOf, adrKeyOf, proposalQuestion, deliverProposals } = new Function(
  'ADR_FOLDER',
  'ADR_PROPOSED',
  'askQuestion',
  'activeMission',
  'rt',
  'dbg',
  'questionRows', 'Q', 'sel', 'C', 'fullQuestionText',
  `${adrBlock}\nreturn { adrKeysOf, adrKeyOf, proposalQuestion, deliverProposals };`,
)(
  'docs/decisions',
  'proposed',
  async () => ({ id: 'row-new' }),
  async () => ({ id: 'mission-1', properties: { 'Миссия': { title: [{ plain_text: 'NAR-5' }] } } }),
  rt,
  () => {},
  async () => [], { done: 'Решено', byDefault: 'Принят дефолт' }, (p) => p?.select?.name || '',
  { repo: 'example/relay-fixture' }, (value) => String(value).trim(),
);

const keys = adrKeysOf(
  'Предложение docs/decisions/0016-capability-registry-boundary.md и NAR-5.13',
);
assert.ok(keys.has('0016-capability-registry-boundary'), 'имя файла — ключ решения');
assert.ok(keys.has('nar-5.13'), 'номер карточки — тоже ключ');
assert.ok(adrKeysOf('ORBIT_X-7.19').has('orbit_x-7.19'), 'префикс проекта не зашит');
assert.equal(adrKeyOf('NAR-5.9.md'), 'nar-5.9', 'ключ файла без расширения');

const asked = proposalQuestion({ file: '0016-capability-registry-boundary.md', sha: 'a'.repeat(40), content: 'Статус: proposed\n# Полный документ\n' }, 'NAR-5');
assert.match(asked.text, /docs\/decisions\/0016-capability-registry-boundary\.md/, 'в вопросе есть ссылка на файл');
assert.equal(asked.url, 'https://github.com/example/relay-fixture/blob/main/docs/decisions/0016-capability-registry-boundary.md', 'ссылка на материал ведёт на файл в main');
assert.ok(asked.fullText.includes(asked.url), 'ссылка доступна приёмке');
assert.equal(asked.fallback, 'оставить как есть', 'по умолчанию — оставить как есть');
assert.deepEqual(asked.options, ['принять', 'отклонить', 'оставить как есть'], 'три варианта решения');
assert.match(asked.fullText, /Статус файла меняет исполнитель карточкой/, 'граница записана в вопросе');

// Повторный проход по тому же файлу новых строк не плодит: ключ в askQuestion.
const calls = [];
const dedupe = new Function(
  'ADR_FOLDER',
  'ADR_PROPOSED',
  'askQuestion',
  'activeMission',
  'rt',
  'dbg',
  'questionRows', 'Q', 'sel', 'C', 'fullQuestionText',
  `${adrBlock}\nreturn { deliverProposals };`,
)(
  'docs/decisions',
  'proposed',
  async (q, ctx) => {
    calls.push({ q, ctx });
    return null;
  },
  async () => ({ id:'mission-1', properties:{ 'Миссия':{title:[{plain_text:'Миссия'}]} } }),
  rt,
  () => {},
  async () => [], { done: 'Решено', byDefault: 'Принят дефолт' }, (p) => p?.select?.name || '',
  { repo: 'example/relay-fixture' }, (value) => String(value).trim(),
);
await dedupe.deliverProposals([
  { file: '0016-capability-registry-boundary.md', sha: 'a'.repeat(40), content: 'Статус: proposed\n# Первый документ\n' },
  { file: 'NAR-5.9.md', sha: 'b'.repeat(40), content: 'Статус: proposed\n# Второй документ\n' },
]);
assert.equal(calls.length, 2, 'предложение на файл — один вопрос');
assert.equal(calls[0].ctx.key, `adr-full:0016-capability-registry-boundary.md:${'a'.repeat(40)}`, 'отметка о передаче по файлу');
assert.ok(calls[0].q.text.includes('docs/decisions/0016-capability-registry-boundary.md'), 'ссылка на файл в вопросе');

// ── 4. Проводка в обновлении решений ──────────────────────────────────────
const refreshSrc = cut('  async function refreshDecisions(force = false) {', '  let decisionsWatch = 0;');
assert.match(refreshSrc, /answered\.has\(adrKeyOf\(row\.file\)\)/, 'решённое предложение отделяется по имени файла');
assert.match(refreshSrc, /if \(pending\.length\) await deliverProposals\(pending\);/, 'нерешённое уходит приёмке');
assert.match(refreshSrc, /статус файла меняет исполнитель карточкой/, 'долг агентов назван, а не спрятан');

// ── 5. Промпт приёмки знает про предложения (декларативно) ────────────────
const { PromptCompiler, answerRequest, dispatchRequest } = await import('./helpers/prompt-env.mjs');
const ans = PromptCompiler.compile(answerRequest()).text;
assert.match(ans, /Отвечай по существу/, 'приёмка отвечает по существу');
assert.match(ans, /сам оракул\/файлы не меняй/, 'статус/файлы меняет не приёмка');
const exe = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(exe, /статус accepted\/rejected после ответа/, 'статус файла меняет исполнитель');

console.log('adr-handoff: 24 проверки — ok');
