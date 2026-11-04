// Поведенческая среда provisioning: исполняет src/31 + src/33 с мок-Notion,
// мок-DOM и мок-транспортом. K.pending/K.expect не должны записываться.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');
const source = ['31-provision-core.js', '33-provision-flow.js'].map((f) => readFileSync(join(srcDir, f), 'utf8')).join('\n');
export const UUID = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
export const ADMIN = UUID(2);
export const CAND = UUID(1);
export const OLD = UUID(9);
export const NEW = UUID(7);
export const OTHER = UUID(8);
const norm = (s) => String(s || '').replace(/-/g, '').toLowerCase();

export function makeWorld({ cfg = {}, mode = 'auto', replace = false } = {}) {
  const store = new Map();
  const session = new Map();
  const GM_getValue = (k, d) => (store.has(k) ? store.get(k) : d);
  const GM_setValue = (k, v) => store.set(k, v);
  let seq = 500;
  const defaults = {
    agentProvisionEnabled: true, agentProvisionMode: mode, agentProvisionRepoAllowlist: ['owner/repo'],
    agentBootstrapPrompt: 'Что изображено на картинке test.jpg в репозитории https://github.com/owner/test?',
    agentProvisionMaxJobs: 3, agentProvisionDailyMax: 5, agentBootstrapWaitMs: 600000,
    agentUrlWaitMs: 30000, agentRenameAttempts: 3, agentProvisionAutoActivate: true, agentProvisionArchiveOld: true,
  };
  const C = { ...defaults, ...cfg, notion: 'token', requests: 'requests-ds' };
  const K = {
    provision: 'provision', provisionRequest: 'request', provisionLock: 'lock',
    pending: 'pending', expect: 'expect', pilotWait: 'pilotWait', paused: 'paused', pause: 'pause', auto: 'auto',
  };
  const pages = new Map();
  const row = (over = {}) => ({
    id: CAND, pageId: CAND, name: 'Executor Core', fn: 'Executor', status: 'Ждёт', url: '', repo: 'owner/repo',
    agentAdmin: false, agentState: 'запрошен', previousAgentUrl: '', ...over,
  });
  pages.set(ADMIN, row({ id: ADMIN, pageId: ADMIN, name: 'Admin Coord', fn: 'Coordinator', status: 'Активна', url: `https://arena.ai/agent/${ADMIN}`, agentAdmin: true, agentState: 'не требуется' }));
  pages.set(UUID(3), row({ id: UUID(3), pageId: UUID(3), name: 'Reviewer', fn: 'Reviewer', status: 'Активна', url: `https://arena.ai/agent/${UUID(3)}`, agentState: 'не требуется' }));
  pages.set(CAND, row(replace ? { url: `https://arena.ai/agent/${OLD}` } : {}));
  const world = {
    store, session, pages, C, K, patches: [], schemaPatches: [], delivers: [], logs: [], pauses: [], archives: [], renames: [], repoSelects: [],
    cards: [], options: [], sidebar: new Map([[OLD, { textContent: 'Old Name' }]]),
    pendingReplies: [], markerObj: null, working: false, renameFails: false, compileFail: false,
    captcha: false, toolLimit: false, visibleError: null, auto: true,
  };
  session.set(K.auto, '1');
  const location = {
    origin: 'https://arena.ai', pathname: '/', search: '', hash: '',
    get href() { return this.origin + this.pathname; },
    assign(url) { const u = new URL(url, this.origin); this.pathname = u.pathname; },
  };
  const agentUuid = (value) => {
    try { const u = new URL(String(value || ''), location.origin); const m = u.pathname.match(/^\/agent\/([0-9a-f-]{36})\/?$/i); return m ? m[1].toLowerCase() : ''; }
    catch { return ''; }
  };
  const applyProps = (id, props) => {
    const page = pages.get(id);
    if (!page) return;
    for (const [key, value] of Object.entries(props)) {
      if (value.url !== undefined) {
        if (key === 'Agent URL') page.url = value.url;
        if (key === 'Previous Agent URL') page.previousAgentUrl = value.url;
      }
      if (value.select?.name !== undefined) {
        if (key === 'Статус') page.status = value.select.name;
        if (key === 'Agent State') page.agentState = value.select.name;
      }
      if (value.rich_text) page.agentJobId = value.rich_text[0]?.text?.content || '';
      if (value.date?.start) page.agentCreatedAt = value.date.start;
    }
  };
  const deps = {
    GM_getValue, GM_setValue, C, K,
    uid: () => UUID(++seq), nowIso: () => '2026-11-04T00:00:00.000Z', norm, dbg: () => {},
    log: (text, error, options) => world.logs.push({ text, error, options }),
    normalizeProvisionConfig: (p) => ({ ...defaults, ...p }),
    sessionStorage: { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v), removeItem: (k) => session.delete(k) },
    pause: (reason, context) => { world.pauses.push({ reason, context }); store.set(K.paused, reason); },
    autoOn: () => session.get(K.auto) === '1',
    autoSet: (on) => { if (on) session.set(K.auto, '1'); else session.delete(K.auto); },
    rolesFresh: async () => [...pages.values()],
    query: async () => world.cards,
    notion: async (method, path, body) => {
      if (method === 'GET' && path.startsWith('pages/')) {
        const page = pages.get(path.slice(6));
        if (!page) throw new Error('404 object_not_found');
        return page;
      }
      if (method === 'GET' && path.startsWith('data_sources/')) return { properties: { 'Кому': { type: 'select', select: { options: world.options.map((name) => ({ name })) } } } };
      if (method === 'PATCH' && path.startsWith('data_sources/')) {
        world.schemaPatches.push(body);
        world.options = body.properties['Кому'].select.options.map((o) => o.name);
        return {};
      }
      throw new Error(`unexpected notion ${method} ${path}`);
    },
    patch: async (id, props) => { world.patches.push({ id, props }); applyProps(id, props); return {}; },
    mapRoleRow: (p) => p,
    taskRole: (p) => p.to || '',
    rt: (v) => (v && typeof v === 'object' ? v.rich_text?.[0]?.text?.content || '' : String(v || '')),
    richText: (v) => [{ type: 'text', text: { content: String(v) } }],
    PromptCompiler: { compile: () => (world.compileFail ? { ok: false, error: { code: 'budget_exceeded', message: 'budget' } } : { ok: true, text: 'PROVISION_PROMPT' }) },
    ensureComposer: async () => ({ editor: {} }),
    writePrompt: () => true,
    deliver: async (editor, text) => {
      world.delivers.push(text);
      if (text === C.agentBootstrapPrompt) {
        location.assign(`/agent/${NEW}`);
        world.sidebar.set(NEW, { textContent: 'Old Name' });
      }
      return { ok: true };
    },
    lastMessageId: () => 'w0',
    messages: () => [],
    nodeId: (x) => x,
    messagesAfter: () => world.pendingReplies,
    parseMarker: (raw) => (String(raw).includes('CF_AGENT_PROVISION_RESULT') ? world.markerObj : null),
    captchaDialog: () => world.captcha,
    detectToolCallLimit: () => (world.toolLimit ? { text: 'limit' } : null),
    detectVisibleErrorCard: () => world.visibleError,
    stillWorking: () => world.working,
    location,
    provisionAgentUuid: agentUuid,
    provisionCurrentAgentUuid: () => agentUuid(location.pathname),
    provisionSelectRepository: async (repo) => { world.repoSelects.push(repo); return { alreadySelected: false, attempts: 1 }; },
    provisionFindSidebarItem: (uuid) => world.sidebar.get(String(uuid).toLowerCase()) || null,
    provisionText: (el) => String(el?.textContent || '').trim(),
    provisionRenameAgent: async (uuid, name) => {
      world.renames.push({ uuid, name });
      if (world.renameFails) throw new Error('rename failed');
      world.sidebar.set(String(uuid).toLowerCase(), { textContent: name });
      return { attempts: 1 };
    },
    provisionArchiveAgent: async (uuid) => { world.archives.push(uuid); world.sidebar.delete(String(uuid).toLowerCase()); return { archived: true, unverified: false }; },
  };
  const names = Object.keys(deps);
  const api = new Function(...names, `${source}\nreturn { consumeProvision, provisionStartRequest, provisionCancelRequest, provisionState, provisionRequestState, provisionActiveJob };`)(...names.map((n) => deps[n]));
  const approve = (jobs) => {
    const request = store.get(K.provisionRequest);
    world.markerObj = { request_id: request.requestId, jobs, reason: 'ok' };
    world.pendingReplies = [{ raw: 'CF_AGENT_PROVISION_RESULT {}' }];
  };
  const candidateJob = (action = replace ? 'replace' : 'create') => ({ role_page_id: CAND, role_name: 'Executor Core', repo: 'owner/repo', action });
  return { api, world, location, approve, candidateJob, store, session };
}
