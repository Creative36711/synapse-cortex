// Проба 1.4.86: обрыв связи — не приговор, и причина у него читаемая.
//
// 29.10 в 10:08 цикл встал на паузе посреди шага 5.20: POST
// `data_sources/ed076bfe-…/query` (чтение базы «Роли») не получил вообще
// ничего — ни кода, ни тела. Notion при этом был жив: отдельный запрос в ту же
// минуту ответил. Транспорт сделал две вещи не так:
//
//   1. обрыв повторялся один раз через 0,7 с, тогда как 502 — до шести раз;
//      секундная потеря связи стоила паузы;
//   2. `onerror` выбрасывал объект ответа, поэтому в журнале не было ни
//      `statusText`, ни `error`, а текст «хост не разрешён в @connect»
//      отправлял Мастера искать блокировку, которой нет.
//
// Проверяется:
//   • причина обрыва сохраняется в тексте ошибки, `status` = 0, `link` = true;
//   • зонд связи — два запроса: через 5 и 15 с; первый успех прекращает серию;
//   • оба зонда провалились → `false`, и это значит «пауза честная»;
//   • успешный зонд пишет в журнал, что связь вернулась;
//   • в сообщении об обрыве больше нет указания на @connect;
//   • пауза для обрыва говорит «связь пропала», а не «сеть или блокировка».

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

// ── 1. Причина обрыва не теряется ──────────────────────────────────────────
const linkErrorBlock = sliceBetween('  function linkError(kind, r) {', '  function requestOnce(');
const linkError = new Function(`${linkErrorBlock}; return linkError;`)();

{
  const e = linkError('сеть недоступна или запрос оборвался', {
    statusText: 'error',
    error: { message: 'net::ERR_INTERNET_DISCONNECTED' },
  });
  assert.equal(e.status, 0, 'обрыв — это status 0, а не HTTP-код');
  assert.equal(e.link, true, 'видно, что это связь, а не отказ данных');
  assert.match(e.message, /запрос оборвался/, 'своя часть сообщения на месте');
  assert.match(e.message, /net::ERR_INTERNET_DISCONNECTED/, 'причина из расширения сохранена');
  assert.match(e.message, /error/, 'statusText тоже сохранён');
}
{
  const e = linkError('таймаут запроса', undefined);
  assert.equal(e.message, 'таймаут запроса', 'без подробностей сообщение остаётся коротким');
  assert.equal(e.status, 0, 'таймаут тоже status 0');
}
{
  const e = linkError('сеть недоступна или запрос оборвался', { statusText: '', error: null });
  assert.equal(e.message, 'сеть недоступна или запрос оборвался', 'пустые подробности не склеиваются в « / »');
}
// Путь Notion больше не поминает @connect: хост в заголовке разрешён, и
// отправлять Мастера искать блокировку было нечестно. В `gmRequest` (пуши
// ntfy) эта причина остаётся законной — там @connect и правда решает.
assert.match(src, /@connect\s+api\.notion\.com/, 'хост Notion в заголовке разрешён');
const requestOnceBlock = sliceBetween('  function requestOnce(method, url, headers, body, timeout = 45000) {', '  /**');
assert.ok(
  !/@connect/.test(requestOnceBlock),
  'в запросах к Notion фразы про @connect больше нет: она отправляла искать блокировку, которой нет',
);

// ── 2. Зонд связи: 5 с, потом 15 с ─────────────────────────────────────────
const linkBackBlock = sliceBetween('  async function linkBack() {', '  const isUuid = (value) =>');

const makeProbe = ({ failTimes = 0, waits = [5000, 15000] } = {}) => {
  const slept = [];
  const logs = [];
  let calls = 0;
  const linkBack = new Function(
    'GM_getValue', 'K', 'C', 'requestOnce', 'sleep', 'log',
    `${linkBackBlock}; return linkBack;`,
  )(
    () => 'secret',
    { notion: 'cfn-notion-token' },
    { notionV: '2025-09-03', linkProbeWaits: waits },
    async () => {
      calls += 1;
      if (calls <= failTimes) throw Object.assign(new Error('сеть недоступна'), { status: 0 });
      return { object: 'user' };
    },
    async (ms) => {
      slept.push(ms);
    },
    (text, error, options) => logs.push({ text, error, options }),
  );
  return { linkBack, slept, logs, calls: () => calls };
};

// 2.1. Первый зонд не прошёл, второй прошёл.
{
  const p = makeProbe({ failTimes: 1 });
  assert.equal(await p.linkBack(), true, 'связь вернулась — шаг можно повторять');
  assert.deepEqual(p.slept, [5000, 15000], 'ждали 5 с, потом 15 с');
  assert.equal(p.calls(), 2, 'два зонда');
  assert.equal(p.logs.length, 1, 'в журнале одна строка');
  assert.match(p.logs[0].text, /Связь с Notion пропадала и вернулась через 15 с/, 'видно, сколько ждали');
  assert.equal(p.logs[0].error, false, 'это не ошибка: работа продолжится');
  assert.equal(p.logs[0].options.ntfy, 'quiet', 'ночью за это не звонят');
}

// 2.2. Связи нет ни через 5 с, ни через 15 с.
{
  const p = makeProbe({ failTimes: 5 });
  assert.equal(await p.linkBack(), false, 'связи нет — пауза будет честной');
  assert.deepEqual(p.slept, [5000, 15000], 'обе выдержки соблюдены');
  assert.equal(p.calls(), 2, 'третьего зонда нет: 20 с уже достаточно');
  assert.equal(p.logs.length, 0, 'молчание: сообщение будет в паузе');
}

// 2.3. Связь жива сразу — зонд не ждёт лишнего.
{
  const p = makeProbe({ failTimes: 0 });
  assert.equal(await p.linkBack(), true);
  assert.deepEqual(p.slept, [5000], 'одна выдержка: первый же зонд прошёл');
  assert.equal(p.calls(), 1, 'один запрос');
}

// ── 3. Пауза объясняет обрыв своим словами ─────────────────────────────────
const pauseBlock = sliceBetween('      const raw = String((e && e.message) || e);', '        { kind: "error" },');
assert.match(pauseBlock, /e && e\.relay === "notion" && e\.link/, 'у обрыва своя ветка');
assert.match(pauseBlock, /Связь с Notion пропала/, 'пауза называет вещь своим именем');
assert.match(pauseBlock, /два зонда \(через 5 и 15 с\)/, 'и говорит, что связь уже проверяли');
assert.ok(
  pauseBlock.indexOf('HTTP (?:429|5') < pauseBlock.indexOf('e && e.relay === "notion"'),
  'сбой сервера по-прежнему разбирается раньше общей формулировки',
);

console.log('OK: relay 1.4.86 — обрыв связи читаем, зонд 5/15 с решает паузу, пауза говорит правду');
