// D-093 (1.14.22): повтор после ошибки Arena собирается фактами своего вида хода.
//
// Боевой случай 09.11 в 20:28. Передача вопроса Warden'у не принялась ошибкой
// Arena. Минимальный повтор всегда собирался через `delivery.compact` — профиль
// рабочей карточки, у которого в обязательных фактах `task.runId`. У вопроса
// run_id нет и быть не может: сборка падала на своих же фактах
// (`missing_fact task.runId`), до Arena дело не доходило, цикл вставал на
// `prompt-compile` и звал разбор как «поломку транспорта». Вопрос при этом лежал
// в очереди и ждал — то есть работа стояла не из-за Arena.
//
// Проба проверяет три вещи:
//   1) каждый вид хода собирает повтор СВОИМИ фактами (answer/review/arbiter/
//      dispatch/plan) и ни один не требует чужих;
//   2) повтор не теряет IDs: маркер в нём — тот же, что ждёт ожидание, иначе
//      ответ пришёл бы «мимо» и попал в `marker-mismatch`;
//   3) задание без run_id не отправляется вовсе: честная пауза вместо промпта,
//      собранного на пустом месте.

import assert from 'node:assert/strict';
import { PromptCompiler, PROMPT_PROFILES, UUID, role } from './helpers/prompt-env.mjs';

const profiles = PROMPT_PROFILES.profiles;

// ── 1. select: вид хода сильнее общего compact ────────────────────────────
assert.equal(PROMPT_PROFILES.select('answer', 'Reviewer', 'compact'), 'continuation.answer',
  'повтор вопроса идёт профилем вопроса, а не профилем карточки');
assert.equal(PROMPT_PROFILES.select('review', 'Reviewer', 'compact'), 'continuation.review');
assert.equal(PROMPT_PROFILES.select('arbiter', 'Reviewer', 'compact'), 'continuation.arbiter');
assert.equal(PROMPT_PROFILES.select('retry', 'Executor', 'compact'), 'executor.card',
  'обычная выдача по-прежнему собирается профилем карточки');
assert.equal(PROMPT_PROFILES.select('answer', 'Reviewer', 'tool_limit'), 'continuation.answer',
  'лимит инструментов не сломан правкой');

// ── 2. Ни один профиль повтора не требует чужих фактов ────────────────────
// Факт `task.runId` у вопроса, приёмки и арбитра взять негде — это и была поломка.
for (const id of ['continuation.answer', 'continuation.review', 'continuation.arbiter']) {
  const p = profiles[id];
  assert.ok(!(p.requiredFacts || []).includes('task.runId'), `${id} не требует task.runId`);
  assert.ok(!p.blocks.some((b) => b === 'identity.task'), `${id} не просит карточку, которой нет`);
}

// ── 3. Повтор вопроса: свои факты, свой маркер, те же IDs ─────────────────
{
  const question = { id: UUID.question, turnId: UUID.turn };
  const r = PromptCompiler.compile({
    kind: 'answer', role: role('Reviewer', { name: 'Warden' }), turnId: UUID.turn,
    mission: { id: UUID.mission },
    question, delivery: { tier: 'compact', attempt: 1 },
  });
  assert.ok(r.ok, `повтор вопроса собирается: ${r.error?.message}`);
  assert.equal(r.profileId, 'continuation.answer');
  assert.equal(r.marker, 'CF_ANSWER_RESULT', 'маркер тот же, что ждёт ожидание');
  assert.ok(r.text.includes(question.id), 'question_id не потерян');
  assert.ok(r.text.includes(UUID.turn), 'turn_id не потерян');
  assert.ok(r.text.trim().endsWith('}'), 'маркер последней строкой');
}

// ── 4. Повтор приёмки и арбитража: свои IDs, без карточки ─────────────────
{
  const r = PromptCompiler.compile({
    kind: 'review', role: role('Reviewer'), mission: { id: UUID.mission }, turnId: UUID.turn,
    delivery: { tier: 'compact', attempt: 1 },
  });
  assert.ok(r.ok, `повтор приёмки собирается: ${r.error?.message}`);
  assert.equal(r.marker, 'CF_REVIEW_RESULT');
  assert.ok(r.text.includes(UUID.mission) && r.text.includes(UUID.turn), 'mission_id и turn_id на месте');
}
{
  const r = PromptCompiler.compile({
    kind: 'arbiter', role: role('Reviewer'), turnId: UUID.turn, mission: { id: UUID.mission },
    arbiter: { cardId: UUID.dispatch, cardTitle: 'NAR-1.10' },
    delivery: { tier: 'compact', attempt: 1 },
  });
  assert.ok(r.ok, `повтор арбитража собирается: ${r.error?.message}`);
  assert.equal(r.marker, 'CF_ARBITER_RESULT');
  assert.ok(r.text.includes(UUID.dispatch), 'карточка разбора названа');
}

// ── 5. Промпт повтора не тащит задание и git: это просьба дочитать, а не выдача
for (const id of ['continuation.answer', 'continuation.review', 'continuation.arbiter']) {
  const p = profiles[id];
  for (const block of ['task.assignment', 'task.acceptance', 'task.scope', 'git.executor', 'queue.coordinator']) {
    assert.ok(p.forbidden.includes(block), `${id}: блок ${block} запрещён`);
  }
}

// ── 6. Код: вид хода выбирает факты, а не «одно правило на всё» ────────────
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/14-missing-marker.js', import.meta.url), 'utf8');
  assert.match(src, /const answerLike = expect\.kind === "answer" \|\| expect\.kind === "review" \|\| expect\.kind === "arbiter";/,
    'виды хода различены до сборки');
  assert.match(src, /if \(!String\(expect\.runId \|\| ""\)\.trim\(\)\) \{/,
    'задание без run_id не отправляется');
  assert.match(src, /kind: "retry-no-run"/, 'пауза названа своим видом');
  const core = readFileSync(new URL('../src/40-heal-core.js', import.meta.url), 'utf8');
  assert.match(core, /"retry-no-run": "master",/, 'вид паузы размечен: это состояние ожидания, а не поломка');
}

console.log('OK: relay-retry-facts — D-093: повтор собирается фактами своего вида хода, IDs и маркер сохранены, выдача без run_id не отправляется');
