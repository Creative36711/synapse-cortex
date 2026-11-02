// Проба «агент ещё отвечает»: когда Stop — настоящий, а когда — призрак.
//
// Случай Мастера (2026-10-23, 18:40): «Шаг» открыл страницу Architect и сразу
// отказался работать: «агент ещё отвечает (кнопка «Stop generating»)». Ответ
// Architect был закончен давно, кнопки на экране не было.
//
// Две причины, обе проверяются здесь:
//   1. кнопка живёт в панели действий сообщения, скрытой `opacity: 0` на
//      обёртке: своя прозрачность единица, площадь есть — «видна»;
//   2. сразу после перехода Arena показывает Stop на время загрузки — один
//      кадр не должен останавливать нажатый шаг.
//
// 24.10 Мастер прислал разметку настоящей кнопки:
//   <button aria-label="Stop generating" data-perf-target="send"> внутри
//   панели ввода, и добавил: «когда он не активен, его нигде не видно».
// Значит Stop в слоте отправки — честный признак генерации, а правило
// «ответ закончился — значит призрак» относится только к панели действий
// сообщения.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Скрытый предок отменяет «видимость» ─────────────────────────────────
const hFrom = src.indexOf('  const hiddenByAncestor = (el) => {');
const hTo = src.indexOf('  /** Где живёт кнопка');
assert.ok(hFrom > 0 && hTo > hFrom, 'проверка скрытых предков на месте');
const hiddenByAncestor = new Function(
  'getComputedStyle',
  `${src.slice(hFrom, hTo)}; return hiddenByAncestor;`,
)((el) => el.__style || { opacity: '1', visibility: 'visible', display: 'block' });

const chain = (styles) => {
  // Собираем цепочку предков: последний элемент — самый внешний.
  let parent = null;
  const nodes = styles.map((st) => {
    const node = { __style: st, parentElement: parent, getAttribute: () => null, hasAttribute: () => false };
    parent = node;
    return node;
  });
  return nodes.at(-1);
};

assert.equal(hiddenByAncestor(chain([{ opacity: '1' }, { opacity: '1' }])), false, 'обычная кнопка не скрыта');
assert.equal(hiddenByAncestor(chain([{ opacity: '1' }, { opacity: '0' }])), true, 'прозрачная обёртка скрывает кнопку');
assert.equal(hiddenByAncestor(chain([{ opacity: '1' }, { visibility: 'hidden' }])), true, 'visibility на обёртке');
assert.equal(hiddenByAncestor(chain([{ opacity: '1' }, { display: 'none' }])), true, 'display: none на обёртке');

{
  let node = { getAttribute: (n) => (n === 'aria-hidden' ? 'true' : null), hasAttribute: () => false, parentElement: null };
  const child = { getAttribute: () => null, hasAttribute: () => false, parentElement: node };
  assert.equal(hiddenByAncestor(child), true, 'aria-hidden на обёртке');
}

// ── 2. busyReason: кнопка ищется с учётом предков и протухших сообщений ────
const bFrom = src.indexOf('  function busyReason() {');
const bTo = src.indexOf('  const generating = () => busyReason()?.kind === "stop";');
assert.ok(bFrom > 0 && bTo > bFrom, 'busyReason на месте');
const bBlock = src.slice(bFrom, bTo);

function busy({ buttons, messages = [], ended = false, opacity = '1', ancestorOpacity = '1', where = 'composer', plaque = false } = {}) {
  const makeAncestor = () => ({
    __style: { opacity: ancestorOpacity, visibility: 'visible', display: 'block' },
    parentElement: null,
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
  });
  const nodes = buttons.map((btn) => ({
    ...btn,
    parentElement: makeAncestor(),
    getAttribute: (n) => (n === 'aria-label' ? btn.label : null),
    hasAttribute: () => false,
    closest: (sel) => {
      if (sel.includes('data-perf-target')) return btn.slot ? { __slot: true } : null;
      if (sel.includes('data-agent-transcript-message')) return where === 'message' ? { __msg: true, id: btn.msg } : null;
      if (sel.includes('form') || sel.includes('footer') || sel.includes('composer')) return where === 'composer' ? { __form: true } : null;
      return null;
    },
    __style: { opacity, visibility: 'visible', display: 'block', pointerEvents: 'auto' },
  }));
  const doc = {
    querySelectorAll: (sel) => {
      if (sel === 'button, [role="button"]') return nodes;
      if (sel === '[data-agent-transcript-message]') return messages;
      return [];
    },
  };
  const fn = new Function(
    'completionPlaque', 'document', 'visible', 'getComputedStyle', 'shortLabel', 'replyEnded', 'hiddenByAncestor',
    'whereIs', 'stopIsStale', 'composerSlot',
    `${bBlock}; return busyReason;`,
  );
  return fn(
    () => plaque,
    doc,
    () => true,
    (el) => el.__style || { opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' },
    (el) => el.label || '',
    () => ended,
    (el) => Number(el.__style?.opacity) === 0 || Number(el.parentElement?.__style?.opacity) === 0,
    () => (where === 'composer' ? ' в поле ввода' : where === 'message' ? ' в сообщении' : ''),
    (el) => Boolean(el.__stale),
    (el) => Boolean(el.closest?.('[data-perf-target="send"]')),
  );
}

assert.equal(busy({ buttons: [] })(), null, 'нет кнопок — агент молчит');
assert.equal(busy({ buttons: [{ label: 'Stop generating' }] })().label, 'Stop generating', 'настоящая кнопка Stop — признак работы');
assert.equal(busy({ buttons: [{ label: 'Stop generating' }] })().where, ' в поле ввода', 'видно, где кнопка');
assert.equal(busy({ buttons: [{ label: 'Stop generating' }], opacity: '0' })(), null, 'прозрачная кнопка не считается');
assert.equal(busy({ buttons: [{ label: 'Stop generating' }], ancestorOpacity: '0' })(), null, 'скрытая обёртка не считается');
assert.equal(busy({ buttons: [{ label: 'Stop generating', __stale: true }] })(), null, 'Stop из законченного сообщения — призрак');
assert.equal(busy({ buttons: [{ label: 'Send' }] })(), null, 'другие кнопки не путаются');

// Слот отправки: в покое Arena не рисует там Stop вовсе.
assert.equal(
  busy({ buttons: [{ label: 'Stop generating', slot: true }] })().slot,
  true,
  'Stop в слоте отправки — настоящий признак генерации',
);
assert.equal(
  busy({ buttons: [{ label: 'Stop generating', slot: true }], ended: true })().kind,
  'stop',
  'и «последний ответ закончился» его не отменяет: в покое кнопки нет в разметке',
);
assert.equal(
  busy({ buttons: [{ label: 'Stop generating', __stale: true }] })(),
  null,
  'Stop в панели действий законченного сообщения — призрак',
);
assert.equal(
  busy({ buttons: [{ label: 'Stop generating' }], plaque: true })(),
  null,
  'плашка «задача выполнена» — агент свободен даже при видимой кнопке Stop',
);

// ── 3. stopIsStale: сообщение закончилось — кнопка протухла ────────────────
const stFrom = src.indexOf('  const stopIsStale = (el) => {');
const stTo = src.indexOf('  function busyReason() {');
const stopIsStale = new Function(
  'document', 'replyEnded',
  `${src.slice(stFrom, stTo)}; return stopIsStale;`,
);
const docWith = (messages) => ({ querySelectorAll: (sel) => (sel === '[data-agent-transcript-message]' ? messages : []) });
const inMsg = (msg) => ({ closest: () => msg });

{
  const only = { id: 'm1' };
  assert.equal(stopIsStale(docWith([only]), () => false)(inMsg(only)), false, 'последнее сообщение печатается — Stop настоящий');
  assert.equal(stopIsStale(docWith([only]), () => true)(inMsg(only)), true, 'ответ закончен — Stop в нём призрак');
}
{
  const first = { id: 'm1' };
  const last = { id: 'm2' };
  const doc = docWith([first, last]);
  assert.equal(stopIsStale(doc, () => false)(inMsg(last)), false, 'Stop в последнем сообщении во время печати — настоящий');
  assert.equal(stopIsStale(doc, () => false)(inMsg(first)), true, 'Stop в старом сообщении — призрак');
  assert.equal(stopIsStale(doc, () => true)(inMsg(last)), true, 'у законченного последнего сообщения Stop — призрак');
}
assert.equal(
  stopIsStale(docWith([]), () => false)({ closest: () => null }),
  false,
  'Stop в поле ввода (вне сообщений) не протухает',
);

// ── 4. Мгновенный кадр не останавливает шаг ────────────────────────────────
const sFrom = src.indexOf('  async function busySettled(stepMs = 1200) {');
const sTo = src.indexOf('  const busyLabel = (reason) =>');
assert.ok(sFrom > 0 && sTo > sFrom, 'busySettled на месте');
const sBlock = src.slice(sFrom, sTo);
const settle = (samples) => {
  let i = 0;
  const busyReason = () => samples[Math.min(i++, samples.length - 1)];
  const dbg = () => {};
  const sleep = async () => {};
  return new Function('busyReason', 'sleep', 'dbg', `${sBlock}; return busySettled;`)(busyReason, sleep, dbg);
};

assert.equal(await settle([null])(), null, 'сразу пусто — не ждём');
assert.equal(await settle([{ kind: 'stop' }, null])(), null, 'Stop мигнул и исчез — шаг продолжается');
assert.equal((await settle([{ kind: 'stop' }, { kind: 'stop' }])())?.kind, 'stop', 'Stop остаётся — агент правда работает');

// ── 5. Повтор шага ограничен и ничего не отправляет ────────────────────────
const rFrom = src.indexOf('  let stepRetry = 0;');
const rTo = src.indexOf('  async function tick(fromToggle = false) {');
const retrySrc = src.slice(rFrom, rTo);
assert.match(retrySrc, /if \(stepRetry >= 2\) return;/, 'не больше двух повторов');
assert.match(retrySrc, /tick\(true\);/, 'после исчезновения Stop шаг продолжается сам');
assert.doesNotMatch(retrySrc, /sendToRole|consumePending|submitExecutor/, 'повтор ничего не отправляет');

// ── 6. Строка в журнале говорит, где кнопка ────────────────────────────────
assert.match(src, /кнопка «\$\{reason\.label\}»\$\{reason\.where \|\| ""\}/, 'в журнале видно, где нашлась кнопка');
assert.match(src, /const composerSlot = \(el\) => Boolean\(el\?\.closest\?\.\('\[data-perf-target="send"\]'\)\);/, 'слот отправки определяется по разметке Arena');
assert.match(src, /if \(!composerSlot\(b\) && stopIsStale\(b\)\) return false;/, 'протухание — только для панели действий сообщения');
assert.match(src, /Проверю ещё раз через/, 'Мастер видит, что шаг проверится сам');

console.log('OK: relay 1.4.63 — Stop в слоте отправки настоящий, скрытый и протухший не блокируют шаг, заставка не считается');
