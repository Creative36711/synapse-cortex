// Проба 1.4.63: у Rework есть путь назад.
//
// 25.10 Координатор поставил NAR-2.5 в Rework за форму ответа: код уже лежал в
// main, а в отчёте не хватало цитат. Транспорт выдаёт только Ready, поэтому из
// Rework карточка сама никуда не уходит, — а в промпте стояло «карточку с
// ответом обратно в Ready не возвращай». Вместе это запирало карточку навсегда:
// Координатор видел причину, но не имел права вернуть работу.
//
// Проверяется:
//   • Rework попадает в промпт списком с причиной из «Ответ»;
//   • в промпте назван путь назад: Ready, а следы ответа снимает транспорт;
//   • запрет возврата в Ready остался только для принятых (Accepted);
//   • Ready со следами прошлого ответа предупреждает заранее, а не паузой;
//   • без Rework строка пустая и промпт не растёт.

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

const block = sliceBetween('  const reworkCause = (card) => {', '  async function coordinatorStep(');
assert.ok(block.includes('function reworkLine'), 'reworkLine на месте');
assert.ok(block.includes('const staleMarks'), 'staleMarks на месте');

const card = (over) => ({
  id: over.id || 'card-1',
  properties: {
    'Запрос': { title: [{ plain_text: over.title || 'NAR-2.5 · Режимы возможностей' }] },
    'Кому': { select: { name: over.role || 'Kernel' } },
    'Sequence': { number: over.seq ?? 40 },
    'Ответ': { rich_text: over.answer ? [{ plain_text: over.answer }] : [] },
    'Submitted At': { date: over.submitted ? { start: over.submitted } : null },
    'PR': { url: over.pr || null },
    'Run ID': { rich_text: over.runId ? [{ plain_text: over.runId }] : [] },
  },
});

const api = new Function(
  'C', 'rt', 'taskTitle', 'taskRole',
  `${block}
   return { reworkCause, staleMarks, reworkLine };`,
)(
  { readyLineMax: 6 },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || '').join(''),
  (c) => (c.properties?.['Запрос']?.title || []).map((x) => x.plain_text).join(''),
  (c) => c.properties?.['Кому']?.select?.name || '',
);

// ── 1. Причина Rework и следы прошлого ответа ──────────────────────────────
{
  const rework = card({
    answer: 'Rework по форме ответа, не по работе. Код уже в main — нужны цитаты.',
    submitted: '2026-10-24T21:02:00.000+00:00',
    pr: 'https://github.com/example/relay-fixture/pull/45',
    runId: 'run-1',
  });
  assert.match(api.reworkCause(rework), /форме ответа/, 'причина из «Ответ»');
  assert.deepEqual(api.staleMarks(rework), ['«Submitted At»', '«PR»', '«Run ID»'], 'три следа названы');

  const line = api.reworkLine([rework]);
  assert.match(line, /NAR-2\.5/, 'карточка названа');
  assert.match(line, /Kernel/, 'роль названа');
  assert.match(line, /причина: Rework по форме ответа/, 'причина рядом');
  assert.match(line, /Rework сам не выдаётся/, 'сказано, что сам не уходит');
  assert.match(line, /верни карточку в Ready/, 'путь назад назван');
  assert.match(line, /«Submitted At», «PR», «Run ID»/, 'что чистить — перечислено');
  assert.match(line, /прими, запиши в «Ответ»/, 'второй законный выход: принять');
}

// ── 2. Пустая «Ответ» не молчит ────────────────────────────────────────────
assert.match(api.reworkCause(card({})), /«Ответ» пуст/, 'пустая причина названа');

// ── 3. Нет Rework — нет строки ─────────────────────────────────────────────
assert.equal(api.reworkLine([]), '', 'без Rework промпт не растёт');
assert.equal(api.reworkLine(null), '', 'null тоже пустой');

// ── 4. Длинная причина обрезается ──────────────────────────────────────────
{
  const long = 'x'.repeat(400);
  const cause = api.reworkCause(card({ answer: long }));
  assert.ok(cause.length <= 161, 'причина обрезана');
  assert.ok(cause.endsWith('…'), 'и это видно');
}

// ── 5. Ready со следами прошлого ответа предупреждает заранее ──────────────
{
  const readyBlock = sliceBetween('  function readyLine(cards) {', '  /**\n   * Rework — статус');
  assert.match(readyBlock, /остались \$\{stale\.join/, 'readyLine называет следы');
  assert.match(readyBlock, /следы снимет транспорт после разрешённого возврата/, 'следы снимаются только после разрешённого возврата');
  assert.match(readyBlock, /это повторная работа/, 'отвеченная карточка в Ready названа повторной работой');
  assert.match(readyBlock, /убери карточку из Ready/, 'а если повторять не надо — её убирают');
}

// ── 6. Промпт: Rework возвращается, Check=fail — отдельный шаг ─────────────
const { PromptCompiler, planRequest } = await import('./helpers/prompt-env.mjs');
const coord = PromptCompiler.compile(planRequest({ queue: { summary: 's', rework: api.reworkLine([card({ answer: 'причина' })]) } })).text;
assert.match(coord, /Rework: переделка — в Ready отдельным шагом/, 'путь назад назван');
assert.match(coord, /Check=fail НЕ ставь Rework\+Ready одним ответом/, 'Check=fail требует отдельного Rework (#37)');
assert.match(coord, /Accepted\/Rework\/Ready — ты/, 'Ready — право Координатора');
assert.doesNotMatch(coord, /чисти «Submitted At», «PR», «Run ID», иначе выдача откажет/, 'прежняя просьба чистить коннектором убрана');

// ── 7. Строка Rework доходит до Координатора ───────────────────────────────
assert.match(src, /reworkLine\(queue\.rework\)/, 'reworkLine вызывается при запросе плана');
assert.match(src, /function coordinatorPrompt\([\s\S]*?rework = "",/, 'промпт принимает строку Rework');

console.log('OK: relay 1.4.63 — Rework не запирает карточку: причина в промпте, путь назад назван, следы снимает транспорт');
