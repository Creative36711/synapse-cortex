// D-044 · K-30: подтверждённая доставка не теряется уборкой фантомов.
//
// Боевой случай: «Задание отправлено» с id сообщения зафиксировано, агент
// закончил ход и прислал маркер этой выдачи, но позднее `expect.sentAt`
// оказался пуст. Прежний dropGhostHandoff вернул карточку в Ready со словами
// «работы не было». Теперь факт доставки хранится отдельной квитанцией, а
// перед откатом ищется сама реплика этой выдачи в чате адресата.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

const from = src.indexOf('  const DELIVERY_RECEIPT_KEY');
const to = src.indexOf('  /** Уведомление и время относятся только к той очереди');
assert.ok(from > 0 && to > from, 'блок квитанций доставки на месте');
const block = src.slice(from, to);
// D-045: разбор опознавательных строк выдачи — настоящий блок исходника, а не
// его пересказ. Именно он теперь обслуживает и ключ доставки, и поиск реплики.
const idsFrom = src.indexOf('  function promptDispatchIds(text) {');
const idsTo = src.indexOf('  /** Своё сообщение в транскрипте', idsFrom);
assert.ok(idsFrom > 0 && idsTo > idsFrom, 'разбор dispatch/run на месте');
const idsBlock = src.slice(idsFrom, idsTo);

const DISPATCH = '40f6f0cf-5705-816d-8b13-ee1bb3f46841';
const RUN = 'eeee0444-aaef-4a47-af9f-78d65150e53a';
const OLD_RUN = '68f1b381-0000-7000-8000-000000000000';
const MSG = '01a1ad66-288d-79bf-8f02-e9ab18fc5b29';
const ROLE = '01a19d2b-bd07-722f-bbdb-20ba2f90028b';
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const isUuid = (x) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(x || ''));
const idTime = (id) => {
  const hex = String(id || '').replace(/-/g, '');
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isFinite(ms) ? ms : 0;
};
const promptText = (run = RUN) =>
  `Задача SYN-1 · K-30 (dispatch ${DISPATCH}, run ${run})\nCF_TECH\nmarker example`;

function make({ expect = null, pending = null, receipts = [], nodes = [], currentRole = ROLE } = {}) {
  const store = new Map([
    ['cfn-expect', expect],
    ['cfn-pending', pending],
    ['cfn-delivery-receipts-v1', receipts],
  ]);
  const logs = [];
  const rollbacks = [];
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'norm', 'isUuid', 'idTime', 'roleFromPath',
    'userMessages', 'messageRaw', 'nodeId', 'log', 'releaseUndelivered',
    `${idsBlock}\n${block}\nreturn { recordDeliveryReceipt, forgetDeliveryReceipt, deliveryReceipt, restoreMissingSendMark, dropGhostHandoff, dispatchPromptInChat, promptDispatchIds };`,
  )(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    { expect: 'cfn-expect', pending: 'cfn-pending', deadSend: 'cfn-dead-send' },
    norm, isUuid, idTime, () => currentRole,
    () => nodes,
    (node) => node.raw,
    (node) => node.id,
    (text, error, options) => logs.push({ text, error: Boolean(error), options }),
    async (handoff, why) => { rollbacks.push({ handoff, why }); return true; },
  );
  return { api, store, logs, rollbacks };
}

const baseExpect = {
  kind: 'dispatch', ref: DISPATCH, runId: RUN, roleId: ROLE,
  roleName: 'Executor Core', title: 'SYN-1 · K-30', at: 1762374494000,
  text: promptText(), seen: ['old-1'], sentAt: null, verified: false,
};

// 1. Квитанция пишется отдельно и восстанавливает потерянный sentAt.
{
  const h = make({ expect: { ...baseExpect } });
  h.api.recordDeliveryReceipt(baseExpect, { messageId: MSG, sentAt: 1762374524000, watermark: MSG, seen: ['old-1'] });
  const receipts = h.store.get('cfn-delivery-receipts-v1');
  assert.equal(receipts.length, 1, 'квитанция одна');
  assert.equal(receipts[0].messageId, MSG);
  assert.equal(receipts[0].runId, RUN);
  const dropped = await h.api.dropGhostHandoff('задание не дошло: отметки отправки нет');
  assert.equal(dropped, null, 'ход не объявлен фантомом');
  assert.equal(h.rollbacks.length, 0, 'карточка не возвращена в Ready');
  const live = h.store.get('cfn-expect');
  assert.equal(live.sentAt, 1762374524000, 'sentAt восстановлен');
  assert.equal(live.verified, true);
  assert.equal(live.watermark, MSG, 'граница ответа — подтверждённое сообщение');
  assert.equal(live.dispatchSentAt, 1762374524000, 'время работы исполнителя сохранено');
  assert.match(h.logs[0].text, /восстановлена/, 'причина видна в журнале');
}

// 2. Квитанция другой выдачи не спасает настоящий фантом.
{
  const h = make({
    expect: { ...baseExpect },
    receipts: [{
      key: `dispatch|${norm(DISPATCH)}|${norm(OLD_RUN)}|||${norm(ROLE)}`,
      kind: 'dispatch', ref: DISPATCH, runId: OLD_RUN, roleId: ROLE,
      messageId: 'old-msg', sentAt: 1, watermark: 'old-msg', seen: [],
    }],
  });
  const dropped = await h.api.dropGhostHandoff('нет отметки');
  assert.ok(dropped, 'без доказательства этой выдачи ход снят');
  assert.equal(h.rollbacks.length, 1, 'настоящий фантом возвращён в Ready');
  assert.equal(h.store.get('cfn-expect'), null);
}

// 3. Реплика этой выдачи в чате адресата — тоже доказательство.
{
  const h = make({
    expect: { ...baseExpect },
    nodes: [{ id: MSG, raw: promptText() }],
  });
  assert.equal(await h.api.dropGhostHandoff('нет отметки'), null);
  assert.equal(h.rollbacks.length, 0);
  assert.equal(h.store.get('cfn-expect').watermark, MSG);
}

// 4. Прошлая выдача той же карточки не принимается за текущую.
{
  const h = make({
    expect: { ...baseExpect },
    nodes: [{ id: 'old-msg', raw: promptText(OLD_RUN) }],
  });
  const dropped = await h.api.dropGhostHandoff('нет отметки');
  assert.ok(dropped, 'старый run не доказывает доставку нового');
  assert.equal(h.rollbacks.length, 1);
}

// 5. Чужая страница не читается как чат адресата.
{
  const h = make({
    expect: { ...baseExpect },
    nodes: [{ id: MSG, raw: promptText() }],
    currentRole: '01a19d29-b5c1-7368-8eba-1492816dda30',
  });
  assert.equal(h.api.dispatchPromptInChat(baseExpect), null);
}

// 6. Живая очередь не снимается уборкой.
{
  const h = make({ expect: { ...baseExpect }, pending: { roleId: ROLE, text: promptText(), at: 1 } });
  assert.equal(await h.api.dropGhostHandoff('нет отметки'), null);
  assert.equal(h.rollbacks.length, 0);
  assert.ok(h.store.get('cfn-expect'), 'ожидание сохранено, пока есть очередь');
}

// 7. Квитанции не растут бесконечно и не дублируют одну выдачу.
{
  const h = make({ expect: { ...baseExpect } });
  for (let i = 0; i < 120; i += 1) {
    h.api.recordDeliveryReceipt({ ...baseExpect, runId: `run-${i}` }, { messageId: `msg-${i}`, sentAt: i + 1 });
  }
  h.api.recordDeliveryReceipt(baseExpect, { messageId: MSG, sentAt: 1000 });
  h.api.recordDeliveryReceipt(baseExpect, { messageId: MSG, sentAt: 1001 });
  const list = h.store.get('cfn-delivery-receipts-v1');
  assert.equal(list.length, 100, 'хранится не больше 100 квитанций');
  assert.equal(list.filter((x) => x.runId === RUN).length, 1, 'одна квитанция на выдачу');
  assert.equal(list.at(-1).sentAt, 1001);
}

// 8. Капча/ошибка Arena гасят квитанцию: мёртвая реплика не доказывает доставку.
{
  const h = make({ expect: { ...baseExpect }, nodes: [{ id: MSG, raw: promptText() }] });
  h.api.recordDeliveryReceipt(baseExpect, { messageId: MSG, sentAt: 1000 });
  h.api.forgetDeliveryReceipt(baseExpect);
  assert.equal(h.api.deliveryReceipt(baseExpect), null, 'квитанция погашена');
  h.store.set('cfn-expect', { ...baseExpect, captcha: true });
  assert.equal(h.api.dispatchPromptInChat({ ...baseExpect, captcha: true }), null, 'капча не принимается за доставку');
  h.store.set('cfn-expect', { ...baseExpect });
  assert.ok(h.api.dispatchPromptInChat(baseExpect), 'без отметки deadSend реплика видна');
  h.store.set('cfn-dead-send', MSG);
  assert.equal(h.api.dispatchPromptInChat(baseExpect), null, 'мёртвое сообщение не доказывает доставку');
}
{
  const h = make({ expect: { ...baseExpect }, nodes: [{ id: MSG, raw: promptText() }] });
  h.store.set('cfn-pending', { roleId: ROLE, text: promptText(), at: 1, captcha: true });
  assert.equal(h.api.dispatchPromptInChat(baseExpect), null, 'очередь с капчей не доказывает доставку');
}

// 9. Проводка: квитанция до снятия очереди; потерянное ожидание не называется успехом.
const cpFrom = src.indexOf('  async function consumePending(');
const cpTo = src.indexOf('  // ───────────────────── следы прошлых попыток', cpFrom);
assert.ok(cpFrom > 0 && cpTo > cpFrom, 'consumePending на месте');
const cp = src.slice(cpFrom, cpTo);
assert.match(cp, /if \(!expect \|\| norm\(expect\.roleId\) !== norm\(me\)\) \{\s*pause\(/, 'потерянное ожидание ставит паузу, а не молчаливый успех');
assert.match(cp, /kind: "delivery-state-lost"/);
assert.match(cp, /recordDeliveryReceipt\(expect, \{ messageId: delivery\.msgId, sentAt, watermark: mark, seen \}\);[\s\S]*?GM_setValue\(K\.expect, \{[\s\S]*?GM_setValue\(K\.pending, null\);/, 'квитанция и отметка пишутся до снятия очереди');

// 10. Намеренный сброс доставки гасит квитанцию во всех путях повтора.
assert.match(src, /forgetDeliveryReceipt\(waiting\);\s*GM_setValue\(K\.expect, \{ \.\.\.waiting, captcha: true, sentAt: null/, 'капча гасит квитанцию');
assert.match(src, /forgetDeliveryReceipt\(failed\);\s*GM_setValue\(K\.expect, \{\s*\.\.\.failed,\s*undelivered: true/, 'отказ отправки гасит квитанцию');
const missing = readFileSync(new URL('../src/14-missing-marker.js', import.meta.url), 'utf8');
assert.match(missing, /forgetDeliveryReceipt\(expect\);\s*GM_setValue\(K\.expect, \{\s*\.\.\.expect,\s*text,\s*prompt: envelope,\s*sentAt: null/, 'arenaResend гасит квитанцию');
assert.match(missing, /forgetDeliveryReceipt\(expect\);\s*GM_setValue\(K\.expect, \{\s*\.\.\.expect,\s*sentAt: null,\s*verified: false,\s*branchResend/, 'branchResend гасит квитанцию');

// 11. Второй призрак в тике решает по живому состоянию, а не по устаревшему снимку.
const tickFrom = src.indexOf('  async function tick(');
const tick = src.slice(tickFrom);
assert.match(tick, /const ghost2 = await dropGhostHandoff\("задание не дошло: отметки отправки нет"\);\s*const live = GM_getValue\(K\.expect, null\);\s*if \(!ghost2 && live && Number\(live\.sentAt\)\) \{\s*expect = live;/, 'восстановленное ожидание не стирается повторной уборкой');

console.log('OK: relay D-044 — квитанция доставки и реплика выдачи спасают подтверждённый ход; настоящий фантом по-прежнему снимается');
