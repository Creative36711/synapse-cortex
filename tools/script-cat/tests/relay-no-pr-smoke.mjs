// Проба 1.4.63: «PR не будет» — законный исход, а не ошибка.
//
// 24.10 Build/Release делал карточку-отчёт: кода он не менял, и в чат ушла
// реплика «Please open a pull request…», а агент вместо отчёта отвечал, что
// изменений нет. Аудит устроен так же: аудитор не меняет репозиторий вовсе, и
// PR у него не будет никогда.
//
// Здесь проверяется:
//   • аудитор не ждёт мерж и Continue — кнопки PR не трогаются вовсе;
//   • исполнитель может заявить работу без PR (`"pr": null`), и это не Rework;
//   • пропущенный `pr` по-прежнему считается забытым: безопасность не ослабла;
//   • промпт говорит об этом прямо, чтобы агент не открывал пустой PR.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Версия ──────────────────────────────────────────────────────────────
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);

// ── 2. Разбор заявки «PR не будет» ─────────────────────────────────────────
const from = src.indexOf('  const prDeclined = (result) => {');
const to = src.indexOf('  // ───────────────────────── техническая информация', from);
assert.ok(from > 0 && to > from, 'prDeclined на месте');
const block = src.slice(from, to);
const { prDeclined } = new Function(`${block}\nreturn { prDeclined };`)();

assert.equal(prDeclined({ pr: null }), true, 'явный null — работы без PR');
assert.equal(prDeclined({ pr: 'none' }), true, '«none» — то же самое');
assert.equal(prDeclined({ pr: '-' }), true, 'прочерк — то же самое');
assert.equal(prDeclined({ pr: 'Нет' }), true, '«нет» по-русски');
assert.equal(prDeclined({}), false, 'пропущенный pr — не заявка, а забывчивость');
assert.equal(prDeclined({ pr: 37 }), false, 'номер PR — обычный мерж');
assert.equal(prDeclined({ pr: 'https://github.com/o/r/pull/37' }), false, 'ссылка — тоже');
assert.equal(prDeclined(null), false, 'без ответа — не заявка');

// ── 3. Аудитор и «без PR» не доходят до ожидания мержа ─────────────────────
assert.match(
  src,
  /const noPr = role\.fn === "Auditor" \|\| role\.fn === "Reviewer" \|\| prDeclined\(result\);/,
  'признак «PR не ждём» — Auditor, карточка Reviewer или заявка в маркере',
);
assert.match(
  src,
  /const merged = noPr \? "none" : await ensureMerged\(page, result\);/,
  'ensureMerged не вызывается, когда PR не ждём',
);

// Кнопки Create/Merge живут только внутри ensureMerged: если он не вызван,
// нажать их негде.
const clickCreate = (src.match(/create\.click\(\)/g) || []).length;
const clickMerge = (src.match(/merge\.click\(\)/g) || []).length;
assert.equal(clickCreate, 1, 'клик по «Create pull request» один и только в запасном пути');
assert.equal(clickMerge, 1, 'клик по «Merge pull request» тоже один');
const ensureFrom = src.indexOf('  async function ensureMerged(task, result) {');
const ensureTo = src.indexOf('  async function finishMerge(task, key) {', ensureFrom);
const ensureBlock = src.slice(ensureFrom, ensureTo);
assert.match(ensureBlock, /create\.click\(\)/, 'клик по Create — внутри ensureMerged');
assert.match(ensureBlock, /merge\.click\(\)/, 'клик по Merge — внутри ensureMerged');

// Запасной путь не срабатывает, когда агент уже заявил мерж.
const claimAt = ensureBlock.indexOf('if (hasMergedClaim(result)) {');
const clickAt = ensureBlock.indexOf('const create = createPr();');
assert.ok(claimAt > 0 && clickAt > claimAt, 'заявка о мерже проверяется раньше кликов');

// ── 4. Промпт: работа без PR названа законной ──────────────────────────────
const orderFrom = src.indexOf('  function executorOrder(task, runId,');
const orderTo = src.indexOf('  /** Порядок для аудитора', orderFrom);
const order = src.slice(orderFrom, orderTo);
assert.match(order, /PR не открывай/, 'сказано: без своих изменений PR не нужен');
assert.match(order, /пустой PR ради галочки не нужен/, 'и почему');
assert.match(order, /\\"pr\\": null/, 'как это записать в маркере');
assert.match(order, /пропущенный `pr` считается забытым/, 'разница между null и пропуском');

// Напоминание о маркере тоже подсказывает законный путь.
assert.match(src, /"pr":<номер PR\|null>/, 'в напоминании есть вариант без PR');

// ── 5. Аудит не ослаблен: отчёт всё равно обязателен ───────────────────────
assert.match(
  src,
  /if \(answer\.body < C\.minAnswerChars\) \{/,
  'маркер без отчёта по-прежнему не ответ',
);
assert.match(
  src,
  /role\.fn === "Auditor" \|\| role\.fn === "Reviewer" \|\| prDeclined\(result\)/,
  'аудит остался в правиле «PR не ждём» — вместе с Reviewer и работой без PR',
);

console.log('OK: relay 1.4.63 — аудит и работа без PR не ждут мерж, пропущенный pr по-прежнему ведёт в Rework');
