// Проба J-4 (D-103): причина повтора называется правильно, а занятый номер
// решения чинится подстановкой, а не остановкой хода.
//
// 10.11 три живых случая:
//   • Arena дважды отклонила сообщение («Something went wrong»), транспорт
//     повторил его текстом «Продолжи ответ на вопрос после лимита инструментов».
//     Лимита не было — Warden получил неверную причину;
//   • приёмка назвала занятый номер D-099, и ход встал на паузу, хотя ответ был
//     верный и нужен был только свободный номер;
//   • пауза, которую снимает сам транспорт, всё равно подавалась как человеческая.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptCompiler, answerRequest, dispatchRequest } from "./helpers/prompt-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");
const src = (name) => readFileSync(`${root}/tools/script-cat/src/${name}`, "utf8");

test("повтор после ошибки Arena не выдаёт себя за лимит инструментов", () => {
  const retry = PromptCompiler.compile({
    ...answerRequest(),
    delivery: { tier: "compact", attempt: 1, reason: "retry" },
  });
  assert.ok(retry.ok, "повтор собирается");
  assert.match(retry.text, /повтор того же вопроса/, "названа настоящая причина");
  assert.doesNotMatch(retry.text, /после лимита инструментов/, "лимита инструментов в повторе нет");
});

test("настоящий лимит инструментов говорит о лимите", () => {
  const limit = PromptCompiler.compile(answerRequest({ delivery: { tier: "tool_limit", attempt: 1 } }));
  assert.ok(limit.ok, "продолжение после лимита собирается");
  assert.match(limit.text, /после лимита инструментов/, "прежнее поведение сохранено");
});

test("повтор выдачи исполнителю тоже называет причину", () => {
  // minimalPrompt собирает повтор не полным профилем карточки, а `delivery.compact`:
  // у повтора другой вид хода (`kind: "retry"`), те же ID и короткий текст.
  const base = dispatchRequest("Executor");
  const retry = PromptCompiler.compile({
    kind: "retry", profileId: "delivery.compact",
    role: base.role, task: base.task, mission: base.mission,
    delivery: { tier: "compact", attempt: 1, reason: "retry" },
  });
  assert.ok(retry.ok, "повтор выдачи собирается");
  assert.match(retry.text, /повтор той же выдачи/, "причина названа");
  assert.doesNotMatch(retry.text, /лимита инструментов/, "лимита инструментов в повторе нет");
});

test("минимальный повтор передаёт причину, а не вид хода", () => {
  const missing = src("14-missing-marker.js");
  const retries = missing.match(/reason: "retry"/g) || [];
  assert.ok(retries.length >= 4, `все виды хода помечают причину повтора (найдено ${retries.length})`);
});

test("перед отправкой пауза ставится ровно одна и только после второго отказа", () => {
  // Ответ Мастера на вопрос «пауза на транспорте два раза»: паузы перед отправкой
  // в коде две ветки, и обе стоят ПОСЛЕ исчерпания повторов. Первый отказ Arena
  // паузы не даёт — он уходит минимальным сообщением (см. пробу arena-swallow).
  const errors = src("15-visible-errors.js");
  const tried = errors.indexOf("const tried = Number(expect?.arenaResend) || 0;");
  const pauseAt = errors.indexOf("Arena второй раз не приняла задание", tried);
  assert.ok(tried > 0 && pauseAt > tried, "пауза выдачи стоит только после второго отказа");
  const miss = src("14-missing-marker.js");
  const resend = miss.indexOf("if (count < C.maxReloadAttempts) {");
  const stop = miss.indexOf("повторился ${C.maxReloadAttempts} раз", resend);
  assert.ok(resend > 0 && stop > resend, "перезагрузки кончаются раньше паузы");
  // Вторая пауза того же инцидента не поднимается: D-102 и D-094 держат одну.
  const panel = src("06-pause-panel.js");
  assert.match(panel, /const sameIncident =/, "одна поломка — одна пауза");
});

test("занятый номер решения заменяется свободным, ответ не отбрасывается", () => {
  const adr = src("25-legacy-adr.js");
  const from = adr.indexOf("  const DECISION_LOOKBEHIND");
  const to = adr.indexOf("  /**\n   * Вопрос приёмке по предложению из репозитория.");
  assert.ok(from > 0 && to > from, "разбор номеров на месте");
  const { decisionNumberConflict, renumberDecisionAnswer, decisionClaim } =
    new Function(`${adr.slice(from, to)}\nreturn { decisionNumberConflict, renumberDecisionAnswer, decisionClaim };`)();
  const taken = ["D-098", "D-099", "D-100", "D-101", "D-102"];
  const reply = "Решение D-099 — это дефект разбора, а не ответ агента. D-099 в main есть.";
  assert.equal(decisionClaim(reply).includes("D-099"), true, "заявка распознана");
  assert.match(decisionNumberConflict(reply, taken), /D-099/, "конфликт виден");
  const fixed = renumberDecisionAnswer(reply, taken);
  assert.equal(fixed.replaced.length, 1, "заменён один номер");
  assert.equal(fixed.replaced[0].to, "D-103", "свободный номер — следующий за последним занятым");
  assert.match(fixed.text, /D-103 — это дефект разбора/, "номер в заявке заменён");
  assert.match(fixed.text, /D-103 вместо D-099/, "замена названа в тексте");
  assert.match(fixed.text, /Суть решения от этого не меняется/, "смысл ответа сохранён");
});

test("пересказ занятых номеров по-прежнему не считается заявкой", () => {
  const adr = src("25-legacy-adr.js");
  const from = adr.indexOf("  const DECISION_LOOKBEHIND");
  const to = adr.indexOf("  /**\n   * Вопрос приёмке по предложению из репозитория.");
  const { decisionNumberConflict } = new Function(`${adr.slice(from, to)}\nreturn { decisionNumberConflict };`)();
  const taken = ["D-098", "D-099", "D-100"];
  const retell = "В объявлении Warden было «свободны D-098 и D-099», сейчас оба заняты. " +
    "Заняты D-098, D-099, D-100. Свободен следующий.";
  assert.equal(decisionNumberConflict(retell, taken), "", "пересказ состояния не останавливает ход");
});
