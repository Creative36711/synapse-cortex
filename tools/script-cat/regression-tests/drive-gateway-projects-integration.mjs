// Полностью локальная модель Apps Script / Drive; реальные сервисы не используются.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('../drive-gateway.gs', import.meta.url), 'utf8');
let serial = 0;
class Iter { constructor(rows) { this.rows = [...rows]; } hasNext() { return this.rows.length > 0; } next() { return this.rows.shift(); } }
class Folder {
  constructor(name, parent = null) { this.id = `folder_${String(++serial).padStart(10, '0')}`; this.name = name; this.parent = parent; this.folders = []; this.files = []; }
  getId() { return this.id; } getName() { return this.name; } setName(n) { this.name = n; }
  getParents() { return new Iter(this.parent ? [this.parent] : []); }
  getFoldersByName(name) { return new Iter(this.folders.filter((f) => f.name === name)); }
  getFilesByName(name) { return new Iter(this.files.filter((f) => f.name === name)); }
  createFolder(name) { const f = new Folder(name, this); this.folders.push(f); return f; }
  createFile(nameOrBlob, text, mime) {
    const f = typeof nameOrBlob === 'object' && nameOrBlob && typeof nameOrBlob.getBytes === 'function'
      ? new File(nameOrBlob.getName(), nameOrBlob.getDataAsString(), nameOrBlob.getContentType(), this, nameOrBlob.getBytes())
      : new File(nameOrBlob, text, mime, this);
    this.files.push(f); return f;
  }
  moveTo(dest) { this.parent.folders = this.parent.folders.filter((f) => f !== this); this.parent = dest; dest.folders.push(this); }
}
class File {
  constructor(name, text, mime, parent, bytes) { this.id = `file_${String(++serial).padStart(10, '0')}`; this.name = name; this.text = text; this.mime = mime; this.parent = parent; this.bytes = bytes || new Uint8Array(Buffer.from(String(text ?? ''), 'utf8')); }
  getId() { return this.id; } getName() { return this.name; } getMimeType() { return this.mime; }
  getParents() { return new Iter([this.parent]); } getBlob() { return { getDataAsString: () => this.text, getBytes: () => this.bytes }; } setContent(s) { this.text = s; this.bytes = new Uint8Array(Buffer.from(String(s), 'utf8')); }
}
const root = new Folder('root');
function find(id, node = root) { if (node.id === id) return node; for (const child of [...node.folders, ...node.files]) { if (child.id === id) return child; if (child instanceof Folder) { const result = find(id, child); if (result) return result; } } return null; }
const drive = { getRootFolder: () => root, getFolderById: (id) => { const x = find(id); if (!(x instanceof Folder)) throw Error('folder missing'); return x; }, getFileById: (id) => { const x = find(id); if (!(x instanceof File)) throw Error('file missing'); return x; } };
const props = new Map();
const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) };
const ContentService = { MimeType: { JSON: 'json' }, createTextOutput: (v) => ({ setMimeType() { return this; }, getContent: () => v }) };
const LockService = { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) };
const factory = new Function('DriveApp', 'PropertiesService', 'ContentService', 'MimeType', 'LockService', 'Utilities', `${source}\nreturn { doPost, setupGatewayKey, setupProjectGateway };`);
const api = factory(drive, PropertiesService, ContentService, { PLAIN_TEXT: 'text/plain' }, LockService, {
  getUuid: randomUUID,
  newBlob: (data, mime, name) => {
    const bytes = typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'utf8')) : new Uint8Array(data);
    return { getBytes: () => bytes, getDataAsString: () => (typeof data === 'string' ? data : Buffer.from(bytes).toString('utf8')), getName: () => name, getContentType: () => mime };
  },
  base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')),
  base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
});
const quiet = console.log; console.log = () => {};
const legacyKey = api.setupGatewayKey();
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
function setup(id, name) { props.set('CF_SETUP_PROJECT_ID', id); props.set('CF_SETUP_PROJECT_FOLDER', name); return api.setupProjectGateway(); }
const a = setup(A, 'synapse'), b = setup(B, 'atlas');
console.log = quiet;
assert.notEqual(a.key, b.key); assert.notEqual(a.key, legacyKey); assert.notEqual(b.key, legacyKey);
const call = (key, body) => JSON.parse(api.doPost({ postData: { contents: JSON.stringify({ ...body, key }) } }).getContent());
const legacy = call(legacyKey, { action: 'ping' });
assert.equal(legacy.version, '1.8.0'); assert(!legacy.projectScoped); assert.equal(legacy.artifacts.name, 'artifacts');
for (const [profile, id] of [[a, A], [b, B]]) {
  const ping = call(profile.key, { action: 'ping', projectId: id });
  assert.equal(ping.ok, true); assert.equal(ping.projectScoped, true); assert.equal(ping.projectId, id);
  assert.equal(ping.project.name, profile.folder); assert.equal(ping.logs.name, 'logs');
  assert.equal(find(ping.logs.id).parent.id, ping.project.id); assert.equal(find(ping.payloads.id).parent.id, ping.project.id);
  assert.equal(ping.artifacts.name, 'artifacts'); assert.equal(find(ping.artifacts.id).parent.id, ping.project.id);
}
// Миграция 1.6 → 1.7: реестр без artifactsId усыновляет существующую папку, ключ не меняется.
{
  const registry = JSON.parse(props.get('CF_GATEWAY_PROJECTS_V1'));
  const keyBefore = registry[A].key;
  const projectFolder = find(registry[A].folderId);
  // убираем artifacts, созданный setup, чтобы смоделировать реестр 1.6 + ручную папку
  projectFolder.folders = projectFolder.folders.filter((f) => f.name !== 'artifacts');
  delete registry[A].artifactsId;
  props.set('CF_GATEWAY_PROJECTS_V1', JSON.stringify(registry));
  const adopted = projectFolder.createFolder('artifacts');
  adopted.createFile('старый.md', 'история', 'text/plain');
  const ping = call(a.key, { action: 'ping', projectId: A });
  assert.equal(ping.ok, true); assert.equal(ping.artifacts.id, adopted.id, 'существующая artifacts усыновлена');
  const after = JSON.parse(props.get('CF_GATEWAY_PROJECTS_V1'));
  assert.equal(after[A].artifactsId, adopted.id); assert.equal(after[A].key, keyBefore, 'ключ не сменился');
  assert.equal(adopted.files.length, 1, 'история artifacts сохранена');
  // несколько одноимённых папок — ошибка, а не молчаливый выбор
  const extra = projectFolder.createFolder('artifacts');
  delete after[A].artifactsId; props.set('CF_GATEWAY_PROJECTS_V1', JSON.stringify(after));
  assert.equal(call(a.key, { action: 'ping', projectId: A }).ok, false, 'две artifacts требуют ручного разбора');
  // возвращаем проект в рабочее состояние для последующих проверок
  projectFolder.folders = projectFolder.folders.filter((f) => f !== extra);
  after[A].artifactsId = adopted.id; props.set('CF_GATEWAY_PROJECTS_V1', JSON.stringify(after));
}
for (const [key, id] of [[a.key, B], [b.key, A], [legacyKey, A], [a.key, null], [legacyKey, 'not-a-project']]) {
  assert.equal(call(key, { action: 'ping', ...(id ? { projectId: id } : {}) }).ok, false, 'ключ не открывает чужое пространство');
}
const run = '33333333-3333-4333-8333-333333333333', dispatch = '44444444-4444-4444-8444-444444444444';
const aLog = call(a.key, { action: 'createLog', projectId: A, dispatchId: dispatch, runId: run });
const bLog = call(b.key, { action: 'createLog', projectId: B, dispatchId: dispatch, runId: run });
const oldLog = call(legacyKey, { action: 'createLog', dispatchId: dispatch, runId: run });
assert(aLog.ok && bLog.ok && oldLog.ok); assert.equal(new Set([aLog.fileId, bLog.fileId, oldLog.fileId]).size, 3);
assert.equal(call(a.key, { action: 'createLog', projectId: A, dispatchId: dispatch, runId: run }).fileId, aLog.fileId);
assert.equal(call(a.key, { action: 'createLog', projectId: A, dispatchId: dispatch, runId: run, folderId: '19ljf2TgeDg6j-jIamGira8K8_2NjC1BT' }).ok, false);
const marker = '<!-- CF_DISPATCH x:y -->', entry = `\n${marker}\nanswer`;
assert.equal(call(a.key, { action: 'append', projectId: A, fileId: aLog.fileId, marker, entry }).result, 'appended');
assert.equal(call(a.key, { action: 'append', projectId: A, fileId: aLog.fileId, marker, entry }).result, 'duplicate');
const payload = call(a.key, { action: 'savePayload', projectId: A, name: 'task', content: 'alpha' });
assert.equal(call(a.key, { action: 'read', projectId: A, fileId: payload.fileId }).content, 'alpha');
for (const fileId of [bLog.fileId, oldLog.fileId]) {
  assert.equal(call(a.key, { action: 'read', projectId: A, fileId }).ok, false, 'чужой журнал нельзя прочитать');
  assert.equal(call(a.key, { action: 'append', projectId: A, fileId, marker, entry }).ok, false, 'чужой журнал нельзя изменить');
}
assert.equal(call(b.key, { action: 'read', projectId: B, fileId: payload.fileId }).ok, false);
// Обратная совместимость сознательно сохраняет историческое чтение по ID для legacy.
assert.equal(call(legacyKey, { action: 'read', fileId: oldLog.fileId }).ok, true);
const projectFolder = find(call(a.key, { action: 'ping', projectId: A }).project.id);
projectFolder.setName('moved');
assert.equal(call(a.key, { action: 'ping', projectId: A }).ok, false, 'переименование не перенаправляет запись');
assert.equal(call(a.key, { action: 'createLog', projectId: A, dispatchId: dispatch, runId: run }).ok, false);
projectFolder.setName('synapse');
assert.throws(() => setup(A, 'synapse'), /уже зарегистрирован/);
assert.throws(() => setup('55555555-5555-4555-8555-555555555555', 'atlas'), /уже занят/);
assert.equal(call(a.key, { action: 'ping', projectId: A }).ok, true, 'отказ регистрации не меняет прежние доступы');
// saveArtifact: проектная граница и чтение только своего artifacts
const artName = `${dispatch}_${run}__note.json`;
const artA = call(a.key, { action: 'saveArtifact', projectId: A, name: artName, content: '{"a":1}' });
assert.equal(artA.ok, true); assert.equal(find(artA.fileId).parent.name, 'artifacts');
assert.equal(call(a.key, { action: 'read', projectId: A, fileId: artA.fileId }).content, '{"a":1}');
assert.equal(call(b.key, { action: 'read', projectId: B, fileId: artA.fileId }).ok, false, 'чужой артефакт не читается');
assert.equal(call(b.key, { action: 'saveArtifact', projectId: B, name: artName, content: '{}' }).fileId !== artA.fileId, true, 'имя не пересекает проекты');
// D-031: подкаталог миссии не пересекает проекты и читается только своим ключом.
const d031 = 'SYN-P1__P-A__shot__2026-11-04.png';
const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
const shotA = call(a.key, { action: 'saveArtifact', projectId: A, name: d031, content: pngB64, encoding: 'base64', subdir: 'SYN-P1' });
assert.equal(shotA.ok, true); assert.equal(find(shotA.fileId).parent.name, 'SYN-P1');
assert.equal(call(b.key, { action: 'verifyArtifactPlacement', projectId: B, fileId: shotA.fileId }).ok, false, 'чужой PNG не подтверждается');
assert.equal(call(a.key, { action: 'verifyArtifactPlacement', projectId: A, fileId: shotA.fileId }).ok, true);
console.log('OK: Gateway 1.8.0 — два проекта, разные ключи, artifacts (D-031/PNG/подкаталог) и миграция без смены ключа, границы чтения/записи, отказ при переносе и legacy');
