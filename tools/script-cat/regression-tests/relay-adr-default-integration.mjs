// Истёкший default не является решением приёмки по ADR. Проверяем настоящие
// блоки ScriptCat с моделью Notion и хранилища, не правя существующие вопросы.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a), to = src.indexOf(b, from + a.length);
  assert(from >= 0 && to > from, `нет блока ${a}`);
  return src.slice(from, to);
}
const decisionBlock = cut('  function adrKeysOf(text) {', '  /** `Статус:` из шапки ADR');
const expireBlock = cut('  async function closeExpired(rows, closedIds = null) {', '  /** Строки базы «Вопросы»');
const intentBlock = cut('  const questionIntents = () => {', '  function queueQuestion(q, ctx = {}) {');
const questionBlock = cut('  const adrRefsOf = (text) => {', '  /**\n   * Отметить ответы доставленными');
const proposalBlock = cut('  function proposalQuestion(row, missionName = "") {', '  async function refreshDecisions');
const Q = { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт' };
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const sel = (p) => p?.select?.name || '';
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const prop = (s) => ({ rich_text: [{ plain_text: s }] });
const question = (id, text, status, answer = '') => ({ id, properties: {
  'Вопрос': { title: [{ plain_text: text }] },
  'Статус': { select: { name: status } },
  'По умолчанию': prop('оставить как есть'), 'Ответ': prop(answer),
  'Срок': { date: { start: '2000-01-01T00:00:00.000Z' } },
} });
const expired = question('expired', 'Предложение docs/decisions/STAB-1.32.md: принять?', Q.byDefault, 'оставить как есть');
const answered = question('answered', 'Предложение docs/decisions/STAB-1.34.md: принять?', Q.done, 'принять точный diff');
const unanswered = question('missing', 'Предложение docs/decisions/NAR-2.14.md: принять?', Q.done, '');

// Закрытие обычных вопросов по сроку сохраняется, но предложение по ADR
// остаётся открытым до настоящего решения приёмки или Мастера.
{
  const patches = [];
  const closeExpired = new Function('rt', 'patch', 'Q', 'richText', 'log', 'recordQuestionChange', 'sel', 'notion', 'withQuestionWriteLock', `${expireBlock}\nreturn closeExpired;`)(
    rt, async (id, data) => patches.push({ id, data }), Q,
    (text) => [{ type: 'text', text: { content: text } }], () => {}, () => {}, sel,
    async (_method, path) => [ordinary, adr1, adr2].find((row) => path === `pages/${row.id}`),
    (work) => work(),
  );
  const ordinary = question('ordinary', 'Какой формат отчёта выбрать?', Q.wait);
  const adr1 = question('adr1', 'ADR STAB-1.32: изменить оракул?', Q.wait);
  const adr2 = question('adr2', 'Предложение docs/decisions/STAB-1.34.md: принять?', Q.wait);
  const closedIds = new Set();
  // D-080: сроков в поведении нет. Ни обычный вопрос, ни ADR-предложение по
  // сроку не закрываются: открытый вопрос остаётся открытым, пока на него не
  // ответят, и «Принят дефолт» больше не ставится никому.
  assert.equal(await closeExpired([ordinary, adr1, adr2], closedIds), 0);
  assert.deepEqual([...closedIds], []);
  assert.deepEqual(patches.map((p) => p.id), []);
}


// refreshQuestions не скрывает истёкший ADR или запись, которую Notion не
// позволил закрыть, и ставит их в очередь приёмки: закрыты лишь успешные PATCH.
{
  const refresh = cut('  async function refreshQuestions({ force = false, quiet = false } = {}) {', '  let questionsWatch = 0;');
  const ordinary = question('ordinary', 'Какой формат?', Q.wait);
  const adr = question('adr', 'Предложение docs/decisions/STAB-1.32.md: принять?', Q.wait);
  const failed = question('failed', 'Сбойная запись', Q.wait);
  const data = [ordinary, adr, failed];
  const patched = [], adopted = [], output = new Map();
  const close = new Function('rt', 'patch', 'Q', 'richText', 'log', 'recordQuestionChange', 'sel', 'notion', 'withQuestionWriteLock', `${expireBlock}\nreturn closeExpired;`)(
    rt, async (id) => { if (id === 'failed') throw new Error('Notion 503'); patched.push(id); },
    Q, (text) => [{ type: 'text', text: { content: text } }], () => {}, () => {}, sel,
    async (_method, path) => data.find((row) => path === `pages/${row.id}`), (work) => work(),
  );
  const run = new Function(
    'flushQuestionQueue', 'dbg', 'openQuestions', 'C', 'paintQuestions', 'questionRows', 'Q',
    'activeMission', 'rt', 'missionSame', 'expiredQuestions', 'closeExpired', 'GM_getValue',
    'answerHandoffKey', 'handWaitingRow', 'questionFromRow', 'log', 'qText', 'qFallback',
    'GM_setValue', 'notifyNewQuestions', 'questionRevision', 'mergeQuestionChanges', 'questionClosedAfter', 'pruneQuestionSeen',
    // D-082: строка без «Статуса» подписывается транспортом, поэтому песочнице
    // нужны те же свободные имена, что в бандле: sel, patch и oneLine.
    'sel', 'patch', 'oneLine',
    `${refresh}\nreturn refreshQuestions;`,
  )(
    async () => {}, () => {}, () => ({ at: 0, rows: [] }), { questionCheckMs: 100 }, () => {},
    async () => data, Q,
    async () => ({ properties: { 'Миссия': { title: [{ plain_text: 'STAB-1' }] } } }),
    rt, (a, b) => a === b, (rows) => rows, close, (_key, fallback) => fallback,
    (id) => `handoff:${id}`, (row) => adopted.push(row.id), (row) => ({ text: rt(row.properties['Вопрос']) }),
    () => {}, (row) => rt(row.properties['Вопрос']), (row) => rt(row.properties['По умолчанию']),
    (key, value) => output.set(key, value), () => {}, 0, (rows) => rows, () => false, () => {},
    sel, async (id) => { patched.push(id); }, (value) => String(value || ''),
  );
  const open = await run({ force: true });
  // D-080: закрывать по сроку нечего, поэтому и «не удалось закрыть» не бывает:
  // ни одной PATCH, все строки остаются открытыми и видны Координатору.
  assert.deepEqual(patched, [], 'по сроку ничего не закрыто');
  // Раз закрытия нет, «не закрылось» тоже нет: каждая ждущая строка сразу
  // передаётся приёмке, и ни одна не пропадает из открытых.
  assert.deepEqual(adopted, ['ordinary', 'adr', 'failed'], 'все ждущие строки переданы приёмке');
  assert.deepEqual(open.map((r) => r.id), ['ordinary', 'adr', 'failed']);
  assert.deepEqual(output.get('cfn-q-open').rows.map((r) => r.id), ['ordinary', 'adr', 'failed']);
}

// Старый автоматически закрытый ADR нельзя выдать Координатору как ответ.
{
  const block = cut('  function answersLine(rows) {', '  /** Свойства строки базы «Вопросы».');
  const answersLine = new Function('rt', 'sel', 'Q', 'C', `${block}\nreturn answersLine;`)(
    rt, sel, Q, { questionLineMax: 20 },
  );
  const line = answersLine([expired]);
  assert.match(line, /только default, фактического решения приёмки по ADR нет/);
  assert.match(line, /Ответы на обратную связь от Мастера и приёмки/);
}

const crossReference = question('cross', 'ADR docs/decisions/STAB-1.35.md: принять?', Q.done,
  'Принять 1.35; отдельно см. docs/decisions/STAB-1.32.md.');
const ambiguous = question('ambiguous', 'Решить docs/decisions/A.md и docs/decisions/B.md', Q.done, 'Нужны оба.');
const rows = [expired, answered, unanswered, crossReference, ambiguous];
const calls = { query: [], created: [], queued: [], patches: [] };
const store = new Map([['cfn-asked:adr:STAB-1.32.md', 1]]); // след старого вопроса
const questionRows = async (statuses) => {
  calls.query.push([...statuses]);
  return rows.filter((r) => statuses.includes(sel(r.properties['Статус'])));
};
const { adrKeysOf, adrSubjectKeysOf, decidedAdrNames } = new Function('questionRows', 'Q', 'rt', 'dbg',
  `${decisionBlock}\nreturn { adrKeysOf, adrSubjectKeysOf, decidedAdrNames };`)(questionRows, Q, rt, () => {});
{
  const names = await decidedAdrNames();
  assert.deepEqual(calls.query.at(-1), [Q.done], 'по умолчанию не запрашивается как решённое');
  assert.equal(names.has('stab-1.32'), false, 'срок и упоминание в чужом ответе не равны решению');
  assert.equal(names.has('stab-1.34'), true, 'реальный ответ по существу признаётся');
  assert.equal(names.has('stab-1.35'), true, 'решение относится к теме вопроса');
  assert.equal(names.has('a'), false, 'неоднозначный вопрос о двух файлах не присваивает решение каждому');
  assert.equal(names.has('b'), false, 'для неоднозначного вопроса нужно уточнение');
  assert.equal(names.has('nar-2.14'), false, 'пустой ответ не признаётся');
  assert.deepEqual([...adrSubjectKeysOf('NAR-2.14: docs/decisions/0016-boundary.md')], ['0016-boundary']);
  assert.deepEqual([...adrSubjectKeysOf('ORBIT_X-7.19: решение')], ['orbit_x-7.19'], 'префикс другого проекта не зашит');
  assert.deepEqual([...adrSubjectKeysOf('ORBIT_X-7.19 или TEAM-4.2')], [], 'неоднозначные темы не объединяются');
}

const { askQuestion } = new Function(
  'norm', 'rt', 'sel', 'Q', 'questionRows', 'GM_getValue', 'GM_setValue', 'log', 'dbg',
  'notion', 'C', 'questionProps', 'noteQuestionAsked', 'appendQuestionBody', 'queueAnswer', 'queueQuestion',
  'withQuestionWriteLock', 'questionMaterial',
  `${intentBlock}\n${questionBlock}\nreturn { askQuestion };`,
)(
  norm, rt, sel, Q, questionRows,
  (key, fallback) => store.has(key) ? store.get(key) : fallback,
  (key, value) => store.set(key, structuredClone(value)),
  () => {}, () => {},
  async (method, path, body) => {
    assert.equal(method, 'POST');
    assert.equal(path, 'pages');
    const made = { id: `new-${calls.created.length + 1}`, properties: body.properties };
    calls.created.push(made);
    rows.push(made);
    return made;
  },
  { questions: 'question-ds' },
  (q) => question('', q.text, Q.wait).properties,
  () => {}, async () => {},
  (row, q, context) => { calls.queued.push({ row, q, context }); return { row, q }; },
  () => { throw new Error('неожиданная очередь ошибок'); },
  (work) => work(), (url) => url || '',
);

const { deliverProposals, proposalQuestion } = new Function(
  'ADR_FOLDER', 'askQuestion', 'activeMission', 'questionRows', 'Q', 'rt', 'sel', 'adrSubjectKeysOf', 'adrKeyOf', 'dbg', 'C', 'fullQuestionText',
  `${proposalBlock}\nreturn { deliverProposals, proposalQuestion };`,
)(
  'docs/decisions', askQuestion,
  async () => ({ id: 'mission', properties: { 'Миссия': { title: [{ plain_text: 'STAB-1' }] } } }),
  questionRows, Q, rt, sel, adrSubjectKeysOf, (s) => String(s).replace(/\.md$/i, '').toLowerCase(), () => {},
  { repo: 'example/relay-fixture' }, (s) => String(s).trim(),
);
const proposal = proposalQuestion({ file: 'STAB-1.32.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }, 'STAB-1');
assert.match(proposal.fullText, /истечение срока не являются фактическим решением/);
assert.equal(proposal.fallback, 'оставить как есть');
assert.deepEqual(proposal.options, ['принять', 'отклонить', 'оставить как есть']);

const oldSnapshot = structuredClone(expired);
await deliverProposals([{ file: 'STAB-1.32.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }, { file: 'STAB-1.34.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }]);
assert.equal(calls.created.length, 1, 'исторический default приводит к одному новому уточнению, не к подмене ответа');
assert.deepEqual(expired, oldSnapshot, 'старая строка не меняется');
assert.equal(calls.queued.length, 1, 'уточнение идёт приёмке');
assert.match(calls.queued[0].q.text, /^Уточнение: Предложение docs\/decisions\/STAB-1\.32\.md/);
assert.match(calls.queued[0].q.fullText, /default не является решением/);
assert.equal(calls.queued[0].context.key, `adr-full-confirm:STAB-1.32.md:${'a'.repeat(40)}:expired`);
assert.equal(store.has(`cfn-asked:adr-full-confirm:STAB-1.32.md:${'a'.repeat(40)}:expired`), true);
assert.equal(calls.created[0].properties['Статус'].select.name, Q.wait);

await deliverProposals([{ file: 'STAB-1.32.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }, { file: 'STAB-1.34.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }]);
assert.equal(calls.created.length, 1, 'повторный проход не создаёт дубликат');
assert.equal(calls.queued.length, 1);

// Если история не читается, новая строка не создаётся вслепую.
{
  const sends = [];
  const fn = new Function(
    'ADR_FOLDER', 'askQuestion', 'activeMission', 'questionRows', 'Q', 'rt', 'sel', 'adrSubjectKeysOf', 'adrKeyOf', 'dbg', 'C', 'fullQuestionText',
    `${proposalBlock}\nreturn deliverProposals;`,
  )('docs/decisions', (...args) => sends.push(args), async () => null,
    async () => { throw new Error('Notion offline'); }, Q, rt, sel, adrSubjectKeysOf,
    (s) => String(s).replace(/\.md$/i, '').toLowerCase(), () => {});
  await fn([{ file: 'STAB-1.32.md', sha: 'a'.repeat(40), content:'Статус: proposed\n# Материал\n' }]);
  assert.equal(sends.length, 0);
}
console.log('OK: default ADR не считается ответом; старый default отдельно передаётся приёмке без правки истории');
