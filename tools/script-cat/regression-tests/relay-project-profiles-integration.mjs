// Реальные функции сборки userscript с поддельным GM-хранилищем и HTTP; без сети.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert(i >= 0 && j > i, a); return src.slice(i, j); };
const initial = cut('  // ───────────────────────────── конфиг ─────────────────────────────', '  const ui = {');
const raw = new Map();
const sessions = () => { const map = new Map(); return { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) }; };
const id = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-${String(n).padStart(12, '0')}`;
const profile = (n, name, repo, branch, driveFolder) => ({ id: id(n), name, repo, branch, driveFolder,
  roles: id(n * 10 + 1), missions: id(n * 10 + 2), requests: id(n * 10 + 3), questions: id(n * 10 + 4),
  pageUrl: 'https://app.notion.com/p/page', questionsUrl: 'https://www.notion.so/database' });
const A = profile(1, 'Synapse', 'team/synapse', 'release/next', 'synapse');
const B = profile(2, 'Atlas', 'team/atlas', 'main', 'atlas');
raw.set('cfn-project-profiles-v1', [A, B]);
const getter = (k, fallback) => raw.has(k) ? structuredClone(raw.get(k)) : fallback;
const setter = (k, v) => raw.set(k, structuredClone(v));
const make = (sessionStorage) => new Function('GM_getValue', 'GM_setValue', 'sessionStorage', 'URL',
  `${initial}\nreturn { C, K, ACTIVE_PROFILE, projectStorageKey, validProfile, resolveProfile, projectApproved, get: GM_getValue, set: GM_setValue };`)(getter, setter, sessionStorage, URL);
const legacyTab = sessions(), tabA = sessions(), tabB = sessions();
tabA.setItem('cfn-active-project-v1', A.id); tabB.setItem('cfn-active-project-v1', B.id);
const legacy = make(legacyTab), a = make(tabA), b = make(tabB);
assert.equal(legacy.ACTIVE_PROFILE.id, 'unconfigured'); assert.equal(legacy.C.repo, '');
assert.equal(legacy.projectApproved(), false); assert.equal(a.projectApproved(), false);
assert.equal(a.C.repo, A.repo); assert.equal(a.C.branch, A.branch); assert.equal(b.C.questions, B.questions);
assert(Object.isFrozen(a.C) && Object.isFrozen(a.ACTIVE_PROFILE));
const keys = ['cfn-notion-token', 'cfn-gw-key', 'cfn-github-token', 'cfn-ntfy-token', 'cfn-pending', 'cfn-expect', 'cfn-mission-id', 'cfn-console-log',
  'cfn-done:arbitrary-id:run-id', 'cfn-asked:dynamic', 'cfn-q-handoff:row', 'cfn-adr-text', 'cf-auto-error-reload-count:dispatch'];
for (const key of keys) { raw.set(key, `legacy:${key}`); legacy.set(key, `blank:${key}`); a.set(key, `A:${key}`); b.set(key, `B:${key}`); }
for (const key of keys) {
  assert.equal(legacy.get(key), `blank:${key}`); assert.equal(a.get(key), `A:${key}`); assert.equal(b.get(key), `B:${key}`);
  assert.equal(raw.get(key), `legacy:${key}`, 'старое состояние не мигрируется и не очищается');
}
a.set('cfn-project-approved', true); assert.equal(a.projectApproved(), true); assert.equal(b.projectApproved(), false);
assert.equal(legacy.K.auto, 'cfn-auto-enabled'); assert.notEqual(a.K.auto, b.K.auto); assert.notEqual(a.K.auto, legacy.K.auto);
tabA.setItem(a.K.auto, '1'); assert.equal(tabB.getItem(b.K.auto), null); assert.equal(legacyTab.getItem(legacy.K.auto), null);
// Уже запущенная closure не переключается и не использует новые адреса/состояние.
tabA.setItem('cfn-active-project-v1', B.id); assert.equal(a.C.repo, A.repo); assert.equal(a.get(keys[0]), 'A:' + keys[0]);
assert.equal(make(tabA).C.repo, B.repo, 'новый запуск выбирает новую closure');
const brokenTab = sessions(); brokenTab.setItem('cfn-active-project-v1', id(9));
const broken = make(brokenTab); assert.equal(broken.ACTIVE_PROFILE.invalid, true); assert.equal(broken.projectApproved(), false);
assert.equal(broken.C.repo, '', 'неизвестный профиль не подменяется Relay');
const blockedStorage = make({ getItem() { throw new Error('storage disabled'); } });
assert.equal(blockedStorage.ACTIVE_PROFILE.invalid, true);
assert.equal(blockedStorage.projectApproved(), false);
assert.equal(blockedStorage.C.repo, '', 'недоступное sessionStorage не подставляет чужой профиль');
assert.equal(blockedStorage.get('cfn-notion-token', ''), '', 'legacy-секрет не читается');
blockedStorage.set('cfn-notion-token', 'isolated');
assert.equal(raw.get('cfn-notion-token'), 'legacy:cfn-notion-token');
assert.equal(a.validProfile({ ...A, repo: 'evil/../repo' }), false);
assert.equal(a.validProfile({ ...A, branch: 'main;echo' }), false);
assert.equal(a.validProfile({ ...A, pageUrl: 'https://notion.so.attacker.invalid/p/x' }), false);
assert.equal(a.validProfile({ ...A, questions: A.roles }), false);

// Переключение/переходы: только явная кнопка снимает hold; URL роли жёстко на текущем origin.
const control = cut('  // ───────────────────────────── управление проектами ─────────────────────────────', '  /** Проверка схемы и ролей только чтением');
const controlSession = sessions(), writes = [], pauses = [];
const controls = new Function('ACTIVE_PROFILE','K','sessionStorage','GM_setValue','URL','location','pause',
  `${control}\nreturn { projectHeld, releaseProjectHold, projectRoleAllowed, trackProjectTask, active: () => projectAsyncWork };`)(
  { ...A, legacy:false }, { step:'step' }, controlSession, (k,v) => writes.push([k,v]), URL,
  { href:'https://arena.ai/agent/current', origin:'https://arena.ai' }, (...args) => pauses.push(args));
controlSession.setItem('cfn-project-switch-hold:' + A.id, '1');
assert.equal(controls.projectHeld(), true);
const cycleSource = readFileSync(new URL('../src/28-cycle.js', import.meta.url), 'utf8');
const tickSource = cycleSource.slice(cycleSource.indexOf('  async function tick(fromToggle = false) {'));
let accidentalRelease = 0;
const heldTick = new Function('projectApproved','projectHeld','releaseProjectHold','log',
  `${tickSource}\nreturn tick;`)(() => true, () => true, () => { accidentalRelease++; return true; }, () => {});
await heldTick(true);
assert.equal(accidentalRelease, 0, 'отложенный tick(true) не снимает hold');
assert.equal(controls.releaseProjectHold(), true);
assert.equal(controls.projectHeld(), false); assert.deepEqual(writes, [['step', false]]);
assert.equal(controls.projectRoleAllowed({id:'r',url:'https://arena.ai/agent/a-123'}), true);
for (const url of ['https://www.arena.ai/agent/a-123', 'https://arena.ai/agent/a/other', 'https://arena.ai/agent/a.evil', 'https://evil.invalid/agent/a'])
  assert.equal(controls.projectRoleAllowed({id:'r',url}), false, url);
assert.equal(pauses.length, 4);
let finish; const pending = controls.trackProjectTask(new Promise((resolve) => { finish = resolve; }));
assert.equal(controls.active(), 1); finish(); await pending; assert.equal(controls.active(), 0);
await assert.rejects(controls.trackProjectTask(Promise.reject(new Error('no')))); assert.equal(controls.active(), 0);
const bootSource = readFileSync(new URL('../src/29-boot.js', import.meta.url), 'utf8');
const wrappers = bootSource.slice(0, bootSource.indexOf('  entries = '));
let approved = true, held = true, qCalls = 0, dCalls = 0;
const wrapped = new Function('tick','refreshQuestions','refreshDecisions','flushPollJournal','trackProjectTask','projectHeld','projectApproved','openQuestions','openDecisions',
  `${wrappers}\nreturn { refreshQuestions, refreshDecisions };`)(async()=>{}, async()=>{qCalls++;return ['q'];}, async()=>{dCalls++;return ['d'];}, async()=>{},
  (p)=>p, () => held, () => approved, () => ({rows:[]}), () => ({rows:[]}));
await wrapped.refreshQuestions(); await wrapped.refreshDecisions(); assert.equal(qCalls + dCalls, 0, 'hold блокирует и фоновые сторожа');
held = false; approved = false; await wrapped.refreshQuestions(); await wrapped.refreshDecisions(); assert.equal(qCalls + dCalls, 0, 'снятый допуск блокирует сторожа');
approved = true; await wrapped.refreshQuestions(); await wrapped.refreshDecisions(); assert.equal(qCalls + dCalls, 2);
assert.match(bootSource, /GM_getValue\(K\.step, false\) && !projectHeld\(\)/, 'сохранённый автоматический шаг не снимает hold');

// Из ссылок берётся ID базы из пути, не ID view после '?'; чужой хост не принимается.
const lookupSource = cut('  /** UUID базы из HTTPS-ссылки Notion;', '  function projectsDialog() {');
const lookupId = new Function('URL', `${lookupSource}\nreturn notionDatabaseId;`)(URL);
assert.equal(lookupId(`https://www.notion.so/My-Database-${A.id.replace(/-/g,'')}?v=${B.id}`), A.id);
assert.equal(lookupId(`https://app.notion.com/p/${A.id.replace(/-/g,'')}`), A.id);
for (const url of [`http://notion.so/${A.id}`, `https://notion.so.evil.invalid/${A.id}`, `https://notion.so/no-id?v=${A.id}`, `https://user:pass@notion.so/${A.id}`])
  assert.equal(lookupId(url), '', url);

// Старый шлюз 1.5 игнорирует projectId: перед записью он обязан быть отклонён.
const gatewaySource = cut('  async function gateway(action, fileId, extra = {}) {', '  async function gatewayWithCredentials(');
const gateway = (active, responder) => new Function('ACTIVE_PROFILE', 'GM_getValue', 'K', 'gatewayWithCredentials', `${gatewaySource}\nreturn gateway;`)(active, () => 'secret', { gwUrl: 'url', gwKey: 'key' }, responder);
const seen = [];
let transport = gateway(A, async (action, _file, extra) => { seen.push({ action, extra }); return { ok: true, version: '1.5' }; });
await assert.rejects(() => transport('createLog', '', {}), /не подтвердил этот проект/);
assert.deepEqual(seen.map((r) => r.action), ['ping']);
seen.length = 0;
transport = gateway({ ...A, legacy: false }, async (action, _file, extra) => { seen.push({ action, extra }); return action === 'ping' ? { ok: true, projectScoped: true, projectId: A.id, project: { name: A.driveFolder } } : { ok: true, fileId: 'a-file' }; });
assert.equal((await transport('createLog', '', { dispatchId: id(3) })).fileId, 'a-file');
assert.deepEqual(seen.map((r) => r.action), ['ping', 'createLog']);
assert.equal(seen[1].extra.projectId, A.id);
seen.length = 0;
transport = gateway({ ...A, legacy: false }, async (action, _file, extra) => { seen.push({ action, extra }); return { ok: true, projectScoped: true, projectId: B.id, project: { name: A.driveFolder } }; });
await assert.rejects(() => transport('read', 'file', {}), /не подтвердил этот проект/); assert.deepEqual(seen.map((r) => r.action), ['ping']);

// Чужой PR не вызывает HTTP, не может стать подтверждением, не исправляет карточку.
const pr = cut('  function prRef(result, targetRepo', '  /** Заголовки GitHub API.');
const verify = cut('  async function verifyMergeClaim(result, token = "",', '  /**\n   * Вернуть карточку');
let sent = [], response = { merged: true, base: { ref: A.branch, repo: { full_name: A.repo } } };
const verifyFn = new Function('C', 'ACTIVE_PROFILE', 'URL', 'githubPr', 'request', 'githubHeaders', 'hasMergedClaim', `${pr}\n${verify}\nreturn { projectPrBoundary, verifyMergeClaim };`)(
  { repo: A.repo, branch: A.branch }, { legacy: false }, URL,
  async (repo, number, token) => { sent.push({ repo, number, token }); return response; }, async () => ({}), () => ({}), (result) => result?.merged === true);
for (const value of ['https://github.com/other/repo/pull/2', 'https://github.com.evil.invalid/team/synapse/pull/2', 'http://github.com/team/synapse/pull/2']) {
  assert.equal((await verifyFn.verifyMergeClaim({ pr: value }, 'secret')).status, 'boundary');
}
assert.equal(sent.length, 0, 'токен не отправляется для чужого PR');
assert.equal((await verifyFn.verifyMergeClaim({}, 'secret')).status, 'unknown', 'без номера PR подтверждение невозможно');
assert.equal(sent.length, 0, 'без номера PR сетевого запроса нет');
assert.equal((await verifyFn.verifyMergeClaim({pr:null, merged:true}, 'secret')).status, 'boundary', 'заявка о мерже без номера отклоняется');
const noPrSource = cut('  const prDeclined = (result) => {', '  // ───────────────────────── техническая информация');
const declinedFor = (legacy) => new Function('ACTIVE_PROFILE', 'hasMergedClaim', `${noPrSource}\nreturn prDeclined;`)({legacy}, (r)=>r?.merged===true);
assert.equal(declinedFor(false)({pr:null,merged:false}), true, 'новая работа без PR по-прежнему разрешена');
assert.equal(declinedFor(false)({pr:null,merged:true}), false, 'противоречивый маркер не обходит проверку PR');
assert.equal(declinedFor(true)({pr:null,merged:true}), true, 'legacy-обработка без PR не изменена');
assert.equal((await verifyFn.verifyMergeClaim({ pr: 'https://github.com/team/synapse/pull/2' }, 'secret')).status, 'merged');
assert.equal(sent[0].repo, A.repo); response = { merged: true, base: { ref: 'main', repo: { full_name: A.repo } } };
assert.equal((await verifyFn.verifyMergeClaim({ pr: 2 }, 'secret')).status, 'boundary', 'другая базовая ветка не подтверждает работу');
response = { merged: true }; assert.equal((await verifyFn.verifyMergeClaim({ pr: 2 }, 'secret')).status, 'boundary');
response = { merged: true, base: { ref: A.branch, repo: { full_name: 'team/other' } } };
assert.equal((await verifyFn.verifyMergeClaim({ pr: 2 }, 'secret')).status, 'boundary', 'ответ GitHub для другого base repo не подтверждает работу');
response = { merged: true, base: { ref: A.branch } };
assert.equal((await verifyFn.verifyMergeClaim({ pr: 2 }, 'secret')).status, 'boundary', 'неполный base repo не подтверждает работу');
// Даже видимый Merged/Continue нового проекта не обходится без проверки
// GitHub. Старый Relay сохраняет прежний путь без дополнительного запроса.
const ensureSource = cut('  async function ensureMerged(task, result) {', '  async function finishMerge(task, key) {');
async function runEnsure(legacy, statuses, surface = 'merged', rememberedPr = null) {
  const checks = [], finishes = [];
  const sandbox = new Function('ACTIVE_PROFILE','projectPrBoundary','verifyMergeClaim','ghToken','hasMergedClaim',
    'K','GM_getValue','rt','hasPrUi','waitFor','patience','C','mergedFlag','closedFlag','continueButton','finishMerge','finishClosed','prRef', 'dispatchTarget',
    `let lastMergeCheck = null;\n${ensureSource}\nreturn { ensureMerged, check:()=>lastMergeCheck };`)(
    {legacy}, () => '', async () => { const status = statuses[Math.min(checks.length, statuses.length - 1)]; checks.push(status); return {status,why:'mock'}; },
()=>'token', (r)=>r.merged===true, {merged:'m:'}, (key) => rememberedPr !== null && key === (legacy ? 'm:card:run' : `m:card:run:repo-${encodeURIComponent(A.repo)}:pr-${rememberedPr}:base-${encodeURIComponent(A.branch)}`), () => '', () => true, async()=>null, (v)=>v,
    {repo:A.repo,branch:A.branch,prCardWaitMs:0,mergeGraceMs:0,prWaitMs:1000}, () => surface === 'merged', () => surface === 'closed',
    () => surface === 'continue' ? {} : null, async()=>{finishes.push('merged');return 'merged';}, async()=>{finishes.push('closed');return 'closed';},
    (result)=>({repo:A.repo, number:Number(result.pr)}), () => null);
  const result = await sandbox.ensureMerged({id:'card',properties:{}},{pr:2,merged:false,run_id:'run'});
  return {result, checks, finishes, detail:sandbox.check()};
}
for (const surface of ['merged','continue']) {
  const openResult = await runEnsure(false, ['open','open'], surface);
  assert.equal(openResult.result, 'boundary', `DOM ${surface} не принимает открытый PR`);
  assert.equal(openResult.finishes.length, 0); assert.equal(openResult.checks.length, 2);
  const lostResult = await runEnsure(false, ['open','unknown'], surface);
  assert.equal(lostResult.result, 'boundary', 'потеря проверки не принимается по DOM');
  const acceptedResult = await runEnsure(false, ['merged','merged'], surface);
  assert.equal(acceptedResult.result, 'merged'); assert.deepEqual(acceptedResult.finishes, ['merged']);
}
const inconsistentClosed = await runEnsure(false, ['open','open'], 'closed');
assert.equal(inconsistentClosed.result, 'boundary'); assert.equal(inconsistentClosed.finishes.length, 0);
const realClosed = await runEnsure(false, ['closed','closed'], 'closed');
assert.equal(realClosed.result, 'closed'); assert.deepEqual(realClosed.finishes, ['closed']);
// Кеш той же выдачи не заменяет текущее подтверждение GitHub и не переносится на другой PR.
const cachedOpen = await runEnsure(false, ['open'], 'merged', 2);
assert.equal(cachedOpen.result, 'boundary'); assert.equal(cachedOpen.finishes.length, 0);
const cachedMerged = await runEnsure(false, ['merged'], 'merged', 2);
assert.equal(cachedMerged.result, 'already');
const cachedOther = await runEnsure(false, ['merged','merged'], 'merged', 3);
assert.equal(cachedOther.result, 'merged'); assert.deepEqual(cachedOther.finishes, ['merged']);
const legacyCached = await runEnsure(true, ['unknown'], 'merged', 2);
assert.equal(legacyCached.result, 'already'); assert.equal(legacyCached.checks.length, 0);
const noReadablePr = await runEnsure(false, ['unknown']);
assert.equal(noReadablePr.result, 'boundary'); assert.equal(noReadablePr.finishes.length, 0);
const legacyMerged = await runEnsure(true, ['unknown']);
assert.equal(legacyMerged.result, 'merged'); assert.equal(legacyMerged.checks.length, 0, 'legacy DOM-поведение не изменено');

console.log('OK: изоляция legacy и двух профилей, независимые вкладки, scope Drive и границы GitHub');
