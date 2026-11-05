// Проба 1.4.40: запрос к шлюзу Drive идёт путём расширения, а не страницы.
//
// Случай Мастера (2026-10-24, 14:41): «Шаг» нашёл ответ Build/Release, дошёл до
// записи в журнал и упал с «Failed to fetch» — цикл встал на паузе. Причина:
// шлюз Apps Script вызывался обычным `fetch` из страницы Arena, а такой запрос
// живёт по правилам страницы (CORS и её CSP). Сеть при этом была жива.
//
// Здесь проверяется:
//   • первый путь — GM_xmlhttpRequest (страницу обходит), fetch остался вторым;
//   • сетевой сбой повторяется один раз, отказ шлюза — нет;
//   • ошибка называет источник: «шлюз Drive», а не «запись в Notion»;
//   • «duplicate» на append — успех: ответ уже в журнале, шаг доводит карточку.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const reqFrom = src.indexOf('  const networkish = (text) =>');
const reqTo = src.indexOf('  async function notion(method, path, body) {');
assert.ok(reqFrom > 0 && reqTo > reqFrom, 'блок запросов на месте');
const reqBlock = src.slice(reqFrom, reqTo);

const gwFrom = src.indexOf('  async function gateway(action, fileId, extra = {}) {');
const gwTo = src.indexOf('  // ───────────────────────────── Notion ─────────────────────────────');
assert.ok(gwFrom > 0 && gwTo > gwFrom, 'gateway на месте');
const gwBlock = src.slice(gwFrom, gwTo);

assert.ok(/await request\("POST", url, headers, payload\)/.test(gwBlock), 'шлюз идёт путём расширения');
assert.ok(/await fetchWithTimeout\(url/.test(gwBlock), 'fetch остался запасным путём (D-041: с таймаутом)');
assert.ok(gwBlock.indexOf('await request(') < gwBlock.indexOf('await fetchWithTimeout(url'), 'сначала расширение, потом fetch');
assert.ok(/err\.relay = "gateway"/.test(gwBlock), 'ошибка помечена как шлюз');
assert.ok(/networkish/.test(reqBlock), 'сетевые сбои отличаются от отказов');

const load = ({ gm, fetchImpl }) => {
  const calls = { gm: 0, fetch: 0 };
  // D-041: шлюз зовёт fetchWithTimeout (fetch + таймаут). В пробе таймаут не
  // нужен — передаём pass-through к моку fetch, логика путей не меняется.
  const mockedFetch = async () => {
    calls.fetch += 1;
    const reply = fetchImpl(calls.fetch);
    if (reply.error) throw new Error(reply.error);
    return { ok: reply.status ? reply.status < 400 : true, status: reply.status || 200, json: async () => reply.body };
  };
  const api = new Function(
    'GM_xmlhttpRequest', 'sleep', 'GM_getValue', 'K', 'fetchWithTimeout',
    `${reqBlock}\n${gwBlock}\nreturn { request, gateway, networkish };`,
  )(
    (opts) => {
      calls.gm += 1;
      const reply = gm(calls.gm, opts);
      if (reply.error) opts.onerror();
      else opts.onload({ status: reply.status ?? 200, responseText: JSON.stringify(reply.body ?? {}) });
    },
    async () => {},
    (k) => (k === 'cfn-gw-url' ? 'https://script.google.com/macros/s/x/exec' : k === 'cfn-gw-key' ? 'k' : ''),
    { gwUrl: 'cfn-gw-url', gwKey: 'cfn-gw-key' },
    (url, opts) => mockedFetch(url, opts),
  );
  return { api, calls };
};

// 1. Обычный путь: ответ шлюза через расширение, fetch не трогаем.
{
  const { api, calls } = load({ gm: () => ({ body: { ok: true, result: 'appended' } }), fetchImpl: () => ({ error: 'не должен вызываться' }) });
  const data = await api.gateway('append', 'file-1', { marker: '<!-- CF_DISPATCH a:b -->', entry: '…' });
  assert.equal(data.result, 'appended', 'ответ шлюза принят');
  assert.equal(calls.gm, 1, 'сходили через расширение');
  assert.equal(calls.fetch, 0, 'до fetch дело не дошло');
}

// 2. Сетевой сбой в расширении: одна повторная попытка, и всё работает.
{
  const { api, calls } = load({
    gm: (n) => (n === 1 ? { error: true } : { body: { ok: true, result: 'appended' } }),
    fetchImpl: () => ({ error: 'не должен вызываться' }),
  });
  const data = await api.gateway('append', 'file-1', {});
  assert.equal(data.ok, true, 'повтор спас запрос');
  assert.equal(calls.gm, 2, 'была ровно одна повторная попытка');
  assert.equal(calls.fetch, 0, 'fetch не понадобился');
}

// 3. Расширение не может (нет @connect, выключен GM) — работает fetch.
{
  const { api, calls } = load({
    gm: () => ({ error: true }),
    fetchImpl: () => ({ body: { ok: true, result: 'appended' } }),
  });
  const data = await api.gateway('append', 'file-1', {});
  assert.equal(data.ok, true, 'запасной путь сработал');
  assert.equal(calls.fetch, 1, 'fetch вызван один раз');
}

// 4. Не работают оба пути — ошибка называет шлюз, а не Notion.
{
  const { api } = load({ gm: () => ({ error: true }), fetchImpl: () => ({ error: 'Failed to fetch' }) });
  await assert.rejects(
    () => api.gateway('append', 'file-1', {}),
    (e) => {
      assert.equal(e.relay, 'gateway', 'источник помечен');
      assert.match(e.message, /шлюз Drive не ответил/, 'по-русски и по делу');
      assert.match(e.message, /Failed to fetch/, 'техническая строка сохранена');
      return true;
    },
  );
}

// 5. Отказ шлюза (неверный ключ) не повторяется и не выдаёт себя за молчание.
{
  const { api, calls } = load({
    gm: () => ({ body: { ok: false, error: 'Неверный ключ шлюза.' } }),
    fetchImpl: () => ({ body: { ok: false, error: 'Неверный ключ шлюза.' } }),
  });
  await assert.rejects(
    () => api.gateway('append', 'file-1', {}),
    (e) => {
      assert.match(e.message, /Неверный ключ шлюза/, 'причина сохранена');
      assert.match(e.message, /отказал/, 'отказ назван отказом');
      assert.doesNotMatch(e.message, /не ответил/, 'молчанием это не называется');
      assert.equal(e.refused, true, 'видно, что шлюз ответил');
      assert.equal(e.relay, 'gateway', 'источник помечен');
      return true;
    },
  );
  assert.equal(calls.gm, 1, 'на отказе повторов нет');
  assert.equal(calls.fetch, 0, 'второй путь на отказе не нужен: ответ будет тот же');
}

// 5б. Отказ про папку — единственный случай, в котором скрипт возвращает
//     журнал выдачи: так было на NAR-2.13 (D-071).
{
  const { api } = load({
    gm: () => ({ body: { ok: false, error: 'Запись разрешена только в текстовые файлы Arena/logs.' } }),
    fetchImpl: () => ({ error: 'не должен вызываться' }),
  });
  await assert.rejects(
    () => api.gateway('append', '1rt913-отчёт', {}),
    (e) => {
      assert.equal(e.refused, true, 'отказ помечен');
      assert.match(e.reason, /Arena\/logs/, 'причина отказа видна отдельным полем');
      return true;
    },
  );
}

// 6. request: сетевой сбой повторяется, HTTP 400 — нет.
{
  const gm = [];
  const { api } = load({
    gm: (n) => {
      gm.push(n);
      return n === 1 ? { error: true } : { body: { ok: true } };
    },
    fetchImpl: () => ({ error: 'нет' }),
  });
  await api.request('GET', 'https://api.notion.com/v1/users', {}, undefined);
  assert.equal(gm.length, 2, 'сеть повторили');
}
{
  let calls = 0;
  const api = new Function(
    'GM_xmlhttpRequest', 'sleep',
    `${reqFrom > 0 ? reqBlock : ''}\nreturn { request, networkish };`,
  )(
    (opts) => {
      calls += 1;
      opts.onload({ status: 400, responseText: JSON.stringify({ message: 'path failed validation' }) });
    },
    async () => {},
  );
  await assert.rejects(() => api.request('PATCH', 'https://api.notion.com/v1/pages/x', {}, {}), /HTTP 400/);
  assert.equal(calls, 1, 'отказ прав не повторяется');
}

// 7. «duplicate» на append — не отказ: такая запись уже в журнале. Иначе шаг,
//    сорвавшийся ПОСЛЕ записи журнала (NAR-1.10: ответ записан, запись в Notion
//    прервалась), не завершился бы никогда — повтор упирался бы в свой маркер.
{
  const { api, calls } = load({
    gm: () => ({ body: { ok: false, error: 'duplicate' } }),
    fetchImpl: () => ({ error: 'не должен вызываться' }),
  });
  const data = await api.gateway('append', 'file-1', { marker: '<!-- CF_DISPATCH a:b -->', entry: '…' });
  assert.equal(data.ok, true, 'дубль маркера считается успехом');
  assert.equal(data.duplicate, true, 'видно, что запись уже была');
  assert.equal(calls.gm, 1, 'повторов не понадобилось');
}

// 8. Запасной fetch понимает дубль так же, а для остальных действий
//    «duplicate» остаётся отказом: там идемпотентности по маркеру нет.
{
  const { api } = load({
    gm: () => ({ error: 'нет расширения' }),
    fetchImpl: () => ({ body: { ok: false, error: 'duplicate' } }),
  });
  const data = await api.gateway('append', 'file-1', {});
  assert.equal(data.duplicate, true, 'fetch-путь тоже понимает дубль');
}
{
  const { api } = load({
    gm: () => ({ body: { ok: false, error: 'duplicate' } }),
    fetchImpl: () => ({ body: { ok: false, error: 'duplicate' } }),
  });
  await assert.rejects(() => api.gateway('createLog', 'x', {}), /duplicate/, 'для не-append это отказ');
}

// 9. Шаг говорит об этом вслух и снимает ожидание с уже оформленной карточки:
//    молчание Мастер читает как «ничего не произошло».
{
  const submit = src.slice(src.indexOf('async function submitExecutor'), src.indexOf('async function releaseStalled'));
  assert.match(submit, /wrote && wrote\.duplicate/, 'submitExecutor различает дубль записи');
  assert.match(submit, /Ответ уже был в журнале Drive/, 'и объясняет, почему второго блока нет');
  assert.match(submit, /повторная запись не нужна, ожидание снято/, 'оформленная карточка снимает ожидание');
  assert.match(submit, /GM_setValue\(K\.expect, null\)/, 'ожидание действительно снимается');
  assert.match(
    submit,
    /const \{ wrote, logId \} = await appendToJournal\(/,
    'журнал берётся из выдачи, а не из поля карточки',
  );
  assert.doesNotMatch(
    submit,
    /gateway\("append",\s*declaredLog/,
    'ответ не пишется в id из карточки напрямую: его мог переписать агент',
  );
}

console.log('OK: relay 1.4.63 — шлюз Drive идёт через расширение, сеть повторяется, ошибка называет источник');
