// Prompt provisioning: admin.provision, бюджет ≤1800, forbidden-блоки,
// единый маркер в registry и переносимость (без проектных имён в коде).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PromptCompiler, PROMPT_MARKER_REGISTRY, UUID } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const candidates = [{ rolePageId: UUID.dispatch, roleName: 'Executor Core', fn: 'Executor', repo: 'owner/repo', action: 'create' }];
const request = (fn = 'Coordinator') => ({
  kind: 'provision', role: { fn, name: fn === 'Coordinator' ? 'Coord' : 'Rev' },
  provision: { requestId: UUID.run, candidates, maxJobs: 3 }, delivery: { tier: 'full' },
});

test('admin.provision компилируется для Coordinator/Reviewer и держит overhead ≤1800', () => {
  for (const fn of ['Coordinator', 'Reviewer']) {
    const r = PromptCompiler.compile(request(fn));
    assert.ok(r.ok, r.error?.message);
    assert.equal(r.profileId, 'admin.provision');
    assert.equal(r.marker, 'CF_AGENT_PROVISION_RESULT');
    assert.ok(r.metrics.overheadChars <= 1800, `overhead ${r.metrics.overheadChars}`);
    assert.match(r.text.trim().split('\n').at(-1), /^CF_AGENT_PROVISION_RESULT \{/);
    assert.ok(r.text.includes(UUID.run));
    assert.ok(r.text.includes('Executor Core'));
    assert.ok(r.text.includes('create'));
  }
});

test('в admin.provision нет mission/queue/git/pilot/обычных marker-блоков', () => {
  const r = PromptCompiler.compile(request());
  const forbidden = ['identity.task', 'identity.mission', 'queue.snapshot', 'queue.coordinator', 'git.executor', 'git.auditor',
    'task.intent', 'task.invariants', 'task.acceptance', 'review.evidence', 'answer.question', 'pilot.brief', 'pilot.repo',
    'marker.agent', 'marker.coordinator', 'marker.review', 'marker.answer', 'reminder.marker'];
  for (const b of forbidden) assert.ok(!r.blocks.includes(b), b);
  assert.ok(!/CF_AGENT_RESULT|CF_COORDINATOR_RESULT|CF_REVIEW_RESULT|CF_ANSWER_RESULT/.test(r.text));
});

test('provisioning не выдаётся неадмин-функции и требует candidates/requestId', () => {
  const notAdmin = PromptCompiler.compile(request('Executor'));
  assert.equal(notAdmin.ok, false, 'Executor не получает admin.provision');
  assert.equal(PromptCompiler.compile({ kind: 'provision', role: { fn: 'Coordinator' }, provision: { requestId: UUID.run, candidates: [] } }).error.code, 'missing_fact');
  assert.equal(PROMPT_MARKER_REGISTRY.forKind('provision'), 'CF_AGENT_PROVISION_RESULT');
  assert.deepEqual(PROMPT_MARKER_REGISTRY.idFields('CF_AGENT_PROVISION_RESULT'), ['request_id']);
});

test('код provisioning не содержит проектных имён и named-role привилегий', () => {
  for (const f of ['31-provision-core.js', '32-provision-dom.js', '33-provision-flow.js', '34-provision-ui.js']) {
    const text = readFileSync(join(srcDir, f), 'utf8');
    assert.ok(!/creative36711|synapse/i.test(text), `${f}: проектное имя`);
    assert.ok(!/norm\(["']Warden|===\s*["']Warden|name\s*===\s*["']Coordinator["']/i.test(text), `${f}: named-role привилегия`);
  }
  const profiles = readFileSync(join(srcDir, '02-profiles-core.js'), 'utf8');
  assert.match(profiles, /agentBootstrapPrompt:\s*""/, 'bootstrap по умолчанию пуст');
  assert.match(profiles, /agentProvisionEnabled:\s*false/, 'provisioning выключен по умолчанию');
});
