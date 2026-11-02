// Проба 1.4.78 / 1.4.86: короткий сбой Notion не останавливает цикл.
//
// 27.10 в 19:23 цикл встал на паузе: POST `data_sources/ed076bfe-…/query`
// получил HTTP 502. Это ответ на стороне Notion, а не отказ по существу:
// карточка и ход были целы. Скрипт же считал 5xx отказом, не повторял запрос и
// останавливался — Мастер у экрана из-за чужой пятиминутной аварии.
//
// Теперь 429 и 5xx считаются сбоем связи: запрос повторяется (до четырёх
// попыток, с выдержкой), а если Notion не восстановился — пауза говорит прямо,
// что это его сторона и ход не потерян.
//
// 1.4.86: обрыв связи (`status 0`) повторяется ТАК ЖЕ, как 5xx. 29.10 в 10:08
// цикл встал на шаге 5.20 ровно на этом: обрыв повторился один раз за 0,7 с и
// уехал в паузу, хотя Notion был жив, а запрос — обычное чтение базы «Роли».
//
// Проверяется:
//   • 502 → повтор → успех: паузы нет, цикл продолжается;
//   • чтение, правка свойств и запрос очереди повторяются;
//   • создание страницы (POST pages) не повторяется никогда: на 502 запрос мог
//     уже пройти, и повтор сделал бы вторую карточку;
//   • 4xx не повторяется: это не сбой связи, а отказ по существу;
//   • четыре 5xx подряд → ошибка с источником «Notion» и понятным текстом;
//   • обрыв связи повторяется как 5xx: четыре попытки, выдержки 0,8 / 2,5 / 6 с;
//   • после четырёх обрывов зонд связи решает: вернулась — запрос повторён,
//     нет — ошибка говорит «связь не восстановилась»;
//   • networkish знает про 429 и 5xx.

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

// ── 1. Сбой связи ──────────────────────────────────────────────────────────
const netBlock = sliceBetween('  const networkish = (text) =>', '  function requestOnce(');
const networkish = new Function(`${netBlock}; return networkish;`)();
for (const text of [
  'HTTP 502: Bad Gateway',
  'HTTP 503',
  'HTTP 504: Gateway Timeout',
  'HTTP 500: Internal Server Error',
  'HTTP 429: rate limited',
  'таймаут запроса',
  'Failed to fetch',
]) {
  assert.equal(networkish(text), true, `«${text}» — сбой, который имеет смысл повторить`);
}
for (const text of ['HTTP 400: bad request', 'HTTP 404', 'HTTP 401: Unauthorized', 'validation_error']) {
  assert.equal(networkish(text), false, `«${text}» — отказ по существу, повтор не поможет`);
}

// ── 2. notion(): повтор 5xx, но не создание страниц ────────────────────────
const notionSrc = sliceBetween('  async function notion(method, path, body) {', '  /**\n   * Вызов шлюза Drive.');

const RETRY_WAITS = [800, 2500, 6000];
const PROBE_WAITS = [5000, 15000];

/** Обрыв связи: GM_xmlhttpRequest отдал `onerror` — ни кода, ни тела. */
const breakLink = (detail = 'net::ERR_INTERNET_DISCONNECTED') =>
  Object.assign(new Error(`сеть недоступна или запрос оборвался: ${detail}`), { status: 0, link: true });

const makeHarness = (replies, { link = async () => false } = {}) => {
  const calls = [];
  const waits = [];
  const probes = [];
  const notion = new Function(
    'GM_getValue', 'K', 'C', 'isUuid', 'request', 'retriable', 'linkBack', 'sleep',
    `${notionSrc}; return notion;`,
  )(
    (key) => (key === 'cfn-notion-token' ? 'secret' : ''),
    { notion: 'cfn-notion-token' },
    { notionV: '2025-09-03', retryWaits: RETRY_WAITS, linkProbeWaits: PROBE_WAITS },
    (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '')),
    async (method) => {
      calls.push(method);
      const reply = replies(calls.length, method);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    (e) => Boolean(e) && (Number(e.status) === 0 || /HTTP (?:429|5\d\d)/i.test(String(e.message || ''))),
    async () => {
      probes.push('probe');
      return link();
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  return { notion, calls, waits, probes };
};

// 2.1. Один 502 — повтор, и всё идёт дальше.
{
  const h = makeHarness((n) => (n === 1 ? new Error('HTTP 502: Bad Gateway') : { results: [] }));
  const out = await h.notion('POST', 'data_sources/ed076bfe-99dd-447d-9cac-55ca14661e99/query', {});
  assert.deepEqual(out, { results: [] }, 'ответ второго запроса принят');
  assert.equal(h.calls.length, 2, 'запрос повторён один раз');
  assert.deepEqual(h.waits, [800], 'перед повтором подождали');
}

// 2.2. Два 502 — ещё повтор.
{
  const h = makeHarness((n) => (n < 3 ? new Error('HTTP 503') : { ok: true }));
  assert.deepEqual(await h.notion('GET', 'pages/4016f0cf-5705-81f7-8bf6-e7c605f152eb'), { ok: true });
  assert.equal(h.calls.length, 3, 'три попытки');
  assert.deepEqual(h.waits, [800, 2500], 'выдержка растёт');
}

// 2.3. Создание страницы не повторяется: на 502 запрос мог уже пройти.
{
  const h = makeHarness(() => new Error('HTTP 502: Bad Gateway'));
  await assert.rejects(
    () => h.notion('POST', 'pages', { parent: {} }),
    /Notion не ответил на POST pages: HTTP 502/,
    'ошибка называет Notion и запрос',
  );
  assert.equal(h.calls.length, 1, 'POST pages не повторялся');
  assert.deepEqual(h.waits, [], 'и выдержки не было');
}

// 2.4. 4xx не повторяется.
{
  const h = makeHarness(() => new Error('HTTP 400: path failed validation'));
  await assert.rejects(() => h.notion('PATCH', 'pages/4016f0cf-5705-81f7-8bf6-e7c605f152eb', {}), /HTTP 400/);
  assert.equal(h.calls.length, 1, 'отказ по существу не повторяем');
}

// 2.5. Notion не поднялся: четыре попытки и честная причина.
{
  const h = makeHarness(() => new Error('HTTP 502: Bad Gateway'));
  await assert.rejects(
    () => h.notion('POST', 'data_sources/ed076bfe-99dd-447d-9cac-55ca14661e99/query', {}),
    (e) => {
      assert.equal(e.relay, 'notion', 'источник назван: Notion');
      assert.match(e.message, /Notion не ответил на POST data_sources\/.*\/query: HTTP 502/, 'текст называет запрос');
      return true;
    },
  );
  assert.equal(h.calls.length, 4, 'использованы все четыре попытки');
  assert.deepEqual(h.waits, RETRY_WAITS, 'выдержки 0,8 / 2,5 / 6 с');
  assert.equal(h.probes.length, 0, 'к 5xx зонд связи не прикладывается: Notion ответил');
}

// 2.6. Обрыв связи повторяется так же, как 5xx (29.10, шаг 5.20).
{
  const h = makeHarness((n) => (n < 4 ? breakLink() : { results: [] }));
  assert.deepEqual(
    await h.notion('POST', 'data_sources/ed076bfe-99dd-447d-9cac-55ca14661e99/query', {}),
    { results: [] },
    'четвёртая попытка прошла',
  );
  assert.equal(h.calls.length, 4, 'обрыв не обрывает работу на второй попытке');
  assert.deepEqual(h.waits, RETRY_WAITS, 'выдержки те же, что у 5xx');
  assert.equal(h.probes.length, 0, 'зонд не понадобился: связь вернулась сама');
}

// 2.7. Четыре обрыва, но зонд говорит «связь есть» — запрос повторён.
{
  const h = makeHarness((n) => (n <= 4 ? breakLink() : { ok: true }), { link: async () => true });
  assert.deepEqual(await h.notion('GET', 'pages/4016f0cf-5705-81f7-8bf6-e7c605f152eb'), { ok: true });
  assert.equal(h.calls.length, 5, 'четыре попытки и одна после зонда');
  assert.equal(h.probes.length, 1, 'зонд спросили один раз');
}

// 2.8. Связи нет: зонд не помог — пауза честно называет причину.
{
  const h = makeHarness(() => breakLink('net::ERR_INTERNET_DISCONNECTED'), { link: async () => false });
  await assert.rejects(
    () => h.notion('POST', 'data_sources/ed076bfe-99dd-447d-9cac-55ca14661e99/query', {}),
    (e) => {
      assert.equal(e.relay, 'notion', 'источник назван');
      assert.equal(e.link, true, 'видно, что это обрыв, а не отказ данных');
      assert.match(e.message, /Notion не ответил на POST data_sources\/.*\/query/, 'текст называет запрос');
      assert.match(e.message, /связь не восстановилась за 20 с/, 'сказано, что зонды не помогли');
      assert.match(e.message, /ERR_INTERNET_DISCONNECTED/, 'причина обрыва сохранена, а не потеряна');
      return true;
    },
  );
  assert.equal(h.calls.length, 4, 'пять раз в сеть не ходим: зонд уже сказал «нет»');
  assert.equal(h.probes.length, 1, 'зонд был');
}

// 2.9. Создание страницы не повторяется и при обрыве: на нём дубль дороже.
{
  const h = makeHarness(() => breakLink());
  await assert.rejects(() => h.notion('POST', 'pages', { parent: {} }), /Notion не ответил на POST pages/);
  assert.equal(h.calls.length, 1, 'POST pages не повторялся');
  assert.deepEqual(h.waits, [], 'и выдержки не было');
  assert.equal(h.probes.length, 0, 'и зонд не спрашивали');
}

// 2.10. `request(…, { retry: false })` — ровно один запрос: распорядок повторов
// принадлежит `notion()`, иначе циклы перемножаются (2 × 4 = восемь попыток).
{
  const requestSrc = sliceBetween('  async function request(method', '  /**\n   * Сбой, который имеет смысл повторить');
  const calls = [];
  const waits = [];
  const request = new Function('networkish', 'requestOnce', 'sleep', `${requestSrc}; return request;`)(
    (text) => /сеть|HTTP (?:429|5\d\d)/i.test(String(text || '')),
    async () => {
      calls.push('call');
      throw Object.assign(new Error('сеть недоступна или запрос оборвался'), { status: 0 });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  await assert.rejects(() => request('GET', 'https://api.notion.com/v1/x', {}, undefined, { retry: false }));
  assert.equal(calls.length, 1, 'с retry: false — одна попытка, повторы считает notion()');
  assert.deepEqual(waits, [], 'и своей выдержки у request нет');
  await assert.rejects(() => request('GET', 'https://api.notion.com/v1/x', {}, undefined));
  assert.equal(calls.length, 3, 'без opts — две попытки в request (1 + 2)');
  assert.deepEqual(waits, [700], 'и одна выдержка между ними, без холостой в конце');
}

// ── 3. Пауза объясняет, чья это ошибка ────────────────────────────────────
const pauseBlock = sliceBetween('      const raw = String((e && e.message) || e);', '        { kind: "error" },');
assert.match(pauseBlock, /HTTP \(\?:429\|5/, 'в тексте паузы разбирается код 429/5xx');
assert.match(pauseBlock, /Notion ответил сбоем на своей стороне/, 'сказано, что сбой не наш');
assert.match(pauseBlock, /это не ошибка карточки и не потерянный ход/, 'и что ход не потерян');
assert.ok(
  pauseBlock.indexOf('HTTP (?:429|5') < pauseBlock.indexOf('e && e.relay === "notion"'),
  'сбой сервера отличается от сети до общей формулировки',
);

console.log('OK: relay 1.4.86 — 5xx/429 и обрыв повторяются одинаково, зонд решает паузу, POST pages не повторяется');
