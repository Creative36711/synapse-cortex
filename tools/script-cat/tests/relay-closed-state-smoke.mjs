/**
 * Структурная проба relay.user.js: состояния PR и различение Closed.
 *
 * Проверяет не поведение в браузере (для этого нужна живая страница Arena), а
 * инварианты, которые легко сломать незаметно: порядок проверок в ожидании
 * мержа, признак «слито» в маркере и наличие перехода в Rework.
 *
 *   node _tools/ScriptCat/tests/relay-closed-state-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const path = new URL('../relay.user.js', import.meta.url);
const src = readFileSync(path, 'utf8');

// 1. Версия: Closed появился в 1.2.0, проверка шлюза — в 1.2.1,
//    технический блок — в 1.3.2, пауза и ntfy — в 1.4.0.
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
assert.match(src, /gatewayIsOld/, 'есть проверка версии шлюза: старый пишет мимо Arena');
assert.match(src, /major === 1 && minor < 5/, 'порог — шлюз 1.5');
assert.match(src, /repo:\s*""/, 'новая установка не содержит встроенного репозитория');
assert.match(src, /\(mainEntry && mainEntry\.repo\)/, 'репозиторий профиля — главная запись списка репозиториев');

// 2. Бейджи взяты ровно те, что в интерфейсе Arena, и только среди видимых:
//    в DOM остаются скрытые бейджи прошлых состояний.
assert.match(src, /badgeVisible\("Pull request merged"\)/, 'Merged — по aria-label "Pull request merged"');
assert.match(src, /badgeVisible\("Pull request closed"\)/, 'Closed — по aria-label "Pull request closed"');
assert.match(src, /rect\.width > 0 && rect\.height > 0/, 'видимость считается по площади, а не по offsetParent');

// 3. Порядок в ожидании мержа: Merged → Closed → Continue.
//    Если Continue проверять раньше Closed, закрытый PR будет принят за слитый.
const loop = src.slice(src.indexOf('async function ensureMerged'), src.indexOf('async function finishClosed'));
const iMerged = loop.indexOf('if (mergedFlag())');
const iClosed = loop.indexOf('if (closedFlag())');
const iContinue = loop.indexOf('if (continueButton()) {', iClosed);
assert.match(loop.slice(iContinue, iContinue + 350), /return finishMerge\(task, key\)/, 'Continue после проверки всё ещё ведёт в finishMerge');
assert.ok(iMerged > -1 && iClosed > iMerged && iContinue > iClosed, 'порядок проверок: Merged → Closed → Continue');

// 4. Признак мержа берётся из маркера, а не из бейджа.
assert.match(src, /result\.merged === true/, 'маркер может заявить merged: true');
assert.match(src, /status.*=== "merged"/s, 'status: "merged" тоже принимается');
assert.match(src, /"pr":"<URL\|null>","merged":true/, 'в шаблоне маркера требуются pr и merged');

// 5. Закрытие без мержа: причина в лог, Rework с ответом, ход Координатору.
const closedPath = src.slice(src.indexOf('merged === "unconfirmed") && !hasMergedClaim(result)'));
assert.ok(closedPath.length > 0, 'есть ветка «закрыт без мержа»');
const closedEnd = closedPath.indexOf('    if (merged === "timeout")');
assert.ok(closedEnd > 0, 'конец ветки закрытого PR найден');
const block = closedPath.slice(0, closedEnd);
assert.match(block, /:closed -->/, 'в лог пишется отдельный маркер закрытия');
assert.match(block, /name: "Rework"/, 'карточка уходит в Rework');
assert.match(block, /Работа в .{1,60}не попала/, 'причина называет базовую ветку проекта в «Ответе»');
assert.match(block, /goTo\(coord\)/, 'ход возвращается Координатору');

// 6. Continue нажимается и в закрытом состоянии — иначе цикл встанет.
const finishClosed = src.slice(src.indexOf('async function finishClosed'), src.indexOf('function prUrl'));
assert.match(finishClosed, /cont\.click\(\)/, 'Continue нажимается в Closed');
assert.match(finishClosed, /return "closed"/, 'ensureMerged возвращает "closed", а не "merged"');

// 7. Ссылка на PR собирается и из номера, и из готового URL.
const prFn = src.slice(src.indexOf('function prUrl'), src.indexOf('const hasMergedClaim'));
assert.match(prFn, /\^https\?:/, 'готовый URL принимается');
assert.match(prFn, /\^\\d\+\$/, 'номер превращается в ссылку');

// 8. Сводка Координатору показывает Rework: иначе причина теряется.
assert.match(src, /Есть Rework: посмотри «Ответ»/, 'Координатор получает подсказку про Rework');

console.log('OK: relay 1.4.63 — Merged / Closed / Timeout, Closed без мержа → Rework, шлюз 1.5');
