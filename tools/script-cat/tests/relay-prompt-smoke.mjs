// Проба текстов задания: что именно читает агент.
//
// Жалобы Мастера (2026-10-23, 18:06) на задание Architect:
//   • «мержить кнопкой в интерфейсе», «не кнопками», «Кнопки Create/Merge
//     нажимать не нужно», «Continue нажимается автоматически» — у агента нет
//     интерфейса, эти строки только сбивают;
//   • «(текст задания не найден — работай по карточке)» — выглядело как сбой,
//     хотя карточка и есть задание;
//   • «Лог попытки: …» вело на пустой файл, и было непонятно, что это.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Технический блок: ни кнопок, ни Continue ─────────────────────────────
const techFrom = src.indexOf('  const snapshotFact = (repo, branch) => {');
const techTo = src.indexOf('  /**\n   * Полный блок для роли, собранный из контекста цели выдачи');
assert.ok(techFrom > 0 && techTo > techFrom, 'блок технической информации на месте');
const tech = new Function(
  'C',
  `${src.slice(techFrom, techTo)}; return { executorTech: executorTech(C.repo, C.branch), auditorTech: auditorTech(C.repo, C.branch), COORDINATOR_TECH };`,
)({ repo: 'example/relay-fixture' });
const FORBIDDEN = /кнопк|Continue|интерфейс/i;
for (const [name, text] of Object.entries(tech)) {
  assert.doesNotMatch(text, FORBIDDEN, `${name}: агенту не рассказывают про кнопки интерфейса`);
}

// ── 2. Правила ролей и порядок работы ───────────────────────────────────────
const prFrom = src.indexOf('  /** Правило поведения зависит от функции');
const prTo = src.indexOf('  function coordinatorPrompt(');
assert.ok(prFrom > 0 && prTo > prFrom, 'блок промптов на месте');
const api = new Function(
  'rt', 'taskTitle', 'technicalInfo', 'roleContext', 'C', 'nowIso',
  `${src.slice(prFrom, prTo)}
   return { roleRule, workRules, executorOrder, auditorOrder, assignmentBody, taskLogEntry, executorPrompt };`,
)(
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (task) => (task.properties['Запрос']?.title || []).map((x) => x.plain_text).join(''),
  () => 'ТЕХБЛОК',
  (role) => `Ты — ${role.name}.`,
  { pageUrl: 'https://example.test/page' },
  () => '2026-10-23T15:36:00.000Z',
);

const executor = { name: 'Architect', fn: 'Executor', zone: 'docs/contracts/', gate: 'ADR' };
const coordinator = { name: 'Coordinator', fn: 'Coordinator' };

for (const [name, text] of Object.entries({
  roleRuleExecutor: api.roleRule(executor),
  roleRuleCoordinator: api.roleRule(coordinator),
  order: api.executorOrder({ id: 'd1' }, 'r1').join('\n'),
  auditOrder: api.auditorOrder({ id: 'd1' }, 'r1').join('\n'),
})) {
  assert.doesNotMatch(text, FORBIDDEN, `${name}: без кнопок и Continue`);
}

// 2.1. Мерж всё ещё требуется — но командой.
assert.match(api.roleRule(executor), /gh pr merge --squash/, 'мерж остаётся обязанностью исполнителя');
assert.match(api.executorOrder({ id: 'd1' }, 'r1').join('\n'), /gh pr merge --squash --delete-branch/, 'команда мержа на месте');

// 2.2. Файлы «для показа» не открываются: запрет в общих правилах хода.
//     24.10 агент открыл md-файл Мастеру в окне просмотра — это тормозит
//     браузер и в автоматическом цикле не нужно.
for (const who of [executor, coordinator, { name: 'Runtime Auditor', fn: 'Auditor' }]) {
  const rules = api.workRules(who);
  assert.match(rules, /Файлы для показа не открывай/, `${who.name}: открывать файлы для демонстрации нельзя`);
  assert.match(rules, /путь к файлу назови текстом в отчёте/, `${who.name}: файл называется путём, а не открывается`);
}

// ── 3. Задание: карточка достаточна, «не найден» больше нет ────────────────
const card = {
  id: 'card-1',
  properties: {
    'Запрос': { title: [{ plain_text: 'NAR-1.1 · Карта ядра' }] },
    'Намерение': { rich_text: [{ plain_text: 'Понять, из чего состоит GameEngine.' }] },
    'Инварианты': { rich_text: [{ plain_text: 'В таблице ровно 253 строки.' }] },
    'Acceptance': { rich_text: [{ plain_text: "grep -cE '^  (async )?[a-zA-Z_]+\\(' src/core/engine.ts = 253" }] },
    'Свободно': { rich_text: [{ plain_text: 'Формат таблицы.' }] },
    'Scope': { rich_text: [{ plain_text: 'docs/design/core-map.md (создать).' }] },
  },
};

const fallback = api.assignmentBody(card, '');
assert.doesNotMatch(fallback, /не найден/i, 'слова «текст задания не найден» больше нет');
assert.match(fallback, /карточка и есть задание/, 'сказано прямо: карточка и есть задание');
assert.match(fallback, /Намерение|Инварианты|Оракул|Scope/, 'перечислено, что читать в карточке');
assert.match(fallback, /docs\/decisions\//, 'напомнено, куда писать решения при разрешённом Scope');
assert.match(fallback, /docs\/decisions\/[^\n]*если Scope разрешает этот путь; иначе — в отчёте/, 'журнал решения не нарушает Scope');
assert.match(fallback, /через question в Notion; до ответа контракт не меняется/, 'предложения не подменяют фактическое решение');
const execOrder = api.executorOrder({ id: 'd1' }, 'r1').join('\n');
assert.match(execOrder, /docs\/decisions\/[^\n]*если Scope разрешает этот путь; иначе — в отчёте/, 'порядок исполнителя тоже сохраняет Scope');
assert.match(execOrder, /через question в Notion; до фактического решения контракт остаётся прежним/);
assert.equal(api.assignmentBody(card, '  Текст из файла\n'), 'Текст из файла', 'файл задания важнее карточки');
assert.equal(api.assignmentBody(card, '   '), fallback, 'пустой файл не считается заданием');

const prompt = api.executorPrompt(card, executor, '', 'LOG1', 'run-1');
assert.ok(prompt.includes(fallback), 'задание попало в промпт целиком');
assert.doesNotMatch(prompt, /не найден/i, 'в промпте нет «не найден»');
assert.doesNotMatch(prompt, /drive\.google\.com\/file/, 'ссылки на журнал в задании нет: она не нужна агенту');

assert.doesNotMatch(
  src.slice(src.indexOf('  function executorPrompt('), src.indexOf('  function answerLogLine(')),
  /answerLogLine|drive\.google\.com/,
  'ссылка на журнал ответа — только Координатору, в задании исполнителя её нет',
);

const withPayload = api.executorPrompt(card, executor, 'Текст из файла', 'LOG1', 'run-1');
assert.match(withPayload, /ЗАДАНИЕ\nТекст из файла/, 'приложенный файл идёт как задание');

// ── 4. Журнал попытки: не пустой, с маркером и разделами ────────────────────
const entry = api.taskLogEntry(card, executor, '', 'run-1');
assert.match(entry, /^<!-- CF_DISPATCH card-1:run-1:task -->/, 'первая строка — маркер записи');
assert.match(entry, /## Задание NAR-1\.1 · Карта ядра/, 'журнал назван по задаче');
assert.match(entry, /- кому: Architect/, 'видно адресата');
assert.match(entry, /### Намерение[\s\S]*### Инварианты[\s\S]*### Оракул[\s\S]*### Scope/, 'разделы карточки в журнале');
assert.match(entry, /### Задание/, 'само задание в журнале');
assert.ok(entry.includes(fallback), 'в журнал попадает тот же текст, что читает агент');

// ── 5. Выдача хода пишет журнал до отправки ─────────────────────────────────
const dispatchFrom = src.indexOf('  async function dispatchTask(');
const dispatchTo = src.indexOf('  // ───────────────────────────── цикл', dispatchFrom);
assert.ok(dispatchFrom > 0 && dispatchTo > dispatchFrom, 'функция выдачи хода на месте');
const dispatchBody = src.slice(dispatchFrom, dispatchTo);
const appendAt = dispatchBody.indexOf('await gateway("append", logId');
const sendAt = dispatchBody.indexOf('sendToRole(role, executorPrompt(');
assert.ok(appendAt > 0 && sendAt > appendAt, 'задание пишется в журнал до отправки агенту');
assert.match(dispatchBody, /:task -->/, 'у записи свой маркер');
assert.match(dispatchBody, /отдельного файла с заданием нет — текст собран из карточки/, 'в журнале панели видно, откуда взялось задание');
assert.match(dispatchBody, /catch \(e\) \{\s*log\(`Задание не записалось в журнал попытки/, 'сбой журнала не срывает ход');

// ── 6. Напоминания и план Координатора тоже без кнопок ─────────────────────
const reminderFrom = src.indexOf('  function markerReminder(');
const reminderTo = src.indexOf('  /**', reminderFrom + 10);
const markerBlock = src.slice(reminderFrom, reminderTo);
assert.doesNotMatch(markerBlock, FORBIDDEN, 'в напоминании о маркере нет кнопок');

console.log('OK: relay 1.4.63 — агенту не рассказывают про кнопки, файлы для показа не открываются, задание берётся из карточки, журнал попытки заполняется сразу');
