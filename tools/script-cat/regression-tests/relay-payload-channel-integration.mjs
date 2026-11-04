// D-034: канал payloads в боевой выдаче. Проверяем поведение dispatchTask +
// реального executorPrompt (не заглушку): большое задание фиксируется снимком
// через savePayload и уходит указателем (оракул/Scope inline), малое задание
// остаётся инлайном, отказ шлюза — явная ошибка, а не тихий инлайн.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler } from '../tests/helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const dFrom = src.indexOf('  async function dispatchTask(');
const dTo = src.indexOf('  // ───────────────────────────── цикл', dFrom);
assert.ok(dFrom > 0 && dTo > dFrom, 'dispatchTask на месте');
const pFrom = src.indexOf('  const taskFacts =');
const pTo = src.indexOf('  /** Ссылка на журнал последнего ответа', pFrom);
assert.ok(pFrom > 0 && pTo > pFrom, 'executorPrompt/taskFacts на месте');

const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const taskTitle = (t) => rt(t.properties['Запрос']);
const promptRole = (role) => ({ id: role?.id || '', name: role?.name || '', fn: role?.fn || '', repo: role?.repo || '', zone: role?.zone || '', gate: role?.gate || '' });
const promptTarget = (ctx = {}) => ({ repo: ctx.repo || '', baseBranch: ctx.branch || 'main', startSha: '' });
const budgetBreakdownLine = () => '';

function makeExecutorPrompt(pauses) {
  return new Function('rt', 'taskTitle', 'promptRole', 'promptTarget', 'PromptCompiler', 'pause', 'budgetBreakdownLine',
    `${src.slice(pFrom, pTo)}\nreturn executorPrompt;`)(
    rt, taskTitle, promptRole, promptTarget, PromptCompiler,
    (text) => pauses.push(text), budgetBreakdownLine);
}

function makeHarness({ payloadId = '', fileText = '', saveFails = false } = {}) {
  const calls = [];
  const pauses = [];
  const store = {};
  const card = {
    id: 'card-1',
    properties: {
      'Запрос': { title: [{ plain_text: 'SYN-1 · K-17 · Аудит' }] },
      'Намерение': { rich_text: [{ plain_text: 'Проверить O-4.' }] },
      'Acceptance': { rich_text: [{ plain_text: 'grep -c отчёт = 1' }] },
      'Scope': { rich_text: [{ plain_text: 'docs/agents/**' }] },
      'Кому': { select: { name: 'Spec Auditor' } },
      'Payload Drive File ID': { rich_text: payloadId ? [{ plain_text: payloadId }] : [] },
      'Dispatch State': { select: { name: 'Ready' } },
      'Check': { select: null },
    },
  };
  const executorPrompt = makeExecutorPrompt(pauses);
  const dispatchTask = new Function(
    'roles', 'roleRows', 'norm', 'rt', 'gateway', 'patch', 'taskLogEntry', 'executorPrompt',
    'log', 'taskTitle', 'uid', 'nowIso', 'sendToRole',
    'notion', 'taskState', 'taskRole', 'taskTargetRepository', 'reworkSeen', 'C', 'ACTIVE_PROFILE', 'GM_getValue', 'GM_setValue', 'pause', 'K',
    'profileSessionRepo', 'canonicalTargetRepository', 'profileRepoBranch',
    'redispatchClearProps', 'redispatchWhy', 'noteRedispatch', 'REDISPATCH_LIMIT',
    'answerStampKey', 'reworkKey', 'taskPreflight',
    `${src.slice(dFrom, dTo)}; return dispatchTask;`,
  )(
    async () => [{ id: 'agent-1', name: 'Spec Auditor', fn: 'Auditor', zone: 'docs/agents/**' }],
    async () => [{ id: 'agent-1', name: 'Spec Auditor', fn: 'Auditor', status: 'Активна', url: '/agent/agent-1', zone: 'docs/agents/**' }],
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    rt,
    async (action, fileId, extra = {}) => {
      calls.push({ action, fileId, name: extra.name, entry: extra.entry });
      if (action === 'read') return { ok: true, content: fileText };
      if (action === 'createLog') return { ok: true, fileId: 'LOG1' };
      if (action === 'savePayload') {
        if (saveFails) throw new Error('шлюз Drive отказал: нет доступа');
        return { ok: true, fileId: 'SAVED_PAYLOAD', name: extra.name };
      }
      return { ok: true, result: 'appended' };
    },
    async (id, props) => calls.push({ action: 'patch', id, props }),
    (task, role, payload) => `LOG[${String(payload).slice(0, 40)}]`,
    executorPrompt,
    (text, error) => calls.push({ action: 'log', text, error }),
    taskTitle,
    () => 'run-1',
    () => '2026-11-04T21:10:00.000Z',
    async (role, prompt, kind, ref) => {
      calls.push({ action: 'send', prompt, kind, ref });
      return prompt != null;
    },
    async () => card,
    (page) => page?.properties?.['Dispatch State']?.select?.name || '',
    (page) => page?.properties?.['Кому']?.select?.name || '',
    (page, fallback) => fallback,
    () => true,
    { repo: 'Creative36711/synapse-cortex', branch: 'arena/87031a47-synapse-cortex', payloadInlineMax: 1500 },
    { legacy: true, repo: 'Creative36711/synapse-cortex', branch: 'main' },
    (key, fallback) => store[key] ?? fallback,
    (key, value) => { store[key] = value; },
    (text) => pauses.push(text),
    { pending: 'cfn-pending', expect: 'cfn-expect' },
    () => 'Creative36711/synapse-cortex',
    (value, fallback) => String(value || fallback || '').trim(),
    () => 'main',
    () => null,
    () => '',
    () => 1,
    3,
    (id) => `cfn-answer-stamp:${id}`,
    (id) => `cfn-rework:${id}`,
    async () => '',
  );
  return { dispatchTask, card, calls, pauses };
}

const sentPrompt = (h) => h.calls.find((c) => c.action === 'send')?.prompt;

// ── 1. Большое задание → снимок savePayload + указатель, оракул inline ─────
{
  const body = 'РАЗВЁРНУТОЕ ЗАДАНИЕ ИЗ PAYLOAD. '.repeat(200); // ~6400 символов
  const h = makeHarness({ payloadId: 'PAYLOAD_FILE_1', fileText: body });
  const sent = await h.dispatchTask(h.card, 'Spec Auditor');
  assert.equal(sent, true, 'ход выдан');
  const save = h.calls.find((c) => c.action === 'savePayload');
  assert.ok(save, 'большое задание материализовано через savePayload');
  assert.match(save.name, /^card-1_run-1__assignment\.md$/, 'имя снимка — dispatch_run__assignment.md');
  const p = sentPrompt(h);
  assert.ok(p && typeof p === 'object' && typeof p.text === 'string', 'ушёл envelope компилятора');
  assert.ok(p.text.includes('SAVED_PAYLOAD'), 'указатель ведёт на снимок прогона');
  assert.ok(p.text.includes('прочитай его до работы'), 'агенту сказано прочитать файл');
  assert.ok(!p.text.includes('РАЗВЁРНУТОЕ ЗАДАНИЕ ИЗ PAYLOAD.'.repeat(3)), 'тело задания не инлайнится');
  assert.ok(p.text.includes('Оракул (как принимают)'), 'оракул остаётся inline');
  assert.ok(p.text.includes('Scope'), 'Scope остаётся inline');
  assert.ok(p.metrics.chars <= 5500, 'указатель в total-лимите Аудитора');
  assert.ok(h.calls.some((c) => c.action === 'read' && c.fileId === 'PAYLOAD_FILE_1'), 'исходный файл прочитан');
}

// ── 2. Отказ savePayload — явная ошибка, ход не уходит ────────────────────
{
  const body = 'БОЛЬШОЕ ЗАДАНИЕ. '.repeat(200);
  const h = makeHarness({ payloadId: 'PAYLOAD_FILE_1', fileText: body, saveFails: true });
  await assert.rejects(() => h.dispatchTask(h.card, 'Spec Auditor'), /savePayload|шлюз Drive отказал/, 'отказ шлюза останавливает выдачу');
  assert.ok(!h.calls.some((c) => c.action === 'send'), 'исполнителю ничего не ушло');
}

// ── 3. Малое задание остаётся инлайном (full), снимок не создаётся ─────────
{
  const h = makeHarness({ payloadId: 'PAYLOAD_SMALL', fileText: 'короткое задание' });
  const sent = await h.dispatchTask(h.card, 'Spec Auditor');
  assert.equal(sent, true);
  const p = sentPrompt(h);
  assert.ok(p.text.includes('короткое задание'), 'малое задание инлайнится');
  assert.ok(!p.text.includes('прочитай его до работы'), 'указателя нет');
  assert.ok(!h.calls.some((c) => c.action === 'savePayload'), 'малое задание не материализуется');
}

// ── 4. Без файла — карточка и есть задание, шлюз записи не дёргается ───────
{
  const h = makeHarness();
  const sent = await h.dispatchTask(h.card, 'Spec Auditor');
  assert.equal(sent, true);
  const p = sentPrompt(h);
  assert.ok(p.text.includes('карточка и есть задание'), 'задание собрано из карточки');
  assert.ok(!h.calls.some((c) => c.action === 'savePayload'), 'savePayload не вызывается');
}

console.log('OK: D-034 payload-канал — большое задание снимком+указателем (оракул inline), малое инлайном, отказ шлюза явный');
