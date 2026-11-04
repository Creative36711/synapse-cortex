// «PR не будет» — законный исход: аудитор/Reviewer/явный null не ждут мерж,
// пропущенный pr по-прежнему забывчивость. Промпт теперь декларативный.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler, dispatchRequest } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
assertUserscriptVersionContract(src);

// 1. Разбор заявки «PR не будет» (код не менялся).
const from = src.indexOf('  const prDeclined = (result) => {');
const to = src.indexOf('  };', from) + 4;
const { prDeclined } = new Function(`${src.slice(from, to)}\nreturn { prDeclined };`)();
assert.equal(prDeclined({ pr: null }), true);
assert.equal(prDeclined({ pr: 'none' }), true);
assert.equal(prDeclined({ pr: '-' }), true);
assert.equal(prDeclined({ pr: 'Нет' }), true);
assert.equal(prDeclined({}), false, 'пропущенный pr — забывчивость');
assert.equal(prDeclined({ pr: 37 }), false);
assert.equal(prDeclined(null), false);

// 2. Аудитор/Reviewer/без PR не доходят до ожидания мержа.
assert.match(src, /const noPr = role\.fn === "Auditor" \|\| role\.fn === "Reviewer" \|\| prDeclined\(result\);/);
assert.match(src, /const merged = noPr \? "none" : await ensureMerged\(page, result\);/);
assert.equal((src.match(/create\.click\(\)/g) || []).length, 1);
assert.equal((src.match(/merge\.click\(\)/g) || []).length, 1);

// 3. Декларативный промпт: работа без PR названа законной.
const exec = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(exec, /Нет изменений — "pr":null/, 'без изменений PR не нужен');
assert.match(exec, /"pr":"<URL\|null>","merged":true/, 'шаблон маркера допускает null');
const audit = PromptCompiler.compile(dispatchRequest('Auditor')).text;
assert.ok(!/gh pr merge/.test(audit), 'аудитору мерж не предлагается');
assert.ok(!audit.includes('"pr"'), 'аудиторский маркер без pr');

// 4. Аудит не ослаблен: отчёт обязателен.
assert.match(src, /if \(answer\.body < C\.minAnswerChars\) \{/);

console.log('OK: no-pr — аудит и работа без PR не ждут мерж, пропущенный pr ведёт в Rework');
