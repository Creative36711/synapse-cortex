/** Relay ScriptCat Drive gateway 1.6. Deploy as a web app executing as the owner. */
const CF_KEY_PROPERTY = "CF_GATEWAY_KEY";
const CF_PROJECTS_PROPERTY = "CF_GATEWAY_PROJECTS_V1";
const CF_SETUP_PROJECT_ID = "CF_SETUP_PROJECT_ID";
const CF_SETUP_PROJECT_FOLDER = "CF_SETUP_PROJECT_FOLDER";
const CF_ARENA_FOLDER_NAME = "Arena";
const CF_LOGS_FOLDER_NAME = "logs";
const CF_PAYLOADS_FOLDER_NAME = "payloads";
// Optional explicit compatibility settings; never assume a previous project's folder.
const CF_LEGACY_LOG_FOLDER_NAME_PROPERTY = "CF_LEGACY_LOG_FOLDER_NAME";
const CF_LEGACY_RUN_LOG_FOLDER_ID_PROPERTY = "CF_LEGACY_RUN_LOG_FOLDER_ID";

/** Run once in the Apps Script editor; copy the returned key into ScriptCat. */
function setupGatewayKey() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(CF_KEY_PROPERTY);
  if (!key) {
    key =
      Utilities.getUuid().replace(/-/g, "") +
      Utilities.getUuid().replace(/-/g, "");
    props.setProperty(CF_KEY_PROPERTY, key);
  }
  console.log("CF Gateway key (keep private): " + key);
  return key;
}

/**
 * Explicitly register ONE new project from the Apps Script editor.
 * Set Script Properties CF_SETUP_PROJECT_ID (profile UUID from ScriptCat) and
 * CF_SETUP_PROJECT_FOLDER (e.g. synapse), then run this function once. Copy the
 * returned *project* key privately into that profile. Never copy the master key.
 * Existing folders are not adopted and existing project registrations are not
 * overwritten; a setup failure may leave newly-created folders for inspection.
 */
function setupProjectGateway() {
  return withScriptLock_(function () {
    const props = PropertiesService.getScriptProperties();
    const id = String(props.getProperty(CF_SETUP_PROJECT_ID) || "").trim().toLowerCase();
    const name = String(props.getProperty(CF_SETUP_PROJECT_FOLDER) || "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
      throw new Error("CF_SETUP_PROJECT_ID должен быть UUID профиля ScriptCat.");
    if (!/^[a-z0-9][a-z0-9._-]{0,50}$/.test(name) || name.includes("..") || ["logs", "payloads"].includes(name))
      throw new Error("CF_SETUP_PROJECT_FOLDER должен быть безопасным отдельным именем папки.");
    const registry = projectRegistry_();
    if (Object.prototype.hasOwnProperty.call(registry, id)) throw new Error("Проект уже зарегистрирован; ключ и папки не меняются.");
    if (Object.values(registry).some(function (p) { return p.name === name; }))
      throw new Error("Это имя папки уже занято проектом.");
    const root = DriveApp.getRootFolder();
    const arenas = root.getFoldersByName(CF_ARENA_FOLDER_NAME);
    const arena = arenas.hasNext() ? arenas.next() : root.createFolder(CF_ARENA_FOLDER_NAME);
    if (arenas.hasNext()) throw new Error("В корне несколько папок Arena: сначала разберите их вручную.");
    if (arena.getFoldersByName(name).hasNext())
      throw new Error("Папка проекта уже существует: шлюз не присоединяет существующие папки автоматически.");
    const folder = arena.createFolder(name);
    const logs = folder.createFolder(CF_LOGS_FOLDER_NAME);
    const payloads = folder.createFolder(CF_PAYLOADS_FOLDER_NAME);
    const key = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
    registry[id] = { id: id, name: name, key: key, arenaId: arena.getId(),
      folderId: folder.getId(), logsId: logs.getId(), payloadsId: payloads.getId() };
    props.setProperty(CF_PROJECTS_PROPERTY, JSON.stringify(registry));
    console.log("Project " + id + " · Arena/" + name + " · key (keep private): " + key);
    return { projectId: id, folder: name, key: key };
  });
}

function projectRegistry_() {
  const raw = PropertiesService.getScriptProperties().getProperty(CF_PROJECTS_PROPERTY);
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Реестр проектов шлюза повреждён.");
  return value;
}

function projectLayout_(project) {
  const arena = DriveApp.getFolderById(project.arenaId);
  const folder = DriveApp.getFolderById(project.folderId);
  const logs = DriveApp.getFolderById(project.logsId);
  const payloads = DriveApp.getFolderById(project.payloadsId);
  const root = DriveApp.getRootFolder();
  if (arena.getName() !== CF_ARENA_FOLDER_NAME || !isDirectChildOf_(arena, root.getId()) ||
      folder.getName() !== project.name || !isDirectChildOf_(folder, arena.getId()) ||
      logs.getName() !== CF_LOGS_FOLDER_NAME || !isDirectChildOf_(logs, folder.getId()) ||
      payloads.getName() !== CF_PAYLOADS_FOLDER_NAME || !isDirectChildOf_(payloads, folder.getId()))
    throw new Error("Папки проекта перемещены или переименованы: проверьте расположение и настройки шлюза.");
  return { arena: arena, project: folder, logs: logs, payloads: payloads };
}

function doGet() {
  return json_({
    ok: true,
    service: "Relay Drive gateway",
    version: "1.6",
  });
}

function doPost(e) {
  try {
    const request = JSON.parse(e?.postData?.contents || "{}");
    const projectId = String(request.projectId || "").trim().toLowerCase();
    const registry = projectId ? projectRegistry_() : null;
    const project = projectId && Object.prototype.hasOwnProperty.call(registry, projectId) ? registry[projectId] : null;
    const expected = projectId ? (project && project.key) :
      PropertiesService.getScriptProperties().getProperty(CF_KEY_PROPERTY);
    if (!expected || !constantTimeEqual_(String(request.key || ""), String(expected))) {
      return json_({ ok: false, error: "Неверный ключ или неизвестный проект шлюза." });
    }
    const layoutForRequest = function () { return project ? projectLayout_(project) : ensureLayout_(); };

    if (request.action === "ping") {
      return withScriptLock_(function () {
        const layout = layoutForRequest();
        return json_({
          ok: true,
          service: "Relay Drive gateway",
          version: "1.6",
          ...(project ? { projectScoped: true, projectId: project.id, project: folderInfo_(layout.project) } : {}),
          arena: folderInfo_(layout.arena),
          logs: folderInfo_(layout.logs),
          payloads: folderInfo_(layout.payloads),
        });
      });
    }

    if (request.action === "createLog") {
      const folderId = String(request.folderId || "");
      const oldFolder = PropertiesService.getScriptProperties().getProperty(CF_LEGACY_RUN_LOG_FOLDER_ID_PROPERTY) || "";
      if (folderId && (project || !oldFolder || folderId !== oldFolder)) {
        throw new Error("Прямой folderId не настроен: createLog сам выбирает Arena/logs.");
      }
      const dispatchId = String(request.dispatchId || "");
      const runId = String(request.runId || "");
      if (!/^[0-9a-f-]{36}$/i.test(dispatchId) || !/^[0-9a-f-]{36}$/i.test(runId)) {
        throw new Error("Некорректные Dispatch ID или Run ID.");
      }
      const name = dispatchId + "_" + runId + ".md";
      return withScriptLock_(function () {
        const logs = layoutForRequest().logs;
        const matches = logs.getFilesByName(name);
        if (matches.hasNext()) {
          const existing = matches.next();
          const result = { fileId: existing.getId(), name: name };
          return json_({ ok: true, fileId: result.fileId, name: result.name, result: result });
        }
        const content = "# Dispatch-Run log\n\nDispatch ID: " + dispatchId +
          "\nRun ID: " + runId + "\n";
        const file = logs.createFile(name, content, MimeType.PLAIN_TEXT);
        const result = { fileId: file.getId(), name: name };
        return json_({ ok: true, fileId: result.fileId, name: result.name, result: result });
      });
    }

    if (request.action === "savePayload") {
      const name = safePayloadName_(request.name);
      const content = String(request.content || "");
      if (content.length > 1500000) throw new Error("Payload превышает допустимый размер.");
      return withScriptLock_(function () {
        const payloads = layoutForRequest().payloads;
        const matches = payloads.getFilesByName(name);
        if (matches.hasNext()) {
          const existing = matches.next();
          return json_({ ok: true, fileId: existing.getId(), name: name, duplicate: true });
        }
        const file = payloads.createFile(name, content, MimeType.PLAIN_TEXT);
        return json_({ ok: true, fileId: file.getId(), name: name, duplicate: false });
      });
    }

    const id = String(request.fileId || "");
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) {
      throw new Error("Некорректный Drive file ID.");
    }

    if (request.action === "read") {
      // Reads are needed for the task payload selected from the Notion record.
      const file = DriveApp.getFileById(id);
      if (project) {
        const layout = layoutForRequest();
        if (!isDirectChildOf_(file, layout.logs.getId()) && !isDirectChildOf_(file, layout.payloads.getId()))
          throw new Error("Чтение разрешено только из logs или payloads этого проекта.");
      }
      const mime = String(file.getMimeType() || "");
      if (!mime.startsWith("text/")) {
        throw new Error("Шлюз читает только текстовые файлы.");
      }
      return json_({
        ok: true,
        content: file.getBlob().getDataAsString("UTF-8"),
      });
    }

    if (request.action === "append") {
      const file = DriveApp.getFileById(id);
      const marker = String(request.marker || "");
      const entry = String(request.entry || "");
      if (!marker.startsWith("<!-- CF_DISPATCH ") || !entry.includes(marker)) {
        throw new Error("Некорректный маркер записи.");
      }
      if (entry.length > 1500000) throw new Error("Запись превышает допустимый размер.");
      return withScriptLock_(function () {
        const logs = layoutForRequest().logs;
        if (!isDirectChildOf_(file, logs.getId()) || !String(file.getMimeType() || "").startsWith("text/")) {
          throw new Error(project ? "Запись разрешена только в текстовые файлы logs этого проекта." : "Запись разрешена только в текстовые файлы Arena/logs.");
        }
        const old = file.getBlob().getDataAsString("UTF-8");
        if (old.includes(marker)) return json_({ ok: true, result: "duplicate" });
        file.setContent(old + entry);
        return json_({ ok: true, result: "appended" });
      });
    }

    throw new Error("Неизвестное действие шлюза.");
  } catch (error) {
    return json_({ ok: false, error: String(error?.message || error) });
  }
}

function withScriptLock_(operation) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return operation();
  } finally {
    lock.releaseLock();
  }
}

/** Create the one owned root folder and its two gateway-managed children. */
function ensureLayout_() {
  const root = DriveApp.getRootFolder();
  const arena = getFolderByName_(root, CF_ARENA_FOLDER_NAME) || root.createFolder(CF_ARENA_FOLDER_NAME);
  const logs = getFolderByName_(arena, CF_LOGS_FOLDER_NAME) || adoptLegacyLogs_(root, arena) || arena.createFolder(CF_LOGS_FOLDER_NAME);
  const payloads = getFolderByName_(arena, CF_PAYLOADS_FOLDER_NAME) || arena.createFolder(CF_PAYLOADS_FOLDER_NAME);
  return { arena: arena, logs: logs, payloads: payloads };
}

/** Move and rename the v1.4 root folder only when Arena/logs does not exist. */
function adoptLegacyLogs_(root, arena) {
  const name = String(PropertiesService.getScriptProperties().getProperty(CF_LEGACY_LOG_FOLDER_NAME_PROPERTY) || "").trim();
  if (!name) return null;
  const legacy = getFolderByName_(root, name);
  if (!legacy) return null;
  legacy.setName(CF_LOGS_FOLDER_NAME);
  legacy.moveTo(arena);
  return legacy;
}

function getFolderByName_(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : null;
}

function folderInfo_(folder) {
  return { id: folder.getId(), name: folder.getName() };
}

function safePayloadName_(value) {
  let name = String(value || "payload").trim()
    .replace(/[\\/:]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 180);
  if (!name || name === "." || name === "..") name = "payload";
  if (!/\.md$/i.test(name)) name += ".md";
  return name;
}

function isDirectChildOf_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
