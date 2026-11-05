// D-042: обратная связь Координатору должна доходить до промпта.
//
// Боевой случай (2026-11-05, 19:44–19:46): карточка K-22 стояла в Ready с
// «Кому» = Warden. Координатор трижды назвал next:"Warden", транспорт трижды
// отказал (decisionRoute → ask) и встал в паузу. Причина петли: заметка отказа
// передавалась в coordinatorPrompt как `note`, но НЕ попадала в compile-контекст,
// и блока plan.note не существовало — Координатор получал тот же снимок очереди
// без объяснения и повторял запрещённый ход. Guard работал, обратная связь терялась.
//
// Здесь проверяется: note рендерится блоком plan.note (verbatim, без overhead),
// доходит и в full, и в recovery; отказ Reviewer исполним (поле «Кому», рабочие
// роли); пауза после трёх попыток сохранена; пустая заметка блока не создаёт.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PromptCompiler, PROMPT_BLOCKS, planRequest } from '../tests/helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}

// ── 1. Блок plan.note существует, verbatim, только Coordinator ─────────────
assert.ok(PROMPT_BLOCKS['plan.note'], 'блок plan.note зарегистрирован');
assert.equal(PROMPT_BLOCKS['plan.note'].verbatim, true, 'plan.note — verbatim (не ест overhead)');
assert.deepEqual(PROMPT_BLOCKS['plan.note'].audience, ['Coordinator'], 'plan.note только Координатору');

// ── 2. note доходит до скомпилированного промпта (full) ────────────────────
const note = 'Карточку выдать не удалось — роль не активна. Поправь её состояние.';
const full = PromptCompiler.compile(planRequest({ note }));
assert.ok(full.ok, `full план компилируется: ${full.error?.message || ''}`);
assert.ok(full.text.includes(note), 'заметка дословно в промпте Координатора');
assert.match(full.text, /Обратная связь транспорта:/, 'заметка подписана как обратная связь');
const noteBlock = full.blocks.find((b) => b.id === 'plan.note');
assert.ok(noteBlock, 'plan.note попал в список блоков');
assert.equal(noteBlock.overhead, 0, 'plan.note не увеличивает overhead');
assert.equal(full.blocks.at(-1).id, 'marker.coordinator', 'маркер остаётся последним');

// ── 3. note доходит и в recovery ───────────────────────────────────────────
const recovery = PromptCompiler.compile(planRequest({ note, delivery: { tier: 'recovery' } }));
assert.ok(recovery.ok, `recovery компилируется: ${recovery.error?.message || ''}`);
assert.ok(recovery.text.includes(note), 'заметка доходит и в recovery-промпт');
assert.ok(recovery.blocks.some((b) => b.id === 'plan.note'), 'plan.note есть в recovery');

// ── 4. пустая заметка не создаёт блок и не меняет промпт ───────────────────
const empty = PromptCompiler.compile(planRequest());
assert.ok(empty.ok);
assert.ok(!empty.blocks.some((b) => b.id === 'plan.note'), 'без заметки блока plan.note нет');
assert.ok(!empty.text.includes('Обратная связь транспорта'), 'без заметки подписи нет');
const blank = PromptCompiler.compile(planRequest({ note: '   ' }));
assert.ok(blank.ok && !blank.blocks.some((b) => b.id === 'plan.note'), 'пробельная заметка = нет блока');

// ── 5. заметка не раздувает overhead против плана без неё ──────────────────
// Verbatim-блок не считает свой текст в overhead; добавляется лишь разделитель
// «\n\n» между блоками (2 знака). Бюджет coordinator.plan (3200) не поднят.
assert.ok(full.metrics.overheadChars <= empty.metrics.overheadChars + 2, 'plan.note добавляет только разделитель, не свой текст');
assert.ok(full.metrics.overheadChars <= 3200, 'план с заметкой остаётся в бюджете overhead 3200');

// ── 6. отказ Reviewer исполним: поле «Кому», рабочие роли, пауза сохранена ─
const routing = cut('  function decisionRoute(next,', '  // ───────────────────────────── вопросы к Мастеру');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const decisionRoute = new Function('norm', `${routing}\nreturn decisionRoute;`)(norm);
const warden = { name: 'Warden', fn: 'Reviewer', id: 'rev-1', status: 'Активна' };
const kernel = { name: 'Kernel', fn: 'Executor', id: 'exec-1', status: 'Активна' };
const auditor = { name: 'Runtime Auditor', fn: 'Auditor', id: 'audit-1', status: 'Активна' };
const coordinator = { name: 'Coordinator', fn: 'Coordinator', id: 'coord-1', status: 'Активна' };
const roles = [coordinator, warden, kernel, auditor];

const route = decisionRoute('Warden', { roles, directory: roles, readyRoles: ['Warden'] });
assert.equal(route.kind, 'ask', 'Reviewer по-прежнему не получает карточку');
assert.match(route.note, /Reviewer/);
assert.match(route.note, /Auditor|Executor/);
assert.match(route.note, /вопросы и предложения/);
assert.match(route.note, /done/);
// D-042: конкретика, которой не хватало в бою.
assert.match(route.note, /«Кому»/, 'названо поле, которое надо исправить');
assert.match(route.note, /Kernel/, 'названа доступная рабочая роль Executor');
assert.match(route.note, /Runtime Auditor/, 'названа доступная рабочая роль Auditor');
assert.match(route.note, /Ready/, 'сказано оставить карточку в Ready');
assert.match(route.note, /исполнителя/, 'ратификация названа работой исполнителя');
assert.equal(decisionRoute('Warden', { roles, directory: roles, readyRoles: ['Warden'], misses: 2 }).kind, 'pause', 'пауза после трёх попыток сохранена');

// Без активных рабочих ролей — отказ не падает и не предлагает пустой список.
const noWorkers = decisionRoute('Warden', { roles: [coordinator, warden], directory: [coordinator, warden], readyRoles: ['Warden'] });
assert.equal(noWorkers.kind, 'ask');
assert.match(noWorkers.note, /Executor или Auditor/, 'без рабочих ролей назван класс роли');

// Рабочие роли по-прежнему получают dispatch (фикс не задел нормальный путь).
assert.equal(decisionRoute('Kernel', { roles, directory: roles, readyRoles: ['Kernel'] }).kind, 'dispatch');
assert.equal(decisionRoute('done', { roles, directory: roles }).kind, 'done');

// ── 7. проводка note в compile-контекст coordinatorPrompt (место бага) ─────
// coordinatorPrompt — последняя функция 21-prompts.js; за ней в бандле идёт
// 22-executor.js (appendToJournal). Recovery-envelope собирается в requestPlan.
const coordPromptSrc = cut('  function coordinatorPrompt(', '  async function appendToJournal(');
assert.match(coordPromptSrc, /turnId,\s*note,\s*queue:/, 'coordinatorPrompt кладёт note в контекст рядом с turnId');
assert.match(src, /recoveryEnvelope = PromptCompiler\.compile\(\{[\s\S]*?turnId,\s*note,\s*queue:/, 'requestPlan передаёт note в recovery-envelope');

console.log('OK: заметка Координатору доходит до промпта (full+recovery); отказ Reviewer исполним; пауза и маркер сохранены');
