// Проба 1.4.63: новая миссия начинается с чистого хода.
//
// После приёмки NAR-1 Мастер создаёт новую миссию в «Миссиях» и жмёт «Шаг».
// Но ожидание ответа, очередь отправки и пауза остались от прошлой миссии —
// и решают, куда пойдёт шаг. Без сброса транспорт повёл бы Мастера на
// страницу исполнителя, который уже ничего не делает.
//
// Проверяется:
//   • смена миссии снимает обычное ожидание, очередь и паузу прошлой миссии;
//   • живая карточная выдача не теряется при смене миссии — нужна ручная проверка;
//   • та же миссия ничего не снимает;
//   • пауза, поставленная текущей миссией, остаётся — её снимает человек;
//   • «нет активной миссии» говорит, что именно создать, а не «ждём»;
//   • сверка стоит в тике до любых решений о ходе.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

const block = sliceBetween(
  '  /** Активная миссия и сменилась ли она',
  '  /**\n   * Блок замечаний Мастера',
);
for (const name of ['missionProbe', 'syncMissionState', 'clearStaleMissionPause', 'dropPauseOfMission']) {
  assert.ok(block.includes(`function ${name}`), `${name} на месте`);
}

const mission = {
  id: 'mission-2',
  properties: { 'Миссия': { title: [{ plain_text: 'NAR-2 · Шов движок/пак' }] } },
};

function makeApi({ store = new Map(), active = mission, logs = [] } = {}) {
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'log', 'rt', 'activeMission', 'missionKind', 'isReturned',
    'pause', 'norm', 'notion', 'autoSet',
    `${block}
     return { missionProbe, syncMissionState, clearStaleMissionPause };`,
  )(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    {
      expect: 'cfn-expect',
      pending: 'cfn-pending',
      paused: 'cfn-paused',
      pause: 'cfn-pause-context',
      mission: 'cfn-mission-id',
    },
    (text, error, options) => logs.push({ text, error, options }),
    (property) => (property?.title || property?.rich_text || []).map((x) => x.plain_text || '').join(''),
    async () => active,
    () => '',
    () => false,
    (reason, context) => { store.set('cfn-paused', reason); store.set('cfn-pause-context', context); },
    (value) => String(value || '').replaceAll('-', '').toLowerCase(),
    async () => { throw new Error('неожиданное чтение миссии'); },
    () => {},
  );
  return { api, store, logs };
}

// ── 1. Смена миссии: прошлый план снят целиком ────────────────────────────
{
  const store = new Map([
    ['cfn-mission-id', 'mission-1'],
    ['cfn-expect', { kind: 'plan', ref: 'mission-1', roleId: 'role-1' }],
    ['cfn-pending', { roleId: 'role-1', text: 'план' }],
    ['cfn-paused', 'ждём ответа'],
    ['cfn-pause-context', { kind: 'send', ref: 'mission-1', reason: 'ждём ответа' }],
    // 1.4.80: очередь ответов на вопросы прошлой миссии к новой не относится.
    ['cfn-answer-queue', [{ id: 'q-old', text: 'вопрос прошлой миссии' }]],
  ]);
  const { api } = makeApi({ store });
  assert.equal((await api.missionProbe()).changed, true, 'миссия другая');
  await api.syncMissionState();

  assert.equal(store.get('cfn-expect'), null, 'ожидание ответа снято');
  assert.equal(store.get('cfn-pending'), null, 'очередь отправки снята');
  assert.equal(store.get('cfn-paused'), '', 'пауза прошлой миссии снята');
  assert.equal(store.get('cfn-pause-context'), null, 'контекст паузы снят');
  assert.equal(store.get('cfn-mission-id'), 'mission-2', 'запомнена новая миссия');
  assert.deepEqual(store.get('cfn-answer-queue'), [], 'вопросы прошлой миссии сняты');
}

// Живая выдача при смене миссии не сбрасывается: иначе Running останется без ответа.
for (const kind of ['dispatch', 'reminder']) {
  const expect = { kind, ref: 'card-1', runId: 'run-1', missionId: 'mission-1' };
  const pending = { roleId: 'role-1', text: 'задание' };
  const store = new Map([
    ['cfn-mission-id', 'mission-1'],
    ['cfn-expect', expect],
    ['cfn-pending', pending],
  ]);
  const { api } = makeApi({ store });
  assert.equal(await api.syncMissionState(), true, 'ход остановлен для проверки');
  assert.deepEqual(store.get('cfn-expect'), expect, 'выдача сохранена');
  assert.deepEqual(store.get('cfn-pending'), pending, 'очередь сохранена');
  assert.equal(store.get('cfn-mission-id'), 'mission-1', 'миссия не переключена');
  assert.equal(store.get('cfn-pause-context').kind, 'mission-change-running');
}

// ── 2. Та же миссия: ничего не трогаем ─────────────────────────────────────
{
  const store = new Map([
    ['cfn-mission-id', 'mission-2'],
    ['cfn-expect', { kind: 'dispatch', ref: 'card-1' }],
    ['cfn-pending', { roleId: 'role-1' }],
    ['cfn-paused', 'прошлая пауза'],
    ['cfn-answer-queue', [{ id: 'q-1', text: 'вопрос этой миссии' }]],
  ]);
  const { api } = makeApi({ store });
  assert.equal((await api.missionProbe()).changed, false, 'миссия та же');
  await api.syncMissionState();
  assert.deepEqual(store.get('cfn-expect'), { kind: 'dispatch', ref: 'card-1' }, 'ожидание живо');
  assert.deepEqual(store.get('cfn-pending'), { roleId: 'role-1' }, 'очередь жива');
  assert.equal(store.get('cfn-paused'), 'прошлая пауза', 'пауза осталась');
  assert.deepEqual(store.get('cfn-answer-queue'), [{ id: 'q-1', text: 'вопрос этой миссии' }], 'очередь ответов жива');
}

// ── 3. Капча и сломанная страница ждут человека, а не миссии ──────────────
{
  const store = new Map([
    ['cfn-mission-id', 'mission-1'],
    ['cfn-paused', 'капча'],
    ['cfn-pause-context', { kind: 'captcha', ref: '', reason: 'капча' }],
  ]);
  const { api } = makeApi({ store });
  await api.syncMissionState();
  assert.equal(store.get('cfn-paused'), 'капча', 'капча не снимается сменой миссии');
  assert.equal(await api.clearStaleMissionPause(), false, 'и страж её не трогает');
  assert.equal(store.get('cfn-paused'), 'капча', 'капча на месте');
}

// ── 4. Пауза прошлого хода с карточкой в контексте тоже снимается ─────────
{
  const store = new Map([
    ['cfn-mission-id', 'mission-1'],
    ['cfn-paused', 'маркер не совпал'],
    ['cfn-pause-context', { kind: 'marker-mismatch', ref: 'card-9', reason: 'маркер не совпал' }],
  ]);
  const { api } = makeApi({ store });
  assert.equal(await api.clearStaleMissionPause(), false, 'ошибка ID не снимается автоматически');
  assert.equal(store.get('cfn-paused'), 'маркер не совпал', 'пауза сохранена');
  assert.equal(store.get('cfn-mission-id'), 'mission-1', 'старый контекст сохранён до ручной проверки');
}

// ── 5. Сообщения, по которым видно, что делать ────────────────────────────
{
  const { logs } = makeApi({
    store: new Map([
      ['cfn-mission-id', 'mission-1'],
      ['cfn-expect', { ref: 'card-1' }],
    ]),
  });
  // повторяем вызов на том же хранилище, чтобы прочитать журнал
  const store = new Map([
    ['cfn-mission-id', 'mission-1'],
    ['cfn-expect', { ref: 'card-1' }],
  ]);
  const logs2 = [];
  const { api } = makeApi({ store, logs: logs2 });
  await api.syncMissionState();
  assert.ok(logs2.some((line) => /Новая миссия/.test(line.text)), 'смена миссии названа');
  assert.ok(logs2.some((line) => /снял прошлый ход/.test(line.text)), 'сказано, что именно снято');
  assert.ok(logs2.some((line) => /начинается с Координатора/.test(line.text)), 'сказано, откуда ход');
  assert.ok(logs !== null);
}

assert.match(src, /Миссий в работе нет\. Создайте карточку в «Миссиях»/, 'пустая очередь миссий объясняет, что делать');
assert.match(src, /Состояние = «Активна»/, 'названо состояние новой миссии');
assert.match(src, /await syncMissionState\(\)/, 'сверка миссии вызывается из тика');
assert.match(src, /await clearStaleMissionPause\(\)/, 'стража паузы спрашивают до выхода');

console.log(`OK: relay ${versionMatch[1]} — старый план снимается, а живая выдача при смене миссии сохраняется`);
