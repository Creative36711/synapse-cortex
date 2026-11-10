// D-096 (1.14.25): ход приёмки закрывается нажатой Continue, а не руками Мастера.
//
// Боевой случай 10.11, 10:31. Вопрос был закрыт Warden'ом, ход вернулся
// Координатору — и Continue на странице приёмки осталась не нажатой. В журнале
// об этом не было ни строки. Мастер нажал её сам; без этого Warden остаётся на
// слитой ветке и в той же сессии следующий PR слить не сможет.
//
// Механизм промаха: Continue нажималась только в двух местах — `finishMerge`
// (конец хода исполнителя) и `ensureFreshBranch` (перед отправкой из очереди).
// Ход приёмки не проходит ни одного из них: он заканчивается переходом на
// Координатора, то есть вне отправки.
//
// Проба фиксирует:
//   1) у приёмки есть свой конец хода, и он нажимает Continue;
//   2) этот конец хода вызывают все три пути приёмки — ответ на вопрос, приёмка
//      миссии (принята / возвращена / просит Мастера) и разбор петли;
//   3) клик делается до объявления результата и до перехода, иначе Мастер или
//      следующий ход уходят раньше, чем сессия стала рабочей;
//   4) отказ Continue не молчит: не принялась — строка в журнале с предупреждением.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const read = (file) => readFileSync(join(srcDir, file), 'utf8');
const pr = read('19-pull-requests.js');
const answers = read('27-review-answers.js');
const review = read('26-review.js');
const arbiter = read('26b-arbiter.js');

// ── 1. Конец хода приёмки существует и нажимает Continue ────────────────────
const from = pr.indexOf('async function finishReviewerTurn');
assert.ok(from > 0, 'у хода приёмки есть свой конец');
const body = pr.slice(from, pr.indexOf('\n  }\n', from));
assert.match(body, /continueButton\(\)/, 'кнопка ищется той же функцией, что у исполнителя');
assert.match(body, /await ensureFreshBranch\(why\)/, 'клик и проверка исчезновения — общим путём, а не вторым самодельным');
assert.match(body, /patience\(C\.continueWaitMs\)/, 'после мержа кнопка дорисовывается — ждём её, как везде');
assert.match(body, /done === "stuck"/, 'отказ различается');
assert.match(body, /Continue на странице приёмки не принялась/, 'отказ не молчит: без этого случая разбор начинается с нуля');
assert.match(body, /continueButton\(\) \? true : Boolean/, 'сначала быстрая проверка: нет кнопки — нет лишних пяти секунд');

// ── 2. Три пути приёмки вызывают этот конец хода ────────────────────────────
assert.match(answers, /finishReviewerTurn\("вопрос закрыт приёмкой"\)/, 'ответ на вопрос закрывает ход приёмки');
assert.match(review, /finishReviewerTurn\("миссия принята"\)/, 'принятая миссия закрывает ход приёмки');
assert.match(review, /finishReviewerTurn\("приёмка просит Мастера"\)/, 'остановка тоже не оставляет сессию слитой');
assert.match(arbiter, /finishReviewerTurn\("петля разобрана"\)/, 'разбор петли закрывает ход приёмки');

// ── 3. Порядок: Continue до результата и до перехода ───────────────────────
{
  const i = answers.indexOf('finishReviewerTurn("вопрос закрыт приёмкой")');
  const plan = answers.indexOf('await requestPlan(mission, coord, queue, note', i);
  assert.ok(i > 0 && plan > i, 'Continue нажимается до запроса плана, а не после');
  const j = review.indexOf('finishReviewerTurn("миссия принята")');
  const patch = review.indexOf('await patch(mission.id, {', j);
  assert.ok(j > 0 && patch > j, 'Continue нажимается до записи «Завершена»');
}

// ── 4. Ни одного «пустого» вызова: ошибка Continue не съедает ход ──────────
for (const [file, pattern] of [
  ['27-review-answers.js', /finishReviewerTurn\("вопрос закрыт приёмкой"\)\.catch/],
  ['26-review.js', /finishReviewerTurn\("миссия принята"\)\.catch/],
  ['26b-arbiter.js', /finishReviewerTurn\("петля разобрана"\)\.catch/],
]) {
  const text = read(file);
  assert.match(text, pattern, `${file}: сбой Continue не отменяет закрытие хода`);
}

// ── 5. Ход исполнителя не переделан: Continue по-прежнему в finishMerge ────
{
  const merge = pr.slice(pr.indexOf('async function finishMerge'));
  assert.match(merge.slice(0, 900), /await waitFor\(continueButton/, 'finishMerge ищет Continue сам, как раньше');
  assert.match(pr, /async function ensureFreshBranch/, 'проверка перед отправкой осталась');
}

console.log('OK: relay-reviewer-continue — D-096: ход приёмки закрывается нажатой Continue до возврата хода, отказ виден в журнале');
