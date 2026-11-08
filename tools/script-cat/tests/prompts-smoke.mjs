// Конструктор промптов: профили, бюджеты, маркеры, изоляция пилота, покрытие
// ruleId и инварианты #37/#38/#40. Источник истины — src/prompt-*.js.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  PromptCompiler, PROMPT_PROFILES, PROMPT_BLOCKS,
  dispatchRequest, planRequest, reviewRequest, answerRequest, reminderRequest, pilotRequest,
  UUID, task, role,
} from './helpers/prompt-env.mjs';

const BUDGETS = {
  'executor.card': 2800, 'auditor.card': 2200, 'coordinator.plan': 3200, 'coordinator.recovery': 1500,
  'reviewer.mission': 2400, 'reviewer.answer': 1800, 'reviewer.card': 2000, 'reminder.marker': 700,
  'reviewer.arbiter': 2400, 'continuation.arbiter': 700,
  'delivery.compact': 1500, 'pilot.synapse': 250,
};
const TOTALS = {
  'executor.card': 8000, 'auditor.card': 5500, 'coordinator.plan': 7500, 'reviewer.mission': 7000,
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

// 15б. D-075/1.14.1: план Координатора собирается на БОЕВЫХ размерах данных.
//
// 08.11 в 00:24 живой SYN-3 встал на budget_exceeded (overhead 3303 > 3200) —
// а проба этого не видела, потому что гоняла короткое имя миссии и короткий ТЗ.
// Факты (имя, id, ссылка на ТЗ, круг) теперь verbatim, как зона роли в D-036:
// бюджет overhead защищает инструкции, а не длину данных Мастера. Здесь
// проверяются именно предельные данные, а не фикстура.
{
  const zone = 'docs/agents/**, tools/script-cat/**, contracts/**, docs/DECISIONS.md, docs/REGULATION.md, docs/design/**, docs/process/**, docs/agents/roles/**, docs/adr/**';
  const longMission = {
    id: '4126f0cf-5705-819c-89c3-c1566cf5b67a',
    name: 'SYN-3 · Транспорт и укомплектованность миссии (D-063…D-075)',
    round: 2, reworkLimit: 3,
    tzUrl: 'https://www.notion.so/creative36711/SYN-3-TZ-1-7-4126f0cf5705819c89c3c1566cf5b67a?pvs=4',
  };
  const live = PromptCompiler.compile(planRequest({ role: { name: 'Coordinator', fn: 'Coordinator', zone }, mission: longMission }));
  assert.ok(live.ok, `боевой SYN-3 собирается: ${live.error?.message}`);
  assert.ok(live.metrics.overheadChars <= 3200, `overhead ${live.metrics.overheadChars} ≤ 3200`);

  // Overhead не должен зависеть от длины данных: иначе следующий длинный URL
  // снова остановит цикл, и снова в самом дорогом месте.
  const short = PromptCompiler.compile(planRequest({ role: { name: 'Coordinator', fn: 'Coordinator', zone } }));
  assert.equal(live.metrics.overheadChars, short.metrics.overheadChars,
    'имя миссии и ссылка на ТЗ не съедают бюджет инструкций');

  const worst = PromptCompiler.compile(planRequest({
    role: { name: 'Coordinator', fn: 'Coordinator', zone },
    mission: { ...longMission, name: 'X'.repeat(200), tzUrl: `https://www.notion.so/creative36711/${'Y'.repeat(200)}` },
  }));
  assert.ok(worst.ok, `предельные данные тоже собираются: ${worst.error?.message}`);
  // Общий предел от этого не отменён: жёсткий лимит считает весь текст.
  // Жёсткий лимит задаётся доставкой (в бою его ставит compileOrPause через
  // forDelivery); проверяем именно его, а не надежду на «и так упадёт».
  const tooBig = PromptCompiler.compile(planRequest({
    role: { name: 'Coordinator', fn: 'Coordinator', zone },
    mission: { ...longMission, name: 'X'.repeat(9000) },
    delivery: { tier: 'full', hardLimit: 9000 },
  }));
  assert.equal(tooBig.ok, false, 'жёсткий общий предел по-прежнему работает');
  assert.equal(tooBig.error.code, 'budget_exceeded');
}

// 15в. D-075/1.14.2: total-лимит действует на всех путях, а не только на выдаче.
//
// В телеметрии 08.11 боевой план Координатора пришёл 7271 знак, и ничто, кроме
// overhead, его не ограничивало: `hardLimit` передавал только путь выдачи
// (`DISPATCH_TOTAL` в 21-prompts.js), а план, приёмка, ответ и напоминание
// собирались без общего предела. Значения при этом были записаны в
// docs/agents/protocol.md — код их просто не применял.
{
  const limits = { Executor: 8000, Auditor: 5500, Coordinator: 7500, Reviewer: 7000 };
  for (const [fn, limit] of Object.entries(limits)) {
    assert.equal(PromptCompiler.totalLimit({ role: { fn } }, 'x'), limit, `${fn}: предел из протокола`);
  }
  // Боевой план из телеметрии — 7271 — обязан влезать: документированный
  // предел Coordinator 7500, и правка не должна ломать живую работу.
  const live = planRequest({
    mission: { id: '4126f0cf-5705-819c-89c3-c1566cf5b67a', name: 'SYN-3 · Транспорт', round: 1, reworkLimit: 3 },
    role: { name: 'Coordinator', fn: 'Coordinator', zone: 'a/**' },
    queue: { summary: '0 Submitted, 0 Running, 1 Ready', ready: 'Готовы: ' + 'X'.repeat(1030), answersLine: 'О'.repeat(2770) },
  });
  const ok = PromptCompiler.compile(live);
  assert.ok(ok.ok, `боевой план собирается: ${ok.error?.message}`);
  assert.ok(ok.metrics.chars <= 7500, `боевой план ${ok.metrics.chars} ≤ 7500`);

  // А предел обязан срабатывать без всякого `delivery.hardLimit`.
  const tooBig = PromptCompiler.compile(planRequest({
    role: { name: 'Coordinator', fn: 'Coordinator', zone: 'a/**' },
    queue: { summary: 's', answersLine: 'О'.repeat(9000) },
  }));
  assert.equal(tooBig.ok, false, 'план без общего предела больше не собирается молча');
  assert.equal(tooBig.error.code, 'budget_exceeded');
  assert.equal(tooBig.error.detail.limit, 7500, 'назван именно предел роли');

  // Явный hardLimit вызывающего по-прежнему главнее (путь выдачи с payload).
  assert.equal(PromptCompiler.totalLimit({ role: { fn: 'Executor' }, delivery: { hardLimit: 4000 } }, 'executor.card'), 4000,
    'явный предел вызывающего не перетирается');
  // Ответ на вопрос везёт сам вопрос целиком (до 12000), поэтому его предел
  // считается про инструкции и не равен «Answer ≤6000» по тексту.
  const answer = PromptCompiler.compile(answerRequest({ question: { id: 'q', turnId: 't', text: 'Вопрос', fullText: 'В'.repeat(9000), fallback: 'A' } }));
  assert.ok(answer.ok, `длинный вопрос доезжает: ${answer.error?.message}`);
  assert.ok(answer.metrics.chars <= 14000);
}

// 16. D-038: регрессия K-21 — реальная длинная зона Executor Core влезает в
// executor.card без подъёма бюджета. D-036 закрыл auditor.card и plan, но
// executor.card с длинной зоной не проверялся; боевая зона ~158 зн. пробила
// бюджет (2859 > 2800). Лечение: зона роли вынесена в verbatim-блок role.zone
// (факт, как task.scope) и не входит в overhead; authority.core несёт только
// правило о зонах; команда мержа не дублируется в authority.executor.
{
  const longZone = 'src/core/**, src/schema/**, src/i18n/**, tools/notice-verifier/**, contracts/**, docs/design/core/**, docs/decisions/**, package.json, NOTICE, tsconfig.json';
  const k21 = dispatchRequest('Executor', {
    task: { ...task(), title: 'SYN-1 · K-21 · Исправить offline NOTICE verifier без потери атрибуций' },
    role: { name: 'Executor Core', fn: 'Executor', zone: longZone },
    target: { repo: 'Creative36711/synapse', baseBranch: 'main' },
  });
  const r = PromptCompiler.compile(k21);
  assert.ok(r.ok, `K-21 с длинной зоной компилируется: ${r.error?.message}`);
  assert.ok(r.metrics.overheadChars <= 2800, `K-21 overhead ${r.metrics.overheadChars} ≤ 2800 без подъёма бюджета`);
  assert.ok(r.text.includes('Зона роли:') && r.text.includes(longZone), 'зона роли видна исполнителю целиком');
  assert.equal(r.blocks.find((b) => b.id === 'role.zone')?.verbatim, true, 'зона — verbatim-факт, не overhead');
  assert.ok(r.text.includes('merged:true только после мержа'), 'Executor по-прежнему учит pr/merged');
  assert.match(r.text, /gh pr merge <N> --squash/, 'команда мержа осталась в git.executor');
  // Overhead не зависит от длины зоны: зона — verbatim-факт, запас не съедается.
  const longer = PromptCompiler.compile(dispatchRequest('Executor', {
    task: { ...task(), title: 'SYN-1 · K-21 · Исправить offline NOTICE verifier без потери атрибуций' },
    role: { name: 'Executor Core', fn: 'Executor', zone: `${longZone}, docs/adr/**, tools/**, src/**` },
    target: { repo: 'Creative36711/synapse', baseBranch: 'main' },
  }));
  assert.ok(longer.ok, 'ещё более длинная зона компилируется');
  assert.equal(longer.metrics.overheadChars, r.metrics.overheadChars, 'overhead не зависит от длины зоны (verbatim)');
}

// 17. D-039: боевая K-21 с крупным оракулом (total > 6500) доставляется после
// подъёма total-лимита Executor до 7500. Overhead уже lean (D-038), избыток —
// подлинный контент задачи (оракул/инварианты), который не режется молча (D-034).
// Боевой путь: DISPATCH_TOTAL.Executor=7500, softLimit 6000 → карточка между
// лимитами уходит стратегией compact с ТЕМ ЖЕ полным контентом (delivery-smoke §2).
{
  // Лимит проверяется боевой функцией доставки: она берёт hardLimit из
  // DISPATCH_TOTAL.Executor, а не из текста исходника.
  const srcPrompts = readFileSync(new URL('../src/21-prompts.js', import.meta.url), 'utf8');
  const total = new Function(`${srcPrompts.slice(srcPrompts.indexOf('  const DISPATCH_TOTAL'), srcPrompts.indexOf('\n', srcPrompts.indexOf('  const DISPATCH_TOTAL')))}return DISPATCH_TOTAL;`)();
  assert.equal(total.Executor, 8000, 'DISPATCH_TOTAL.Executor поднят до 8000 (D-048)');
  assert.equal(total.Auditor, 5500, 'Auditor не менялся');
  assert.equal(total.Reviewer, 7000, 'Reviewer не менялся');
  // Собранный скрипт — то, что реально работает у Мастера: лимит в бандле
  // обязан совпадать с исходником, иначе правка живёт только в репозитории.
  const bundle = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
  const bundled = new Function(`${bundle.slice(bundle.indexOf('  const DISPATCH_TOTAL'), bundle.indexOf('\n', bundle.indexOf('  const DISPATCH_TOTAL')))}return DISPATCH_TOTAL;`)();
  assert.deepEqual(bundled, total, 'в relay.user.js те же лимиты, что в исходнике');
  const longZone = 'src/core/**, src/schema/**, src/i18n/**, tools/notice-verifier/**, contracts/**, docs/design/core/**, docs/decisions/**, package.json, NOTICE, tsconfig.json';
  const big = {
    ...task(),
    title: 'SYN-1 · K-21 · Исправить offline NOTICE verifier без потери атрибуций',
    intent: 'Починить offline-верификатор NOTICE так, чтобы он проверял атрибуции без сети и не терял ни одной записи.',
    invariants: 'Существующие атрибуции сохраняются дословно; порядок записей не меняется; verifier работает полностью offline; ни одна лицензия не теряется; поведение остальных проверок не меняется. '.repeat(8),
    acceptance: 'node tools/notice-verifier/verify.mjs --offline возвращает 0; количество атрибуций в NOTICE равно количеству в реестре (253); grep -c attributions = 253; ни одна строка не потеряна; отчёт с SHA и кодом возврата; каждая проверка закрыта командой или артефактом. '.repeat(8),
    scope: 'tools/notice-verifier/**, NOTICE, docs/design/core/notice.md',
    freedom: 'Структуру проверки выбирает исполнитель, если инварианты соблюдены.',
  };
  const req = dispatchRequest('Executor', { task: big, role: { name: 'Executor Core', fn: 'Executor', zone: longZone } });
  const full = PromptCompiler.compile({ ...req, delivery: { tier: 'full', hardLimit: 0 } });
  assert.ok(full.metrics.chars > 6500, `карточка ${full.metrics.chars} больше старого лимита 6500 — подъём был нужен`);
  assert.ok(full.metrics.chars <= 8000, `карточка ${full.metrics.chars} в новом лимите 8000`);
  // Старый лимит давал паузу (боевой инцидент 16:52:10).
  const old = PromptCompiler.forDelivery(req, { softLimit: 6000, hardLimit: 6500, payloadChannel: false });
  assert.equal(old.strategy, 'pause', 'со старым лимитом 6500 карточка не собиралась');
  // Новый лимит доставляет карточку целиком, оракул и инварианты не порезаны.
  const d = PromptCompiler.forDelivery(req, { softLimit: 6000, hardLimit: 8000, payloadChannel: false });
  assert.notEqual(d.strategy, 'pause', 'K-21 доставляется, а не пауза');
  assert.ok(d.envelope.metrics.chars <= 8000, 'доставка в лимите 8000');
  assert.ok(d.envelope.text.includes(big.acceptance.trim()), 'оракул не порезан');
  assert.ok(d.envelope.text.includes(big.invariants.trim()), 'инварианты не порезаны');
}

// 17б. D-072: агенту сказано, что вариант по умолчанию пишется целиком.
// Раньше транспорт молча требовал ≤200 знаков, а промпт об этом не говорил:
// 08.11 в 20:01 боевой SYN-3 дал полный вариант в 260 знаков и получил паузу
// «ничего не усекал и приёмке не передал».
{
  const plan = PromptCompiler.compile(planRequest()).text;
  assert.match(plan, /длина не ограничена/, 'правило вопроса называет отсутствие предела');
  assert.match(plan, /пиши его целиком/, 'и велит писать вариант полностью');
}

// 18. D-048: боевая K-43 «комментарий к примеру» встала на 7802 > 7500 —
// оракул 2541, намерение 944, Scope 747, инварианты 642. Карточка делает правку
// в один абзац, дробить её не за что: лимит 8000, оракул по-прежнему verbatim.
{
  const sizeUp = (text, target) => {
    let out = String(text);
    while (out.length < target) out += ' Проверка повторяется на том же SHA? ';
    return out;
  };
  const k43 = {
    ...task(),
    title: 'SYN-1 · K-43 · Возврат 1: снять устаревший комментарий examples/cycle.game.yaml (F-1 аудита K-41)',
    intent: sizeUp('Снять устаревший комментарий к примеру.', 944),
    invariants: sizeUp('YAML-данные не меняются.', 642),
    acceptance: sizeUp('grep -n на main не находит старой формулировки.', 2541),
    scope: sizeUp('examples/cycle.game.yaml', 747),
    freedom: '',
  };
  const req = dispatchRequest('Executor', { task: k43 });
  const full = PromptCompiler.compile({ ...req, delivery: { tier: 'full', hardLimit: 0 } });
  assert.ok(full.metrics.chars > 7500, `карточка ${full.metrics.chars} больше прежнего лимита — 06.11 она встала в паузу`);
  assert.ok(full.metrics.chars <= 8000, `карточка ${full.metrics.chars} в лимите 8000`);
  assert.equal(
    PromptCompiler.forDelivery(req, { softLimit: 6000, hardLimit: 7500, payloadChannel: false }).strategy,
    'pause',
    'со старым лимитом 7500 карточка не собиралась (боевой инцидент 20:19)',
  );
  const d = PromptCompiler.forDelivery(req, { softLimit: 6000, hardLimit: 8000, payloadChannel: false });
  assert.notEqual(d.strategy, 'pause', 'с лимитом 8000 доставляется');
  assert.ok(d.envelope.text.includes(k43.acceptance.trim()), 'оракул не порезан');
  assert.ok(d.envelope.text.includes(k43.invariants.trim()), 'инварианты не порезаны');
}

// 19. D-049: арбитраж петли — профиль и продолжение в бюджетах, ID карточки,
// остановка цикла не подставлена по умолчанию, ничего «делающего» у арбитра нет.
{
  const arbiter = (over = {}) => ({
    kind: 'arbiter', role: role('Reviewer', { name: 'Warden' }),
    mission: { id: UUID.mission, name: 'SYN-2 · Мини-игра арены' },
    turnId: UUID.turn,
    arbiter: { cardId: UUID.dispatch, cardTitle: 'SYN-2 · S-4 · Мини-игра арены',
      redispatchCount: 3, redispatchLimit: 3, windowHours: 6, reason: 'её видели в Rework',
      state: 'Ready', check: 'fail', answer: 'Scope blocker — не готов к мержу.',
      pr: 'https://github.com/Creative36711/synapse/pull/26', prState: 'draft, открыт',
      attempts: '07.11 12:05 · dispatch · executor.card · Rework', queue: '1 Ready, 1 Rework' },
    delivery: { tier: 'full' }, ...over,
  });
  const r = PromptCompiler.compile(arbiter());
  assert.ok(r.ok, `reviewer.arbiter компилируется: ${r.error?.message}`);
  assert.equal(r.profileId, 'reviewer.arbiter');
  assert.equal(r.marker, 'CF_ARBITER_RESULT', 'маркер арбитража');
  assert.ok(r.metrics.overheadChars <= 2400, `арбитр overhead ${r.metrics.overheadChars} ≤ 2400`);
  assert.ok(r.metrics.chars <= 7000, `арбитр total ${r.metrics.chars} ≤ 7000 (DISPATCH_TOTAL Reviewer)`);
  assert.ok(r.text.includes(UUID.dispatch) && r.text.includes(UUID.turn), 'ID карточки и хода в промпте');
  assert.match(r.text.trim().split('\n').at(-1), /^CF_ARBITER_RESULT \{/, 'маркер — последней строкой');
  assert.ok(!/"verdict":"master"\s*\}$/.test(r.text.trim().split('\n').at(-1)), 'по умолчанию не master');
  for (const id of ['git.executor', 'task.assignment', 'queue.coordinator']) {
    assert.ok(!r.blocks.some((b) => b.id === id), `арбитр без блока ${id}`);
  }
  // Продолжение после tool-call limit — тот же ход и те же ID.
  const cont = PromptCompiler.compile(arbiter({ delivery: { tier: 'tool_limit' } }));
  assert.ok(cont.ok, `continuation.arbiter компилируется: ${cont.error?.message}`);
  assert.equal(cont.profileId, 'continuation.arbiter');
  assert.ok(cont.metrics.overheadChars <= 700, `продолжение ${cont.metrics.overheadChars} ≤ 700`);
  assert.ok(cont.text.includes(UUID.dispatch) && cont.text.includes(UUID.turn), 'продолжение с теми же ID');
  // Карточка обязательна: разбор без неё не выдаётся.
  const broken = PromptCompiler.compile(arbiter({ arbiter: {} }));
  assert.equal(broken.error.code, 'missing_fact', 'без cardId — missing_fact');
}

console.log('OK: prompts — профили в бюджетах, маркеры/ID верны, пилот изолирован, #37/#38/#40 сохранены, D-034 (K-17, payload-указатель, разбивка бюджета), D-035 (прайм маркера, адрес артефактов), D-036 (K-20 длинная зона), D-038 (K-21 зона Executor — verbatim), D-039 (K-21 total Executor 7500), D-048 (K-43 total Executor 8000, оракул verbatim), D-049 (арбитраж петли в бюджетах)');
