// Проба 1.4.74: вопрос, который не записался в Notion, не теряется.
//
// 25.10 в 21:28 Координатор спросил про предел руководства — и в базе «Вопросы»
// не появилось ни строки: «Ждёт» = 0. Вопрос остался только в маркере, ❓ и пуш
// молчали, Мастер увидел его случайно. Причина — неудачная запись: `askQuestion`
// писал ошибку в журнал и возвращал null, второго шанса не было.
//
// Здесь проверяется, что такая строка попадает в очередь, переживает неудачу и
// записывается при следующей проверке вопросов — то есть вопрос опаздывает, но
// не исчезает.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const has = (needle, why) => assert.ok(src.includes(needle), `в скрипте нет: ${why}`);

const from = src.indexOf('  function supplementalQuestion(q, row) {');
const to = src.indexOf('  async function askQuestion(q, ctx = {}) {');
assert.ok(from > 0 && to > from, 'блок очереди вопросов на месте');
const block = src.slice(from, to);

function make({ failPost = false, rows = [] } = {}) {
  const store = new Map();
  const logs = [];
  const posted = [];
  let posts = 0;
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'notion', 'questionProps', 'noteQuestionAsked', 'appendQuestionBody', 'log', 'dbg',
    'norm', 'questionRows', 'Q', 'rt', 'queueAnswer', 'sel', 'withQuestionWriteLock', 'questionMaterial', 'fullQuestionText', 'questionBlocks', 'blockText',
    `${block}\nreturn { queueQuestion, flushQuestionQueue };`,
  );
  const api = fn(
    (key, def) => (store.has(key) ? store.get(key) : def),
    (key, value) => store.set(key, value),
    { qQueue: 'k-queue' },
    { questions: 'ds-questions' },
    async (method, path, body) => {
      posts += 1;
      if (failPost) throw new Error('Notion 502');
      posted.push({ method, path, body });
      return { id: `row-${posts}`, properties: { 'Вопрос': { title: [{ plain_text: body.properties['Вопрос'].title[0].text.content }] } } };
    },
    (q) => ({ 'Вопрос': { title: [{ type: 'text', text: { content: q.text } }] } }),
    (row, q) => logs.push({ note: q.text, rowId: row.id }),
    (row, q) => logs.push({ body: q.fullText || '', rowId: row.id }),
    (text, error, opts) => logs.push({ text, error: Boolean(error), ntfy: opts?.ntfy }),
    () => {},
    (v) => String(v || '').trim().toLowerCase(),
    async () => rows,
    { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт' },
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
    (row) => row,
    (p) => p?.select?.name || '',
    (work) => work(),
    (url) => url || '',
    (text) => text, async () => [], () => '',
  );
  return { ...api, store, logs, posted, posts: () => posts };
}

const question = {
  text: 'Какой предел руководства действует?',
  fallback: 'Оставить 71 680',
  options: ['A', 'B', 'C'],
  blocks: '',
  hours: 24,
};

// ── 1. Неудача: строка остаётся в очереди ─────────────────────────────────
{
  const { queueQuestion, flushQuestionQueue, store } = make({ failPost: true });
  queueQuestion(question, { roleName: 'Coordinator', key: 'm:1' });
  const saved = await flushQuestionQueue();
  assert.equal(saved, 0, 'при отказе Notion ничего не записано');
  assert.equal(store.get('k-queue').length, 1, 'вопрос остался в очереди, а не пропал');
}

// ── 2. Успех: очередь пустеет, вопрос записывается ────────────────────────
{
  const { queueQuestion, flushQuestionQueue, store, posted, logs } = make();
  queueQuestion(question, { roleName: 'Coordinator', key: 'm:1' });
  const saved = await flushQuestionQueue();
  assert.equal(saved, 1, 'отложенный вопрос записан');
  assert.equal(store.get('k-queue').length, 0, 'очередь пуста');
  assert.equal(posted.length, 1, 'сделан ровно один POST');
  assert.equal(posted[0].body.parent.data_source_id, 'ds-questions', 'строка идёт в базу «Вопросы»');
  assert.equal(posted[0].body.properties['Вопрос'].title[0].text.content, question.text);
  assert.ok(logs.every((l) => l.ntfy !== 'loud'), 'громкого пуша нет: вопрос уходит приёмке');
  // D-080: без gate вопрос не держит ход — журнал говорит, по какому варианту
  // идём и что ответ придёт следующим промптом.
  assert.ok(logs.some((l) => l.text && l.text.includes('ход идёт по')), 'в журнале сказано, что ход продолжается');
  assert.ok(logs.every((l) => l.ntfy !== 'loud'), 'громкого пуша нет: Мастера не будим');
  assert.ok(logs.some((l) => l.text && l.text.includes('Отложенный вопрос')), 'в журнал ушло объяснение');
}

// ── 3. Больше десяти вопросов не теряются и затем все отправляются ──────────
{
  const { queueQuestion, flushQuestionQueue, store, posted } = make();
  for (let i = 0; i < 12; i += 1) queueQuestion({ ...question, text: `Вопрос ${i}` }, { key: `k${i}` });
  assert.equal(store.get('k-queue').length, 12, 'ни один вопрос не выброшен при переполнении');
  assert.equal(await flushQuestionQueue(), 12, 'все двенадцать записаны');
  assert.equal(posted.length, 12, 'для каждого вопроса сделан POST');
  assert.equal(store.get('k-queue').length, 0, 'все отложенные вопросы записаны');
}

// ── 3б. Мастер ответил, пока вопрос лежал в очереди: не пишем и не будим ──
{
  const answered = {
    id: 'row-1',
    properties: {
      'Вопрос': { title: [{ plain_text: 'NAR-2.15: какой предел, 71 680 или 524 288?' }] },
      'Статус': { select: { name: 'Решено' } },
      'Ответ': { rich_text: [{ plain_text: '524 288' }] },
    },
  };
  const { queueQuestion, flushQuestionQueue, store, posted, logs } = make({ rows: [answered] });
  queueQuestion({ ...question, text: 'Как решить открытый ADR docs/decisions/NAR-2.15.md?' }, { key: 'm:9' });
  const saved = await flushQuestionQueue();
  assert.equal(saved, 0, 'повтор про решённый ADR не записан');
  assert.equal(posted.length, 0, 'лишнего POST нет');
  assert.equal(store.get('k-queue').length, 0, 'вопрос снят с очереди, а не копится');
  assert.ok(!logs.some((l) => l.ntfy === 'loud'), 'громкого пуша нет');
  assert.ok(logs.some((l) => l.text && l.text.includes('уже есть')), 'причина названа в журнале');
}

// ── 3г. Строка «Ждёт» без ответа — передаётся приёмке, а не глотается ─────
// 28.10: строка про NAR-5 висела в «Ждёт» с 15:41, а скрипт писал «Мастер уже
// ответил» и до приёмки её не доносил.
{
  const waiting = {
    id: 'row-wait',
    properties: {
      'Вопрос': { title: [{ plain_text: 'NAR-2.15: какой предел руководства действует?' }] },
      'Статус': { select: { name: 'Ждёт' } },
      'Ответ': { rich_text: [] },
      'По умолчанию': { rich_text: [{ plain_text: 'оставить как есть' }] },
      'Варианты': { rich_text: [{ plain_text: 'A · B · C' }] },
    },
  };
  const store = new Map();
  const queued = [];
  const logs = [];
  let posts = 0;
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'notion', 'questionProps', 'noteQuestionAsked', 'appendQuestionBody', 'log', 'dbg',
    'norm', 'questionRows', 'Q', 'rt', 'queueAnswer', 'sel', 'withQuestionWriteLock', 'questionMaterial', 'fullQuestionText', 'questionBlocks', 'blockText',
    `${block}\nreturn { queueQuestion, flushQuestionQueue };`,
  );
  const run = fn(
    (key, def) => (store.has(key) ? store.get(key) : def),
    (key, value) => store.set(key, value),
    { qQueue: 'k-queue' },
    { questions: 'ds-questions' },
    async () => {
      posts += 1;
      return { id: 'row-new' };
    },
    () => ({}),
    () => {},
    () => {},
    (text, error, opts) => logs.push({ text, error: Boolean(error), ntfy: opts?.ntfy }),
    () => {},
    (v) => String(v || '').trim().toLowerCase(),
    async () => [waiting],
    { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт' },
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
    (row, q) => queued.push({ rowId: row.id, text: q.text }),
    (p) => p?.select?.name || '',
    (work) => work(),
    (url) => url || '',
    (text) => text, async () => [], () => '',
  );
  run.queueQuestion(
    { ...question, text: 'Как решить открытый ADR docs/decisions/NAR-2.15.md?' },
    { roleName: 'Coordinator', key: 'm:11' },
  );
  const saved = await run.flushQuestionQueue();
  assert.equal(saved, 0, 'второй строки нет: она уже есть в базе');
  assert.equal(posts, 0, 'POST не делается');
  assert.equal(queued.length, 1, 'висящая строка поставлена в очередь приёмки');
  assert.equal(queued[0].rowId, 'row-wait', 'в очередь идёт именно найденная строка');
  assert.equal(store.get('k-queue').length, 0, 'очередь отложенных пуста');
  assert.ok(logs.some((l) => l.text && l.text.includes('ждёт без ответа')), 'причина названа в журнале');
}

// ── 3в. Один и тот же текст в очередь дважды не попадает ──────────────────
{
  const { queueQuestion, store } = make({ failPost: true });
  queueQuestion(question, { key: 'm:10' });
  queueQuestion(question, { key: 'm:10' });
  assert.equal(store.get('k-queue').length, 1, 'дубль в очереди не появляется');
}

// ── 4. Проводка: неудача пишется в очередь, повтор идёт с проверкой ────────
has('queueQuestion(q, ctx);', 'неудачная запись попадает в очередь');
has('Строка отложена и повторится сама', 'Мастер видит, что вопрос не потерян');
has('await flushQuestionQueue();', 'повтор запускается при обновлении вопросов');
has('qQueue: "cfn-q-queue",', 'ключ хранилища очереди');
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];
has(`@version      ${V}`, `версия ${V}`);

console.log('question-retry: ok');
