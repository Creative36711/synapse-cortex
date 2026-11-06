// Проба 1.4.44: возврат миссии отменяет прошлый ход Координатора.
//
// 24.10 в 15:47 Координатор ответил `done`, миссия закрылась, а ожидание плана
// осталось висеть: 1.4.41 на «нет активной миссии» его не снимала. В 16:07
// Мастер вернул NAR-1 на доработку, и в 16:12 шаг принял тот старый `done` за
// ответ на замечания — пауза «в «Итоге» нет раздела «Возврат»», хотя нового
// хода Координатора не было вовсе.
//
// Здесь проверяется:
//   • у каждого возврата свой отсчёт, и ожидание, начатое раньше, снимается;
//   • план, запрошенный после возврата, переживает перезагрузку страницы;
//   • повторный возврат (новый круг или новые замечания) начинает отсчёт заново;
//   • пауза done-with-remarks остаётся только для ответа уже после возврата,
//     и «Продолжить» после неё не ждёт минутный троттлинг;
//   • замечания одним абзацем «1) … 2) …» делятся на пункты, а строка журнала
//     режется по границе слова, а не тянет тысячу символов.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Версия ──────────────────────────────────────────────────────────────
const versionMatch = assertUserscriptVersionContract(src);

// ── 2. Функции возврата ────────────────────────────────────────────────────
const from = src.indexOf('  const firstLine = (text, max = 220) => {');
const to = src.indexOf('  const taskTitle = (p) => rt(p.properties["Запрос"]);');
assert.ok(from > 0 && to > from, 'блок возврата и замечаний на месте');
const block = src.slice(from, to);

function make({ store = new Map(), now = Date.parse('2026-10-24T16:12:51+03:00') } = {}) {
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'Date', 'isReturned', 'missionRemarks', 'textHash', 'rt',
    `${block}
     return { firstLine, remarkItems, returnFingerprint, returnEpoch, dropStalePlan, returnBlock, returnAnswered, textHash };`,
  )(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { expect: 'cfn-expect' },
    class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
    (page) => page?.properties?.['Состояние']?.select?.name === 'Возвращена',
    (page) => (page?.properties?.['Замечания']?.rich_text || []).map((x) => x.text?.content || '').join(''),
    (text) => {
      let h = 5381;
      const value = String(text);
      for (let i = 0; i < value.length; i += 1) h = ((h << 5) + h + value.charCodeAt(i)) | 0;
      return String(h);
    },
    // `rt` принимает свойство Notion, как боевая функция: в dropStalePlan и
    // returnBlock он вызывается на `properties[...]`, а не на странице.
    (prop) => (prop?.rich_text || []).map((x) => x.text?.content || '').join(''),
  );
  return { api, store };
}

const mission = ({ remarks = '1) раз 2) два 3) три', round = 1, at = '2026-10-24', editedAt = '',
  result = 'NAR-1 закрыта: 11 карточек…' } = {}) => ({
  id: 'mission-1',
  ...(editedAt ? { last_edited_time: editedAt } : {}),
  properties: {
    'Миссия': { title: [{ text: { content: 'NAR-1 · Ядро под паки' } }] },
    'Состояние': { select: { name: 'Возвращена' } },
    'Возвращена': { date: { start: at } },
    'Круг': { number: round },
    'Замечания': { rich_text: [{ text: { content: remarks } }] },
    'Итог': { rich_text: [{ text: { content: result } }] },
  },
});

const stale = (at) => ({ kind: 'plan', at, sentAt: at, ref: 'mission-1', turnId: 'turn-old' });

// 3a. Ожидание, начатое до возврата, снимается, и план разрешён сразу.
{
  const { api, store } = make();
  const m = mission();
  store.set('cfn-expect', stale(Date.parse('2026-10-24T15:47:00+03:00')));
  const epoch = api.returnEpoch(m);
  assert.equal(epoch.at, Date.parse('2026-10-24T16:12:51+03:00'), 'отсчёт возврата — первый шаг, который его увидел');
  const dropped = api.dropStalePlan(m, store.get('cfn-expect'), epoch);
  assert.equal(dropped, true, 'старый ход снят');
  assert.equal(store.get('cfn-expect'), null, 'ожидание очищено: маркер прошлого хода не будет прочитан');
  assert.equal(store.get('cfn-plan-at'), 0, 'минутный троттлинг снят: новый план уходит в этом же шаге');
}

// 3a2. План, запрошенный уже после возврата (в том числе ещё на 1.4.42),
// не снимается: отсчёт берётся по последней правке карточки миссии, а не по
// моменту обновления скрипта.
{
  const { api, store } = make();
  const m = mission({ editedAt: '2026-10-24T13:07:00Z' }); // 16:07 MSK — возврат
  const epoch = api.returnEpoch(m);
  assert.equal(epoch.at, Date.parse('2026-10-24T13:07:00Z'), 'отсчёт — время возврата');
  store.set('cfn-expect', { kind: 'plan', at: Date.parse('2026-10-24T16:20:00+03:00') });
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), epoch), false, 'план после возврата остаётся');
  store.set('cfn-expect', stale(Date.parse('2026-10-24T15:47:00+03:00')));
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), epoch), true, 'план до возврата снимается');
}

// 3b. План, запрошенный после возврата, не снимается — в том числе после
// перезагрузки страницы (отсчёт сохранён в хранилище скрипта).
{
  const store = new Map();
  const m = mission();
  const first = make({ store });
  const epoch = first.api.returnEpoch(m);
  const freshAt = epoch.at + 4_000;
  store.set('cfn-expect', { kind: 'plan', at: freshAt, sentAt: freshAt });

  const reload = make({ store, now: epoch.at + 60_000 });
  const same = reload.api.returnEpoch(m);
  assert.equal(same.at, epoch.at, 'отсчёт не переписывается при каждом шаге');
  assert.equal(reload.api.dropStalePlan(m, store.get('cfn-expect'), same), false, 'свежий план остаётся');
  assert.equal(store.get('cfn-expect')?.at, freshAt, 'ожидание не тронуто');
}

// 3c. Повторный возврат — новый круг или новые замечания — новый отсчёт.
{
  const store = new Map();
  const m = mission();
  const first = make({ store });
  const epoch = first.api.returnEpoch(m);
  const freshAt = epoch.at + 4_000;
  store.set('cfn-expect', { kind: 'plan', at: freshAt, sentAt: freshAt });

  const again = make({ store, now: epoch.at + 3 * 60 * 60 * 1000 });
  const second = again.api.returnEpoch(mission({ round: 2 }));
  assert.ok(second.at > epoch.at, 'второй возврат начинает отсчёт заново');
  assert.equal(again.api.dropStalePlan(mission({ round: 2 }), store.get('cfn-expect'), second), true, 'ход прошлого круга снят');

  store.set('cfn-expect', { kind: 'plan', at: second.at + 2_000, sentAt: second.at + 2_000 });
  assert.equal(again.api.dropStalePlan(mission({ round: 2 }), store.get('cfn-expect'), second), false, 'план нового круга остаётся');
}

// 3c2. Возврат, уже объявленный 1.4.42 (метка без отпечатка), не объявляется
// второй раз после обновления — но новый возврат объявляется заново.
{
  const store = new Map([['cfn-mission-return:mission-1', true]]);
  const { api } = make({ store });
  const m = mission();
  const epoch = api.returnEpoch(m);
  const seen = `cfn-mission-return:${m.id}:${api.textHash(epoch.fp)}`;
  assert.equal(store.get(seen), true, 'строка о возврате не повторится после обновления');

  const second = api.returnEpoch(mission({ round: 2 }));
  const seenSecond = `cfn-mission-return:${m.id}:${api.textHash(second.fp)}`;
  assert.notEqual(second.fp, epoch.fp, 'у нового возврата свой отпечаток');
  assert.ok(!store.get(seenSecond), 'новый возврат объявится своей строкой');
}

// 3c3. Главный случай 06.11: отсчёт возврата впервые считается уже ПОСЛЕ
// правки карточки, и ожидание, отправленное между возвратом и правкой, нельзя
// объявлять прошлым ходом.
//
// Возврат 17:07:32, план с замечаниями 17:07:57, Координатор к 17:18 создал
// K-38…K-41 и дописал «Возврат» в «Итог» → «последняя правка» 17:18. Шаг
// 17:19:30 снял живое ожидание, в 17:19:54 ушёл второй план подряд — агент
// потратил на него ещё 11 минут, и только сверка с очередью спасла от дублей.
{
  // Часы — 17:19:30, тот самый шаг. Иначе «последняя правка» окажется в
  // будущем, отсчёт возьмётся по часам, и проверка пройдёт случайно.
  const { api, store } = make({ now: Date.parse('2026-11-06T17:19:30+03:00') });
  // Правка «Итога» в 17:18: Координатор дописал раздел «Возврат» — тот самый,
  // которого требует план с замечаниями.
  const returned = mission({
    editedAt: '2026-11-06T14:18:40Z',
    result: 'Возврат: 1) --state → отпечаток K-39; 2) --lang → K-38; 3) render:font-sample → K-40.',
  });
  const epoch = api.returnEpoch(returned);
  assert.equal(epoch.at, Date.parse('2026-11-06T17:18:40+03:00'), 'отсчёт по последней правке — 17:18');
  const planAt = Date.parse('2026-11-06T17:07:57+03:00');
  store.set('cfn-expect', { kind: 'plan', at: planAt, sentAt: planAt, turnId: 'turn-1' });
  assert.equal(api.dropStalePlan(returned, store.get('cfn-expect'), epoch), false,
    'ход, который нёс замечания, не снимается');
  assert.equal(store.get('cfn-expect')?.turnId, 'turn-1', 'ожидание не тронуто');
}

// 3c3b. Тот же час, но «Итог» ещё не дописан: ожидание прошлого круга
// по-прежнему снимается — исправление не отменяет исходную защиту 24.10.
{
  const { api, store } = make({ now: Date.parse('2026-11-06T17:19:30+03:00') });
  const returned = mission({ editedAt: '2026-11-06T14:18:40Z' });
  const epoch = api.returnEpoch(returned);
  const oldAt = Date.parse('2026-11-06T15:47:00+03:00');
  store.set('cfn-expect', { kind: 'plan', at: oldAt, sentAt: oldAt, turnId: 'turn-old' });
  assert.equal(api.dropStalePlan(returned, store.get('cfn-expect'), epoch), true, 'план прошлого хода снят');
  assert.equal(store.get('cfn-expect'), null, 'ожидание очищено');
  assert.equal(store.get('cfn-plan-at'), 0, 'новый план разрешён сразу');
}

// 3c4. Тот же случай, но «Итога» в карточке ещё нет (агент пишет в него позже):
// держит снимок «план отправлен уже с замечаниями». Снимок сильнее времени.
{
  const { api, store } = make({ now: Date.parse('2026-11-06T17:19:30+03:00') });
  const m = mission({ editedAt: '2026-11-06T14:18:40Z' });
  const epoch = api.returnEpoch(m);
  store.set('cfn-expect', {
    kind: 'plan', at: epoch.at - 30 * 60 * 1000, sentAt: epoch.at - 30 * 60 * 1000, planBeforeReturn: false,
  });
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), epoch), false, 'план с замечаниями остаётся');

  store.set('cfn-expect', {
    kind: 'plan', at: epoch.at - 30 * 60 * 1000, sentAt: epoch.at - 30 * 60 * 1000, planBeforeReturn: true,
  });
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), epoch), true, 'план прошлого круга снят');
}

// 3c5. Отметка «возврат объявили» не даёт снять ход, начатый после неё, даже
// если время возврата уехало вперёд (остаток прошлой версии).
{
  const { api, store } = make({ now: Date.parse('2026-11-06T17:19:30+03:00') });
  const m = mission({ editedAt: '2026-11-06T14:18:40Z' });
  const markedAt = Date.parse('2026-11-06T17:07:40+03:00');
  const sent = Date.parse('2026-11-06T17:08:05+03:00');
  store.set('cfn-expect', { kind: 'plan', at: sent, sentAt: sent });
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), { at: Date.parse('2026-11-06T17:18:40+03:00'), fp: 'x', markedAt }), false,
    'ход после объявления возврата не старый');
  assert.equal(api.dropStalePlan(m, store.get('cfn-expect'), { at: Date.parse('2026-11-06T17:18:40+03:00'), fp: 'x' }), true,
    'без снимка и раздела «Возврат» остаётся правило по времени');
}

// 3c6. «Раздел «Возврат» в «Итоге»» — тот же признак, которого требует план:
// без замечаний или без раздела он ничего не доказывает.
{
  const { api } = make();
  assert.equal(api.returnAnswered(mission()), false, 'раздела нет — ответа нет');
  const answered = mission();
  answered.properties['Итог'] = { rich_text: [{ text: { content: 'Возврат: 1) сделано; 2) поправлено' } }] };
  assert.equal(api.returnAnswered(answered), true, 'раздел есть — ответ есть');
  const noRemarks = { ...answered, properties: { ...answered.properties, 'Замечания': { rich_text: [] } } };
  assert.equal(api.returnAnswered(noRemarks), false, 'без замечаний отвечать нечего');
}

// 3c7. Напоминание по тому же плану не теряет снимок «с замечаниями»: иначе
// повтор промпта возвращает нас к сравнению по времени правки карточки.
{
  const srcPolls = readFileSync(new URL('../src/17-arena-polls.js', import.meta.url), 'utf8');
  assert.match(srcPolls, /planCarry/, 'снимок переносится в новое ожидание');
  assert.match(srcPolls, /"planBeforeReturn" in previousPlan/, 'перенос только для плана той же миссии');
  assert.match(srcPolls, /previousPlan\.kind === "plan"/, 'чужое ожидание не переписывается');
  assert.ok(
    srcPolls.indexOf('planCarry') < srcPolls.indexOf('...payload,'),
    'снимок кладётся в ожидание раньше полей выдачи',
  );
}

// 3d. Замечания — по пунктам, даже если Мастер записал их одним абзацем.
{
  const { api } = make();
  const items = api.remarkItems('1) раз 2) два 3) три');
  assert.equal(items.length, 3, 'три пункта, а не один');
  assert.match(items[1], /^2\)/, 'второй пункт начинается со своего номера');
  // Notion хранит замечания несколькими rich_text-элементами, и `rt` склеивает
  // их без разделителя: «…не менялся.2) docs…». Граница пункта всё равно видна.
  const glued = api.remarkItems('1) раз.2) два.3) три');
  assert.equal(glued.length, 3, 'пункты, склеенные без пробела, тоже делятся');
  assert.match(glued[1], /^2\)/, 'второй пункт на месте');
  assert.deepEqual(api.remarkItems('- a\n- b'), ['a', 'b'], 'список с переводами строки тоже делится');
  assert.deepEqual(api.remarkItems('2026-10-24: 15 прогонов, 2 раза'), ['2026-10-24: 15 прогонов, 2 раза'], 'даты и числа не режутся');

  const text = api.returnBlock(mission({ remarks: '1) раз 2) два' }));
  assert.match(text, /- 1\) раз\n- 2\) два/, 'в плане Координатора каждый пункт отдельной строкой');
}

// 3e. Строка журнала не тянет тысячу символов одним абзацем.
{
  const { api } = make();
  const long = `1) Детерминизм не подтверждён — ${'очень длинное объяснение '.repeat(60)}`;
  const line = api.firstLine(long);
  assert.ok(line.length <= 221, `строка обрезана (${line.length})`);
  assert.ok(line.endsWith('…'), 'обрезана с многоточием');
  assert.ok(!line.includes('\n'), 'одна строка');
  assert.equal(api.firstLine('коротко'), 'коротко', 'короткий текст не трогается');
}

// ── 4. Порядок в шаге Координатора ─────────────────────────────────────────
const step = src.slice(src.indexOf('  async function coordinatorStep('), src.indexOf('  /**\n   * Запрос хода Координатора.'));
assert.ok(step.length > 1000, 'coordinatorStep на месте');
const returned = step.slice(step.indexOf('    if (isReturned(mission)) {'), step.indexOf('    await releaseStalled(mission);'));
assert.match(returned, /const epoch = returnEpoch\(mission\)/, 'отсчёт берётся до разбора маркера');
// Вызов снятия получает отсчёт вместе с отметкой «когда объявили возврат»;
// важно не буквальное имя аргумента, а порядок: отсчёт считается раньше.
const dropCall = returned.search(/dropStalePlan\(mission, expect,/);
assert.ok(dropCall > 0, 'снятие ожидания вызывается из шага Координатора');
assert.ok(returned.indexOf('returnEpoch(mission)') < dropCall, 'сначала отсчёт, потом проверка ожидания');
assert.match(returned, /markedAt/, 'вместе с отсчётом передаётся момент объявления возврата');
assert.match(returned, /expect = null/, 'старое ожидание не доходит до разбора маркера');
assert.match(block, /GM_setValue\("cfn-plan-at", 0\)/, 'снятие старого хода разрешает новый план немедленно');
assert.ok(
  step.search(/dropStalePlan\(mission, expect,/) < step.indexOf('if (expect && (expect.kind === "plan"'),
  'снятие идёт до ветки разбора ответа Координатора',
);

const done = step.slice(step.indexOf('        const returned = isReturned(mission);'), step.indexOf('        if (fresh.draft.length) {'));
assert.match(done, /GM_setValue\("cfn-plan-at", 0\)/, 'после паузы «Продолжить» не ждёт минуту');
assert.match(done, /уже после возврата/, 'пауза объясняет, что ответ был после возврата, а не вместо него');
assert.match(done, /done-with-remarks/, 'пауза сохранила свой вид');

// Снимок «с замечаниями» рождается в requestPlan из содержимого задачи — до
// отправки — и уезжает в ожидание. Время правки карточки для этого не годится.
const planFrom = src.indexOf('  async function requestPlan(');
const plan = src.slice(planFrom, src.indexOf('\n  }\n', src.indexOf('if (sent) await markDelivered(briefing.fresh);', planFrom)));
assert.match(plan, /const planBeforeReturn = !isReturned\(mission\)/, 'снимок считается в requestPlan');
const snapshot = plan.slice(plan.indexOf('const planBeforeReturn'));
assert.match(
  snapshot.slice(0, snapshot.indexOf('Recovery')),
  /returnBlock\(mission\)/,
  'признак берётся из содержимого задачи (returnBlock), а не из времени',
);
assert.ok(
  plan.indexOf('const planBeforeReturn') < plan.indexOf('sendToRole('),
  'снимок готов до отправки плана',
);
assert.match(plan, /planBeforeReturn,/, 'снимок уходит в ожидание');

assert.match(src, /const items = remarkItems\(remarks\)\.map/, 'returnBlock использует разбор замечаний по пунктам');
assert.match(src, /cfn-mission-return-at:/, 'отсчёт возврата хранится по миссии');

console.log('OK: relay 1.4.63 — возврат миссии снимает прошлый ход, старый done не считается ответом на замечания');
