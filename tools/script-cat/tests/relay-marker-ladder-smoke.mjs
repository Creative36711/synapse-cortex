// Проба D-067: маркер читается по лестнице, идентичность при этом не слабеет.
//
// 07.11.2026, 16:56. Координатор миссии SYN-3 ответил по делу, но последняя
// строка ответа была JSON-ом без имени маркера:
//   {"next":"Contract Architect","question":{"id":"SYN3-ADR-V2-FRAMES-0",…}}
// Разбор искал только литерал `CF_COORDINATOR_RESULT`. Маркера «нет» — и цикл
// дважды попросил «не хватило последней строки с CF_COORDINATOR_RESULT», а на
// третий раз встал на паузу 17:01:24 при полностью информативном ответе. Агент
// повторял ровно тот же хвост: напоминание не называло дефект, а ответ был
// верным по смыслу.
//
// Здесь проверяется:
//   1) живой ответ 16:56 принимается (ступень 3 — JSON без имени);
//   2) имя в другом написании (`cf-coordinator-result`, `CF COORDINATOR RESULT`)
//      и «почти JSON» (одинарные кавычки, висячая запятая) тоже принимаются;
//   3) строгие ступени не потеряны: точное имя по-прежнему первым, последнее
//      вхождение важнее предыдущего;
//   4) шаблоны из наших же промптов (`<роль|done>`, `<путь>`) не засчитываются;
//   5) чужой JSON не подставляется под ожидание (сдача ≠ вердикт ≠ арбитраж);
//   6) пустой ответ и ответ без JSON — по-прежнему «маркера нет»;
//   7) дефект называется точно (`no-name`), и напоминание просит имя, а не
//      «последнюю строку», и при этом влезает в бюджет 700/900, а не поднимает
//      его;
//   8) замок идентичности не ослаблен: чужой JSON с нашими ID проверяется
//      дальше по коду — ID сверяет вызывающий, а не разбор.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler } from './helpers/prompt-env.mjs';
import { reminderRequest } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── Срез разбора: те же границы, что в docs-smoke и relay-answer-parse ──────
const from = src.indexOf('  function braceJson(');
const to = src.indexOf('  /** Короткая подпись элемента для журнала');
assert.ok(from > 0 && to > from, 'разбор маркеров на месте');
const api = new Function(`${src.slice(from, to)}\nreturn { parseMarker, markerRejectReason, markerRejectHint, markerNotes };`)();
const { parseMarker, markerRejectReason, markerRejectHint } = api;

const COORD = 'CF_COORDINATOR_RESULT';
const AGENT = 'CF_AGENT_RESULT';
const REVIEW = 'CF_REVIEW_RESULT';
const ARBITER = 'CF_ARBITER_RESULT';

// ── 1. Живой ответ 16:56 ───────────────────────────────────────────────────
const live = [
  'Ход 44c6ba5a — итог.',
  '',
  'Очередь после хода: 1 Submitted, 1 Ready, черновики S-13…S-16.',
  'ADR готов: default — вариант A (V-2 на N ∈ {60,120,1}).',
  '',
  '{"next":"Contract Architect","question":{"id":"SYN3-ADR-V2-FRAMES-0","topic":"V-2","default":"A"}}',
].join('\n');
const liveParsed = parseMarker(live, COORD);
assert.ok(liveParsed, 'ответ 16:56 принимается: JSON без имени маркера');
assert.equal(liveParsed.next, 'Contract Architect', 'next прочитан');
assert.equal(liveParsed.question.id, 'SYN3-ADR-V2-FRAMES-0', 'вопрос прочитан');
assert.equal(markerRejectReason(COORD), 'no-name', 'дефект назван: нет имени маркера');
assert.equal(parseMarker(live, AGENT), null, 'тот же текст не считается сдачей карточки');

// Вложенный question не должен подменять собой решение: разбор берёт внешний
// объект, а не последнюю скобку.
assert.equal(parseMarker('Отчёт.\n{"question":{"id":"q1","default":"A"}}', COORD), null,
  'JSON без next не решение Координатора');

// ── 2. Имя в другом написании и «почти JSON» ───────────────────────────────
for (const [label, text] of [
  ['нижний регистр через дефис', 'Готово.\ncf-coordinator-result {"mission_id":"m1","turn_id":"t1","next":"Kernel"}'],
  ['пробелы вместо подчёркиваний', 'Готово.\nCF COORDINATOR RESULT {"mission_id":"m1","next":"Kernel"}'],
  ['одинарные кавычки', "Готово.\nCF_COORDINATOR_RESULT {'mission_id':'m1','next':'Kernel'}"],
  ['висячая запятая', 'Готово.\nCF_COORDINATOR_RESULT {"mission_id":"m1","next":"Kernel",}'],
  ['типографские кавычки', 'Готово.\nCF_COORDINATOR_RESULT {“mission_id”:“m1”,“next”:“Kernel”}'],
]) {
  const parsed = parseMarker(text, COORD);
  assert.ok(parsed, `принимается: ${label}`);
  assert.equal(parsed.next, 'Kernel', `next прочитан: ${label}`);
}

// Имя названо (пусть и иначе) — это ответ агента, даже если в объекте нет
// «подписи»: пустые поля разберёт вызывающий (next пустой — пауза), а
// подменять ответ чужой догадкой нельзя.
const named = parseMarker('Готово.\ncf-coordinator-result {"mission_id":"m1","note":"жду ответа"}', COORD);
assert.equal(named?.mission_id, 'm1', 'названный маркер принимается и без подписи в объекте');
assert.equal(parseMarker('Готово.\n{"mission_id":"m1","note":"жду ответа"}', COORD), null,
  'JSON без имени и без подписи ответом не считается');

// ── 3. Строгие ступени не потеряны ─────────────────────────────────────────
const strictParsed = parseMarker('Отчёт.\nCF_COORDINATOR_RESULT {"mission_id":"m1","next":"Kernel"}', COORD);
assert.ok(strictParsed, 'ступень 1 работает');
assert.equal(markerRejectReason(COORD), '', 'на строгом чтении дефект не выдумывается');
assert.equal(
  parseMarker('CF_COORDINATOR_RESULT {"next":"Старый"}\nCF_COORDINATOR_RESULT {"next":"Новый"}', COORD).next,
  'Новый',
  'последнее вхождение важнее предыдущего',
);

// ── 4. Шаблоны из наших промптов не засчитываются ──────────────────────────
for (const [label, value] of [
  ['роль-заглушка', '<роль|done>'],
  ['путь', '<путь>'],
  ['описание по-русски', '<чего именно не хватает>'],
]) {
  const text = `CF_COORDINATOR_RESULT {"mission_id":"m1","next":"${value}"}`;
  assert.equal(parseMarker(text, COORD), null, `шаблон отклонён: ${label}`);
  assert.equal(markerRejectReason(COORD), 'placeholder', `шаблон назван шаблоном: ${label}`);
}
assert.equal(
  parseMarker('Отчёт.\n{"next":"<роль|done>","question":{"id":"q1"}}', COORD),
  null,
  'JSON без имени, но с заглушкой, тоже не ответ',
);
// Пример из промпта целиком (строка, которую транспорт сам и присылает).
assert.equal(
  parseMarker('Наш шаблон: CF_COORDINATOR_RESULT {"mission_id":"<миссия>","turn_id":"<id>","status":"completed","next":"<роль|done>"}', COORD),
  null,
  'пример из промпта не считается ответом',
);

// ── 5. Чужой JSON не подставляется ─────────────────────────────────────────
const agentBody = '{"dispatch_id":"d1","run_id":"r1","status":"submitted","pr":null}';
assert.ok(parseMarker(`Сдал.\n${agentBody}`, AGENT), 'сдача карточки без имени принимается');
assert.equal(parseMarker(`Сдал.\n${agentBody}`, REVIEW), null, 'сдача не подменяет вердикт');
assert.equal(markerRejectReason(REVIEW), 'foreign-json', 'чужой JSON назван чужим');
assert.ok(markerRejectHint(REVIEW).includes(AGENT), 'в журнале назван владелец JSON');

const verdictBody = '{"mission_id":"m1","dispatch_id":"d1","run_id":"r1","verdict":"rework","remarks":"пункт 1"}';
assert.ok(parseMarker(`Проверка.\n${verdictBody}`, REVIEW), 'вердикт без имени принимается');
assert.equal(parseMarker(`Проверка.\n${verdictBody}`, AGENT), null, 'вердикт не считается сдачей работы');

// Объект с вердиктом и статусом карточки — это не «сдача работы»: где
// вердикт, там приёмка или арбитраж, и угадывать не надо — пусть придёт имя.
assert.equal(parseMarker('Итог.\n{"dispatch_id":"d1","run_id":"r1","status":"submitted","verdict":"accept"}', AGENT),
  null, 'вердикт в объекте не делает его сдачей работы');

const arbiterBody = '{"dispatch_id":"d1","verdict":"resolve","action":"ready","reason":"причина"}';
assert.ok(parseMarker(`Арбитраж.\n${arbiterBody}`, ARBITER), 'арбитраж без имени принимается');
assert.equal(parseMarker(`Арбитраж.\n${arbiterBody}`, REVIEW), null, 'арбитраж не подменяет вердикт приёмки');

// Свой маркер, но с чужими ID: разбор пропускает, а сверку ID делает
// вызывающий (sameMission/markerMissing) — здесь проверяем, что разбор не
// выдумывает ID от себя.
const foreignIds = parseMarker('Итог.\n{"next":"Kernel","mission_id":"deadbeef-0000-4000-8000-000000000000"}', COORD);
assert.equal(foreignIds.mission_id, 'deadbeef-0000-4000-8000-000000000000', 'ID из ответа не подменяются');
assert.match(src, /const sameMission = !decision\.mission_id/, 'сверка миссии по-прежнему в коде Координатора');
assert.match(src, /return markerMissing\(role, expect, "CF_COORDINATOR_RESULT", manual\)/,
  'ответ без решения по-прежнему идёт в лестницу напоминаний');
assert.match(src, /if \(!sameMission\) \{/, 'чужая миссия по-прежнему пауза');

// ── 6. Пустой ответ и ответ без JSON ───────────────────────────────────────
assert.equal(parseMarker('', COORD), null, 'пустой ответ — нет маркера');
assert.equal(parseMarker('Только текст, JSON не приложил.', COORD), null, 'текст без JSON — нет маркера');
assert.equal(markerRejectReason(COORD), '', 'дефект не выдумывается, когда JSON нет вовсе');
assert.equal(
  parseMarker('Маркер: {"next":"Kernel","note":"6<7, порог не достигнут"}', COORD)?.next,
  'Kernel',
  'живой текст со знаком «меньше» не отвергается как шаблон',
);

// ── 7. Напоминание называет дефект и не поднимает бюджет ───────────────────
assert.match(src, /reminder: \{ markerName, attempt, max: C\.markerReminders, why: defect \}/,
  'напоминание несёт причину');
assert.match(src, /typeof markerRejectReason === "function" \? markerRejectReason\(markerName\) : ""/,
  'причина берётся у разбора, а не сочиняется');
assert.match(src, /defect === "no-name"[\s\S]{0,200}?JSON решения без имени/,
  'сообщение транспорта называет дефект: JSON без имени');
// D-084: исчерпание напоминаний больше не зовёт Мастера. Пауза называет дефект
// словами разбора — этот текст уходит брифом Transport Maintainer'у.
assert.match(src, /markerDefectHint\(why, defect, markerName\)/,
  'пауза называет, чего именно не хватило в ответе');
assert.match(src, /JSON решения есть, а имени \$\{markerName\} в ответе нет/,
  'дефект «JSON без имени» назван для разбора');
assert.ok(!/Нужен Мастер: проверьте страницу агента/.test(src.slice(src.indexOf('async function markerMissing('),
  src.indexOf('// ───────────────────────── ошибка на экране'))),
  'после исчерпания напоминаний Мастер не вызывается');

// Бюджеты живут в пробе конструктора промптов: здесь важно, что ветка
// «нет имени» не требует их поднять.
const budgetProbe = readFileSync(new URL('./prompts-smoke.mjs', import.meta.url), 'utf8');
assert.match(budgetProbe, /'reminder\.marker': 700/, 'бюджет overhead не поднят');
assert.match(budgetProbe, /'reminder\.marker': 900/, 'общий бюджет напоминания не поднят');

for (const [fn, markerName] of [
  ['Executor', AGENT],
  ['Coordinator', COORD],
  ['Reviewer', 'CF_ANSWER_RESULT'],
  ['Auditor', AGENT],
]) {
  const r = PromptCompiler.compile(
    reminderRequest(fn, markerName, { reminder: { markerName, attempt: 2, max: 2, why: 'no-name' } }),
  );
  assert.ok(r.ok, `напоминание ${fn} с причиной no-name собирается без поднятия бюджета`);
  assert.match(r.text, new RegExp(`${markerName}`), `напоминание ${fn} называет маркер`);
  assert.match(r.text, /нет имени/, `напоминание ${fn} просит имя`);
  assert.ok(!/последней строки/.test(r.text), `напоминание ${fn} не просит «последнюю строку»`);
}

// ── 8. Ступень 3 не подменяет ожидание целиком ─────────────────────────────
// Координатор просит решение: JSON с чужим набором ключей решением не станет.
assert.equal(parseMarker('Итог.\n{"jobs":["a"],"request_id":"r1"}', COORD), null,
  'заявка на роли не считается решением Координатора');
assert.equal(parseMarker('Итог.\n{"answer":"да","question_id":"q1"}', COORD), null,
  'ответ на вопрос не считается решением Координатора');

console.log('OK: relay 1.12.18 — маркер читается по лестнице (точное имя → другое написание → JSON без имени → почти JSON), '
  + 'шаблоны и чужие JSON по-прежнему не засчитываются, идентичность сверяет вызывающий');
