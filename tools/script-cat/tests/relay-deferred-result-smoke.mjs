// D-105: встречный gate-вопрос удерживает исходный result, ответ возвращается
// точному автору, а подтверждённое решение переживает перезапуск и продолжает
// тот же ход. Все проверки исполняют извлечённые production-функции из bundle.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `production fragment found: ${from.trim().slice(0, 70)}`);
  return src.slice(a, b);
};
const norm = (value) => String(value || '').replace(/-/g, '').toLowerCase();
const isUuidBlock = cut('  const isUuid = (value) =>', '\n\n  /**');
const isUuid = new Function(`${isUuidBlock}\nreturn isUuid;`)();

const UUID = {
  dispatch: 'a709d6df-4698-4a98-b111-90d22de42894',
  run: '8abe7712-1111-4a2b-9c3d-4e5f6a7b8c9d',
  mission: '40c6f0cf-5705-81ae-ab6c-efac6bad62f0',
  question: '46208c7d-7c36-41df-ac99-2a38d79dbcf2',
  role: '01a18b9c-0c8b-71fd-8696-eb881e2e5217',
  otherRole: '01a18b9c-0c8b-71fd-8696-eb881e2e5218',
  turn: '7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  returnTurn: 'abcccd3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
  otherTurn: '0b0c0d0e-4a5b-6c7d-8e9f-0a1b2c3d4e5f',
};
const K = { answers: 'answers', answerReturns: 'answer-returns', expect: 'expect', pending: 'pending' };
const resultMarkers = {
  dispatch: 'CF_AGENT_RESULT',
  review: 'CF_REVIEW_RESULT',
  arbiter: 'CF_ARBITER_RESULT',
  answer: 'CF_ANSWER_RESULT',
};

function sourceExpect(kind) {
  const ref = kind === 'review' ? UUID.mission : kind === 'answer' ? UUID.question : UUID.dispatch;
  return {
    kind,
    ref,
    roleId: UUID.role,
    roleName: 'Builder',
    roleUrl: `https://arena.ai/agent/${UUID.role}`,
    roleFn: 'Executor',
    ...(kind === 'dispatch' ? { runId: UUID.run } : { turnId: UUID.turn }),
    missionId: UUID.mission,
    watermark: 'source-watermark',
    sentAt: 1_790_000_000_000,
    verified: true,
    text: 'original source prompt',
  };
}

function heldEvent(kind = 'dispatch', overrides = {}) {
  const expect = sourceExpect(kind);
  const saved = {
    version: 1,
    marker: resultMarkers[kind],
    kind,
    ref: expect.ref,
    turnId: expect.turnId || '',
    decision: { verdict: 'accept', result: 'original decision', question: null },
  };
  const deferred = {
    version: 1,
    sourceRoleId: expect.roleId,
    missionId: expect.missionId,
    expect,
    result: saved,
  };
  return {
    questionId: UUID.question,
    sourceName: 'Builder',
    sourceRoleId: UUID.role,
    answer: 'Keep the current API; verify the boundary with the contract test.',
    question: 'Should the API stay stable?',
    card: 'SYN-1.4 · API',
    mission: 'SYN-1',
    missionId: UUID.mission,
    turnId: UUID.returnTurn,
    deferred,
    at: 1_790_000_000_001,
    ...overrides,
  };
}

const returnStorageBlock = cut('  const answerReturns = () => {', '\n  const answerPending = () => answerQueue()[0] || null;');
function makeReturnApi(state = new Map(), pauses = []) {
  const get = (key, fallback) => (state.has(key) ? state.get(key) : fallback);
  const set = (key, value) => state.set(key, value);
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'norm', 'uid', 'isUuid', 'pause',
    `${returnStorageBlock}\nreturn { answerReturns, answerReturnPending, queueAnswerReturn, dropAnswerReturn, markAnswerReturnResuming, deferredReturnExpectation, resumeDeferredAnswerReturn, acknowledgeResumedAnswerReturn };`,
  )(
    get, set, K, norm, () => UUID.returnTurn, isUuid,
    (message, context = {}) => pauses.push({ message, context }),
  );
  return { ...api, get, set, state, pauses };
}

// ── 1. Gate-return snapshot is versioned, UUID-bound, and marker-specific ───
{
  const state = new Map();
  const api = makeReturnApi(state);
  for (const kind of Object.keys(resultMarkers)) {
    const event = heldEvent(kind);
    const restored = api.deferredReturnExpectation(event);
    assert.equal(restored.error, '', `${kind}: supported deferred snapshot restores`);
    assert.equal(restored.expect.kind, kind, `${kind}: original result kind survives`);
    assert.equal(restored.expect.ref, event.deferred.expect.ref, `${kind}: original ref survives`);
    assert.deepEqual(restored.expect.deferredResult.decision, event.deferred.result.decision,
      `${kind}: decision is retained, not reconstructed from prose`);
    assert.deepEqual(restored.expect.resumedAnswerReturn, {
      questionId: UUID.question, turnId: UUID.returnTurn,
    }, `${kind}: return receipt is bound to the answering question and turn`);
    const deferredResultBlock = cut('  function deferredResultFor(expect, marker) {',
      '\n  /** Обычный вопрос записывается; gate+need сначала сохраняет, затем передаёт результатный ход.');
    const deferredResultFor = new Function('norm',
      `${deferredResultBlock}\nreturn deferredResultFor;`)(norm);
    const recovered = deferredResultFor(restored.expect, resultMarkers[kind]);
    assert.equal(recovered.found, true, `${kind}: consumer accepts only the saved marker`);
    assert.deepEqual(recovered.decision, event.deferred.result.decision);
    assert.equal(recovered.error, '');
  }

  const base = heldEvent('dispatch');
  const broken = [
    { ...base, questionId: 'not-a-uuid' },
    { ...base, turnId: 'not-a-uuid' },
    { ...base, deferred: { ...base.deferred, version: 2 } },
    { ...base, deferred: { ...base.deferred, sourceRoleId: UUID.otherRole } },
    { ...base, deferred: { ...base.deferred, expect: { ...base.deferred.expect, ref: 'bad-ref' } } },
    { ...base, deferred: { ...base.deferred, expect: { ...base.deferred.expect, runId: 'bad-run' } } },
    { ...base, deferred: { ...base.deferred, result: { ...base.deferred.result, marker: 'CF_REVIEW_RESULT' } } },
    { ...base, deferred: { ...base.deferred, result: { ...base.deferred.result, kind: 'review' } } },
    { ...base, deferred: { ...base.deferred, result: { ...base.deferred.result, ref: UUID.mission } } },
    { ...base, deferred: { ...base.deferred, result: { ...base.deferred.result, turnId: UUID.otherTurn } } },
    { ...base, deferred: { ...base.deferred, result: { ...base.deferred.result, decision: null } } },
  ];
  for (const candidate of broken) {
    assert.notEqual(api.deferredReturnExpectation(candidate).error, '',
      'malformed UUID, marker, role, kind/ref/turn or snapshot version is rejected');
  }
  const invalidDispatchRun = heldEvent('dispatch');
  invalidDispatchRun.deferred.expect.runId = 'bad-run';
  assert.notEqual(api.deferredReturnExpectation(invalidDispatchRun).error, '',
    'dispatch recovery requires the original run UUID');
  const invalidReviewTurn = heldEvent('review');
  invalidReviewTurn.deferred.expect.turnId = 'bad-turn';
  assert.notEqual(api.deferredReturnExpectation(invalidReviewTurn).error, '',
    'non-dispatch recovery requires the original turn UUID');
}

// ── 2. The snapshot reaches durable storage before the answer is sent ───────
{
  const state = new Map();
  const pauses = [];
  const calls = [];
  const original = sourceExpect('dispatch');
  const event = heldEvent('dispatch');
  const row = {
    id: UUID.question, text: event.question, gate: true, need: 'Warden',
    role: 'Builder', sourceRoleId: UUID.role, missionId: UUID.mission,
  };
  state.set(K.answers, [row]);
  state.set(K.expect, original);
  const get = (key, fallback) => (state.has(key) ? state.get(key) : fallback);
  const set = (key, value) => state.set(key, value);
  const queue = () => get(K.answers, []);
  const attachBlock = cut('  function attachDeferredQuestion(parsed, ctx, expect, result = null, parentDeferred = null) {',
    '\n  /** Вытащить сохранённое решение только для исходного маркера, вида хода и ID. */');
  const attach = new Function('answerQueue', 'norm', 'GM_setValue', 'K', 'dbg',
    `${attachBlock}\nreturn attachDeferredQuestion;`)(queue, norm, set, K, () => {});
  const parsed = {
    kind: 'asked',
    question: { text: event.question, gate: true, need: 'Warden' },
    row: { id: UUID.question },
    queued: { id: UUID.question },
  };
  const deferBlock = cut('  async function deferResultForQuestion(raw, fallback, ctx, expect, marker, decision, parentDeferred = null) {',
    '\n  /**\n   * D-101: реплика этой выдачи в чате');
  const defer = new Function(
    'askQuestionFromMarker', 'GM_getValue', 'K', 'norm', 'pause', 'attachDeferredQuestion',
    'missionForQuestion', 'startAnswer', 'logThrottled',
    `${deferBlock}\nreturn deferResultForQuestion;`,
  )(
    async () => parsed, get, K, norm,
    (message, context = {}) => pauses.push({ message, context }), attach,
    async (item) => {
      assert.ok(item.deferred, 'mission lookup receives the already-persisted snapshot');
      calls.push('mission');
      return { id: UUID.mission };
    },
    async (_mission, item) => {
      const persisted = queue().find((candidate) => candidate.id === UUID.question);
      assert.ok(persisted?.deferred?.result?.decision, 'durable decision exists before sendToRole');
      assert.equal(item.deferred.expect.roleId, UUID.role);
      calls.push('send');
      set(K.expect, { kind: 'answer', ref: UUID.question, sourceRoleId: UUID.role });
      return true;
    },
    () => {},
  );
  const decision = {
    dispatch_id: UUID.dispatch, run_id: UUID.run, status: 'submitted', check: 0,
    report: 'logs/run.md', question: { text: 'Should the API stay stable?', default: 'Keep it stable' },
  };
  const result = await defer('question payload', 'continue by default', {
    roleName: 'Builder', roleId: UUID.role, missionId: UUID.mission, mission: 'SYN-1', card: 'SYN-1.4',
  }, original, 'CF_AGENT_RESULT', decision);
  assert.equal(result.held, true, 'result processing pauses for the explicit gate');
  assert.equal(result.queued, true, 'question and deferred decision remain queued');
  assert.equal(result.routed, true, 'the exact addressed-answer handoff was created');
  assert.deepEqual(calls, ['mission', 'send'], 'persistence and lookup precede handoff');
  const savedRow = queue()[0];
  assert.equal(savedRow.deferred.version, 1);
  assert.equal(savedRow.deferred.sourceRoleId, UUID.role);
  assert.equal(savedRow.deferred.result.marker, 'CF_AGENT_RESULT');
  assert.equal(savedRow.deferred.result.kind, 'dispatch');
  assert.equal(savedRow.deferred.result.ref, UUID.dispatch);
  assert.deepEqual(savedRow.deferred.result.decision, decision);
  assert.equal(pauses.length, 0, 'successful durable handoff does not pause');

  // If the durable question row is unavailable, do not send the answer request.
  state.set(K.answers, []);
  state.set(K.expect, original);
  calls.length = 0;
  const missing = await defer('question payload', 'continue by default', {
    roleName: 'Builder', roleId: UUID.role, missionId: UUID.mission,
  }, original, 'CF_AGENT_RESULT', decision);
  assert.equal(missing.held, true);
  assert.equal(missing.queued, false);
  assert.deepEqual(calls, [], 'no address is contacted without a durable snapshot');
  assert.equal(pauses.at(-1).context.kind, 'answer-handoff-missing');
}

// ── 3. Answer-return receipt is idempotent across reload and storage order ──
{
  const state = new Map();
  const pauses = [];
  const api = makeReturnApi(state, pauses);
  const source = heldEvent('dispatch');
  const item = {
    id: UUID.question, text: source.question, role: 'Builder', sourceRoleId: UUID.role,
    card: source.card, mission: source.mission, missionId: UUID.mission, deferred: source.deferred,
  };
  const event = api.queueAnswerReturn(item, '  Keep the public API stable.  ', source.deferred);
  assert.equal(event.answer, 'Keep the public API stable.', 'stored answer is normalized once');
  assert.equal(event.sourceRoleId, UUID.role, 'author role identity is durable');
  assert.equal(event.turnId, UUID.returnTurn, 'return has its own UUID receipt');
  assert.deepEqual(state.get(K.answerReturns), [event], 'return queue is written before a live answer is cleared');
  const duplicate = api.queueAnswerReturn(item, 'Updated answer text.', source.deferred);
  assert.equal(state.get(K.answerReturns).length, 1, 'same question cannot create duplicate return rows');
  assert.equal(duplicate.turnId, event.turnId, 'retry keeps the original return UUID');
  assert.equal(duplicate.at, event.at, 'retry keeps its original persistence timestamp');

  state.set(K.answerReturns, [event]);
  state.set(K.expect, {
    kind: 'answer-return', ref: UUID.question, questionId: UUID.question,
    roleId: UUID.role, turnId: event.turnId,
  });
  assert.equal(api.resumeDeferredAnswerReturn(event), true, 'confirmed return restores the source expectation');
  const restored = state.get(K.expect);
  assert.equal(restored.kind, 'dispatch');
  assert.equal(restored.ref, UUID.dispatch);
  assert.equal(restored.runId, UUID.run);
  assert.deepEqual(restored.deferredResult.decision, event.deferred.result.decision);
  assert.deepEqual(restored.resumedAnswerReturn, { questionId: UUID.question, turnId: event.turnId });
  assert.deepEqual(state.get(K.answerReturns), [], 'durable event is acknowledged after expectation is restored');

  // Simulate a reload in the narrow window after the expectation write but
  // before the queue removal. The persisted resume token makes the retry safe.
  state.set(K.answerReturns, [event]);
  const restarted = makeReturnApi(state, pauses);
  assert.equal(restarted.resumeDeferredAnswerReturn(event), true, 'restart recognizes the already-restored token');
  assert.deepEqual(state.get(K.answerReturns), [], 'restart removes only the matching receipt');
  const clean = restarted.acknowledgeResumedAnswerReturn(state.get(K.expect));
  assert.equal(clean.resumedAnswerReturn, undefined, 'next tick removes the one-shot token');
  assert.equal(state.get(K.expect).kind, 'dispatch', 'source result stays live after cleanup');
  assert.equal(pauses.length, 0, 'normal restart is not treated as identity mismatch');

  // A different live turn is never overwritten by a stale return event.
  state.set(K.answerReturns, [event]);
  const unrelated = { kind: 'review', ref: UUID.mission, turnId: UUID.otherTurn, roleId: UUID.otherRole };
  state.set(K.expect, unrelated);
  assert.equal(restarted.resumeDeferredAnswerReturn(event), true, 'stale receipt is held for inspection');
  assert.deepEqual(state.get(K.expect), unrelated, 'a newer live expectation is not replaced');
  assert.deepEqual(state.get(K.answerReturns), [event], 'unmatched durable receipt remains queued');
  assert.equal(pauses.at(-1).context.kind, 'answer-return-changed');
}

// ── 4. Return is delivered to the exact source role, never a default Reviewer ─
{
  const rows = [
    { id: UUID.otherRole, name: 'Warden', fn: 'Reviewer', status: 'Активна', url: `https://arena.ai/agent/${UUID.otherRole}` },
    { id: UUID.role, name: 'Builder', fn: 'Executor', status: 'Активна', url: `https://arena.ai/agent/${UUID.role}` },
  ];
  const textBlock = cut('  function answerReturnText(event, responderName) {',
    '\n  /**\n   * Поставить прямой возврат автору вопроса');
  const answerReturnText = new Function(`${textBlock}\nreturn answerReturnText;`)();
  const startBlock = cut('  async function startAnswerReturn(event) {',
    '\n  /** Coordinator получает очередь только после прямого подтверждения источнику. */');
  const makeStart = (directory) => {
    const sent = [];
    const pauses = [];
    const start = new Function(
      'roleRows', 'norm', 'logThrottled', 'pause', 'isUuid', 'deliveryReceipt',
      'GM_setValue', 'K', 'location', 'navigateTo', 'sendToRole', 'isPaused', 'answerReturnText',
      `${startBlock}\nreturn startAnswerReturn;`,
    )(
      async (options) => { assert.deepEqual(options, { fresh: true, requireFresh: true }); return directory; },
      norm, () => {}, (message, context = {}) => pauses.push({ message, context }), isUuid,
      () => null, () => {}, K, { href: 'https://arena.ai/agent/current' }, async () => {},
      async (...args) => { sent.push(args); return true; }, () => false, answerReturnText,
    );
    return { start, sent, pauses };
  };
  const event = heldEvent('dispatch');
  const exact = makeStart(rows);
  assert.equal(await exact.start(event), 'queued');
  assert.equal(exact.sent.length, 1, 'one direct message was queued');
  assert.equal(exact.sent[0][0].id, UUID.role, 'the exact source role ID wins over first Reviewer');
  assert.equal(exact.sent[0][2], 'answer-return');
  assert.equal(exact.sent[0][3], UUID.question);
  assert.match(exact.sent[0][1], /^АДРЕСНЫЙ ВОЗВРАТ ОТВЕТА/);
  assert.ok(exact.sent[0][1].includes(UUID.question) && exact.sent[0][1].includes(UUID.returnTurn));
  assert.ok(exact.sent[0][1].includes(event.answer));
  assert.equal(exact.sent[0][4].sourceRoleId, UUID.role);
  assert.equal(exact.pauses.length, 0);

  // ID is authoritative: a matching display name cannot redirect a stale ID.
  const staleId = makeStart(rows);
  const wrong = await staleId.start({ ...event, sourceRoleId: UUID.otherTurn });
  assert.equal(wrong, 'held');
  assert.equal(staleId.sent.length, 0, 'wrong source-role ID is not replaced by matching name');
  assert.equal(staleId.pauses[0].context.kind, 'answer-return-role');

  const disabled = makeStart([{ ...rows[1], status: 'Ждёт' }]);
  assert.equal(await disabled.start(event), 'held');
  assert.equal(disabled.sent.length, 0, 'disabled author never gets a fallback delivery');
  assert.equal(disabled.pauses[0].context.kind, 'answer-return-role');
}

// ── 5. Only a verified delivery receipt can resume the held result ──────────
{
  const state = new Map();
  const pauses = [];
  const api = makeReturnApi(state, pauses);
  const event = heldEvent('dispatch');
  state.set(K.answerReturns, [event]);
  const live = {
    kind: 'answer-return', ref: UUID.question, questionId: UUID.question,
    roleId: UUID.role, turnId: event.turnId, sentAt: 1_790_000_000_010, verified: true,
  };
  state.set(K.expect, live);
  const stepBlock = cut('  async function answerReturnStep(role, expect, manual = false) {',
    '\n  /**\n   * D-085:');
  const makeStep = () => new Function(
    'K', 'GM_getValue', 'GM_setValue', 'norm', 'pause', 'restoreMissingSendMark',
    'answerReturns', 'log', 'dropAnswerReturn', 'markAnswerReturnResuming',
    'resumeDeferredAnswerReturn', 'continueAfterAnswerReturn',
    `${stepBlock}\nreturn answerReturnStep;`,
  )(
    K, api.get, api.set, norm,
    (message, context = {}) => pauses.push({ message, context }),
    () => null, api.answerReturns, () => {}, api.dropAnswerReturn,
    api.markAnswerReturnResuming, api.resumeDeferredAnswerReturn,
    async () => { throw new Error('deferred return must not jump to Coordinator'); },
  );
  assert.equal(await makeStep()({ id: UUID.role }, live, false), true);
  assert.equal(state.get(K.expect).kind, 'dispatch', 'verified return restores the exact source result');
  assert.equal(state.get(K.expect).ref, UUID.dispatch);
  assert.equal(state.get(K.answerReturns).length, 0, 'receipt is consumed after safe restore');

  // Unverified sends stay queued and cannot clear or apply the deferred result.
  const pendingState = new Map();
  const pendingApi = makeReturnApi(pendingState, pauses);
  const pendingEvent = heldEvent('dispatch');
  pendingState.set(K.answerReturns, [pendingEvent]);
  const unverified = { ...live, sentAt: 0, verified: false };
  pendingState.set(K.expect, unverified);
  const pendingStep = new Function(
    'K', 'GM_getValue', 'GM_setValue', 'norm', 'pause', 'restoreMissingSendMark',
    'answerReturns', 'log', 'dropAnswerReturn', 'markAnswerReturnResuming',
    'resumeDeferredAnswerReturn', 'continueAfterAnswerReturn',
    `${stepBlock}\nreturn answerReturnStep;`,
  )(
    K, pendingApi.get, pendingApi.set, norm,
    (message, context = {}) => pauses.push({ message, context }),
    () => null, pendingApi.answerReturns, () => {}, pendingApi.dropAnswerReturn,
    pendingApi.markAnswerReturnResuming, pendingApi.resumeDeferredAnswerReturn,
    async () => true,
  );
  assert.equal(await pendingStep({ id: UUID.role }, unverified, false), false,
    'absence of a delivery proof keeps waiting without applying the source result');
  assert.equal(pendingState.get(K.expect), unverified);
  assert.deepEqual(pendingState.get(K.answerReturns), [pendingEvent]);
}

console.log('OK: D-105 — durable gate result, exact author routing, UUID/restart guards, verified return, report boundary');
