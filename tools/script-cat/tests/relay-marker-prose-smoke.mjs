// Проба J-3 (D-100): проза в ответе не делает маркер шаблоном.
//
// 10.11, 09:47. Warden ответил настоящим CF_ANSWER_RESULT, но в прозе `answer`
// цитировал наше же правило: «FIXED <что именно исправлено и в какой сборке>».
// Разбор искал `<…>` в любом строковом поле, находил подпись в прозе и объявлял
// **весь маркер** шаблоном из задания. Два напоминания, пауза marker, разбор не
// состоялся — при полностью готовом ответе.
//
// Что проверяется:
//   • боевой маркер принимается, и цитата шаблона в прозе ему не мешает;
//   • шаблоны из наших промптов по-прежнему отклоняются (включая `<dispatch>` в ID);
//   • `<уточнить>` — живое значение, а не заглушка;
//   • поля-списки (`verdict`, `status`) шаблоном не бывают по своей природе;
//   • причина отказа в журнале называется прежним словом `placeholder`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const src = readFileSync(`${root}/tools/script-cat/src/13-arena-messages.js`, "utf8");
// Берём участок от разбора JSON до конца parseMarker: заглушки живут между
// ними, и грузить их в одиночку нельзя — им нужны braceJson/markerJson.
const from = src.indexOf("  function braceJson(rest) {");
const to = src.indexOf("  /** Короткая подпись элемента для журнала");
assert.ok(from > 0 && to > from, "разбор маркера на месте");
const { parseMarker, isPlaceholderMarker } = new Function(
  `${src.slice(from, to)}\nreturn { parseMarker, isPlaceholderMarker };`,
)();

const ANSWER = "CF_ANSWER_RESULT";

test("боевой случай 09:47: проза с цитатой шаблона — не шаблон", () => {
  // Текст восстановлен из паузы marker 4146f0cf-5705-81cd-8464-f1fa3aa32a7e.
  const answer =
    "Решение D-099 (cortex main 0) — это дефект разбора, а не ответ агента. " +
    "Правило ответа требует первой строкой FIXED <что именно исправлено и в какой сборке> либо NOTFIXED <почему не берёшься>. " +
    "Признак сделанного: D-099 в main (есть), ТЗ 1.9 и очередь 1.9.2 в main (есть), зоны §7 и Scope B2 без изменений (есть).";
  const text = `Отчёт приёмки.\n${ANSWER} ${JSON.stringify({
    question_id: "4146f0cf-5705-81cd-8464-f1fa3aa32a7e",
    turn_id: "e08c84fb-8d22-48a9-85c5-1ed2e81bd220",
    verdict: "answer",
    answer,
  })}`;
  const parsed = parseMarker(text, ANSWER);
  assert.ok(parsed, "маркер с прозой принимается");
  assert.equal(parsed.question_id, "4146f0cf-5705-81cd-8464-f1fa3aa32a7e");
  assert.match(parsed.answer, /FIXED <что именно исправлено/, "проза сохранена целиком");
});

test("короткая цитата шаблона в прозе тоже не отвергает маркер", () => {
  const parsed = parseMarker(
    `${ANSWER} {"question_id":"q1","verdict":"answer","answer":"формат ответа: FIXED <что исправлено>"}`,
    ANSWER,
  );
  assert.ok(parsed, "цитата в прозе — не повод для паузы");
});

test("шаблоны из наших промптов по-прежнему отклоняются", () => {
  const cases = [
    ["координатор, `<роль|done>`", "CF_COORDINATOR_RESULT", { mission_id: "m1", status: "completed", next: "<роль|done>" }],
    ["приёмка, `<на что опирался>`", "CF_REVIEW_RESULT", { mission_id: "m1", verdict: "accept", summary: "<на что опирался>" }],
    ["ответ, `<решение>`", ANSWER, { question_id: "q1", verdict: "answer", answer: "<решение>" }],
    ["ответ, подпись с описанием", ANSWER, { question_id: "q1", verdict: "answer", answer: "<чего именно не хватает: роль, доступ>" }],
    ["сдача карточки, `<путь>`", "CF_AGENT_RESULT", { dispatch_id: "d1", run_id: "r1", status: "submitted", report: "<путь>" }],
  ];
  for (const [label, name, obj] of cases) {
    assert.equal(parseMarker(`отчёт\n${name} ${JSON.stringify(obj)}`, name), null, `отклонён: ${label}`);
  }
});

test("угловая скобка в ID — это пример, как бы ни выглядел внутри", () => {
  for (const id of ["<dispatch>", "<dispatch_id>", "<миссия>"]) {
    const obj = { dispatch_id: id, run_id: "r1", status: "submitted" };
    assert.equal(parseMarker(`CF_AGENT_RESULT ${JSON.stringify(obj)}`, "CF_AGENT_RESULT"), null, `ID-пример отклонён: ${id}`);
  }
});

test("слово без скобок — значение, слово целиком в скобках — подпись", () => {
  // Граница правила: шаблон — это значение, которое ЦЕЛИКОМ в скобках.
  const plain = parseMarker(
    `CF_COORDINATOR_RESULT {"mission_id":"m1","status":"completed","next":"уточнить"}`,
    "CF_COORDINATOR_RESULT",
  );
  assert.equal(plain?.next, "уточнить", "слово без скобок — живое значение");
  const bracketed = parseMarker(
    `CF_COORDINATOR_RESULT {"mission_id":"m1","status":"completed","next":"<уточнить>"}`,
    "CF_COORDINATOR_RESULT",
  );
  assert.equal(bracketed, null, "значение целиком в скобках остаётся подписью — как было до D-100");
});

test("длинная проза в полях данных шаблоном не считается, короткая подпись — считается", () => {
  const long = "x".repeat(80) + " <div> и <b> в тексте";
  assert.equal(isPlaceholderMarker({ answer: long }), false, "абзац с тегами — не пример");
  assert.equal(isPlaceholderMarker({ answer: "<путь>" }), true, "короткая подпись — пример");
  assert.equal(isPlaceholderMarker({ verdict: "<accept|rework>" }), true, "подпись в вердикте ловится");
});

test("причина отказа в журнале называется прежним словом", () => {
  parseMarker('CF_COORDINATOR_RESULT {"mission_id":"m1","next":"<роль|done>"}', "CF_COORDINATOR_RESULT");
  assert.match(src, /markerNotes\[name\] = \{ reason: "placeholder"/, "журнал говорит placeholder");
});
