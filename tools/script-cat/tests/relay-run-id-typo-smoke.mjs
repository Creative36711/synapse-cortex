// D-054 (07.11.2026, 17:04): Run ID с одной опечаткой — не чужой ответ.
//
// Executor Platform выполнил карточку S-4 и прислал маркер, в котором run_id
// отличался от выдачи ОДНИМ знаком:
//   выдача (и карточка Notion): a437578a-e5d6-4a26-b72d-41d2de180d6c
//   в маркере агента:           a437578a-e5db-4a26-b72d-41d2de180d6c
// dispatch_id был верный, в тексте — тот же отчёт и PR #26. Транспорт отнёс это
// к «чужим ID» и встал на паузу marker-mismatch: работа сделана, а цикл
// потребовал Мастера. Прошлой выдачи с таким run не существовало — сравнивать
// было нечего.
//
// Правило D-054: одна замена знака в хвосте UUID при совпадении префикса
// времени (первые 8 знаков), верном dispatch_id и карточке, которая несёт
// ОЖИДАЕМЫЙ run, — опечатка копирования. Ответ принимается, работа не
// повторяется. Всё остальное (другой префикс, другая длина, больше одной
// замены, карточка с чужим run) остаётся конфликтом и паузой.

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
// Инцидентные ветки должны попадать в тест целиком, иначе проверка их не видит.
const ids = cut('  const isUuid = ', '  async function notion(');
// Ветки D-054 (looksLikeTypo, runValues, typoTiedToCard, alignRunValues)
// приходят в тест вместе с настоящим submitExecutor — отдельную копию не берём,
// иначе объявления конфликтуют. Но проверить, что срез действительно несёт
// новые функции, надо явно: пустой срез молча даёт зелёный тест.
const d054 = (name) => {
  const a = src.indexOf(name);
  assert(a > 0, `в relay.user.js нет ${name}`);
  return a;
};
d054('  function looksLikeTypo(');
d054('  async function typoTiedToCard(');
d054('  const alignRunValues = ');
const missionMatch = cut('  const MISSION_STOPWORDS = ', '  /** Поле названия показывается');
const cardBinding = cut('  const cardMissionId = ', '  function cardBindingIssue(');
const retained = cut('  function retainRejectedResult(', '  /**\n   * `rich_text`');
const report = cut('  function runAnswer(', '  /**\n   * Минимальное сообщение');
const dispatch = cut('  async function appendToJournal(', '  // ───────────────────────────── ход Координатора');
const closeMission = cut('  async function closeMission(', '  /** Вернуть миссию Координатору');
const reviewStep = cut('  async function reviewStep(', '  // ─────────────────────── вопросы:');
const adopt = cut('  async function adoptPageAnswer(', '  /** Последняя проверка заявки');
const notice = cut('  async function missionDoneNotice(', '  /** Активная миссия и сменилась ли она');

const MID = '4106f0cf-5705-8167-850c-d0ca6c0a090a';
const CARD = '4116f0cf-5705-8118-8349-c63d5524ed96';
const RUN = 'a437578a-e5d6-4a26-b72d-41d2de180d6c';   // выдача и карточка
const TYPO = 'a437578a-e5db-4a26-b72d-41d2de180d6c';  // ровно то, что пришло
const OTHER_RUN = '09238d7a-4791-4ff0-ba7b-9bc29e493061'; // другая машина: другой префикс
const AGENT = '01a19db7-c1d2-7898-bf38-ff9eff301088';
const PR_URL = 'https://github.com/Creative36711/synapse/pull/26';
const agentResult = (extra = {}) => `CF_AGENT_RESULT ${JSON.stringify({
  dispatch_id: CARD, run_id: RUN, status: 'submitted', check: 0,
  report: 'Arena/synapse/artifacts/SYN-2-S-4-a437578a-report.md', pr: PR_URL, merged: false, ...extra })}`;

const TURN = '09999999-aaaa-4bbb-8ccc-eeeeeeeeeeee';
const FIXED_NOW = Date.parse('2026-11-07T14:04:22.000Z');
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
  static now() { return FIXED_NOW; }
}
const NAME = 'SYN-2 · S-4 · Камера и локали';
const reviewer = { id: AGENT, name: 'Warden', fn: 'Reviewer', url: '/agent/warden' };
const coordinator = { id: 'coord', name: 'Coordinator', fn: 'Coordinator' };
const rich = (s) => ({ rich_text: s ? [{ plain_text: s }] : [] });
const propText = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const state = (page) => page?.properties?.['Dispatch State']?.select?.name || '';
const marker = (name, data) => `${name} ${JSON.stringify(data)}`;
const expectDispatch = (extra = {}) => ({ kind: 'dispatch', ref: CARD, runId: RUN, missionId: MID, roleId: AGENT, watermark: 'before', sentAt: 1, ...extra });
const clone = (v) => structuredClone(v);
const longBody = 'Проверен оракул N-5: восемь локалей, отпечатки кадров 0/60/120 совпадают побайтово, регресс SYN-1 зелёный. '.repeat(4);
const message = (text, id = 'msg-1') => ({ id, raw: text, text });
const worker = { id: AGENT, name: 'Executor Core', fn: 'Executor' };

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
    if (h.failRead === id) throw new Error('notion offline');
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
    notion, patch, gateway, activeMission: currentMission, lastClosedMission: async () => clone(pages.get(MID)), queueOf,
    messagesAfter: () => clone(h.replies), messages: () => clone(h.replies),
    roleFromPath: () => AGENT, isUserNode: () => false, nodeId: (n) => n.id, messageRaw: (n) => n.raw,
    roles: async () => [reviewer, coordinator], goTo: async (role) => calls.sends.push(role.name),
    log: (text, error, opts) => logs.push({ text, error, opts }), pause,
    autoOn: () => true, autoSet: (on) => calls.autos.push(on), setStatus: () => {},
    missionKind: (p) => p?.properties?.['Состояние']?.select?.name || '',
    nowIso: () => '2026-10-30T15:00:00.000Z', oneLine: (s, n) => String(s).slice(0, n), firstLine: (s) => String(s).split('\n')[0],
    questionInMarker: () => ({ kind: 'none' }), askQuestion: async () => { throw new Error('вопросов в тесте нет'); },
    deferredResultFor: (expect) => expect?.deferredResult
      ? { found: true, decision: expect.deferredResult.decision, error: '' }
      : { found: false, decision: null, error: '' },
    // В этом сценарии PR #26 открыт и не слит: исполнитель говорит merged:false.
    ensureMerged: async () => {
      calls.merge++;
      return h.mergeResult || 'merged';
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
      notion, patch, gateway, activeMission, lastClosedMission, queueOf, messagesAfter, messages,
      roleFromPath, isUserNode, nodeId, messageRaw, roles, goTo, log, pause, autoOn, autoSet,
      setStatus, missionKind, nowIso, oneLine, firstLine, questionInMarker, askQuestion, deferredResultFor,
      ensureMerged, prDeclined, prUrl, prRef, hasMergedClaim, prMergeConflict, rememberAnswerStamp, lastMergeCheck,
      markerMissing, looseResult, stillWorking, staleBranchRefusal, retryStaleBranchHandoff,
      consumePending, returnMission } = env;
    ${parser}\n${ids}\n${missionMatch}\n${cardBinding}\n${retained}\n${report}\n${dispatch}\n${closeMission}\n${reviewStep}\n${adopt}\n${notice}
    return { submitExecutor, reviewStep, adoptPageAnswer, missionDoneNotice, answerBody };
  `);
  Object.assign(h, create(env));
  h.expect = (e) => GM_setValue('expect', e);
  h.getExpect = () => GM_getValue('expect', null);
  return h;
}


// ── 1. Опечатка в run_id: ответ принимается, работы не повторяем ────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${agentResult({ run_id: TYPO })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.length, 0, 'пауза marker-mismatch не ставится — это не чужой ответ');
  assert.equal(state(h.pages.get(CARD)), 'Submitted', 'карточка сдана, работа не повторяется');
  assert.equal(h.calls.writes, 1, 'ответ ушёл в журнал выдачи');
  assert.match([...h.logFile.values()][0], new RegExp(CARD), 'журнал привязан к карточке');
  const note = h.logs.find((row) => /Run ID с опечаткой/.test(row.text));
  assert.ok(note, 'журнал называет опечатку, а не молчит');
  assert.match(note.text, new RegExp(TYPO), 'видно, что прислал агент');
  assert.match(note.text, new RegExp(RUN), 'видно, что было в выдаче');
  // Оригинал сохраняется: разбор возможен и после записи.
  const kept = h.storage.get('cfn-rejected-results-v1') || [];
  assert.ok(kept.some((row) => row.kind === 'dispatch-typo' && row.raw.includes(TYPO)), 'присланный маркер сохранён');
}

// ── 2. Настоящий чужой run (другой префикс времени) — прежняя пауза ────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${agentResult({ run_id: OTHER_RUN })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'чужой run остаётся поводом для паузы');
  assert.equal(h.calls.writes, 0, 'чужой ответ в журнал не пишется');
  assert.equal(state(h.pages.get(CARD)), 'Running', 'карточка не сдана');
}

// ── 3. Две замены в UUID — уже не опечатка копирования ─────────────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  // a437578a-e5d6-… -> a437578a-e7d9-…: две буквы в первом блоке, обе не дефисы
  const twoTypos = `${RUN.slice(0, 9)}e7d9${RUN.slice(13)}`;
  assert.equal(twoTypos.length, RUN.length, 'длина UUID сохранена — проверяется именно число замен');
  h.replies = [message(`${longBody}\n${agentResult({ run_id: twoTypos })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'две замены — не опечатка');
  assert.equal(h.calls.writes, 0);
}

// ── 4. Опечатка в dispatch_id тоже не прощается ────────────────────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  const typoDispatch = CARD.slice(0, 12) + 'e' + CARD.slice(13);
  h.replies = [message(`${longBody}\n${agentResult({ dispatch_id: typoDispatch })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'карточка в маркере — истина, её не угадываем');
  assert.equal(h.calls.writes, 0);
}

// ── 5. Опечатка в run, но карточка уже несёт другой run — чужой ответ ──────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.pages.get(CARD).properties['Run ID'] = rich(OTHER_RUN);
  h.replies = [message(`${longBody}\n${agentResult({ run_id: TYPO })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'карточку перевыдали — опечатку не трактуем');
  assert.equal(h.calls.writes, 0);
}

// ── 6. Карточка недоступна: не угадываем, остаётся пауза ───────────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.failRead = CARD;
  h.replies = [message(`${longBody}\n${agentResult({ run_id: TYPO })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'без подтверждения карточки ответ не принимается');
  assert.equal(h.calls.writes, 0);
}

// ── 7. Замена попала на дефис: это сдвиг строки, а не опечатка ─────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  // a437578a-e5d6-… -> a437578a-e5d-…: тот же набор знаков, но сдвинут.
  const shifted = `${RUN.slice(0, 12)}-${RUN.slice(13)}`;
  h.replies = [message(`${longBody}\n${agentResult({ run_id: shifted })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'сдвиг с дефисом не прощаем');
  assert.equal(h.calls.writes, 0);
}

// ── 8. В маркере не UUID: опечатку искать не в чем ─────────────────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.replies = [message(`${longBody}\n${agentResult({ run_id: 'a437578a-e5d6' })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'обрезанный ID не принимается');
  assert.equal(h.calls.writes, 0);
}

// ── 9. Карточка выдана другому агенту — чужой ответ ───────────────────────
{
  const h = harness({ reviewRequired: false });
  const e = expectDispatch(); h.expect(e);
  h.pages.get(CARD).properties['Recipient Agent ID'] = rich('01a19db7-0000-7000-8000-000000000000');
  h.replies = [message(`${longBody}\n${agentResult({ run_id: TYPO })}`)];
  await h.submitExecutor(worker, e);
  assert.equal(h.pauses.at(-1)?.kind, 'marker-mismatch', 'владелец карточки должен совпасть');
  assert.equal(h.calls.writes, 0);
}

console.log('OK: D-054 — опечатка в одном знаке Run ID принимается без повтора работы; другой префикс, две замены, опечатка в dispatch_id, перевыданная карточка и недоступный Notion остаются паузой');
