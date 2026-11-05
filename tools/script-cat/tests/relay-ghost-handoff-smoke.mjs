// Проба 1.4.44: упавшая попытка не оставляет карточку в Running.
//
// 24.10 в 16:35 ход ушёл в «Kernel»: карточка NAR-1.12 стала Running
// (`Started At`, `Run ID`, файл журнала), а страница Arena упала до отправки —
// сообщение в чат не попало. В 17:09 очередь отправки снялась по TTL, но
// карточку скрипт не тронул: откат статуса был привязан к странице адресата, а
// Мастер стоял на другой. В Running карточка ждала ещё 11 минут до
// `releaseStalled`, всё это время Координатор видел «1 Running» и не мог
// выдать работу заново.
//
// Здесь проверяется:
//   • просроченная очередь возвращает карточку в Ready с любой страницы;
//   • ожидание без отметки отправки снимается на любом шаге, а не только на
//     странице адресата;
//   • сообщение, которое всё-таки ушло (есть `sentAt`), не откатывается;
//   • очередь, которая ещё может уйти, не трогает карточку;
//   • после уборки ход начинается заново сразу, без минутного троттлинга.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Версия ──────────────────────────────────────────────────────────────
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

// ── 2. Помощник dropGhostHandoff ───────────────────────────────────────────
const from = src.indexOf('  async function dropGhostHandoff(why, { ignoreQueue = false } = {}) {');
const to = src.indexOf('  /**\n   * Досылает задание, сохранённое перед переходом');
assert.ok(from > 0 && to > from, 'помощник на месте');
const helper = src.slice(from, to);

function make({ expect = null, pending = null, rolled = true } = {}) {
  const store = new Map();
  if (expect) store.set('cfn-expect', expect);
  if (pending) store.set('cfn-pending', pending);
  store.set('cfn-plan-at', 12345);
  const released = [];
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'releaseUndelivered', 'restoreMissingSendMark',
    `${helper}
     return dropGhostHandoff;`,
  );
  const call = fn(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { expect: 'cfn-expect', pending: 'cfn-pending' },
    async (exp, why) => {
      released.push({ ref: exp.ref, why });
      return rolled;
    },
    // D-044: восстановление по квитанции/реплике проверяется отдельной пробой
    // relay-delivery-receipt-smoke; здесь настоящие фантомы без доказательств.
    () => null,
  );
  return { call, store, released };
}

const dispatch = (extra = {}) => ({
  kind: 'dispatch',
  ref: 'card-1',
  roleId: 'kernel',
  roleName: 'Kernel',
  at: Date.now(),
  ...extra,
});

// 2a. Ожидание без отметки отправки, очереди нет — карточка возвращается.
{
  const { call, store, released } = make({ expect: dispatch() });
  const ghost = await call('задание не дошло');
  assert.ok(ghost, 'след снят');
  assert.equal(ghost.rolled, true, 'карточка вернулась в Ready');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято');
  assert.equal(store.get('cfn-plan-at'), 0, 'минутный троттлинг снят: новый план уйдёт сразу');
  assert.deepEqual(released[0], { ref: 'card-1', why: 'задание не дошло' }, 'откат идёт по карточке ожидания');
}

// 2b. Карточка уже не Running (её оформили руками) — ожидание всё равно снимается.
{
  const { call, store, released } = make({ expect: dispatch(), rolled: false });
  const ghost = await call('задание не дошло');
  assert.equal(ghost.rolled, false, 'откат не понадобился');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято и в этом случае');
  assert.equal(released.length, 1, 'проверка карточки была');
}

// 2c. Сообщение всё-таки ушло (есть отметка) — ничего не трогаем.
{
  const { call, store, released } = make({ expect: dispatch({ sentAt: Date.now() }) });
  assert.equal(await call('не должно вызываться'), null, 'это не след, а живой ход');
  assert.ok(store.get('cfn-expect'), 'ожидание на месте');
  assert.equal(released.length, 0, 'карточку не трогали');
}

// 2d. Очередь ещё может уйти — карточка не откатывается.
{
  const { call, store } = make({
    expect: dispatch(),
    pending: { roleId: 'kernel', text: 'задание', at: Date.now() },
  });
  assert.equal(await call('рано'), null, 'пока очередь жива, откат не делается');
  assert.ok(store.get('cfn-expect'), 'ожидание на месте');
  assert.ok(store.get('cfn-pending'), 'очередь на месте');
}

// 2d2. Та же очередь, но просроченная: она снимается этим же шагом, поэтому
// откат карточки разрешён явно и не зависит от порядка записи в хранилище.
{
  const { call, store, released } = make({
    expect: dispatch(),
    pending: { roleId: 'kernel', text: 'задание', at: Date.now() - 40 * 60 * 1000 },
  });
  const ghost = await call('очередь отправки просрочена', { ignoreQueue: true });
  assert.ok(ghost, 'след снят, хотя в хранилище ещё лежит просроченная очередь');
  assert.equal(ghost.rolled, true, 'карточка возвращена в Ready');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято');
  assert.equal(released.length, 1, 'откат был');
}

// 2e. Ожидание другой роли (маркер Координатора) — тоже след, но без карточки.
{
  const { call, store } = make({ expect: { kind: 'plan', roleId: 'coord', at: Date.now() } });
  const ghost = await call('план не ушёл');
  assert.ok(ghost, 'след снят');
  assert.equal(store.get('cfn-expect'), null, 'ожидание плана снято');
}

// ── 3. Просроченная очередь: карточка возвращается с любой страницы ────────
const consume = src.slice(src.indexOf('  async function consumePending(manual = false) {'), src.indexOf('  // ───────────────────── следы прошлых попыток (очистка)'));
assert.ok(consume.length > 2000, 'consumePending на месте');
const ttl = consume.slice(consume.indexOf('    if (age > (pending.undelivered'), consume.indexOf('    if (!me || norm(me) !== norm(pending.roleId)) return false;'));
assert.ok(ttl.length > 200, 'ветка TTL на месте');
assert.match(ttl, /await dropGhostHandoff\("очередь отправки просрочена", \{ ignoreQueue: true \}\)/, 'откат идёт через помощника, просроченная очередь не мешает');
assert.doesNotMatch(ttl, /mine && waiting/, 'условие «только на странице адресата» убрано');
assert.doesNotMatch(ttl, /Вернитесь на страницу адресата/, 'Мастера больше не отправляют вручную на страницу адресата');
assert.match(ttl, /Карточка возвращена в Ready/, 'в журнале сказано, что карточка вернулась');
assert.match(ttl, /Сообщение в чате есть — ожидание ответа оставлено/, 'отправленное сообщение не откатывается');

// ── 4. Уборка следа идёт до правила «ручной режим — только по нажатию» ─────
const tickStart = src.indexOf('  async function tick(fromToggle = false) {');
assert.ok(tickStart > 0, 'tick на месте');
const tick = src.slice(tickStart);
const ghostAt = tick.indexOf('const ghost = await dropGhostHandoff(');
const manualAt = tick.indexOf('if (!auto && !fromToggle) return;');
assert.ok(ghostAt > 0, 'шаг убирает след');
assert.ok(manualAt > ghostAt, 'уборка идёт до выхода из ручного режима: иначе карточка ждала бы нажатия');

// Старая ветка «нет отметки отправки» тоже возвращает карточку.
const late = tick.slice(tick.indexOf('if (expect && !Number(expect.sentAt)) {'));
assert.match(late.slice(0, 700), /dropGhostHandoff\(/, 'запасная ветка делает то же');

// ── 5. Обновление скрипта тоже не бросает карточку ─────────────────────────
// 1.4.9 снимала при обновлении ожидание без отметки отправки — и карточка,
// успевшая стать Running, оставалась в нём до `releaseStalled`.
const migrateFrom = src.indexOf('  function migrateState() {');
const migrateTo = src.indexOf('  /**\n   * Кнопка ↺: снять ход, а не только память транспорта');
assert.ok(migrateFrom > 0 && migrateTo > migrateFrom, 'migrateState на месте');
const migrate = src.slice(migrateFrom, migrateTo);
assert.match(migrate, /сохранены.*и очередь/, 'ожидание и очередь не снимаются');
assert.match(migrate, /отсутствие sentAt не доказывает/, 'нужна ручная сверка');
assert.doesNotMatch(migrate, /GM_setValue\(K\.expect, null\)/, 'миграция не сбрасывает ожидание');

console.log('OK: relay 1.4.63 — упавшая отправка возвращает карточку в Ready с любой страницы');
