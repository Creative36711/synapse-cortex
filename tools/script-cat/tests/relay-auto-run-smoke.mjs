// Проба автоцикла: что произойдёт после нажатия «Включить».
//
// Ожидание Мастера (2026-10-23): открыл браузер, зашёл на arena.ai, нажал
// «Включить» — и цикл идёт сам, как ручной режим, только без «Шага».
//
// Здесь проверяется 1.4.19: автоцикл сам открывает нужную страницу (раньше на
// главной он молчал), не начинает новый ход поверх неотправленного задания,
// не спамит журнал и умеет не зацикливаться на битом «Agent URL».

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const version = src.match(/^\/\/ @version\s+(\S+)/m)?.[1];
assert.ok(version, 'у активного userscript задана версия');

const tickFrom = src.indexOf('  async function tick(fromToggle = false) {');
const tickBody = src.slice(tickFrom, src.indexOf('  // ───────────────────────────── старт', tickFrom));

// ── 1. Включение автоцикла — это тик, а не «Шаг» ───────────────────────────
const toggleFrom = src.indexOf('  async function toggleAuto() {');
const toggleBlock = src.slice(toggleFrom, src.indexOf('  function btnStyle()', toggleFrom));
assert.match(toggleBlock, /autoSet\(true\);/, 'автоцикл включается кнопкой');
assert.match(
  toggleBlock,
  /log\("Автоцикл включён\."\);[\s\S]{0,300}?tick\(false\);/,
  'после включения идёт обычный тик, а не ручной шаг',
);
assert.doesNotMatch(
  toggleBlock.slice(toggleBlock.indexOf('log("Автоцикл включён.")')),
  /tick\(true\);/,
  'включение автоцикла не притворяется нажатием «Шаг»',
);

// ── 2. На главной автоцикл сам открывает нужную страницу ──────────────────
assert.match(tickBody, /if \(!fromToggle && !autoOn\(\)\) return;/, 'в автоцикле переход разрешён без нажатия');
assert.match(tickBody, /return navigateTo\(target, why\);/, 'страница выбирается и открывается самим циклом');
assert.match(
  tickBody,
  /if \(!pendingNow && fromToggle\) GM_setValue\(K\.step, true\);/,
  'отложенный шаг остаётся ручным механизмом',
);

// ── 3. Неотправленное задание важнее нового хода ──────────────────────────
const pendingAt = tickBody.indexOf('const pendingNow = GM_getValue(K.pending, null);');
assert.ok(pendingAt > 0, 'тик видит очередь');
const pendingBlock = tickBody.slice(pendingAt, tickBody.indexOf('const meId = roleFromPath();', pendingAt));
assert.match(pendingBlock, /if \(pendingNow && \(fromToggle \|\| autoOn\(\)\)\)/, 'страница адресата открывается и в автоцикле');
assert.match(pendingBlock, /return navigateTo\(target, "там ждёт отправки задание"\)/, 'переход к адресату очереди');
assert.ok(
  pendingBlock.indexOf('navigateTo') < pendingBlock.length,
  'переход происходит до любых решений о новом ходе',
);
assert.ok(
  tickBody.indexOf('pendingNow && (fromToggle || autoOn())') < tickBody.indexOf('const meId = roleFromPath();'),
  'очередь проверяется раньше, чем страница начнёт новый ход',
);

// ── 4. Ожидание ответа чужой роли — тоже переход ──────────────────────────
assert.match(
  tickBody,
  /if \(\(fromToggle \|\| autoOn\(\)\) && owner\) \{/,
  'в автоцикле ход догоняется на странице адресата',
);
assert.match(
  tickBody,
  /return navigateTo\(owner, `ждём ответа «\$\{owner\.name\}», а не «\$\{me\.name\}»`\)/,
  'переход объясняет причину',
);

// ── 5. Исполнитель без задания в автоцикле идёт к Координатору ────────────
assert.match(
  tickBody,
  /else if \(autoOn\(\) && coord\) \{[\s\S]{0,400}navigateTo\(coord, "там начинается ход"\)/,
  'пустая страница исполнителя не держит цикл',
);
assert.match(
  tickBody,
  /if \(fromToggle && coord\) \{[\s\S]{0,900}navigateTo\(coord, "там начинается ход"\)/,
  'и в ручном режиме «Шаг» ведёт туда же',
);

// ── 6. Журнал не забивается повторами ─────────────────────────────────────
assert.match(src, /function logThrottled\(key, text, error = false, ms = 300_000\)/, 'есть тихий лог');
assert.match(src, /logThrottled\(\s*"no-mission",\s*"Миссий в работе нет\./, '«нет миссии» не пишется каждые 15 секунд и говорит, что делать');

// ── 6.1. «done» с живыми карточками миссию не закрывает ───────────────────
assert.match(src, /kind: "done-with-open"/, 'есть защита от преждевременного done');
assert.match(src, /Миссию не закрываю: сначала закройте карточки/, 'причина понятна человеку');

// ── 7. Переход не зацикливается на битом Agent URL ────────────────────────
const navFrom = src.indexOf('  async function navigateTo(role, why) {');
const navTo = src.indexOf('  /**\n   * Отправка без подтверждения', navFrom);
assert.ok(navFrom > 0 && navTo > navFrom, 'navigateTo на месте');
const navSrc = src.slice(navFrom, navTo);
assert.match(navSrc, /Date\.now\(\) - Number\(last\.at \|\| 0\) < 30_000/, 'повтор того же перехода в 30 секунд — зацикливание');
assert.match(navSrc, /pause\(\s*`Не удалось открыть страницу/, 'вместо прыжков — пауза с причиной');

const makeNav = ({ store, path = '/', now = Date.now() }) => {
  const pauses = [];
  const logs = [];
  const assigned = [];
  const flushes = [];
  const location = { pathname: path, assign: (u) => assigned.push(String(u)) };
  const clock = { now: () => now };
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'norm', 'pause', 'log', 'location', 'Date',
    // D-045: переход ждёт подтверждения записей; проверяем и порядок.
    'flushBeforeNavigate', 'handoffKeys',
    `${navSrc}; return navigateTo;`,
  );
  const navigateTo = fn(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    (text, ctx) => pauses.push({ text, ctx }),
    (text) => logs.push(text),
    location,
    clock,
    async (keys) => { flushes.push({ keys: [...keys], assigned: assigned.length, nav: store.get('cfn-nav') }); return true; },
    () => ['cfn-expect', 'cfn-pending', 'cfn-nav'],
  );
  return { navigateTo, pauses, logs, assigned, flushes };
};

const role = { id: 'architect', name: 'Architect', url: 'https://arena.ai/agent/architect' };

// 7.1. Первый переход — обычный.
{
  const h = makeNav({ store: new Map(), path: '/' });
  assert.equal(await h.navigateTo(role, 'ждём ответа'), true, 'переход выполнен');
  assert.deepEqual(h.assigned, ['https://arena.ai/agent/architect'], 'открыт адрес роли');
  assert.match(h.logs.join(' '), /открываю страницу «Architect»: ждём ответа/, 'причина в журнале');
  assert.equal(h.pauses.length, 0, 'паузы нет');
  // D-045: отметка перехода записана и подтверждена ДО ухода со страницы.
  assert.equal(h.flushes.length, 1, 'записи доведены до хранилища');
  assert.equal(h.flushes[0].assigned, 0, 'подтверждение раньше перехода');
  assert.equal(h.flushes[0].nav.roleId, 'architect', 'отметка перехода уже в хранилище');
  assert.deepEqual(h.flushes[0].keys, ['cfn-expect', 'cfn-pending', 'cfn-nav']);
}

// 7.2. Тот же переход до 30 секунд — пауза; на самой границе — разрешён.
{
  const store = new Map();
  await makeNav({ store, path: '/', now: 1_000 }).navigateTo(role, 'ждём ответа');
  const beforeLimit = makeNav({ store, path: '/', now: 30_999 });
  assert.equal(await beforeLimit.navigateTo(role, 'ждём ответа'), true, 'повтор обработан');
  assert.equal(beforeLimit.assigned.length, 0, 'до лимита второго перехода нет');
  assert.equal(beforeLimit.pauses.length, 1, 'цикл поставлен на паузу');
  assert.equal(beforeLimit.flushes.length, 0, 'петля не доходит до перехода');
  assert.match(beforeLimit.pauses[0].text, /Не удалось открыть страницу «Architect»/, 'человек видит причину');

  const atLimit = makeNav({ store, path: '/', now: 31_000 });
  assert.equal(await atLimit.navigateTo(role, 'ждём ответа'), true, 'переход после полного окна разрешён');
  assert.deepEqual(atLimit.assigned, [role.url], 'новый переход действительно открыт');
  assert.equal(atLimit.pauses.length, 0, 'на границе цикла нет ложной паузы');
}

// 7.3. Со другой страницы тот же адрес — это не петля.
{
  const store = new Map();
  await makeNav({ store, path: '/' }).navigateTo(role, 'ждём ответа');
  const h = makeNav({ store, path: '/agent/coordinator' });
  assert.equal(await h.navigateTo(role, 'ждём ответа'), true, 'переход с другой страницы разрешён');
  assert.equal(h.pauses.length, 0, 'паузы нет');
}

console.log(`OK: relay ${version} — автоцикл сам находит страницу, не петляет и не забивает журнал`);
