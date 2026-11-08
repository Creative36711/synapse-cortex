// D-075 на языке кода: гейт укомплектованности миссии, маршрут некомплекта и
// связь с контуром создания агентов.
//
// Решение D-075 записало контракт, но не код: до первой выдачи состав ролей
// никто не проверял, дефект адресата был виден только у черновиков, а нехватка
// роли уезжала Maintainer'у, который её решать не вправе. Здесь проверяется
// поведение, а не строки:
//   • миссия с ролью в статусе «Ждёт» не выдаёт ни одной карточки;
//   • полный состав выдаёт (гейт молчит);
//   • некомплект — класс master, а настоящая поломка доставки — transport;
//   • повторная пауза по тому же некомплекту не зацикливается (ключ стабилен);
//   • при выключенном provisioning поведение прежнее, при включённом —
//     просьба одобрения, а не молчаливое создание;
//   • вариант «Функция» следует за строкой: без строки не появляется.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healApi } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();

// Чистое ядро состава ролей: ни DOM, ни GM, ни сети — исполняется как есть.
const rosterSrc = readFileSync(join(srcDir, '42-roster.js'), 'utf8');
const rosterApi = new Function(
  'norm', 'taskRole',
  `${rosterSrc}
   return { missionRoster, rosterRoleGaps, rosterReason, rosterGate, ROSTER_SOURCE };`,
)(
  norm,
  (card) => card?.properties?.['Кому']?.select?.name || '',
);

// Контур создания: чистые правила кандидатов и запроса по составу.
const provisionCore = readFileSync(join(srcDir, '31-provision-core.js'), 'utf8');
const provisionApi = new Function(
  'norm', 'uid', 'nowIso', 'GM_getValue', 'GM_setValue', 'C', 'K', 'log',
  `${provisionCore}
   return { provisionRosterRequest, provisionCandidateFromRow, PROVISION_FUNCTIONS };`,
)(norm, () => 'id', () => 'now', () => null, () => {}, {}, {}, () => {});

const card = (seq, who) => ({ id: `card-${seq}`, properties: {
  'Запрос': { title: [{ plain_text: `SYN-3 · B${seq}` }] },
  'Кому': who ? { select: { name: who } } : {},
  'Sequence': { number: seq },
} });

const ACTIVE = [
  { name: 'Coordinator', fn: 'Coordinator', status: 'Активна', url: 'https://arena.ai/agent/coord' },
  { name: 'Warden', fn: 'Reviewer', status: 'Активна', url: 'https://arena.ai/agent/warden' },
  { name: 'Executor Core', fn: 'Executor', status: 'Активна', url: 'https://arena.ai/agent/exec' },
];

// ── 1. Миссия с ролью «Ждёт» не выдаёт ни одной карточки ──────────────────
{
  const directory = [...ACTIVE, { name: 'Build/Release', fn: 'Executor', status: 'Ждёт', url: '' }];
  const cards = [card(1, 'Executor Core'), card(2, 'Build/Release')];
  const gate = rosterApi.rosterGate(cards, { directory, recipientOptions: ['Executor Core', 'Build/Release'] });
  assert.equal(gate.ok, false, 'некомплект останавливает выдачу целиком, а не только «свою» карточку');
  assert.equal(gate.kind, 'mission-roster', 'вид паузы назван по решению');
  assert.equal(gate.cls, 'master', 'класс — master: это решение Мастера');
  assert.match(gate.reason, /Build\/Release/, 'недостающая роль названа');
  assert.match(gate.reason, /Статус «Ждёт»/, 'назван настоящий статус, а не «роли нет»');
  assert.match(gate.reason, /дозаполните существующую строку/, 'сказано: агента создавать не нужно');
  assert.doesNotMatch(gate.reason, /создайте агента/, 'нет ложного совета создавать второго агента');
}

// ── 2. Полный состав выдаёт ────────────────────────────────────────────────
{
  const cards = [card(1, 'Executor Core'), card(2, 'Warden'), card(3, '')];
  const gate = rosterApi.rosterGate(cards, { directory: ACTIVE, recipientOptions: ['Executor Core'] });
  assert.equal(gate.ok, true, 'полный состав — гейт молчит');
  assert.equal(gate.pause, null);
  assert.equal(gate.roster.roles.length, 2, 'карточка без «Кому» в состав не попадает: её выдаёт Координатор');
  assert.deepEqual(rosterApi.rosterGate([], { directory: ACTIVE }).ok, true, 'пустая миссия — не некомплект');
}

// ── 3. Три разных случая — три разных слова ───────────────────────────────
{
  const onlyStrings = rosterApi.rosterReason(rosterApi.missionRoster([card(1, 'Ghost')], { directory: ACTIVE }));
  assert.match(onlyStrings, /нет.*— создайте агента в Arena/, 'роли нет → создать агента');
  assert.match(onlyStrings, /«Статус» = «Активна»/, 'и что поставить после создания');

  const inactive = rosterApi.rosterReason(rosterApi.missionRoster([card(1, 'Build/Release')], {
    directory: [...ACTIVE, { name: 'Build/Release', fn: 'Executor', status: 'Ждёт', url: 'https://arena.ai/agent/b' }],
  }));
  assert.match(inactive, /дозаполните существующую строку/, 'строка есть, но не активна → дозаполнить');

  // «Активна и URL заполнен», но функция не рабочая — третий случай.
  const wrongFn = rosterApi.rosterReason(rosterApi.missionRoster([card(1, 'Coordinator')], {
    directory: [...ACTIVE, { name: 'Coordinator', fn: 'Coordinator', status: 'Активна', url: 'https://arena.ai/agent/coord' }],
  }));
  assert.equal(wrongFn, '', 'роль активна с URL — дефекта нет, даже если функция не рабочая');

  const inactiveRow = rosterApi.rosterReason(rosterApi.missionRoster([card(1, 'Helpdesk')], {
    directory: [{ name: 'Helpdesk', fn: '', status: 'Активна', url: 'https://arena.ai/agent/h' }],
  }));
  assert.match(inactiveRow, /проверьте «Функцию» и «Зону записи»/, 'роль активна, но функция пуста — третий текст');
}

// ── 4. Рабочая роль без варианта «Кому» — тоже некомплект ─────────────────
{
  const roster = rosterApi.missionRoster([card(1, 'Executor Core')], { directory: ACTIVE, recipientOptions: [] });
  assert.equal(roster.ok, true, 'пустой список вариантов не считается доказательством: схему мог не прочитать запрос');
  const strict = rosterApi.missionRoster([card(1, 'Executor Core')], {
    directory: ACTIVE, recipientOptions: ['Warden'],
  });
  assert.equal(strict.ok, false, 'имени нет в вариантах «Кому» — карточку не выдать');
  assert.match(strict.broken[0].gaps.join(','), /вариантах «Кому»/);
}

// ── 5. Повторная пауза не зацикливается: ключ некомплекта стабилен ────────
{
  const directory = [...ACTIVE, { name: 'Build/Release', fn: 'Executor', status: 'Ждёт', url: '' }];
  const a = rosterApi.missionRoster([card(1, 'Build/Release'), card(2, 'Ghost')], { directory: directory });
  const b = rosterApi.missionRoster([card(9, 'Ghost'), card(4, 'Build/Release')], { directory: directory });
  assert.equal(a.key, b.key, 'тот же некомплект — тот же ключ, даже при другом порядке и других карточках');
  const fixed = rosterApi.missionRoster([card(1, 'Build/Release')], {
    directory: [...ACTIVE, { name: 'Build/Release', fn: 'Executor', status: 'Активна', url: 'https://arena.ai/agent/b' }],
  });
  assert.notEqual(fixed.key, a.key, 'после устранения ключ меняется');
  assert.equal(fixed.key, '', 'и некомплекта больше нет');
  assert.equal(a.source, 1, 'версия правил названа: смена поведения не пройдёт молча');
}

// ── 6. Маршрут: некомплект — master, поломка доставки — transport ─────────
{
  // Настоящая поломка доставки: очередь и ожидание адресованы разным агентам.
  const delivery = healApi.classifyPause('reviewer-task-check',
    'Ожидание и очередь адресованы разным агентам. Оба сохранены; проверьте чат и Run ID.');
  assert.equal(delivery.cls, 'transport', 'потеря доставки по-прежнему уходит Maintainer-у');
  assert.equal(delivery.by, 'label');

  const lost = healApi.classifyPause('reviewer-task-pending',
    'В очереди осталась рабочая карточка Reviewer от прежней версии. Не отправляю её.');
  assert.equal(lost.cls, 'transport', 'остаток прошлой версии — тоже доставка');

  // Некомплект: адресат не подтверждён среди активных, роль неактивна, нет варианта.
  const roster = healApi.classifyPause('reviewer-task-check',
    'Адресат рабочей очереди не найден среди активных Executor/Auditor или его функция изменилась. Очередь сохранена.');
  assert.equal(roster.cls, 'master', 'некомплект ролей — решение Мастера, а не поломка транспорта');
  assert.equal(roster.route, 'master');
  assert.equal(roster.by, 'roster', 'видно, что класс взят по тексту причины, а не по виду паузы');
  assert.equal(roster.maintainer, false, 'ход Maintainer-у не уходит');

  const staleRow = healApi.classifyPause('reviewer-task-pending',
    'Старая выдача Reviewer или её адресат не подтверждены: «Статус» = «Ждёт».');
  assert.equal(staleRow.cls, 'master', 'роль в статусе «Ждёт» — не работа транспорта');

  // Вид паузы самого гейта — master по таблице, а не по тексту.
  const gate = healApi.classifyPause('mission-roster', 'Роль «Build/Release» в «Ролях» есть, но «Статус» = «Ждёт».');
  assert.equal(gate.cls, 'master');
  assert.equal(gate.maintainer, false);
  assert.equal(healApi.decideHeal(gate, {}).action, 'master', 'автопродолжения и передачи у некомплекта нет');

  // И таблица по-прежнему сходится с кодом: mission-roster действительно стоит в коде.
  const legacy = readFileSync(join(srcDir, '25-legacy-adr.js'), 'utf8');
  assert.match(legacy, /kind: "mission-roster"/, 'вид паузы mission-roster ставится в коде, а не выдуман таблицей');
}

// ── 7. Контур создания: выключен — прежнее поведение; включён — одобрение ─
{
  const broken = rosterApi.missionRoster([card(1, 'Build/Release')], { directory: ACTIVE }).broken;

  const off = provisionApi.provisionRosterRequest(broken, { agentProvisionEnabled: false }, null);
  assert.equal(off.enabled, false);
  assert.equal(off.create.length, 1, 'строка нужна и при выключенном контуре');
  assert.match(off.reason, /Мастер/, 'создание агента остаётся Мастеру');
  assert.equal(off.signalOwner, 'Coordinator', 'сигнал ставит Coordinator, а не Мастер');

  const on = provisionApi.provisionRosterRequest(broken, { agentProvisionEnabled: true }, null);
  assert.equal(on.enabled, true);
  assert.equal(on.create[0].signal, 'Agent State = запрошен', 'сигнал назван полем, а не «Статус = Ждёт»');
  assert.match(on.reason, /одобрение/, 'дальше — просьба одобрения админ-роли, а не молчаливое создание');
  assert.doesNotMatch(on.reason, /создаю|создан/, 'ничего не создаётся само');

  // Гейт соединяет состав с контуром: пауза говорит, что запрос на создание есть.
  const plan = provisionApi.provisionRosterRequest(broken, { agentProvisionEnabled: true },
    { candidates: [{ roleName: 'Build/Release' }] });
  assert.equal(plan.requested, true, 'кандидат в выданном запросе виден');
  const gateWithRequest = rosterApi.rosterGate([card(1, 'Build/Release')], {
    directory: ACTIVE, provision: plan,
  });
  assert.match(gateWithRequest.reason, /Запрошено создание роли «?Build\/Release/, 'пауза говорит, что запрос уже выдан');
  assert.match(gateWithRequest.reason, /ждём одобрения/, 'и чего именно ждём');

  const gateWithoutRequest = rosterApi.rosterGate([card(1, 'Build/Release')], {
    directory: ACTIVE, provision: provisionApi.provisionRosterRequest(broken, { agentProvisionEnabled: true }, null),
  });
  assert.doesNotMatch(gateWithoutRequest.reason, /ждём одобрения/, 'без выданного запроса пауза не обещает одобрения');
}

// ── 8. Админ-роли и роли вне allowlist по-прежнему отвергаются ────────────
{
  const cfg = { agentProvisionEnabled: true, agentProvisionRepoAllowlist: ['creative36711/synapse'], agentProvisionMaxJobs: 3 };
  const row = (over = {}) => ({
    pageId: 'a709d6df-4698-4a98-b111-90d22de42894', id: 'agent-1', name: 'Build/Release', fn: 'Executor',
    status: 'Ждёт', url: '', repo: 'Creative36711/synapse', agentAdmin: false, agentState: 'запрошен', ...over,
  });
  assert.equal(provisionApi.provisionCandidateFromRow(row(), cfg).ok, true, 'обычная строка — кандидат');
  assert.match(provisionApi.provisionCandidateFromRow(row({ agentAdmin: true }), cfg).reason,
    /админ-роль/, 'админ-роль отвергается');
  assert.match(provisionApi.provisionCandidateFromRow(row({ repo: 'evil/repo' }), cfg).reason,
    /allowlist/, 'репозиторий вне allowlist отвергается');
  assert.match(provisionApi.provisionCandidateFromRow(row({ agentState: 'не требуется' }), cfg).reason,
    /Agent State не запрошен/, 'без сигнала кандидата нет');
  assert.match(provisionApi.provisionCandidateFromRow(row({ fn: 'Maintainer' }), cfg).reason,
    /недопустимая функция/, 'Maintainer контуром не создаётся (D-074 п. 7)');
  assert.equal(provisionApi.PROVISION_FUNCTIONS.includes('Maintainer'), false, 'и в списке функций его нет');
}

// ── 9. Пункт 2: дефект адресата виден у Ready и Rework, а не только у Draft ─
{
  const adr = readFileSync(join(srcDir, '25-legacy-adr.js'), 'utf8');
  assert.match(adr, /function readyLine\(cards, known = \[\]\)/, 'readyLine получает список ролей');
  assert.match(adr, /function reworkLine\(cards, known = \[\]\)/, 'reworkLine получает список ролей');
  assert.match(adr, /function roleDefect\(/, 'разбор дефекта один для всех трёх списков');
  assert.match(adr, /readyLine\(queue\.ready, directory\)/, 'список ролей действительно передаётся');
  assert.match(adr, /reworkLine\(queue\.rework, directory\)/);
  // Промпт Координатора: обязанность сверки — в блоке queue.coordinator.
  const blocks = readFileSync(join(srcDir, 'prompt-blocks.js'), 'utf8');
  const queueLine = blocks.slice(blocks.indexOf('def("queue.coordinator"'));
  const body = queueLine.slice(0, queueLine.indexOf('\n    def('));
  assert.match(body, /Состав ролей сверяй до выдачи/, 'обязанность записана в блоке очереди Координатора');
  assert.match(body, /Agent State = запрошен/, 'и сигнал на создание назван там же');
  assert.match(body, /Статус\/Agent URL — Мастер/, 'и граница прав не размыта');
  // Файл роли Координатора говорит то же самое словами (D-075 п. 2).
  const role = readFileSync(join(here, '..', '..', '..', 'docs', 'agents', 'roles', 'coordinator.md'), 'utf8');
  assert.match(role, /Укомплектованность миссии/, 'в роли Координатора есть раздел об укомплектованности');
  assert.match(role, /Agent State = запрошен/, 'и сигнал на создание');
}

console.log('OK: D-075 — некомплект не выдаёт карточек, полный состав выдаёт, master против transport различаются, ' +
  'повторная пауза устойчива, контур просит одобрения вместо молчаливого создания, вариант «Функция» следует за строкой');
