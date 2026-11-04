// Тексты задания: без «кнопочного» мусора, мерж командой, карточка и есть
// задание. Журнал попытки (taskLogEntry) сохраняет задание и маркер записи.
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler, dispatchRequest, planRequest, task, role } from './helpers/prompt-env.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const FORBIDDEN = /кнопк|Continue|интерфейс/i;

// 1. Промпты ролей без кнопок и Continue.
for (const req of [dispatchRequest('Executor'), dispatchRequest('Auditor'), planRequest()]) {
  const r = PromptCompiler.compile(req);
  assert.doesNotMatch(r.text, FORBIDDEN, `${r.profileId}: без кнопок`);
}

// 2. Мерж требуется, но командой; аудитор не мержит.
const exec = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(exec, /gh pr merge <N> --squash/);
const audit = PromptCompiler.compile(dispatchRequest('Auditor')).text;
assert.ok(!/gh pr merge/.test(audit));

// 3. assignmentBody / taskLogEntry: карточка и есть задание, маркер записи.
const aFrom = src.indexOf('  function assignmentBody(');
const aTo = src.indexOf('  const taskFacts =');
assert.ok(aFrom > 0 && aTo > aFrom);
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const { assignmentBody, taskLogEntry } = new Function('rt', 'taskTitle', 'nowIso',
  `${src.slice(aFrom, aTo)}\nreturn { assignmentBody, taskLogEntry };`)(
  rt, (t) => (t.properties['Запрос']?.title || []).map((x) => x.plain_text).join(''), () => '2026-11-04T00:00:00.000Z');
const card = { id: 'd1', properties: { 'Запрос': { title: [{ plain_text: 'SYN-1.1' }] }, 'Намерение': rt ? { rich_text: [{ plain_text: 'цель' }] } : {} } };
assert.match(assignmentBody(card, ''), /карточка и есть задание/);
assert.match(assignmentBody(card, 'большое задание'), /большое задание/);
const log = taskLogEntry(card, role('Executor'), '', 'r1');
assert.match(log, /<!-- CF_DISPATCH d1:r1:task -->/);
assert.match(log, /dispatch: `d1`/);

// 4. Исполнитель получает задание (verbatim) и маркер последней строкой.
const r = PromptCompiler.compile(dispatchRequest('Executor', { task: task({ payload: 'Сделай X.' }) }));
assert.ok(r.text.includes('Сделай X.'));
assert.match(r.text.trim().split('\n').at(-1), /^CF_AGENT_RESULT \{/);

console.log('OK: prompt — без кнопок, мерж командой, карточка=задание, журнал с маркером');
