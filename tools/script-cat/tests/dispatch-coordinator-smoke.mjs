// Migration of the old dispatch-coordinator contract to the active
// _tools/ScriptCat/relay.user.js + Gateway 1.5. Do not resurrect
// dispatch.user.js: these assertions exercise the current implementation.
// Companion tests in this same 72-file suite retain the current equivalents
// of the old send-control, message-freshness, Coordinator, role, and handoff
// cases. Notion, Arena, and Drive are local models in these tests, not live checks.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const testDir = new URL('.', import.meta.url);
const userScriptUrl = new URL('../relay.user.js', import.meta.url);
const legacyDispatchUrl = new URL('../dispatch.user.js', import.meta.url);
assert.equal(existsSync(legacyDispatchUrl), false, 'legacy dispatch.user.js stays absent');
const source = readFileSync(userScriptUrl, 'utf8');
assert.match(source, /^\/\/ ==UserScript==/m, 'the active userscript has a ScriptCat header');
const version = source.match(/^\/\/ @version\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
assert.ok(version, 'the active userscript declares an x.y.z version');
assert.match(source, /^\/\/ @match\s+https:\/\/arena\.ai\/\*/m, 'the active script is bound to Arena');

const tests = readdirSync(testDir).filter((name) => name.endsWith('.mjs'));
assert.equal(tests.length, 89, '83 prior suites, D-046 pr-claim, D-049 arbiter, D-054 run-id typo, D-055 review-turn orphan, D-056 unbound-binding and D-067 marker-ladder suites remain in the suite');
for (const added of ['prompts-smoke.mjs', 'delivery-smoke.mjs', 'pilot-smoke.mjs', 'docs-smoke.mjs']) {
  assert.ok(tests.includes(added), `${added} suite present`);
}
const currentContractCompanions = [
  'relay-auto-run-smoke.mjs',
  'relay-send-safety-smoke.mjs',
  'relay-send-truth-smoke.mjs',
  'relay-send-repeat-smoke.mjs',
  'relay-send-confirm-smoke.mjs',
  'relay-answer-parse-smoke.mjs',
  'relay-reply-boundary-smoke.mjs',
  'relay-coordinator-turn-smoke.mjs',
  'relay-coordinator-marker-smoke.mjs',
  'relay-marker-ladder-smoke.mjs',
  'relay-coordinator-authority-smoke.mjs',
  'relay-marker-id-smoke.mjs',
  'relay-roles-cache-smoke.mjs',
  'relay-review-dispatch-integration.mjs',
  'relay-poll-gateway-integration.mjs',
  'drive-gateway-arena-smoke.mjs',
  'scriptcat-gateway-smoke.mjs',
  'relay-portability-guard-smoke.mjs',
  'relay-delivery-receipt-smoke.mjs',
  'relay-run-id-typo-smoke.mjs',
  'relay-review-turn-orphan-smoke.mjs',
  'relay-unbound-binding-smoke.mjs',
];
for (const name of currentContractCompanions) {
  assert.ok(tests.includes(name), `${name} preserves a current-contract companion scenario`);
}

const objectSource = (name) => {
  const start = source.indexOf(`  const ${name} = {`);
  const end = source.indexOf('\n  };', start);
  assert.ok(start >= 0 && end > start, `${name} configuration exists`);
  return source.slice(start, end + '\n  };'.length);
};
const config = new Function(`${objectSource('C')}\nreturn C;`)();
const keys = new Function(`${objectSource('K')}\nreturn K;`)();

const helperLines = ['const norm =', 'const rt =', 'const sel =', 'const taskState ='];
const runtimeHelpers = helperLines.map((prefix) => {
  const line = source.split('\n').find((candidate) => candidate.trimStart().startsWith(prefix));
  assert.ok(line, `production helper exists: ${prefix}`);
  return line;
}).join('\n');

const dispatchStart = source.indexOf('  function dispatchGuard(page, expect, role) {');
const dispatchEnd = source.indexOf('\n  async function submitExecutor(', dispatchStart);
assert.ok(dispatchStart > 0 && dispatchEnd > dispatchStart, 'dispatchGuard is present');
const dispatchGuard = new Function(
  `${runtimeHelpers}\n${source.slice(source.indexOf("  const isUuid ="), source.indexOf("  /**", source.indexOf("  const isUuid =")))}\n${source.slice(dispatchStart, dispatchEnd)}\nreturn dispatchGuard;`,
)();
const CARD_ID = '4096f0cf-5705-8159-bd88-c725d5ea075d';
const MISSION_ID = '4086f0cf-5705-81ea-94c6-e47bd6c3ba78';
const RUN_ID = '57b20404-787e-476e-96d6-b6548f27a3df';
const OTHER_RUN_ID = '09238d7a-4791-4ff0-ba7b-9bc29e493061';
const AGENT_ID = '01a18b9c-0c8b-71fd-8696-eb881e2e5217';
const OTHER_AGENT_ID = '01a18b9c-0c8b-71fd-8696-eb881e2e5218';
const isUuidStart = source.indexOf('  const isUuid = (value) =>');
const isUuidEnd = source.indexOf('  /**', isUuidStart);
assert.ok(isUuidStart > 0 && isUuidEnd > isUuidStart, 'production UUID validator exists');
const isUuid = new Function(`${source.slice(isUuidStart, isUuidEnd)}\nreturn isUuid;`)();
for (const [name, value] of Object.entries({ CARD_ID, MISSION_ID, RUN_ID, OTHER_RUN_ID, AGENT_ID, OTHER_AGENT_ID })) {
  assert.equal(isUuid(value), true, `${name} is a valid production UUID`);
}

const text = (value) => ({ rich_text: [{ plain_text: value }] });
const dispatchPage = ({ state = 'Running', runId = RUN_ID, owner = AGENT_ID } = {}) => ({
  properties: {
    'Dispatch State': { select: { name: state } },
    'Run ID': text(runId),
    'Mission ID': text(MISSION_ID),
    'Recipient Agent ID': text(owner),
  },
});
const executor = { id: AGENT_ID, fn: 'Executor' };
const expected = { dispatchId: CARD_ID, missionId: MISSION_ID, runId: RUN_ID, roleId: AGENT_ID };

// Live-run guard: accept only the current Running dispatch, expected Run ID,
// and intended recipient; every stale/missing/misdirected case remains red.
assert.equal(dispatchGuard(dispatchPage(), expected, executor), '', 'matching live run is eligible');
assert.equal(dispatchGuard(dispatchPage({ state: 'Ready' }), expected, executor), 'карточка уже не Running');
assert.equal(dispatchGuard(dispatchPage({ state: 'Submitted' }), expected, executor), 'карточка уже не Running');
assert.match(dispatchGuard(dispatchPage({ runId: '' }), expected, executor), /Run ID/);
assert.match(dispatchGuard(dispatchPage(), { ...expected, runId: '' }, executor), /Run ID/);
assert.match(dispatchGuard(dispatchPage({ runId: OTHER_RUN_ID }), expected, executor), /Run ID/);
assert.match(dispatchGuard(dispatchPage(), { ...expected, roleId: OTHER_AGENT_ID }, executor), /другому агенту/);
assert.match(dispatchGuard(dispatchPage({ owner: OTHER_AGENT_ID }), expected, executor), /другому агенту/);
assert.match(
  dispatchGuard(dispatchPage({ owner: '' }), expected, { ...executor, fn: 'Reviewer' }),
  /не указан адресат/,
);

// Role identity is derived from the configured Arena URL, not a duplicate
// field that could become stale or disagree with the target page.
const agentStart = source.indexOf('  function agentIdFromUrl(url) {');
const agentEnd = source.indexOf('\n  }\n', agentStart) + '\n  }'.length;
assert.ok(agentStart > 0 && agentEnd > agentStart, 'agentIdFromUrl is present');
const agentIdFromUrl = new Function(`${source.slice(agentStart, agentEnd)}\nreturn agentIdFromUrl;`)();
assert.equal(agentIdFromUrl('https://arena.ai/agent/agent-7?tab=chat'), 'agent-7');
assert.equal(agentIdFromUrl('https://arena.ai/agent/agent-7/'), 'agent-7');
assert.equal(agentIdFromUrl('https://arena.ai/'), '', 'invalid role URL has no guessed identity');

// Current bounded Arena-rejection recovery replaces the removed AUTO contract.
// Exercise the production limits and writes, not obsolete AUTO.maxSends names.
const retryStart = source.indexOf('  function retryRejectedHandoff(expect, alert, why) {');
const retryEnd = source.indexOf('\n  /**', retryStart);
assert.ok(retryStart > 0 && retryEnd > retryStart, 'retryRejectedHandoff is present');
const retryFn = new Function(
  'C', 'Date', 'minimalPrompt', 'GM_setValue', 'K', 'log', 'forgetDeliveryReceipt',
  `${source.slice(retryStart, retryEnd)}\nreturn retryRejectedHandoff;`,
);
const now = 1_000_000;
const clock = { now: () => now };
const state = new Map();
const logs = [];
const set = (key, value) => state.set(key, value);
const retry = retryFn(config, clock, () => ({ text: 'Прочитай актуальную карточку.' }), set, keys, (message) => logs.push(message), () => {});
const sent = {
  kind: 'dispatch', dispatchId: CARD_ID, runId: RUN_ID,
  roleId: AGENT_ID, roleName: 'Builder', roleUrl: `https://arena.ai/agent/${AGENT_ID}`,
  sentAt: now - 1_000, arenaResend: 0, text: 'original long task',
};
assert.equal(retry(sent, { messageId: 'dead-message-1', text: 'Something went wrong' }, 'HTTP 500'), true);
assert.equal(state.get(keys.deadSend), 'dead-message-1', 'rejected message is marked dead before retry');
assert.deepEqual(state.get(keys.pending), {
  roleId: AGENT_ID, roleName: 'Builder', roleUrl: `https://arena.ai/agent/${AGENT_ID}`,
  text: 'Прочитай актуальную карточку.', at: now, sendTries: 0,
});
assert.equal(state.get(keys.expect).arenaResend, 1, 'exactly one short retry is recorded');
assert.equal(state.get(keys.expect).sentAt, null, 'delivery evidence is cleared before resend');
assert.equal(state.get(keys.expect).verified, false, 'resend is not treated as delivered');
assert.match(logs.join('\n'), /Второй отказ подряд — пауза/);

for (const stale of [
  { ...sent, arenaResend: config.arenaResendMax },
  { ...sent, sentAt: now - config.arenaRetryMs - 1 },
  { ...sent, roleId: '' },
  { ...sent, sentAt: null },
]) {
  const untouched = new Map();
  const shouldNotRetry = retryFn(config, clock, () => 'no resend', (key, value) => untouched.set(key, value), keys, () => {});
  assert.equal(shouldNotRetry(stale, { messageId: 'old-or-invalid' }, 'error'), false, 'stale or exhausted handoff is not resent');
  assert.equal(untouched.size, 0, 'rejected retry leaves queue and expectation unchanged');
}

// The Coordinator emits a mission/turn result marker; its current companion
// test executes the full turn and the marker-missing/recovery tests stay active.
const coordinatorStart = source.indexOf('  function coordinatorPrompt(');
assert.ok(coordinatorStart > 0, 'coordinatorPrompt is present');
const { PromptCompiler, planRequest, UUID } = await import('./helpers/prompt-env.mjs');
const coordinator = PromptCompiler.compile(planRequest()).text;
assert.ok(coordinator.includes(UUID.mission) && coordinator.includes(UUID.turn), 'marker carries current mission and turn identities');
assert.match(coordinator, /mission_id и turn_id копируй из этого промпта/);
assert.doesNotMatch(coordinator, /campaign_id/, 'obsolete campaign-based identity is not used');

console.log(`OK: relay ${version} — current dispatch/run guard, one bounded retry, URL identity, no legacy userscript`);
