// Проба хода Координатора: приёмка и выдача — один ответ, а не два.
//
// Случай Мастера (2026-10-23, 18:55): Coordinator принял NAR-1.1 и честно
// ответил next:"Coordinator", оставив очередь пустой. Скрипт 1.4.14 на такое
// решение падал в паузу «Координатор направил ход в «Coordinator», но
// Ready-карточки нет» — то есть наказывал за аккуратный ответ.
//
// Здесь проверяется 1.4.19: ход возвращается Координатору сам, с подсказкой
// закончить ход, а промпт требует приёмку и выдачу в одном ответе.
// Плюс (49): Координатор получает ссылку на журнал ответа, который принимает.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Промпт: законченный ход, а не «ровно одно действие» (компилятор) ────
const { PromptCompiler, planRequest } = await import('./helpers/prompt-env.mjs');
const draftText = 'Черновики: NAR-1.10 · Регрессия и отчёт (Build/Release, Sequence 100).';
const prompt = PromptCompiler.compile(planRequest({ queue: { summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework', draft: draftText } })).text;

assert.match(prompt, /незаконченный ход/, 'пустая очередь — незаконченный ход');
assert.match(prompt, /next — имя роли выдаваемой карточки или done/, 'next должен называть исполнителя');
assert.match(prompt, /CF_COORDINATOR_RESULT/, 'маркер на месте');
assert.match(prompt, /NAR-1\.10 · Регрессия и отчёт/, 'черновики видны Координатору списком');
assert.match(prompt, /Нарезка|нарезка/, 'выдача — работа Координатора');
assert.match(prompt, /Accepted\/Rework\/Ready — ты/, 'Ready — право Координатора');
assert.match(prompt, /Draft→Ready/, 'черновик можно выдать, а не пересоздавать');
assert.ok(!/перевести Draft в Ready[^.]*не вправе/.test(prompt), 'запрета на выдачу черновика нет');

// ── 1a. Журнал ответа: ссылку получает Координатор, а не исполнитель ────────
const lineFrom = src.indexOf('  /** Ссылка на журнал последнего ответа');
const lineTo = src.indexOf('  function coordinatorPrompt(');
assert.ok(lineFrom > 0 && lineTo > lineFrom, 'answerLogLine на месте');
const answerLogLine = new Function(
  'rt', 'taskTitle', 'taskRole',
  `${src.slice(lineFrom, lineTo)}; return answerLogLine;`,
)(
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (card) => (card.properties['Запрос']?.title || []).map((x) => x.plain_text).join(''),
  (card) => card.properties['Кому']?.select?.name || '',
);

const cardAt = (id, who, logId, at) => ({
  properties: {
    'Запрос': { title: [{ plain_text: id }] },
    'Кому': { select: { name: who } },
    'Output Drive File ID': { rich_text: [{ plain_text: logId }] },
    'Submitted At': { date: { start: at } },
  },
});
const submitted = [
  cardAt('NAR-1.1 · Карта ядра', 'Architect', 'LOG1', '2026-10-23T15:00:00Z'),
  cardAt('NAR-1.2 · Контекст и страж графа', 'Kernel', 'LOG2', '2026-10-23T16:26:00Z'),
];
const answerLine = answerLogLine(submitted);
assert.match(
  answerLine,
  /^Журнал ответа Kernel \(NAR-1\.2\): https:\/\/drive\.google\.com\/file\/d\/LOG2\/view — прочитай, если нужны детали ответа\.$/,
  'ссылка ведёт на журнал последнего ответа, а не первого',
);
assert.equal(answerLogLine([]), '', 'нет Submitted — нет строки');
assert.equal(answerLogLine([{ properties: {} }]), '', 'карточка без журнала не даёт строку');

const promptWithLine = PromptCompiler.compile(planRequest({ queue: { summary: '1 Submitted, 0 Running, 0 Ready, 0 Rework', answerLine } })).text;
assert.ok(promptWithLine.includes(answerLine), 'строка с журналом попала в промпт Координатора');
assert.doesNotMatch(prompt, /drive\.google\.com\/file/, 'без Submitted строки в промпте нет');

// ── 2. Маршрутизация решения ───────────────────────────────────────────────
const routeFrom = src.indexOf('  function decisionRoute(next,');
const routeTo = src.indexOf('  /** Свежие счётчики очереди');
assert.ok(routeFrom > 0 && routeTo > routeFrom, 'decisionRoute на месте');
const decisionRoute = new Function(
  'norm',
  `${src.slice(routeFrom, routeTo)}; return decisionRoute;`,
)((x) => String(x || '').replace(/-/g, '').toLowerCase());

const roles = [
  { name: 'Coordinator', fn: 'Coordinator' },
  { name: 'Architect', fn: 'Executor' },
  { name: 'Kernel', fn: 'Executor' },
];

// 2.1. Сам Координатор — не ошибка, а просьба закончить ход.
{
  const route = decisionRoute('Coordinator', { roles, readyRoles: [] });
  assert.equal(route.kind, 'ask', 'next:Coordinator — не пауза и не отправка');
  assert.match(route.note, /Ход вернулся Координатору/, 'в подсказке сказано, что ход у него');
  assert.match(route.note, /выдай работу сам/, 'подсказка просит выдать карточку');
  assert.match(route.note, /переведи в Ready подходящий Draft/, 'или выдать готовый черновик');
}

// 2.2. Роль есть, карточка готова — отправляем.
assert.deepEqual(
  decisionRoute('Kernel', { roles, readyRoles: ['Kernel'] }),
  { kind: 'dispatch', roleName: 'Kernel' },
  'карточка Ready — ход уходит исполнителю',
);

// 2.3. Роль есть, карточки нет — просим создать, а не падаем.
{
  const route = decisionRoute('Architect', { roles, readyRoles: [] });
  assert.equal(route.kind, 'ask', 'нет карточки — просим, а не падаем');
  assert.match(route.note, /в Ready нет карточки/, 'сказано, чего не хватает');
}

// 2.4. Второй промах подряд — пауза с понятной причиной.
{
  const route = decisionRoute('Architect', { roles, readyRoles: [], misses: 1 });
  assert.equal(route.kind, 'pause', 'второй промах — пауза');
  assert.match(route.reason, /второй раз/, 'причина называет повтор');
}

// 2.5. Неизвестная роль — просим назвать существующую.
{
  const route = decisionRoute('UI/UX', { roles, readyRoles: [] });
  assert.equal(route.kind, 'ask', 'неизвестная роль не отправляется');
  assert.match(route.note, /нет среди активных/, 'сказано, что роли нет');
}

// 2.5b. Карточка этой роли в Ready есть, но роль не активна — причина другая.
{
  const route = decisionRoute('UI/UX', { roles, readyRoles: ['UI/UX'] });
  assert.equal(route.kind, 'ask', 'неактивная роль не отправляется');
  assert.match(route.note, /карточка в Ready есть, но выдать её некому/, 'сказано, в чём дело');
  assert.match(route.note, /Активные роли: Coordinator, Architect, Kernel/, 'видно, кому выдать можно');
}

// 2.5c. Роль есть в базе, но со статусом «Ждёт» и заполненным Agent URL.
{
  const directory = [
    { name: 'Coordinator', status: 'Активна', url: 'https://arena.ai/agent/c' },
    { name: 'Build/Release', status: 'Ждёт', url: 'https://arena.ai/agent/01a16d5c' },
  ];
  const route = decisionRoute('Build/Release', { roles, readyRoles: ['Build/Release'], directory });
  assert.match(route.note, /Статус «Ждёт», Agent URL заполнен/, 'причина названа без домыслов');
  assert.match(route.note, /Статус роли и Agent URL ставит Мастер/, 'сказано, кто это решает');
  assert.doesNotMatch(route.note, /Agent URL пуст/, 'заполненная ссылка не объявляется пустой');
}

// 2.5a. Постоянные промахи не превращаются в бесконечную переписку.
{
  const route = decisionRoute('Coordinator', { roles, readyRoles: [], misses: 2 });
  assert.equal(route.kind, 'pause', 'третье «ход себе» подряд — пауза');
  assert.match(route.reason, /возвращает ход себе/, 'причина называет поведение');
}
{
  const route = decisionRoute('UI/UX', { roles, readyRoles: [], misses: 2 });
  assert.equal(route.kind, 'pause', 'третья неизвестная роль подряд — пауза');
}

// 2.6. Пустой next и done.
assert.equal(decisionRoute('', { roles, readyRoles: [] }).kind, 'ask', 'пустой next — просьба');
assert.equal(decisionRoute('done', { roles, readyRoles: [] }).kind, 'done', 'done распознан');

// 2.7. Регистр и дефисы не мешают.
assert.equal(
  decisionRoute('architect', { roles, readyRoles: ['ARCHITECT'] }).kind,
  'dispatch',
  'регистр не важен',
);

// ── 3. requestPlan: свой ход не наказывается минутой ожидания ──────────────
const rpFrom = src.indexOf('  async function requestPlan(');
const rpTo = src.indexOf('  async function dispatchTask(', rpFrom);
assert.ok(rpFrom > 0 && rpTo > rpFrom, 'requestPlan на месте');
const rp = src.slice(rpFrom, rpTo);
assert.match(rp, /const waitMs = force \? 5_000 : 60_000;/, 'для своего хода — пять секунд, не минута');
assert.match(rp, /if \(manual\) log\(`Шаг не выполнен: план запрашивали/, 'в ручном режиме отказ объясняется');
assert.match(rp, /const answerLine = answerLogLine\(queue\.submitted\);/, 'журнал последнего ответа передаётся Координатору');
assert.match(
  rp,
  /readyLine\(queue\.ready\),\s*reworkLine\(queue\.rework\),\s*briefing\.openLine,\s*briefing\.answersLine,?/,
  'строка доходит до промпта вместе со списком черновиков и вопросами',
);
assert.match(rp, /const drafts = draftLine\(queue\.draft \|\| \[\], directory\);/, 'черновики попадают в промпт списком');

// ── 4. Скрипт больше не падает на пустом Ready ─────────────────────────────
assert.doesNotMatch(
  src,
  /throw new Error\(`Координатор направил ход в «\$\{roleName\}», но Ready-карточки нет\.`\)/,
  'падения «Ready-карточки нет» больше нет',
);
assert.match(
  src,
  /GM_setValue\("cfn-plan-miss", \(Number\(GM_getValue\("cfn-plan-miss", 0\)\) \|\| 0\) \+ 1\);[\s\S]{0,400}requestPlan\(mission, role, fresh, route\.note, \{ force: true \}\)/,
  'ход возвращается Координатору с подсказкой',
);
assert.match(src, /GM_setValue\("cfn-plan-miss", 0\);/, 'счётчик промахов сбрасывается на успехе');

console.log('OK: relay 1.4.63 — приёмка и выдача в одном ходе, next:Coordinator не ставит цикл на паузу');
