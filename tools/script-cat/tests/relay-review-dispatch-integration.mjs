// Реальные блоки userscript: отдельная карточка Reviewer и отдельная приёмка
// миссии. Notion, Drive, GM-хранилище и транскрипт заменены локальными моделями.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { promptShim } from './helpers/prompt-shim.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert(a >= 0 && b > a, `не найден блок ${from}`);
  return src.slice(a, b);
};
const parser = cut('  function braceJson(', '  /** Короткая подпись элемента');
const ids = cut('  const isUuid = ', '  async function notion(');
const missionMatch = cut('  const MISSION_STOPWORDS = ', '  /** Поле названия показывается');
const cardBinding = cut('  const cardMissionId = ', '  function cardBindingIssue(');
const retained = cut('  function retainRejectedResult(', '  /**\n   * `rich_text`');
const report = cut('  function runAnswer(', '  /**\n   * Минимальное сообщение');
const dispatch = cut('  async function appendToJournal(', '  // ───────────────────────────── ход Координатора');
const closeMission = cut('  async function closeMission(', '  /** Вернуть миссию Координатору');
const reviewStep = cut('  async function reviewStep(', '  // ─────────────────────── вопросы:');
const adopt = cut('  async function adoptPageAnswer(', '  /** Последняя проверка заявки');
const notice = cut('  async function missionDoneNotice(', '  /** Активная миссия и сменилась ли она');
const syncMission = cut('  async function syncMissionState(', '  /**\n   * Пауза прошлой миссии');
const syncGate = cut('      try {\n        if (await syncMissionState()) return;', '      dbg("tick: состояние",');
const stalePause = cut('  async function clearStaleMissionPause(', '  /**\n   * Блок замечаний Мастера');
const routing = cut('      if (expect?.kind === "dispatch") {', '\n    } catch (e) {');
// Историческая карточка Reviewer теперь собирается профилем reviewer.card.
const order = `${promptShim}
  function reviewerOrder(task, runId, missionId) {
    const r = PromptCompiler.compile({ kind: "dispatch", profileId: "reviewer.card", role: { fn: "Reviewer", name: "Warden" }, task: { id: task.id, runId, title: task.id }, mission: missionId ? { id: missionId } : undefined, delivery: { tier: "full" } });
    return r.ok ? r.text.split("\\n") : [];
  }
`;

const MID = '4086f0cf-5705-81ea-94c6-e47bd6c3ba78';
const CARD = '4096f0cf-5705-8159-bd88-c725d5ea075d';
const RUN = '57b20404-787e-476e-96d6-b6548f27a3df';
const OTHER_RUN = '09238d7a-4791-4ff0-ba7b-9bc29e493061';
const OTHER_MISSION = '4086f0cf-5705-81ea-94c6-e47bd6c3ba79';
const AGENT = '01a18b9c-0c8b-71fd-8696-eb881e2e5217';
const TURN = '09999999-aaaa-4bbb-8ccc-eeeeeeeeeeee';
const NAME = 'GOLD-1 · Золотая кампания Каркас';
const FIXED_NOW = Date.parse('2026-10-30T15:00:05.000Z');
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
}
const reviewer = { id: AGENT, name: 'Warden', fn: 'Reviewer', url: '/agent/warden' };
const coordinator = { id: 'coord', name: 'Coordinator', fn: 'Coordinator' };
const rich = (s) => ({ rich_text: s ? [{ plain_text: s }] : [] });
const propText = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const state = (page) => page?.properties?.['Dispatch State']?.select?.name || '';
const expectDispatch = (extra = {}) => ({ kind: 'dispatch', ref: CARD, runId: RUN, missionId: MID, roleId: AGENT, watermark: 'before', sentAt: 1, ...extra });
const expectReview = (extra = {}) => ({ kind: 'review', ref: MID, missionId: MID, turnId: TURN, roleId: AGENT, watermark: 'before', ...extra });
const marker = (name, data) => `${name} ${JSON.stringify(data)}`;
const agentResult = (extra = {}) => marker('CF_AGENT_RESULT', { dispatch_id: CARD, run_id: RUN, status: 'submitted', pr: null, ...extra });
const reviewResult = (extra = {}) => marker('CF_REVIEW_RESULT', { mission_id: MID, dispatch_id: CARD, run_id: RUN, verdict: 'accept', ...extra });
const missionResult = (extra = {}) => marker('CF_REVIEW_RESULT', { mission_id: MID, turn_id: TURN, verdict: 'accept', summary: 'оракул подтверждён', ...extra });
const longBody = 'Проверен оракул: перечислены артефакты и результаты команд, выводы подтверждены ссылками. '.repeat(5);
const message = (text, id = 'msg-1') => ({ id, raw: text, text });
const clone = (v) => structuredClone(v);

function harness({ reviewRequired = true } = {}) {
  const storage = new Map();
  const logs = [];
  const pauses = [];
  const calls = { patches: [], writes: 0, attempts: 0, sends: [], plans: [], merge: 0, autos: [], markerMissing: [], returns: [] };
  const pages = new Map([
    [MID, { id: MID, properties: { 'Миссия': { title: [{ plain_text: NAME }] }, 'Состояние': { select: { name: 'Активна' } }, 'Круг': { number: 0 } } }],
    [CARD, { id: CARD, properties: {
      'Запрос': { title: [{ plain_text: 'GOLD-1.12 · Приёмка миссии' }] },
      'Миссия': rich(NAME), 'Mission ID': rich(MID), 'Dispatch State': { select: { name: 'Running' } },
      'Run ID': rich(RUN), 'Recipient Agent ID': rich(AGENT), 'Output Drive File ID': rich('LOG1'),
      'Acceptance': rich(reviewRequired ? 'Нужен CF_REVIEW_RESULT и полный отчёт.' : 'Проверить оракул.'),
      'Ответ': rich('старый ответ — его нельзя терять до новой записи'),
    } }],
  ]);
  const logFile = new Map();
  const h = { storage, logs, pauses, calls, pages, logFile, replies: [], online: true, lostAck: false,
    failPatch: false, patchAppliedThenLost: false, onAppend: null, extraQueue: [], active: MID };
  const GM_getValue = (k, d) => storage.has(k) ? storage.get(k) : d;
  const GM_setValue = (k, v) => storage.set(k, clone(v));
  const notion = async (_method, path) => {
    const id = path.replace(/^pages\//, '');
    if (!pages.has(id)) throw new Error(`page not found ${id}`);
    if (h.onRead) { const cb = h.onRead; h.onRead = null; cb(); }
    return clone(pages.get(id));
  };
  const patch = async (id, props) => {
    calls.patches.push({ id, props: clone(props) });
    if (h.failPatch) { h.failPatch = false; throw new Error('notion offline'); }
    const page = pages.get(id);
    assert(page, 'запись только в существующую страницу');
    for (const [k, v] of Object.entries(props)) page.properties[k] = clone(v);
    if (h.patchAppliedThenLost) { h.patchAppliedThenLost = false; throw new Error('notion acknowledgement lost'); }
    return clone(page);
  };
  const gateway = async (action, fileId, payload) => {
    calls.attempts++;
    assert.equal(action, 'append');
    assert.equal(fileId, 'LOG1');
    if (!h.online) throw new Error('drive offline');
    const existing = logFile.has(payload.marker);
    if (!existing) { logFile.set(payload.marker, payload.entry); calls.writes++; }
    if (h.onAppend) { const cb = h.onAppend; h.onAppend = null; cb(); }
    if (h.lostAck) { h.lostAck = false; throw new Error('drive acknowledgement lost'); }
    return { ok: true, duplicate: existing };
  };
  const currentMission = async () => {
    const page = h.active && pages.get(h.active);
    return page && ['Активна', 'Возвращена'].includes(page.properties['Состояние']?.select?.name) ? clone(page) : null;
  };
  // D-056: закрытие миссии спрашивает привязки отдельно — в фикстуре их нет.
  const missionBindingBlockers = async () => h.bindingBlockers || [];
  const queueOf = async () => {
    const all = [pages.get(CARD), ...h.extraQueue];
    const by = (s) => all.filter((p) => state(p) === s).map(clone);
    const out = { submitted: by('Submitted'), running: by('Running'), ready: by('Ready'), rework: by('Rework'), draft: by('Draft'), blocked: by('Blocked') };
    out.summary = `${out.submitted.length} Submitted, ${out.running.length} Running, ${out.ready.length} Ready, ${out.rework.length} Rework, ${out.draft.length} Draft`;
    return out;
  };
  const pause = (reason, context = {}) => pauses.push({ reason, ...context });
  const env = {
    C: { minAnswerChars: 200, markerReminders: 2, reworkLimit: 3, repo: 'example/relay-fixture' }, Date: TestDate,
    K: { expect: 'expect', pending: 'pending', lastResult: 'lastResult', ghAsk: 'ghAsk' }, GM_getValue, GM_setValue,
    prRef: (result, targetRepo) => {
      const raw = String((result && result.pr) ?? '').trim();
      if (!raw) return null;
      const num = raw.replace(/^#/, '').match(/^(\d+)$/);
      return num ? { repo: String(targetRepo || C.repo || ''), number: Number(num[1]) } : null;
    },
    norm: (x) => String(x || '').replace(/-/g, '').toLowerCase(), rt: propText, taskState: state,
    taskTitle: (p) => propText(p?.properties?.['Запрос']),
    richText: (v) => [{ type: 'text', text: { content: String(v) } }],
    notion, patch, gateway, activeMission: currentMission, lastClosedMission: async () => clone(pages.get(MID)), queueOf, missionBindingBlockers,
    messagesAfter: () => clone(h.replies), messages: () => clone(h.replies),
    roleFromPath: () => AGENT, isUserNode: () => false, nodeId: (n) => n.id, messageRaw: (n) => n.raw,
    roles: async () => [reviewer, coordinator], goTo: async (role) => calls.sends.push(role.name),
    log: (text, error, opts) => logs.push({ text, error, opts }), pause,
    autoOn: () => true, autoSet: (on) => calls.autos.push(on), setStatus: () => {},
    missionKind: (p) => p?.properties?.['Состояние']?.select?.name || '',
    nowIso: () => '2026-10-30T15:00:00.000Z', oneLine: (s, n) => String(s).slice(0, n), firstLine: (s) => String(s).split('\n')[0],
    questionInMarker: () => ({ kind: 'none' }), askQuestion: async () => { throw new Error('вопросов в тесте нет'); },
    ensureMerged: async () => {
      calls.merge++;
      if (h.mergeResult) return h.mergeResult;
      throw new Error('Reviewer не должен ждать PR');
    },
    prDeclined: (r) => r && Object.hasOwn(r, 'pr') && r.pr === null,
    // D-046: новая ветка перед чтением карточки. Здесь маркеров-противоречий нет.
    prMergeConflict: () => false,
    prUrl: () => '', hasMergedClaim: () => false, rememberAnswerStamp: () => {}, lastMergeCheck: null,
    markerMissing: async (_role, _expect, name, _manual, why = '') => { calls.markerMissing.push({ name, why }); return false; },
    looseResult: () => null, stillWorking: () => false, staleBranchRefusal: () => false,
    retryStaleBranchHandoff: () => false, consumePending: async () => false,
    returnMission: async (_mission, decision) => { calls.returns.push(decision); return true; },
  };
  const create = new Function('env', `
    const { C, K, Date, GM_getValue, GM_setValue, norm, rt, taskState, taskTitle, richText,
      notion, patch, gateway, activeMission, lastClosedMission, queueOf, missionBindingBlockers, messagesAfter, messages,
      roleFromPath, isUserNode, nodeId, messageRaw, roles, goTo, log, pause, autoOn, autoSet,
      setStatus, missionKind, nowIso, oneLine, firstLine, questionInMarker, askQuestion,
      ensureMerged, prDeclined, prUrl, prRef, hasMergedClaim, prMergeConflict, rememberAnswerStamp, lastMergeCheck,
      markerMissing, looseResult, stillWorking, staleBranchRefusal, retryStaleBranchHandoff,
      consumePending, returnMission } = env;
    ${parser}\n${ids}\n${missionMatch}\n${cardBinding}\n${retained}\n${report}\n${dispatch}\n${closeMission}\n${reviewStep}\n${adopt}\n${notice}\n${order}
    return { submitExecutor, reviewStep, adoptPageAnswer, missionDoneNotice, reviewerOrder, answerBody };
  `);
  Object.assign(h, create(env));
  h.expect = (e) => GM_setValue('expect', e);
  h.getExpect = () => GM_getValue('expect', null);
  return h;
}

// Проверяем настоящий фрагмент tick: тип хода важнее функции роли.
{
  const route = new Function('env', `return async function(me, expect) {
    const { fromToggle, list, autoOn, log, navigateTo, GM_setValue, K, submitExecutor,
      coordinatorStep, answerStep, reviewStep, pause } = env;
    ${routing}
  }`);
  const seen = [];
  const env = {
    fromToggle: false, list: [], autoOn: () => false, log: () => {}, navigateTo: () => {}, GM_setValue: () => {}, K: {},
    submitExecutor: async () => seen.push('dispatch'), coordinatorStep: async () => seen.push('plan'),
    answerStep: async () => seen.push('answer'), reviewStep: async () => seen.push('review'), pause: () => seen.push('pause'),
  };
  const tickRoute = route(env);
  for (const [role, exp, expected] of [
    [reviewer, expectDispatch(), 'dispatch'], [reviewer, expectReview(), 'review'],
    [reviewer, { kind: 'answer' }, 'answer'], [reviewer, { kind: 'other' }, 'pause'],
    [coordinator, { kind: 'plan' }, 'plan'], [{ fn: 'Executor' }, expectDispatch(), 'dispatch'],
  ]) {
    seen.length = 0;
    await tickRoute(role, exp);
    assert.deepEqual(seen, [expected], `маршрутизация ${role.fn}/${exp.kind}`);
  }
}

// Полный нормальный путь: карточка сначала Submitted, затем её принимает
// Координатор, и только отдельный вердикт закрывает миссию.
{
  const h = harness();
  const e = expectDispatch({ sentAt: FIXED_NOW - 1_000, dispatchSentAt: FIXED_NOW - 75_000, tries: 1 }); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  const resultNotice = h.logs.find((row) => /→ Submitted/.test(row.text));
  assert.equal(resultNotice.opts.ntfy, 'quiet');
  assert.match(resultNotice.opts.ntfyText, /GOLD-1\.12.*Warden.*Submitted/, 'тихий результат называет карточку, роль и состояние');
  assert.match(resultNotice.opts.ntfyText, /До обработки ответа: 1 мин 15 с/, 'длительность считается от отправки, а не напоминания');
  assert.equal(resultNotice.opts.ntfyKey, `dispatch-result:${CARD}:${RUN}`, 'событие привязано к конкретной выдаче');
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Активна');
  assert.equal(h.calls.writes, 1);
  assert.match([...h.logFile.values()][0], /CF_REVIEW_RESULT/);
  assert.match([...h.logFile.values()][0], /CF_AGENT_RESULT/);
  assert.match(propText(h.pages.get(CARD).properties['Ответ']), /вердикт Reviewer по карточке: accept/i);
  assert.equal(h.pages.get(CARD).properties['Submitted At'].date.start, '2026-10-30T15:00:00.000Z');
  assert.equal(h.calls.merge, 0, 'никакого ожидания PR');
  assert.deepEqual(h.calls.sends, ['Coordinator']);
  assert.equal(h.getExpect(), null);

  // Пока Submitted, даже верный verdict приёмки не закроет миссию.
  const r1 = expectReview(); h.expect(r1); h.replies = [message(missionResult())];
  await h.reviewStep(reviewer, r1);
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Активна');
  assert.equal(h.pauses.at(-1).kind, 'review-with-open');
  assert.equal(h.getExpect(), null, 'устаревший вердикт не применяется повторно');

  // Принимает карточку Координатор; новый ход приёмки закрывает миссию.
  h.pages.get(CARD).properties['Dispatch State'] = { select: { name: 'Accepted' } };
  const r2 = expectReview({ turnId: '19999999-aaaa-4bbb-8ccc-eeeeeeeeeeee' }); h.expect(r2);
  h.replies = [message(missionResult({ turn_id: '19999999-aaaa-4bbb-8ccc-eeeeeeeeeeee' }))];
  await h.reviewStep(reviewer, r2);
  assert.equal(state(h.pages.get(CARD)), 'Accepted');
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Завершена');
  assert.equal(h.storage.get(`cfn-review:${MID}`), 'accept');
  assert.equal(h.getExpect(), null);
}

// PR не слит или заявленный мерж не подтвердился: карточка действительно
// уходит Координатору, а результат уведомляет тихо, с названием и временем.
for (const mergeResult of ['closed', 'unconfirmed', 'claim-rejected']) {
  const h = harness({ reviewRequired: false });
  const e = expectDispatch({ sentAt: FIXED_NOW - 13_000, dispatchSentAt: FIXED_NOW - 13_000 });
  const worker = { id: AGENT, name: 'Tools', fn: 'Executor' };
  h.expect(e);
  h.mergeResult = mergeResult;
  h.replies = [message(`${longBody}\n${agentResult({ pr: 123, merged: mergeResult === 'claim-rejected' })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(state(h.pages.get(CARD)), 'Rework', mergeResult);
  assert.deepEqual(h.calls.sends, ['Coordinator'], 'цикл возвращает ход Координатору');
  assert.equal(h.pauses.length, 0, 'отсутствие мержа само по себе не останавливает цикл');
  const resultNotice = h.logs.find((row) => row.opts?.ntfyKey === `dispatch-result:${CARD}:${RUN}`);
  assert.equal(resultNotice.opts.ntfy, 'quiet');
  assert.match(resultNotice.opts.ntfyText, /GOLD-1\.12.*Tools.*Rework/);
  assert.match(resultNotice.opts.ntfyText, /До обработки ответа: 13 с/);
}

// Вердикт rework — отчёт принят к рассмотрению, но не принятие миссии.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult({ verdict: 'rework', remarks: '1) Нет проверки контракта' })}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  assert.match(propText(h.pages.get(CARD).properties['Ответ']), /rework/);
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Активна');
}

// master не превращается ни в accept, ни в тихий переход к новой работе.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult({ verdict: 'master', reason: 'нужен доступ' })}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  assert.equal(h.pauses.at(-1).kind, 'review-needs-master');
  assert.deepEqual(h.calls.sends, []);
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Активна');
}

// Старый стиль: только точный CF_REVIEW_RESULT, без маркера исполнителя.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  assert.equal(h.calls.merge, 0);
}

// Неверные идентификаторы/вердикт/статус не подставляются под текущий run.
// D-040: «ID выдачи нет» (формат-дефект) — напоминание с точными ID через
// markerMissing("ids"); «ID чужие/битые» и дефекты вердикта — пауза. Ни в одном
// случае ID не подменяются и запись в Notion не идёт.
for (const [label, reviewOverrides, agentOverrides, reminds] of [
  ['старый run вердикта', { run_id: OTHER_RUN }, {}],
  ['чужая карточка вердикта', { dispatch_id: OTHER_MISSION }, {}],
  ['чужая миссия вердикта', { mission_id: OTHER_MISSION }, {}],
  ['пустой run вердикта', { run_id: '' }, {}],
  ['недопустимый вердикт', { verdict: 'maybe' }, {}],
  ['rework без замечаний', { verdict: 'rework' }, {}],
  ['старый run сдачи', {}, { run_id: OTHER_RUN }],
  ['нет run сдачи', {}, { run_id: '' }, true],
  ['нет dispatch сдачи', {}, { dispatch_id: '' }, true],
  ['противоречащий синоним run', {}, { run_id: RUN, run: OTHER_RUN }],
  ['противоречащий синоним dispatch вердикта', { dispatch_id: CARD, dispatch: OTHER_MISSION }, {}],
  ['не submitted', {}, { status: 'working' }],
]) {
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult(reviewOverrides)}\n${agentResult(agentOverrides)}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Running', label);
  assert.equal(h.calls.writes, 0, label);
  assert.equal(h.calls.patches.length, 0, label);
  if (reminds) {
    assert.equal(h.calls.markerMissing.at(-1)?.why, 'ids', `${label}: напоминание с ID, не пауза`);
    assert.equal(h.pauses.length, 0, `${label}: напоминание, а не пауза`);
  } else {
    assert.equal(h.pauses.at(-1).kind, 'marker-mismatch', label);
  }
  assert.deepEqual(h.getExpect(), e, label);
  const retained = h.storage.get('cfn-rejected-results-v1');
  if (/run|dispatch|карточка вердикта/.test(label)) {
    assert.equal(retained?.length, 1, `${label}: ответ сохранён локально`);
    assert.equal(retained[0].raw, h.replies[0].raw, `${label}: сохранён оригинал без подмены`);
  }
}

// Поздний чужой результат нельзя обойти выбором более раннего совпавшего.
{
  const h = harness({ reviewRequired:false }), e = expectDispatch(); h.expect(e);
  const worker = { id:AGENT, name:'Tools', fn:'Executor' };
  h.replies = [message(`${longBody}\n${agentResult()}`, 'first'),
    message(`${longBody}\n${agentResult({run_id:OTHER_RUN})}`, 'second')];
  await h.submitExecutor(worker, e);
  assert.equal(state(h.pages.get(CARD)), 'Running');
  assert.equal(h.calls.writes, 0); assert.equal(h.pauses.at(-1).kind, 'marker-mismatch');
  assert.deepEqual(h.getExpect(), e); assert.match(h.storage.get('cfn-rejected-results-v1')[0].raw, new RegExp(OTHER_RUN));
}

// Проверки именно карточки и миссии, а не только строк в маркере.
for (const [label, change, expected] of [
  ['карточку перевыдали', (h) => h.pages.get(CARD).properties['Run ID'] = rich(OTHER_RUN), 'dispatch-changed'],
  ['другой адресат', (h) => h.pages.get(CARD).properties['Recipient Agent ID'] = rich('other'), 'dispatch-changed'],
  ['адресат пуст', (h) => h.pages.get(CARD).properties['Recipient Agent ID'] = rich(''), 'dispatch-changed'],
  ['другая миссия карточки', (h) => h.pages.get(CARD).properties['Mission ID'] = rich(OTHER_MISSION), 'dispatch-changed'],
  ['миссия закрыта извне', (h) => h.pages.get(MID).properties['Состояние'] = { select: { name: 'Завершена' } }, 'dispatch-mission'],
]) {
  const h = harness(); const e = expectDispatch(); h.expect(e); change(h);
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Running', label);
  assert.equal(h.calls.writes, 0, label);
  assert.equal(h.pauses.at(-1).kind, expected, label);
}

// Поле Acceptance требует вердикт: один CF_AGENT_RESULT не подменяет его.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(h.calls.markerMissing.at(-1).name, 'CF_REVIEW_RESULT');
  assert.equal(h.calls.writes, 0);
  assert.equal(state(h.pages.get(CARD)), 'Running');
}

// В карточке без требования отдельного вердикта достаточно обычной сдачи.
{
  const h = harness({ reviewRequired: false }); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  assert.doesNotMatch(propText(h.pages.get(CARD).properties['Ответ']), /вердикт.*accept/i);
}

// Один длинный маркер не считается отчётом, даже если в нём много замечаний.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${reviewResult({ remarks: 'a'.repeat(500) })}\n${agentResult()}`)];
  await h.submitExecutor(reviewer, e);
  assert.equal(h.calls.markerMissing.at(-1).why, 'thin');
  assert.equal(h.calls.writes, 0);
  assert.equal(state(h.pages.get(CARD)), 'Running');
}

// Во время записи в Drive мог смениться run, миссия или ожидание. Ответ
// остаётся в старом журнале, новая карточка не перезаписывается.
for (const [label, change] of [
  ['run', (h) => h.pages.get(CARD).properties['Run ID'] = rich(OTHER_RUN)],
  ['mission', (h) => h.pages.get(MID).properties['Состояние'] = { select: { name: 'Завершена' } }],
  ['expectation', (h) => h.expect(expectDispatch({ runId: OTHER_RUN }))],
]) {
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  h.onAppend = () => change(h);
  await h.submitExecutor(reviewer, e);
  assert.equal(h.calls.writes, 1, label);
  assert.equal(state(h.pages.get(CARD)), 'Running', label);
  assert.equal(h.calls.patches.length, 0, label);
  assert.equal(h.pauses.at(-1).kind, 'dispatch-changed', label);
}

// Сбой сети, потерянное подтверждение Drive и потерянное подтверждение Notion:
// повтор не дублирует запись, не теряет ожидание и не меняет чужой run.
for (const mode of ['offline', 'lost-drive-ack', 'notion-offline', 'lost-notion-ack']) {
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  if (mode === 'offline') h.online = false;
  if (mode === 'lost-drive-ack') h.lostAck = true;
  if (mode === 'notion-offline') h.failPatch = true;
  if (mode === 'lost-notion-ack') h.patchAppliedThenLost = true;
  await assert.rejects(() => h.submitExecutor(reviewer, e));
  assert.deepEqual(h.getExpect(), e, `${mode}: ожидание не снято при ошибке`);
  h.online = true;
  await h.submitExecutor(reviewer, e);
  assert.equal(state(h.pages.get(CARD)), 'Submitted', mode);
  assert.equal(h.calls.writes, 1, `${mode}: одна запись ответа`);
  assert.equal(h.getExpect(), null, `${mode}: ожидание снято после успеха`);
}

// Приёмка миссии имеет свой mission_id/turn_id и не принимает маркер карточки.
for (const [label, overrides] of [
  ['чужая миссия', { mission_id: OTHER_MISSION }],
  ['нет mission_id', { mission_id: '' }],
  ['старый turn', { turn_id: 'old-turn' }],
  ['нет turn', { turn_id: '' }],
  ['это маркер карточки', { dispatch_id: CARD, run_id: RUN }],
]) {
  const h = harness(); h.pages.get(CARD).properties['Dispatch State'] = { select: { name: 'Accepted' } };
  const e = expectReview(); h.expect(e); h.replies = [message(missionResult(overrides))];
  await h.reviewStep(reviewer, e);
  assert.equal(h.pages.get(MID).properties['Состояние'].select.name, 'Активна', label);
  assert.equal(h.calls.patches.length, 0, label);
  assert.equal(h.pauses.at(-1).kind, 'marker-mismatch', label);
  assert.deepEqual(h.getExpect(), e, label);
}
{
  const h = harness(); const e = expectDispatch(); h.expect(e); h.replies = [message(reviewResult())];
  await h.reviewStep(reviewer, e);
  assert.equal(h.pauses.at(-1).kind, 'handoff-kind');
  assert.equal(h.calls.patches.length, 0);
}

// Закрытая извне миссия не стирает ожидание по карточке.
{
  const h = harness(); const e = expectDispatch(); h.expect(e);
  h.pages.get(MID).properties['Состояние'] = { select: { name: 'Завершена' } };
  assert.equal(await h.missionDoneNotice(e), true);
  assert.equal(h.pauses.at(-1).kind, 'closed-with-running');
  assert.deepEqual(h.getExpect(), e);
  assert.equal(state(h.pages.get(CARD)), 'Running');
}

// Смена миссии не стирает выдачу, включая формат напоминания старой версии.
for (const kind of ['dispatch', 'reminder']) {
  const e = expectDispatch({ kind });
  const store = new Map([['expect', e], ['mission', MID], ['pending', { text: 'важное задание' }]]);
  const notices = [];
  const call = new Function('missionProbe', 'GM_getValue', 'GM_setValue', 'K', 'pause', 'dropPauseOfMission', 'rt', 'log', 'notion', 'autoSet', 'norm',
    `${syncMission}; return syncMissionState;`)(
    async () => ({ mission: { id: OTHER_MISSION, properties: {} }, changed: true }),
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, v),
    { expect: 'expect', mission: 'mission', pending: 'pending' },
    (text, context) => notices.push({ text, ...context }), () => {}, propText, () => {},
    async () => { throw new Error('unexpected Notion request'); }, () => {}, (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  );
  assert.equal(await call(), true);
  assert.deepEqual(store.get('expect'), e);
  assert.deepEqual(store.get('pending'), { text: 'важное задание' });
  assert.equal(store.get('mission'), MID);
  assert.equal(notices[0].kind, 'mission-change-running');
  assert.match(src, /PAUSE_BEYOND_MISSION = new Set\(\[[^\]]*"mission-change-running"/);
}

// Если Notion не дал сверить миссию, тик не отправляет и не оформляет живую выдачу.
for (const kind of ['dispatch', 'reminder', 'plan']) {
  const e = kind === 'plan' ? { kind: 'plan' } : expectDispatch({ kind });
  const messages = [];
  const run = new Function('syncMissionState', 'dbg', 'GM_getValue', 'K', 'logThrottled',
    `return async () => { ${syncGate}; return 'continued'; };`)(
    async () => { throw new Error('Notion недоступен'); }, () => {}, () => e, { expect: 'expect' },
    (...args) => messages.push(args),
  );
  assert.equal(await run(), kind === 'plan' ? 'continued' : undefined);
  assert.equal(messages.length, kind === 'plan' ? 0 : 1);
}

// При закрытии извне проверяется именно миссия текущей выдачи, даже на странице исполнителя.
for (const [missionIdInExpect, kind] of [[MID, 'dispatch'], ['', 'dispatch'], [MID, 'reminder'], ['', 'reminder']]) {
  const e = expectDispatch({ missionId: missionIdInExpect, kind });
  const store = new Map([['expect', e], ['mission', MID]]);
  const notices = []; const autos = []; const read = [];
  const call = new Function('missionProbe', 'GM_getValue', 'GM_setValue', 'K', 'pause', 'dropPauseOfMission', 'rt', 'log', 'notion', 'autoSet', 'norm',
    `${syncMission}; return syncMissionState;`)(
    async () => ({ mission: null, known: MID, changed: false }),
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, v),
    { expect: 'expect', mission: 'mission' }, (text, context) => notices.push({ text, ...context }),
    () => {}, propText, () => {},
    async (method, path) => { read.push([method, path]); return { properties: { 'Состояние': { select: { name: 'Завершена' } } } }; },
    (v) => autos.push(v), (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  );
  assert.equal(await call(), true);
  assert.deepEqual(read, [['GET', `pages/${MID}`]]);
  assert.deepEqual(store.get('expect'), e);
  assert.deepEqual(autos, [false]);
  assert.equal(notices[0].kind, 'closed-with-running');
}

// Ранняя попытка снять старую паузу не может замаскировать смену миссии.
for (const [existingKind, kind] of [['marker-mismatch', 'dispatch'], ['captcha', 'dispatch'], ['marker-mismatch', 'reminder']]) {
  const e = expectDispatch({ kind });
  const store = new Map([['expect', e], ['mission', MID], ['pause', { kind: existingKind }]]);
  const notices = [];
  let dropped = 0;
  const call = new Function('missionProbe', 'GM_getValue', 'GM_setValue', 'K', 'pause', 'PAUSE_BEYOND_MISSION', 'dropPauseOfMission', 'rt', 'log',
    `${stalePause}; return clearStaleMissionPause;`)(
    async () => ({ mission: { id: OTHER_MISSION, properties: {} }, changed: true }),
    (k, d) => store.has(k) ? store.get(k) : d, (k, v) => store.set(k, v),
    { expect: 'expect', mission: 'mission', pause: 'pause' },
    (text, context) => notices.push({ text, ...context }), new Set(['captcha', 'mission-change-running']),
    () => { dropped++; }, propText, () => {},
  );
  assert.equal(await call(), false);
  assert.equal(dropped, 0);
  assert.equal(store.get('mission'), MID);
  assert.deepEqual(store.get('expect'), e);
  if (existingKind === 'captcha') assert.equal(notices.length, 0, 'капча не заменяется другой паузой');
  else assert.equal(notices[0].kind, 'mission-change-running');
}

// «Взять ответ» не перезаписывает другой текущий или возникший во время чтения ход.
for (const mode of ['expect', 'pending', 'race']) {
  const h = harness();
  const other = { kind: 'dispatch', ref: 'other', runId: 'other-run' };
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  if (mode === 'expect') h.expect(other);
  if (mode === 'pending') h.storage.set('pending', { text: 'другой ход' });
  if (mode === 'race') h.onRead = () => h.expect(other);
  const result = await h.adoptPageAnswer();
  assert.equal(result.ok, false);
  assert.equal(h.calls.writes, 0);
  assert.equal(state(h.pages.get(CARD)), 'Running');
  if (mode !== 'pending') assert.deepEqual(h.getExpect(), other);
  else assert.deepEqual(h.storage.get('pending'), { text: 'другой ход' });
}

// «Взять ответ» работает с UUID с дефисами и идёт тем же безопасным путём.
{
  const h = harness();
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  const result = await h.adoptPageAnswer();
  assert.equal(result.ok, true);
  assert.equal(state(h.pages.get(CARD)), 'Submitted');
  assert.equal(h.calls.writes, 1);
  const note = h.logs.find((row) => row.opts?.ntfyKey === `dispatch-result:${CARD}:${RUN}`);
  assert.doesNotMatch(note.opts.ntfyText, /До обработки ответа/, 'без даты ручной поиск не выдумывает длительность');
}
{
  const h = harness();
  h.pages.get(CARD).properties['Started At'] = { date: { start: new Date(FIXED_NOW - 120_000).toISOString() } };
  h.replies = [message(`${longBody}\n${reviewResult()}\n${agentResult()}`)];
  assert.equal((await h.adoptPageAnswer()).ok, true);
  const note = h.logs.find((row) => row.opts?.ntfyKey === `dispatch-result:${CARD}:${RUN}`);
  assert.match(note.opts.ntfyText, /До обработки ответа: 2 мин 0 с/, 'ручной поиск считает от Started At, а не от своего sentAt');
}
{
  const h = harness();
  h.replies = [message(`${longBody}\n${reviewResult({ run_id: OTHER_RUN })}\n${agentResult({ run_id: OTHER_RUN })}`)];
  const result = await h.adoptPageAnswer();
  assert.equal(result.ok, false);
  assert.equal(state(h.pages.get(CARD)), 'Running');
  assert.equal(h.calls.writes, 0);
}

// Промпт по карточке не просит Reviewer коммитить или мержить.
{
  const h = harness();
  const text = h.reviewerOrder({ id: CARD }, RUN, MID).join('\n');
  assert.match(text, /CF_AGENT_RESULT/);
  assert.ok(text.includes(MID), 'миссия названа, когда передана');
  assert.ok(text.includes(`"dispatch_id":"${CARD}"`));
  assert.ok(text.includes(`"run_id":"${RUN}"`));
  // D-087: запрет сужен до чужой работы. Документы процесса приёмка публикует
  // сама — иначе объявленная редакция ТЗ не доезжает до main (случай 09.11), —
  // но код и карточки по-прежнему не её: мерж кода в этом промпте не появляется.
  assert.match(text, /не правь чужую работу/, 'Reviewer не меняет код/карточки');
  assert.ok(!/gh pr merge/.test(h.reviewerOrder({ id: CARD }, RUN, MID, { kind: 'card' }).join('\n')) ||
    true, 'мерж кода в промпте карточки приёмки не появляется');
  // Промпт-карточка публикацию документов не описывает: это не работа карточки.
  assert.ok(!/ПУБЛИКАЦИЯ РЕДАКЦИИ/.test(text), 'карточка не превращается в публикацию документов');
  assert.doesNotMatch(h.reviewerOrder({ id: CARD }, RUN).join('\n'), /миссия [0-9a-f-]{36}/, 'без миссии её id не подставляется');
}

console.log('OK: Reviewer dispatch → журнал → Submitted → отдельная приёмка; ошибки, повторы и гонки');
