// Проба 1.4.86: длинный текст и варианты-объекты.
//
// 28.10 в 22:00 цикл дважды подряд встал на записи ответа приёмки. Notion был
// жив и ответил по делу:
//
//   body.properties.Ответ.rich_text[0].text.content.length should be ≤ 2000,
//   instead was 2296
//
// Виноват скрипт, и дважды. Первое: он писал ответ одним объектом `rich_text`,
// а у одного объекта предел 2000 знаков — длинное решение не уезжало вовсе.
// Второе: этот HTTP 400 показывался Мастеру как «Notion не ответил: сеть или
// блокировка запроса», и чинили сеть, которой ничего не было.
//
// Проверяется:
//
//   • 2296 знаков дают два объекта, каждый не длиннее 2000 — текст доходит весь;
//   • пустое значение даёт пустой массив, а не объект с пустой строкой;
//   • граница не рвёт суррогатную пару: эмодзи остаётся целым;
//   • 100 частей — предел массива Notion, дальше не растём;
//   • вариант-объект даёт читаемую метку, а не «[object Object]».

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

/** Вырезает объявление по началу и по строке, с которой начинается следующее. */
const sliceFrom = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

const richTextCode = sliceFrom('  function richText(', '  const sel = (p) =>');
const optionLabelCode = sliceFrom('  const optionLabel = (option) =>', '  /**');

const { richText, optionLabel } = new Function(
  `${richTextCode}\n${optionLabelCode}\nreturn { richText, optionLabel };`,
)();

const textOf = (parts) => parts.map((p) => p.text.content).join('');

// ── 1. Ровно случай 28.10: 2296 знаков ─────────────────────────────────────
{
  const answer = 'я'.repeat(2296);
  const parts = richText(answer);
  assert.ok(Array.isArray(parts), 'rich_text — массив объектов');
  assert.equal(parts.length, 2, '2296 знаков — две части, а не одна');
  for (const part of parts) {
    assert.equal(part.type, 'text', 'каждая часть — text');
    assert.ok(
      part.text.content.length <= 2000,
      `часть не длиннее 2000, а было ${part.text.content.length}`,
    );
  }
  assert.equal(textOf(parts), answer, 'ни один знак не потерян');
}

// ── 2. Пустое значение: Notion не принимает объект с пустой строкой ────────
{
  for (const empty of ['', null, undefined]) {
    assert.deepEqual(richText(empty), [], `пустое (${String(empty)}) даёт пустой массив`);
  }
}

// ── 3. Суррогатная пара на границе части ───────────────────────────────────
{
  // 1899 знаков + эмодзи (2 единицы UTF-16) — граница приходится ровно на пару.
  const answer = 'а'.repeat(1899) + '🙂' + 'б'.repeat(50);
  const parts = richText(answer);
  assert.equal(parts.length, 2, 'две части');
  assert.equal(textOf(parts), answer, 'эмодзи целый');
  // Граница отодвигается на знак назад: эмодзи целиком уходит во вторую часть.
  assert.equal(parts[0].text.content.length, 1899, 'первая часть короче ровно на знак');
  assert.ok(parts[1].text.content.startsWith('🙂'), 'эмодзи не разорван между частями');
  for (const part of parts) {
    // Половина суррогатной пары — это одиночный код 0xd800–0xdfff на краю.
    const last = part.text.content.charCodeAt(part.text.content.length - 1);
    const first = part.text.content.charCodeAt(0);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'часть не кончается половиной пары');
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'часть не начинается половиной пары');
  }
}

// ── 4. Короткий текст — один объект ────────────────────────────────────────
{
  const parts = richText('Ответ принят');
  assert.equal(parts.length, 1, 'короткий ответ — одна часть');
  assert.equal(parts[0].text.content, 'Ответ принят', 'текст как есть');
}

// ── 5. Предел массива: больше 100 частей Notion не примет ──────────────────
{
  const giant = 'в'.repeat(1900 * 130);
  const parts = richText(giant);
  assert.equal(parts.length, 100, 'частей ровно 100 — предел Notion');
  assert.ok(parts.every((p) => p.text.content.length <= 2000), 'каждая часть в пределе');
}

// ── 6. Варианты: объект вместо строки ──────────────────────────────────────
{
  assert.equal(optionLabel('A'), 'A', 'строка как есть');
  assert.equal(optionLabel(7), '7', 'число — строкой');
  assert.equal(optionLabel({ label: 'оставить' }), 'оставить', 'label');
  assert.equal(optionLabel({ text: 'сузить' }), 'сузить', 'text');
  assert.equal(optionLabel({ title: 'снять' }), 'снять', 'title');
  assert.equal(optionLabel({ name: 'keep-scope' }), 'keep-scope', 'name');
  assert.equal(optionLabel({ value: 'A' }), 'A', 'value');
  assert.equal(optionLabel({ id: 'opt-1' }), 'opt-1', 'id');
  assert.equal(optionLabel({ weight: 3 }), '', 'объект без подписи — пусто, а не мусор');
  assert.equal(optionLabel(null), '', 'null — пусто');
  assert.equal(
    [ { label: 'A' }, { text: 'B' } ].map(optionLabel).join(' · '),
    'A · B',
    'склейка вариантов читаемая, без «[object Object]»',
  );
  assert.ok(!optionLabel({ label: 'A' }).includes('[object'), 'никакого [object Object]');
}

console.log('OK: relay 1.4.86 — длинный ответ делится на части, вариант-объект даёт метку');
