// Проба чтения ответа: где кончается «наше» и начинается ответ агента.
//
// 24.10 в 14:27 скрипт сказал «новых сообщений нет», хотя ответ Build/Release
// с маркером лежал в чате. Причина — граница «после отправки»: id сообщений
// Arena не упорядочены по времени (ответ `01a16da4-10b2…` пришёл позже
// запроса `01a16da4-1dc9…`, но меньше его), а водяной знак — это id нашей же
// реплики, которую фильтр отбрасывает. Здесь проверяется:
//   • граница считается по полному списку (вместе с нашими репликами);
//   • потерянный водяной знак заменяется снимком id, снятым перед отправкой;
//   • ответ находится по маркеру выдачи, даже если позиция подвела;
//   • ответ прошлого круга (старый id) за новый не сходит;
//   • цитата задания с настоящим маркером остаётся ответом;
//   • кнопка Stop вне сообщений не держит шаг, если последний ответ закончен.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const blockFrom = src.indexOf('  function messages() {');
const blockTo = src.indexOf('  /**\n   * Ответ закончен', blockFrom);
assert.ok(blockFrom > 0 && blockTo > blockFrom, 'блок сообщений на месте');
const chatBlock = src.slice(blockFrom, blockTo);
assert.match(chatBlock, /function messagesAfter\(watermark, seen\)/, 'messagesAfter с снимком id');
assert.match(chatBlock, /function rescueReplies\(\)/, 'страховка по маркеру');

const markerFrom = src.indexOf('  function braceJson(rest) {');
const markerTo = src.indexOf('  /** Короткая подпись элемента для журнала', markerFrom);
assert.ok(markerFrom > 0 && markerTo > markerFrom, 'разбор маркера на месте');
const markerBlock = src.slice(markerFrom, markerTo);

// ────────────────────────────── фальшивый чат ──────────────────────────────
const CARD = '4016f0cf-5705-8197-be3a-c06bf51885ac';
/** UUIDv7 из инцидента: первый прогон ответа (11:20:31Z). */
const ANSWER_ID = '01a16da4-10b2-7c56-9c68-15adbcea39ef';
const ANSWER_AT = Number.parseInt(ANSWER_ID.replace(/-/g, '').slice(0, 12), 16);
/** Наш запрос, у которого id больше ответа (11:20:34Z). */
const PROMPT_ID = '01a16da4-1dc9-7d0b-9d47-4d8c4b1b3f55';
const OLD_ID = '01a16b90-0000-7c56-9c68-15adbcea39ef'; // час назад

const node = (id, text, { user = false } = {}) => ({
  id: `chat-message-${id}`,
  __id: id,
  __text: text,
  __user: user,
  querySelector: (selector) =>
    user && selector === '[data-user-message-layout="true"]' ? { layout: true } : null,
  querySelectorAll: () => [],
  cloneNode: () => ({ querySelectorAll: () => [], textContent: text }),
});

const marker = (id = CARD) => `CF_AGENT_RESULT {"dispatch_id":"${id}","run_id":"19b52574","status":"submitted","check":0,"pr":34,"merged":true}`;

function make({ nodes, waiting = null }) {
  const logs = [];
  const document = {
    querySelectorAll: (selector) =>
      selector === '[data-agent-transcript-message="true"][id^="chat-message-"]' ? nodes : [],
  };
  const fn = new Function(
    'document', 'replyEnded', 'parseMarker', 'norm', 'GM_getValue', 'K', 'logThrottled', 'C',
    `${markerBlock}\n${chatBlock}\nreturn { messagesAfter, rescueReplies, messages, idTime, looksLikeOwnTask };`,
  );
  const api = fn(
    document,
    () => false,
    // parseMarker настоящий: он и разбирает маркер из текста сообщения.
    new Function(`${markerBlock}\nreturn parseMarker;`)(),
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    () => waiting,
    { expect: 'cfn-expect' },
    (key, text) => logs.push({ key, text }),
    { longWaitNoticeMs: 600000 },
  );
  return { api, logs };
}

const answer = (id = ANSWER_ID, text = `${marker()}`) => node(id, `Отчёт.\n\n${text}`);
const prompt = (text = 'Задача NAR-1.10\n\nCF_TECH …') => node(PROMPT_ID, text, { user: true });

// ── 1. Ответ ниже нашего запроса, но с меньшим id ──────────────────────────
{
  const nodes = [prompt(), answer()];
  const { api } = make({ nodes, waiting: { ref: CARD, sentAt: ANSWER_AT } });
  const found = api.messagesAfter(PROMPT_ID, [PROMPT_ID]);
  assert.equal(found.length, 1, 'ответ найден, хотя его id меньше водяного знака');
  assert.equal(found[0].id, ANSWER_ID, 'это именно ответ агента');
  assert.match(found[0].raw, /CF_AGENT_RESULT/, 'текст прочитан целиком');
}

// ── 2. Водяной знак потерян: границу держит снимок id ──────────────────────
{
  const nodes = [prompt(), answer()];
  const { api } = make({ nodes, waiting: { ref: CARD, sentAt: ANSWER_AT } });
  const found = api.messagesAfter('', [prompt().__id]);
  assert.equal(found.length, 1, 'по снимку новым считается только ответ');
  assert.equal(found[0].id, ANSWER_ID, 'старый id в снимке — не новый');
}

// ── 3. Ответ есть, но позиция подвела: спасает маркер выдачи ───────────────
{
  // Водяной знак указывает на сам ответ — после него в разметке пусто.
  const nodes = [prompt(), answer()];
  const { api, logs } = make({ nodes, waiting: { ref: CARD, sentAt: ANSWER_AT } });
  const found = api.messagesAfter(ANSWER_ID, [PROMPT_ID, ANSWER_ID]);
  assert.equal(found.length, 1, 'молчаливого «новых сообщений нет» при готовом ответе нет');
  assert.equal(found[0].id, ANSWER_ID, 'ответ найден по маркеру');
  assert.match(logs[0].text, /найден по маркеру выдачи/, 'в журнале видно, как он нашёлся');
}

// ── 4. Ответ прошлого круга за новый не сходит ─────────────────────────────
{
  const old = answer(OLD_ID);
  const nodes = [prompt(), old];
  const { api, logs } = make({ nodes, waiting: { ref: CARD, sentAt: ANSWER_AT } });
  // Граница стоит на самом старом ответе: после него пусто, значит решает
  // страховка по маркеру — и она обязана отказать по времени id.
  const found = api.messagesAfter(OLD_ID, []);
  assert.equal(found.length, 0, 'старый ответ не принимается за новый');
  assert.equal(logs.length, 0, 'и в журнал ничего не пишется');
}

// ── 5. Цитата задания с настоящим маркером — ответ ────────────────────────
{
  const quoted = node('01a16da4-3aaa-7c56-9c68-15adbcea39ef', `CF_TECH в тексте задания\n\n${marker()}`);
  const nodes = [prompt(), quoted];
  const { api } = make({ nodes, waiting: { ref: CARD, sentAt: ANSWER_AT } });
  const found = api.messagesAfter(PROMPT_ID, []);
  assert.equal(found.length, 1, 'ответ с цитатой задания не выпадает');
  assert.equal(api.looksLikeOwnTask(`CF_TECH в тексте задания\n\n${marker()}`), false, 'решает маркер, а не слово CF_TECH');
  assert.equal(api.looksLikeOwnTask('Задача NAR-1.10\n\nCF_TECH …'), true, 'наше задание без маркера — не ответ');
}

// ── 6. Stop вне сообщений не держит шаг ───────────────────────────────────
const stopFrom = src.indexOf('  const stopIsStale = (el) => {');
const stopTo = src.indexOf('\n  };', stopFrom) + '\n  };'.length;
assert.ok(stopFrom > 0 && stopTo > stopFrom, 'stopIsStale на месте');
const stopBlock = src.slice(stopFrom, stopTo);

function stopStale({ nodes, ended, inside = false }) {
  const document = { querySelectorAll: () => nodes };
  const fn = new Function('document', 'replyEnded', `${stopBlock}; return stopIsStale;`);
  return fn(document, () => ended)({ closest: () => (inside ? nodes[0] : null) });
}

const lastAnswer = node(ANSWER_ID, marker());
assert.equal(
  stopStale({ nodes: [prompt(), lastAnswer], ended: true }),
  true,
  'последний ответ закончен — Stop над полем ввода протух (24.10, 14:20)',
);
assert.equal(stopStale({ nodes: [], ended: false }), false, 'в пустом чате Stop — настоящий');
assert.equal(
  stopStale({ nodes: [prompt(), lastAnswer], ended: false }),
  false,
  'последним стоит наше задание — ответ ещё идёт, Stop настоящий',
);
assert.equal(
  stopStale({ nodes: [lastAnswer], ended: true, inside: true }),
  true,
  'Stop внутри законченного сообщения протух',
);

// ── 7. В очереди отправки занятость проверяется дважды ────────────────────
const sendFrom = src.indexOf('async function consumePending(manual = false) {');
const sendBlock = src.slice(sendFrom, src.indexOf('async function submitExecutor(', sendFrom));
assert.match(sendBlock, /const busy = await busySettled\(\);/, 'состояние проверяется, а не один кадр');
assert.match(sendBlock, /Агент ещё отвечает/, 'в журнале есть причина ожидания');

console.log('OK: relay 1.4.63 — ответ находится по месту и по маркеру, ложного «нет сообщений» и ложной занятости нет');
