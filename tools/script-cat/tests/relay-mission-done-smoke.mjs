// Проба 1.4.44: конец миссии — событие, возврат миссии — задача.
//
// 24.10 в 15:49 Координатор закрыл миссию NAR-1 (`Состояние = Завершена`,
// `next:done`), а ScriptCat написал в журнал только «Нет активной миссии —
// ждём»: ни зелёной строки, ни пуша, ни выключенного автоцикла. Мастер узнал
// о конце работы из чата.
//
// Здесь проверяется:
//   • конец миссии объявляется один раз: зелёная строка, громкий пуш, автоцикл
//     выключен, ожидание снято;
//   • обычное «миссии пока нет» (закрытая миссия недельной давности) остаётся
//     тишиной;
//   • «Возвращена» — активная миссия, замечания идут в план Координатора;
//   • возвращённую миссию нельзя закрыть без раздела «Возврат» в «Итоге»;
//   • закрытие плашки не даёт двух одинаковых строк в журнале.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

// ── 1. Цвет журнала ────────────────────────────────────────────────────────
const colorBlock = sliceBetween('const logColor = (e) =>', 'function renderLog()');
assert.match(colorBlock, /"#8ee28e"/, 'зелёный цвет есть');
assert.match(colorBlock, /"#ffd479"/, 'жёлтый цвет есть');
assert.match(colorBlock, /e\.error \? "#ff9a9a"/, 'ошибка остаётся красной');
assert.match(src, /tone: options\.tone \|\| ""/, 'тон строки сохраняется вместе с записью');
{
  const fn = new Function(`${colorBlock}; return logColor;`)();
  assert.equal(fn({ error: true, tone: 'ok' }), '#ff9a9a', 'ошибка важнее тона');
  assert.equal(fn({ error: false, tone: 'ok' }), '#8ee28e', 'успех — зелёный');
  assert.equal(fn({ error: false, tone: 'warn' }), '#ffd479', 'предупреждение — жёлтое');
  assert.equal(fn({ error: false }), 'inherit', 'рутина остаётся обычной');
}

// ── 2. Конец миссии: объявление события ────────────────────────────────────
const noticeBlock = sliceBetween('  async function missionDoneNotice(expect) {', '  /**\n   * Блок замечаний Мастера');
assert.match(noticeBlock, /autoSet\(false\)/, 'автоцикл выключается: цикл остановлен, а не «ждёт»');
assert.match(
  noticeBlock,
  /ntfy: failed && \(running \|\| waited\) \? "loud" : "quiet"/,
  'громко только «Провалена», остановившая цикл или ход: принятую объявляет приёмка',
);
assert.match(noticeBlock, /tone: failed \? "warn" : "ok"/, 'успех зелёный, провал жёлтый');
assert.match(noticeBlock, /cfn-mission-done:/, 'событие объявляется один раз на миссию');
assert.match(noticeBlock, /GM_setValue\(K\.expect, null\)/, 'ожидание снимается: ход вернуть некуда');

// verdict — отметка приёмки: `accept` значит, что миссию закрыла роль Reviewer,
// а не агент своей рукой. По умолчанию она есть: большинство случаев проверяют
// объявление закрытия, а не его законность.
//
// Время в пробе зафиксировано, а не взято из часов. 29.10 проба упала на
// «ровно одна пауза»: у закрытой миссии стояла дата 2026-10-28, а реальные
// часы ушли за сутки, и правило «свежее закрытие» перестало срабатывать.
// Код был цел — красной стала проба. Даты в ней заданы числами, значит и
// «сейчас» должно быть числом.
const FIXED_NOW = Date.parse('2026-10-28T12:00:00Z');

function makeNotice({ closed = null, store = new Map(), expect = null, now = FIXED_NOW, verdict = 'accept' } = {}) {
  const logs = [];
  const pauses = [];
  // Отметку ставим только при первом построении: иначе второй проход по тому
  // же store «лечил» бы случай, который проверяет отсутствие вердикта.
  if (closed && verdict && !store.has(`cfn-review:${closed.id}`)) store.set(`cfn-review:${closed.id}`, verdict);
  const fn = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'log', 'lastClosedMission', 'autoSet', 'autoOn', 'setStatus', 'rt', 'missionKind', 'pause', 'Date',
    `${noticeBlock}; return missionDoneNotice;`,
  );
  const call = fn(
    (k, d) => (store.has(k) ? store.get(k) : d),
    (k, v) => store.set(k, v),
    { expect: 'cfn-expect' },
    (t, e, o) => logs.push({ t, e, o }),
    async () => closed,
    () => store.set('auto', false),
    () => store.get('auto') === true,
    () => {},
    (prop) => (prop?.rich_text || []).map((x) => x.text?.content || '').join(''),
    (page) => page?.properties?.['Состояние']?.select?.name || '',
    (reason, context = {}) => pauses.push({ reason, kind: context.kind }),
    class extends Date {
      constructor(...args) {
        super(...(args.length ? args : [now]));
      }
      static now() {
        return now;
      }
    },
  );
  return { call, logs, store, pauses };
}

const closedMission = (state = 'Завершена', at = '2026-10-24') => ({
  id: 'mission-1',
  properties: {
    'Миссия': { rich_text: [{ text: { content: 'NAR-1 · Ядро под паки' } }] },
    'Состояние': { select: { name: state } },
    'Завершена': { date: { start: at } },
  },
});

// 2a. Конец миссии после запрошенного плана: это событие.
{
  const { call, logs, store } = makeNotice({
    closed: closedMission(),
    expect: { kind: 'plan', ref: 'mission-1' },
  });
  const handled = await call({ kind: 'plan', ref: 'mission-1' });
  assert.equal(handled, true, 'шаг считается обработанным');
  assert.equal(store.get('cfn-expect'), null, 'ожидание снято');
  assert.equal(store.get('auto'), false, 'автоцикл выключен');
  assert.equal(logs.length, 1, 'одна строка, а не две');
  assert.match(logs[0].t, /Миссия «NAR-1 · Ядро под паки» завершена/, 'видно, какая миссия');
  assert.match(logs[0].t, /цикл остановлен/, 'сказано, что дальше ничего не поедет');
  assert.equal(logs[0].o.tone, 'ok', 'строка зелёная');
  assert.equal(logs[0].o.ntfy, 'quiet', 'без громкого пуша: принятую миссию объявляет сама приёмка');
}

// 2b. Повторный шаг не повторяет пуш.
{
  const store = new Map();
  const closed = closedMission();
  const first = makeNotice({ closed, store, expect: { kind: 'plan' } });
  await first.call({ kind: 'plan' });
  const second = makeNotice({ closed, store, expect: { kind: 'plan' } });
  const handled = await second.call({ kind: 'plan' });
  assert.equal(handled, true, 'шаг по-прежнему обработан');
  assert.equal(second.logs.length, 0, 'второй раз пуш не уходит');
}

// 2c. Закрытая миссия недельной давности — не событие.
{
  const { call, logs } = makeNotice({ closed: closedMission('Завершена', '2026-10-15'), expect: null });
  const handled = await call(null);
  assert.equal(handled, false, 'шаг не считается особым событием');
  assert.equal(logs.length, 0, 'журнал молчит');
}

// 2c-bis. Миссию вернули и закрыли снова — это новое событие, а не повтор.
// 28.10 NAR-4 закрыли повторно после возврата, а флаг «объявлено» остался с
// 27.10: Мастер не получил ни громкого пуша, ни остановленного автоцикла.
{
  const store = new Map();
  const firstClose = closedMission('Завершена', '2026-10-27');
  const first = makeNotice({ closed: firstClose, store, expect: { kind: 'plan' } });
  await first.call({ kind: 'plan' });
  assert.equal(first.logs.length, 1, 'первое закрытие объявлено');

  const reClosed = {
    ...closedMission('Завершена', '2026-10-28'),
    properties: {
      ...closedMission('Завершена', '2026-10-28').properties,
      'Возвращена': { date: { start: '2026-10-28' } },
    },
  };
  const second = makeNotice({ closed: reClosed, store, expect: { kind: 'plan' } });
  await second.call({ kind: 'plan' });
  assert.equal(second.logs.length, 1, 'второе закрытие после возврата снова объявлено');
  assert.equal(second.store.get('auto'), false, 'и снова гасит автоцикл');
  assert.equal(second.logs[0].o.ntfy, 'quiet', 'пуш снова тихий: громко объявляет только приёмка');
}

// 2c-ter. Повторный проход по уже объявленному закрытию тоже гасит автоцикл.
{
  const store = new Map();
  const closed = closedMission();
  const first = makeNotice({ closed, store, expect: { kind: 'plan' } });
  await first.call({ kind: 'plan' });
  store.delete('auto');
  const second = makeNotice({ closed, store, expect: { kind: 'plan' } });
  await second.call({ kind: 'plan' });
  assert.equal(store.get('auto'), false, 'закрытая миссия не оставляет автоцикл включённым');
  assert.equal(second.logs.length, 0, 'но строку и пуш второй раз не печатает');
}

// 2c-quater. «Завершена» — дата без времени: закрытие сегодняшнего дня
// объявляется и через полчаса, и через восемь часов, если цикл работал.
{
  const now = new Date(2026, 9, 28, 12, 0, 0).getTime();
  const { call, logs, store } = makeNotice({
    closed: closedMission('Завершена', '2026-10-28'),
    expect: { kind: 'marker', ref: 'mission-1' },
    now,
  });
  const handled = await call({ kind: 'marker', ref: 'mission-1' });
  assert.equal(handled, true, 'закрытие этого дня — событие, а не тишина');
  assert.equal(store.get('auto'), false, 'автоцикл выключен');
  assert.equal(logs[0].o.ntfy, 'quiet', 'пуш тихий: принятую миссию объявляет приёмка');
}

// 2c-quinquies. Крутящийся автоцикл останавливается и о старом закрытии
// говорит вслух: иначе он бесконечно писал бы «Миссий в работе нет».
{
  const { call, logs, store } = makeNotice({
    closed: closedMission('Завершена', '2026-10-15'),
    expect: null,
  });
  store.set('auto', true);
  const handled = await call(null);
  assert.equal(handled, true, 'пустой ход не выдаётся за «нет миссии»');
  assert.equal(store.get('auto'), false, 'автоцикл остановлен');
  assert.equal(logs.length, 1, 'о конце работы сказано один раз');
  assert.equal(logs[0].o.ntfy, 'quiet', 'и тихим пушем: конец работы объявляет приёмка');
}

// 2c-sexies. Без цикла и без ожидания старое закрытие — тишина.
{
  const { call, logs, store } = makeNotice({ closed: closedMission('Завершена', '2026-09-30'), expect: null });
  const handled = await call(null);
  assert.equal(handled, false, 'старое закрытие не событие');
  assert.equal(logs.length, 0, 'пуш не уходит');
  assert.equal(store.get('auto'), false, 'но автоцикл всё равно выключен');
}

// 2d. «Провалена» называется своим словом.
{
  const { call, logs } = makeNotice({ closed: closedMission('Провалена'), expect: { kind: 'plan' } });
  await call({ kind: 'plan' });
  assert.match(logs[0].t, /закрыта как «Провалена»/, 'провал не выдаётся за успех');
  assert.equal(logs[0].o.tone, 'warn', 'строка жёлтая');
  assert.equal(logs[0].o.ntfy, 'loud', 'провал звонит: разбирать его Мастеру');
}

// 2d-bis. Провал, замеченный на уже выключенном стенде, не объявляем сиреной.
{
  const { call, logs, store } = makeNotice({ closed: closedMission('Провалена', '2026-10-28'), expect: null });
  await call(null);
  assert.equal(store.get('auto'), false, 'стенд и так выключен');
  assert.match(logs[0].t, /«Провалена»/);
  assert.equal(logs[0].o.ntfy, 'quiet', 'провал без остановленного хода не будит');
}
// Включённый автоцикл при обнаружении провала действительно выключается.
{
  const { call, logs, store } = makeNotice({ closed: closedMission('Провалена', '2026-10-28'), expect: null });
  store.set('auto', true);
  await call(null);
  assert.equal(store.get('auto'), false);
  assert.equal(logs[0].o.ntfy, 'loud');
  assert.equal(logs[0].o.cycleStopped, true);
}

// 2e. Миссию закрыли без приёмки — это стоп с объяснением, а не «конец работы».
// Координатор больше не имеет права ставить «Завершена»: это решение приёмки.
{
  const { call, logs, store, pauses } = makeNotice({
    closed: closedMission('Завершена', '2026-10-28'),
    expect: { kind: 'plan', ref: 'mission-1' },
    verdict: '',
  });
  const handled = await call({ kind: 'plan', ref: 'mission-1' });
  assert.equal(handled, true, 'шаг остановлен, а не продолжен');
  assert.equal(pauses.length, 1, 'ровно одна пауза');
  assert.equal(pauses[0].kind, 'closed-unreviewed', 'вид паузы — закрытие в обход приёмки');
  assert.match(pauses[0].reason, /приёмка вердикта не давала/, 'сказано, чего не было');
  assert.match(pauses[0].reason, /верните её в «Возвращена»/, 'сказано, что делать');
  assert.equal(logs.length, 0, 'зелёной строки о конце работы нет');
  assert.equal(store.get('cfn-review-ack:mission-1:2026-10-28'), true, 'второй раз о том же не сообщаем');
}

// 2f. Тот же случай после «Продолжить»: закрытие принимается и объявляется.
{
  const store = new Map();
  const closed = closedMission('Завершена', '2026-10-28');
  const first = makeNotice({ closed, store, expect: { kind: 'plan' }, verdict: '' });
  await first.call({ kind: 'plan' });
  const second = makeNotice({ closed, store, expect: { kind: 'plan' }, verdict: '' });
  const handled = await second.call({ kind: 'plan' });
  assert.equal(handled, true, 'закрытие всё равно останавливает цикл');
  assert.equal(second.pauses.length, 0, 'второй паузы нет');
  assert.equal(second.logs.length, 1, 'и теперь сказано о конце работы');
  assert.equal(second.logs[0].o.ntfy, 'quiet', 'тихим пушем: закрытие в обход приёмки');
}

// 2g. Тихий стенд без цикла и без ожидания: закрытие без вердикта не будит.
{
  const { call, pauses, logs } = makeNotice({
    closed: closedMission('Завершена', '2026-10-01'),
    expect: null,
    verdict: '',
  });
  await call(null);
  assert.equal(pauses.length, 0, 'старое закрытие не пауза');
  assert.equal(logs.length, 0, 'и не событие');
}

// ── 3. Возврат миссии ──────────────────────────────────────────────────────
assert.match(src, /select: \{ equals: "Возвращена" \}/, '«Возвращена» считается активной миссией');
const remarkItems = sliceBetween('  const remarkItems = (text) =>', '  /** Последняя закрытая миссия');
const returnBlock = sliceBetween('  function returnBlock(mission) {', '  const taskTitle =');
{
  const fn = new Function(
    'isReturned', 'missionRemarks',
    `${remarkItems}\n${returnBlock}; return returnBlock;`,
  );
  const block = fn(
    () => true,
    () => '- smoke:dialogue-transitions зелёный\n- в «Итоге» нет раздела «Возврат»',
  )({ properties: { 'Возвращена': { date: { start: '2026-10-25' } } } });
  assert.match(block, /МИССИЯ ВОЗВРАЩЕНА МАСТЕРОМ 2026-10-25 НА ДОРАБОТКУ/, 'шапка блока');
  assert.match(block, /- smoke:dialogue-transitions зелёный/, 'замечания построчно');
  assert.match(block, /на каждое замечание — отдельная карточка/, 'правила возврата в промпте');
}
assert.match(src, /returnBlock\(mission\),/, 'блок попадает в план Координатора');

// У возвращённой миссии «done» без раздела «Возврат» не принимается.
assert.match(src, /returned && !\/возврат\/i\.test\(rt\(mission\.properties\["Итог"\]\)\)/, 'проверка раздела «Возврат»');
assert.match(src, /done-with-remarks/, 'это пауза с понятной причиной');
assert.match(src, /return-empty/, 'пустые замечания тоже пауза, а не молчаливый ход');

// ── 4. Плашка: одна строка, и только по факту ──────────────────────────────
// 1.4.45: «закрыть заранее» вырезано — первая попытка не срабатывала, и в
// журнале появлялась вторая такая же строка со счётчиком закрытий.
const plaqueFrom = src.indexOf('    // Плашка «Эта задача была выполнена успешно?» закрывает поле ввода.');
const plaqueTo = src.indexOf('if (!editor) {', plaqueFrom);
const plaqueBlock = src.slice(plaqueFrom, plaqueTo);
assert.ok(plaqueFrom > 0 && plaqueTo > plaqueFrom, 'блок закрытия плашки на месте');
assert.equal(
  (plaqueBlock.match(/log\(/g) || []).length,
  1,
  'о плашке говорится одной строкой за шаг',
);
assert.match(plaqueBlock, /const \{ editor, closed, overlay \} = await ensureComposer\(\)/, 'плашку закрывает поиск поля ввода');
assert.match(plaqueBlock, /if \(closed\) log\(/, 'строка журнала — по факту закрытия');
assert.match(plaqueBlock, /«задача выполнена»/, 'формулировка осталась прежней');
assert.doesNotMatch(plaqueBlock, /plaqueClosed/, 'счётчика закрытий больше нет');

console.log('OK: relay 1.4.63 — конец миссии зелёной строкой и пушем, возврат доработкой, плашка одной строкой');
