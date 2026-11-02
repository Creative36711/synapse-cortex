// Проба 1.4.40: id из строки-маркера больше не адресуют запись в Notion.
//
// Инцидент 24.10.2026, 13:15 UTC. Kernel выполнил NAR-1.9 и прислал маркер, в
// котором uuid карточки был с опечаткой:
//   было:  4036f0cf-5705-81ba-9f79-ed89959fe3b8
//   пришло: 4036f0cf-5705-ba9f-79ed-59fe3b8e
// Скрипт поверил строке ответа, пошёл в Notion по этому адресу и получил
// HTTP 400 «path.page_id should be a valid uuid». Цикл встал на паузу, хотя
// работа была сделана и PR #33 уже слит.
//
// Правило: истина — выдача, которую движок сам поставил в Running.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];
assert.match(src, new RegExp(`@version\\s+${V.replace(/\./g, '\\.')}`), `версия ${V}`);

// ── 1. isUuid и adoptIds ────────────────────────────────────────────────────
const from = src.indexOf('const isUuid = (value) =>');
const to = src.indexOf('async function notion(method, path, body) {');
assert.ok(from > 0 && to > from, 'isUuid и adoptIds на месте');

const { isUuid, adoptIds } = new Function(
  'norm',
  `${src.slice(from, to)}; return { isUuid, adoptIds };`,
)((x) => String(x || '').trim().toLowerCase());

const REAL = '4036f0cf-5705-81ba-9f79-ed89959fe3b8';
const BROKEN = '4036f0cf-5705-ba9f-79ed-59fe3b8e'; // ровно то, что пришло от Kernel
const OTHER = '4016f0cf-5705-8197-be3a-c06bf51885ac';
const RUN = 'e56a3ff8-486d-4c95-a6b8-f913812697ea';

assert.equal(isUuid(REAL), true, 'настоящий uuid проходит');
assert.equal(isUuid(BROKEN), false, 'uuid с опечаткой не проходит');
assert.equal(isUuid(''), false, 'пустая строка — не uuid');

// 1.1. Всё совпало — ничего не трогаем и не пишем в журнал.
{
  const { result, stray } = adoptIds({ dispatch_id: REAL, run_id: RUN }, { ref: REAL, runId: RUN });
  assert.equal(result.dispatch_id, REAL, 'свой id остаётся');
  assert.equal(result.run_id, RUN, 'свой run остаётся');
  assert.deepEqual(stray, [], 'чужих id нет — журнал молчит');
}

// 1.2. Опечатка в dispatch_id — берём id из выдачи.
{
  const { result, stray } = adoptIds({ dispatch_id: BROKEN, run_id: RUN }, { ref: REAL, runId: RUN });
  assert.equal(result.dispatch_id, BROKEN, 'битый id не заменён');
  assert.equal(result.run_id, RUN, 'run не тронут');
  assert.equal(stray.length, 1, 'замена названа');
  assert.match(stray[0], /dispatch_id/, 'в журнале видно, что именно было битым');
}

// 1.3. Валидный, но чужой uuid — тоже не адрес записи.
{
  const { result, stray } = adoptIds({ dispatch_id: OTHER, run_id: RUN }, { ref: REAL, runId: RUN });
  assert.equal(result.dispatch_id, OTHER, 'чужой id не подменён и не используется');
  assert.equal(stray.length, 1, 'подмена названа');
}

// 1.4. Битый run_id.
{
  const { result, stray } = adoptIds({ dispatch_id: REAL, run_id: 'e56a3ff8-486d-4c95' }, { ref: REAL, runId: RUN });
  assert.equal(result.run_id, 'e56a3ff8-486d-4c95', 'битый run не подменён');
  assert.match(stray[0], /run_id/, 'в журнале видно run_id');
}

// 1.5. Маркер без id вовсе.
{
  const { result, stray } = adoptIds({ status: 'submitted' }, { ref: REAL, runId: RUN });
  assert.equal(result.dispatch_id, undefined, 'нет id — не подставляем свой');
  assert.equal(result.run_id, undefined, 'нет run — не подставляем свой');
  assert.equal(stray.length, 2, 'обе подстановки названы');
}

// 1.6. Входной объект не меняется: adoptIds возвращает копию.
{
  const raw = { dispatch_id: BROKEN, run_id: RUN };
  adoptIds(raw, { ref: REAL, runId: RUN });
  assert.equal(raw.dispatch_id, BROKEN, 'исходный маркер не переписан');
}

// ── 2. Notion не получает запросов с невалидным id ─────────────────────────
const notionSrc = src.slice(to, src.indexOf('async function gateway(', to));
assert.match(
  notionSrc,
  /\(\?:pages\|blocks\|data_sources\)/,
  'адрес проверяется до запроса',
);
assert.match(notionSrc, /битый id/, 'отказ объясняется по-русски');
assert.match(notionSrc, /throw new Error\(/, 'запрос не уходит');

// ── 3. Ответ агента действительно правится до записи ───────────────────────
const submit = src.slice(src.indexOf('async function submitExecutor('), src.indexOf('// ───────────────────────────── ожидание'));
assert.ok(submit.length > 0, 'submitExecutor на месте');
assert.match(submit, /const \{ result, stray \} = adoptIds\(hit\.result, expect\);/, 'id правятся до Notion');
assert.ok(
  submit.indexOf('adoptIds(') < submit.indexOf('notion("GET", `pages/'),
  'подстановка идёт раньше первого запроса по id',
);
assert.match(submit, /ничего не подменяю/, 'в журнале сказано, что ID не подменяются');
assert.match(submit, /\{ ntfy: false \}/, 'такая строка не будит Мастера');

// ── 4. Отказ вставки сам по себе не повод для громкого пуша ────────────────
assert.match(src, /insertRetries:\s*3/, 'порог повторов задан');
const paste = src.slice(src.indexOf('if (!writePrompt(editor, pending.text))'), src.indexOf('insertFail = { at: 0, count: 0 };\n    await sleep(600);'));
assert.ok(paste.length > 0, 'ветка отказа вставки на месте');
assert.match(paste, /attempt < C\.insertRetries/, 'первые попытки — тихие');
assert.match(paste, /повторю через 15 секунд/, 'сказано, что повторит сам');
assert.match(
  paste,
  /attempt >= C\.insertRetries \? \{\} : \{ ntfy: false \}/,
  'пуш только на затяжном отказе',
);
assert.match(paste, /Нажмите «Шаг»/, 'на затяжном отказе видно, что делать');
assert.doesNotMatch(paste, /\n\s*true,\n\s*\);/, 'прежнего «всегда ошибка» больше нет');

console.log(
  `OK: relay ${V} — id из маркера не адресуют запись (битый uuid не подменяется), ` +
    'повторная вставка не будит Мастера, пауза объясняется по-русски',
);
