// Проба двух решений 1.4.19: куда ведёт «Шаг» и когда включается автоцикл.
//
// Случай Мастера (2026-10-23, 18:30): «Шаг» нажали с https://arena.ai/ —
// скрипт открыл Координатора, хотя ход ждал ответа Architect, и шаг отказался
// работать: «ход ждёт ответа 01a1689c-…, а не Coordinator».
//
// Второе: автоцикл подхватывался после каждого открытия браузера, потому что
// жил в хранилище скрипта, которое переживает браузер.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Автоцикл: память вкладки, а не хранилище скрипта ─────────────────────
const autoFrom = src.indexOf('  let autoMem = false;');
const autoTo = src.indexOf('  /** Старое значение в хранилище скрипта снимаем');
assert.ok(autoFrom > 0 && autoTo > autoFrom, 'блок автосостояния на месте');
const autoBlock = src.slice(autoFrom, autoTo);

const makeAuto = () => {
  const api = new Function('K', `${autoBlock}; return { autoOn, autoSet };`);
  return api({ auto: 'cfn-auto-enabled' });
};

{
  const { autoOn, autoSet } = makeAuto();
  assert.equal(autoOn(), false, 'новый запуск браузера — автоцикл выключен');
  autoSet(true);
  assert.equal(autoOn(), true, 'внутри вкладки включается');
  autoSet(false);
  assert.equal(autoOn(), false, 'и выключается');
}

// 1.1. Источник состояния — sessionStorage, а не GM.
assert.match(autoBlock, /sessionStorage\.getItem\(K\.auto\)/, 'читаем из памяти вкладки');
assert.match(autoBlock, /sessionStorage\.setItem\(K\.auto, "1"\)/, 'пишем в память вкладки');
assert.doesNotMatch(autoBlock, /GM_(get|set)Value/, 'хранилище скрипта не участвует');

// 1.2. Старое значение снимается при старте, и об этом есть строка.
const forgetStart = src.indexOf('  function autoForgetPersisted() {');
const forget = src.slice(forgetStart, src.indexOf('\n  }\n', forgetStart) + 4);
assert.match(forget, /GM_setValue\(K\.auto, false\)/, 'старый флаг сброшен');
assert.match(forget, /Автоцикл прошлой сессии снят/, 'Мастер увидит, почему цикл стоит');
assert.match(src, /const boot = \(\) => \{\s*migrateState\(\);\s*\/\/[^\n]*\n\s*autoForgetPersisted\(\);/s, 'сброс до первого шага');

// 1.3. Ни один автопуть не включает цикл сам.
assert.doesNotMatch(src, /GM_setValue\(K\.auto, true\)/, 'автоцикл не включается через хранилище');
assert.match(src, /projectApproved\(\) && !projectHeld\(\) && !GM_getValue\(K\.paused, ""\)/, 'ссылка не обходит сохранённую паузу');
assert.match(src, /Автоцикл включён через ссылку — только для этой вкладки/, 'это честно сказано');

// ── 2. «Шаг» с корня открывает ту роль, где есть работа ────────────────────
const tickFrom = src.indexOf('  async function tick(fromToggle = false) {');
const tickBody = src.slice(tickFrom, src.indexOf('  // ───────────────────────────── старт', tickFrom));
const rootStart = tickBody.indexOf('if (!meId) {');
const root = tickBody.slice(rootStart, tickBody.indexOf('const me = list.find(', rootStart));
assert.ok(root.length > 0, 'ветка «нет /agent/<id> в адресе» на месте');
assert.match(root, /const pendingRole = pendingNow \? byId\(pendingNow\.roleId\) : null;/, 'сначала адресат неотправленного задания');
assert.match(root, /const waitingRole = waitingNow \? byId\(waitingNow\.roleId\) : null;/, 'потом тот, чей ответ ждём');
assert.match(root, /const target = pendingRole \|\| waitingRole \|\| coord;/, 'Координатор — только если ждать нечего');
assert.match(root, /return navigateTo\(target, why\);/, 'открывается нужная страница через общий переход');
assert.match(root, /ждём ответа «\$\{target\.name\}»/, 'в журнале видно причину перехода');
assert.match(root, /if \(!pendingNow && fromToggle\) GM_setValue\(K\.step, true\);/, 'отложенный шаг только в ручном режиме и когда очередь пуста');

// 2.1. Не та страница: «Шаг» сам переходит, а не просит Мастера.
assert.match(
  tickBody,
  /return navigateTo\(owner, `ждём ответа «\$\{owner\.name\}», а не «\$\{me\.name\}»`\)/,
  'вместо отказа — переход на страницу адресата',
);
assert.match(
  tickBody,
  /if \(\(fromToggle \|\| autoOn\(\)\) && owner\) \{/,
  'переход и по нажатию, и в автоцикле — но не в ручном фоне',
);
assert.match(tickBody, /samePage = new URL\(owner\.url, location\.href\)\.pathname === location\.pathname/, 'проверка на петлю: та же страница — не переходим');

// 2.2. У исполнителя работы нет: «Шаг» ведёт к Координатору, а не в тупик.
assert.match(
  tickBody,
  /if \(fromToggle && coord\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*log\(`У «\$\{me\.name\}» нет задания в очереди — открываю Координатора/,
  'нажатие «Шаг» без задания ведёт к Координатору',
);
assert.match(
  tickBody,
  /нет задания в очереди — открываю Координатора[\s\S]{0,200}GM_setValue\(K\.step, true\);[\s\S]{0,120}return navigateTo\(coord, "там начинается ход"\);/,
  'переход сразу выполняет отложенный шаг на странице Координатора',
);

// ── 3. Ожидание помнит имя и адрес роли ─────────────────────────────────────
assert.match(src, /roleName: role\.name,/, 'в ожидании есть имя роли');
assert.match(src, /roleUrl: role\.url,/, 'в ожидании есть её страница');
assert.match(
  src,
  /const owner = list\.find\(\(r\) => norm\(r\.id\) === norm\(expect\.roleId\)\) \|\| null;/,
  'старые ожидания без имени находят роль по id',
);

// ── 4. Поведение: навигация выбирает роль, а не константу ──────────────────
function pickTarget({ pending = null, expect = null, rolesList = [] } = {}) {
  const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
  const byId = (id) => (id ? rolesList.find((r) => norm(r.id) === norm(id)) || null : null);
  const pendingRole = pending ? byId(pending.roleId) : null;
  const waitingRole = expect ? byId(expect.roleId) : null;
  const coord = rolesList.find((r) => r.fn === 'Coordinator');
  return pendingRole || waitingRole || coord || null;
}
const coordinator = { id: 'coord', name: 'Coordinator', fn: 'Coordinator', url: 'https://arena.ai/agent/coordinator' };
const architect = { id: '01a1689c-44c4-7626-8085-ae11c372b3f8', name: 'Architect', fn: 'Executor', url: 'https://arena.ai/agent/architect' };
const list = [coordinator, architect];

assert.equal(pickTarget({ expect: { roleId: architect.id }, rolesList: list }).name, 'Architect', 'ждём ответ — идём к нему');
assert.equal(pickTarget({ pending: { roleId: architect.id }, rolesList: list }).name, 'Architect', 'задание в очереди — идём к адресату');
assert.equal(pickTarget({ rolesList: list }).name, 'Coordinator', 'ждать нечего — начинаем с Координатора');
assert.equal(
  pickTarget({ pending: { roleId: architect.id }, expect: { roleId: '01a16940-0000-0000-0000-000000000000' }, rolesList: list }).name,
  'Architect',
  'неотправленное задание важнее прежнего ожидания',
);
assert.equal(pickTarget({ expect: { roleId: 'неизвестно' }, rolesList: list }).name, 'Coordinator', 'неизвестная роль — не блокируем шаг');

console.log('OK: relay 1.4.63 — «Шаг» ведёт к тому, чей ответ ждут, а автоцикл живёт только в текущей вкладке');
