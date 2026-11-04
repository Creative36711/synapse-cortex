// Проба 1.4.63: чужой turn_id в маркере Координатора не останавливает цикл.
//
// 25.10, ход 41. Transport запросил план и положил в промпт готовую строку с
// turn_id 8453c8ac. Coordinator ответил на этот самый вопрос, но вписал id
// прошлого хода (f214b8e0) и потерял mission_id — решение при этом было верное
// («next»: «Runtime Auditor», карточка NAR-2.10 уже лежала в Ready).
// Транспорт сравнил turn_id, не совпало — и поставил паузу, хотя терять было
// нечего: id хода он знает сам.
//
// Здесь проверяется новое правило:
//   • миссия в маркере по-прежнему проверяется — чужую миссию не применяем;
//   • пустой next — пауза: непонятно, кому передавать ход;
//   • чужой turn_id — строка в журнале, свой id подставляется, ход идёт;
//   • старый общий текст «не совпал с ожидающим ходом» убран;
//   • промпт просит копировать строку целиком, а не собирать по памяти.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

const from = src.indexOf('      const sameMission = !decision.mission_id');
const to = src.indexOf('      log(`Маркер Координатора найден', from);
assert.ok(from > 0 && to > from, 'разбор маркера Координатора на месте');
const block = src.slice(from, to);

// ── 1. Миссия и next — проверки по существу, они остались паузой ───────────
assert.match(block, /if \(!sameMission\) \{/, 'миссия проверяется');
assert.match(block, /относится к другой миссии/, 'причина названа: другая миссия');
assert.match(block, /if \(!String\(decision\.next \|\| ""\)\.trim\(\)\) \{/, 'next обязателен');
assert.match(block, /нет next/, 'причина названа: нет next');

const pauses = block.match(/\bpause\(/g) || [];
assert.equal(pauses.length, 2, 'пауза ровно в двух случаях: чужая миссия и пустой next');

// ── 2. Чужой turn_id — не пауза ───────────────────────────────────────────
const turnFrom = block.indexOf('if (!sameTurn) {');
assert.ok(turnFrom > 0, 'ветка чужого turn_id есть');
const turnTo = block.indexOf('decision.turn_id = expect.turnId;', turnFrom);
assert.ok(turnTo > turnFrom, 'свой turn_id подставляется');
const turnBlock = block.slice(turnFrom, turnTo);
assert.ok(!/pause\(/.test(turnBlock), 'в ветке чужого turn_id паузы нет');
assert.match(turnBlock, /log\(/, 'ошибка агента всё равно видна в журнале');
assert.match(turnBlock, /чужой turn_id/, 'сказано, что именно не так');
assert.doesNotMatch(src, /не совпал с ожидающим ходом/, 'старый общий текст убран');

// Свой id подставляется до того, как решение применяется: иначе вопрос
// Мастеру ушёл бы с ключом чужого хода.
assert.ok(
  src.indexOf('decision.turn_id = expect.turnId;') < src.indexOf('if (norm(decision.next) !== "blocked")'),
  'подмена идёт до применения решения',
);

// ── 3. Промпт: строку не собирают по памяти (декларативный компилятор) ─────
const { PromptCompiler, planRequest, UUID } = await import('./helpers/prompt-env.mjs');
const prompt = PromptCompiler.compile(planRequest()).text;
assert.match(prompt, /mission_id и turn_id копируй из этого промпта/, 'сказано, откуда брать id');
assert.ok(prompt.includes(UUID.mission) && prompt.includes(UUID.turn), 'готовая строка с настоящими ID');
assert.match(prompt, /CF_COORDINATOR_RESULT \{"mission_id":"/, 'маркер Координатора в промпте');

// ── 4. Решение всё равно проходит проверку роли и Ready ───────────────────
assert.match(src, /const route = decisionRoute\(decision\.next, \{/, 'решение проверяется в decisionRoute');
assert.match(
  src,
  /Координатор направил ход в «\$\{route\.roleName\}», но карточки этой роли в Ready нет/,
  'чужой next без Ready-карточки всё равно даёт паузу, а не выдачу не тому',
);
assert.match(src, /if \(route\.kind === "pause"\) \{/, 'роли и статусы проверяются до выдачи');

console.log('OK: relay 1.4.63 — чужой turn_id в маркере Координатора не останавливает цикл, а виден в журнале');
