// Проба 1.4.40: Координатор сам распоряжается очередью — включая черновики.
//
// Случай Мастера (2026-10-24). На приёмке NAR-1.8 Координатор написал:
// «старый Draft 1.9 архивирован — перевести Draft в Ready я не вправе», и
// создал такую же карточку заново. Причина была не в правах, а в двух вещах:
//   • в промпте стояло «Ready, Running и Submitted ставит движок» — читается
//     как запрет выдавать существующий черновик;
//   • в строке «Очередь: …» черновиков не было вовсе, то есть Координатор не
//     видел собственный задел (NAR-1.10 лежал Draft и в очереди не появлялся).
//
// Здесь проверяется: права выданы, черновики видны списком, счётчик Draft есть,
// а подсказки на промах говорят «выдай черновик», а не «создайте карточку».

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];

assert.match(src, new RegExp(`@version\\s+${V.replace(/\./g, '\\.')}`), `версия ${V}`);

// ── 1. Промпт: очередь — зона Координатора ─────────────────────────────────
const promptFrom = src.indexOf('  function coordinatorPrompt(');
const promptTo = src.indexOf('  // ───────────────────────────── ход исполнителя', promptFrom);
const prompt = new Function(
  'technicalInfo', 'rt', 'roleContext', 'returnBlock',
  `${src.slice(promptFrom, promptTo)}; return coordinatorPrompt;`,
)(
  () => 'ТЕХНИКА',
  () => 'NAR-1',
  () => 'Ты — Coordinator.',
  // 1.4.44: блок «миссия возвращена» — часть промпта; в этой пробе миссия активна.
  () => '',
)(
  { id: 'mission-1', properties: { 'Миссия': { title: [{ plain_text: 'NAR-1' }] }, 'ТЗ URL': { url: 'https://x' } } },
  { name: 'Coordinator', fn: 'Coordinator' },
  '1 Submitted, 0 Running, 1 Ready, 0 Rework, 2 Draft',
  'turn-1',
  '',
  '',
  'Черновики (предложения — выдаёшь их ты): NAR-1.10 · Регрессия и отчёт (Build/Release, Sequence 100).',
  'Готовы к выдаче: NAR-1.10 · Регрессия и отчёт (Build/Release, Sequence 100).',
);

assert.match(prompt, /1 Submitted, 0 Running, 1 Ready, 0 Rework, 2 Draft/, 'черновики есть в счётчике очереди');
assert.match(prompt, /Черновики \(предложения — выдаёшь их ты\)/, 'черновики перечислены списком');
assert.match(prompt, /выдача черновика \(Draft → Ready\), правка его полей и архив лишнего — твои действия/, 'выдача черновика — право Координатора');
assert.match(prompt, /Мастер и Архитектор пишут только черновики/, 'кто пишет черновики');
assert.match(prompt, /выдавай сам, не дожидаясь Мастера/, 'ждать Мастера не нужно');
assert.match(prompt, /Движок ставит Running и Submitted/, 'граница движка названа точно');
assert.match(prompt, /Rework и Ready ставишь ты/, 'Ready — не движок, а Координатор');
assert.match(prompt, /или Draft → Ready/, 'черновик можно выдать в том же ходе');
assert.match(prompt, /это твой задел/, 'сказано, зачем черновики');
assert.match(prompt, /Готовы к выдаче: NAR-1\.10 · Регрессия и отчёт \(Build\/Release, Sequence 100\)/, 'Ready перечислен с ролью');
assert.match(prompt, /next — имя роли той карточки, которую выдаёшь/, 'адресат берётся из карточки');
assert.match(prompt, /Если роль не может получить работу/, 'видно, что роль не может получить работу');
assert.match(prompt, /Статус роли и Agent URL — зона Мастера/, 'статус роли — не зона Координатора');
assert.doesNotMatch(prompt, /ставит движок\./, 'прежней фразы «Ready … ставит движок» больше нет');
assert.doesNotMatch(prompt, /не вправе|нельзя переводить Draft/i, 'запрета на выдачу черновика нет');

// Технический блок Координатора читается последним: там тоже про выдачу.
const techFrom = src.indexOf('const COORDINATOR_TECH = [');
const techTo = src.indexOf('];', techFrom);
const tech = src.slice(techFrom, techTo);
assert.match(tech, /число Ready и выдача работы — новой карточкой или Draft → Ready/, 'в техблоке Координатора тоже сказано про выдачу');

// ── 2. draftLine: список, а не число ────────────────────────────────────────
const lineFrom = src.indexOf('  function draftLine(cards, known = []) {');
const lineTo = src.indexOf('  async function coordinatorStep(');
assert.ok(lineFrom > 0 && lineTo > lineFrom, 'draftLine на месте');
const draftLine = new Function(
  'C', 'taskTitle', 'taskRole', 'norm',
  `${src.slice(lineFrom, lineTo)}; return draftLine;`,
)(
  { draftLineMax: 2 },
  (card) => card.properties['Запрос'].title[0].text.content,
  (card) => card.properties['Кому']?.select?.name || '',
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
);

const card = (title, who, seq) => ({
  id: title,
  properties: {
    'Запрос': { title: [{ text: { content: title } }] },
    'Кому': { select: who ? { name: who } : null },
    'Sequence': { number: seq },
  },
});

assert.match(draftLine([]), /Черновиков нет/, 'пустой задел назван словами');
assert.match(draftLine([]), /предложи сам/, 'и это не приглашение ждать Мастера');

const two = draftLine(
  [card('NAR-1.10 · Регрессия и отчёт', 'Build/Release', 100), card('NAR-1.9 · Реестр caps', 'Kernel', 90)],
  ['Kernel', 'Build/Release'],
);
assert.match(two, /NAR-1\.9 · Реестр caps \(Kernel, Sequence 90\)/, 'порядок по Sequence, роль и номер видны');
assert.match(two, /NAR-1\.10 · Регрессия и отчёт \(Build\/Release, Sequence 100\)/, 'второй черновик тоже в списке');
assert.ok(two.indexOf('Sequence 90') < two.indexOf('Sequence 100'), 'сначала меньший Sequence');

const three = draftLine([
  card('A · один', 'Kernel', 10),
  card('B · два', 'Kernel', 20),
  card('C · три', 'Kernel', 30),
]);
assert.match(three, /и ещё 1/, 'лишнее сверх лимита свёрнуто');
assert.ok(!/C · три/.test(three), 'свёрнутые не перечисляются');

// Роль не задана — так и пишем, а не пустые скобки.
assert.match(draftLine([card('D · четыре', '', 40)]), /роль не задана/, 'пустая роль названа');

// Строки базы «Роли» целиком: видно, чего именно не хватает.
const row = (name, status, url) => ({ name, status, url });
const DIRECTORY = [
  row('Kernel', 'Активна', 'https://arena.ai/agent/kernel'),
  row('Build/Release', 'Ждёт', 'https://arena.ai/agent/01a16d5c-2b46-7efe-a7e7-06229a0e6ad1'),
  row('Studio', 'Активна', ''),
];

// Агент создан, Agent URL заполнен — не хватает только статуса.
const waiting = draftLine([card('E · пять', 'Build/Release', 50)], DIRECTORY);
assert.match(waiting, /Build\/Release — Статус «Ждёт»/, 'ждать — это статус, а не пустая ссылка');
assert.doesNotMatch(waiting, /Agent URL/, 'заполненный Agent URL не при чём');

// Статус «Активна», но ссылки нет.
assert.match(
  draftLine([card('F · шесть', 'Studio', 60)], DIRECTORY),
  /Studio — нет Agent URL/,
  'пустая ссылка названа своим словом',
);

// Роли нет в базе вовсе — это не «не активна», а опечатка или новая роль.
assert.match(
  draftLine([card('G · семь', 'UI/UX', 70)], DIRECTORY),
  /UI\/UX — нет в «Ролях»/,
  'отсутствующая роль названа своим словом',
);

// Регистр не мешает сверке.
assert.ok(
  !/Статус|нет Agent URL|нет в «Ролях»/.test(draftLine([card('H · восемь', 'kernel', 80)], DIRECTORY)),
  'регистр роли не мешает сверке',
);

// Без базы ролей не пугаем ложной пометкой.
assert.ok(
  !/Статус|нет Agent URL|нет в «Ролях»/.test(draftLine([card('I · девять', 'Build/Release', 90)], [])),
  'без списка ролей пометки нет',
);

// ── 2a. readyLine: что лежит в Ready — с ролью ─────────────────────────────
const rFrom = src.indexOf('  function readyLine(cards) {');
const rTo = src.indexOf('  async function coordinatorStep(');
assert.ok(rFrom > 0 && rTo > rFrom, 'readyLine на месте');
const readyLine = new Function(
  'C', 'taskTitle', 'taskRole',
  `${src.slice(rFrom, rTo)}; return readyLine;`,
)(
  { readyLineMax: 2 },
  (card) => card.properties['Запрос'].title[0].text.content,
  (card) => card.properties['Кому']?.select?.name || '',
);

assert.match(readyLine([]), /Ready пуст/, 'пустой Ready назван словами');
assert.match(
  readyLine([card('NAR-1.10 · Регрессия и отчёт', 'Build/Release', 100)]),
  /NAR-1\.10 · Регрессия и отчёт \(Build\/Release, Sequence 100\)/,
  'у готовой карточки видно, кому её выдавать',
);
assert.match(readyLine([card('Без роли', '', 10)]), /роль не задана/, 'пустая роль названа');
{
  const many = readyLine([
    card('A · один', 'Kernel', 10),
    card('B · два', 'Kernel', 20),
    card('C · три', 'Kernel', 30),
  ]);
  assert.match(many, /и ещё 1/, 'лишнее сверх readyLineMax свёрнуто');
  assert.ok(!/C · три/.test(many), 'свёрнутые не перечисляются');
  assert.ok(many.indexOf('A · один') < many.indexOf('B · два'), 'порядок по Sequence');
}

// ── 3. queueOf считает Draft ───────────────────────────────────────────────
const qFrom = src.indexOf('  async function queueOf(mission) {');
const qTo = src.indexOf('  function draftLine(cards, known = []) {');
// 1.4.63: очередь запоминает карточки в Rework — по этой памяти транспорт
// снимает следы прошлого ответа при повторной выдаче.
const remembered = [];
const queueOf = new Function(
  'tasks',
  'rememberRework',
  'assertMissionBindings',
  `${src.slice(qFrom, qTo)}; return queueOf;`,
)(
  async (state) =>
    Array.from({ length: { Submitted: 1, Running: 0, Ready: 1, Rework: 1, Draft: 2 }[state] || 0 }, (_, i) => ({
      id: `${state}-${i}`,
    })),
  (cards) => remembered.push(...cards.map((c) => c.id)),
  async () => {},
);

queueOf({ id: 'm1' }).then((queue) => {
  assert.equal(queue.draft.length, 2, 'черновики читаются отдельным запросом');
  assert.equal(queue.summary, '1 Submitted, 0 Running, 1 Ready, 1 Rework, 2 Draft, 0 Blocked', 'счётчик Draft в строке очереди');
  assert.deepEqual(remembered, ['Rework-0'], 'карточка из Rework запомнена для повторной выдачи');

  // ── 4. Ход Координатора передаёт черновики в промпт ──────────────────────
  const planFrom = src.indexOf('  async function requestPlan(');
  const planTo = src.indexOf('  async function dispatchTask(', planFrom);
  const plan = src.slice(planFrom, planTo);
  assert.match(plan, /const drafts = draftLine\(queue\.draft \|\| \[\], directory\);/, 'список черновиков собирается');
  assert.match(plan, /const directory = await roleRows\(\)/, 'и сверяется со всей базой «Роли», а не только с активными');
  assert.match(
    plan,
    /coordinatorPrompt\(\s*mission,\s*role,\s*summary,\s*turnId,\s*note,\s*answerLine,\s*drafts,\s*readyLine\(queue\.ready\),\s*reworkLine\(queue\.rework\),\s*briefing\.openLine,\s*briefing\.answersLine,?\s*\)/s,
    'и уходит в промпт',
  );
  assert.match(plan, /\$\{\(queue\.draft \|\| \[\]\)\.length\} Draft/, 'запасной счётчик тоже знает про Draft');

  // ── 5. Подсказки на промах говорят про черновик, а не «создайте карточку» ─
  const routeFrom = src.indexOf('  function decisionRoute(next,');
  const routeTo = src.indexOf('  /** Свежие счётчики очереди');
  const decisionRoute = new Function(
    'norm',
    `${src.slice(routeFrom, routeTo)}; return decisionRoute;`,
  )((x) => String(x || '').replace(/-/g, '').toLowerCase());

  const roles = [{ name: 'Coordinator', fn: 'Coordinator' }, { name: 'Kernel', fn: 'Executor' }];

  const ask = decisionRoute('Kernel', { roles, readyRoles: [] });
  assert.equal(ask.kind, 'ask', 'нет карточки — просим, а не падаем');
  assert.match(ask.note, /переведи в Ready подходящий Draft/, 'подсказка предлагает выдать черновик');

  const again = decisionRoute('Kernel', { roles, readyRoles: [], misses: 1 });
  assert.equal(again.kind, 'pause', 'второй промах — пауза');
  assert.match(again.reason, /Нажмите «Продолжить»/, 'выход — продолжить, а не «создайте карточку»');
  assert.match(again.reason, /создать карточку или выдать черновик/, 'сказано, что он умеет');

  const directory = [
    { name: 'Coordinator', status: 'Активна', url: 'https://arena.ai/agent/c' },
    { name: 'Kernel', status: 'Активна', url: 'https://arena.ai/agent/k' },
    { name: 'Build/Release', status: 'Ждёт', url: 'https://arena.ai/agent/b' },
  ];
  const idle = decisionRoute('Build/Release', { roles, readyRoles: ['Build/Release'], directory });
  assert.equal(idle.kind, 'ask', 'карточка есть, роль не активна — объясняем, а не молчим');
  assert.match(idle.note, /карточка в Ready есть, но выдать её некому — Статус «Ждёт», Agent URL заполнен/, 'причина названа точно');
  assert.match(idle.note, /Статус роли и Agent URL ставит Мастер/, 'сказано, чья это зона');
  assert.match(idle.note, /Активные роли: Coordinator, Kernel/, 'перечислены те, кому выдать можно');
  assert.match(idle.note, /правка черновика — твоё право/, 'Координатор может назначить другую роль');

  const idle2 = decisionRoute('Build/Release', { roles, readyRoles: ['Build/Release'], directory, misses: 1 });
  assert.equal(idle2.kind, 'pause', 'повтор — пауза, а не бесконечный круг');

  const self = decisionRoute('Coordinator', { roles, readyRoles: [] });
  assert.match(self.note, /выдай работу сам/, 'ход вернулся — выдай сам');

  console.log(
    `OK: relay ${V} — Координатор сам создаёт и выдаёт карточки: Draft → Ready, ` +
      'черновики видны списком, считаются в очереди, а причина «выдать некому» названа точно ' +
      '(Статус / нет Agent URL / нет в «Ролях»)',
  );
});
