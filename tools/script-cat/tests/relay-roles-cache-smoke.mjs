// Проба 1.4.86: база «Роли» — настройка, и её сетевой сбой не останавливает цикл.
//
// 29.10 в 10:08 цикл встал на паузе на POST `data_sources/ed076bfe-…/query`.
// Это чтение базы «Роли» — список агентов, который Мастер правит руками раз в
// неделю, а скрипт читает в начале КАЖДОГО шага. Тот же запрос валил цикл
// 27.10 (HTTP 502) и 29.10 (обрыв): данные тут ни при чём, а цена — пауза на
// девятом часу работы.
//
// Проверяется:
//   • список читается из Notion и кладётся в кеш;
//   • второй шаг в пределах 10 минут в сеть не ходит;
//   • после срока кеш перечитывается;
//   • `fresh: true` идёт мимо кеша;
//   • Notion не ответил, кеш есть → работаем по кешу и пишем об этом в журнал;
//   • Notion не ответил, кеша нет → ошибка идёт дальше, как раньше;
//   • карта строки не теряет ни поля «Роль», ни «Agent URL».

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

// Кеш на 10 минут — в конфиге, а не в коде по месту.
assert.match(src, /rolesCacheMs:\s*600000/, 'срок кеша — 10 минут, и он в конфиге');
assert.match(src, /rolesCache:\s*"cfn-roles-cache"/, 'ключ кеша объявлен вместе с остальными');
assert.match(src, /GM_setValue\(K\.rolesCache, null\)/, 'кеш сбрасывается при смене настроек и в rolesFresh');

const rolesBlock = sliceBetween('  /** Строка базы «Роли» в том виде', '  /** Свежий список ролей');

const makeRoles = ({ reply, cacheMs = 600000, store = new Map() } = {}) => {
  const calls = [];
  const logs = [];
  const roleRows = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'query', 'log', 'firstLine', 'agentIdFromUrl', 'rt', 'sel',
    `${rolesBlock}; return roleRows;`,
  )(
    (key, def) => (store.has(key) ? store.get(key) : def),
    (key, value) => store.set(key, value),
    { rolesCache: 'cfn-roles-cache' },
    { rolesCacheMs: cacheMs },
    async () => {
      calls.push(Date.now());
      const r = reply(calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
    (text, error, options) => logs.push({ text, error, options }),
    (text) => String(text || '').split('\n')[0],
    (url) => (String(url || '').match(/\/agent\/([\w-]+)/) || [])[1] || '',
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
    (p) => p?.select?.name || '',
  );
  return { roleRows, calls, logs, store };
};

const row = (name, url, fn = 'Executor', status = 'Активна') => ({
  id: `page-${name}`,
  properties: {
    'Роль': { title: [{ text: { content: name } }] },
    'Agent URL': { url },
    'Функция': { select: { name: fn } },
    'Статус': { select: { name: status } },
    'Зона записи': { rich_text: [{ plain_text: `зона ${name}` }] },
    'Гейт': { rich_text: [{ plain_text: `гейт ${name}` }] },
  },
});

// ── 1. Строка базы не теряет поля ──────────────────────────────────────────
{
  const h = makeRoles({ reply: () => [row('Tools', 'https://arena.ai/agent/abc-123', 'Executor', 'Активна')] });
  const rows = await h.roleRows();
  assert.deepEqual(rows, [
    {
      id: 'abc-123',
      name: 'Tools',
      url: 'https://arena.ai/agent/abc-123',
      fn: 'Executor',
      status: 'Активна',
      zone: 'зона Tools',
      gate: 'гейт Tools',
      repo: '',
      pageId: 'page-Tools',
    },
  ], 'карта строки полная');
}

// ── 2. Второй шаг в пределах срока в сеть не ходит ─────────────────────────
{
  const h = makeRoles({ reply: () => [row('Warden', 'https://arena.ai/agent/w-1', 'Reviewer')] });
  await h.roleRows();
  await h.roleRows();
  await h.roleRows();
  assert.equal(h.calls.length, 1, 'три шага — одно чтение: это и есть выигрыш');
  assert.ok(h.store.get('cfn-roles-cache'), 'реестр лёг в кеш');
}

// ── 3. Срок вышел — перечитываем ───────────────────────────────────────────
{
  const h = makeRoles({
    reply: (n) => [row(n === 1 ? 'Tools' : 'Tools-2', 'https://arena.ai/agent/abc-123')],
    cacheMs: 30,
  });
  await h.roleRows();
  await new Promise((r) => setTimeout(r, 45));
  const rows = await h.roleRows();
  assert.equal(h.calls.length, 2, 'после срока — новое чтение');
  assert.equal(rows[0].name, 'Tools-2', 'и в списке уже свежие данные');
}

// ── 4. fresh: true идёт мимо кеша ──────────────────────────────────────────
{
  const h = makeRoles({ reply: (n) => [row(n === 1 ? 'Tools' : 'Architect', 'https://arena.ai/agent/abc-123')] });
  await h.roleRows();
  const rows = await h.roleRows({ fresh: true });
  assert.equal(h.calls.length, 2, 'мимо кеша — отдельное чтение');
  assert.equal(rows[0].name, 'Architect', 'вернулись свежие данные');
}

// ── 5. Notion не ответил, кеш есть — работаем дальше ───────────────────────
{
  const h = makeRoles({
    reply: (n) => (n === 1 ? [row('Tools', 'https://arena.ai/agent/abc-123')] : new Error('HTTP 502: Bad Gateway')),
    cacheMs: 20,
  });
  await h.roleRows();
  await new Promise((r) => setTimeout(r, 35));
  const rows = await h.roleRows();
  assert.equal(rows[0].name, 'Tools', 'список агентов взялся из кеша');
  assert.equal(h.calls.length, 2, 'в сеть сходили и получили отказ');
  assert.equal(h.logs.length, 1, 'об этом сказано в журнале');
  assert.match(h.logs[0].text, /База «Роли» не ответила/, 'причина названа');
  assert.match(h.logs[0].text, /работаю по кешу/, 'видно, чем обошлись');
  assert.equal(h.logs[0].error, false, 'это не ошибка: шаг продолжается');
  assert.equal(h.logs[0].options.ntfy, 'quiet', 'и не будит ночью');
}

// ── 6. Кеша нет и Notion не ответил — ошибка идёт дальше ───────────────────
{
  const h = makeRoles({ reply: () => new Error('HTTP 502: Bad Gateway') });
  await assert.rejects(() => h.roleRows(), /HTTP 502/, 'первый запуск без кеша падает честно');
  assert.equal(h.logs.length, 0, 'и ничего не выдумывает в журнале');
}

// ── 7. Пустой список не затирает кеш ───────────────────────────────────────
{
  const h = makeRoles({
    reply: (n) => (n === 1 ? [row('Tools', 'https://arena.ai/agent/abc-123')] : []),
    cacheMs: 20,
  });
  await h.roleRows();
  await new Promise((r) => setTimeout(r, 35));
  await h.roleRows();
  assert.equal(h.store.get('cfn-roles-cache').rows.length, 1, 'пустой ответ кеш не обнуляет');
}

// ── 8. Проверка перед выдачей не может разрешать по устаревшему кешу ───────
{
  const h = makeRoles({ reply: (n) => n === 1
    ? [row('Tools', 'https://arena.ai/agent/abc-123')]
    : new Error('Notion offline') });
  await h.roleRows();
  await assert.rejects(() => h.roleRows({ fresh: true, requireFresh: true }), /Notion offline/,
    'даже при наличии кеша новое назначение не выдаётся без актуальной роли');
  assert.equal(h.store.get('cfn-roles-cache').rows[0].name, 'Tools', 'кеш не потерян');
  assert.equal(h.logs.length, 0, 'отказ не называется успешной работой по кешу');
  const cached = await h.roleRows();
  assert.equal(cached[0].name, 'Tools', 'обычное чтение по-прежнему работает с кешем');
}

console.log('OK: relay 1.4.86 — «Роли» кешируются на 10 минут, сбой чтения не останавливает цикл');
