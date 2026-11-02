  // ───────────────────────────── профили проекта ─────────────────────────────
  // Метаданные не содержат секретов. Каждый рабочий профиль получает свой
  // префикс UUID. Старые ключи остаются нетронутыми и копируются только явно.
  const rawGet = GM_getValue;
  const rawSet = GM_setValue;
  const PROFILE_REGISTRY_KEY = "cfn-project-profiles-v1";
  const PROFILE_SESSION_KEY = "cfn-active-project-v1";
  const LEGACY_PROFILE_ID = "unconfigured";
  const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LEGACY_PROFILE = Object.freeze({
    id: LEGACY_PROFILE_ID, name: "Проект не настроен", legacy: true, invalid: true,
    roles: "", missions: "", requests: "", questions: "", pageUrl: "", questionsUrl: "", repo: "",
    branch: "main", driveFolder: "",
  });

  function profileRegistry() {
    const value = rawGet(PROFILE_REGISTRY_KEY, []);
    return Array.isArray(value) ? value : [];
  }
  function validProfile(profile) {
    if (!profile || !PROJECT_UUID.test(String(profile.id || "")) ||
        !String(profile.name || "").trim() || String(profile.name).length > 80) return false;
    const ids = [profile.roles, profile.missions, profile.requests, profile.questions];
    if (ids.some((id) => !PROJECT_UUID.test(String(id || ""))) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== 4) return false;
    try {
      for (const value of [profile.pageUrl, profile.questionsUrl]) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password ||
            !["app.notion.com", "notion.so", "www.notion.so"].includes(url.hostname)) return false;
      }
    } catch { return false; }
    const repo = String(profile.repo || "");
    const branch = String(profile.branch || "");
    const folder = String(profile.driveFolder || "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes("..") &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch) && !branch.includes("..") &&
      !branch.includes("//") && !branch.includes("/.") && !branch.endsWith("/") &&
      !branch.endsWith(".") && !branch.endsWith(".lock") &&
      /^[a-z0-9][a-z0-9._-]{0,50}$/.test(folder) && !folder.includes("..") &&
      !["logs", "payloads"].includes(folder);
  }
  function selectedProfileId() {
    try { return sessionStorage.getItem(PROFILE_SESSION_KEY) || LEGACY_PROFILE_ID; }
    catch {
      // Профиль вкладки неизвестен: не подменяем его рабочим Relay.
      return "session-storage-unavailable";
    }
  }
  function resolveProfile(id) {
    if (id === LEGACY_PROFILE_ID) return LEGACY_PROFILE;
    const matches = profileRegistry().filter((p) => p && p.id === id);
    if (matches.length !== 1 || !validProfile(matches[0])) {
      // Никогда не подменяем повреждённый/удалённый профиль на Relay.
      return Object.freeze({ id: String(id || "invalid"), name: "Профиль недоступен", invalid: true,
        roles: "", missions: "", requests: "", questions: "", pageUrl: "", questionsUrl: "",
        repo: "", branch: "main", driveFolder: "" });
    }
    // Копия и closure неизменяемы до полной перезагрузки вкладки.
    return Object.freeze({ ...matches[0], legacy: false, invalid: false });
  }
  const ACTIVE_PROFILE = resolveProfile(selectedProfileId());
  const projectStorageKey = (id, key) => `project:${id}:${String(key)}`;
  GM_getValue = (key, fallback) => rawGet(projectStorageKey(ACTIVE_PROFILE.id, key), fallback);
  GM_setValue = (key, value) => rawSet(projectStorageKey(ACTIVE_PROFILE.id, key), value);
  Object.assign(C, {
    roles: ACTIVE_PROFILE.roles, missions: ACTIVE_PROFILE.missions, requests: ACTIVE_PROFILE.requests,
    questions: ACTIVE_PROFILE.questions, pageUrl: ACTIVE_PROFILE.pageUrl, questionsUrl: ACTIVE_PROFILE.questionsUrl,
    repo: ACTIVE_PROFILE.repo, branch: ACTIVE_PROFILE.branch, projectName: ACTIVE_PROFILE.name,
    driveFolder: ACTIVE_PROFILE.driveFolder,
  });
  Object.freeze(C);
  const projectApproved = () => !ACTIVE_PROFILE.invalid && !ACTIVE_PROFILE.legacy &&
    GM_getValue("cfn-project-approved", false) === true;

  const K = {
    notion: "cfn-notion-token",
    gwUrl: "cfn-gw-url",
    gwKey: "cfn-gw-key",
    auto: "cfn-auto-enabled",
    paused: "cfn-paused",
    log: "cfn-console-log",
    pending: "cfn-pending",
    expect: "cfn-expect",
    mission: "cfn-mission-id",
    merged: "cfn-merged:",
    branch: "cfn-branch",
    pause: "cfn-pause-context",
    ntfyTopic: "cfn-ntfy-topic",
    ntfyToken: "cfn-ntfy-token",
    ghToken: "cfn-github-token",
    ghAsk: "cfn-github-ask",
    lastResult: "cfn-last-result",
    errSeen: "cfn-error-seen",
    step: "cfn-step-request",
    debug: "cfn-debug",
    lastSend: "cfn-last-send",
    deadSend: "cfn-dead-send",
    qQueue: "cfn-q-queue",
    answers: "cfn-answer-queue",
    collapsed: "cfn-panel-collapsed",
    stateV: "cfn-state-v",
    rolesCache: "cfn-roles-cache",
  };

  // sessionStorage также разделён; выбранный ID хранится отдельно на вкладку.
  if (!ACTIVE_PROFILE.legacy) K.auto = projectStorageKey(ACTIVE_PROFILE.id, K.auto);

  const ui = {
    panel: "cfn-panel",
    log: "cfn-log",
    status: "cfn-status",
    toggle: "cfn-toggle",
    step: "cfn-step",
    setup: "cfn-setup",
    stop: "cfn-stop",
    clear: "cfn-clear",
    reset: "cfn-reset",
    questions: "cfn-questions",
    qBadge: "cfn-q-badge",
    collapse: "cfn-collapse",
    count: "cfn-log-count",
    debug: "cfn-debug-toggle",
  };
