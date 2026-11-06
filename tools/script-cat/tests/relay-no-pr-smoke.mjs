// «PR не будет» — законный исход: аудитор/Reviewer/явный null не ждут мерж,
// пропущенный pr по-прежнему забывчивость. Промпт теперь декларативный.
// D-046: явный pr:null + merged:true — противоречие маркера, а не тихое «PR не
// будет»: раньше такой маркер уходил в проверку PR и вставал в Blocked (K-27,
// K-34). У него своя короткая лестница напоминаний, поэтому проверки ниже
// охватывают и legacy-, и неlegacy-профили.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler, dispatchRequest, reminderRequest } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
assertUserscriptVersionContract(src);

// Модули вырезаем одним непрерывным куском: D-046 поставил prNoneValue и
// prMergeConflict вплотную к prDeclined, а наивный срез по первому «};» рвал
// функцию посередине и прятал ошибку (так баг и прошёл в 1.12.10).
const blockFrom = src.indexOf('  const hasMergedClaim = (result) =>');
const blockEndMark = 'prNoneValue(result.pr) && hasMergedClaim(result);';
const blockTo = src.indexOf(blockEndMark, blockFrom);
assert.ok(blockFrom > -1 && blockTo > blockFrom, 'блок разбора pr/merged найден');
// Срез кончается на полном объявлении prMergeConflict — ничего не достраиваем.
const block = src.slice(blockFrom, blockTo + blockEndMark.length);
const { prDeclined: declined, prMergeConflict: conflict, prNoneValue: noneValue } = new Function(
  `let ACTIVE_PROFILE = { legacy: false };\n${block}\nreturn { prDeclined, prMergeConflict, prNoneValue };`,
)();

// 1. Разбор заявки «PR не будет» — поведение прежнее.
assert.equal(declined({ pr: null }), true);
assert.equal(declined({ pr: 'none' }), true);
assert.equal(declined({ pr: '-' }), true);
assert.equal(declined({ pr: 'Нет' }), true);
assert.equal(declined({}), false, 'пропущенный pr — забывчивость');
assert.equal(declined({ pr: 37 }), false);
assert.equal(declined(null), false);
assert.equal(noneValue(null), true, 'явный null — заявка, а не забывчивость');
assert.equal(noneValue('null'), true);
assert.equal(noneValue('https://github.com/Creative36711/synapse/pull/17'), false);
assert.equal(noneValue(''), false, 'пустая строка — не заявка');

// 2. D-046: «pr:null + merged:true» — противоречие маркера, а не законный
//    исход. Ловится в обоих профилях, потому что merged-ссылка важна всегда.
const dispatchId = '4106f0cf-5705-8130-8e38-ed7aec06c27a';
const k34 = {
  dispatch_id: dispatchId,
  run_id: '2fca06ef-6485-4c76-a103-545e135e245e',
  status: 'submitted',
  check: 0,
  pr: null,
  merged: true,
};
assert.equal(conflict(k34), true, 'дословный маркер K-34 распознан как противоречие');
assert.equal(conflict({ ...k34, pr: 'none' }), true, '"none" + merged:true — тоже противоречие');
assert.equal(conflict({ ...k34, pr: '', merged: true }), false, 'пустой pr — забывчивость, её держит projectPrBoundary');
assert.equal(conflict({ ...k34, pr: 'https://github.com/Creative36711/synapse/pull/17' }), false);
assert.equal(conflict({ ...k34, merged: false }), false, 'merged:false законен');
assert.equal(conflict({ pr: null }), false, 'без заявки о мерже противоречия нет');
assert.equal(conflict({ merged: true }), false, 'пропущенный pr не маскируется: его ловит projectPrBoundary');
assert.equal(conflict(null), false);

// 3. Инвариант не ослаблен: такой маркер всё ещё не проходит проверку PR —
//    напоминание ведёт к исправлению маркера, а не к пропуску сверки repo/base.
assert.match(src, /function projectPrBoundary\(/, 'проверка repo/base на месте');
// Проверка repo/base не тронута D-046: для «PR нет, но слит» она по-прежнему
// требует номер, поэтому маркер не может проскочить без сверки.
assert.match(
  src,
  /!ACTIVE_PROFILE\.legacy && hasMergedClaim\(result\)\s*\n\s*\? "В маркере нет номера PR для проверки репозитория и базовой ветки\."/,
  'projectPrBoundary всё ещё требует номер PR при заявке о мерже',
);
assert.match(
  src,
  /if \(role\.fn !== "Auditor" && role\.fn !== "Reviewer" && prMergeConflict\(result\)\) \{\s*\n\s*return markerMissing\(role, expect, "CF_AGENT_RESULT", manual, "pr-claim"\);\s*\n\s*\}/,
  'противоречие уходит в напоминание, а не в Blocked',
);
// Напоминание не должно создавать журнал и не должно менять карточку: до Drive
// и Notion дело не доходит — ветка стоит перед запросом карточки.
const conflictAt = src.indexOf('prMergeConflict(result))');
const cardReadAt = src.indexOf('const page = await notion("GET"', conflictAt);
const blockedAt = src.indexOf('PR этой выдачи не подтверждён', conflictAt);
assert.ok(conflictAt > -1 && cardReadAt > conflictAt, 'напоминание стоит до чтения карточки');
assert.ok(blockedAt > conflictAt, 'Blocked достижим только после лестницы напоминаний');

// 4. Аудитор/Reviewer/без PR не доходят до ожидания мержа.
assert.match(src, /const noPr = role\.fn === "Auditor" \|\| role\.fn === "Reviewer" \|\| prDeclined\(result\);/);
assert.match(src, /const merged = noPr \? "none" : await ensureMerged\(page, result\);/);
assert.equal((src.match(/create\.click\(\)/g) || []).length, 1);
assert.equal((src.match(/merge\.click\(\)/g) || []).length, 1);

// 5. Промпт больше не учит противоречию: шаблон не подставляет merged:true
//    рядом с «PR может быть null», а правило связывает два поля.
const exec = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(exec, /Нет изменений — "pr":null/, 'без изменений PR не нужен');
assert.match(exec, /"pr":"<URL\|null>","merged":false/, 'шаблон маркера не подсказывает merged:true');
assert.ok(
  !/"pr":"<URL\|null>","merged":true/.test(exec),
  'D-046: шаблон не содержит пары «pr может быть null» + merged:true',
);
assert.match(exec, /без PR pr:null,merged:false/, 'правило связывает pr и merged');
assert.match(exec, /merged:true только после мержа/, 'условие для merged:true названо');
const audit = PromptCompiler.compile(dispatchRequest('Auditor')).text;
assert.ok(!/gh pr merge/.test(audit), 'аудитору мерж не предлагается');
assert.ok(!audit.includes('"pr"'), 'аудиторский маркер без pr');

// 6. Напоминание объясняет противоречие и не требует переделывать работу.
const reminder = PromptCompiler.compile(
  reminderRequest('Executor', 'CF_AGENT_RESULT', {
    reminder: { attempt: 1, max: 2, why: 'pr-claim', markerName: 'CF_AGENT_RESULT' },
  }),
).text;
assert.match(reminder, /Техническое напоминание \(1 из 2/, 'напоминание собрано как напоминание, а не как новое задание');
assert.match(reminder, /"pr":null и "merged":true разом — так нельзя/, 'напоминание называет противоречие');
assert.match(reminder, /Изменений не было — "pr":null,"merged":false/, 'напоминание показывает законный вариант');
assert.match(reminder, /Поправь только маркер/, 'работу не заставляют переделывать');
// Бюджет напоминания не поднят: ветка обязана влезать в тот же лимит, иначе
// вместо лечения противоречия цикл получит budget_exceeded.
for (const [fn, mk] of [['Executor', 'CF_AGENT_RESULT'], ['Auditor', 'CF_AGENT_RESULT'],
  ['Reviewer', 'CF_ANSWER_RESULT'], ['Coordinator', 'CF_COORDINATOR_RESULT']]) {
  const budget = PromptCompiler.compile(
    reminderRequest(fn, mk, { reminder: { attempt: 1, max: 2, why: 'pr-claim', markerName: mk } }),
  );
  assert.equal(budget.ok, true, `напоминание pr-claim для ${fn} влезает в бюджет: ${budget.error?.message || ''}`);
}

// 7. Аудит не ослаблен: отчёт обязателен.
assert.match(src, /if \(answer\.body < C\.minAnswerChars\) \{/);

console.log('OK: no-pr — работа без PR не ждёт мерж, противоречие pr:null+merged:true лечится напоминанием');
