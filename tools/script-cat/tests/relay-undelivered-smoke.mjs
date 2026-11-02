// Проба 1.4.40: карточка, до которой ход не дошёл, не остаётся в Running.
//
// Вопрос Мастера (53): «Сейчас задача 1.8 Running, скрипт пытался написать
// координатору. Он должен был сменить статус? Всё было бы нормально?»
//
// Статус ставит сама выдача — `dispatchTask`, до отправки, иначе Координатор
// успел бы выдать ту же карточку второй раз. Но «выдана» и «дошла» — разные
// вещи: отказ Send оставлял Running с «Started At» и «Run ID», и карточка
// висела так до `releaseStalled` — 45 минут впустую.
//
// Здесь проверяется `rollbackProps` и `releaseUndelivered` поведением:
// возврат в Ready только для Running без ответа и только по своей выдаче,
// снятие Run ID и «Started At», отметка в журнале попытки и отказ от записи,
// если Notion недоступен (тогда работает прежнее правило 45 минут).

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const from = src.indexOf('  /**\n   * Ход не дошёл до исполнителя');
const to = src.indexOf('  function resume(reason = "проверено Мастером") {');
assert.ok(from > 0 && to > from, 'возврат недошедшего хода на месте');
const block = src.slice(from, to);

const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');

const card = ({ state = 'Running', runId = 'r1', submitted = null, pr = null, logId = 'log1' } = {}) => ({
  id: 'c1',
  properties: {
    'Запрос': { title: [{ plain_text: 'NAR-1.8 · Крафт' }] },
    'Dispatch State': { select: { name: state } },
    'Run ID': { rich_text: runId ? [{ plain_text: runId }] : [] },
    'Started At': { date: { start: '2026-10-23T19:01:00.000+00:00' } },
    'Submitted At': { date: submitted ? { start: submitted } : null },
    'PR': { url: pr },
    'Output Drive File ID': { rich_text: logId ? [{ plain_text: logId }] : [] },
  },
});

function make({ page = card(), notionFails = false, patchFails = false } = {}) {
  const out = { patched: [], appended: [], logs: [], reads: [] };
  const fn = new Function(
    'rt', 'norm', 'notion', 'patch', 'gateway', 'log', 'taskTitle',
    `${block}\nreturn { rollbackProps, releaseUndelivered };`,
  );
  const api = fn(
    rt,
    norm,
    async (method, path) => {
      out.reads.push({ method, path });
      if (notionFails) throw new Error('Notion 502');
      return page;
    },
    async (id, props) => {
      if (patchFails) throw new Error('Notion 503');
      out.patched.push({ id, props });
    },
    async (action, fileId, extra) => { out.appended.push({ action, fileId, marker: extra?.marker }); },
    (text, error) => out.logs.push({ text, error: Boolean(error) }),
    (c) => c.properties['Запрос'].title[0].plain_text,
  );
  return { ...api, out };
}

// ── 1. Правило: возвращаем только Running без ответа ────────────────────────
{
  const { rollbackProps } = make();
  const props = rollbackProps(card(), 'r1');
  assert.equal(props['Dispatch State'].select.name, 'Ready', 'Running → Ready');
  assert.equal(props['Started At'].date, null, '«Started At» снимается');
  assert.deepEqual(props['Run ID'].rich_text, [], 'Run ID снимается');
  assert.equal(Object.keys(props).length, 3, 'других полей не трогаем');
}
{
  const { rollbackProps } = make();
  assert.equal(rollbackProps(card({ state: 'Submitted' }), 'r1'), null, 'отвеченную не трогаем');
  assert.equal(rollbackProps(card({ submitted: '2026-10-23T19:30:00Z' }), 'r1'), null, 'с «Submitted At» не трогаем');
  assert.equal(rollbackProps(card({ pr: 'https://github.com/x/y/pull/1' }), 'r1'), null, 'с PR не трогаем');
  assert.equal(rollbackProps(card({ state: 'Ready' }), 'r1'), null, 'Ready уже');
  assert.equal(rollbackProps(card({ runId: 'r2' }), 'r1'), null, 'чужая (более новая) выдача не откатывается');
}
// Пустой Run ID у Running-карточки — тоже брошенная карточка (так выглядели
// выдачи до 1.4.20): сверять нечего, возвращаем в Ready.
{
  const { rollbackProps } = make();
  const props = rollbackProps(card({ runId: '' }), 'r1');
  assert.equal(props['Dispatch State'].select.name, 'Ready', 'без Run ID на карточке тоже возвращаем');
}

// ── 2. Ход не выдавался этой карточке: ничего не делаем ─────────────────────
{
  const h = make();
  assert.equal(await h.releaseUndelivered(null, 'нет хода'), false, 'пустое ожидание');
  assert.equal(await h.releaseUndelivered({ kind: 'plan', ref: '' }, 'план Координатора'), false, 'план карточки не касается');
  assert.equal(h.out.reads.length, 0, 'Notion даже не спрашиваем');
}

// ── 3. Отказ Send: карточка возвращается, отметка в журнале попытки ─────────
{
  const h = make();
  const ok = await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1' }, 'сообщение не ушло (send нажат)');
  assert.equal(ok, true, 'возврат удался');
  assert.equal(h.out.patched.length, 1, 'одна запись в карточку');
  assert.equal(h.out.patched[0].props['Dispatch State'].select.name, 'Ready');
  assert.equal(h.out.appended.length, 1, 'причина записана в журнал попытки');
  assert.equal(h.out.appended[0].fileId, 'log1', 'журнал — тот же файл выдачи');
  assert.match(h.out.appended[0].marker, /:undelivered -->$/, 'метка отдельная, ответ не перетрёт');
  assert.ok(h.out.logs.some((l) => /возвращена в Ready/.test(l.text)), 'в журнале цикла видно');
  assert.ok(h.out.logs.some((l) => /45 минут/.test(l.text)), 'объяснено, чего избежали');
}

// ── 4. Карточку уже сдвинули: не перезаписываем и говорим «не вышло» ───────
{
  const h = make({ page: card({ state: 'Submitted', submitted: '2026-10-23T19:20:00Z' }) });
  assert.equal(await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1' }, 'сообщение не ушло'), false);
  assert.equal(h.out.patched.length, 0, 'отвеченная карточка не сбрасывается в Ready');
  assert.equal(h.out.appended.length, 0, 'и журнал не засоряется');
}

// ── 4.1. Карточку успели перевыдать: живой ход не снимаем ──────────────────
{
  const h = make({ page: card({ runId: 'r2' }) });
  assert.equal(
    await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1', runId: 'r1' }, 'сообщение не ушло'),
    false,
    'новая выдача не откатывается старой',
  );
  assert.equal(h.out.patched.length, 0);
}

// ── 5. Notion недоступен: ход не съедаем, работает правило 45 минут ────────
{
  const h = make({ notionFails: true });
  assert.equal(await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1' }, 'сообщение не ушло'), false);
  assert.equal(h.out.patched.length, 0);
  assert.ok(h.out.logs.some((l) => l.error && /не прочитать/.test(l.text)), 'причина видна и помечена как проблема');
}
{
  const h = make({ patchFails: true });
  assert.equal(await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1' }, 'сообщение не ушло'), false);
  assert.ok(h.out.logs.some((l) => /осталась в Running/.test(l.text)), 'сказано, что статус не снялся');
}

// ── 6. Карточка без журнала попытки: возврат всё равно работает ────────────
{
  const h = make({ page: card({ logId: '' }) });
  assert.equal(await h.releaseUndelivered({ kind: 'dispatch', ref: 'c1' }, 'сообщение не ушло'), true);
  assert.equal(h.out.appended.length, 0, 'писать некуда — не ошибка');
  assert.equal(h.out.patched.length, 1);
}

// ── 7. Вызовы на месте: иначе правило есть, а не работает ──────────────────
assert.match(src, /const rolled = await releaseUndelivered\(\s*failed,/, 'отказ Send снимает Running');
assert.match(src, /await dropGhostHandoff\("очередь отправки просрочена", \{ ignoreQueue: true \}\)/, 'просрочка снимает Running с любой страницы');
assert.match(src, /async function dropGhostHandoff\(why, \{ ignoreQueue = false \} = \{\}\)/, 'откат собран в одном месте');
assert.match(src, /await releaseUndelivered\(gone, "отправка не подтвердилась/, 'фантом без текста снимает Running');
assert.match(src, /await releaseUndelivered\(stuck, "агент не ответил и ничего не делает"\)/, 'молчание 30 минут снимает Running');
assert.match(src, /"Dispatch State": \{ select: \{ name: "Running" \} \}/, 'выдача по-прежнему ставит Running до отправки');
// ── 8. 1.4.63: отказ отправки не снимает ход ───────────────────────────────
// Мастер: «кнопка „Продолжить“ не должна сбрасывать ход полностью, а именно
// продолжать на том моменте, где произошла ошибка». Поэтому текст задания
// остаётся в очереди, а карточка возвращается в Running перед повторной
// отправкой — без нового хода Координатора.
const failFrom = src.indexOf('if (!delivery.ok) {');
const failBlock = src.slice(failFrom, src.indexOf('const expect = GM_getValue(K.expect, null);', failFrom));
assert.ok(failFrom > 0, 'ветка отказа отправки на месте');
assert.match(failBlock, /GM_setValue\(K\.pending, \{ \.\.\.pending, undelivered: true/, 'очередь остаётся и помечается');
assert.match(failBlock, /undelivered: true,\n\s+cardRolled: true/, 'ожидание помнит, что карточка откатана');
assert.doesNotMatch(failBlock, /GM_setValue\(K\.pending, null\)/, 'очередь больше не снимается');
assert.match(failBlock, /без нового хода Координатора/, 'Мастеру сказано, что ход не потерян');

const consumeFrom = src.indexOf('async function consumePending(manual = false) {');
const consumeBlock = src.slice(consumeFrom, src.indexOf('// ───────────────────── следы прошлых попыток', consumeFrom));
assert.match(consumeBlock, /pending\.undelivered \? C\.undeliveredTtlMs : C\.pendingTtlMs/, 'у неотправленного свой срок ожидания');
assert.match(consumeBlock, /if \(pending\.undelivered\) \{/, 'перед отправкой проверяется откат');
assert.match(consumeBlock, /"Dispatch State": \{ select: \{ name: "Running" \} \}/, 'карточка возвращается в Running');
assert.match(consumeBlock, /text: \{ content: waiting\.runId \}/, 'Run ID — тот же, ответ агента будет куда записать');
assert.match(consumeBlock, /state !== "Ready" && state !== "Running"/, 'чужое состояние не перезаписываем');
assert.match(consumeBlock, /новый ход Координатора не нужен/, 'в журнале сказано, что Координатор не нужен');

assert.match(src, /undeliveredTtlMs: 7200000/, 'два часа на ответ Мастера');
assert.match(src, /stale\.undelivered && staleExpect/, 'перевыдача карточки снимает прошлую очередь');
assert.match(src, /Задание уже в очереди — отправляю его заново/, '«Продолжить» говорит, что ход не сброшен');

console.log(
  'OK: relay 1.4.63 — ход, не дошедший до исполнителя, возвращает карточку в Ready, а не держит её 45 минут',
);
