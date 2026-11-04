// Технический контекст теперь декларативный: состав зависит от роли и профиля,
// а не от ручного техблока. Проверяем разделение полномочий по ролям.
import { strict as assert } from 'node:assert';
import { PromptCompiler, dispatchRequest, planRequest, reviewRequest } from './helpers/prompt-env.mjs';

const exec = PromptCompiler.compile(dispatchRequest('Executor', { role: { name: 'Kernel', fn: 'Executor', zone: 'game/**' } })).text;
const audit = PromptCompiler.compile(dispatchRequest('Auditor', { role: { name: 'Runtime Auditor', fn: 'Auditor' } })).text;
const coord = PromptCompiler.compile(planRequest()).text;
const rev = PromptCompiler.compile(reviewRequest()).text;

// Executor: git-ритуал и мерж самому, репозиторий назван.
assert.match(exec, /Kernel/);
assert.match(exec, /merge-base HEAD origin\/main/);
assert.match(exec, /gh pr merge <N> --squash/);
assert.match(exec, /Creative36711\/synapse/);
assert.match(exec, /PR без общей истории удалит чужие файлы/);

// Auditor: только чтение, без мержа и без сброса дерева.
assert.match(audit, /Аудитор: только чтение/);
assert.match(audit, /истина — origin\/main/);
assert.match(audit, /show origin\/main:<путь>/);
assert.ok(!/git reset --hard/.test(audit));
assert.ok(!/gh pr merge/.test(audit));

// Coordinator: без git вообще.
assert.ok(!/git fetch|git merge-base|git reset|git switch/.test(coord));
assert.ok(!/gh pr /.test(coord));
assert.match(coord, /Notion/);

// Reviewer: не правит код/карточки.
assert.match(rev, /Ничего не правь|не правь/);

// Другой проект: его репозиторий и base, без старого снимка.
const other = PromptCompiler.compile(dispatchRequest('Executor', { target: { repo: 'team/synapse', baseBranch: 'release/next' } })).text;
assert.match(other, /team\/synapse/);
assert.match(other, /origin\/release\/next/);
assert.doesNotMatch(other, /origin\/main/);

// Без «кнопочного» мусора.
for (const t of [exec, audit, coord, rev]) assert.doesNotMatch(t, /кнопк|Continue|интерфейс/i);

console.log('OK: tech-info — Executor ритуал main, Auditor только читает, Coordinator без git, Reviewer без правок');
