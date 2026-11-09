// Проба очистки состояния: почему после обновления всплывало «прошлое задание».
//
// Хранилище ScriptCat общее для всех версий. Ожидание, записанное прошлой
// версией без отметки отправки, доживало до нового запуска, и шаг ссылался
// на отправку, которой не было. Здесь проверяется:
//   • после обновления снимается только ожидание без отправки;
//   • настоящая отправка и очередь с текстом остаются;
//   • кнопка ↺ очищает очередь, ожидание и защиту от повторов по воле Мастера;
//   • пустое состояние не порождает записей в журнале.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const from = src.indexOf('  // ───────────────────── следы прошлых попыток (очистка) ─────────────────────');
const to = src.indexOf('  // ───────────────────────────── PR ─────────────────────────────');
assert.ok(from > 0 && to > from, 'блок очистки состояния на месте');
const block = src.slice(from, to);

function make(seed = {}) {
  const store = new Map(Object.entries(seed));
  const logs = [];
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'SCRIPT_VERSION', 'log', 'confirm', 'setStatus',
    'composerText', 'healAfterUpdate', 'C',
    `${block}
     return { transientState, describeTransient, resetState, migrateState, resetStateDialog };`,
  );
  const api = fn(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { pending: 'cfn-pending', expect: 'cfn-expect', lastSend: 'cfn-last-send', step: 'cfn-step-request', stateV: 'cfn-state-v', paused: 'cfn-paused', pause: 'cfn-pause-context' },
    '1.4.74',
    (t, e, o) => logs.push({ t, e, o }),
    () => true,
    () => {},
    () => String(seed['cfn-composer'] || ''),
    undefined,
    { buildFingerprint: 'fp-test' },
  );
  return { api, store, logs };
}

const ghost = { roleId: 'coord', roleName: 'Coordinator', kind: 'plan', text: 'ЗАДАНИЕ', watermark: 'm1', at: 1 };
const real = { ...ghost, sentAt: 2, verified: true };

// ── Обновление сохраняет ожидание и ставит восстановительную паузу ТОЛЬКО там,
// где есть неоднозначность «ушло или нет» (D-085).
// Неподтверждённое ожидание и очередь — пауза: доказательства доставки нет.
{
  const pending = { roleId:'coord', text:'ЗАДАНИЕ', at:1 };
  const { api, store, logs } = make({ 'cfn-state-v':'1.4.8', 'cfn-expect':ghost, 'cfn-pending':pending });
  assert.equal(api.migrateState(), '«Coordinator», plan');
  assert.deepEqual(store.get('cfn-expect'), ghost);
  assert.deepEqual(store.get('cfn-pending'), pending);
  assert.equal(store.get('cfn-pause-context').kind, 'update-recovery');
  assert.match(store.get('cfn-paused'), /отсутствие sentAt не доказывает/);
  assert.equal(store.get('cfn-state-v'), '1.4.74');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].o?.skip, true);
}
// Подтверждённая доставка — паузы нет: ожидание живое, ответ придёт в него же.
// 09.11 на этом стояли паузы после каждой из шести сборок подряд.
{
  const { api, store, logs } = make({ 'cfn-state-v':'1.4.8', 'cfn-expect':real });
  assert.equal(api.migrateState(), '«Coordinator», plan');
  assert.equal(store.get('cfn-pause-context'), undefined, 'доставка подтверждена — паузы нет');
  assert.equal(store.get('cfn-paused'), undefined);
  assert.deepEqual(store.get('cfn-expect'), real, 'ожидание сохранено как есть');
  assert.match(String(logs[0]?.t || ''), /доставка подтверждена/);
}
// Очередь без ожидания — по-прежнему пауза: отправки могло не быть.
{
  const { api, store } = make({ 'cfn-state-v':'1.4.8', 'cfn-pending':{ roleId:'coord', text:'З', at:1 } });
  api.migrateState();
  assert.equal(store.get('cfn-pause-context').kind, 'update-recovery');
}
{
  const { api, logs } = make({ 'cfn-state-v':'1.4.8' });
  assert.equal(api.migrateState(), '');assert.equal(logs.length,0);
}
{
  const { api, store } = make({ 'cfn-state-v':'1.4.74', 'cfn-expect':ghost });
  assert.equal(api.migrateState(),'');assert.deepEqual(store.get('cfn-expect'),ghost);
}

// ── 4. Кнопка ↺: полная очистка по воле Мастера ─────────────────────────────
{
  const { api, store } = make({
    'cfn-expect': real,
    'cfn-pending': { roleId: 'coord', text: 'ЗАДАНИЕ', at: Date.now() },
    'cfn-last-send': { roleId: 'coord', hash: '1', at: Date.now() },
    'cfn-plan-at': 123,
    'cfn-step-request': true,
  });
  const cleared = api.resetState();
  assert.match(cleared.text, /очередь: «coord»/, 'описана снятая очередь');
  assert.match(cleared.text, /ожидание: «Coordinator»/, 'описано снятое ожидание');
  assert.match(cleared.text, /защита от повторов/, 'описана снятая защита');
  for (const key of ['cfn-expect', 'cfn-pending', 'cfn-last-send']) {
    assert.equal(store.get(key), null, `${key} очищен`);
  }
  assert.equal(store.get('cfn-plan-at'), 0, 'троттлинг плана сброшен');
  assert.equal(store.get('cfn-step-request'), false, 'отложенный шаг снят');
  assert.equal(store.get('cfn-state-v'), '1.4.74', 'метка версии на месте');
}

// ── 5. Диалог: отказ ничего не чистит ───────────────────────────────────────
{
  const { api, store } = make({ 'cfn-pending': { roleId: 'coord', text: 'ЗАДАНИЕ', at: 1 } });
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'SCRIPT_VERSION', 'log', 'confirm', 'setStatus',
    `${block}; return { resetStateDialog };`,
  );
  const logs = [];
  const withNo = fn(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { pending: 'cfn-pending', expect: 'cfn-expect', lastSend: 'cfn-last-send', step: 'cfn-step-request', stateV: 'cfn-state-v', paused: 'cfn-paused', pause: 'cfn-pause-context' },
    '1.4.74', (t) => logs.push(t), () => false, () => {},
  );
  withNo.resetStateDialog();
  assert.ok(store.get('cfn-pending'), 'при отказе очередь осталась');
  assert.equal(logs.length, 0, 'при отказе журнал молчит');
  void api;
}

// ── 6. Кнопка есть в панели, у 🧹 подсказка про ↺ ───────────────────────────
assert.match(src, /reset: "cfn-reset"/, 'id кнопки объявлен');
assert.match(src, /id="\$\{ui\.reset\}" title="Снять ход: очередь, ожидание и карточки в Running/, 'кнопка ↺ в панели');
assert.match(src, /getElementById\(ui\.reset\)\.onclick = \(\) => \{/, 'кнопка вызывает очистку');
assert.match(src, /const work = resetStateDialog\(\);[\s\S]*?trackProjectTask\(work\)[\s\S]*?\.catch\(/, 'отказ сети при снятии хода не теряется');
assert.match(src, /Очистить журнал; очередь снимается кнопкой ↺/, 'у 🧹 понятная подсказка');
assert.match(src, /reset: \(\) => resetStateDialog\(\)/, 'в консоли есть __relay.reset()');
assert.match(src, /const boot = \(\) => \{\s*migrateState\(\);/, 'миграция выполняется до первого шага');
assert.match(src, /title="версия скрипта">v\$\{SCRIPT_VERSION\}/, 'в панели видно, какая версия загружена');

console.log('OK: relay 1.4.63 — обновление сохраняет ожидание и ставит паузу, ↺ снимает ход целиком, журнал не засоряется');

// ── D-085: задание уже в поле ввода — доказательство «не ушло», пауза не нужна.
// 09.11 каждая из шести установок сборки при живом ходе требовала «Продолжить»,
// хотя часть ходов стояла именно в поле и отправлялась сама.
{
  const pending = { roleId:'coord', text:'ЗАДАНИЕ В ПОЛЕ', at:1 };
  const { api, store, logs } = make({
    'cfn-state-v':'1.4.8', 'cfn-expect':ghost, 'cfn-pending':pending, 'cfn-composer':'ЗАДАНИЕ В ПОЛЕ',
  });
  assert.equal(api.migrateState(), '«Coordinator», plan');
  assert.equal(store.get('cfn-pause-context'), undefined, 'задание в поле — паузы нет');
  assert.match(String(logs[0]?.t || ''), /уже в поле ввода/);
  assert.deepEqual(store.get('cfn-expect'), ghost, 'ожидание не тронуто');
}
// Чужой текст в поле доказательством не считается: пауза остаётся.
{
  const pending = { roleId:'coord', text:'ЗАДАНИЕ В ПОЛЕ', at:1 };
  const { api, store } = make({
    'cfn-state-v':'1.4.8', 'cfn-expect':ghost, 'cfn-pending':pending, 'cfn-composer':'вопрос про другое',
  });
  api.migrateState();
  assert.equal(store.get('cfn-pause-context').kind, 'update-recovery', 'чужой текст паузу не снимает');
}
