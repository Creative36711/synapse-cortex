// Ядро provisioning: кандидаты, админ-право, маркер одобрения, лимиты, журнал.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', '31-provision-core.js'), 'utf8');
const UUID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();

function loadCore(cfg = {}) {
  const store = new Map();
  const GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  const GM_setValue = (k, v) => store.set(k, v);
  let seq = 100;
  const defaults = {
    agentProvisionEnabled: true, agentProvisionMode: 'manual', agentProvisionRepoAllowlist: ['owner/repo'],
    agentBootstrapPrompt: 'Что изображено на картинке test.jpg в репозитории https://github.com/owner/test?',
    agentProvisionMaxJobs: 3, agentProvisionDailyMax: 5, agentBootstrapWaitMs: 600000,
    agentUrlWaitMs: 30000, agentRenameAttempts: 3, agentProvisionAutoActivate: true, agentProvisionArchiveOld: true,
  };
  const C = { ...defaults, ...cfg };
  const K = { provision: 'provision', provisionRequest: 'request', provisionLock: 'lock' };
  const api = new Function('GM_getValue', 'GM_setValue', 'C', 'K', 'uid', 'nowIso', 'norm', 'dbg', 'normalizeProvisionConfig', 'sessionStorage',
    `${source}\nreturn { normalizeProvisionRepo, provisionBootstrapClean, provisionCandidateFromRow, provisionCandidates, provisionAdminRole, validateProvisionMarker, provisionState, saveProvisionState, provisionEvent, provisionDailyAllow, provisionDailyConsume, provisionNewJob, provisionSaveJob, provisionActiveJob, saveProvisionRequest, provisionRequestState, PROVISION_EVENTS, PROVISION_STATES };`)(
    GM_getValue, GM_setValue, C, K, () => UUID(++seq), () => '2026-11-04T00:00:00.000Z', norm, () => {}, (p) => ({ ...defaults, ...p }), { getItem: () => 'tab', setItem: () => {} });
  return { api, store, C };
}
const row = (over = {}) => ({
  id: UUID(1), pageId: UUID(1), name: 'Executor Core', fn: 'Executor', status: 'Ждёт',
  url: '', repo: 'owner/repo', agentAdmin: false, agentState: 'запрошен', ...over,
});
const admin = (over = {}) => row({ id: UUID(2), pageId: UUID(2), name: 'Admin', fn: 'Coordinator', status: 'Активна', url: 'https://arena.ai/agent/' + UUID(2), agentAdmin: true, agentState: 'не требуется', ...over });

test('repo нормализуется в точный owner/repo', () => {
  const { api } = loadCore();
  assert.equal(api.normalizeProvisionRepo('https://github.com/Owner/Repo.git'), 'owner/repo');
  assert.equal(api.normalizeProvisionRepo(' owner/repo/ '), 'owner/repo');
  assert.equal(api.normalizeProvisionRepo('owner/repo/extra'), '');
  assert.equal(api.normalizeProvisionRepo('owner/../repo'), '');
});

test('bootstrap-пробник не содержит внутренних токенов', () => {
  const { api } = loadCore();
  assert.ok(api.provisionBootstrapClean('Что изображено на картинке test.jpg в репозитории https://github.com/owner/test?'));
  for (const bad of ['', 'CF_AGENT_RESULT', 'Notion page', 'cortex', 'REGULATION', 'WARDEN', 'DECISIONS', 'ghp_abcdef123456', 'https://app.notion.so/x']) {
    assert.equal(api.provisionBootstrapClean(bad), false, bad);
  }
});

test('create/replace кандидаты и отказы', () => {
  const { api, C } = loadCore();
  const create = api.provisionCandidateFromRow(row(), C);
  assert.ok(create.ok); assert.equal(create.candidate.action, 'create');
  const replace = api.provisionCandidateFromRow(row({ url: 'https://arena.ai/agent/' + UUID(9) }), C);
  assert.ok(replace.ok); assert.equal(replace.candidate.action, 'replace');
  assert.equal(replace.candidate.oldAgentUrl, 'https://arena.ai/agent/' + UUID(9));
  assert.equal(api.provisionCandidateFromRow(row({ agentState: 'не требуется', url: 'https://arena.ai/agent/' + UUID(9) }), C).ok, false);
  assert.equal(api.provisionCandidateFromRow(row({ agentAdmin: true }), C).ok, false);
  assert.equal(api.provisionCandidateFromRow(row({ fn: 'Master' }), C).ok, false);
  assert.equal(api.provisionCandidateFromRow(row({ repo: 'other/repo' }), C).ok, false);
  assert.equal(api.provisionCandidateFromRow(row(), C, { names: new Set([norm('Executor Core')]) }).ok, false);
});

test('админ выбирается по флагу, предпочтительно Coordinator', () => {
  const { api } = loadCore();
  const reviewer = admin({ fn: 'Reviewer', name: 'Rev', id: UUID(3), pageId: UUID(3), url: 'https://arena.ai/agent/' + UUID(3) });
  assert.equal(api.provisionAdminRole([reviewer]), reviewer);
  const coord = admin();
  assert.equal(api.provisionAdminRole([reviewer, coord]), coord);
  assert.equal(api.provisionAdminRole([admin({ status: 'Ждёт' })]), null);
  assert.equal(api.provisionAdminRole([row({ name: 'Coordinator' })]), null, 'имя без флага не даёт права');
});

test('маркер одобрения: request_id, кандидаты, свежая строка, запрет команд', () => {
  const { api, C } = loadCore();
  const request = { requestId: UUID(50), candidates: [api.provisionCandidateFromRow(row(), C).candidate] };
  const fresh = [row(), admin()];
  assert.ok(api.validateProvisionMarker({ request_id: UUID(50), jobs: [] }, request, fresh, C).ok);
  const good = api.validateProvisionMarker({ request_id: UUID(50), jobs: [{ role_page_id: UUID(1), role_name: 'Executor Core', repo: 'owner/repo', action: 'create' }] }, request, fresh, C);
  assert.ok(good.ok); assert.equal(good.jobs.length, 1);
  assert.equal(api.validateProvisionMarker({ request_id: UUID(51), jobs: [] }, request, fresh, C).ok, false);
  assert.equal(api.validateProvisionMarker({ request_id: UUID(50), jobs: [{ role_page_id: UUID(99), role_name: 'X', repo: 'owner/repo', action: 'create' }] }, request, fresh, C).ok, false);
  assert.equal(api.validateProvisionMarker({ request_id: UUID(50), jobs: [{ role_page_id: UUID(1), role_name: 'Executor Core', repo: 'other/repo', action: 'create' }] }, request, fresh, C).ok, false);
  assert.equal(api.validateProvisionMarker({ request_id: UUID(50), jobs: [{ role_page_id: UUID(2), role_name: 'Admin', repo: 'owner/repo', action: 'create' }] }, request, fresh, C).ok, false);
  assert.equal(api.validateProvisionMarker({ request_id: UUID(50), jobs: [], archive: true }, request, fresh, C).ok, false);
  const many = { request_id: UUID(50), jobs: Array.from({ length: 4 }, () => ({ role_page_id: UUID(1), role_name: 'Executor Core', repo: 'owner/repo', action: 'create' })) };
  assert.equal(api.validateProvisionMarker(many, request, fresh, C).ok, false);
});

test('суточный лимит и журнал без секретов', () => {
  const { api } = loadCore({ agentProvisionDailyMax: 1 });
  assert.ok(api.provisionDailyAllow());
  api.provisionDailyConsume();
  assert.equal(api.provisionDailyAllow(), false);
  api.provisionEvent('provision_request_sent', { requestId: UUID(50), jobId: UUID(60), rolePageId: UUID(1), repo: 'owner/repo', step: 'awaiting', reason: 'ok' });
  const state = api.provisionState();
  assert.equal(state.journal.length, 1);
  assert.equal(state.journal[0].event, 'provision_request_sent');
  assert.ok(api.PROVISION_EVENTS.length === 17);
  assert.ok(api.PROVISION_STATES.includes('url_captured'));
});

test('job персистится и восстанавливается по requestId', () => {
  const { api, C } = loadCore();
  const candidate = api.provisionCandidateFromRow(row(), C).candidate;
  const job = api.provisionNewJob(candidate, UUID(50));
  api.provisionSaveJob(job);
  api.saveProvisionRequest({ requestId: UUID(50), jobIds: [job.id], state: 'approved' });
  assert.equal(api.provisionActiveJob().id, job.id);
  const updated = api.provisionSaveJob({ ...job, state: 'url_captured', agentUrl: 'https://arena.ai/agent/' + UUID(7) });
  assert.equal(api.provisionActiveJob().state, 'url_captured');
  assert.equal(updated.agentUrl, 'https://arena.ai/agent/' + UUID(7));
});
