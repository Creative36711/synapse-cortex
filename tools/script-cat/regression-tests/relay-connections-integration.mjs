// Единое окно подключений: старые ключи, черновик, проверки и восстановление.
// Только локальный DOM и фиктивные HTTP; настоящий цикл и внешние сервисы не запускаются.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);
const start = src.indexOf('  // ───────────────────────────── подключения ─────────────────────────────');
const end = src.indexOf('  // ───────────────────────────── ntfy-настройка ─────────────────────────────', start);
assert.ok(start > 0 && end > start, 'блок подключений найден');
const section = src.slice(start, end);
const ghStart = src.indexOf('  function githubDialog() {');
const ghEnd = src.indexOf('  // ───────────────────────────── HTTP ─────────────────────────────', ghStart);
assert.ok(ghStart > 0 && ghEnd > ghStart, 'автоподсказка GitHub найдена');
const githubOpeners = src.slice(ghStart, ghEnd);
const mountStart = src.indexOf('  function mount() {');
const mount = src.slice(mountStart, src.indexOf('  async function toggleAuto() {', mountStart));
assert.match(mount, /id="\$\{ui\.setup\}"[^>]*>⚙ Подключения/);
assert.doesNotMatch(mount, /id="\$\{ui\.(?:gh|ntfy)\}"/, 'дополнительные кнопки подключения убраны');
assert.match(section, /role="dialog" aria-modal="true"/);
assert.match(section, /id="cfn-connection-notion" type="password"/);
assert.match(section, /id="cfn-connection-key" type="password"/);
assert.match(section, /id="cfn-connection-github" type="password"/);
assert.doesNotMatch(section, /\bprompt\s*\(/, 'старых трёх prompt больше нет');
assert.match(section, /В старом Relay проверка ping может создать Arena\/logs и Arena\/payloads или перенести старую папку логов/, 'побочный эффект legacy Drive ping назван до проверки');
assert.match(section, /новому проекту нужен заранее зарегистрированный шлюз/, 'новый проект не описан как legacy');

const K = {
  notion: 'cfn-notion-token', gwUrl: 'cfn-gw-url', gwKey: 'cfn-gw-key',
  ghToken: 'cfn-github-token', ghAsk: 'cfn-github-ask', rolesCache: 'cfn-roles-cache',
  pending: 'cfn-pending', expect: 'cfn-expect',
};
const C = { notionV: '2025-09-03', roles: 'roles-id', missions: 'missions-id', requests: 'requests-id',
  questions: 'questions-id', repo: 'owner/repository' };
const initial = {
  [K.notion]: 'saved-notion-secret', [K.gwUrl]: 'https://script.google.com/macros/s/deployment/exec',
  [K.gwKey]: 'saved-drive-secret', [K.ghToken]: 'saved-github-secret',
  [K.rolesCache]: { at: 123, rows: [{ name: 'old' }] }, [K.ghAsk]: 12,
};

function makeHarness(values = initial, activeProfile = undefined) {
  const store = new Map(Object.entries(structuredClone(values)));
  const nodes = new Map();
  const calls = { http: [], gateway: [], writes: [], logs: [], open: [], ntfy: 0, recover: 0, adopt: 0 };
  const options = { failedSource: '', failGithub: false, failGateway: false, version: '1.5', failKeyOnce: '', recoverPromise: null, gatewayPromise: null };
  let automatic = false, paused = false, confirmAnswer = true;
  const location = { href: 'https://arena.ai/agent/example?other=1&cf-auth-setup=1#part' };
  const history = { replaceState: (_a, _b, url) => { location.href = url; } };
  function node(id = '') {
    const handlers = new Map();
    const el = {
      id, style: {}, value: '', checked: false, disabled: false, textContent: '', placeholder: '', html: '',
      onclick: null, onkeydown: null, focused: false,
      addEventListener: (type, fn) => handlers.set(type, fn),
      dispatch: (type) => handlers.get(type)?.({ target: el }),
      focus: () => { el.focused = true; },
      remove() { nodes.delete(el.id); for (const id of el.childIds || []) nodes.delete(id); },
      querySelector(selector) { return selector === '[role="dialog"]' ? el.dialog : nodes.get(selector.slice(1)) || null; },
    };
    Object.defineProperty(el, 'innerHTML', {
      set(html) {
        el.html = html;
        el.childIds = [];
        for (const m of html.matchAll(/id="([^"]+)"/g)) {
          nodes.set(m[1], node(m[1]));
          el.childIds.push(m[1]);
        }
        el.dialog = node('dialog');
      },
    });
    return el;
  }
  const document = {
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => node(),
    body: { appendChild: (el) => { nodes.set(el.id, el); } },
  };
  nodes.set('cfn-setup', node('cfn-setup'));
  const request = async (method, url, headers, body) => {
    calls.http.push({ method, url, headers, body });
    if (url.includes('/users/me')) return { object: 'user' };
    if (url.includes('/data_sources/')) {
      if (url.endsWith(options.failedSource) && options.failedSource) throw new Error('HTTP 404: not shared');
      return { object: 'data_source' };
    }
    if (url.includes('api.github.com')) {
      if (options.failGithub) throw new Error(`HTTP 401: ${headers.Authorization}`);
      return { full_name: C.repo };
    }
    throw new Error(`unexpected request ${url}`);
  };
  const gatewayWithCredentials = async (action, file, extra, credentials) => {
    calls.gateway.push({ action, file, extra, credentials });
    if (options.failGateway) throw new Error(`refused ${credentials.key}`);
    return options.gatewayPromise || { ok: true, version: options.version };
  };
  const get = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  const set = (key, value) => {
    calls.writes.push([key, structuredClone(value)]);
    if (options.failKeyOnce === key) { options.failKeyOnce = ''; throw new Error('storage failure'); }
    store.set(key, value);
  };
  const factory = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'ui', 'document', 'location', 'history', 'request',
    'gatewayWithCredentials', 'gatewayIsOld', 'githubHeaders', 'inputStyle', 'btnStyle', 'log', 'window',
    'confirm', 'ntfyDialog', 'recoverLastClaim', 'adoptPageAnswer', 'setTimeout', 'autoOn', 'isPaused', 'autoSet', 'setStatus', 'ACTIVE_PROFILE',
    `let busy = false;\n${section}\n${githubOpeners}\nreturn { setup, connectionDialog, githubDialog, maybeGhDialog, connectionEndpoint, connectionProblem, probeNotionConnection, probeDriveConnection, probeGithubConnection, setBusy: (value) => { busy = value; }, setWork: (value) => { projectAsyncWork = value; } };`,
  );
  const api = factory(
    get, set, K, C, { setup: 'cfn-setup' }, document, location, history, request, gatewayWithCredentials,
    (v) => Number.parseFloat(v) < 1.5, (token) => token ? { Authorization: `Bearer ${token}` } : {},
    () => '', () => '', (...args) => calls.logs.push(args), { open: (...args) => calls.open.push(args) },
    () => confirmAnswer, () => { calls.ntfy += 1; }, async () => {
      calls.recover += 1; return options.recoverPromise || { ok: true, text: 'карточка восстановлена' };
    },
    async () => { calls.adopt += 1; return { ok: true, text: 'ответ обработан' }; },
    (fn) => { fn(); return 1; }, () => automatic, () => paused, (value) => { automatic = value; }, () => {}, activeProfile,
  );
  return {
    ...api, store, nodes, calls, options, location,
    setAuto: (value) => { automatic = value; }, setPaused: (value) => { paused = value; },
    setConfirm: (value) => { confirmAnswer = value; },
    el: (name) => nodes.get(`cfn-connection-${name}`),
    main: (name) => nodes.get(`cfn-connections-${name}`),
    type(name, value) { const el = nodes.get(`cfn-connection-${name}`); el.value = value; el.dispatch('input'); },
    toggle(name, value) { const el = nodes.get(`cfn-connection-${name}`); el.checked = value; el.dispatch('change'); },
  };
}

// Старая ссылка и открытие повторно: секреты не попадают в разметку и поля.
{
  const h = makeHarness();
  await h.setup(false);
  assert.equal(h.location.href, 'https://arena.ai/agent/example?other=1#part', 'параметр setup удалён, остальные сохранены');
  const box = h.nodes.get('cfn-connections');
  assert.ok(box, 'окно открыто');
  for (const secret of [initial[K.notion], initial[K.gwKey], initial[K.ghToken]]) assert.ok(!box.html.includes(secret));
  for (const field of ['notion', 'key', 'github']) assert.equal(h.el(field).value, '', 'сохранённые секреты не подставляются в DOM');
  assert.match(h.el('notion-status').textContent, /ещё не проверен/);
  h.type('github', 'draft-not-saved');
  h.maybeGhDialog();
  assert.equal(h.nodes.get('cfn-connections'), box, 'автоподсказка не пересоздала окно');
  assert.equal(h.el('github').value, 'draft-not-saved', 'несохранённый ввод не потерян');
  assert.equal(h.el('github').focused, true, 'автоподсказка ведёт к GitHub');
  assert.equal(h.store.get(K.ghAsk), 0);
  h.setConfirm(false);
  h.main('close').onclick();
  assert.ok(h.nodes.has('cfn-connections'), 'закрытие несохранённого ввода требует подтверждения');
}

// Проверка использует черновик, не пишет GM и показывает ограничения по каждому сервису.
{
  const h = makeHarness(); h.connectionDialog();
  h.type('notion', 'new-notion-secret'); h.type('key', 'new-drive-secret'); h.type('github', 'new-github-secret');
  const before = structuredClone(Object.fromEntries(h.store));
  await h.main('check').onclick();
  assert.deepEqual(Object.fromEntries(h.store), before, 'проверка не сохраняет введённые ключи');
  assert.equal(h.calls.http.filter((c) => c.url.includes('api.notion.com')).length, 5, 'users/me и четыре источника');
  assert.ok(h.calls.http.filter((c) => c.url.includes('api.notion.com')).every((c) => c.headers.Authorization === 'Bearer new-notion-secret'));
  assert.equal(h.calls.gateway[0].credentials.key, 'new-drive-secret');
  assert.equal(h.calls.gateway[0].action, 'ping');
  assert.ok(h.calls.http.some((c) => c.url.includes('api.github.com') && c.headers.Authorization === 'Bearer new-github-secret'));
  assert.match(h.el('notion-status').textContent, /четыре источника читаются.*полная схема не проверялись/);
  assert.match(h.el('drive-status').textContent, /Чтение и запись файлов не проверялись/);
  assert.match(h.el('github-status').textContent, /Права на PR и файлы не проверялись/);
  assert.equal(h.calls.logs.length, 0, 'проверка не пишет секреты в журнал');
  h.main('save').onclick();
  assert.equal(h.store.get(K.notion), 'new-notion-secret');
  assert.equal(h.store.get(K.gwKey), 'new-drive-secret');
  assert.equal(h.store.get(K.ghToken), 'new-github-secret');
  assert.equal(h.store.get(K.rolesCache), null, 'при замене Notion сброшен кеш ролей');
  assert.equal(h.store.get(K.ghAsk), 0);
  assert.equal(h.el('notion').value, '', 'после сохранения секрет убран из DOM');
  assert.match(h.el('github-status').textContent, /ещё не проверен/, 'сохранение само по себе не объявляет доступ проверенным');
  assert.ok(!JSON.stringify(h.calls.logs).includes('new-'));
}

// Частичные ошибки независимы, сообщения не раскрывают ключи.
{
  const h = makeHarness(); h.connectionDialog();
  h.options.failedSource = C.requests; h.options.failGateway = true; h.options.failGithub = true;
  await h.main('check').onclick();
  assert.match(h.el('notion-status').textContent, /источник «Запросы» не прочитан/);
  assert.match(h.el('drive-status').textContent, /не проверен/);
  assert.match(h.el('github-status').textContent, /не проверен/);
  const visible = ['notion-status', 'drive-status', 'github-status'].map((name) => h.el(name).textContent).join(' ');
  for (const secret of [initial[K.notion], initial[K.gwKey], initial[K.ghToken]]) assert.ok(!visible.includes(secret));
  assert.equal(h.store.get(K.notion), initial[K.notion]);
  h.options.version = '1.4'; h.options.failGateway = false;
  const old = await h.probeDriveConnection({ notion: '', gwUrl: initial[K.gwUrl], gwKey: initial[K.gwKey], github: '' });
  assert.match(old.text, /старше 1\.5/);
}

// Нестандартный сервер не получает ключ без отдельного согласия; HTTP запрещён.
{
  const h = makeHarness(); h.connectionDialog();
  assert.equal(h.connectionEndpoint('https://script.google.com.evil.example/macros/s/x/exec').standard, false);
  assert.equal(h.connectionEndpoint('http://script.google.com/macros/s/x/exec').ok, false);
  assert.equal(h.connectionEndpoint('https://user:pass@script.google.com/macros/s/x/exec').ok, false);
  h.type('url', 'https://script.google.com.evil.example/macros/s/x/exec');
  await h.main('check').onclick();
  assert.equal(h.calls.gateway.length, 0, 'без согласия ключ не отправляется на чужой хост');
  assert.match(h.el('drive-status').textContent, /Подтвердите доверие/);
  h.main('save').onclick();
  assert.equal(h.store.get(K.gwUrl), initial[K.gwUrl], 'без согласия новый адрес не сохранён');
  h.toggle('trust', true);
  await h.main('check').onclick();
  assert.equal(h.calls.gateway.length, 1, 'явное согласие разрешает совместимый шлюз');
  h.main('save').onclick();
  assert.equal(h.store.get(K.gwUrl), 'https://script.google.com.evil.example/macros/s/x/exec');
  h.type('url', 'http://example.test/exec'); h.main('save').onclick();
  assert.match(h.main('note').textContent, /HTTPS/);
  assert.equal(h.store.get(K.gwUrl), 'https://script.google.com.evil.example/macros/s/x/exec');
}

// Ранее сохранённый HTTP-адрес помечается как небезопасный: проверка не отправляет ключ,
// но исправление другого подключения не затирает и не блокирует старую конфигурацию.
{
  const h = makeHarness({ ...initial, [K.gwUrl]: 'http://legacy.example/exec' }); h.connectionDialog();
  assert.match(h.el('drive-status').textContent, /небезопасный/);
  await h.main('check').onclick(); assert.equal(h.calls.gateway.length, 0);
  h.type('github', 'replacement-github'); h.main('save').onclick();
  assert.equal(h.store.get(K.ghToken), 'replacement-github');
  assert.equal(h.store.get(K.gwUrl), 'http://legacy.example/exec');
  assert.match(h.main('note').textContent, /небезопасным/);
  h.type('key', 'new-key'); h.main('save').onclick();
  assert.equal(h.store.get(K.gwKey), initial[K.gwKey], 'ключ нельзя сменить для HTTP');
}

// Пустые секреты не стирают старые; удаление — только флажком.
{
  const h = makeHarness(); h.connectionDialog();
  h.type('url', 'https://script.google.com/macros/s/other/exec');
  await h.main('check').onclick();
  assert.equal(h.calls.gateway.length, 0, 'сохранённый ключ не отправляем другому Google deployment без согласия');
  h.main('save').onclick(); assert.equal(h.store.get(K.gwUrl), initial[K.gwUrl]);
  h.toggle('trust', true);
  h.type('url', 'https://script.google.com/macros/s/third/exec');
  assert.equal(h.el('trust').checked, false, 'согласие отозвано при смене адреса');
  await h.main('check').onclick(); assert.equal(h.calls.gateway.length, 0);
  h.toggle('trust', true); h.main('save').onclick();
  assert.equal(h.store.get(K.gwUrl), 'https://script.google.com/macros/s/third/exec');
  assert.equal(h.store.get(K.notion), initial[K.notion]);
  assert.equal(h.store.get(K.gwKey), initial[K.gwKey]);
  assert.equal(h.store.get(K.ghToken), initial[K.ghToken]);
  assert.deepEqual(h.store.get(K.rolesCache), initial[K.rolesCache], 'не меняли Notion — кеш не сбрасывается');
  h.toggle('github-remove', true); h.main('save').onclick();
  assert.equal(h.store.get(K.ghToken), '', 'явное удаление работает');
  assert.equal(h.store.get(K.notion), initial[K.notion]);
  h.toggle('drive-remove', true); h.main('save').onclick();
  assert.equal(h.store.get(K.gwUrl), ''); assert.equal(h.store.get(K.gwKey), '');
  h.toggle('notion-remove', true); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), ''); assert.equal(h.store.get(K.rolesCache), null);
}

// Открытое окно не начинает новый тик; открытие внутри тика снимает busy через finally.
{
  const from = src.indexOf('  async function tick(fromToggle = false) {');
  const to = src.indexOf('  // ───────────────────────────── старт ─────────────────────────────', from);
  assert.ok(from > 0 && to > from);
  const code = src.slice(from, to);
  let open = true, flushes = 0, setups = 0, statusUpdates = 0, openDuringHeal = false;
  const document = { getElementById: (id) => id === 'cfn-connections' && open ? {} : null };
  const h = new Function('document', 'flushPollJournal', 'selfHealClaim', 'autoOn', 'GM_getValue', 'K',
    'isPaused', 'captchaDialog', 'handleToolCallLimit', 'monitorVisibleErrors', 'setup', 'setStatus', 'log',
    `let busy = false, busyAt = 0, stepRestarts = 0;\n${code}\nreturn { tick, busy: () => busy };`,
  )(
    document, async () => { flushes += 1; }, async () => { if (openDuringHeal) open = true; },
    () => true, (_key, fallback) => fallback, { pending: 'pending', expect: 'expect' },
    () => false, () => false, async () => false, () => false, async () => { setups += 1; open = true; },
    () => { statusUpdates += 1; }, () => {},
  );
  await h.tick(false);
  assert.equal(flushes, 0, 'при открытом окне новый тик и повтор журналов не начинаются');
  open = false; openDuringHeal = true;
  await h.tick(false);
  assert.equal(setups, 0, 'окно, открытое при самопроверке, останавливает тик');
  open = false; openDuringHeal = false;
  await h.tick(false);
  assert.equal(setups, 1, 'настройка открывается внутри тика');
  assert.equal(h.busy(), false, 'окно не удерживает блокировку шага');
  assert.equal(statusUpdates, 1, 'finally выполнился');
}

// Смена подключения при сохранённом ходе требует осознанного подтверждения и не снимает его.
{
  const waiting = { kind: 'dispatch', ref: 'live-card', sentAt: 123 };
  const h = makeHarness({ ...initial, [K.expect]: waiting }); h.connectionDialog();
  h.type('notion', 'replacement'); h.setConfirm(false); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), initial[K.notion]);
  assert.deepEqual(h.store.get(K.expect), waiting);
  h.setConfirm(true); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), 'replacement');
  assert.deepEqual(h.store.get(K.expect), waiting);
}

// На активном шаге/цикле сохранения нет. Другая вкладка и ошибка хранилища не затирают значения.
{
  const h = makeHarness(); h.setAuto(true); h.connectionDialog(); h.type('notion', 'replacement');
  assert.equal(h.el('stop-auto').disabled, false);
  h.main('save').onclick(); assert.equal(h.store.get(K.notion), initial[K.notion]);
  h.el('stop-auto').onclick();
  assert.equal(h.el('stop-auto').disabled, true, 'автоцикл этой вкладки остановлен');
  h.main('save').onclick(); assert.equal(h.store.get(K.notion), 'replacement');
  assert.match(h.calls.logs.at(-2)[0], /очередь и ожидание не сняты/);
}
{
  const h = makeHarness(); h.connectionDialog(); h.type('notion', 'replacement');
  h.setAuto(true); h.main('save').onclick();
  assert.match(h.main('note').textContent, /Остановите цикл/); assert.equal(h.store.get(K.notion), initial[K.notion]);
  h.setPaused(true); h.setBusy(true); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), initial[K.notion]);
  h.setBusy(false); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), 'replacement', 'на паузе после шага можно сохранить');
}
{
  const h = makeHarness(); h.connectionDialog(); h.type('github', 'replacement');
  h.store.set(K.ghToken, 'other-tab'); h.main('save').onclick();
  assert.equal(h.store.get(K.ghToken), 'other-tab');
  assert.match(h.main('note').textContent, /другой вкладке/);
}
{
  const h = makeHarness(); h.connectionDialog(); h.type('notion', 'replacement'); h.type('key', 'replacement-key');
  h.options.failKeyOnce = K.gwKey; h.main('save').onclick();
  assert.equal(h.store.get(K.notion), initial[K.notion], 'ранняя запись откачена');
  assert.equal(h.store.get(K.gwKey), initial[K.gwKey]);
  assert.match(h.main('note').textContent, /прежние значения восстановлены/);
}

// В новом проекте изменения доступа отзывают ранее выданный допуск; во время
// фоновой операции сохранить нельзя. Откат ошибки возвращает и допуск.
{
  const profile = { id:'project-id', name:'Synapse', driveFolder:'synapse', legacy:false };
  const h = makeHarness({ ...initial, 'cfn-project-approved':true }, profile); h.connectionDialog();
  h.type('notion', 'replacement'); h.setWork(1); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), initial[K.notion]); assert.equal(h.store.get('cfn-project-approved'), true);
  h.setWork(0); h.main('save').onclick();
  assert.equal(h.store.get(K.notion), 'replacement'); assert.equal(h.store.get('cfn-project-approved'), false);
  assert.match(h.main('note').textContent, /Допуск проекта снят/);
}
{
  const profile = { id:'project-id', name:'Synapse', driveFolder:'synapse', legacy:false };
  const h = makeHarness({ ...initial, 'cfn-project-approved':true }, profile); h.connectionDialog();
  h.type('notion', 'replacement'); h.options.failKeyOnce = K.notion; h.main('save').onclick();
  assert.equal(h.store.get(K.notion), initial[K.notion]); assert.equal(h.store.get('cfn-project-approved'), true);
}

// Проверку можно закрыть только с предупреждением: сетевой запрос не отменяется.
{
  const h = makeHarness(); h.connectionDialog();
  let finish;
  h.options.gatewayPromise = new Promise((resolve) => { finish = resolve; });
  const checking = h.main('check').onclick();
  h.setConfirm(false); h.main('close').onclick();
  assert.ok(h.nodes.has('cfn-connections'), 'пользователь может отменить закрытие во время проверки');
  finish({ ok: true, version: '1.5' }); await checking;
  h.main('close').onclick(); assert.ok(!h.nodes.has('cfn-connections'));
}

// Восстановление нельзя скрыть, пока операция не закончилась.
{
  const h = makeHarness(); h.connectionDialog();
  let finish;
  h.options.recoverPromise = new Promise((resolve) => { finish = resolve; });
  const recovery = h.el('recover').onclick();
  h.main('close').onclick();
  assert.ok(h.nodes.has('cfn-connections'), 'окно остаётся открытым во время восстановления');
  assert.match(h.main('note').textContent, /Восстановление ещё выполняется/);
  finish({ ok: true, text: 'карточка восстановлена' });
  await recovery;
  h.main('close').onclick(); assert.ok(!h.nodes.has('cfn-connections'));
}

// Восстановление и ntfy по-прежнему доступны, но не работают по случайному черновику.
{
  const h = makeHarness(); h.connectionDialog();
  h.type('github', 'draft'); await h.el('recover').onclick();
  assert.equal(h.calls.recover, 0); assert.match(h.main('note').textContent, /сохраните или отмените/);
  h.type('github', ''); await h.el('recover').onclick(); await h.el('adopt').onclick();
  assert.equal(h.calls.recover, 1); assert.equal(h.calls.adopt, 1);
  h.el('ntfy').onclick(); assert.equal(h.calls.ntfy, 1);
}

// Реальный gateway wrapper и тестовый ping используют один транспорт, не переписывая хранилище.
{
  const gwStart = src.indexOf('  async function gateway(action, fileId, extra = {}) {');
  const gwEnd = src.indexOf('  // ───────────────────────────── Notion ─────────────────────────────', gwStart);
  const gw = src.slice(gwStart, gwEnd);
  const sent = [];
  const gateway = new Function('GM_getValue', 'K', 'request', 'fetch', 'networkish', 'sleep',
    `${gw}\nreturn { gateway, gatewayWithCredentials };`)(
    (key) => key === K.gwUrl ? 'https://saved.example/exec' : 'stored-key', K,
    async (_method, url, _headers, body) => { sent.push({ url, body: JSON.parse(body) }); return { ok: true }; },
    () => { throw new Error('не нужен запасной транспорт'); }, () => false, async () => {},
  );
  await gateway.gateway('ping', '');
  await gateway.gatewayWithCredentials('ping', '', {}, { url: 'https://draft.example/exec', key: 'draft-key' });
  assert.deepEqual(sent.map(({ url, body }) => [url, body.key]), [
    ['https://saved.example/exec', 'stored-key'], ['https://draft.example/exec', 'draft-key'],
  ]);
}
console.log('OK: единые подключения, старые GM-ключи, независимые проверки, защита секретов и восстановление');
