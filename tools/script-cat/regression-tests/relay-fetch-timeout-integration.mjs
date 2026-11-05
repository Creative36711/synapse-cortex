// D-041 (05.11.2026): запасной fetch не имеет права висеть вечно.
//
// Боевой инцидент K-21/SYN-1: после маркера Координатора («дальше Contract
// Architect») выдача поставила карточку в Running, затем gateway("append")
// завис на fallback-fetch БЕЗ таймаута (GM-путь ограничен 45 с, а fetch — нет).
// Лог «Выдан ход» и sendToRole (ожидание + промпт) не выполнились. Сторож тишины
// через 131 с снял блокировку и перезапустил шаг; ожидания выдачи не было —
// Координатор получил план заново при живой карточке в Running.
//
// Правило D-041: каждый запасной fetch ограничен таймаутом (шлюз 45 с, ntfy
// 15 с — как их GM-пути). Отказ становится явным и ловимым: вызывающий
// разбирает его (журнал попытки не записался — выдача продолжается), а не
// зависает навсегда. Отметку жизни fetch не ставит — это сетевой запрос.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const V = assertUserscriptVersionContract(src)[1];

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `не найден блок ${from}`);
  return src.slice(a, b);
};

// ── 1. fetchWithTimeout: зависший fetch обрывается по таймауту ─────────────
const fn = cut('  function fetchWithTimeout(', '  const norm =');
assert.match(fn, /new AbortController\(\)/, 'таймаут через AbortController');
assert.match(fn, /signal: controller\.signal/, 'сигнал передаётся в fetch');
assert.match(fn, /clearTimeout\(timer\)/, 'таймер очищается после завершения');

// fetch, который никогда не отвечает, пока его не abort-ят.
const hangingFetch = (url, opts) => new Promise((resolve, reject) => {
  if (opts?.signal?.aborted) return reject(opts.signal.reason || new Error('aborted'));
  opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted')));
});
const { fetchWithTimeout } = new Function('fetch', `${fn}\nreturn { fetchWithTimeout };`)(hangingFetch);

const start = Date.now();
await assert.rejects(fetchWithTimeout('https://gateway.invalid/exec', {}, 60), /таймаут запроса/, 'зависший fetch обрывается');
assert.ok(Date.now() - start < 5000, 'fallback не висит вечно (таймаут сработал быстро)');

// Успешный fetch возвращается как есть, таймер не течёт.
const okFetch = async (url, opts) => ({ ok: true, status: 200, url, method: opts?.method });
const { fetchWithTimeout: fwtOk } = new Function('fetch', `${fn}\nreturn { fetchWithTimeout };`)(okFetch);
const res = await fwtOk('https://gateway.invalid/exec', { method: 'POST' }, 1000);
assert.equal(res.ok, true, 'успешный ответ возвращается');
assert.equal(res.method, 'POST', 'опции запроса сохранены');

// ── 2. Все запасные fetch ограничены: шлюз 45 с, ntfy 15 с ─────────────────
assert.ok(src.includes('fetchWithTimeout(url, { method: "POST", headers, body: payload }, 45000)'), 'шлюз: fallback с таймаутом 45 с');
assert.ok(src.includes('fetchWithTimeout(url, { method: "POST", headers, body: payload }, 15000)'), 'ntfy publish: fallback с таймаутом 15 с');
assert.ok(src.includes('fetchWithTimeout(`${NTFY_BASE}/v1/health`, { cache: "no-store" }, 15000)'), 'ntfy health: fallback с таймаутом 15 с');

// В шлюзе и ntfy не осталось fetch без таймаута.
const gw = src.slice(src.indexOf('  async function gateway('), src.indexOf('  // ───────────────────────────── Notion'));
assert.doesNotMatch(gw, /await fetch\(/, 'в шлюзе нет fetch без таймаута');
const ntfy = src.slice(src.indexOf('  async function ntfyPublish('), src.indexOf('  function notifyNtfy('));
assert.doesNotMatch(ntfy, /await fetch\(/, 'в ntfy нет fetch без таймаута');

// ── 3. Выдача переживает отказ журнала: gateway append обёрнут в try/catch ──
// Таймаут шлюза не должен убивать выдачу: карточка уже Running, задание уходит
// агенту, а незаписанный журнал попытки логируется, не останавливая ход.
assert.ok(src.includes('  async function dispatchTask('), 'dispatchTask на месте');
assert.match(src, /await gateway\("append", logId/, 'журнал попытки пишется шлюзом');
assert.match(src, /catch \(e\) \{\s*log\(`Задание не записалось в журнал попытки/, 'отказ журнала ловится и логируется, а не роняет выдачу');

console.log(
  `OK: relay ${V} — D-041: запасной fetch ограничен таймаутом (шлюз 45 с / ntfy 15 с), ` +
    'зависший запрос обрывается и разбирается вызывающим, выдача не встаёт посреди Running',
);
