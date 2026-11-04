// Конструктор промптов: профили, бюджеты, маркеры, изоляция пилота, покрытие
// ruleId и инварианты #37/#38/#40. Источник истины — src/prompt-*.js.
import { strict as assert } from 'node:assert';
import {
  PromptCompiler, PROMPT_PROFILES, PROMPT_BLOCKS,
  dispatchRequest, planRequest, reviewRequest, answerRequest, reminderRequest, pilotRequest,
  UUID, task, role,
} from './helpers/prompt-env.mjs';

const BUDGETS = {
  'executor.card': 2800, 'auditor.card': 2200, 'coordinator.plan': 3200, 'coordinator.recovery': 1500,
  'reviewer.mission': 2400, 'reviewer.answer': 1800, 'reviewer.card': 2000, 'reminder.marker': 700,
  'delivery.compact': 1500, 'pilot.synapse': 250,
};
const TOTALS = {
  'executor.card': 6500, 'auditor.card': 5500, 'coordinator.plan': 7500, 'reviewer.mission': 7000,
  'reviewer.answer': 6000, 'reminder.marker': 900,
};

// 1. Каждый профиль компилируется и держит бюджет overhead и total.
const cases = [
  dispatchRequest('Executor'), dispatchRequest('Auditor'), dispatchRequest('Reviewer'),
  planRequest(), planRequest({ delivery: { tier: 'recovery' } }),
  reviewRequest(), answerRequest(), reminderRequest('Executor'), reminderRequest('Coordinator', 'CF_COORDINATOR_RESULT'),
  reminderRequest('Reviewer', 'CF_ANSWER_RESULT'), pilotRequest(),
];
for (const req of cases) {
  const r = PromptCompiler.compile(req);
  assert.ok(r.ok, `${req.kind}/${req.role.fn}: компилируется (${r.error?.message})`);
  const budget = BUDGETS[r.profileId];
  assert.ok(r.metrics.overheadChars <= budget, `${r.profileId}: overhead ${r.metrics.overheadChars} <= ${budget}`);
  if (TOTALS[r.profileId]) assert.ok(r.metrics.chars <= TOTALS[r.profileId], `${r.profileId}: total <= ${TOTALS[r.profileId]}`);
  assert.ok(r.metrics.utf8Bytes >= r.metrics.chars, 'utf8Bytes учитывает кириллицу');
  assert.ok(r.hash && r.blocks.length, 'есть хеш и список блоков');
}

// 2. Маркер ровно один, последний, с правильными ID.
{
  const r = PromptCompiler.compile(dispatchRequest('Executor'));
  const lines = r.text.trim().split('\n');
  assert.match(lines.at(-1), /^CF_AGENT_RESULT \{/, 'маркер последней строкой');
  assert.ok(r.text.includes(UUID.dispatch) && r.text.includes(UUID.run), 'ID выдачи в маркере');
  assert.equal(r.marker, 'CF_AGENT_RESULT');
}
{
  const r = PromptCompiler.compile(answerRequest());
  assert.match(r.text.trim().split('\n').at(-1), /^CF_ANSWER_RESULT \{/);
  assert.ok(r.text.includes(UUID.question), 'question_id сохранён (#40)');
}

// 3. Типизированные ошибки компиляции.
{
  const missing = PromptCompiler.compile(dispatchRequest('Executor', { task: task({ runId: '' }) }));
  assert.equal(missing.error.code, 'missing_fact');
  const unknown = PromptCompiler.compile({ kind: 'dispatch', role: role('Executor'), profileId: 'nope' });
  assert.equal(unknown.error.code, 'unknown_profile');
  const pilotTeam = PromptCompiler.compile(pilotRequest({ role: { fn: 'Executor' } }));
  assert.equal(pilotTeam.error.code, 'unknown_profile');
  const budget = PromptCompiler.compile(dispatchRequest('Executor', { delivery: { tier: 'full', hardLimit: 10 } }));
  assert.equal(budget.error.code, 'budget_exceeded');
}

// 4. Пилот изолирован: ни командных блоков, ни внутренних токенов.
{
  const r = PromptCompiler.compile(pilotRequest());
  assert.ok(r.ok);
  for (const bad of ['CF_AGENT_RESULT', 'CF_COORDINATOR_RESULT', 'Notion', 'cortex', 'REGULATION', 'WARDEN', 'DECISIONS']) {
    assert.ok(!r.text.includes(bad), `пилот без «${bad}»`);
  }
  assert.ok(r.text.includes('a'.repeat(40)), 'startSha в брифе');
  assert.ok(r.metrics.overheadChars <= 250, 'overhead пилота <= 250 сверх брифа');
}

// 5. Покрытие обязательных ruleId по ролям.
{
  const need = {
    Executor: ['R-PHASES', 'R-I18N', 'R-CARD-FIELDS', 'R-MARKER', 'R-REPO-BOUNDARY'],
    Coordinator: ['R-QUEUE', 'R-NO-REVIEWER-DISPATCH', 'R-MASTER-ONLY', 'R-D028'],
    Reviewer: ['R-VERIFY-GITHUB', 'R-D028', 'R-MASTER-ONLY'],
  };
  const exec = PromptCompiler.compile(dispatchRequest('Executor'));
  const coord = PromptCompiler.compile(planRequest());
  const rev = PromptCompiler.compile(reviewRequest());
  for (const id of need.Executor) assert.ok(exec.ruleIds.includes(id), `Executor: ${id}`);
  for (const id of need.Coordinator) assert.ok(coord.ruleIds.includes(id), `Coordinator: ${id}`);
  for (const id of need.Reviewer) assert.ok(rev.ruleIds.includes(id), `Reviewer: ${id}`);
}

// 6. Инварианты регламента в тексте.
{
  const coord = PromptCompiler.compile(planRequest()).text;
  assert.match(coord, /Check=fail НЕ ставь Rework\+Ready одним ответом/, '#37: fail не выдаётся без Rework');
  assert.match(coord, /Reviewer карточку не выдавай/, 'запрет dispatch Reviewer');
  const rec = PromptCompiler.compile(planRequest({ delivery: { tier: 'recovery' } })).text;
  assert.match(rec, /не новая задача и не новая выдача/, '#38: recovery не dispatch');
  assert.ok(!rec.includes('Черновики'), 'recovery не содержит полный план');
  const ans = PromptCompiler.compile(answerRequest({ question: { id: UUID.question, turnId: UUID.turn, fullText: 'q', masterEscalated: true } })).text;
  assert.ok(ans.includes(UUID.question), '#40: поздний маркер того же вопроса');
}

// 7. Нет «кнопочного» мусора и версионность блоков.
{
  for (const req of cases) {
    const r = PromptCompiler.compile(req);
    if (r.ok) assert.doesNotMatch(r.text, /кнопк|Continue|интерфейс/i, `${r.profileId}: без кнопок`);
  }
  for (const [id, b] of Object.entries(PROMPT_BLOCKS)) {
    assert.ok(Number.isInteger(b.version) && b.version >= 1, `${id}: версия блока`);
  }
}

// 8. forDelivery: full → compact → pause, не режет оракул молча.
{
  const d = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 6000, hardLimit: 9000 });
  assert.equal(d.strategy, 'full');
  const tight = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 10, hardLimit: 20 });
  assert.equal(tight.strategy, 'pause');
}

console.log('OK: prompts — профили в бюджетах, маркеры/ID верны, пилот изолирован, #37/#38/#40 сохранены');
