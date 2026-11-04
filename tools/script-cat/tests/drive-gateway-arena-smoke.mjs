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
  createFile(nameOrBlob, content, mime) {
    const file = typeof nameOrBlob === 'object' && nameOrBlob && typeof nameOrBlob.getBytes === 'function'
      ? new MockFile(nameOrBlob.getName(), nameOrBlob.getDataAsString(), nameOrBlob.getContentType(), this, nameOrBlob.getBytes())
      : new MockFile(nameOrBlob, content, mime, this);
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
  constructor(name, content, mime, parent, bytes) {
    this.id = `d${String(++seq).padStart(14, '0')}`;
    this.name = name;
    this.content = content;
    this.mime = mime;
    this.parent = parent;
    this.bytes = bytes || new Uint8Array(Buffer.from(String(content ?? ''), 'utf8'));
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
    return { getDataAsString: () => this.content, getBytes: () => this.bytes };
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
  const Utilities = {
    getUuid: () => `uuid-${++seq}-0000-0000-0000-000000000000`,
    newBlob: (data, mime, name) => {
      const bytes = typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : new Uint8Array(data);
      return {
        getBytes: () => bytes,
        getDataAsString: () => (typeof data === 'string' ? data : Buffer.from(bytes).toString('utf8')),
        getName: () => name,
        getContentType: () => mime,
      };
    },
    base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
  };

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
  assert.equal(ping.version, '1.8.0');
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
  const again = call({ action: 'saveArtifact', name, content: '# отчёт' });
  assert.equal(again.fileId, res.fileId, 'повтор того же имени и содержимого идемпотентен');
  assert.equal(again.duplicate, true);
  assert.equal(artifacts.files[0].content, '# отчёт', 'duplicate не перезаписывает');
  // то же имя, другое содержимое — явный конфликт, а не молчаливый старый отчёт
  const conflict = call({ action: 'saveArtifact', name, content: 'другой отчёт' });
  assert.equal(conflict.ok, false, 'разное содержимое под тем же именем отклоняется');
  assert.match(conflict.error, /конфликт/i);
  assert.equal(artifacts.files[0].content, '# отчёт', 'конфликт не перезаписывает файл');
  // имя вне контракта отклоняется
  assert.equal(call({ action: 'saveArtifact', name: '../../evil.md', content: 'x' }).ok, false);
  assert.equal(call({ action: 'saveArtifact', name: `${d}_${r}__x.exe`, content: 'x' }).ok, false);
  assert.equal(call({ action: 'saveArtifact', name, content: 'x'.repeat(262145) }).ok, false, 'размер ограничен');
  // кириллица: проходит по string.length, но превышает лимит в UTF-8 байтах
  const cyr = 'я'.repeat(140000); // 140000 символов, 280000 байт
  assert.ok(cyr.length <= 262144, 'по длине строки проходит');
  const cyrRes = call({ action: 'saveArtifact', name: `${d}_${r}__cyr.md`, content: cyr });
  assert.equal(cyrRes.ok, false, 'кириллический текст за байтовым лимитом отклоняется');
  assert.match(cyrRes.error, /UTF-8/);
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

// ── 10. D-031: имена миссии, PNG/base64, подкаталог первого уровня ──────────
{
  const drive = makeDrive();
  const { call } = loadGateway(drive);
  const name = 'SYN-1__K-15__evidence__e19a8d3.txt';
  const res = call({ action: 'saveArtifact', name, content: 'доказательство' });
  assert.equal(res.ok, true, 'имя D-031 принимается');
  const artifacts = drive.root.folders[0].folders.find((f) => f.name === 'artifacts');
  assert.equal(drive.getFileById(res.fileId).parent, artifacts, 'D-031 файл лежит в artifacts');
  assert.equal(call({ action: 'saveArtifact', name, content: 'доказательство' }).duplicate, true);
  assert.equal(call({ action: 'saveArtifact', name, content: 'другое' }).ok, false, 'конфликт содержимого D-031');

  const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const png = 'SYN-P1__P-A__shot__2026-11-04.png';
  const pres = call({ action: 'saveArtifact', name: png, content: Buffer.from(pngBytes).toString('base64'), encoding: 'base64' });
  assert.equal(pres.ok, true, 'PNG/base64 принимается');
  const pngFile = drive.getFileById(pres.fileId);
  assert.equal(pngFile.mime, 'image/png');
  assert.deepEqual(Array.from(pngFile.bytes), pngBytes, 'байты PNG сохранены без UTF-8 порчи');
  assert.equal(call({ action: 'saveArtifact', name: 'SYN-P1__P-A__shot__2026-11-05.png', content: 'not-base64!' }).ok, false, 'не-base64 PNG отклоняется');

  const sub = 'SYN-P1__P-B__report__2026-11-04.md';
  const sres = call({ action: 'saveArtifact', name: sub, content: '# отчёт', subdir: 'SYN-P1' });
  assert.equal(sres.ok, true, 'подкаталог миссии принимается');
  const subFile = drive.getFileById(sres.fileId);
  assert.equal(subFile.parent.name, 'SYN-P1');
  assert.equal(subFile.parent.parent, artifacts, 'подкаталог — прямой ребёнок artifacts');
  assert.equal(call({ action: 'saveArtifact', name: sub, content: 'x', subdir: 'OTHER' }).ok, false, 'подкаталог должен совпадать с миссией');
  assert.equal(call({ action: 'saveArtifact', name: sub, content: 'x', subdir: 'SYN-P1/inner' }).ok, false, 'вложенный путь запрещён');
  const d = uuid(), r = '11111111-1111-4111-8111-111111111111';
  assert.equal(call({ action: 'saveArtifact', name: `${d}_${r}__x.md`, content: 'x', subdir: 'SYN-1' }).ok, false, 'legacy-имя не получает подкаталог');

  for (const bad of ['SYN-1__K-15__evidence.txt', 'SYN-1__K-15__unknown__2026-11-04.txt', 'SYN-1__K-15__evidence__notadate.txt', '../__K-15__evidence__2026-11-04.txt']) {
    assert.equal(call({ action: 'saveArtifact', name: bad, content: 'x' }).ok, false, `невалидное имя D-031: ${bad}`);
  }
  assert.equal(call({ action: 'saveArtifact', name: 'SYN-1__K-15__report__2026-11-04__supplement-1.md', content: 'дополнение' }).ok, true, 'supplement разрешён');

  assert.equal(call({ action: 'verifyArtifactPlacement', fileId: pres.fileId }).ok, true, 'PNG placement подтверждается');
  assert.equal(call({ action: 'verifyArtifactPlacement', fileId: sres.fileId }).ok, true, 'подкаталог placement подтверждается');
  assert.equal(call({ action: 'read', fileId: sres.fileId }).content, '# отчёт', 'текст из подкаталога читается');
  assert.equal(call({ action: 'read', fileId: pres.fileId }).ok, false, 'PNG не читается как текст');
  const big = Buffer.alloc(262145).toString('base64');
  assert.equal(call({ action: 'saveArtifact', name: 'SYN-P1__P-C__shot__2026-11-04.png', content: big, encoding: 'base64' }).ok, false, 'байтовый лимит PNG действует');
}

console.log('OK: локальный Apps Script harness Gateway 1.8.0 — Arena/{logs,payloads,artifacts}, saveArtifact (D-031/PNG/подкаталог), placement, valid IDs и idempotency; live Drive не затронут');
