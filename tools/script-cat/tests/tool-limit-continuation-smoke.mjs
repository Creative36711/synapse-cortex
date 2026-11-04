// Tool-call limit: continuation-профили в бюджетах, IDs/маркеры верны, роль и
// git-границы соблюдены; classifyArenaFailure относит лимит к tool_call_limit
// раньше budget/rate/generic; детектор распознаёт формулировки Arena.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, PROMPT_PROFILES, UUID, role } from './helpers/prompt-env.mjs';

const srcDir = new URL('../src/', import.meta.url);
const read = (f) => readFileSync(new URL(f, srcDir), 'utf8');

// classifyArenaFailure выделяем из исходника (без браузерных зависимостей).
const tech = read('20-technical-context.js');
const cfStart = tech.indexOf('  function classifyArenaFailure(text) {');
const cfEnd = tech.indexOf('\n  }', cfStart) + '\n  }'.length;
const classifyArenaFailure = new Function(`${tech.slice(cfStart, cfEnd)}\nreturn classifyArenaFailure;`)();

// Детектор и его регулярка — из исходника видимых ошибок.
const vis = read('15-visible-errors.js');
const detSource = vis.slice(vis.indexOf('const TOOL_LIMIT_RE'), vis.indexOf('function latestUserMessageAlert'));
const { TOOL_LIMIT_RE } = new Function(`${detSource}\nreturn { TOOL_LIMIT_RE };`)();

const LIMIT_TEXT = 'The agent reached the tool-call limit for this turn. Send a message to continue where it left off.';

// ── 1. Классификация: tool_call_limit раньше budget/rate/generic ─────────────
assert.equal(classifyArenaFailure(LIMIT_TEXT), 'tool_call_limit');
assert.equal(classifyArenaFailure('The agent reached the tool-call limit for this turn'), 'tool_call_limit');
assert.equal(classifyArenaFailure('Send a message to continue where it left off'), 'tool_call_limit');
assert.equal(classifyArenaFailure('tool-call limit for this turn'), 'tool_call_limit');
assert.equal(classifyArenaFailure('tool call limit for this turn'), 'tool_call_limit');
assert.equal(classifyArenaFailure('Агент достиг лимита инструментов'), 'tool_call_limit');
assert.equal(classifyArenaFailure('лимит вызовов инструментов'), 'tool_call_limit');
// слово limit само по себе — не tool-call limit и не повод для budget по слову
assert.equal(classifyArenaFailure('rate limit exceeded'), 'rate_limit');
assert.equal(classifyArenaFailure('budget exceeded'), 'budget_exceeded');
assert.equal(classifyArenaFailure('Something went wrong. Please try again.'), 'arena_generic_error');

// ── 2. Детектор: формулировки распознаются, регэксп не ловит постороннее ─────
assert.ok(TOOL_LIMIT_RE.test(LIMIT_TEXT));
assert.ok(TOOL_LIMIT_RE.test('Агент достиг лимита инструментов'));
assert.ok(!TOOL_LIMIT_RE.test('The agent finished the task successfully'));
assert.ok(!TOOL_LIMIT_RE.test('rate limit exceeded, please slow down'));

// ── 3. Continuation-профили: бюджет, IDs, маркер, последний блок ─────────────
const cont = (kind, fn, over = {}) => ({
  kind, role: role(fn), turnId: UUID.turn, delivery: { tier: 'tool_limit', attempt: 1 },
  task: { id: UUID.dispatch, runId: UUID.run }, mission: { id: UUID.mission },
  question: { id: UUID.question, turnId: UUID.turn }, ...over,
});
const cases = [
  ['dispatch', 'Executor', 'continuation.dispatch', 'CF_AGENT_RESULT'],
  ['dispatch', 'Auditor', 'continuation.dispatch', 'CF_AGENT_RESULT'],
  ['plan', 'Coordinator', 'continuation.plan', 'CF_COORDINATOR_RESULT'],
  ['review', 'Reviewer', 'continuation.review', 'CF_REVIEW_RESULT'],
  ['answer', 'Reviewer', 'continuation.answer', 'CF_ANSWER_RESULT'],
];
for (const [kind, fn, profileId, marker] of cases) {
  const r = PromptCompiler.compile(cont(kind, fn));
  assert.ok(r.ok, `${profileId} собирается: ${r.error?.message}`);
  assert.equal(r.profileId, profileId);
  assert.equal(r.marker, marker);
  assert.ok(r.metrics.overheadChars <= 700, `${profileId} overhead ${r.metrics.overheadChars} ≤ 700`);
  assert.equal(r.blocks.at(-1).id.startsWith('marker.'), true, 'маркер — последний смысловой блок');
  assert.ok(r.text.includes(marker), 'маркер назван');
  // IDs соответствующего хода сохранены
  if (kind === 'dispatch') {
    assert.ok(r.text.includes(`dispatch_id=${UUID.dispatch}`) && r.text.includes(`run_id=${UUID.run}`), 'dispatch/run IDs');
    assert.ok(r.text.includes(`"dispatch_id":"${UUID.dispatch}"`) && r.text.includes(`"run_id":"${UUID.run}"`), 'IDs в маркерном JSON');
  } else if (kind === 'answer') {
    assert.ok(r.text.includes(`question_id=${UUID.question}`) && r.text.includes(`turn_id=${UUID.turn}`), 'question/turn IDs');
  } else {
    assert.ok(r.text.includes(`mission_id=${UUID.mission}`) && r.text.includes(`turn_id=${UUID.turn}`), 'mission/turn IDs');
  }
  // нет полного регламента/ТЗ/очереди
  assert.ok(!/REGULATION|РЕГЛАМЕНТ|Намерение|Инварианты|Оракул \(как принимают\)/.test(r.text), 'без полного регламента/ТЗ');
  assert.ok(!/Submitted,.*Running,.*Ready/.test(r.text), 'без снимка очереди');
}

// ── 4. Роль и git-границы continuation ───────────────────────────────────────
const aud = PromptCompiler.compile(cont('dispatch', 'Auditor')).text;
assert.ok(/Только чтение и проверка: без коммитов, push и PR/.test(aud), 'Auditor continuation read-only');
assert.ok(!/gh pr merge|git commit|git push/.test(aud), 'Auditor continuation без git-write');
const exec = PromptCompiler.compile(cont('dispatch', 'Executor')).text;
assert.ok(/Работай только в своём Scope/.test(exec), 'Executor continuation в своём Scope');
const plan = PromptCompiler.compile(cont('plan', 'Coordinator')).text;
assert.ok(/Не трогай git/.test(plan), 'Coordinator continuation не трогает git');
assert.ok(!/gh pr merge|git commit|git push/.test(plan));

// ── 5. Pilot continuation: без CF_* и внутренних ссылок ──────────────────────
const pilot = PromptCompiler.compile({ kind: 'pilot', role: { fn: 'pilot' }, delivery: { tier: 'tool_limit', attempt: 1 } });
assert.ok(pilot.ok, `continuation.pilot собирается: ${pilot.error?.message}`);
assert.equal(pilot.profileId, 'continuation.pilot');
assert.equal(pilot.marker, null);
assert.ok(pilot.metrics.overheadChars <= 250, 'pilot overhead ≤ 250');
assert.ok(!/CF_/.test(pilot.text), 'pilot без командных маркеров');
assert.ok(!/notion|cortex|REGULATION|WARDEN|DECISIONS|synapse-cortex/i.test(pilot.text), 'pilot без внутренних ссылок');

// ── 6. Compact-retry ролевой: Auditor read-only, Executor мержит ─────────────
const compact = (fn) => PromptCompiler.compile({
  kind: 'retry', profileId: 'delivery.compact', role: role(fn),
  task: { id: UUID.dispatch, runId: UUID.run, url: '' }, delivery: { tier: 'compact', attempt: 1 },
});
const cAud = compact('Auditor');
assert.ok(cAud.ok);
assert.ok(/Только чтение и проверка/.test(cAud.text), 'compact Auditor read-only граница');
assert.ok(!/gh pr merge/.test(cAud.text), 'compact Auditor без gh pr merge');
assert.ok(!/git commit|git push/.test(cAud.text), 'compact Auditor без git-write');
const cExec = compact('Executor');
assert.ok(cExec.ok && /gh pr merge --squash/.test(cExec.text), 'compact Executor мержит сам');

// ── 7. Ошибка компиляции continuation: missing_fact / forbidden / audience ───
const noFact = PromptCompiler.compile({ kind: 'dispatch', role: role('Executor'), delivery: { tier: 'tool_limit' }, task: { id: '', runId: UUID.run } });
assert.equal(noFact.ok, false);
assert.equal(noFact.error.code, 'missing_fact');
// continuation.dispatch не принимает Coordinator (аудитория строго по типу хода)
const wrongAud = PromptCompiler.compile(cont('dispatch', 'Coordinator'));
assert.equal(wrongAud.ok, false, 'Coordinator не получает continuation.dispatch');
// профиль continuation не содержит блоков полного задания
for (const pid of ['continuation.dispatch', 'continuation.plan', 'continuation.review', 'continuation.answer']) {
  const p = PROMPT_PROFILES.profiles[pid];
  assert.ok(!p.blocks.some((b) => ['task.assignment', 'task.acceptance', 'task.scope', 'queue.coordinator', 'git.executor'].includes(b)), `${pid} без полного задания/git-write`);
  assert.equal(p.budget.overhead, 700);
}

console.log('OK: tool-limit continuation — профили в бюджетах, IDs/маркеры верны, роль и git-границы, compact Auditor read-only, классификация tool_call_limit');
