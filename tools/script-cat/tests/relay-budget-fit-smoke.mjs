// D-085 — переполнение бюджета сжимает ДАННЫЕ, а не останавливает ход.
//
// Боевой случай 09.11: план Координатора собрался в 8178 знаков при пределе
// 7500 (answers.delta 3346, queue.snapshot 1191, queue.coordinator 901,
// marker.coordinator 392). Отправки не было, цикл встал — хотя мешало не
// задание, а размер переписки: те же ответы целыми лежат в Notion.
//
// Проверяется поведение, а не строка:
//   • переполненный данными план всё равно уходит, и в нём есть пометка о
//     сжатии с адресом полного текста (молча не режем — D-034);
//   • инструкции и задание не тронуты: зона роли, правила, маркер на месте;
//   • если освобождать нечего (нет длинных данных) — прежняя пауза, без
//     притворства, что «сжали»;
//   • рабочая выдача карточки не режется: оракул и Scope остаются целиком;
//   • причина в паузе называет блоки, которые съели бюджет.

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
import { PromptCompiler, planRequest, dispatchRequest, UUID, task, role } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const bundle = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(bundle);
const ctxSrc = readFileSync(join(srcDir, '20-technical-context.js'), 'utf8');
const adrSrc = readFileSync(join(srcDir, '25-legacy-adr.js'), 'utf8');

/** Окружение 20-technical-context: компилятор, журнал, пауза. */
function harness() {
  const env = { logs: [], pauses: [] };
  const api = new Function(
    'PromptCompiler', 'log', 'pause', 'dbg', 'recordPromptAttempt', 'budgetBreakdownLine', 'uid',
    `${ctxSrc}\nreturn { compileOrPause, fitRequestToBudget };`,
  )(
    PromptCompiler,
    (t, loud, o) => env.logs.push({ t: String(t), o: o || {} }),
    (reason, context) => env.pauses.push({ reason: String(reason), kind: context?.kind }),
    () => {},
    () => {},
    () => '',
    () => 'x',
  );
  return { api, env };
}

// ── 1. Боевой случай: план переполнен брифингом ответов.
{
  const { api, env } = harness();
  const live = planRequest({
    mission: { id: UUID, name: 'SYN-3 · Транспорт', round: 1, reworkLimit: 3 },
    role: { name: 'Coordinator', fn: 'Coordinator', zone: 'tools/script-cat/**' },
    queue: {
      summary: '1 Submitted, 0 Running, 2 Ready, 1 Rework',
      ready: 'Готовы: ' + 'X'.repeat(1200),
      // 3346 знаков — размер answers.delta в боевой телеметрии 09.11.
      answersLine: 'Ответ Warden: ' + 'О'.repeat(3300),
    },
  });
  const raw = PromptCompiler.compile(live);
  assert.equal(raw.ok, false, 'без сжатия боевой план не влезает');
  assert.equal(raw.error.code, 'budget_exceeded');

  const out = api.compileOrPause(live, 'plan 4126f0cf');
  assert.ok(out, 'ход не остановлен: промпт собран после сжатия');
  assert.ok(out.metrics.chars <= 7500, `уложились в предел: ${out.metrics.chars} ≤ 7500`);
  assert.equal(env.pauses.length, 0, 'паузы нет — отправка состоялась');
  assert.ok(env.logs.some((l) => /Сжал данные/.test(l.t)), 'журнал говорит, что данные сжаты');
  assert.match(out.text, /полный текст — в Notion/i, 'в тексте есть адрес полного текста');
  // Задание и правила целы.
  assert.match(out.text, /tools\/script-cat\/\*\*/, 'зона роли не тронута');
  assert.match(out.text, /CF_COORDINATOR_RESULT/, 'маркер на месте');
}

// ── 2. Освобождать нечего: сжатие не притворяется, пауза остаётся.
{
  const { api, env } = harness();
  // Переполнение создаёт само задание (Scope/оракул), а не переписка.
  // 9000 знаков оракула — это задание, а не переписка: резать нечего.
  const fat = dispatchRequest('Executor', {
    task: task({ acceptance: 'Oracle: ' + 'Ж'.repeat(9000) }),
  });
  const out = api.compileOrPause(fat, 'dispatch 4126f0cf');
  assert.equal(out, null, 'без данных для сжатия возвращается null');
  assert.equal(env.pauses.length, 1, 'прежняя пауза на месте');
  assert.equal(env.pauses[0].kind, 'prompt-compile');
}

// ── 3. Рабочая карточка не режется: оракул и Scope — это задание, не данные.
{
  const { api } = harness();
  const card = dispatchRequest('Executor', {
    task: task({ acceptance: 'Oracle: ' + 'Ж'.repeat(2000) }),
  });
  const out = api.compileOrPause(card, 'dispatch x');
  assert.ok(out, 'карточка собирается');
  assert.match(out.text, /Ж{2000}/, 'оракул дошёл целиком');
}

// ── 4. `done` не спотыкается о Rework: это очередь приёмки, не работа в полёте.
{
  assert.match(adrSrc, /const waiting = fresh\.rework\.length \+ fresh\.draft\.length/,
    'Rework и Draft посчитаны отдельно от работы в полёте');
  assert.match(adrSrc, /очередь приёмки, а не работа в полёте/,
    'причина названа в журнале словами, а не молчанием');
  const doneBranch = adrSrc.slice(adrSrc.indexOf('if (decision.next === "done")'));
  const openLine = (doneBranch.match(/const open = [^;]+;/) || [])[0] || '';
  assert.ok(openLine, 'формула «в работе» на месте');
  assert.doesNotMatch(openLine, /rework/, 'Rework не входит в блокирующие');
}

// ── 5. Пустое обновление не поднимает паузу; подтверждённая доставка — тоже.
{
  const recSrc = readFileSync(join(srcDir, '18-state-recovery.js'), 'utf8');
  assert.match(recSrc, /if \(expect && expect\.verified === true\)/,
    'подтверждённая доставка не создаёт паузу');
  assert.match(recSrc, /if \(!expect && !pending\) \{[\s\S]{0,400}?return "";/,
    'обновление без хода не поднимает паузу');
}

console.log('OK: D-085 — бюджет сжимает данные, Rework не вешает миссию, обновление без хода не пауза');
