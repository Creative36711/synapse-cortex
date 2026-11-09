// Проба 1.14.20 (D-091): «решение Warden здесь и сейчас» — это ход Warden, а не
// возврат Координатору.
//
// Инцидент SYN-3, ход `9a6073e2` → `5aaf0a4d` (09.11). Координатор сделал
// Rework B0-r2, записал разбор и в том же маркере попросил решения приёмки:
// `question` с вариантом по умолчанию, `need:"Warden"`, `gate:true` — и
// `next:"Warden"`, потому что другого адреса перехода он не знал.
//
// Что произошло в 1.14.19:
//   1. Вопрос лёг строкой в «Обратную связь» и попал в очередь приёмки — верно.
//   2. `if (askedRow && (gate || need))` вычислился, но `startAnswer` вернул
//      `false`: при повторе `askQuestion` отдаёт `{ id: "" }`, ячейки в очереди
//      нет. Ветка не сработала, и ход пошёл дальше — в `decisionRoute`.
//   3. `decisionRoute("Warden")` отказал: приёмке карточек не выдают. Ход
//      вернулся Координатору с текстом «смени «Кому» на рабочую роль и повтори
//      next».
//   4. Очередь была пуста (0 Submitted / 0 Running / 0 Ready / 2 Rework /
//      6 Draft), выдавать было нечего, и Координатор закончил ответ без маркера
//      («Stopped», напоминание 1 из 2).
//
// Причина — в транспорте: гейт-вопрос и `next` считались независимыми, хотя
// решение «мне нужен ответ приёмки, без него дальше нельзя» уже принято. Роль
// при этом права: приёмка — не исполнитель, и требовать от неё рабочую карточку
// по-прежнему нельзя.
//
// Правка D-091:
//   • вопрос с `gate`/`need` сам передаёт ход адресату и завершает ход
//     (`return true`); `next` в этом ходе не читается вовсе;
//   • если передать не удалось — пауза `answer-handoff` с причиной, а не
//     молчаливый возврат Координатору;
//   • отказ `decisionRoute` на приёмку теперь называет канал вопроса отдельно
//     от выдачи карточки, чтобы Координатор не искал рабочую роль для вопроса;
//   • под `next:"blocked"` ветка не дублируется: там свой разбор остановки.
//
// Проба красная на 1.14.19 (пункт 1: у ветки нет `return true` и нет паузы) и
// зелёная на 1.14.20.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assert.match(src, /@version\s+1\.14\.2[0-9]/, 'сборка не старее 1.14.20');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim().slice(0, 60)}`);
  return src.slice(a, b);
};

// ── 1. Гейт-вопрос сам передаёт ход и этим завершает его ───────────────────
{
  const branch = cut('      if (!blocked && askedRow && (askedRow.gate', '      if (askedRow) {');
  assert.match(branch, /await startAnswer\(mission, item\)/, 'ход к адресату ставится');
  assert.match(branch, /return true;/, 'и ход на этом заканчивается — next не читается');
  assert.match(branch, /next «\$\{decision\.next\}» в этом ходе не применяется/,
    'в журнале сказано, что next не применяется: иначе Координатор ждёт выдачи карточки');
  assert.match(branch, /"answer-handoff"/, 'отказ передачи — пауза с причиной, а не молчание');
  assert.match(branch, /answerQueue\(\)\.find\(\(row\) => row\.text && norm\(row\.text\) === norm\(askedRow\.text\)\)/,
    'ячейка ищется и по тексту: при повторе у строки пустой id — это и был отказ 09.11');
  // Под `blocked` эта ветка не срабатывает: там своя ветка остановки.
  assert.match(branch, /^      if \(!blocked &&/, 'ветка не перехватывает остановку');
}

// ── 2. Отказ по приёмке отделяет вопрос от выдачи карточки ─────────────────
{
  const route = cut('    if (reviewer || norm(name) === norm("Warden")) {', '    if (!target) {');
  assert.match(route, /Спрашивать приёмку — можно/, 'Координатору сказано, что спросить можно');
  assert.match(route, /question с gate:true и need:/, 'и назван именно канал вопроса');
  assert.match(route, /next в этом ходе не применяется/, 'и что next при таком вопросе не нужен');
  assert.match(route, /А вот карточку ей не выдают/, 'запрет карточки сохранён и отделён от вопроса');
  assert.match(route, /оставь карточку в Ready и повтори next с этой ролью/, 'прежняя исполнимая подсказка на месте');
}

// ── 3. Класс паузы: это транспорт, а не решение Мастера ────────────────────
{
  const heal = readFileSync(new URL('../src/40-heal-core.js', import.meta.url), 'utf8');
  assert.match(heal, /"answer-handoff": "transport"/,
    'неудачная передача вопроса правится транспортом, Мастер тут ни при чём');
}

// ── 4. Разбор на живом случае: ход 09.11 разворачивается в ход к Warden ────
{
  const branchStart = src.indexOf('      if (!blocked && askedRow && (askedRow.gate');
  const branchEnd = src.indexOf('      if (askedRow) {', branchStart);
  const body = src.slice(branchStart, branchEnd);
  const answerQueue = () => [{ id: 'row-1', text: 'Выдать B5 на ТЗ 1.7?', need: 'Warden', gate: true }];
  const calls = [];
  const run = new Function(
    'answerQueue', 'norm', 'startAnswer', 'log', 'pause', 'oneLine', 'mission', 'decision',
    `return (async () => {
     const blocked = false;
     const askedRow = { id: "", text: 'Выдать B5 на ТЗ 1.7?', need: 'Warden', gate: true };
     ${body}
     return { reached: "next" };
     })();`,
  );
  const result = await run(
    answerQueue,
    (x) => String(x || '').trim().toLowerCase(),
    async (m, item) => { calls.push(item); return true; },
    () => {},
    (reason) => calls.push({ paused: reason }),
    (t) => String(t || ''),
    { id: 'mission-1' },
    { next: 'Warden' },
  );
  assert.equal(calls.length, 1, 'ход ушёл ровно один раз');
  assert.equal(calls[0].need, 'Warden', 'именно к Warden — ячейка найдена по тексту при пустом id');
  assert.equal(result, true, 'ход завершён на передаче вопроса — до маршрутизации по next дело не дошло');
}

// ── 5. Передать не удалось — это пауза, а не «иди по next» ─────────────────
{
  const branchStart = src.indexOf('      if (!blocked && askedRow && (askedRow.gate');
  const branchEnd = src.indexOf('      if (askedRow) {', branchStart);
  const body = src.slice(branchStart, branchEnd);
  const pauses = [];
  const run = new Function(
    'answerQueue', 'norm', 'startAnswer', 'log', 'pause', 'oneLine', 'mission', 'decision',
    `return (async () => {
     const blocked = false;
     const askedRow = { id: "row-9", text: "Выдать B5?", need: "Locale Auditor", gate: true };
     ${body}
     return { reached: "next" };
     })();`,
  );
  const out = await run(
    () => [{ id: 'row-9', text: 'Выдать B5?', need: 'Locale Auditor', gate: true }],
    (x) => String(x || '').trim().toLowerCase(),
    async () => false,
    () => {},
    (reason, ctx) => pauses.push({ reason, ctx }),
    (t) => String(t || ''),
    { id: 'mission-1' },
    { next: 'Warden' },
  );
  assert.equal(pauses.length, 1, 'ровно одна пауза');
  assert.equal(pauses[0].ctx.kind, 'answer-handoff', 'вид паузы назван');
  assert.match(pauses[0].reason, /next «Warden» не применялся/, 'сказано, что next не применялся');
  assert.match(pauses[0].reason, /Адресат «Locale Auditor»/, 'назван адресат вопроса');
  assert.equal(out, true, 'ход завершён паузой — по next он не пошёл');
}

console.log('OK: D-091 — вопрос с gate/need передаёт ход адресату и завершает ход, next в нём не читается');
