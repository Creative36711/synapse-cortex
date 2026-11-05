// Конструктор промптов: профили, бюджеты, маркеры, изоляция пилота, покрытие
// ruleId и инварианты #37/#38/#40. Источник истины — src/prompt-*.js.
import { strict as assert } from 'node:assert';
import {
  PromptCompiler, PROMPT_PROFILES, PROMPT_BLOCKS,
  dispatchRequest, planRequest, reviewRequest, answerRequest, reminderRequest, pilotRequest,
  UUID, task, role,
} from './helpers/prompt-env.mjs';

const BUDGETS = {
  'executor.card': 2800, 'auditor.card': 2200, 'coordinator.plan': 3200, 'coordinator.recovery': 1500,
  'reviewer.mission': 2400, 'reviewer.answer': 1800, 'reviewer.card': 2000, 'reminder.marker': 700,
  'delivery.compact': 1500, 'pilot.synapse': 250,
};
const TOTALS = {
  'executor.card': 6500, 'auditor.card': 5500, 'coordinator.plan': 7500, 'reviewer.mission': 7000,
  'reviewer.answer': 6000, 'reminder.marker': 900,
};

// 1. Каждый профиль компилируется и держит бюджет overhead и total.
const cases = [
  dispatchRequest('Executor'), dispatchRequest('Auditor'), dispatchRequest('Reviewer'),
  planRequest(), planRequest({ delivery: { tier: 'recovery' } }),
  reviewRequest(), answerRequest(), reminderRequest('Executor'), reminderRequest('Coordinator', 'CF_COORDINATOR_RESULT'),
  reminderRequest('Reviewer', 'CF_ANSWER_RESULT'), pilotRequest(),
];
for (const req of cases) {
  const r = PromptCompiler.compile(req);
  assert.ok(r.ok, `${req.kind}/${req.role.fn}: компилируется (${r.error?.message})`);
  const budget = BUDGETS[r.profileId];
  assert.ok(r.metrics.overheadChars <= budget, `${r.profileId}: overhead ${r.metrics.overheadChars} <= ${budget}`);
  if (TOTALS[r.profileId]) assert.ok(r.metrics.chars <= TOTALS[r.profileId], `${r.profileId}: total <= ${TOTALS[r.profileId]}`);
  assert.ok(r.metrics.utf8Bytes >= r.metrics.chars, 'utf8Bytes учитывает кириллицу');
  assert.ok(r.hash && r.blocks.length, 'есть хеш и список блоков');
}

// 2. Маркер ровно один, последний, с правильными ID.
{
  const r = PromptCompiler.compile(dispatchRequest('Executor'));
  const lines = r.text.trim().split('\n');
  assert.match(lines.at(-1), /^CF_AGENT_RESULT \{/, 'маркер последней строкой');
  assert.ok(r.text.includes(UUID.dispatch) && r.text.includes(UUID.run), 'ID выдачи в маркере');
  assert.equal(r.marker, 'CF_AGENT_RESULT');
}
{
  const r = PromptCompiler.compile(answerRequest());
  assert.match(r.text.trim().split('\n').at(-1), /^CF_ANSWER_RESULT \{/);
  assert.ok(r.text.includes(UUID.question), 'question_id сохранён (#40)');
}

// 3. Типизированные ошибки компиляции.
{
  const missing = PromptCompiler.compile(dispatchRequest('Executor', { task: task({ runId: '' }) }));
  assert.equal(missing.error.code, 'missing_fact');
  const unknown = PromptCompiler.compile({ kind: 'dispatch', role: role('Executor'), profileId: 'nope' });
  assert.equal(unknown.error.code, 'unknown_profile');
  const pilotTeam = PromptCompiler.compile(pilotRequest({ role: { fn: 'Executor' } }));
  assert.equal(pilotTeam.error.code, 'unknown_profile');
  const budget = PromptCompiler.compile(dispatchRequest('Executor', { delivery: { tier: 'full', hardLimit: 10 } }));
  assert.equal(budget.error.code, 'budget_exceeded');
}

// 4. Пилот изолирован: ни командных блоков, ни внутренних токенов.
{
  const r = PromptCompiler.compile(pilotRequest());
  assert.ok(r.ok);
  for (const bad of ['CF_AGENT_RESULT', 'CF_COORDINATOR_RESULT', 'Notion', 'cortex', 'REGULATION', 'WARDEN', 'DECISIONS']) {
    assert.ok(!r.text.includes(bad), `пилот без «${bad}»`);
  }
  assert.ok(r.text.includes('a'.repeat(40)), 'startSha в брифе');
  assert.ok(r.metrics.overheadChars <= 250, 'overhead пилота <= 250 сверх брифа');
}

// 5. Покрытие обязательных ruleId по ролям.
{
  const need = {
    Executor: ['R-PHASES', 'R-I18N', 'R-CARD-FIELDS', 'R-MARKER', 'R-REPO-BOUNDARY'],
    Coordinator: ['R-QUEUE', 'R-NO-REVIEWER-DISPATCH', 'R-MASTER-ONLY', 'R-D028'],
    Reviewer: ['R-VERIFY-GITHUB', 'R-D028', 'R-MASTER-ONLY'],
  };
  const exec = PromptCompiler.compile(dispatchRequest('Executor'));
  const coord = PromptCompiler.compile(planRequest());
  const rev = PromptCompiler.compile(reviewRequest());
  for (const id of need.Executor) assert.ok(exec.ruleIds.includes(id), `Executor: ${id}`);
  for (const id of need.Coordinator) assert.ok(coord.ruleIds.includes(id), `Coordinator: ${id}`);
  for (const id of need.Reviewer) assert.ok(rev.ruleIds.includes(id), `Reviewer: ${id}`);
}

// 6. Инварианты регламента в тексте.
{
  const coord = PromptCompiler.compile(planRequest()).text;
  assert.match(coord, /Check=fail НЕ ставь Rework\+Ready одним ответом/, '#37: fail не выдаётся без Rework');
  assert.match(coord, /Reviewer карточку не выдавай/, 'запрет dispatch Reviewer');
  const rec = PromptCompiler.compile(planRequest({ delivery: { tier: 'recovery' } })).text;
  assert.match(rec, /не новая задача и не новая выдача/, '#38: recovery не dispatch');
  assert.ok(!rec.includes('Черновики'), 'recovery не содержит полный план');
  const ans = PromptCompiler.compile(answerRequest({ question: { id: UUID.question, turnId: UUID.turn, fullText: 'q', masterEscalated: true } })).text;
  assert.ok(ans.includes(UUID.question), '#40: поздний маркер того же вопроса');
}

// 7. Нет «кнопочного» мусора и версионность блоков.
{
  for (const req of cases) {
    const r = PromptCompiler.compile(req);
    if (r.ok) assert.doesNotMatch(r.text, /кнопк|Continue|интерфейс/i, `${r.profileId}: без кнопок`);
  }
  for (const [id, b] of Object.entries(PROMPT_BLOCKS)) {
    assert.ok(Number.isInteger(b.version) && b.version >= 1, `${id}: версия блока`);
  }
}

// 8. forDelivery: full → compact → pause, не режет оракул молча.
{
  const d = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 6000, hardLimit: 9000 });
  assert.equal(d.strategy, 'full');
  const tight = PromptCompiler.forDelivery(dispatchRequest('Executor'), { softLimit: 10, hardLimit: 20 });
  assert.equal(tight.strategy, 'pause');
}

// 9. D-034: регрессия K-17 — реальная карточка с длинным заголовком/зоной/веткой
// влезает в бюджет auditor.card БЕЗ подъёма бюджета (скелет стал компактнее).
{
  const k17 = dispatchRequest('Auditor', {
    task: { ...task(), title: 'SYN-1 · K-17 · Промежуточный независимый аудит O-4' },
    role: { name: 'Spec Auditor', fn: 'Auditor', zone: 'docs/agents/**, tools/script-cat/**' },
    target: { repo: 'Creative36711/synapse-cortex', baseBranch: 'arena/87031a47-synapse-cortex' },
  });
  const r = PromptCompiler.compile(k17);
  assert.ok(r.ok, `K-17-подобная карточка компилируется: ${r.error?.message}`);
  assert.ok(r.metrics.overheadChars <= 2200, `K-17 overhead ${r.metrics.overheadChars} ≤ 2200 без подъёма бюджета`);
  // запас на будущие карточки: фиксированный скелет заметно ниже бюджета
  const fixture = PromptCompiler.compile(dispatchRequest('Auditor'));
  assert.ok(fixture.metrics.overheadChars <= 2050, `скелет auditor.card ${fixture.metrics.overheadChars} ≤ 2050`);
}

// 10. D-034: указатель на payload — verbatim, оракул/Scope остаются inline.
{
  const ref = { fileId: '1aq-ufiTecQR4rA2uVGKaHmNvi8LvrmLn', url: 'https://drive.google.com/file/d/1aq-ufiTecQR4rA2uVGKaHmNvi8LvrmLn/view' };
  const r = PromptCompiler.compile(dispatchRequest('Auditor', { task: task({ payload: '', payloadRef: ref, payloadPointer: true }) }));
  assert.ok(r.ok);
  assert.ok(r.text.includes(ref.fileId), 'указатель несёт ID файла');
  assert.ok(r.text.includes('прочитай его до работы'), 'агенту сказано прочитать файл');
  assert.ok(r.text.includes('Оракул (как принимают)'), 'оракул остаётся inline');
  assert.ok(r.text.includes('Scope'), 'Scope остаётся inline');
  const assign = r.blocks.find((b) => b.id === 'task.assignment');
  assert.ok(assign.verbatim, 'указатель — verbatim, не ест overhead');
  // указатель не должен раздувать overhead против карточки без задания
  const bare = PromptCompiler.compile(dispatchRequest('Auditor'));
  assert.ok(r.metrics.overheadChars <= bare.metrics.overheadChars + 1, 'указатель не увеличивает overhead');
}

// 11. D-034: budget_exceeded несёт разбивку по блокам (диагностируемая пауза).
{
  const over = PromptCompiler.compile(dispatchRequest('Auditor', { delivery: { tier: 'full', hardLimit: 10 } }));
  assert.equal(over.error.code, 'budget_exceeded');
  assert.ok(Array.isArray(over.error.detail.blocks) && over.error.detail.blocks.length, 'есть разбивка по блокам');
  const row = over.error.detail.blocks.find((b) => b.id === 'git.auditor');
  assert.ok(row && row.overhead > 0 && typeof row.chars === 'number', 'блок несёт chars/overhead');
  assert.ok(over.error.detail.blocks.some((b) => b.verbatim && b.overhead === 0), 'verbatim-блоки с нулевым overhead');
}

// 12. D-035: маркер Координатора праймится в начале, формат остаётся в конце.
{
  for (const tier of ['full', 'recovery']) {
    const r = PromptCompiler.compile(planRequest({ delivery: { tier } }));
    assert.ok(r.ok, `plan/${tier} компилируется с праймом: ${r.error?.message}`);
    assert.equal(r.blocks[0].id, 'coordinator.prime', 'прайм — первый блок');
    assert.ok(r.text.split('\n')[0].includes('маркером последней строкой'), 'первая строка напоминает о маркере');
    assert.ok(r.text.split('\n')[0].includes('в конце промпта'), 'прайм ссылается на формат в конце');
    // ровно один маркер и он последний; прайм не несёт литерал маркера
    const markerBlocks = r.blocks.filter((b) => b.id.startsWith('marker.'));
    assert.equal(markerBlocks.length, 1, 'ровно один marker-блок');
    assert.equal(r.blocks.at(-1).id, 'marker.coordinator', 'маркер — последний блок');
    assert.ok(!r.text.split('\n')[0].includes('CF_COORDINATOR_RESULT'), 'прайм без литерала маркера');
    assert.ok(r.text.trim().split('\n').at(-1).startsWith('CF_COORDINATOR_RESULT'), 'формат маркера в конце');
  }
}

// 13. D-035: исполнитель/аудитор/ревьюер получают адрес папки артефактов, не корень.
{
  for (const fn of ['Executor', 'Auditor', 'Reviewer']) {
    const r = PromptCompiler.compile(dispatchRequest(fn, { drive: { project: 'synapse' } }));
    assert.ok(r.ok, `${fn} компилируется с drive.artifacts`);
    const b = r.blocks.find((x) => x.id === 'drive.artifacts');
    assert.ok(b, `${fn} несёт блок drive.artifacts`);
    assert.ok(r.text.includes('Arena/synapse/artifacts'), `${fn} видит адрес папки artifacts`);
    assert.ok(r.text.includes('не корень Диска'), `${fn} видит запрет корня`);
    assert.ok(!b.verbatim, 'drive.artifacts не verbatim (честный overhead)');
    // drive.layout по-прежнему только Координатору — исполнитель его не получает
    assert.ok(!r.blocks.some((x) => x.id === 'drive.layout'), `${fn} не несёт coordinator drive.layout`);
  }
  // адрес берётся из ctx.drive.project, а не зашит
  const custom = PromptCompiler.compile(dispatchRequest('Auditor', { drive: { project: 'other-proj' } }));
  assert.ok(custom.text.includes('Arena/other-proj/artifacts'), 'project из ctx, не хардкод');
}

// 14. D-036: регрессия K-20 — реальная ДЛИННАЯ зона роли + main-ветка влезают
// в auditor.card без подъёма бюджета. D-035 добавил блоки, но фикстура K-17 была
// с короткой зоной; боевая зона Spec Auditor ~150 зн. и пробила бюджет. Лечение:
// coordinator.prime/drive.artifacts урезаны, marker.agent аудитора не учит pr/merged.
{
  const longZone = 'docs/agents/**, tools/script-cat/**, contracts/**, docs/DECISIONS.md, docs/REGULATION.md, docs/design/**, docs/process/**, docs/agents/roles/**';
  const k20 = dispatchRequest('Auditor', {
    task: { ...task(), title: 'SYN-1 · K-20 · Промежуточный независимый аудит O-8' },
    role: { name: 'Spec Auditor', fn: 'Auditor', zone: longZone },
    target: { repo: 'Creative36711/synapse', baseBranch: 'main' },
  });
  const r = PromptCompiler.compile(k20);
  assert.ok(r.ok, `K-20 с длинной зоной компилируется: ${r.error?.message}`);
  assert.ok(r.metrics.overheadChars <= 2200, `K-20 overhead ${r.metrics.overheadChars} ≤ 2200 без подъёма бюджета`);
  // маркер аудитора не содержит pr/merged — значит, и инструкция их не объясняет
  assert.ok(!r.text.includes('merged:true только после мержа'), 'аудитору не объясняют pr/merged, которых нет в его маркере');
  const exec = PromptCompiler.compile(dispatchRequest('Executor'));
  assert.ok(exec.text.includes('merged:true только после мержа'), 'Executor по-прежнему учит pr/merged');
}

// 15. D-036: длинная зона Координатора + прайм маркера влезают в coordinator.plan.
{
  const longZone = 'docs/agents/**, tools/script-cat/**, contracts/**, docs/DECISIONS.md, docs/REGULATION.md, docs/design/**, docs/process/**, docs/agents/roles/**, docs/adr/**';
  const r = PromptCompiler.compile(planRequest({ role: { name: 'Coordinator', fn: 'Coordinator', zone: longZone } }));
  assert.ok(r.ok, `plan с длинной зоной компилируется: ${r.error?.message}`);
  assert.ok(r.metrics.overheadChars <= 3200, `plan overhead ${r.metrics.overheadChars} ≤ 3200 без подъёма бюджета`);
  assert.equal(r.blocks[0].id, 'coordinator.prime', 'прайм остался первым блоком');
}

console.log('OK: prompts — профили в бюджетах, маркеры/ID верны, пилот изолирован, #37/#38/#40 сохранены, D-034 (K-17, payload-указатель, разбивка бюджета), D-035 (прайм маркера, адрес артефактов), D-036 (K-20 длинная зона)');
