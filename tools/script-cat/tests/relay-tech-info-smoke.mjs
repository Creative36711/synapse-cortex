/**
 * Проба технического блока ScriptCat: что и кому дописывается.
 *
 * Блок исполняется по-настоящему — кусок исходника вырезается и вычисляется,
 * поэтому проверяется поведение функции, а не наличие строк в файле.
 *
 *   node _tools/ScriptCat/tests/relay-tech-info-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../relay.user.js', import.meta.url), 'utf8');

const start = src.indexOf('  const TECH_OPEN =');
const end = src.indexOf('  // ───────────────────────────── промпты');
assert.ok(start > 0 && end > start, 'секция технической информации найдена');

const C = { repo: 'example/relay-fixture' };
const { technicalInfo, TECH_OPEN, TECH_CLOSE } = new Function(
  'C',
  `${src.slice(start, end)}\nreturn { technicalInfo, TECH_OPEN, TECH_CLOSE };`,
)(C);

const role = (fn, name = fn) => ({ fn, name });

// ── 1. Блок есть в каждом сообщении и помечен как машинный ──────────────────
for (const fn of ['Executor', 'Auditor', 'Coordinator']) {
  const text = technicalInfo(role(fn));
  assert.ok(text.startsWith(TECH_OPEN), `${fn}: блок открывается маркером`);
  assert.ok(text.trimEnd().endsWith(TECH_CLOSE), `${fn}: блок закрывается маркером`);
  assert.match(text, /ТЕХНИЧЕСКАЯ ИНФОРМАЦИЯ/, `${fn}: заголовок на месте`);
  assert.match(text, /не задание и не текст Координатора/, `${fn}: оговорка об источнике`);
  assert.ok(text.includes('UTC'), `${fn}: есть отметка времени`);
}

// ── 2. Executor получает ритуал старта от main ──────────────────────────────
const exec = technicalInfo(role('Executor', 'Kernel'));
assert.match(exec, /Kernel/, 'блок знает, кому он адресован');
assert.match(exec, /git merge-base HEAD origin\/main/, 'есть проверка общей истории');
assert.match(exec, /git reset --hard origin\/main/, 'есть приведение дерева к main');
assert.match(exec, /git switch -c nar\//, 'ветка создаётся от origin/main');
assert.match(exec, new RegExp(C.repo), 'указан репозиторий');
assert.match(exec, /46 файлов/, 'масштаб расхождения назван числом');
assert.match(exec, /PR покажет удаление чужих файлов/, 'объяснён вред снимка');

// ── 3. Auditor: только main, писать нельзя ──────────────────────────────────
const audit = technicalInfo(role('Auditor', 'Runtime Auditor'));
assert.match(audit, /ТЫ НЕ ПИШЕШЬ/, 'аудитору прямо запрещено писать');
assert.match(audit, /Источник истины|ИСТОЧНИК ИСТИНЫ/i, 'источник истины назван');
assert.match(audit, /git show origin\/main:/, 'файлы читаются из main без checkout');
assert.match(audit, /gh pr view <номер> --json state,mergeCommit/, 'проверяется слитый PR');
assert.ok(!/git reset --hard/.test(audit), 'аудитору не предлагается сбрасывать дерево');
assert.ok(!/gh pr merge/.test(audit), 'аудитору не предлагается мержить');

// ── 4. Coordinator: без git вообще ──────────────────────────────────────────
const coord = technicalInfo(role('Coordinator'));
assert.match(coord, /Notion/);
assert.match(coord, /Drive/);
assert.ok(!/git fetch|git merge-base|git reset|git switch/.test(coord), 'координатору не нужен git');
assert.ok(!/gh pr /.test(coord), 'координатору не нужны команды PR');
// Другой проект: те же полномочия, но его репозиторий, base и Drive.
const otherC = {repo:'team/synapse', branch:'release/next', driveFolder:'synapse', projectName:'Synapse'};
const other = new Function('C', `${src.slice(start, end)}\nreturn technicalInfo;`)(otherC);
const otherExec = other(role('Executor', 'Builder')), otherCoord = other(role('Coordinator'));
assert.match(otherExec, /team\/synapse/); assert.match(otherExec, /origin\/release\/next/);
assert.doesNotMatch(otherExec, /origin\/main|46 файлов/, 'старый снимок Relay не выдаётся за факт нового проекта');
assert.match(otherCoord, /Arena\/synapse\/payloads/); assert.doesNotMatch(otherCoord, /Arena\/payloads/);
assert.match(other(role('Reviewer', 'Warden')), /не правишь ни код, ни карточки/);
assert.match(coord, /вопрос ADR в Notion и фактическое решение приёмки или Мастера/, 'изменение контракта по-прежнему требует фактического решения');
assert.match(coord, /Существующие proposed-файлы сохраняются/, 'исторические предложения не удаляются');

// ── 5. Неизвестная функция — безопасный fallback ────────────────────────────
const unknown = technicalInfo(role('Молчит', 'Никто'));
assert.equal(unknown, technicalInfo(role('Executor', 'Никто')).replace('Executor', 'Молчит'), 'fallback = Executor');

// ── 6. Блок реально попадает в промпты и стоит ДО задания ───────────────────
const executorPrompt = src.slice(src.indexOf('function executorPrompt('), src.indexOf('function coordinatorPrompt('));
assert.ok(
  executorPrompt.indexOf('technicalInfo(role, ctx') < executorPrompt.indexOf('"ЗАДАНИЕ"'),
  'в промпте исполнителя блок идёт раньше задания',
);
assert.match(executorPrompt, /role\.fn === "Auditor"\s*\? auditorOrder\(task, runId, ctx\)/, 'аудитор получает свой порядок');
assert.match(executorPrompt, /role\.fn === "Reviewer"\s*\? reviewerOrder\(task, runId, missionId\)/, 'рецензент получает свой порядок');

const coordinatorPrompt = src.slice(src.indexOf('function coordinatorPrompt('), src.indexOf('// ───────────────────────────── ход исполнителя'));
assert.ok(
  coordinatorPrompt.indexOf('technicalInfo(role, ctx') < coordinatorPrompt.indexOf('Миссия:'),
  'координатор получает блок раньше текста задания',
);

// ── 7. Аудитор не ждёт мержа ────────────────────────────────────────────────
assert.match(
  src,
  /const noPr = role\.fn === "Auditor" \|\| role\.fn === "Reviewer" \|\| prDeclined\(result\);\s*\n\s*const merged = noPr \? "none" : await ensureMerged\(page, result\);/,
  'аудитор, рецензент и работа без PR не блокируют цикл ожиданием PR',
);

// ── 8. Правило поведения тоже зависит от функции ────────────────────────────
const ruleSrc = src.slice(src.indexOf('function roleRule('), src.indexOf('function roleContext('));
const { roleRule } = new Function(`${ruleSrc}\nreturn { roleRule };`)();
assert.match(roleRule({ fn: 'Executor' }), /Мерж PR делаешь сам/, 'исполнителю — мерж самому');
assert.match(roleRule({ fn: 'Auditor' }), /ничего не меняешь в репозитории/i, 'аудитору — только отчёт');
assert.match(roleRule({ fn: 'Coordinator' }), /не твоя зона/, 'координатору — Notion, не git');
assert.ok(!/Мерж PR делаешь сам/.test(roleRule({ fn: 'Auditor' })), 'аудитору не сказано мержить');

// ── 9. Порядок работ различается по функции ─────────────────────────────────
const auditorOrder = src.slice(src.indexOf('function auditorOrder('), src.indexOf('function reviewerOrder('));
assert.ok(!/gh pr merge/.test(auditorOrder), 'в порядке аудитора нет мержа');
assert.match(auditorOrder, /Ничего не менять|ничего не менять/, 'аудитору запрещено менять репозиторий');
const executorOrder = src.slice(src.indexOf('function executorOrder('), src.indexOf('function auditorOrder('));
assert.match(executorOrder, /gh pr merge --squash --delete-branch/, 'исполнитель мержит сам');

console.log('OK: техблок 1.4.63 — Executor получает ритуал main, Auditor только читает main, Coordinator без git');
