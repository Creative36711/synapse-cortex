// Проба 1.14.18 (D-088): занятый номер останавливает заявку, но не пересказ.
//
// Инцидент 09.11, 18:00Z, класс transport, пауза `answer-decisions`, 1 из 2:
// ответ Warden перечислял, какие номера решений уже заняты (D-084…D-087) и что в
// объявлении было «свободны D-085 и D-086». Это точный пересказ, а не заявка.
// Гейт D-085 смотрел на 120 знаков вокруг каждого `D-NNN` и падал на словах
// «свободен/номер/решение» — то есть останавливал верный ответ и уводил ход
// Maintainer'у. Здесь проверяется разница между заявкой и упоминанием.
//
// Проверяется:
//   • пересказ занятых номеров и цитата из объявления — не конфликт;
//   • прямая заявка занятого номера — конфликт, и в тексте назван свободный;
//   • свободный номер, равный последнему занятому + 1, называется верно;
//   • отрицание («не занят») заявкой не считается;
//   • внятная причина вместо прежней общей фразы.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

// Блок «заявка ↔ упоминание» тянем из сборки: если в исходнике появится третий
// способ присвоения, проба должна увидеть его, а не копию в тесте.
const from = src.indexOf('const DECISION_LOOKBEHIND');
const to = src.indexOf('/**\n   * Вопрос приёмке по предложению', from);
assert.ok(from > 0 && to > from, 'блок разбора заявок найден в сборке');
const { decisionClaim, decisionNumberConflict } = new Function(
  `${src.slice(from, to)}\nreturn { decisionClaim, decisionNumberConflict };`,
)();

// Занятые номера на 09.11 — как в docs/DECISIONS.md после D-087.
const TAKEN = ['D-080', 'D-081', 'D-082', 'D-083', 'D-084', 'D-085', 'D-086', 'D-087'];

// ── 1. Пересказ и цитата — не конфликт ──────────────────────────────────────
const incident = 'В объявлении Warden было «свободны D-085 и D-086», сейчас оба заняты. ' +
  'Заняты D-084, D-085, D-086, D-087. Свободен следующий.';
assert.deepEqual(decisionClaim(incident), [], 'пересказ занятых номеров — не заявка');
assert.equal(decisionNumberConflict(incident, TAKEN), '',
  'инцидент 18:00Z: верный ответ больше не останавливается');

assert.deepEqual(decisionClaim('Какие номера заняты: D-084, D-085, D-086, D-087, D-088.'), [],
  'простое перечисление не считается заявкой');
assert.deepEqual(decisionClaim('Свободен D-088.'), [], 'называние свободного номера — не заявка');
assert.deepEqual(decisionClaim('D-088 не занят, можно брать.'), [], 'отрицание не является заявкой');
assert.deepEqual(decisionClaim('Решение D-085 уже занято транспортом.'), [],
  '«занято» без присвоения — это тоже пересказ');

// ── 2. Заявка занятого номера — конфликт ────────────────────────────────────
for (const sample of [
  'Решение о зонах §7 = D-087.',
  'Зоны §7 = D-087.',
  'D-087: таблица зон §7.',
  'Беру D-087 — зоны §7.',
  'номер D-087 занят мной, вопрос закрыт.',
  'decision D-087',
]) {
  assert.deepEqual(decisionClaim(sample), ['D-087'], `заявка распознана: ${sample}`);
  assert.match(decisionNumberConflict(sample, TAKEN), /D-087/, `конфликт назван: ${sample}`);
}

// ── 3. Свободный номер назван верно ─────────────────────────────────────────
const message = decisionNumberConflict('Зоны §7 = D-087.', TAKEN);
assert.match(message, /последний занятый — D-087/, 'последний занятый назван');
assert.match(message, /Свободный номер сейчас D-088/, 'свободный номер = последний + 1');
assert.match(message, /возьми его и повтори ответ/, 'действие названо');
assert.match(message, /Упоминание занятых номеров в объяснении конфликтом не считается/,
  'граница «заявка vs упоминание» сказана прямо');

// Номер не «угадывается» по списку ответа: при занятом D-088 свободным будет D-089.
assert.match(decisionNumberConflict('D-088 = зоны.', [...TAKEN, 'D-088']),
  /Свободный номер сейчас D-089/, 'свободный считается от репозитория, а не от памяти');

// ── 4. Пустой ввод и отсутствие списка ──────────────────────────────────────
assert.deepEqual(decisionClaim(''), [], 'пустой ответ ничего не заявляет');
assert.equal(decisionNumberConflict('Зоны = D-087.', []), '', 'без списка занятых не блокируем');
assert.equal(decisionNumberConflict('Обычный ответ без номеров.', TAKEN), '', 'номеров нет — не блокируем');

// ── 5. Гейт подключён к приёмке и остался в классе transport ────────────────
assert.match(src, /const conflict = decisionNumberConflict\(answer, await decisionNumbersTaken\(\)\)/,
  'гейт стоит на пути ответа приёмки');
assert.match(src, /kind: "answer-decisions"/, 'пауза названа своим видом');
assert.match(src, /"answer-decisions": "transport",/, 'пауза остаётся транспорту');

// ── 6. Версия и решение ─────────────────────────────────────────────────────
assert.match(src, /@version\s+1\.14\.18/, 'сборка 1.14.18');
const decisions = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');
assert.match(decisions, /## D-089/, "решение D-089 записано");

console.log('ok 1 - tests/relay-decision-claim-smoke.mjs');
