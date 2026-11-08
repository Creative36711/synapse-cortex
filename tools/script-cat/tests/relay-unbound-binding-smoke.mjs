// D-056: непривязанная карточка останавливает шаг только тогда, когда она
// мешает выбрать очередь этой миссии.
//
// 22:57–06:12. Координатор создал S-13…S-16 без Mission ID и без «Миссии»,
// а страж привязок валил каждый шаг — в том числе приём уже полученного
// ответа Warden. Миссия вернулась в круг 1 из 3, запись сделана, план
// Координатору не ушёл: цикл встал на «Шаг прервался на записи в Notion».
// Здесь настоящие функции бандла: привязка, страж, мягкое и строгое чтение
// очереди `queueOf`. Сеть не нужна — Notion подменён.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + a.length);
  assert(i >= 0 && j > i, a);
  return src.slice(i, j);
};

// ── 1. Код: пауза приёмки стоит там, где очередь решает закрытие ───────────
assert.match(src, /relay = "binding"/, 'ошибка привязки помечена как причина, а не как сбой записи');
assert.match(src, /kind: "review-unbound"/, 'пауза приёмки по привязке названа отдельно');

const acceptFrom = src.indexOf('if (verdict === "accept") {');
const closeAt = src.indexOf('const closed = await closeMission(', acceptFrom);
const unboundAt = src.indexOf('if (unbound.length) {', acceptFrom);
assert.ok(acceptFrom > 0 && closeAt > acceptFrom, 'ветка принятия на месте');
assert.ok(unboundAt > acceptFrom, 'в ветке принятия есть проверка непривязанных карточек');
assert.ok(unboundAt < closeAt, 'проверка привязки стоит до закрытия миссии');
assert.ok(!/if \(verdict === "rework"\)[\s\S]{0,400}review-unbound/.test(src),
  'возврат с примечаниями привязкой не блокируется: замечания уже получены');

// ── 2. Поведение: стража, мягкое и строгое чтение очереди ──────────────────
const uuid = cut('  const isUuid = ', '  /**');
const words = cut('  const MISSION_STOPWORDS = new Set([', '  /** Поле названия показывается человеку');
const binding = cut('  const cardMissionId = ', '  // ───────────────────────────── сообщения чата');
const queueOfSrc = cut('  async function queueOf(mission, { strict = false } = {}) {', '  function draftLine(');
const blockersSrc = cut('  async function missionBindingBlockers(mission) {', '  /** Не прячем записи с пустым состоянием');

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const ID1 = '33333333-3333-4333-8333-333333333333';
const ID2 = '44444444-4444-4444-8444-444444444444';
const ID3 = '55555555-5555-4555-8555-555555555555';

const rich = (s) => ({ type: 'rich_text', rich_text: s ? [{ plain_text: s }] : [] });
const title = (s) => ({ title: [{ plain_text: s }] });
const mission = (id, name, state = 'Активна') => ({
  id, properties: { 'Миссия': title(name), 'Состояние': { select: { name: state } } },
});
const card = (id, mid, label, status = 'Ready') => ({
  id,
  properties: {
    'Запрос': title(`Карточка ${id.slice(0, 4)}`),
    'Миссия': rich(label),
    'Mission ID': rich(mid),
    'Dispatch State': { select: { name: status } },
    'Sequence': { number: 1 },
  },
});

let missions, cards;
const C = { missions: 'missions', requests: 'requests' };
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const sel = (p) => p?.select?.name || '';
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const taskTitle = (p) => rt(p.properties['Запрос']);
const taskState = (p) => sel(p.properties['Dispatch State']);
const query = async (db, filter) =>
  db === 'missions'
    ? missions
    : filter
      ? cards.filter((row) => taskState(row) === filter.select.equals)
      : cards;
const logs = [];
const log = (text) => logs.push(text);

const firstLine = (text, max = 80) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const api = new Function(
  'C', 'rt', 'sel', 'norm', 'taskTitle', 'taskState', 'query', 'log', 'firstLine',
  `${uuid}\n${words}\n${binding}\n${blockersSrc}\n${queueOfSrc}
   return { cardNamesMission, bindingBlockers, missionBindingBlockers, assertMissionBindings, tasks, queueOf };`,
)(C, rt, sel, norm, taskTitle, taskState, query, log, firstLine);

const remembered = [];
const queueOf = new Function(
  'tasks', 'rememberRework', 'assertMissionBindings',
  `${queueOfSrc}; return queueOf;`,
)(
  api.tasks,
  (rows) => remembered.push(...rows.map((row) => row.id)),
  api.assertMissionBindings,
);

// Своя карточка привязана; S-13…S-16 — в базе, но ни ID, ни названия миссии.
missions = [mission(M1, 'Альфа'), mission(M2, 'Бета', 'Завершена')];
cards = [
  card(ID1, M1, 'Альфа'),
  card(ID2, '', ''),
  card(ID3, '', ''),
];

// 2.1 Страж привязок больше не валит шаг из-за чужой непривязанной карточки.
await api.assertMissionBindings(missions[0]);

// 2.2 Непривязанная карточка не попадает в очередь ни в мягком, ни в строгом чтении.
assert.deepEqual((await api.tasks('Ready', missions[0], { allowUnbound: true })).map((r) => r.id), [ID1],
  'чужая непривязанная карточка не в очереди');
assert.deepEqual((await api.tasks('Ready', missions[0], { allowUnbound: true, unbound: [] })).map((r) => r.id), [ID1],
  'чужая карточка не считается «нашей без привязки»');
assert.deepEqual((await api.tasks('Ready', missions[0])).map((r) => r.id), [ID1],
  'строгое чтение тоже не выдаёт чужую карточку — но и шаг не валит');
assert.ok(logs.some((line) => /без Mission ID/.test(line)), 'о пропуске сказано в журнале');

// 2.3 Своя непривязанная карточка видна: пропуск, а не тишина.
cards = [card(ID1, M1, 'Альфа'), card(ID2, '', 'Альфа'), card(ID3, '', '')];
await assert.rejects(api.assertMissionBindings(missions[0]), /карточек с пустым\/неизвестным/,
  'своя карточка без привязки по-прежнему останавливает выбор очереди');
const ownUnbound = [];
const softOwn = await api.tasks('Ready', missions[0], { allowUnbound: true, unbound: ownUnbound });
assert.deepEqual(softOwn.map((r) => r.id), [ID1], 'мягкое чтение не выдаёт карточку без UUID в очередь');
assert.deepEqual(ownUnbound.map((r) => r.id), [ID2], 'но и не молчит: своя карточка без привязки названа');
assert.equal(api.cardNamesMission(cards[1], missions[0]), true, 'карточка с названием миссии — наша');
assert.equal(api.cardNamesMission(cards[2], missions[0]), false, 'карточка без названия — неизвестно чья');

// 2.4 Очередь читается мягко: приём ответа и запись результата не встают.
cards = [card(ID1, M1, 'Альфа'), card(ID2, '', ''), card(ID3, '', 'Карточка 55')];
const soft = await queueOf(missions[0]);
assert.deepEqual(soft.ready.map((r) => r.id), [ID1], 'в очереди только своя карточка');
assert.deepEqual(soft.unbound.map((r) => r.id), [], 'чужие непривязанные не выдаются за свои');
assert.match(soft.summary, /^0 Submitted, 0 Running, 1 Ready/, 'счётчик очереди считает только привязанные');
assert.ok(logs.some((line) => /без Mission ID/.test(line)), 'о непривязанных карточках сказано в журнале');

// 2.5 Строгое чтение (ход планирования) не меняет содержимое очереди, но и не
// притворяется, что карточки нет.
const strict = await queueOf(missions[0], { strict: true });
assert.deepEqual(strict.ready.map((r) => r.id), [ID1], 'строгое чтение даёт ту же очередь');

// 2.6 Карточка текущей миссии без привязки останавливает выбор очереди —
// и проверка привязок называет её, а не прячет.
cards = [card(ID1, M1, 'Альфа'), card(ID2, '', 'Альфа')];
await assert.rejects(queueOf(missions[0], { strict: true }), /Mission ID/,
  'выбор очереди встаёт: без UUID карточку нельзя ни выдать, ни принять');
assert.deepEqual((await api.missionBindingBlockers(missions[0])).map((r) => r.id), [ID2],
  'закрытие миссии видит свою непривязанную карточку');
const softNamed = await queueOf(missions[0]);
assert.deepEqual(softNamed.unbound.map((r) => r.id), [ID2], 'мягкое чтение называет свою карточку без привязки');
assert.deepEqual((await api.missionBindingBlockers(missions[1])).map((r) => r.id), [],
  'и не валит другую миссию');
// Accepted queueOf не читает вовсе, поэтому решение о закрытии спрашивает
// привязки отдельным запросом — иначе карточка без UUID прошла бы молча.
cards = [card(ID1, M1, 'Альфа', 'Accepted'), card(ID2, '', 'Альфа', 'Accepted')];
assert.deepEqual((await api.missionBindingBlockers(missions[0])).map((r) => r.id), [ID2],
  'карточка в Accepted без привязки мешает закрытию миссии');

// 2.7 В решении «done» непривязанная своя карточка тоже видна: миссия с живой
// карточкой без UUID не закрывается молча.
assert.match(src, /const fresh = await queueOf\(mission\);\n\s+const open = fresh\.submitted/, 'решение done считает ту же очередь');

console.log('OK: D-056 — непривязанная карточка останавливает приёмку только по своей миссии');
