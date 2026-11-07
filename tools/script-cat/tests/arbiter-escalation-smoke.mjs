// D-053 · Арбитраж повторяющейся петли.
//
// 07.11 карточку SYN-2 · S-4 перевыдали три раза за шесть часов: исполнитель
// честно отдал draft-PR с описанием блокера по Scope, транспорт увидел «нет
// заявки о мерже» и вернул её в Rework. Правила сработали — а разбирать петлю
// пришлось Мастеру, потому что третья перевыдача сразу ставила паузу.
//
// Теперь та же перевыдача уходит арбитру (роль с функцией Reviewer): он видит
// «Ответ», состояние карточки, PR по GitHub, журнал попыток и очередь и решает,
// что делать с карточкой. Остановить цикл он тоже может — своим решением
// (verdict:master). Проверяется повеление, а не строки: модуль целиком
// исполняется на моделях Notion/GitHub/чата из `src/26b-arbiter.js`.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { PromptCompiler } from './helpers/prompt-env.mjs';
import { promptShim } from './helpers/prompt-shim.mjs';

const src = readFileSync(new URL('../src/26b-arbiter.js', import.meta.url), 'utf8');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const sel = (p) => p?.select?.name || '';
const rich = (s) => ({ rich_text: s ? [{ plain_text: s }] : [] });
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

const CARD = '4096f0cf-5705-8159-bd88-c725d5ea075d';
const MISSION = '4086f0cf-5705-81ea-94c6-e47bd6c3ba78';
const TURN = '09999999-aaaa-4bbb-8ccc-eeeeeeeeeeee';
const RUN = '57b20404-787e-476e-96d6-b6548f27a3df';
const WARDEN = { id: 'agent-warden', name: 'Warden', fn: 'Reviewer', url: '/agent/warden', status: 'Активна' };
const COORD = { id: 'agent-coord', name: 'Coordinator', fn: 'Coordinator', url: '/agent/coord', status: 'Активна' };
const EXEC = { id: 'agent-exec', name: 'Executor Core', fn: 'Executor', url: '/agent/exec', status: 'Активна' };

function harness({ cardState = 'Ready', check = 'fail', pr = '', answer = '', roles: roleList = [WARDEN, COORD, EXEC], prInfo = null } = {}) {
  const store = new Map();
  const pauses = [];
  const logs = [];
  const sends = [];
  const patches = [];
  const plans = [];
  const pages = new Map([
    [MISSION, { id: MISSION, properties: {
      'Миссия': { title: [{ plain_text: 'SYN-2 · Мини-игра арены' }] },
      'Состояние': { select: { name: 'Активна' } },
    } }],
    [CARD, { id: CARD, properties: {
      'Запрос': { title: [{ plain_text: 'SYN-2 · S-4 · Детерминированная мини-игра арены' }] },
      'Mission ID': rich(MISSION),
      'Кому': { select: { name: 'Executor Core' } },
      'Dispatch State': { select: { name: cardState } },
      'Check': { select: check ? { name: check } : null },
      'PR': { url: pr },
      'Run ID': rich(RUN),
      'Acceptance': rich('arena --seed 7 --turns 3 даёт одинаковый лог'),
      'Ответ': rich(answer),
    } }],
  ]);
  const env = {
    store, pauses, logs, sends, patches, plans, pages,
    replies: [],
    ghCalls: [],
  };
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'norm', 'rt', 'taskTitle', 'taskRole', 'taskState',
    'notion', 'patch', 'roles', 'activeMission', 'queueOf', 'githubPr', 'ghToken', 'firstLine',
    'nowIso', 'uid', 'isUuid', 'richText', 'pause', 'log', 'messagesAfter', 'parseMarker',
    'markerMissing', 'retainRejectedResult', 'sendToRole', 'compileOrPause',
    'redispatchKey', 'REDISPATCH_WINDOW', 'REDISPATCH_LIMIT', 'redispatchWhy', 'requestPlan',
    `${promptShim}
     ${src}
     return { arbiterKey, noteArbitration, arbitrationCount, arbiterRole, arbiterCase, arbiterPrompt,
       escalateToWarden, currentArbitration, arbiterStep };`,
  )(
    (k, d) => (store.has(k) ? clone(store.get(k)) : d),
    (k, v) => store.set(k, clone(v)),
    { expect: 'cfn-expect', pending: 'cfn-pending', paused: 'cfn-paused', pause: 'cfn-pause' },
    { arbiterLimit: 2, arbiterWindowHours: 6, arbiterAttempts: 6 },
    norm, rt,
    (p) => rt(p?.properties?.['Запрос']),
    (p) => sel(p?.properties?.['Кому']),
    (p) => sel(p?.properties?.['Dispatch State']),
    async (_m, path) => {
      const id = String(path).replace(/^pages\//, '');
      if (!pages.has(id)) throw new Error(`page not found ${id}`);
      return clone(pages.get(id));
    },
    async (id, props) => {
      patches.push({ id, props: clone(props) });
      const page = pages.get(id);
      assert.ok(page, 'запись только в существующую страницу');
      for (const [k, v] of Object.entries(props)) page.properties[k] = clone(v);
      return clone(page);
    },
    async () => roleList.map(clone),
    async () => clone(pages.get(MISSION)),
    async () => ({ summary: '0 Submitted, 0 Running, 1 Ready, 1 Rework, 0 Draft, 0 Blocked' }),
    async (repo, number) => {
      env.ghCalls.push({ repo, number });
      if (!prInfo) throw new Error('HTTP 404: Not Found');
      return clone(prInfo);
    },
    () => '',
    (text, n = 220) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n),
    () => '2026-11-07T09:15:00.000Z',
    () => TURN,
    (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || '')),
    (s) => (Array.isArray(s) ? s : [String(s ?? '')]).map((x) => ({ type: 'text', text: { content: x } })),
    (reason, context = {}) => { pauses.push({ reason, ...context }); store.set('cfn-paused', reason); },
    (text) => logs.push(text),
    () => env.replies.map((text, i) => ({ id: `m${i}`, raw: text, text })),
    (text, name) => {
      const at = String(text).lastIndexOf(name);
      if (at < 0) return null;
      const raw = String(text).slice(at + name.length).trim();
      try { return JSON.parse(raw); } catch { return null; }
    },
    async (role, expect, name) => { env.markerMissing = { role, expect, name }; return true; },
    (_e, kind) => { env.retained = kind; return true; },
    async (role, envelope, kind, ref, extra) => { sends.push({ role, envelope, kind, ref, extra }); return true; },
    (request, label) => {
      const r = PromptCompiler.compile(request);
      if (r.ok) return r;
      pauses.push({ reason: `${label}: ${r.error.code}`, kind: 'prompt-compile' });
      return null;
    },
    (id) => `cfn-redispatch:${id}`,
    6 * 3600 * 1000,
    3,
    (card) => (sel(card?.properties?.['Check']) === 'fail' ? 'проверка ответа не прошла (Check=fail)' : 'Координатор направил её в работу снова'),
    async (mission, role, queue, note, opts) => { plans.push({ mission, role, queue, note, opts }); return true; },
  );
  return Object.assign(env, { api });
}

const expectFor = (over = {}) => ({
  kind: 'arbiter', ref: CARD, turnId: TURN, roleId: WARDEN.id, roleName: 'Warden',
  watermark: 'before', sentAt: Date.now(), title: 'SYN-2 · S-4 · Детерминированная мини-игра арены', ...over,
});
const marker = (data) => `Разбор петли текстом.\nCF_ARBITER_RESULT ${JSON.stringify(data)}`;

// ── 1. Промпт арбитра: профиль, бюджет, оба вердикта и ID этой карточки ────
{
  const r = PromptCompiler.compile({
    kind: 'arbiter',
    role: { name: 'Warden', fn: 'Reviewer' },
    mission: { id: MISSION, name: 'SYN-2 · Мини-игра арены' },
    turnId: TURN,
    arbiter: { cardId: CARD, cardTitle: 'SYN-2 · S-4 · Мини-игра арены', role: 'Executor Core',
      redispatchCount: 3, redispatchLimit: 3, windowHours: 6, reason: 'её видели в Rework',
      state: 'Ready', check: 'fail', answer: 'Scope blocker — не готов к мержу: нужен game/cli/main.gd вне зоны S-4.',
      pr: 'https://github.com/Creative36711/synapse/pull/26', prState: 'draft, открыт',
      attempts: '07.11 12:05 · dispatch · executor.card · Rework', queue: '1 Ready, 1 Rework' },
    delivery: { tier: 'full' },
  });
  assert.ok(r.ok, `профиль арбитра собирается: ${r.error?.message}`);
  assert.equal(r.profileId, 'reviewer.arbiter');
  assert.equal(r.marker, 'CF_ARBITER_RESULT');
  assert.ok(r.metrics.overheadChars <= 2400, `бюджет арбитра: ${r.metrics.overheadChars} ≤ 2400`);
  const lines = r.text.trim().split('\n');
  assert.match(lines.at(-1), /^CF_ARBITER_RESULT \{/, 'маркер — последней строкой');
  assert.ok(r.text.includes(CARD) && r.text.includes(TURN), 'ID карточки и хода в промпте');
  assert.match(r.text, /verdict:resolve/, 'решение по карточке объяснено');
  assert.match(r.text, /verdict:master|verdict: master/, 'остановка цикла названа');
  assert.ok(r.text.includes('Scope blocker'), 'поле «Ответ» доходит до арбитра');
  assert.ok(r.text.includes('draft, открыт'), 'состояние PR по GitHub доходит до арбитра');
  // Наружу арбитр не пишет код: блоков записи в git и полного задания нет.
  assert.ok(!r.blocks.some((b) => ['git.executor', 'task.assignment'].includes(b.id)), 'арбитр без git-записи и задания');
  // Продолжение после лимита инструментов — тот же ход, свои IDs.
  const cont = PromptCompiler.compile({
    kind: 'arbiter', role: { name: 'Warden', fn: 'Reviewer' }, turnId: TURN,
    arbiter: { cardId: CARD }, delivery: { tier: 'tool_limit' },
  });
  assert.ok(cont.ok, `continuation.arbiter собирается: ${cont.error?.message}`);
  assert.equal(cont.profileId, 'continuation.arbiter');
  assert.ok(cont.metrics.overheadChars <= 700, 'продолжение в бюджете 700');
  assert.ok(cont.text.includes(CARD) && cont.text.includes(TURN), 'продолжение несёт те же ID');
}

// ── 2. Петля уходит арбитру, а не в паузу ──────────────────────────────────
{
  const h = harness({ answer: 'Готово: arena.exe --seed 7 детерминирован.', pr: 'https://github.com/Creative36711/synapse/pull/26' });
  // Транспорт уже видел три перевыдачи за окно.
  h.store.set('cfn-redispatch:' + CARD, [Date.now() - 1000, Date.now() - 500, Date.now()]);
  const escalated = await h.api.escalateToWarden(h.pages.get(CARD), 'её видели в Rework');
  assert.equal(escalated, true, 'петля передана арбитру');
  assert.equal(h.pauses.length, 0, 'паузы Мастера на первой петле нет');
  assert.equal(h.sends.length, 1, 'ход ушёл одному адресату');
  const sent = h.sends[0];
  assert.equal(sent.kind, 'arbiter', 'вид хода — арбитраж');
  assert.equal(sent.ref, CARD, 'ссылка — сама карточка');
  assert.equal(sent.role.name, 'Warden', 'арбитр — роль с функцией Reviewer');
  assert.equal(sent.envelope.profileId, 'reviewer.arbiter');
  assert.ok(sent.extra.arbiter, 'дело арбитра сохранено в ожидании (напоминания и продолжения)');
  assert.ok(sent.envelope.text.includes('Готово: arena.exe --seed 7 детерминирован.'), 'ответ исполнителя в промпте');
  assert.ok(!/CF_ARBITER_RESULT[^\n]*master[^\n]*\}\s*$/m.test(sent.envelope.text.split('\n').slice(-1)[0] + '\n'),
    'последняя строка маркера — не master: остановка остаётся осознанным выбором');
  assert.equal(h.api.arbitrationCount(CARD), 1, 'разбор посчитан');
}

// ── 3. Нет активного Warden — прежняя пауза Мастера ────────────────────────
{
  const h = harness({ roles: [COORD, EXEC] });
  const escalated = await h.api.escalateToWarden(h.pages.get(CARD), 'её видели в Rework');
  assert.equal(escalated, false, 'без Reviewer эскалации нет');
  assert.equal(h.sends.length, 0, 'никому ничего не отправлено');
  assert.equal(h.pauses.length, 0, 'паузу ставит вызывающий: решение о ней остаётся в одном месте');
}

// ── 4. Дело арбитра не читается — тоже прежняя пауза ───────────────────────
{
  const h = harness();
  h.pages.delete(CARD); // Notion не отдал карточку
  const escalated = await h.api.escalateToWarden({ id: CARD }, 'петля');
  assert.equal(escalated, false, 'без фактов арбитраж не начинается');
  assert.equal(h.sends.length, 0, 'пустое дело арбитру не отправляется');
  assert.ok(h.logs.some((line) => /не прочитать для арбитража/.test(line)), 'причина названа в журнале');
}

// ── 5. Предел арбитражей: арбитр не зовёт арбитра по кругу ─────────────────
{
  const h = harness();
  h.store.set('cfn-arbiter:' + CARD, [Date.now() - 2000, Date.now() - 1000]);
  const escalated = await h.api.escalateToWarden(h.pages.get(CARD), 'петля');
  assert.equal(escalated, true, 'ход не продолжается');
  assert.equal(h.sends.length, 0, 'третьего разбора нет');
  assert.equal(h.pauses.at(-1).kind, 'arbiter-limit', 'петля остановлена с причиной');
  assert.match(h.pauses.at(-1).reason, /решает Мастер/, 'Мастер — последняя инстанция');
}

// ── 6. verdict:master — техническое право арбитра остановить цикл ─────────
{
  const h = harness();
  const e = expectFor();
  h.store.set('cfn-expect', e);
  h.replies = [marker({ dispatch_id: CARD, turn_id: TURN, verdict: 'master', reason: 'В постановке два взаимоисключающих требования; нужно решение по ТЗ' })];
  await h.api.arbiterStep(WARDEN, e);
  assert.equal(h.pauses.at(-1).kind, 'arbiter-master', 'цикл остановлен решением арбитра');
  assert.match(h.pauses.at(-1).reason, /нужно решение по ТЗ/, 'причина арбитра видна Мастеру');
  assert.equal(h.store.get('cfn-expect'), null, 'ожидание снято');
  assert.equal(h.patches.length, 0, 'карточку арбитр не правит');
  assert.equal(h.api.arbitrationCount(CARD), 0, 'счётчик разборов обнулён: петля не тянется дальше');
}

// ── 7. resolve + ready: карточка заново, решение записано, ход Координатору ─
{
  const h = harness();
  const e = expectFor();
  h.store.set('cfn-expect', e);
  h.store.set('cfn-redispatch:' + CARD, [Date.now() - 10, Date.now() - 5, Date.now()]);
  h.replies = [marker({ dispatch_id: CARD, turn_id: TURN, verdict: 'resolve', action: 'ready',
    reason: 'Задача требовала публичного run --input вне зоны S-4; постановка неверна', fix: 'Убрать --input из оракула' })];
  await h.api.arbiterStep(WARDEN, e);
  assert.equal(h.pauses.length, 0, 'решение арбитра не останавливает цикл');
  const state = h.patches.find((p) => p.props['Dispatch State'])?.props['Dispatch State'].select.name;
  assert.equal(h.pages.get(CARD).properties['Dispatch State'].select.name, 'Ready', 'та же карточка снова в работе');
  const answer = rt(h.pages.get(CARD).properties['Ответ']);
  assert.match(answer, /Арбитраж Warden/, 'решение видно в карточке');
  assert.match(answer, /Убрать --input из оракула/, 'правка постановки сохранена');
  assert.equal(h.store.get('cfn-redispatch:' + CARD).length, 0, 'порог перевыдач обнулён после разбора');
  assert.equal(h.store.get('cfn-expect'), null, 'ожидание снято после записи');
  assert.equal(h.plans.length, 1, 'ход возвращён Координатору');
  assert.match(h.plans[0].note, /ready — Задача требовала/);
  assert.equal(h.plans[0].opts.force, true, 'ответ Координатору не ждёт минуту');
  assert.equal(state, 'Ready');
}

// ── 8. Остальные решения по карточке ──────────────────────────────────────
for (const [action, expected, why] of [
  ['rework', 'Rework', 'вернуть автору постановки'],
  ['accepted', 'Accepted', 'работа на самом деле выполнена'],
  ['blocked', 'Blocked', 'нужен человек, цикл идёт дальше'],
]) {
  const h = harness();
  const e = expectFor();
  h.store.set('cfn-expect', e);
  h.replies = [marker({ dispatch_id: CARD, turn_id: TURN, verdict: 'resolve', action, reason: why })];
  await h.api.arbiterStep(WARDEN, e);
  assert.equal(h.pages.get(CARD).properties['Dispatch State'].select.name, expected, `${action} → ${expected}`);
  assert.equal(h.pauses.length, 0, `${action}: паузы нет`);
  assert.equal(h.plans.length, 1, `${action}: ход снова у Координатора`);
}

// ── 9. Маркер без своего ID или без причины не принимается ────────────────
for (const [label, data] of [
  ['чужая карточка', { dispatch_id: '11111111-2222-4333-8444-555555555555', turn_id: TURN, verdict: 'resolve', action: 'ready', reason: 'x' }],
  ['чужой ход', { dispatch_id: CARD, turn_id: 'old-turn', verdict: 'resolve', action: 'ready', reason: 'x' }],
  ['нет вердикта', { dispatch_id: CARD, turn_id: TURN }],
  ['неизвестный action', { dispatch_id: CARD, turn_id: TURN, verdict: 'resolve', action: 'retry', reason: 'x' }],
  ['решение без причины', { dispatch_id: CARD, turn_id: TURN, verdict: 'resolve', action: 'ready' }],
]) {
  const h = harness();
  const e = expectFor();
  h.store.set('cfn-expect', e);
  h.replies = [marker(data)];
  await h.api.arbiterStep(WARDEN, e);
  assert.ok(['marker-mismatch', 'arbiter-marker'].includes(h.pauses.at(-1).kind), `${label}: пауза с причиной`);
  assert.equal(h.pages.get(CARD).properties['Dispatch State'].select.name, 'Ready', `${label}: карточку не двигали`);
  assert.equal(h.plans.length, 0, `${label}: ход не возвращался Координатору`);
  assert.deepEqual(h.store.get('cfn-expect'), e, `${label}: ожидание сохранено для разбора`);
}

// ── 10. Чужой ход арбитража не перезаписывается ───────────────────────────
{
  const h = harness();
  const e = expectFor();
  h.store.set('cfn-expect', { ...e, turnId: '22222222-3333-4444-8555-666666666666' });
  h.replies = [marker({ dispatch_id: CARD, turn_id: TURN, verdict: 'resolve', action: 'ready', reason: 'x' })];
  await h.api.arbiterStep(WARDEN, e);
  assert.equal(h.pauses.at(-1).kind, 'marker-mismatch');
  assert.equal(h.plans.length, 0);
}

// ── 11. Перевыдача в dispatchTask: сначала арбитр, пауза — запасной путь ──
{
  const file = readFileSync(new URL('../src/27-review-answers.js', import.meta.url), 'utf8');
  const branch = file.slice(file.indexOf('const times = noteRedispatch(fresh.id);'));
  const point = branch.indexOf('if (times >= REDISPATCH_LIMIT)');
  const block = branch.slice(point, branch.indexOf('if (state !== "Ready" || submittedAt || prLink)'));
  assert.ok(block.includes('await escalateToWarden(fresh, why)'),
    'порог перевыдач сначала уходит арбитру');
  assert.ok(block.indexOf('escalateToWarden') < block.indexOf('pause('),
    'пауза Мастера — только когда арбитра нет');
  assert.match(block, /нет активной роли с функцией Reviewer/, 'причина паузы называет отсутствие арбитра');
}

console.log('OK: D-053 — петля уходит арбитру (Warden) вместо паузы, решения по карточке применяются, master останавливает цикл, без арбитра и по пределу — пауза Мастера');
