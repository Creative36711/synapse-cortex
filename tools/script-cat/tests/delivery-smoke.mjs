// Доставка: классификация отказов, стратегия full→compact→pause, журнал попытки
// и компактный повтор того же хода. Чистые функции берутся из src/.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { PromptCompiler, dispatchRequest, planRequest } from './helpers/prompt-env.mjs';

const src20 = readFileSync(new URL('../src/20-technical-context.js', import.meta.url), 'utf8');
const from = src20.indexOf('  function classifyArenaFailure(');
const to = src20.indexOf('  /** Записать исход доставки');
assert.ok(from > 0 && to > from, 'classifyArenaFailure на месте');
const { classifyArenaFailure } = new Function(`${src20.slice(from, to)}\nreturn { classifyArenaFailure };`)();

// 1. Классы отказов различаются и не сваливаются в unknown.
const cases = [
  ['Security Verification: подтвердите, что вы человек', 'captcha'],
  ['Please sign in to continue (401 unauthorized)', 'auth'],
  ['Agent is unavailable right now', 'agent_unavailable'],
  ['Too many requests — rate limit (429)', 'rate_limit'],
  ['Something went wrong. Please try again.', 'arena_generic_error'],
  ['Send button is disabled', 'send_disabled'],
  ['Не нашёл поле ввода на странице', 'editor_not_found'],
  ['Network error: failed to fetch', 'network'],
  ['budget exceeded: лимит превышен', 'budget_exceeded'],
  ['какая-то непонятная ошибка', 'unknown'],
];
for (const [text, want] of cases) assert.equal(classifyArenaFailure(text), want, text);

// 2. Стратегия доставки: мягкий/жёсткий лимиты, без молчаливой резки оракула.
{
  const full = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 6000, hardLimit: 9000 });
  assert.equal(full.strategy, 'full');
  assert.ok(full.envelope.metrics.chars <= 6000);
  // Мягкий лимит ниже полного, но жёсткий вмещает → compact (тот же смысл).
  const mid = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 100, hardLimit: 9000 });
  assert.ok(['compact', 'payload', 'full'].includes(mid.strategy));
  // Жёсткий лимит крошечный → пауза, а не обрезанный оракул.
  const pause = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 10, hardLimit: 20 });
  assert.equal(pause.strategy, 'pause');
  assert.ok(pause.error.code, 'пауза несёт типизированную причину');
}

// 2b. D-034: большое задание → payload-указатель, а не инлайн и не пауза.
{
  const ref = { fileId: 'PAYLOAD_FILE_1', url: 'https://drive.google.com/file/d/PAYLOAD_FILE_1/view' };
  const big = dispatchRequest('Auditor', { task: { ...dispatchRequest('Auditor').task, payload: 'подробное задание '.repeat(400), payloadRef: ref } });
  // inline не влезает в жёсткий лимит, указатель — влезает
  const d = PromptCompiler.forDelivery(big, { softLimit: 3000, hardLimit: 5500, payloadChannel: true });
  assert.equal(d.strategy, 'payload', 'большое задание уходит указателем');
  assert.ok(d.envelope.text.includes('PAYLOAD_FILE_1'), 'указатель несёт ID файла');
  assert.ok(!d.envelope.text.includes('подробное задание'.repeat(5)), 'тело задания не инлайнится');
  assert.ok(d.envelope.text.includes('Оракул (как принимают)'), 'оракул остаётся inline');
  assert.ok(d.envelope.metrics.chars <= 5500, 'указатель в лимите');
  // без канала payload — пауза, а не молчаливая обрезка
  const noChannel = PromptCompiler.forDelivery(big, { softLimit: 3000, hardLimit: 5500, payloadChannel: false });
  assert.equal(noChannel.strategy, 'pause');
  // малое задание остаётся инлайном (full)
  const small = dispatchRequest('Auditor', { task: { ...dispatchRequest('Auditor').task, payload: 'короткое задание', payloadRef: ref } });
  const s = PromptCompiler.forDelivery(small, { softLimit: 6000, hardLimit: 5500, payloadChannel: true });
  assert.equal(s.strategy, 'full');
  assert.ok(s.envelope.text.includes('короткое задание'));
}

// 3. Compact/recovery сохраняют маркер и ID того же хода (повтор ≠ новый ход).
{
  const rec = PromptCompiler.compile(planRequest({ delivery: { tier: 'recovery' } }));
  assert.ok(rec.ok);
  assert.equal(rec.marker, 'CF_COORDINATOR_RESULT');
  assert.ok(rec.text.includes('7f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'), 'turn_id сохранён');
  const compact = PromptCompiler.compile(dispatchRequest('Executor', { delivery: { tier: 'compact' } }));
  assert.ok(compact.ok && compact.marker === 'CF_AGENT_RESULT');
}

// 4. Журнал попытки пишется кольцом и не содержит секретов.
{
  const store = new Map();
  const GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  const GM_setValue = (k, v) => store.set(k, v);
  const nowIso = () => '2026-11-04T00:00:00.000Z';
  const dbg = () => {};
  const recFrom = src20.indexOf('  function recordPromptAttempt(');
  const recTo = src20.indexOf('  /** Классификация отказа');
  const { recordPromptAttempt } = new Function('GM_getValue', 'GM_setValue', 'nowIso', 'dbg',
    `${src20.slice(recFrom, recTo)}\nreturn { recordPromptAttempt };`)(GM_getValue, GM_setValue, nowIso, dbg);
  const env = PromptCompiler.compile(dispatchRequest('Executor'));
  for (let i = 0; i < 250; i++) recordPromptAttempt(env, { kind: 'dispatch', ref: 'd', role: 'Kernel', outcome: 'delivered' });
  const list = GM_getValue('cfn-prompt-journal-v1', []);
  assert.equal(list.length, 200, 'кольцо на 200 записей');
  const row = list.at(-1);
  assert.equal(row.profileId, 'executor.card');
  assert.ok(row.chars > 0 && row.overhead > 0 && row.hash);
  assert.ok(!JSON.stringify(row).includes('token'), 'без секретов');
}

console.log('OK: delivery — классы отказов, full→compact→pause, журнал-кольцо, повтор того же хода');
