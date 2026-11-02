// Интеграция настоящих блоков userscript с настоящим doPost шлюза.
// Google Drive, сеть, DOM и хранилище ScriptCat — только локальные макеты.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const gs = readFileSync(new URL('../drive-gateway.gs', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert(a >= 0 && b > a, `не найден блок ${from}`);
  return src.slice(a, b);
};
const pollBlock = cut('  const POLL_REPLY = ', '  /**\n   * Ждём появления редактора.');
const gatewayBlock = cut('  async function gateway(', '  // ───────────────────────────── Notion');
const hashBlock = cut('  function textHash(', '  async function sendToRole(');
const tickPrefix = cut('  async function tick(', '    // Ложный отказ проверки мержа');
const reminderBlock = cut('      await sendToRole(role, markerReminder(', '      return true;');
const LOG = 'log_0123456789abcdef';
const FOLDER = 'logs-folder-0000000001';
const QUEUE = 'cfn-poll-journal-queue';
const KEY = 'test-only-key';
const EXPECT = { ref: 'dispatch-1', runId: 'run-1', logId: LOG };

function backend() {
  const files = new Map([[LOG, { content: '# Исходный журнал\n', parent: FOLDER, mime: 'text/plain', writes: 0 }]]);
  const rootId = 'drive-root-0000000001';
  const arenaId = 'arena-folder-00000001';
  const payloadsId = 'payloads-folder-000001';
  const folders = new Map([
    [rootId, { id: rootId, name: 'root', parent: '', children: [arenaId] }],
    [arenaId, { id: arenaId, name: 'Arena', parent: rootId, children: [FOLDER, payloadsId] }],
    [FOLDER, { id: FOLDER, name: 'logs', parent: arenaId, children: [] }],
    [payloadsId, { id: payloadsId, name: 'payloads', parent: arenaId, children: [] }],
  ]);
  const list = (items) => {
    let index = 0;
    return { hasNext: () => index < items.length, next: () => items[index++] };
  };
  const folderApi = (id) => {
    const folder = folders.get(id);
    return {
      getId: () => folder.id,
      getName: () => folder.name,
      getFoldersByName: (name) => list(folder.children.map((childId) => folders.get(childId)).filter((child) => child?.name === name).map((child) => folderApi(child.id))),
      createFolder(name) {
        const childId = `created-folder-${folders.size}`;
        folders.set(childId, { id: childId, name, parent: id, children: [] });
        folder.children.push(childId);
        return folderApi(childId);
      },
    };
  };
  const drive = {
    getRootFolder: () => folderApi(rootId),
    getFileById(id) {
      const f = files.get(id);
      if (!f) throw new Error('Файл не найден');
      return {
        getMimeType: () => f.mime,
        getParents: () => list([{ getId: () => f.parent }]),
        getBlob: () => ({ getDataAsString: () => f.content }),
        setContent: (value) => { f.content = value; f.writes += 1; },
      };
    },
  };
  const context = vm.createContext({
    DriveApp: drive,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => KEY }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    console,
  });
  vm.runInContext(`${gs}\nglobalThis.post = doPost;`, context);
  const post = (payload) => JSON.parse(context.post({ postData: { contents: JSON.stringify(payload) } }).text);
  return { files, folders, post };
}

function group(question, options, { noInput = false, noLabel = false, noSkip = false, disabled = false, onSubmit = () => {}, onSkip = () => {} } = {}) {
  const input = {
    value: '',
    ownerDocument: { defaultView: {
      Event: class Event { constructor(type) { this.type = type; } },
      KeyboardEvent: class KeyboardEvent { constructor(type) { this.type = type; } },
    } },
    dispatchEvent() { return true; },
  };
  const submit = {
    textContent: 'Submit', disabled, isConnected: true, clicks: 0,
    getAttribute: (key) => key === 'aria-label' ? 'Submit custom response' : null,
    click() { this.clicks += 1; this.sent = input.value; onSubmit(); input.value = ''; },
  };
  const skip = {
    textContent: 'Skip', clicks: 0,
    getAttribute: () => null,
    click() { this.clicks += 1; onSkip(); },
  };
  const radios = options.map((text) => ({ innerText: text, textContent: text }));
  const el = {
    isConnected: true,
    getAttribute: (name) => name === 'aria-label' && !noLabel ? question : null,
    querySelector: (sel) => sel.startsWith('input') && !noInput ? input : sel === '.body-base, .body-sm' ? { textContent: question } : null,
    querySelectorAll: (sel) => sel === 'button' ? (noSkip ? [submit] : [submit, skip]) : sel === '[role="radio"]' ? radios : [],
  };
  return { el, input, submit, skip };
}

function harness({ server = backend(), storage = new Map(), clock = { ms: 1000000 }, state = { groups: [] }, network = { mode: 'ok' } } = {}) {
  const logs = [];
  const requests = [];
  const get = (key, fallback) => storage.has(key) ? structuredClone(storage.get(key)) : fallback;
  const set = (key, value) => storage.set(key, structuredClone(value));
  set('url', 'https://script.google.com/test/exec');
  set('key', KEY);
  const message = {
    id: 'chat-message-123456789',
    querySelector: () => null,
    querySelectorAll: (sel) => sel === '[role="radiogroup"]' ? state.groups.map((g) => g.el) : [],
  };
  const document = {
    querySelectorAll: (sel) => sel === '[data-agent-transcript-message="true"]' && state.groups.length ? [message] : [],
  };
  const transport = async (payload) => {
    const parsed = JSON.parse(payload);
    requests.push(parsed);
    if (network.onRequest) network.onRequest(parsed);
    if (network.mode === 'offline') throw new Error('network timeout');
    if (network.mode === 'lost-ack') {
      if (!network.wrote) { server.post(parsed); network.wrote = true; }
      throw new Error('network timeout after write');
    }
    return server.post(parsed);
  };
  const request = async (_method, _url, _headers, payload) => transport(payload);
  const fetch = async (_url, { body }) => ({ status: 200, json: async () => transport(body) });
  const sleep = async (ms) => { clock.ms += ms; };
  const now = { now: () => clock.ms };
  const create = new Function(
    'document', 'GM_getValue', 'GM_setValue', 'log', 'sleep', 'firstLine', 'nowIso',
    'request', 'fetch', 'networkish', 'K', 'C', 'pause', 'location', 'window',
    'nodeId', 'visible', 'getComputedStyle', 'Date',
    `${hashBlock}\n${gatewayBlock}\n${pollBlock}\nreturn { answerPolls, pollLogEntry, flushPollJournal, pollJournalQueue, gateway, POLL_REPLY };`,
  );
  const api = create(
    document, get, set,
    (text, bad, opts) => logs.push({ text, bad, opts }), sleep,
    (text, n) => String(text).slice(0, n), () => new globalThis.Date(clock.ms).toISOString(),
    request, fetch, () => true, { gwUrl: 'url', gwKey: 'key' }, { pollPauseCount: 3 },
    () => {}, { pathname: '/agent/kernel' },
    { KeyboardEvent: class KeyboardEvent { constructor(type) { this.type = type; } } },
    (node) => node.id.replace('chat-message-', ''), () => true,
    () => ({ visibility: 'visible', display: 'block' }), now,
  );
  return { ...api, server, storage, clock, state, network, logs, requests, get, set };
}

const content = (h) => h.server.files.get(LOG).content;
const positive = (h) => h.logs.filter((row) => /вопрос и варианты (записаны|уже были) в журнале/.test(row.text));
const markers = (text) => text.match(/<!-- CF_DISPATCH [^\n]*:poll:[^\n]* -->/g) || [];

// Сам исходный шлюз отказывает старому маркеру: это воспроизводит дефект.
{
  const server = backend();
  const marker = '<!-- CF_POLL old -->';
  const response = server.post({ key: KEY, action: 'append', fileId: LOG, marker, entry: marker });
  assert.equal(response.ok, false);
  assert.match(response.error, /Некорректный маркер записи/);
  assert.equal(server.files.get(LOG).writes, 0);
}

// Два вопроса проходят через реальный gateway/doPost; успех только после ответа.
{
  const h = harness();
  let captured;
  const first = group('Расширять Scope?', ['Да', 'Нет'], { onSubmit: () => {
    captured = h.get(QUEUE, []);
    assert.equal(captured.length, 1, 'снимок сохранён до первого Submit');
    assert.match(captured[0].entry, /Второй вопрос/);
  } });
  const second = group('Второй вопрос', ['Alpha', 'Beta']);
  h.state.groups = [first, second];
  h.network.onRequest = () => assert.equal(positive(h).length, 0, 'успех не объявляется до подтверждения');
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'answered');
  assert.equal(first.submit.clicks, 1);
  assert.equal(second.submit.clicks, 1);
  assert.equal(first.submit.sent, h.POLL_REPLY);
  assert.match(content(h), /Расширять Scope\?/);
  assert.match(content(h), /Второй вопрос/);
  assert.match(content(h), /Alpha/);
  assert.equal((content(h).match(/результат при обработке: универсальный ответ отправлен/g) || []).length, 2);
  assert.equal(markers(content(h)).length, 1);
  assert.equal(h.server.files.get(LOG).writes, 1);
  assert.equal(h.get(QUEUE, []).length, 0);
  assert.equal(positive(h).length, 1);
  const payload = h.requests.at(-1);
  assert.match(payload.marker, /^<!-- CF_DISPATCH dispatch-1:run-1:poll:/);
  assert(payload.entry.includes(payload.marker));

  // Тот же маркер уже существует: настоящий doPost вернёт duplicate.
  h.network.onRequest = null;
  h.set(QUEUE, [{ ...captured[0], readyAt: 0, nextAt: 0, entry: `\n${payload.entry}` }]);
  await h.flushPollJournal();
  assert.equal(h.server.files.get(LOG).writes, 1, 'duplicate не добавляет вторую запись');
  assert.equal(h.get(QUEUE, []).length, 0);
  assert.match(positive(h).at(-1).text, /уже были/);
  assert.equal(first.submit.clicks, 1, 'повтор записи не кликает Submit');
}

// Ошибка сети, исчезновение карточки, перезагрузка экземпляра и отложенный повтор.
{
  const h = harness({ network: { mode: 'offline' } });
  const q = group('Нужен выбор?', ['Да', 'Нет'], { onSubmit: () => { h.state.groups = []; } });
  h.state.groups = [q];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'answered');
  assert.equal(q.submit.clicks, 1);
  assert.equal(positive(h).length, 0);
  assert(h.logs.some((row) => /не записался.*Снимок сохранён/.test(row.text)));
  const queued = h.get(QUEUE, []);
  assert.equal(queued.length, 1);
  assert(queued[0].nextAt > h.clock.ms, 'повтор с задержкой, а не непрерывный цикл');
  assert.equal(h.server.files.get(LOG).writes, 0);
  const restarted = harness({ server: h.server, storage: h.storage, clock: h.clock, state: h.state });
  await restarted.flushPollJournal();
  assert.equal(restarted.requests.length, 0, 'раньше срока повтор не отправляется');
  h.clock.ms = queued[0].nextAt + 1;
  await restarted.flushPollJournal();
  assert.equal(q.submit.clicks, 1);
  assert.equal(h.server.files.get(LOG).writes, 1);
  assert.match(content(restarted), /Нужен выбор\?/);
  assert.equal(restarted.get(QUEUE, []).length, 0);
  assert.equal(positive(restarted).length, 1);
}

// Длинные подписи из DOM не обрезаются до прежних 300/160 символов.
{
  const h = harness();
  const question = `Вопрос ${'длинный '.repeat(50)}КОНЕЦ ВОПРОСА`;
  const option = `Вариант ${'длинный '.repeat(30)}КОНЕЦ ВАРИАНТА`;
  const q = group(question, [option], { noLabel: true });
  h.state.groups = [q];
  await h.answerPolls({ name: 'Kernel' }, EXPECT);
  assert.match(content(h), /КОНЕЦ ВОПРОСА/);
  assert.match(content(h), /КОНЕЦ ВАРИАНТА/);
}

// Реальный отказ шлюза (не та папка) не считается успехом и может быть исправлен.
{
  const h = harness();
  h.server.files.get(LOG).parent = 'another-folder';
  const q = group('Запись разрешена?', ['Да', 'Нет']);
  h.state.groups = [q];
  await h.answerPolls({ name: 'Kernel' }, EXPECT);
  assert.equal(h.server.files.get(LOG).writes, 0);
  assert.equal(positive(h).length, 0);
  assert(h.logs.some((row) => /шлюз Drive отказал.*текстовые файлы/.test(row.text)));
  assert.equal(h.get(QUEUE, []).length, 1);
  h.server.files.get(LOG).parent = FOLDER;
  h.clock.ms = h.get(QUEUE, [])[0].nextAt + 1;
  await h.flushPollJournal();
  assert.equal(h.server.files.get(LOG).writes, 1);
  assert.equal(q.submit.clicks, 1);
}

// Ответ шлюза потерялся после физической записи: повтор даёт duplicate.
{
  const h = harness({ network: { mode: 'lost-ack' } });
  const q = group('Записано, но без подтверждения?', ['Да', 'Нет']);
  h.state.groups = [q];
  await h.answerPolls({ name: 'Kernel' }, EXPECT);
  assert.equal(h.server.files.get(LOG).writes, 1);
  assert.equal(h.get(QUEUE, []).length, 1);
  assert.equal(positive(h).length, 0, 'без подтверждения не называем запись успешной');
  h.network.mode = 'ok';
  h.clock.ms = h.get(QUEUE, [])[0].nextAt + 1;
  await h.flushPollJournal();
  assert.equal(h.server.files.get(LOG).writes, 1);
  assert.equal(markers(content(h)).length, 1);
  assert.match(positive(h).at(-1).text, /уже были/);
  assert.equal(q.submit.clicks, 1);
}

// Нет ID: файл не угадывается, ложного успеха нет, текст доступен в панели.
{
  const h = harness();
  const q = group('Какой режим?', ['Красный', 'Синий']);
  h.state.groups = [q];
  await h.answerPolls({ name: 'Kernel' }, { ref: EXPECT.ref, runId: EXPECT.runId });
  assert.equal(h.requests.length, 0);
  assert.equal(positive(h).length, 0);
  assert(h.logs.some((row) => /не записан.*нет ID журнала/.test(row.text)));
  assert(h.logs.some((row) => /Для ручного переноса: Какой режим\?.*Красный; Синий/.test(row.text)));
  assert.equal(q.submit.clicks, 1);
}

// Опрос, виденный до отправки следующего задания, нельзя привязать к нему.
{
  const h = harness();
  const q = group('Вопрос предыдущей попытки', ['Да', 'Нет']);
  h.state.groups = [q];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, { ...EXPECT, seen: ['123456789'] }), null);
  assert.equal(await h.answerPolls({ name: 'Kernel' }, { ...EXPECT, watermark: '123456789' }), null);
  assert.equal(q.submit.clicks, 0);
  assert.equal(h.requests.length, 0);
}

// Skip закрывает сразу весь опрос: все вопросы уже в снимке, исход честный.
{
  const h = harness();
  const first = group('Первый без поля?', ['1', '2'], { noInput: true, onSkip: () => { h.state.groups = []; } });
  const second = group('Второй без поля?', ['3', '4'], { noInput: true });
  h.state.groups = [first, second];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'waiting');
  assert.equal(first.skip.clicks, 1);
  assert.match(content(h), /Первый без поля\?/);
  assert.match(content(h), /Второй без поля\?/);
  assert.equal((content(h).match(/нажат Skip, ответ не отправлен/g) || []).length, 2);
  assert.equal((content(h).match(/универсальный ответ отправлен/g) || []).length, 0);
}

// Неуспешный Skip не считается закрытием и не блокирует следующую попытку.
{
  const h = harness();
  const q = group('Skip не сработал?', ['Да'], { noInput: true });
  h.state.groups = [q];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'waiting');
  assert.equal(q.skip.clicks, 1);
  assert.match(content(h), /Skip нажат, закрытие не подтверждено/);
  assert(h.logs.some((row) => /закрытие не подтверждено/i.test(row.text)));
  assert.equal((h.get(`cfn-poll2:${EXPECT.runId}`, [])).length, 0, 'без подтверждения вопрос не помечен закрытым');
  q.skip.click = () => { q.skip.clicks += 1; h.state.groups = []; };
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'waiting');
  assert.equal(q.skip.clicks, 2, 'повтор возможен');
  assert.match(content(h), /нажат Skip, ответ не отправлен/);
}

// Частичный успех: не называем отвеченным вопрос без поля и не нажимаем Skip.
{
  const h = harness();
  const first = group('Ответить удалось?', ['Да']);
  const second = group('А тут?', ['Нет'], { noInput: true });
  h.state.groups = [first, second];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'answered');
  assert.equal(first.submit.clicks, 1);
  assert.equal(second.skip.clicks, 0);
  assert.match(content(h), /результат при обработке: универсальный ответ отправлен/);
  assert.match(content(h), /результат при обработке: нет поля для ответа/);
}

// Новая попытка ответа — новое событие: старый отказ не маскирует успех.
{
  const h = harness();
  const q = group('Позднее включившийся Submit?', ['Да'], { noSkip: true, disabled: true });
  h.state.groups = [q];
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'waiting');
  assert.match(content(h), /результат при обработке: отправка ответа не подтверждена/);
  assert.equal(q.submit.clicks, 0);
  q.submit.disabled = false;
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'answered');
  assert.equal(q.submit.clicks, 1);
  assert.equal(markers(content(h)).length, 2, 'два разных исхода записаны отдельно');
  assert.match(content(h), /результат при обработке: универсальный ответ отправлен/);
  assert.equal(await h.answerPolls({ name: 'Kernel' }, EXPECT), 'waiting');
  assert.equal(q.submit.clicks, 1, 'на подтверждённый ответ второй раз не нажимаем');
}

// Аварийное закрытие до завершения обработки: сохранённый снимок не теряется.
{
  const h = harness({ network: { mode: 'offline' } });
  let captured;
  const q = group('Вопрос перед перезагрузкой', ['Вариант'], { onSubmit: () => { captured = h.get(QUEUE, []); } });
  h.state.groups = [q];
  await h.answerPolls({ name: 'Kernel' }, EXPECT);
  h.set(QUEUE, captured); // состояние, существовавшее до завершения обработчика
  const restarted = harness({ server: h.server, storage: h.storage, clock: h.clock, state: { groups: [] } });
  await restarted.flushPollJournal();
  assert.equal(restarted.requests.length, 0, 'живому обработчику сначала дают завершиться');
  h.clock.ms = captured[0].readyAt + 1;
  await restarted.flushPollJournal();
  assert.match(content(restarted), /Вопрос перед перезагрузкой/);
  assert.match(content(restarted), /результат при обработке: не подтверждён/);
  assert.equal(q.submit.clicks, 1);
}

// Новая запись в очереди во время await не затирается после успеха первой.
{
  const h = harness();
  const base = { fileId: LOG, roleName: 'Kernel', readyAt: 0, nextAt: 0, attempts: 0 };
  const a = { ...base, marker: '<!-- CF_DISPATCH a:run:poll:1 -->' };
  const b = { ...base, marker: '<!-- CF_DISPATCH b:run:poll:2 -->' };
  a.entry = `\n${a.marker}\nA`;
  b.entry = `\n${b.marker}\nB`;
  h.set(QUEUE, [a]);
  h.network.onRequest = () => { h.network.onRequest = null; h.set(QUEUE, [...h.get(QUEUE, []), b]); };
  await h.flushPollJournal();
  assert.deepEqual(h.get(QUEUE, []).map((row) => row.marker), [b.marker]);
  await h.flushPollJournal();
  assert.equal(h.get(QUEUE, []).length, 0);
  assert.match(content(h), /\nA/);
  assert.match(content(h), /\nB/);
}

// Повтор работает до проверок auto/pause; напоминание сохраняет ID журнала.
{
  const tickSource = cut('  async function tick(', '  // ───────────────────────────── старт');
  const flushAt = tickSource.indexOf('flushPollJournal().catch(');
  assert(flushAt > 0 && flushAt < tickSource.indexOf('if (!auto && !fromToggle && !pending && !waiting) return;'));
  assert(flushAt < tickSource.indexOf('if (isPaused())'));
  let called = 0;
  const tick = new Function('flushPollJournal', 'Date', 'log', 'pause',
    `let busy = false, busyAt = 0, stepRestarts = 0;\n${tickPrefix}\n}\nreturn tick;`,
  )(async () => { called += 1; }, Date, () => {}, () => {});
  await tick(false);
  assert.equal(called, 1, 'фон запускает повтор до выхода из ручного режима');
  assert.match(reminderBlock, /logId: expect\.logId/);
}

console.log('OK: локальный harness настоящего userscript + Gateway doPost — Drive/Notion/DOM смоделированы; маркер, подтверждение, очередь, duplicate и Skip');
