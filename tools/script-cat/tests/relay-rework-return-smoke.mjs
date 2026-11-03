// Проба 1.4.78: Rework → Ready за один ход не запирает карточку.
//
// 27.10 Координатор разобрал NAR-4.9: вернул её в Rework, переписал Инварианты
// и Acceptance, поставил Check=fail — и тут же перевёл в Ready, чтобы работа
// пошла заново. Транспорт состояние Rework не увидел (оно продержалось меньше
// одного тика), памяти о нём не было, и выдача отказала: «карточка уже
// отвечена → повторно не выдаю», пауза.
//
// Правило исправлено: следы прошлого ответа («Submitted At», «PR», «Run ID»)
// снимаются на выдаче, если карточка в Ready и на ней есть следы. Ход в Ready
// направляет только Координатор — транспорт сам из Ready ничего не берёт,
// поэтому его указание и есть решение «работа нужна заново». Память о Rework
// осталась только для журнала (причина в строке).
//
// Проверяется:
//   • Ready со следами + нет памяти о Rework → чистка всё равно разрешена;
//   • не Ready (Submitted, Running, Rework) — не чистим и не выдаём;
//   • без следов — чистить нечего;
//   • одного следа достаточно (PR или Run ID без даты);
//   • причина в журнале: память → Check=fail → правка после ответа → указание;
//   • из двух карточек роли в Ready берётся свежая, отвеченная — только если
//     другой нет;
//   • счётчик повторных выдач: третья за шесть часов — пауза, и счётчик
//     обнуляется, чтобы «Продолжить» продолжало;
//   • dispatchTask чистит следы до проверки и возвращает причину, а не молчит;
//   • отказ выдачи больше не ставит паузу сразу — ход возвращается Координатору.

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

const block = sliceBetween('  const answeredMarks = (card) =>', '  /**\n   * Вернуть карточку в Ready');

// Память ScriptCat — обычный объект: так видно и запись, и чтение.
const store = new Map();
const api = new Function(
  'GM_getValue',
  'GM_setValue',
  'rt',
  'norm',
  'taskRole',
  'Date',
  `${block}
   return {
     answeredMarks, answeredCard, reworkKey, reworkSeen, rememberRework,
     rememberAnswerStamp, editedSinceAnswer, redispatchWhy,
     redispatchClearProps, pickReadyForRole, noteRedispatch, redispatchKey,
     REDISPATCH_LIMIT,
   };`,
)(
  (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  (key, value) => store.set(key, value),
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || '').join(''),
  (x) => String(x || '').replace(/-/g, '').toLowerCase(),
  (task) => task?.properties?.['Кому']?.select?.name || '',
  Date,
);

const card = (over = {}) => ({
  id: over.id || 'card-1',
  last_edited_time: over.edited || '',
  properties: {
    'Кому': { select: { name: over.role || 'Architect' } },
    'Check': { select: over.check ? { name: over.check } : null },
    'Dispatch State': { select: { name: over.state || 'Ready' } },
    'Submitted At': {
      date: over.submitted === undefined ? { start: '2026-10-27T16:39:00.000+00:00' } : over.submitted,
    },
    'PR': { url: over.pr === undefined ? 'https://github.com/example/relay-fixture/pull/95' : over.pr },
    'Run ID': { rich_text: over.runId === undefined ? [{ plain_text: 'run-1' }] : over.runId },
  },
});

const CLEAR = {
  'Submitted At': { date: null },
  'PR': { url: null },
  'Run ID': { rich_text: [] },
};

// ── 1. Главное: Rework → Ready за один ход больше не запирает карточку ─────
assert.equal(
  api.reworkSeen('card-1'),
  false,
  'памяти о Rework нет — ровно как было на NAR-4.9',
);
assert.deepEqual(api.redispatchClearProps(card()), CLEAR, 'обычный Rework→Ready снимает следы');
assert.equal(api.redispatchClearProps(card({ check: 'fail' })), null, 'Check=fail без наблюдённого Rework не очищается автоматически');

// ── 2. Не Ready — не наше дело ─────────────────────────────────────────────
for (const state of ['Submitted', 'Running', 'Rework', 'Accepted', 'Draft', 'Blocked']) {
  assert.equal(api.redispatchClearProps(card({ state })), null, `«${state}» не чистится: карточка не выдаётся`);
}
assert.equal(api.redispatchClearProps(null), null, 'нет карточки — нет чистки');
assert.equal(api.redispatchClearProps({ id: 'x' }), null, 'нет свойств — нет чистки');

// ── 3. Следов нет — чистить нечего ─────────────────────────────────────────
assert.equal(
  api.redispatchClearProps(card({ submitted: null, pr: null, runId: [] })),
  null,
  'свежая карточка идёт обычным путём',
);

// ── 4. Одного следа достаточно ─────────────────────────────────────────────
assert.deepEqual(api.redispatchClearProps(card({ submitted: null, runId: [] })), CLEAR, 'PR — тоже след');
assert.deepEqual(api.redispatchClearProps(card({ submitted: null, pr: null })), CLEAR, 'Run ID — тоже след');
assert.deepEqual(api.redispatchClearProps(card({ pr: null, runId: [] })), CLEAR, 'дата — тоже след');
assert.deepEqual(
  api.answeredMarks(card()),
  { 'Submitted At': true, 'PR': true, 'Run ID': true },
  'признаки ответа читаются по одному',
);

// ── 5. Причина в журнале: от точной к общей ────────────────────────────────
{
  const fresh = card({ id: 'why-1' });
  assert.equal(api.redispatchWhy(fresh), 'Координатор направил её в работу снова', 'память, признаков и правок нет');

  const failed = card({ id: 'why-2', check: 'fail' });
  assert.match(api.redispatchWhy(failed), /Check=fail/, 'провал проверки назван');

  api.rememberAnswerStamp('why-3', { last_edited_time: '2026-10-27T16:40:00.000Z' });
  const edited = card({ id: 'why-3', edited: '2026-10-27T16:52:00.000Z' });
  assert.match(api.redispatchWhy(edited), /правили после ответа/, 'правка после ответа названа');
  assert.equal(api.editedSinceAnswer(edited), true, 'страница менялась после ответа');
  assert.equal(
    api.editedSinceAnswer(card({ id: 'why-3', edited: '2026-10-27T16:40:00.000Z' })),
    false,
    'та же отметка — правок не было',
  );
  assert.equal(api.editedSinceAnswer(card({ id: 'why-4', edited: '2026-10-27T16:52:00.000Z' })), false, 'нет отметки — нет вывода');

  api.rememberRework([{ id: 'why-5' }]);
  assert.deepEqual(api.redispatchClearProps(card({ id: 'why-5', check: 'fail' })), CLEAR, 'явный Rework разрешает контролируемый повтор');
  assert.match(api.redispatchWhy(card({ id: 'why-5' })), /видели в Rework/, 'память о Rework — первая причина');
  assert.equal(api.reworkSeen('why-6'), false, 'чужая память не переходит на другую карточку');
}

// ── 6. Из двух карточек роли берётся свежая ────────────────────────────────
{
  const old = card({ id: 'old', role: 'Architect' });
  const next = card({ id: 'next', role: 'Architect', submitted: null, pr: null, runId: [] });
  const other = card({ id: 'other', role: 'Kernel' });
  const picked = api.pickReadyForRole([old, next, other], 'Architect');
  assert.equal(picked.id, 'next', 'свежая работа не подменяется повторной');
  assert.equal(api.pickReadyForRole([old, other], 'Architect').id, 'old', 'если другой нет — берётся отвеченная');
  assert.equal(api.pickReadyForRole([next, other], 'ARCHITECT').id, 'next', 'роль сравнивается без регистра');
  assert.equal(api.pickReadyForRole([other], 'Architect'), null, 'чужую роль не выдаём');
  assert.equal(api.pickReadyForRole([], 'Architect'), null, 'пустая очередь — ничего');
}

// ── 7. Петель не больше трёх за шесть часов ────────────────────────────────
{
  assert.equal(api.REDISPATCH_LIMIT, 3, 'порог назван: третья повторная выдача — пауза');
  assert.equal(api.noteRedispatch('loop'), 1, 'первая выдача');
  assert.equal(api.noteRedispatch('loop'), 2, 'вторая');
  store.set(api.redispatchKey('loop'), [Date.now() - 7 * 3600 * 1000, Date.now()]);
  assert.equal(api.noteRedispatch('loop'), 2, 'старые выдачи за окном не считаются');
  assert.equal(api.noteRedispatch('other'), 1, 'счёт у каждой карточки свой');
}

// ── 8. dispatchTask: чистка до проверки, причина вместо молчания ───────────
const dispatch = sliceBetween('  async function dispatchTask(', '\n  async function ');
assert.match(dispatch, /Check\?\.select\?\.name === \"fail\" && !reworkSeen\(fresh\.id\)/, 'Check=fail без явного Rework блокирует повтор');
assert.ok(dispatch.indexOf('Check?.select?.name === \"fail\"') < dispatch.indexOf('redispatchClearProps(fresh)'), 'проверка fail блокирует повтор до очистки следов');
assert.match(dispatch, /const clearing = redispatchClearProps\(fresh\);/, 'выдача спрашивает разрешение на чистку');
assert.match(dispatch, /await patch\(fresh\.id, clearing\);/, 'и снимает следы одной записью');
assert.match(dispatch, /GM_setValue\(answerStampKey\(fresh\.id\), ""\)/, 'отметка ответа тоже снимается');
assert.match(dispatch, /GM_setValue\(reworkKey\(fresh\.id\), 0\)/, 'память о Rework обнуляется');
assert.match(dispatch, /const why = redispatchWhy\(fresh\)/, 'причина попадает в журнал');
assert.ok(
  dispatch.indexOf('redispatchClearProps(fresh)') < dispatch.indexOf('if (state !== "Ready" || submittedAt || prLink)'),
  'чистка идёт до проверки «карточка не в Ready»',
);
assert.match(dispatch, /return state !== "Ready"/, 'невыдача возвращает причину, а не молчит');
assert.match(
  dispatch,
  /redispatchClearProps\(fresh\)[\s\S]*?noteRedispatch\(fresh\.id\)/,
  'счётчик повторных выдач тикает только вместе с чисткой',
);

// ── 9. Отказ выдачи не ставит паузу сразу ─────────────────────────────────
const coordinator = sliceBetween('  async function coordinatorStep(', '  /**\n   * Запрос хода Координатора');
assert.match(coordinator, /const card = pickReadyForRole\(ready, route\.roleName\)/, 'карточка выбирается по роли и свежести');
assert.match(coordinator, /const problem = await dispatchTask\(card, route\.roleName, mission\)/, 'причина отказа читается, миссия передаётся в выдачу');
assert.match(coordinator, /if \(problem === true\)/, 'успех отличается от причины');
assert.match(coordinator, /cfn-dispatch-miss/, 'повторы отказа считаются');
assert.match(
  coordinator,
  /await requestPlan\(mission, role, fresh, `Карточку выдать не удалось/,
  'ход возвращается Координатору с причиной',
);
assert.ok(
  coordinator.indexOf('if (misses >= 3)') < coordinator.indexOf('await requestPlan(mission, role, fresh, `Карточку выдать не удалось'),
  'пауза — только третьим шагом, а не на первом отказе',
);
assert.doesNotMatch(src, /cfn-answered-miss/, 'старый счётчик с паузой со второго раза убран');
assert.doesNotMatch(src, /Похоже, карточку вернули в Ready вручную/, 'просьба чистить поля руками убрана');

// ── 10. Промпт: Координатор знает, что чистить не надо ────────────────────
assert.match(
  src,
  /следы прошлого ответа \(«Submitted At», «PR», «Run ID»\) снимет транспорт на выдаче, даже если Rework и Ready проставлены одним ходом/,
  'в промпте сказано про один ход',
);
assert.doesNotMatch(src, /верни её в Ready и очисти «Submitted At», «PR», «Run ID»/, 'чистка коннектором не просится');
assert.match(src, /rememberRework\(rework\);/, 'queueOf по-прежнему помнит Rework — ради причины в журнале');

console.log('OK: relay 1.4.78 — Rework → Ready за один ход выдаётся заново, паузы нет');
