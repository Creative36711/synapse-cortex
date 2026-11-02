// Проба 1.4.74: план по устаревшей очереди не применяется, а вопросы не дублируются.
//
// 25.10. Мастер вернул в Ready карточку NAR-2.16, которая висела в Running после
// съеденной отправки. Скрипт в это время дочитывал ответ Координатора, снятый ДО
// этой правки: в нём было next: "Tools" — и ушла NAR-2.17, хотя в Ready уже
// лежала NAR-2.16 с меньшим Sequence. Вопрос «почему 2.16 так и не ушла» имеет
// ровно этот ответ: транспорт применил решение к другой очереди.
//
// Второе: уведомления приходили о том, на что Мастер уже ответил. Причина —
// повторная запись того же вопроса и счётчик «⚖», который считал решением
// Мастера то, что Мастер уже решил (ADR остаётся proposed только до записи в
// репозиторий, и записывают его агенты).

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const has = (needle, why) => assert.ok(src.includes(needle), `в скрипте нет: ${why}`);
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 50)}`);
  return src.slice(a, b);
};

// ── 1. Отпечаток Ready ─────────────────────────────────────────────────────
const readyKeySrc = cut('  const readyKeyOf = (cards) =>', '  function readyLine(cards) {');
const { readyKeyOf } = new Function(`${readyKeySrc}\nreturn { readyKeyOf };`)();

const card = (id, seq) => ({ id, properties: { Sequence: { number: seq } } });
const a = card('a', 190);
const b = card('b', 220);

assert.equal(readyKeyOf([a, b]), 'a:190,b:220', 'id и Sequence входят в отпечаток');
assert.equal(readyKeyOf([b, a]), readyKeyOf([a, b]), 'порядок карточек не важен');
assert.notEqual(readyKeyOf([b]), readyKeyOf([a, b]), 'появление карточки меняет отпечаток');
assert.notEqual(readyKeyOf([card('a', 300), b]), readyKeyOf([a, b]), 'смена Sequence меняет отпечаток');
assert.equal(readyKeyOf([]), '', 'пустой Ready — пустой отпечаток');
assert.equal(readyKeyOf(undefined), '', 'нет списка — пустой отпечаток');

// ── 2. Поведение гейта: какая перемена очереди считается чужой ────────────
const guardSrc = cut('      if (expect.kind === "plan" && typeof expect.readyKey === "string") {', '      log(`Маркер Координатора найден');
const makeGuard = ({ readyKey, runningIds = [] }) => {
  const calls = { paused: [], logged: [], plans: [], expect: 'kept', planAt: 1, shifts: 0 };
  const fn = new Function(
    'expect', 'ready', 'mission', 'role', 'decision', 'GM_getValue', 'GM_setValue', 'K', 'pause', 'log',
    'requestPlan', 'queueOf', 'taskTitle',
    `return (async () => {\n${guardSrc}\nreturn "applied";\n})();`,
  );
  const run = (currentReady) =>
    fn(
      { ...expectObj, readyKey, runningIds },
      currentReady,
      { id: 'm1' },
      { name: 'Coordinator' },
      { next: 'Tools' },
      (key, def) => (key === 'cfn-plan-shift' ? calls.shifts : def),
      (key, value) => {
        if (key === 'cfn-plan-shift') calls.shifts = value;
        if (key === 'cfn-expect') calls.expect = value;
        if (key === 'cfn-plan-at') calls.planAt = value;
      },
      { expect: 'cfn-expect' },
      (reason, ctx) => calls.paused.push({ reason, ctx }),
      (text) => calls.logged.push(text),
      async (m, r, q, note) => {
        calls.plans.push({ note, q });
        return true;
      },
      async () => ({ ready: currentReady, running: [], submitted: [], rework: [], draft: [] }),
      (card) => card.properties?.['Запрос']?.title?.[0]?.plain_text || card.id,
    );
  return { run, calls };
};
const expectObj = { kind: 'plan', at: Date.now() };
const cardOf = (id, seq = 190) => ({ id, properties: { Sequence: { number: seq }, 'Запрос': { title: [{ plain_text: `Карточка ${id}` }] } } });

// 2.1 Ничего не изменилось — решение применяется как есть.
{
  const g = makeGuard({ readyKey: 'a:190', runningIds: ['r1'] });
  assert.equal(await g.run([cardOf('a')]), 'applied', 'та же очередь — решение в силе');
  assert.equal(g.calls.plans.length, 0, 'лишнего плана нет');
  assert.equal(g.calls.shifts, 0, 'счётчик сдвигов сброшен');
}

// 2.2 Карточка вернулась в Ready из работы (случай 2.16) — новый план.
{
  const g = makeGuard({ readyKey: '', runningIds: ['4046f0cf-5705-81bd-92ca-ed93c5a98eab'] });
  const res = await g.run([cardOf('4046f0cf-5705-81bd-92ca-ed93c5a98eab')]);
  assert.equal(res, true, 'шаг занят новым планом');
  assert.equal(g.calls.plans.length, 1, 'запрошен новый план');
  assert.ok(g.calls.plans[0].note.includes('вернулись в Ready'), 'причина названа в комментарии');
  assert.ok(g.calls.logged.some((l) => l.includes('не применяю')), 'в журнале сказано, что решение не применено');
  assert.equal(g.calls.paused.length, 0, 'первый раз — без паузы');
}

// 2.3 Карточка ушла из Ready или сменила Sequence — тоже устаревший план.
{
  const g1 = makeGuard({ readyKey: 'a:190,b:220' });
  await g1.run([cardOf('a')]);
  assert.equal(g1.calls.plans.length, 1, 'исчезнувшая карточка — повод пересчитать план');

  const g2 = makeGuard({ readyKey: 'a:190' });
  await g2.run([cardOf('a', 5)]);
  assert.equal(g2.calls.plans.length, 1, 'новый Sequence — повод пересчитать план');
}

// 2.4 Новая карточка, созданная Координатором в этом же ответе, план не ломает.
{
  const g = makeGuard({ readyKey: '', runningIds: [] });
  assert.equal(await g.run([cardOf('new-card')]), 'applied', 'Draft → Ready в этом же ходе — не устаревание');
  assert.equal(g.calls.plans.length, 0, 'новый план не запрашивается');
}

// 2.5 Третий сдвиг подряд — пауза, а не бесконечные планы.
{
  const g = makeGuard({ readyKey: 'a:190' });
  g.calls.shifts = 2;
  const res = await g.run([]);
  assert.equal(res, true, 'шаг занят');
  assert.equal(g.calls.plans.length, 0, 'новый план не запрашивается');
  assert.equal(g.calls.paused[0]?.ctx?.kind, 'plan-shift', 'пауза с причиной plan-shift');
}

// ── 2б. Проводка ───────────────────────────────────────────────────────────
has('readyKey: readyKeyOf(queue.ready),', 'снимок Ready кладётся в ожидание плана');
has('runningIds: (queue.running || []).map((card) => card.id),', 'снимок идущих карточек тоже');
has('вернулись в Ready из работы', 'возврат из Running назван причиной');
has('План Координатора не совпадает с очередью уже', 'после третьего сдвига — пауза, а не цикл');
has('Ready-карточку с меньшим Sequence не обходи молча', 'правило записано в промпт Координатора');

// ── 3. Дедупликация вопросов поведением ───────────────────────────────────
const intentSrc = cut('  const questionIntents = () => {', '  function queueQuestion(q, ctx = {}) {');
const dedupeSrc = cut('  const adrRefsOf = (text) => {', '  async function askQuestion(q, ctx = {}) {');
const askSrc = cut('  async function askQuestion(q, ctx = {}) {', '  /** Отметить ответы доставленными');
const extractAdrRefs = new Function(`${dedupeSrc}\nreturn adrRefsOf;`)();
assert.ok(extractAdrRefs('ORBIT_X-7.19').has('adr:orbit_x-7.19'), 'ссылки другого проекта распознаются');
assert.equal(extractAdrRefs('ORBIT_X-7').size, 0, 'номер миссии не склеивает разные предложения');

function makeAsk({ rows = [], failQuery = false } = {}) {
  const store = new Map();
  const logs = [];
  const created = [];
  const queued = [];
  const deferred = [];
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'Q', 'norm', 'rt', 'sel', 'query', 'questionRows',
    'noteQuestionAsked', 'appendQuestionBody', 'queueQuestion', 'queueAnswer', 'log', 'dbg', 'notion', 'questionProps',
    'withQuestionWriteLock', 'questionMaterial', 'supplementalQuestion', 'questionFromRowComplete',
    `${intentSrc}\n${dedupeSrc}\n${askSrc}\nreturn { askQuestion, sameQuestionRow };`,
  );
  const api = fn(
    (key, def) => (store.has(key) ? store.get(key) : def),
    (key, value) => store.set(key, value),
    { qQueue: 'k-queue' },
    { questions: 'ds-q', questionTextMax: 180, questionTextFull: 12000, questionDefaultMax: 200, questionHours: 24 },
    { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт' },
    (v) => String(v || '').trim().toLowerCase(),
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
    (p) => p?.select?.name || '',
    async () => [],
    async () => {
      if (failQuery) throw new Error('Notion 502');
      return rows;
    },
    () => {},
    () => {},
    (q, ctx) => deferred.push({ q, ctx }),
    (row, q, ctx) => {
      queued.push({ row, q, ctx });
      return { id: row?.id };
    },
    (text, error, opts) => logs.push({ text, error: Boolean(error), ntfy: opts?.ntfy }),
    () => {},
    async (method, path, body) => {
      created.push({ method, path, body });
      return { id: `new-${created.length}`, properties: body?.properties || {} };
    },
    (q) => ({ 'Вопрос': { title: [{ type: 'text', text: { content: q.text } }] } }),
    (work) => work(),
    (url) => url || '',
    (q) => q, async (row) => ({ text: row.properties['Вопрос'].title[0].plain_text }),
  );
  return { ...api, store, logs, created, queued, deferred };
}

const row = (text, status, answer = '') => ({
  id: `row-${text.slice(0, 6)}`,
  properties: {
    'Вопрос': { title: [{ plain_text: text }] },
    'Статус': { select: { name: status } },
    'Ответ': { rich_text: answer ? [{ plain_text: answer }] : [] },
  },
});
const question = { text: 'Предел руководства: 71 680 или 524 288?', fallback: 'оставить 71 680', options: [], hours: 24 };

const same = async () => {
  const q = makeAsk({
    rows: [row('Предел руководства: 71 680 или 524 288?', 'Решено', '524 288 байт')],
  });
  return q;
};

// 3.1 Точный дубль решённого вопроса — не пишем и не будим Мастера.
{
  const api = makeAsk({ rows: [row('Предел руководства: 71 680 или 524 288?', 'Решено', '524 288 байт')] });
  const before = api.logs.length;
  const res = await api.askQuestion(question, { key: 'm:1' });
  assert.equal(res, null, 'дубль не создаёт строку');
  const note = api.logs.slice(before).find((l) => l.text);
  assert.ok(note && note.text.includes('приёмка уже ответила'), 'в журнале сказано, что отвечать не нужно');
  assert.ok(note && note.text.includes('524 288'), 'виден ответ Мастера');
  assert.notEqual(note.ntfy, 'loud', 'громкого пуша нет');
}

// 3.2 Дубль вопроса, который ещё ждёт, — второй строки нет, но вопрос
// передаётся приёмке: «Ждёт» без «Ответа» — это не «Мастер ответил».
{
  const api = makeAsk({ rows: [row('Предел руководства: 71 680 или 524 288?', 'Ждёт')] });
  const res = await api.askQuestion(question, { key: 'm:2' });
  assert.ok(res && res.id, 'найденная строка возвращается, а не теряется');
  assert.equal(api.created.length, 0, 'второй такой же строки не появляется');
  assert.equal(api.queued.length, 1, 'висящая строка поставлена в очередь приёмки');
  assert.equal(api.queued[0].row.id, res.id, 'в очередь идёт именно она');
  assert.ok(api.logs.some((l) => l.text && l.text.includes('Ждёт') && l.text.includes('приёмке')), 'причина названа');
}

// 3.3 Длинные тексты, обрезанные по-разному, считаются одним вопросом.
{
  const long = 'Предел полного руководства: ADR 2.15 держит предложение 294 912 байт, гейт требует 71 680 как действующий, а 2.19 утверждает 524 288 — какой предел действует?';
  const api = makeAsk({ rows: [row(`${long.slice(0, 170)}…`, 'Решено', '524 288')] });
  const res = await api.askQuestion({ ...question, text: long }, { key: 'm:3' });
  assert.equal(res, null, 'обрезанный текст опознан как тот же вопрос');
}

// 3.4 Разные вопросы не склеиваются; при сбое чтения запись ждёт повтора.
{
  const api = makeAsk({ rows: [row('Другой вопрос про паки', 'Решено', 'да')] });
  const res = await api.askQuestion(question, { key: 'm:4' });
  assert.ok(res && res.id, 'новый вопрос записывается');
}

// Ошибка чтения не считается доказательством отсутствия дубля.
{
  const api = makeAsk({ failQuery: true });
  const res = await api.askQuestion(question, { key: 'offline' });
  assert.equal(res, null, 'без проверки дубля строка не создаётся');
  assert.equal(api.created.length, 0, 'POST при сбое чтения запрещён');
  assert.equal(api.deferred.length, 1, 'вопрос отложен для повтора');
}

// 3.5 Тот же ADR другими словами — это повтор, а не новый вопрос (случай 25.10).
{
  const api = makeAsk({
    rows: [row('NAR-2.14: принять F3/F4/F5?', 'Решено', 'принять F3–F5')],
  });
  const before = api.logs.length;
  const res = await api.askQuestion(
    { ...question, text: 'Как решить открытый ADR docs/decisions/NAR-2.14.md?' },
    { key: 'm:5' },
  );
  assert.equal(res, null, 'повтор про решённый ADR не создаёт строку');
  const note = api.logs.slice(before).find((l) => l.text);
  assert.ok(note && note.text.includes('NAR-2.14'), 'назван ADR, по которому уже ответили');
  assert.ok(note && note.text.includes('приёмка уже ответила'), 'сказано, что ответ есть');
  assert.ok(note && note.text.includes('F3'), 'виден прежний ответ');
  assert.notEqual(note.ntfy, 'loud', 'громкого пуша нет');
}

// 3.6 Явное уточнение по тому же ADR проходит: если вопрос правда другой, Мастера спросят.
{
  const api = makeAsk({ rows: [row('NAR-2.14: принять F3/F4/F5?', 'Решено', 'принять')] });
  const res = await api.askQuestion(
    { ...question, text: 'Уточнение по NAR-2.14: что делать с F6 после приёмки F3–F5?' },
    { key: 'm:6' },
  );
  assert.ok(res && res.id, 'уточнение не глушится');
}

// 3.7 Разные ADR не склеиваются.
{
  const api = makeAsk({ rows: [row('NAR-2.15: какой предел, 71 680 или 524 288?', 'Решено', '524 288')] });
  const res = await api.askQuestion(
    { ...question, text: 'NAR-2.14: записывать ли accepted сейчас?' },
    { key: 'm:7' },
  );
  assert.ok(res && res.id, 'вопрос про другой ADR записывается');
}

// 3.8 Тот же ADR, но прежний вопрос ещё ждёт: второй строки нет, а висящая
// строка передаётся приёмке (1.4.84: «Ждёт» без ответа — не ответ Мастера).
{
  const api = makeAsk({ rows: [row('NAR-2.14: принять F3/F4/F5?', 'Ждёт')] });
  const before = api.logs.length;
  const res = await api.askQuestion(
    { ...question, text: 'Как решить открытый ADR docs/decisions/NAR-2.14.md?' },
    { key: 'm:8' },
  );
  assert.ok(res && res.id, 'висящая строка возвращается');
  assert.equal(api.created.length, 0, 'дубль ждущего вопроса не создаётся');
  assert.equal(api.queued.length, 1, 'и передаётся приёмке');
  const note = api.logs.slice(before).find((l) => l.text);
  assert.ok(note && note.text.includes('Ждёт') && note.text.includes('приёмке'), 'причина названа');
  assert.notEqual(note.ntfy, 'loud', 'громкого пуша нет');
}

// ── 4. «⚖» не зовёт Мастера туда, где он уже ответил ─────────────────────
const decidedSrc = cut('  function adrKeysOf(text) {', '  /** `Статус:` из шапки ADR');
const { decidedAdrNames } = new Function(
  'questionRows', 'Q', 'rt', 'dbg',
  `${decidedSrc}\nreturn { decidedAdrNames };`,
)(
  async () => [
    row('Предел руководства: docs/decisions/NAR-2.15.md держит 294 912', 'Решено', '524 288 байт'),
    row('NAR-2.14: принять F3/F4/F5?', 'Решено', 'принять'),
    row('Вопрос без ответа', 'Решено', ''),
    row('Предложение docs/decisions/0016-capability-registry-boundary.md', 'Решено', 'принять с поправкой'),
  ],
  { done: 'Решено', byDefault: 'Принят дефолт' },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  () => {},
);

assert.ok((await decidedAdrNames()).has('nar-2.15'), 'решение 2.15 опознано по вопросу');
assert.ok((await decidedAdrNames()).has('nar-2.14'), 'решение 2.14 опознано по вопросу');
assert.ok(!(await decidedAdrNames()).has('nar-2.16'), 'решение без ответа не считается принятым');

has('const settled = rows.filter((row) => answered.has(adrKeyOf(row.file)));', 'решения с ответом отделяются');
has('await deliverProposals(pending);', 'нерешённое предложение доходит до приёмки, а не только до счётчика');
has('if (answered === null) {', 'сбой чтения ответов не возвращает решённое в счётчик');
has('return cache.rows;', 'при сбое история ADR не считается прочитанной');
assert.doesNotMatch(src, /announceDecisions\(/, 'нет отдельного уведомления предложений');
assert.doesNotMatch(src, /ui\.adrBadge/, 'нет второго счётчика ADR');
has('const same = await sameQuestionRow(item.q.text, {', 'отложенный вопрос сверяется с базой перед записью');
has('if (q?.text && list.some((item) => questionQueueId(item) === questionQueueId(entry))) return;', 'точный повтор с тем же материалом и ходом не копится в очереди');
has('const refs = adrRefsOf(`${text} ${material}`);', 'ссылки на ADR участвуют в поиске дубля');
has('const followUpOf = (text) =>', 'уточнение по тому же ADR не глушится');
has('статус файла меняет исполнитель карточкой', 'долг записи решения остаётся видимым в журнале');

console.log('stale-plan-dedupe: ok');
