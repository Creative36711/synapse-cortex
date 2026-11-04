// Git-безопасность в декларативном промпте: опасные исторические команды не
// становятся приказом; чужие изменения и закреплённая ветка защищены.
import assert from 'node:assert/strict';
import { PromptCompiler, dispatchRequest } from '../tests/helpers/prompt-env.mjs';

const prompt = PromptCompiler.compile(dispatchRequest('Executor', { role: { fn: 'Executor', name: 'Kernel', zone: 'game/**' } })).text;

// Опасные команды не выдаются как исполняемые.
assert.doesNotMatch(prompt, /^\s*git reset --hard origin\/main/m, 'reset --hard не приказ');
assert.doesNotMatch(prompt, /^\s*git switch -c nar\//m, 'смена закреплённой ветки не приказ');
assert.doesNotMatch(prompt, /--delete-branch/, 'закреплённая ветка не удаляется');

// Защита чужих изменений и общей истории.
assert.match(prompt, /чужое не трогай\/не сбрасывай/, 'чужие изменения защищены');
assert.match(prompt, /Закреплённую ветку не меняй/, 'ветка сессии закреплена');
assert.match(prompt, /merge-base HEAD origin\/main/, 'общая история проверяется');
assert.match(prompt, /is-shallow-repository/, 'shallow не доказывает разрыв');
assert.match(prompt, /Direct push в main запрещён/, 'прямой пуш в base запрещён');
assert.match(prompt, /gh pr merge <N> --squash/, 'мерж командой без удаления ветки');
assert.match(prompt, /CF_AGENT_RESULT/, 'маркер на месте');

// Аудитор не получает мерж/сброс.
const audit = PromptCompiler.compile(dispatchRequest('Auditor')).text;
assert.doesNotMatch(audit, /gh pr merge|git reset --hard/);

console.log('OK: git-безопасность — чужие изменения и закреплённая ветка защищены, опасные команды не приказ');
