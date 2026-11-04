// Tool-call limit: полный транспорт продолжения на макете DOM/GM. Реальный
// PromptCompiler; detectToolCallLimit и continueToolLimitTurn — из исходников.
// Боевой цикл, Notion и Drive не используются: проверяется, что продолжение
// сохраняет IDs и терминальные поля, дедуплицируется, уважает лимит и паузы.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, UUID } from '../tests/helpers/prompt-env.mjs';

const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const src30 = read('30-tool-limit.js');
const vis = read('15-visible-errors.js');
const detSource = vis.slice(vis.indexOf('const TOOL_LIMIT_RE'), vis.indexOf('function latestUserMessageAlert'));

const LIMIT_TEXT = 'The agent reached the tool-call limit for this turn. Send a message to continue where it left off.';
const { TOOL_LIMIT_RE, realDetect } = (() => {
  // Детектор с макетом DOM: messages/visible/nodeId/textHash подменяются.
  const mk = (messages, vis, nid, th) =>
    new Function('messages', 'visible', 'nodeId', 'textHash', `${detSource}\nreturn { TOOL_LIMIT_RE, detectToolCallLimit };`)(messages, vis, nid, th);
  return { TOOL_LIMIT_RE: mk(() => [], () => true, () => '', () => '0').TOOL_LIMIT_RE, realDetect: mk };
})();

const norm = (s) => String(s || '').toLowerCase();
const textHash = (t) => { let h = 5381; for (let i = 0; i < t.length; i += 1) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return String(h); };

// Макет DOM для детектора.
const mkStatus = (text, { inCode = false, hidden = false } = {}) => ({
  innerText: text, textContent: text, closest: () => (inCode ? { match: true } : null), hidden,
});
const mkNode = (id, statuses = []) => ({ id: `chat-message-${id}`, querySelectorAll: () => statuses });
const nodeId = (n) => n.id.replace('chat-message-', '');
const visible = (el) => !el.hidden;
const detectFrom = (nodes) => realDetect(() => nodes, visible, nodeId, textHash).detectToolCallLimit();

// ── Детектор: распознавание и границы ────────────────────────────────────────
{
  const hit = detectFrom([mkNode('m1', [mkStatus(LIMIT_TEXT)])]);
  assert.ok(hit && hit.messageId === 'm1', 'amber role=status с tool-call limit распознаётся');
  assert.ok(detectFrom([mkNode('m2', [mkStatus('Агент достиг лимита инструментов')])]), 'русская формулировка');
  assert.equal(detectFrom([mkNode('m3', [mkStatus(LIMIT_TEXT, { inCode: true })])]), null, 'текст в pre/code/diff не ошибка');
  assert.equal(detectFrom([mkNode('m4', [mkStatus(LIMIT_TEXT, { hidden: true })])]), null, 'невидимый статус не ошибка');
  assert.equal(detectFrom([mkNode('m5', [mkStatus('The agent finished the task.')])]), null, 'обычный текст не ошибка');
  assert.equal(detectFrom([]), null, 'пустой транскрипт');
  // без id — хеш текста + позиция
  const noId = detectFrom([{ id: '', querySelectorAll: () => [mkStatus(LIMIT_TEXT)] }]);
  assert.ok(noId && /^h/.test(noId.messageId), 'без messageId — хеш текста+позиция');
}

// ── Транспорт: общая среда ───────────────────────────────────────────────────
function buildEnv({ expect = null, pilots = [] } = {}) {
  const store = new Map();
  if (expect) store.set('expect', expect);
  store.set('pilots', pilots);
  const pauses = [], journal = [], logs = [], delivered = [];
  const ctrl = {
    status: { messageId: 'limit-1', text: LIMIT_TEXT, index: 1 },
    repliesFn: () => [],
    working: false, pageRole: expect?.roleId || 'role-x',
    delivery: { ok: true, msgId: 'cont-msg-1' },
    composerOk: true, writeOk: true, pilotOnPage: true, lastWrite: '',
  };
  const deps = {
    GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
    GM_setValue: (k, v) => store.set(k, v),
    K: { expect: 'expect', pending: 'pending', pilotWait: 'pw:', pilots: 'pilots' },
    C: { toolLimitContinueMax: 2 },
    pause: (text, ctx) => pauses.push({ text, ...(ctx || {}) }),
    log: (text, err) => logs.push({ text, err }),
    dbg: () => {},
    norm,
    roleFromPath: () => ctrl.pageRole,
    messagesAfter: (wm, seen) => ctrl.repliesFn(wm, seen),
    stillWorking: () => ctrl.working,
    busySettled: async () => (ctrl.working ? { kind: 'stop' } : null),
    ensureComposer: async () => ({ editor: ctrl.composerOk ? {} : null }),
    composerText: () => '',
    clearComposer: () => {},
    writePrompt: (_e, text) => { ctrl.lastWrite = text; return ctrl.writeOk; },
    deliver: async (_e, text) => { delivered.push(text); return ctrl.delivery; },
    captchaPause: () => pauses.push({ captcha: true }),
    lastMessageId: () => 'last-msg',
    compileOrPause: (req, label) => { const r = PromptCompiler.compile(req); if (r.ok) return r; pauses.push({ compileError: r.error, label }); return null; },
    recordPromptAttempt: (env, meta) => journal.push({ profileId: env.profileId, chars: env.metrics?.chars, utf8Bytes: env.metrics?.utf8Bytes, ...meta }),
    PromptCompiler,
    detectToolCallLimit: () => ctrl.status,
    TOOL_LIMIT_RE,
    listPilots: () => store.get('pilots') || [],
    getPilot: (id) => (store.get('pilots') || []).find((p) => p.id === id) || null,
    pilotOnPage: () => ctrl.pilotOnPage,
  };
  const names = Object.keys(deps);
  const api = new Function(...names, `${src30}\nreturn { handleToolCallLimit, continueToolLimitTurn, continuePilotToolLimit, markerForExpect };`)(...names.map((n) => deps[n]));
  return { api, store, pauses, journal, logs, delivered, ctrl };
}

const baseExpect = (over = {}) => ({
  roleId: 'role-x', roleName: 'Kernel', roleUrl: '/agent/x', roleFn: 'Executor',
  kind: 'dispatch', ref: UUID.dispatch, runId: UUID.run, missionId: UUID.mission, turnId: UUID.turn,
  watermark: 'wm-0', seen: ['wm-0'], sentAt: Date.now() - 1000, verified: true,
  text: 'original task text', prompt: { profileId: 'executor.card', metrics: { chars: 3000, utf8Bytes: 3000 } },
  tries: 0, dispatchSentAt: 111, logId: 'log-1', pr: 'https://github.com/x/y/pull/7', ...over,
});

// ── dispatch: первое продолжение сохраняет IDs и терминальные поля ───────────
{
  const env = buildEnv({ expect: baseExpect() });
  const handled = await env.api.handleToolCallLimit();
  assert.equal(handled, true, 'tool-limit обработан продолжением');
  const e = env.store.get('expect');
  assert.equal(e.toolLimitContinuations, 1);
  assert.equal(e.lastToolLimitMessageId, 'limit-1');
  assert.ok(e.continuationWatermark, 'continuationWatermark сохранён');
  // IDs и терминальные поля прежние
  assert.equal(e.ref, UUID.dispatch); assert.equal(e.runId, UUID.run);
  assert.equal(e.missionId, UUID.mission); assert.equal(e.turnId, UUID.turn);
  assert.equal(e.dispatchSentAt, 111); assert.equal(e.logId, 'log-1'); assert.equal(e.pr, 'https://github.com/x/y/pull/7');
  assert.equal(e.watermark, 'wm-0', 'исходный watermark не сдвинут (журнал соберёт части до лимита)');
  // новый Run ID не создавался
  assert.equal(e.runId, UUID.run);
  // журнал
  const j = env.journal.find((x) => x.outcome === 'tool_limit_continued');
  assert.ok(j, 'исход tool_limit_continued в журнале');
  assert.equal(j.profileId, 'continuation.dispatch');
  assert.equal(j.errorClass, 'tool_call_limit');
  assert.equal(j.messageId, 'limit-1');
  assert.equal(j.attempt, 1);
  assert.ok(j.chars <= 700 && j.utf8Bytes > 0, 'размер continuation в журнале');
  // отправленный текст — continuation, не повтор задания
  const sent = env.delivered.at(-1);
  assert.ok(sent.includes(`dispatch_id=${UUID.dispatch}`) && sent.includes(`run_id=${UUID.run}`));
  assert.ok(sent.includes('CF_AGENT_RESULT'));
  assert.ok(!sent.includes('original task text'), 'не повторяет исходное задание');
  assert.ok(sent.length <= 750, 'continuation короткий');
  assert.equal(env.pauses.length, 0, 'первое продолжение без паузы');
}

// ── дедупликация: одно сообщение не даёт два продолжения ─────────────────────
{
  const env = buildEnv({ expect: baseExpect() });
  await env.api.handleToolCallLimit();
  const again = await env.api.handleToolCallLimit(); // тот же status.messageId
  assert.equal(again, false, 'повтор того же статусного сообщения не продолжает');
  assert.equal(env.store.get('expect').toolLimitContinuations, 1);
  assert.equal(env.journal.filter((x) => x.outcome === 'tool_limit_continued').length, 1);
}

// ── новое сообщение с новым id + прогресс → второе продолжение; затем пауза ──
{
  const env = buildEnv({ expect: baseExpect() });
  await env.api.handleToolCallLimit();
  // агент поработал после продолжения (содержательные сообщения)
  env.ctrl.repliesFn = (wm) => (wm === 'cont-msg-1' ? [{ id: 'a1', text: 'Продолжаю: сделал X.', raw: 'Продолжаю: сделал X.' }] : []);
  env.ctrl.status = { messageId: 'limit-2', text: LIMIT_TEXT, index: 2 };
  env.ctrl.delivery = { ok: true, msgId: 'cont-msg-2' };
  const second = await env.api.handleToolCallLimit();
  assert.equal(second, true);
  assert.equal(env.store.get('expect').toolLimitContinuations, 2);
  // третий лимит — предел исчерпан → пауза
  env.ctrl.repliesFn = (wm) => (wm === 'cont-msg-2' ? [{ id: 'a2', text: 'Ещё работа.', raw: 'Ещё работа.' }] : []);
  env.ctrl.status = { messageId: 'limit-3', text: LIMIT_TEXT, index: 3 };
  const third = await env.api.handleToolCallLimit();
  assert.equal(third, true);
  assert.ok(env.pauses.some((p) => p.kind === 'tool-limit'), 'после исчерпания лимита — пауза');
  assert.ok(env.journal.some((x) => x.outcome === 'tool_limit_paused'), 'исход tool_limit_paused');
  assert.equal(env.store.get('expect').toolLimitContinuations, 2, 'третье продолжение не отправлено');
}

// ── нет прогресса после продолжения → пауза раньше лимита ────────────────────
{
  const env = buildEnv({ expect: baseExpect() });
  await env.api.handleToolCallLimit();
  env.ctrl.repliesFn = () => []; // только повторный лимит, без содержательных сообщений
  env.ctrl.status = { messageId: 'limit-2', text: LIMIT_TEXT, index: 2 };
  const handled = await env.api.handleToolCallLimit();
  assert.equal(handled, true);
  assert.ok(env.journal.some((x) => x.outcome === 'tool_limit_no_progress'), 'исход tool_limit_no_progress');
  assert.ok(env.pauses.some((p) => p.kind === 'tool-limit'));
  assert.equal(env.store.get('expect').toolLimitContinuations, 1, 'второе продолжение не отправлено без прогресса');
}

// ── plan: mission/turn IDs, не становится dispatch ───────────────────────────
{
  const env = buildEnv({ expect: baseExpect({ kind: 'plan', roleFn: 'Coordinator', roleName: 'Coordinator', ref: UUID.mission }) });
  await env.api.handleToolCallLimit();
  const e = env.store.get('expect');
  const sent = env.delivered.at(-1);
  assert.equal(e.kind, 'plan', 'ход остался plan');
  assert.ok(sent.includes(`mission_id=${UUID.mission}`) && sent.includes(`turn_id=${UUID.turn}`));
  assert.ok(sent.includes('CF_COORDINATOR_RESULT'));
  assert.ok(!sent.includes('CF_AGENT_RESULT'), 'plan не становится dispatch');
  assert.ok(!/gh pr merge|git commit|git push/.test(sent), 'plan не трогает git');
  assert.equal(env.journal.find((x) => x.outcome === 'tool_limit_continued').profileId, 'continuation.plan');
}

// ── review: mission/turn IDs ─────────────────────────────────────────────────
{
  const env = buildEnv({ expect: baseExpect({ kind: 'review', roleFn: 'Reviewer', roleName: 'Warden', ref: UUID.mission }) });
  await env.api.handleToolCallLimit();
  const sent = env.delivered.at(-1);
  assert.ok(sent.includes(`mission_id=${UUID.mission}`) && sent.includes(`turn_id=${UUID.turn}`));
  assert.ok(sent.includes('CF_REVIEW_RESULT'));
  assert.equal(env.journal.find((x) => x.outcome === 'tool_limit_continued').profileId, 'continuation.review');
}

// ── answer: question/turn IDs + masterEscalated сохранён ─────────────────────
{
  const env = buildEnv({ expect: baseExpect({ kind: 'answer', roleFn: 'Reviewer', roleName: 'Warden', ref: UUID.question, masterEscalated: true }) });
  await env.api.handleToolCallLimit();
  const e = env.store.get('expect');
  const sent = env.delivered.at(-1);
  assert.ok(sent.includes(`question_id=${UUID.question}`) && sent.includes(`turn_id=${UUID.turn}`));
  assert.ok(sent.includes('CF_ANSWER_RESULT'));
  assert.equal(e.masterEscalated, true, 'masterEscalated сохранён');
  assert.equal(e.ref, UUID.question);
  assert.equal(env.journal.find((x) => x.outcome === 'tool_limit_continued').profileId, 'continuation.answer');
}

// ── Auditor continuation: без git-write ──────────────────────────────────────
{
  const env = buildEnv({ expect: baseExpect({ roleFn: 'Auditor', roleName: 'Auditor Core' }) });
  await env.api.handleToolCallLimit();
  const sent = env.delivered.at(-1);
  assert.ok(/Только чтение и проверка/.test(sent));
  assert.ok(!/gh pr merge|git commit|git push/.test(sent), 'Auditor continuation без git-write');
}

// ── Guard: не та страница / агент работает / нет доставки / маркер уже есть ─────
{
  const wrongPage = buildEnv({ expect: baseExpect() });
  wrongPage.ctrl.pageRole = 'another-role';
  assert.equal(await wrongPage.api.handleToolCallLimit(), false, 'не та страница — не продолжаем');
  assert.equal(wrongPage.delivered.length, 0);

  const working = buildEnv({ expect: baseExpect() });
  working.ctrl.working = true;
  assert.equal(await working.api.handleToolCallLimit(), false, 'агент генерирует — ждём');
  assert.equal(working.delivered.length, 0);

  const unverified = buildEnv({ expect: baseExpect({ sentAt: 0, verified: false }) });
  assert.equal(await unverified.api.handleToolCallLimit(), false, 'доставка не подтверждена и ход не начался');

  const marked = buildEnv({ expect: baseExpect() });
  marked.ctrl.repliesFn = () => [{ id: 'a1', text: 'done', raw: `CF_AGENT_RESULT {"dispatch_id":"${UUID.dispatch}","run_id":"${UUID.run}"}` }];
  assert.equal(await marked.api.handleToolCallLimit(), false, 'ход завершён маркером — статус лимита игнорируем');
  assert.equal(marked.delivered.length, 0);
}

// ── провал отправки continuation → пауза, карточка не откатывается ───────────
{
  const env = buildEnv({ expect: baseExpect() });
  env.ctrl.delivery = { ok: false, reason: 'Send недоступен' };
  const handled = await env.api.handleToolCallLimit();
  assert.equal(handled, true);
  assert.ok(env.pauses.some((p) => p.kind === 'tool-limit'), 'провал отправки — пауза');
  assert.ok(env.journal.some((x) => x.outcome === 'tool_limit_paused'));
  const e = env.store.get('expect');
  assert.equal(e.runId, UUID.run, 'Run ID не изменился');
  assert.equal(e.cardRolled, undefined, 'карточка не откатывалась в Ready');
}

// ── Reviewer рабочая карточка: продолжение не шаблонизировано → Мастер ───────
{
  const env = buildEnv({ expect: baseExpect({ roleFn: 'Reviewer', roleName: 'Warden' }) });
  const handled = await env.api.handleToolCallLimit();
  assert.equal(handled, true);
  assert.ok(env.pauses.some((p) => p.kind === 'tool-limit'));
  assert.equal(env.delivered.length, 0, 'рабочая выдача Reviewer не отправляется');
}

// ── pilot continuation: без CF_* и внутренних ссылок, свой namespace ─────────
{
  const pilot = { id: 'pilot-1', variant: 'A', url: 'https://arena.ai/pilot' };
  const wait = { id: 'pilot-1', url: 'https://arena.ai/pilot', sentAt: Date.now() - 1000, watermark: 'pwm-0', status: 'running', prompt: { profileId: 'pilot.synapse', metrics: { chars: 200, utf8Bytes: 200 } } };
  const env = buildEnv({ pilots: [pilot] });
  env.store.set('pw:pilot-1', wait);
  const handled = await env.api.handleToolCallLimit();
  assert.equal(handled, true, 'пилотный tool-limit обработан');
  const w = env.store.get('pw:pilot-1');
  assert.equal(w.toolLimitContinuations, 1);
  const sent = env.delivered.at(-1);
  assert.ok(!/CF_/.test(sent), 'pilot continuation без CF_*');
  assert.ok(!/notion|cortex|REGULATION|WARDEN|DECISIONS|synapse-cortex/i.test(sent), 'pilot без внутренних ссылок');
  const j = env.journal.find((x) => x.outcome === 'tool_limit_continued');
  assert.equal(j.profileId, 'continuation.pilot');
  assert.equal(j.kind, 'pilot');
  // командное ожидание не тронуто
  assert.equal(env.store.get('expect'), undefined);
}

console.log('OK: tool-limit continuation integration — детектор, дедупликация, лимит/прогресс/паузы, IDs dispatch/plan/review/answer, masterEscalated, Auditor read-only, pilot изоляция, карточка не откатывается');
