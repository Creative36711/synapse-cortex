// D-043: боевой отказ K-29 (2026-11-05, 22:24) — oversized-карточка без payload.
//
// Факт из Drive-журнала: оракул 4232 знака, Scope 1435, инварианты 1035,
// намерение 626; вместе с правилами и заголовками dispatch дал 10381 > 7500.
// Прежний порядок ставил Running и создавал ожидание ДО сборки промпта, затем
// откатывал карточку и называл null «дублем». Диагностика показывала overhead
// marker/git, а не контент, который действительно не поместился.
//
// Проверяем на тексте самой карточки: ранний отказ до журнала/Running/отправки, причина
// доходит Координатору через plan.note, три подряд отказа ставят паузу, успешная
// выдача сбрасывает счётчик, поздний fail-closed guard и лимит 7500 сохранены.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, PROMPT_BLOCKS, UUID, planRequest } from '../tests/helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/k29-card.json', import.meta.url), 'utf8'));
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const text = (value) => ({ rich_text: [{ plain_text: value }] });
const title = (value) => ({ title: [{ plain_text: value }] });

// Фикстура — дословные поля боевой карточки, без payload и без сетевых вызовов.
assert.equal(fixture.acceptance.length, 4232);
assert.equal(fixture.scope.length, 1435);
assert.equal(fixture.invariants.length, 1035);
assert.equal(fixture.intent.length, 626);
const card = {
  id: UUID.dispatch,
  url: 'https://notion.so/k29',
  properties: {
    'Запрос': title(fixture.title),
    'Намерение': text(fixture.intent),
    'Инварианты': text(fixture.invariants),
    'Acceptance': text(fixture.acceptance),
    'Scope': text(fixture.scope),
    'Кому': { select: { name: 'Executor Core' } },
    'Repository': text(fixture.repository),
    'Dispatch State': { select: { name: 'Ready' } },
    'Check': { select: null },
    'Payload Drive File ID': text(''),
    'Submitted At': { date: null },
    'PR': { url: null },
    'Run ID': text(''),
  },
};
const role = { id: 'agent-executor', name: 'Executor Core', fn: 'Executor', status: 'Активна', url: '/agent/executor', zone: 'game/**' };
const mission = { id: UUID.mission };

// Реальные адаптеры промпта и диагностика из собранного bundle.
const budgetBreakdownLine = new Function(`${cut('  function budgetBreakdownLine(error) {', '\n  // ───────────────────────────── промпты')}return budgetBreakdownLine;`)();
const pauses = [];
const taskTitle = (page) => rt(page.properties['Запрос']);
const promptRole = (r) => ({ id: r?.id || '', name: r?.name || '', fn: r?.fn || '', repo: r?.repo || '', zone: r?.zone || '', gate: r?.gate || '' });
const promptTarget = (ctx = {}) => ({ repo: ctx.repo || '', baseBranch: ctx.branch || 'main', startSha: '' });
const executorPrompt = new Function(
  'rt', 'taskTitle', 'promptRole', 'promptTarget', 'PromptCompiler', 'C', 'pause', 'budgetBreakdownLine',
  `${cut('  const taskFacts =', '\n  /** Ссылка на журнал последнего ответа')}return executorPrompt;`,
)(rt, taskTitle, promptRole, promptTarget, PromptCompiler, { driveFolder: 'synapse', payloadInlineMax: 1500 }, (message, ctx) => pauses.push({ message, ...ctx }), budgetBreakdownLine);

// Total-отказ показывает размеры fact-блоков, а не нулевой overhead marker/git.
let earlyReason = '';
assert.equal(executorPrompt(card, role, '', 'LOG-K29', UUID.run, mission.id, {
  repo: fixture.repository, branch: 'main', onCompileError: (reason) => { earlyReason = reason; },
}), null);
assert.equal(pauses.length, 0, 'ранняя проверка не ставит глобальную паузу');
assert.match(earlyReason, /budget_exceeded/);
assert.match(earlyReason, /total \d+ > жёсткого лимита 8000/, 'названы фактический размер и жёсткий лимит (D-048)');
// В диагностике chars блока включает подпись поля; длины самих полей закреплены выше.
assert.match(earlyReason, /task\.acceptance 42\d\d/);
assert.match(earlyReason, /task\.scope 1442/);
assert.match(earlyReason, /task\.invariants 1047/);
assert.match(earlyReason, /task\.intent 637/);
assert.doesNotMatch(earlyReason, /marker\.agent|git\.executor/, 'нулевой overhead не выдаётся за причину total-отказа');
assert.match(earlyReason, /Ready/);
assert.match(earlyReason, /не заменяет inline-оракул\/Scope/);
assert.doesNotMatch(earlyReason, /то же сообщение уже уходило/);

// Запасной путь без callback по-прежнему fail-closed: null + одна пауза.
assert.equal(executorPrompt(card, role, '', 'LOG-K29', UUID.run, mission.id, { repo: fixture.repository, branch: 'main' }), null);
assert.equal(pauses.length, 1);
assert.equal(pauses[0].kind, 'prompt-compile');
assert.match(pauses[0].message, /нажмите «Продолжить»/);

// Overhead-диагностика D-034 не сломана.
assert.match(budgetBreakdownLine({ detail: { blocks: [{ id: 'git.executor', overhead: 314, chars: 314 }] } }), /Overhead по блокам: git\.executor 314/);

// dispatchTask: отказ сборки не создаёт журнал, Running, запись задания и отправку.
const calls = [];
const store = { 'cfn-dispatch-miss': 2 };
const dispatchFrom = src.indexOf('  async function dispatchTask(');
const dispatchTo = src.indexOf('  // ───────────────────────────── цикл', dispatchFrom);
assert(dispatchFrom > 0 && dispatchTo > dispatchFrom);
const dispatchTask = new Function(
  'roles', 'roleRows', 'norm', 'rt', 'gateway', 'patch', 'taskLogEntry', 'executorPrompt',
  'log', 'taskTitle', 'uid', 'nowIso', 'sendToRole', 'notion', 'taskState', 'taskRole',
  'taskTargetRepository', 'reworkSeen', 'C', 'ACTIVE_PROFILE', 'GM_getValue', 'GM_setValue',
  'pause', 'K', 'profileSessionRepo', 'canonicalTargetRepository', 'profileRepoBranch',
  'redispatchClearProps', 'redispatchWhy', 'noteRedispatch', 'REDISPATCH_LIMIT',
  'answerStampKey', 'reworkKey', 'taskPreflight', 'releaseUndelivered',
  `${src.slice(dispatchFrom, dispatchTo)}; return dispatchTask;`,
)(
  async () => [role], async () => [role], norm, rt,
  async (action) => {
    calls.push(action);
    if (action === 'createLog') return { fileId: 'LOG-K29' };
    throw new Error(`неожиданный gateway.${action} до успешной сборки промпта`);
  },
  async () => { throw new Error('Running записан до проверки бюджета'); },
  () => { throw new Error('taskLogEntry вызван для несобранного промпта'); },
  executorPrompt,
  (message) => calls.push(`log:${message}`),
  (page) => rt(page.properties['Запрос']),
  () => UUID.run, () => '2026-11-05T19:24:23.084Z',
  async () => { throw new Error('исполнителю ушёл несобранный/укороченный промпт'); },
  async () => card,
  (page) => page.properties['Dispatch State']?.select?.name || '',
  (page) => page.properties['Кому']?.select?.name || '',
  (page, fallback) => rt(page.properties.Repository) || fallback,
  () => true,
  { repo: fixture.repository, branch: 'main', payloadInlineMax: 1500 },
  { legacy: true, repo: fixture.repository, branch: 'main' },
  (key, fallback) => store[key] ?? fallback,
  (key, value) => { store[key] = value; },
  () => { throw new Error('ранний отказ сборки не должен сразу паузить цикл'); },
  { pending: 'cfn-pending', expect: 'cfn-expect' },
  () => fixture.repository, (value, fallback) => String(value || fallback || '').trim(), () => 'main',
  () => null, () => '', () => {}, 3,
  (id) => `cfn-answer-stamp:${id}`, (id) => `cfn-rework:${id}`, async () => '',
  async () => { throw new Error('откат Running не должен вызываться: Running не создавался'); },
);
const problem = await dispatchTask(card, role.name, mission);
assert.equal(typeof problem, 'string');
assert.match(problem, /budget_exceeded/);
assert.match(problem, /карточка осталась Ready|Карточка осталась Ready/);
assert.match(problem, /Журнал выдачи не создавался/);
assert.deepEqual(calls.filter((x) => !x.startsWith('log:')), [], 'шлюз записи не вызывался');
assert.equal(store['cfn-dispatch-miss'], 2, 'отказ сборки не сбрасывает счётчик повторных выдач');
assert.equal(card.properties['Dispatch State'].select.name, 'Ready');

// Реальная ветка dispatch в coordinatorStep: два возврата с note, третий — пауза.
const branch = cut('      if (route.kind === "dispatch") {', '      // ask: ход возвращается Координатору');
const notes = [];
const branchPauses = [];
let dispatchResult = problem;
const runBranch = new Function(
  'route', 'ready', 'mission', 'role', 'GM_getValue', 'GM_setValue', 'pickReadyForRole',
  'dispatchTask', 'taskTitle', 'pause', 'log', 'queueOf', 'requestPlan',
  `return (async () => {\n${branch}\n})();`,
);
const coord = { name: 'Coordinator', fn: 'Coordinator' };
const route = { kind: 'dispatch', roleName: role.name };
const args = () => [
  route, [card], mission, coord,
  (key, fallback) => store[key] ?? fallback,
  (key, value) => { store[key] = value; },
  () => card,
  async () => dispatchResult,
  (page) => rt(page.properties['Запрос']),
  (message, ctx) => branchPauses.push({ message, ...ctx }),
  () => {},
  async () => ({ summary: '0 Submitted, 0 Running, 1 Ready' }),
  async (_mission, _role, _queue, note) => {
    notes.push(note);
    const compiled = PromptCompiler.compile(planRequest({ note, queue: { summary: '0 Submitted, 0 Running, 1 Ready' } }));
    assert(compiled.ok, `план с причиной компилируется: ${compiled.error?.message || ''}`);
    assert(compiled.text.includes(note), 'причина дословно доходит Координатору');
    assert(compiled.blocks.some((b) => b.id === 'plan.note'));
    assert.equal(compiled.blocks.at(-1).id, 'marker.coordinator');
  },
];
await runBranch(...args());
assert.equal(store['cfn-dispatch-miss'], 0); // уже было 2 отказа; третий довёл до паузы и сбросил счётчик
assert.equal(branchPauses.length, 1, 'третий подряд отказ останавливает цикл');
assert.equal(branchPauses[0].kind, 'redispatch');
assert.match(branchPauses[0].message, /budget_exceeded/);
assert.equal(store['cfn-dispatch-miss'], 0, 'после паузы счётчик сброжен');

// Первые два отказа действительно возвращают исполнимую note, а не паузу.
store['cfn-dispatch-miss'] = 0;
branchPauses.length = 0;
notes.length = 0;
await runBranch(...args());
await runBranch(...args());
assert.equal(branchPauses.length, 0);
assert.equal(notes.length, 2);
assert.equal(store['cfn-dispatch-miss'], 2);
for (const note of notes) {
  assert.match(note, /budget_exceeded/);
  assert.match(note, /Перепланируй постановку/);
  assert.match(note, /Исправь названную причину и повтори next/);
}
assert.ok(PROMPT_BLOCKS['plan.note'].verbatim, 'note остаётся verbatim, бюджет не поднят');

// Успешная выдача сбрасывает накопленные промахи.
dispatchResult = true;
await runBranch(...args());
assert.equal(store['cfn-dispatch-miss'], 0);
assert.equal(branchPauses.length, 0);

console.log('OK: D-043 K-29 — бюджет проверен до Running, причина доходит Координатору, третий отказ паузит, лимиты и оракул сохранены');
