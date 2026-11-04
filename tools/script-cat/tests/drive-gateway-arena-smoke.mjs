/**
 * Функциональная проба drive-gateway.gs на макете Apps Script.
 *
 * Шлюз нельзя запустить локально, но его логику можно исполнить: DriveApp,
 * PropertiesService, LockService и ContentService подменяются деревом объектов.
 * Проверяется главное обещание — «в корне Диска не появляется ничего, кроме
 * Arena», включая перенос папки от версии 1.4 и защиту от чужого folderId.
 *
 *   node _tools/ScriptCat/tests/drive-gateway-arena-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../drive-gateway.gs', import.meta.url), 'utf8');

let seq = 0;

class List {
  constructor(items) {
    this.items = items;
    this.index = 0;
  }
  hasNext() {
    return this.index < this.items.length;
  }
  next() {
    return this.items[this.index++];
  }
}

class MockFolder {
  constructor(name, parent = null) {
    this.id = `f${String(++seq).padStart(14, '0')}`;
    this.name = name;
    this.parent = parent;
    this.folders = [];
    this.files = [];
  }
  getId() {
    return this.id;
  }
  getName() {
    return this.name;
  }
  getUrl() {
    return `https://drive.example/folder/${this.id}`;
  }
  setName(name) {
    this.name = name;
  }
  getFoldersByName(name) {
    return new List(this.folders.filter((f) => f.name === name));
  }
  createFolder(name) {
    const folder = new MockFolder(name, this);
    this.folders.push(folder);
    return folder;
  }
  getFilesByName(name) {
    return new List(this.files.filter((f) => f.name === name));
  }
  createFile(name, content, mime) {
    const file = new MockFile(name, content, mime, this);
    this.files.push(file);
    return file;
  }
  addFile(file) {
    this.files.push(file);
    file.parent = this;
  }
  moveTo(destination) {
    if (this.parent) this.parent.folders = this.parent.folders.filter((f) => f !== this);
    this.parent = destination;
    destination.folders.push(this);
  }
  getParents() {
    return new List(this.parent ? [this.parent] : []);
  }
}

class MockFile {
  constructor(name, content, mime, parent) {
    this.id = `d${String(++seq).padStart(14, '0')}`;
    this.name = name;
    this.content = content;
    this.mime = mime;
    this.parent = parent;
  }
  getId() {
    return this.id;
  }
  getName() {
    return this.name;
  }
  getMimeType() {
    return this.mime;
  }
  getBlob() {
    return { getDataAsString: () => this.content };
  }
  setContent(content) {
    this.content = content;
  }
  getParents() {
    return new List(this.parent ? [this.parent] : []);
  }
}

function walk(folder, visit) {
  visit(folder);
  for (const child of folder.folders) walk(child, visit);
  for (const file of folder.files) visit(file);
}

function makeDrive() {
  const root = new MockFolder('root');
  const find = (id) => {
    let hit = null;
    walk(root, (node) => {
      if (node.id === id) hit = node;
    });
    return hit;
  };
  return {
    root,
    getRootFolder: () => root,
    getFoldersByName: (name) => {
      const hits = [];
      walk(root, (node) => {
        if (node instanceof MockFolder && node.name === name && node !== root) hits.push(node);
      });
      return new List(hits);
    },
    createFolder: (name) => root.createFolder(name),
    getFolderById: (id) => {
      const hit = find(id);
      if (!hit) throw new Error(`File not found: ${id}`);
      return hit;
    },
    getFileById: (id) => {
      const hit = find(id);
      if (!hit) throw new Error(`File not found: ${id}`);
      return hit;
    },
  };
}

function loadGateway(drive) {
  const properties = new Map();
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: (key) => properties.delete(key),
    }),
  };
  const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({
      mime: 'text/plain',
      setMimeType(mime) {
        this.mime = mime;
        return this;
      },
      getContent: () => text,
    }),
  };
  const MimeType = { PLAIN_TEXT: 'text/plain' };
  const Utilities = { getUuid: () => `uuid-${++seq}-0000-0000-0000-000000000000` };

  const factory = new Function(
    'DriveApp',
    'PropertiesService',
    'ContentService',
    'MimeType',
    'LockService',
    'Utilities',
    `${source}\nreturn { doGet, doPost, setupGatewayKey };`,
  );
  const api = factory(drive, PropertiesService, ContentService, MimeType, LockService, Utilities);
  // setupGatewayKey печатает ключ в лог Apps Script — в пробе это шум.
  const quiet = console.log;
  console.log = () => {};
  const key = api.setupGatewayKey();
  console.log = quiet;
  const call = (body) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ key, ...body }) } }).getContent());
  return { call, api, properties };
}

const uuid = () => '00000000-0000-4000-8000-000000000000';

// ── 1. Пустой диск: корень остаётся чистым, файл уходит в Arena/logs ─────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const dispatchId = uuid();
  const runId = uuid();
  const res = call({ action: 'createLog', dispatchId, runId });
  assert.equal(res.ok, true, 'createLog выполняется');
  assert.equal(drive.root.folders.length, 1, 'в корне появилась ровно одна папка');
  const arena = drive.root.folders[0];
  assert.equal(arena.name, 'Arena');
  const logs = arena.folders.find((f) => f.name === 'logs');
  assert.ok(logs, 'логи лежат в Arena/logs');
  assert.equal(logs.files.length, 1);
  assert.equal(logs.files[0].parent, logs, 'файл создан внутри Arena/logs');
  const duplicate = call({ action: 'createLog', dispatchId, runId });
  assert.equal(duplicate.fileId, res.fileId, 'повтор той же Dispatch/Run пары возвращает тот же лог');
  assert.equal(logs.files.length, 1, 'идемпотентный повтор не создаёт дубль');
  const invalid = call({ action: 'createLog', dispatchId: 'dispatch-1', runId: 'run-1' });
  assert.equal(invalid.ok, false, 'не-UUID Dispatch/Run IDs отклоняются');
  assert.equal(logs.files.length, 1, 'невалидная пара не создаёт файл');
  const nextRun = call({ action: 'createLog', dispatchId, runId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(nextRun.ok, true, 'новый Run той же карточки создаёт журнал');
  assert.notEqual(nextRun.fileId, res.fileId, 'новый Run не смешивает журнал с предыдущим');
  assert.equal(logs.files.length, 2, 'прежний файл сохранён');
}

// ── 2. Ключ обязателен ──────────────────────────────────────────────────────
{
  const drive = makeDrive();
  const { api } = loadGateway(drive);
  const res = JSON.parse(
    api.doPost({ postData: { contents: JSON.stringify({ action: 'createLog', key: 'wrong', dispatchId: uuid(), runId: uuid() }) } }).getContent(),
  );
  assert.equal(res.ok, false, 'без верного ключа запись отклоняется');
  assert.equal(drive.root.folders.length, 0, 'отказ не создаёт папок');
}

// ── 3. Чужой folderId не создаёт файлов вне Arena ───────────────────────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const foreign = drive.root.createFolder('Чужая папка');
  const res = call({ action: 'createLog', dispatchId: uuid(), runId: uuid(), folderId: foreign.id });
  assert.equal(res.ok, false, 'чужой folderId отклоняется');
  assert.equal(foreign.files.length, 0, 'в чужой папке ничего не появилось');
}

// ── 4. legacy dispatch: id старой папки принимается, файл всё равно в Arena ─
{
  const drive = makeDrive();
  const { call, properties } = loadGateway(drive);
  const oldId = 'legacy-fixture-folder-id';
  const payload = { action:'createLog', dispatchId:uuid(), runId:uuid(), folderId:oldId };
  assert.equal(call(payload).ok, false, 'по умолчанию старый folderId не предполагается');
  properties.set('CF_LEGACY_RUN_LOG_FOLDER_ID', oldId);
  const res = call(payload);
  assert.equal(res.ok, true, 'legacy-вызов не ломается');
  const logs = drive.root.folders[0].folders.find((f) => f.name === 'logs');
  assert.ok(logs && logs.files.some((f) => f.id === res.fileId), 'legacy-лог создан в Arena/logs');
  assert.equal(drive.root.folders.length, 1, 'в корне только Arena');
}

// ── 5. Папка версии 1.4 из корня переносится в Arena и переименовывается ────
{
  const drive = makeDrive();
  const legacy = drive.root.createFolder('old-project-logs');
  legacy.createFile('старый.md', '# старый лог', 'text/plain');
  const { call, properties } = loadGateway(drive);
  properties.set('CF_LEGACY_LOG_FOLDER_NAME', 'old-project-logs');
  const res = call({ action: 'createLog', dispatchId: uuid(), runId: uuid() });
  assert.equal(res.ok, true);
  const arena = drive.root.folders[0];
  assert.equal(drive.root.folders.length, 1, 'явно указанная старая папка больше не висит в корне');
  assert.equal(arena.name, 'Arena');
  const logs = arena.folders.find((f) => f.name === 'logs');
  assert.ok(logs, 'папка стала Arena/logs');
  assert.ok(logs.files.some((f) => f.name === 'старый.md'), 'старые логи не потеряны');
  assert.equal(logs.files.length, 2, 'новый лог добавлен рядом со старым');
}

// Без явной настройки шлюз не перемещает прежнюю папку.
{
  const drive = makeDrive();
  const legacy = drive.root.createFolder('old-project-logs');
  const old = legacy.createFile('старый.md', 'история', 'text/plain');
  const { call } = loadGateway(drive);
  assert.equal(call({ action:'createLog', dispatchId:uuid(), runId:uuid() }).ok,true);
  assert.equal(legacy.parent,drive.root);
  assert.equal(old.parent,legacy);
  assert(drive.root.folders.some(f=>f.name==='Arena'));
}

// ── 6. savePayload: только Arena/payloads, имя без путей ────────────────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const res = call({ action: 'savePayload', name: '../../ТЗ: миссия 1', content: 'текст' });
  assert.equal(res.ok, true);
  assert.ok(res.name.endsWith('.md'), 'имя всегда .md');
  assert.ok(!/[/\\]/.test(res.name), 'в имени нет путей');
  assert.ok(res.name.includes('ТЗ'), 'содержательная часть имени сохранена');
  const arena = drive.root.folders[0];
  const payloads = arena.folders.find((f) => f.name === 'payloads');
  assert.ok(payloads && payloads.files.length === 1, 'файл задания лежит в Arena/payloads');
  assert.equal(drive.root.folders.length, 1);

  const again = call({ action: 'savePayload', name: '../../ТЗ: миссия 1', content: 'другой текст' });
  assert.equal(again.fileId, res.fileId, 'повтор с тем же именем идемпотентен');
  assert.equal(again.duplicate, true, 'без overwrite содержимое не меняется');
  assert.equal(payloads.files[0].content, 'текст');
}

// ── 7. append: только в файлы Arena/logs ────────────────────────────────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const created = call({ action: 'createLog', dispatchId: uuid(), runId: uuid() });
  const marker = `<!-- CF_DISPATCH ${uuid()}:${uuid()} -->`;
  const ok = call({ action: 'append', fileId: created.fileId, marker, entry: `\n## Ответ\n\n${marker}\nтекст` });
  assert.equal(ok.ok, true, 'запись в лог Arena/logs разрешена');
  assert.equal(ok.result, 'appended');
  const storedContent = drive.getFileById(created.fileId).getBlob().getDataAsString();
  const duplicate = call({ action: 'append', fileId: created.fileId, marker, entry: `\nповтор\n${marker}\nтекст` });
  assert.equal(duplicate.ok, true, 'повтор того же маркера считается успешной идемпотентной записью');
  assert.equal(duplicate.result, 'duplicate');
  assert.equal(drive.getFileById(created.fileId).getBlob().getDataAsString(), storedContent, 'duplicate не меняет журнал второй раз');

  const badMarker = call({ action: 'append', fileId: created.fileId, marker: '<!-- CF_POLL old -->', entry: '<!-- CF_POLL old -->' });
  assert.equal(badMarker.ok, false, 'устаревший маркер CF_POLL отклоняется');
  assert.match(badMarker.error, /Некорректный маркер записи/);
  assert.equal(drive.getFileById(created.fileId).getBlob().getDataAsString(), storedContent, 'невалидный маркер ничего не записывает');

  const outside = drive.root.createFile('вне.md', 'текст', 'text/plain');
  const bad = call({ action: 'append', fileId: outside.id, marker, entry: `x${marker}` });
  assert.equal(bad.ok, false, 'запись в файл вне Arena запрещена');
}

// ── 8. ping показывает раскладку ────────────────────────────────────────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const ping = call({ action: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.version, '1.7');
  assert.equal(ping.arena.name, 'Arena');
  assert.equal(ping.logs.name, 'logs');
  assert.equal(ping.payloads.name, 'payloads');
  assert.equal(ping.artifacts.name, 'artifacts');
  assert.equal(ping.logs.id, drive.root.folders[0].folders.find((f) => f.name === 'logs').id);
}

// ── 9. saveArtifact: только Arena/artifacts, имя dispatch_run__slug.ext ─────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const d = uuid(), r = '11111111-1111-4111-8111-111111111111';
  const name = `${d}_${r}__report.md`;
  const res = call({ action: 'saveArtifact', name, content: '# отчёт' });
  assert.equal(res.ok, true, 'saveArtifact выполняется');
  const arena = drive.root.folders[0];
  const artifacts = arena.folders.find((f) => f.name === 'artifacts');
  assert.ok(artifacts && artifacts.files.length === 1, 'артефакт лежит в Arena/artifacts');
  assert.equal(artifacts.files[0].parent, artifacts, 'файл создан внутри artifacts');
  assert.equal(artifacts.files[0].mime, 'text/markdown');
  const again = call({ action: 'saveArtifact', name, content: 'другой' });
  assert.equal(again.fileId, res.fileId, 'повтор того же имени идемпотентен');
  assert.equal(again.duplicate, true);
  assert.equal(artifacts.files[0].content, '# отчёт', 'duplicate не перезаписывает');
  // имя вне контракта отклоняется
  assert.equal(call({ action: 'saveArtifact', name: '../../evil.md', content: 'x' }).ok, false);
  assert.equal(call({ action: 'saveArtifact', name: `${d}_${r}__x.exe`, content: 'x' }).ok, false);
  assert.equal(call({ action: 'saveArtifact', name, content: 'x'.repeat(262145) }).ok, false, 'размер ограничен');
  assert.equal(artifacts.files.length, 1, 'отказы не создают файлов');
  // read разрешён из artifacts; append — нет
  assert.equal(call({ action: 'read', fileId: res.fileId }).content, '# отчёт');
  const marker = `<!-- CF_DISPATCH ${d}:${r} -->`;
  assert.equal(call({ action: 'append', fileId: res.fileId, marker, entry: `x${marker}` }).ok, false, 'append в artifacts запрещён');
  // verifyArtifactPlacement: файл в корне отклоняется
  const outside = drive.root.createFile('вне.md', 'текст', 'text/plain');
  assert.equal(call({ action: 'verifyArtifactPlacement', fileId: outside.id }).ok, false, 'файл в корне не артефакт');
  assert.equal(call({ action: 'verifyArtifactPlacement', fileId: res.fileId }).ok, true);
}

console.log('OK: локальный Apps Script harness Gateway 1.7 — Arena/{logs,payloads,artifacts}, saveArtifact, placement, valid IDs и idempotency; live Drive не затронут');
