// D-037: сторож ADR обходит ВСЕ репозитории профиля, а не только главный.
// Боевой сценарий SYN-1: главный репозиторий (synapse-cortex) не содержит
// docs/decisions (404), предложение лежит во втором репозитории (synapse).
// Раньше сторож читал только C.repo, поэтому полный текст с Git blob SHA
// никогда не дописывался в вопрос и предохранитель не пропускал его к приёмке.
// Здесь исполняются настоящие блоки ScriptCat против модели GitHub/хранилища.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length);
  assert(a >= 0 && b > a, `нет блока: ${from}`);
  return src.slice(a, b);
};

const refresh = cut('  async function refreshDecisions(force = false) {', '  let decisionsWatch = 0;');
const proposalBlock = cut('  function proposalQuestion(row, missionName = "") {', '  async function refreshDecisions');

// Сторож больше не зашит на один репозиторий: он итерирует C.repos.
assert.match(refresh, /Array\.isArray\(C\.repos\)/, 'сторож обходит список репозиториев профиля');
assert.match(refresh, /Number\(e\.status\) === 404/, '404 папки decisions не останавливает обход');
assert.match(refresh, /rows\.push\(\{ file: item\.name, sha: item\.sha, url: item\.html_url \|\| "", content, repo, branch \}\)/, 'строка несёт свои репозиторий и ветку');

const content = 'Статус: proposed\n# Полный ADR\nОтдельные вопросы и варианты.\n';
const bytes = Buffer.from(content, 'utf8');
const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const MAIN = 'example/main-repo';
const SECOND = 'example/second-repo';

function makeStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: (key, fallback) => store.has(key) ? store.get(key) : fallback,
    set: (key, value) => store.set(key, value),
  };
}

// Модель GitHub: главный репозиторий без папки decisions (404), второй — с proposed.
function githubModel({ mainHasFolder = false, secondFile = 'SYN-1.md' } = {}) {
  const calls = [];
  const request = async (_method, url) => {
    calls.push(url);
    if (url.includes(`${MAIN}/contents/docs/decisions?`)) {
      if (mainHasFolder) return [];
      const err = new Error('HTTP 404: Not Found'); err.status = 404; throw err;
    }
    if (url.includes(`${SECOND}/contents/docs/decisions?`)) {
      return [{ type: 'file', name: secondFile, sha, html_url: `https://github.com/${SECOND}/blob/main/docs/decisions/${secondFile}` }];
    }
    if (url.includes(`${SECOND}/contents/docs/decisions/${secondFile}?`)) {
      return { sha, content: Buffer.from(content, 'utf8').toString('base64') };
    }
    throw new Error(`неожиданный запрос ${url}`);
  };
  return { request, calls };
}

function runRefresh({ store, request, repos, deliveries, decided = new Set() }) {
  const C = { repo: MAIN, branch: 'main', repos, adrCheckMs: 600000 };
  const fn = new Function(
    'openDecisions', 'GM_getValue', 'GM_setValue', 'C', 'K', 'request', 'githubHeaders', 'ADR_FOLDER',
    'adrStatusOf', 'b64Text', 'ADR_PROPOSED', 'decidedAdrNames', 'adrKeyOf', 'deliverProposals', 'logThrottled', 'dbg',
    `${refresh}\nreturn refreshDecisions;`,
  )(
    () => ({ at: 0, rows: [] }),
    store.get, store.set, C, { ghToken: 'token' }, request, () => ({}), 'docs/decisions',
    (text) => { const m = String(text || '').match(/^\s*Статус:\s*(.+?)\s*$/m); return m ? m[1].replace(/[`*]/g, '').trim().toLowerCase() : ''; },
    (value) => { const clean = String(value || '').replace(/\s+/g, ''); if (!clean) return ''; try { return Buffer.from(clean, 'base64').toString('utf8'); } catch { return ''; } },
    'proposed', async () => decided, (file) => String(file || '').replace(/\.md$/i, '').toLowerCase(),
    async (rows) => deliveries.push(...rows), () => {}, () => {},
  );
  return fn;
}

// 1. Главный репозиторий без папки decisions (404) не роняет обход; предложение
//    из второго репозитория найдено и несёт свои repo/branch.
{
  const store = makeStore();
  const { request, calls } = githubModel();
  const deliveries = [];
  const repos = [{ repo: MAIN, branch: 'main', main: true }, { repo: SECOND, branch: 'main' }];
  const refreshDecisions = runRefresh({ store, request, repos, deliveries });
  const rows = await refreshDecisions(true);
  assert.equal(rows.length, 1, 'предложение из второго репозитория найдено');
  assert.equal(rows[0].file, 'SYN-1.md');
  assert.equal(rows[0].repo, SECOND, 'строка помнит свой репозиторий');
  assert.equal(rows[0].branch, 'main');
  assert.equal(rows[0].sha, sha);
  assert.equal(deliveries.length, 1, 'предложение уходит в доставку');
  assert.ok(calls.some((u) => u.includes(`${MAIN}/contents/docs/decisions?`)), 'главный репозиторий опрошен');
  assert.ok(calls.some((u) => u.includes(`${SECOND}/contents/docs/decisions?`)), 'второй репозиторий опрошен');
  // Кэш составной: ключ включает репозиторий.
  const texts = store.get('cfn-adr-text', {});
  assert.ok(texts[`${SECOND}/SYN-1.md`], 'кэш по составному ключу repo/file');
  assert.equal(texts[`${SECOND}/SYN-1.md`].content, content);
}

// 2. Если главный репозиторий тоже содержит папку decisions, обходятся оба.
{
  const store = makeStore();
  const { request } = githubModel({ mainHasFolder: true });
  const deliveries = [];
  const repos = [{ repo: MAIN, branch: 'main', main: true }, { repo: SECOND, branch: 'main' }];
  const rows = await runRefresh({ store, request, repos, deliveries })(true);
  assert.equal(rows.length, 1, 'пустая папка главного + предложение второго = одна строка');
  assert.equal(rows[0].repo, SECOND);
}

// 3. Одно репозиторное наследие: без C.repos сторож читает C.repo (обратная совместимость).
{
  const store = makeStore();
  const calls = [];
  const request = async (_m, url) => {
    calls.push(url);
    if (url.includes(`${MAIN}/contents/docs/decisions?`)) return [{ type: 'file', name: 'SOLO.md', sha }];
    if (url.includes(`${MAIN}/contents/docs/decisions/SOLO.md?`)) return { sha, content: Buffer.from(content).toString('base64') };
    throw new Error(`неожиданный ${url}`);
  };
  const deliveries = [];
  const rows = await runRefresh({ store, request, repos: [], deliveries })(true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo, MAIN, 'без списка репозиториев берётся главный');
  assert.ok(calls.every((u) => u.includes(MAIN)), 'запросы только в главный репозиторий');
}

// 4. Плоский кэш до D-037 переносится под ключ главного репозитория и не смешивается.
{
  const store = makeStore({ 'cfn-adr-text': { 'SYN-1.md': { sha, status: 'proposed', content } } });
  const { request } = githubModel();
  const deliveries = [];
  const repos = [{ repo: MAIN, branch: 'main', main: true }, { repo: SECOND, branch: 'main' }];
  await runRefresh({ store, request, repos, deliveries })(true);
  const texts = store.get('cfn-adr-text', {});
  assert.equal(texts['SYN-1.md'], undefined, 'плоский ключ убран');
  assert.ok(texts[`${MAIN}/SYN-1.md`], 'старый кэш перенесён под главный репозиторий');
  assert.ok(texts[`${SECOND}/SYN-1.md`], 'кэш второго репозитория отдельно');
}

// 5. proposalQuestion строит ссылку из репозитория/ветки самого предложения.
{
  const { proposalQuestion } = new Function(
    'ADR_FOLDER', 'C', 'fullQuestionText',
    `${proposalBlock}\nreturn { proposalQuestion };`,
  )('docs/decisions', { repo: MAIN, branch: 'main' }, (s) => String(s).trim());
  const q = proposalQuestion({ file: 'SYN-1.md', sha, content, repo: SECOND, branch: 'release/2' }, 'SYN-1');
  assert.equal(q.url, `https://github.com/${SECOND}/blob/release/2/docs/decisions/SYN-1.md`, 'ссылка ведёт в репозиторий предложения');
  assert.ok(q.fullText.includes(q.url), 'ссылка доступна приёмке');
  assert.ok(q.fullText.includes(`${SECOND}@release/2`), 'репозиторий и ветка названы в тексте');
  assert.ok(q.fullText.includes(`CF_ADR_CONTENT ${sha}`), 'маркер полного текста на месте');
  // Без repo/branch в строке — наследие главного репозитория.
  const legacy = proposalQuestion({ file: 'SYN-1.md', sha, content }, 'SYN-1');
  assert.equal(legacy.url, `https://github.com/${MAIN}/blob/main/docs/decisions/SYN-1.md`);
}

// 6. Ключ дедупликации включает репозиторий, когда он известен.
{
  const calls = [];
  const { deliverProposals } = new Function(
    'ADR_FOLDER', 'ADR_PROPOSED', 'askQuestion', 'activeMission', 'rt', 'dbg', 'questionRows', 'Q', 'sel', 'C', 'fullQuestionText', 'adrSubjectKeysOf', 'adrKeyOf', 'logThrottled',
    `${proposalBlock}\nreturn { deliverProposals };`,
  )(
    'docs/decisions', 'proposed',
    async (q, ctx) => { calls.push({ q, ctx }); return null; },
    async () => ({ id: 'mission', properties: { 'Миссия': { title: [{ plain_text: 'SYN-1' }] } } }),
    (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || '').join(''),
    () => {}, async () => [], { done: 'Решено', byDefault: 'Принят дефолт' }, (p) => p?.select?.name || '',
    { repo: MAIN }, (s) => String(s).trim(),
    () => new Set(), (file) => String(file || '').replace(/\.md$/i, '').toLowerCase(), () => {},
  );
  await deliverProposals([{ file: 'SYN-1.md', sha, content, repo: SECOND, branch: 'main' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.key, `adr-full:${SECOND}/SYN-1.md:${sha}`, 'ключ включает репозиторий');
}

console.log('OK: D-037 — сторож ADR обходит все репозитории профиля; 404 главного не роняет обход; предложение второго репозитория доходит до доставки');
