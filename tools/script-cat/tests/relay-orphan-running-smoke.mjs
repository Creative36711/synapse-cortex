// Проба 1.4.84: карточка в Running без хода — не работа.
//
// Случай Мастера, 28.10. Задание для Pack Author не ушло (ложное «отправлено»,
// 1.4.82), Мастер нажал ↺ — очередь и ожидание в хранилище снялись, а карточка
// NAR-5.3 осталась в Notion в Running. Дальше журнал говорит сам за себя:
//
//   19:54:44 План Координатора запрошен (0 Submitted, 1 Running, 1 Ready…)
//   19:56:11 Выдан ход Architect: «NAR-5.16 · ADR 0016 принят…»
//
// Координатор увидел «1 Running», решил, что работа идёт, и выдал следующую
// карточку. Прежняя висела в Running до 45-минутного `releaseStalled` — и даже
// потом вернулась бы не сразу, а на следующем шаге.
//
// Здесь проверяется:
//   1) Running-карточка без ожидания возвращается в Ready сразу (после
//      короткой паузы `orphanGraceMs`), а не через 45 минут;
//   2) живой ход, отправка и занятый транспорт её не трогают;
//   3) ↺ снимает ход целиком: карточка хода → Ready, память → чисто,
//      оставшиеся сироты → Ready; отмена в диалоге не трогает ничего;
//   4) если очередь отправки не создалась, `dispatchTask` не оставляет
//      карточку в Running;
//   5) Координатор не берёт ход, пока ответа ждёт исполнитель (иначе новый
//      план перезаписал бы ожидание — та же потеря работы).

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${String(from).trim().slice(0, 48)}`);
  return src.slice(a, b);
};

const MIN = 60_000;
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const rt = (value) => {
  const part = Array.isArray(value?.rich_text) ? value.rich_text[0] : null;
  return String(part?.text?.content || '');
};

const cardOf = (id, minutesAgo, extra = {}) => ({
  id,
  properties: {
    'Запрос': { title: [{ plain_text: `NAR-${id}` }] },
    'Started At': minutesAgo === null ? { date: null } : { date: { start: new Date(Date.now() - minutesAgo * MIN).toISOString() } },
    'Dispatch State': { select: { name: 'Running' } },
    'Run ID': { rich_text: [{ type: 'text', text: { content: `run-${id}` } }] },
    ...extra,
  },
});

// ── 1. sweepOrphans: возвращает в Ready только брошенные карточки ─────────
const sweepSrc = cut(
  '  /**\n   * Карточки в Running, по которым у транспорта нет хода',
  '  async function releaseStalled(mission) {',
);

function makeSweep({ pending = null, expect = null, cards = [] } = {}) {
  const patched = [];
  const logs = [];
  const stamps = [];
  const store = new Map(Object.entries({ 'cfn-pending': pending, 'cfn-expect': expect }));
  const sweepOrphans = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'norm', 'tasks', 'patch', 'log', 'taskTitle', 'C',
    'rt', 'rollbackProps', 'answerStampKey',
    `${sweepSrc}\nreturn sweepOrphans;`,
  )(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    { pending: 'cfn-pending', expect: 'cfn-expect' },
    norm,
    async () => cards,
    async (id, props) => {
      patched.push({ id, props });
      store.set(`patched:${id}`, props);
    },
    (text, error, options) => logs.push({ text, error: Boolean(error), options }),
    (card) => card.properties['Запрос'].title[0].plain_text,
    { stalledMs: 45 * MIN, orphanGraceMs: 2 * MIN },
    rt,
    // Правило отката — как в скрипте: только Running, без ответа и без PR.
    (card) => {
      const props = card && card.properties;
      if (!props || props['Dispatch State']?.select?.name !== 'Running') return null;
      if (props['Submitted At']?.date?.start || props['PR']?.url) return null;
      return {
        'Dispatch State': { select: { name: 'Ready' } },
        'Started At': { date: null },
        'Run ID': { rich_text: [] },
      };
    },
    (id) => `stamp:${id}`,
  );
  return { sweepOrphans, patched, logs, store, stamps };
}

const mission = { id: 'm1' };

// Брошенная карточка: ожидания нет вовсе.
{
  const h = makeSweep({ cards: [cardOf('c1', 16)] });
  const swept = await h.sweepOrphans(mission);
  assert.equal(swept.length, 1, 'карточка без хода найдена');
  assert.equal(h.patched.length, 1, 'она переписана один раз');
  assert.deepEqual(h.patched[0].props['Dispatch State'], { select: { name: 'Ready' } }, 'статус — Ready');
  assert.equal(h.patched[0].props['Started At'].date, null, '«Started At» снят');
  assert.deepEqual(h.patched[0].props['Run ID'].rich_text, [], '«Run ID» снят');
  assert.ok(h.store.has('stamp:c1'), 'отметка ответа по карточке сброшена');
  assert.equal(h.store.get('stamp:c1'), '', 'сброшена в пусто, а не оставлена');
  assert.match(h.logs[0].text, /висит в Running 16 мин без хода скрипта/, 'в журнале видно, сколько висела');
  assert.equal(h.logs[0].options?.ntfy, 'quiet', 'пуш тихий: это уборка, а не остановка');
}

// Только что выданную не трогаем: ход мог уйти из другой вкладки.
{
  const h = makeSweep({ cards: [cardOf('c1', 1)] });
  assert.deepEqual(await h.sweepOrphans(mission), [], 'карточку в пределах orphanGraceMs не трогаем');
  assert.deepEqual(h.patched, [], 'и не переписываем');
}

// Живой ход: по этой карточке скрипт ждёт ответа — можно и три часа.
{
  const expect = { kind: 'dispatch', ref: 'c1', sentAt: Date.now(), roleName: 'Pack Author' };
  const h = makeSweep({ expect, cards: [cardOf('c1', 180)] });
  assert.deepEqual(await h.sweepOrphans(mission), [], 'карточка живого хода неприкосновенна');
}

// Ожидание по другой карточке не спасает брошенную.
{
  const expect = { kind: 'dispatch', ref: 'c2', sentAt: Date.now() };
  const h = makeSweep({ expect, cards: [cardOf('c1', 30), cardOf('c2', 30)] });
  const swept = await h.sweepOrphans(mission);
  assert.deepEqual(swept.map((c) => c.id), ['c1'], 'вернулась только брошенная');
}

// Идёт отправка — не наше дело.
{
  const h = makeSweep({ pending: { roleId: 'k', at: Date.now() }, cards: [cardOf('c1', 60)] });
  assert.deepEqual(await h.sweepOrphans(mission), [], 'пока задание не ушло, карточки не трогаем');
}

// Транспорт занят другим ходом (вопрос приёмке, приёмка миссии, план).
{
  for (const kind of ['answer', 'review', 'plan']) {
    const h = makeSweep({ expect: { kind, ref: 'm1', sentAt: Date.now() }, cards: [cardOf('c1', 60)] });
    assert.deepEqual(await h.sweepOrphans(mission), [], `во время хода «${kind}» карточки не трогаем`);
  }
}

// Уже отвеченная карточка (Submitted At) — не наша: её разбирает Координатор.
{
  const h = makeSweep({ cards: [cardOf('c1', 60, { 'Submitted At': { date: { start: new Date().toISOString() } } })] });
  assert.deepEqual(await h.sweepOrphans(mission), [], 'карточку с ответом не возвращаем');
}

// Без миссии и без задач — молчание, а не падение.
{
  const h = makeSweep({ cards: [] });
  assert.deepEqual(await h.sweepOrphans(null), [], 'без миссии ничего не делаем');
}

// ── 2. ↺: снять ход целиком ───────────────────────────────────────────────
const dialogSrc = cut(
  '  /**\n   * Кнопка ↺: снять ход, а не только память транспорта',
  '  // ───────────────────────────── PR ─────────────────────────────',
);

function makeDialog({ state = {}, answer = true, rolled = true, swept = [], fail = false } = {}) {
  const store = new Map();
  const logs = [];
  const calls = { released: [], resets: 0, sweeps: [], confirms: [] };
  const resetState = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'describeTransient', 'transientState',
    'releaseUndelivered', 'resetState', 'sweepOrphans', 'activeMission', 'log', 'confirm', 'setStatus', 'dbg',
    'SCRIPT_VERSION',
    `${dialogSrc}\nreturn resetStateDialog;`,
  )(
    (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    (key, value) => store.set(key, value),
    { pending: 'cfn-pending', expect: 'cfn-expect' },
    // describeTransient — по факту состояния, как в скрипте.
    (s) => (s.expect ? 'ожидание: «Pack Author», dispatch' : ''),
    () => ({ pending: null, expect: state.expect || null, last: null }),
    async (handoff, why, opts) => {
      calls.released.push({ handoff, why, opts });
      return rolled;
    },
    async () => {
      calls.resets += 1;
    },
    async (m) => {
      calls.sweeps.push(m);
      if (fail) throw new Error('Notion не ответил');
      return swept;
    },
    async () => ({ id: 'm1' }),
    (text) => logs.push(text),
    (text) => {
      calls.confirms.push(text);
      return answer;
    },
    () => {},
    () => {},
    '1.4.86',
  );
  return { resetState, store, logs, calls };
}

// Отказ в диалоге ничего не трогает.
{
  const h = makeDialog({ state: { expect: { kind: 'dispatch', ref: 'c1', sentAt: 1, title: 'NAR-5.3 · Пак state-ui' } }, answer: false });
  await h.resetState();
  assert.equal(h.calls.released.length, 0, 'карточка не тронута');
  assert.equal(h.calls.resets, 0, 'состояние не снято');
  assert.equal(h.calls.sweeps.length, 0, 'Notion не читается');
  assert.equal(h.logs.length, 0, 'журнал молчит');
}

// Сброс с живым ходом: сначала карточка → Ready, потом память, потом сироты.
{
  const handoff = { kind: 'dispatch', ref: 'c1', sentAt: 1, title: 'NAR-5.3 · Пак state-ui' };
  const h = makeDialog({ state: { expect: handoff }, swept: [cardOf('c9', 30)] });
  await h.resetState();
  assert.equal(h.calls.released.length, 1, 'карточка текущего хода возвращена');
  assert.match(h.calls.released[0].why, /ход снят Мастером кнопкой ↺/, 'причина названа');
  assert.equal(h.calls.released[0].opts?.cause, 'manual-reset', 'в журнале хода — своя причина');
  assert.equal(h.calls.resets, 1, 'очередь и ожидание сняты');
  assert.equal(h.calls.sweeps.length, 1, 'остальные Running проверены');
  assert.match(h.logs.at(-1), /карточка хода возвращена в Ready/, 'Мастер видит, что карточка не осталась в Running');
  assert.match(h.logs.at(-1), /без хода висели 1/, 'и сколько ещё карточек убрано');
  assert.match(h.calls.confirms[0], /вернётся в Ready/, 'в диалоге сказано, что произойдёт');
  assert.match(h.calls.confirms[0], /его ответ придёт в чат уже без карточки/, 'и чем рискует сброс посреди работы');
}

// Сброс при пустом хранилище всё равно проверяет Notion: именно так
// исправляется ситуация «я уже жал ↺, а карточка висит».
{
  const h = makeDialog({ swept: [cardOf('c1', 16)] });
  await h.resetState();
  assert.equal(h.calls.sweeps.length, 1, 'карточки в Running проверены');
  assert.match(h.calls.confirms[0], /Проверить карточки в Running/, 'диалог назван по делу');
  assert.match(h.logs[0], /без хода висели 1 — тоже в Ready/, 'журнал объясняет результат');
}

// Notion не ответил — сброс всё равно выполнен, ошибка не глотается.
{
  const h = makeDialog({ state: { expect: { kind: 'plan', ref: 'm1', sentAt: 1 } }, fail: true });
  await h.resetState();
  assert.equal(h.calls.resets, 1, 'память снята, несмотря на сбой чтения');
}

// ── 3. Выдача не оставляет карточку в Running без очереди ────────────────
const dispatchSrc = cut('  async function dispatchTask(card, roleName, mission = null) {', '  // ───────────────────────────── цикл ───');
assert.match(dispatchSrc, /const queued = await sendToRole\(/, 'результат постановки в очередь проверяется');
assert.match(dispatchSrc, /if \(!queued\) \{/, 'непоставленное задание разбирается, а не игнорируется');
assert.match(
  dispatchSrc,
  /await releaseUndelivered\(\s*\{ kind: "dispatch", ref: card\.id, runId, title: taskTitle\(card\) \},\s*"задание не поставлено в очередь",?\s*\)/,
  'карточка возвращается в Ready с причиной',
);

// ── 4. Координатор не перезаписывает живое ожидание ──────────────────────
const coordSrc = cut('  async function coordinatorStep(role, expect, manual = false) {', '  /**\n   * Запрос хода Координатора');
assert.match(
  coordSrc,
  /if \(expect && Number\(expect\.sentAt\) && expect\.kind !== "plan" && expect\.kind !== "reminder"\) \{/,
  'живой ход останавливает Координатора',
);
assert.match(coordSrc, /там ждёт ответа исполнитель/, 'и открывает страницу того, чей ответ ждём');
assert.ok(
  coordSrc.indexOf('expect.kind !== "reminder"') < coordSrc.indexOf('await releaseStalled(mission)'),
  'проверка стоит до любого планирования',
);
assert.match(
  coordSrc,
  /if \(expect && \(expect\.kind === "plan" \|\| expect\.kind === "reminder"\)\) \{/,
  'свой ход (план и напоминание) по-прежнему разбирается маркером ниже',
);

// ── 5. Очередь и ↺ названы в промпте и панели ────────────────────────────
assert.match(src, /Running\/Submitted — движок; Accepted\/Rework\/Ready — ты/, 'Координатору объяснено, что значит Running');
assert.match(src, /orphanGraceMs: 120000/, 'пауза перед уборкой сирот объявлена в конфиге');
assert.match(src, /title="Снять ход: очередь, ожидание и карточки в Running/, 'у ↺ подсказка про карточки');

console.log('orphan-running: 40 проверок — ok');
