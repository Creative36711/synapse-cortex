// Проба 1.4.78: повторная работа по той же карточке не уходит в слитую ветку.
//
// 27.10 NAR-4.9 прошла два круга. После первого PR #95 память о мерже
// (`cfn-merged:<карточка>`) осталась стоять, поэтому после второго PR #97
// страница агента уже не проверялась: Continue не нажималась, сессия осталась
// на ветке `arena/73b6f5a4-relay` со статусом `pr_merged`. Следующая выдача
// ушла в мёртвую ветку, агент отказался («не могу, нажмите Continue»), маркера
// не было, цикл встал.
//
// Проверяется:
//   • память о мерже ведётся по выдаче (`карточка:run`), а не по карточке;
//   • перед отправкой из очереди страница проверяется на Continue и она
//     нажимается до вставки текста;
//   • отказ «ветка слита, нажмите Continue» распознаётся по тексту и не
//     путается с обычным отчётом о мерже;
//   • повтор после такого отказа ровно один: дальше пауза, а не цикл.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];
assert.match(src, new RegExp(`@version\\s+${V.replace(/\./g, '\\.')}`), `версия ${V}`);

/** Блок функции по её объявлению: от `function name(` до закрывающей `  }`. */
function block(name) {
  const from = src.indexOf(`function ${name}(`);
  assert.ok(from > 0, `функция ${name} на месте`);
  const to = src.indexOf('\n  }\n', from);
  assert.ok(to > from, `у ${name} есть тело`);
  return src.slice(from, to + '\n  }\n'.length);
}

// ── 1. Память о мерже — на выдачу, а не на карточку ────────────────────────
const ensureMerged = block('ensureMerged');
assert.match(ensureMerged, /const runId = String\(result\.run_id \|\| rt\(task\.properties\?\.\["Run ID"\]\)/, 'run читается из маркера или карточки');
assert.match(ensureMerged, /const key = `\$\{K\.merged\}\$\{task\.id\}:\$\{runId \|\| "run"\}/, 'ключ включает Run ID');
assert.match(ensureMerged, /projectRef \? `:repo-\$\{encodeURIComponent\(projectRef\.repo\)\}:pr-\$\{projectRef\.number\}:base-/, 'ключ новой выдачи включает repo, PR и base branch');
assert.doesNotMatch(ensureMerged, /const key = `\$\{K\.merged\}\$\{task\.id\}`;/, 'старого ключа на карточку нет');

// ── 2. Continue перед отправкой ────────────────────────────────────────────
const fresh = block('ensureFreshBranch');
assert.match(fresh, /let cont = continueButton\(\)/, 'кнопка ищется той же функцией, что и после мержа');
assert.match(fresh, /if \(!cont && mergedFlag\(\)\)[\s\S]{0,300}cont = await waitFor\(\(\) => continueButton\(\)/, 'бейдж есть, кнопка дорисовывается — ждём её, а не шлём в слитую ветку');
assert.match(fresh, /cont\.click\(\)/, 'по Continue кликаем');
assert.match(fresh, /waitFor\(\(\) => !continueButton\(\)/, 'ждём, пока кнопка исчезнет');
assert.match(fresh, /again\.click\(\)/, 'второй клик, если кнопка осталась');
assert.match(fresh, /return continueButton\(\) \? "stuck" : "pressed"/, 'видно, чем кончилось');

const consumeFrom = src.indexOf('async function consumePending(');
const consumeTo = src.indexOf('\n  }\n', src.indexOf('const expect = GM_getValue(K.expect, null);', consumeFrom));
const consume = src.slice(consumeFrom, consumeTo);
const freshCall = consume.indexOf('await ensureFreshBranch(');
const composerCall = consume.indexOf('await ensureComposer()');
assert.ok(freshCall > 0, 'consumePending проверяет Continue');
assert.ok(composerCall > freshCall, 'Continue нажимается до вставки текста и до закрытия плашки');

// ── 3. Отказ из-за слитой ветки ────────────────────────────────────────────
const refusal = new Function(`${block('staleBranchRefusal')}; return staleBranchRefusal;`)();

// Настоящий ответ Архитектора 27.10 (сокращённый, но с теми же словами).
const real = [
  'Не могу выполнить новый прогон `b20a92da-0010-4ec5-96bf-7aebf45f709f` на ветке',
  '`arena/73b6f5a4-relay`: её статус — `pr_merged`.',
  'Нажмите **Continue** рядом со статусом PR, если кнопка доступна: она начнёт чистую',
  'ветку от последней базовой версии.',
].join('\n');
assert.equal(refusal(real), true, 'отказ Архитектора распознан');

assert.equal(
  refusal('Не могу начать: ветка уже merged. Нажмите Continue.'),
  true,
  'английское «merged» и русский отказ',
);
assert.equal(
  refusal('PR #97 слит, ветка arena/73b6f5a4-relay, Continue больше не нужна.'),
  false,
  'обычный отчёт о мерже без отказа — не повод повторять выдачу',
);
assert.equal(refusal('Не могу, Continue.'), false, 'без слова о ветке и мерже — не наш случай');
assert.equal(refusal(''), false, 'пустой текст');
assert.equal(refusal('Готово. PR #97 слит. Ветка записана.'), false, 'отчёт без отказа');

// ── 4. Повтор один ────────────────────────────────────────────────────────
const retry = block('retryStaleBranchHandoff');
assert.match(retry, /const done = Number\(expect\.branchResend\) \|\| 0;/, 'счётчик повторов');
assert.match(retry, /if \(done >= 1\) return false;/, 'второго повтора нет');
assert.match(retry, /GM_setValue\(K\.deadSend, mine \? nodeId\(mine\) : ""\)/, 'своя реплика помечена — повтор уйдёт, а не «уже отправлено»');
assert.match(retry, /branchResend: done \+ 1/, 'счётчик растёт');
assert.doesNotMatch(retry, /rollbackProps|Dispatch State/, 'карточку не откатываем: работа по ней не начиналась');
assert.match(retry, /branchResend: done \+ 1,\s*\n\s*tries: 0,/, 'счётчик попыток ответа начинается заново');

// ── 5. Где вызывается ─────────────────────────────────────────────────────
assert.match(
  src,
  /if \(\s*lastReply &&\s*!stillWorking\(\) &&\s*staleBranchRefusal\(lastReply\.raw\) &&\s*retryStaleBranchHandoff\(expect\)\s*\)/s,
  'submitExecutor распознаёт отказ до «нет маркера»',
);
assert.match(src, /retryStaleBranchHandoff\(expect\)[\s\S]{0,400}await consumePending\(true\)/, 'после повтора задание отправляется сразу');

console.log('relay-fresh-branch-smoke: OK');
