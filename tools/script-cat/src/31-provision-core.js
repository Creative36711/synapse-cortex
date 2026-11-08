  // ───────────────────────── provisioning: ядро состояния и правил ─────────────────────────
  // Отдельный административный контур. Не использует K.pending/K.expect и не
  // создаёт рабочие карточки. Право одобрения проверяется по свежей строке
  // Notion (Agent Admin), а не по имени роли. Проектные имена не зашиты.

  const PROVISION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // D-073: Maintainer здесь осознанно нет — закулисный агент транспорта не
  // создаётся через provisioning и не получает карточек (D-063/D-027).
  const PROVISION_FUNCTIONS = ["Coordinator", "Executor", "Auditor", "Auditory", "Reviewer"];
  const PROVISION_STATES = ["validated", "creating", "repo_selected", "bootstrap_sent", "url_captured",
    "renaming", "renamed", "notion_updated", "activating", "activated", "archiving_old", "done", "paused", "error"];
  const PROVISION_EVENTS = ["provision_request_sent", "provision_approved", "provision_rejected",
    "provision_job_started", "provision_repo_selected", "provision_bootstrap_sent", "provision_url_captured",
    "provision_renamed", "provision_notion_updated", "provision_activated", "provision_activation_blocked",
    "provision_old_archived", "provision_old_archive_unverified", "provision_job_done", "provision_paused",
    "provision_conflict", "provision_noop"];
  const PROVISION_BOOTSTRAP_FORBIDDEN = [
    /CF_[A-Z_]+/i, /notion/i, /cortex/i, /REGULATION/, /WARDEN/i, /DECISIONS/,
    /ntn_[A-Za-z0-9]/, /secret_[A-Za-z0-9]/, /ghp_[A-Za-z0-9]/, /github_pat_[A-Za-z0-9]/,
    /Bearer\s+[A-Za-z0-9]/i, /sk-[A-Za-z0-9]{12}/, /app\.notion|notion\.so|notion\.site/i,
  ];

  const provisionConfig = () => normalizeProvisionConfig(C);
  const provisionBootstrapClean = (text) => {
    const s = String(text || "").trim();
    return s.length > 0 && !PROVISION_BOOTSTRAP_FORBIDDEN.some((re) => re.test(s));
  };

  /** Точный owner/repo: строка или https://github.com/owner/repo(.git). */
  function normalizeProvisionRepo(value) {
    let s = String(value || "").trim();
    if (!s) return "";
    s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) || s.includes("..")) return "";
    return s.toLowerCase();
  }

  function provisionState() {
    const raw = GM_getValue(K.provision, null);
    if (raw && typeof raw === "object") {
      return {
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
        journal: Array.isArray(raw.journal) ? raw.journal : [],
        daily: raw.daily && typeof raw.daily === "object" ? raw.daily : { date: "", count: 0 },
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    }
    return { jobs: [], journal: [], daily: { date: "", count: 0 }, history: [] };
  }
  const saveProvisionState = (state) => GM_setValue(K.provision, { ...state, updatedAt: nowIso() });
  const provisionRequestState = () => GM_getValue(K.provisionRequest, null);
  const saveProvisionRequest = (request) => GM_setValue(K.provisionRequest, request);
  const provisionLockState = () => GM_getValue(K.provisionLock, null);

  function provisionTabId() {
    try {
      let id = sessionStorage.getItem("cfn-provision-tab-v1");
      if (!id) { id = uid(); sessionStorage.setItem("cfn-provision-tab-v1", id); }
      return id;
    } catch { return "tab"; }
  }
  function provisionAcquireLock(requestId, resumeAuto) {
    GM_setValue(K.provisionLock, { requestId, tabId: provisionTabId(), at: Date.now(), resumeAuto: Boolean(resumeAuto) });
  }
  const provisionReleaseLock = () => GM_setValue(K.provisionLock, null);
  function provisionLockHeldByOther() {
    const lock = provisionLockState();
    return Boolean(lock && lock.tabId && lock.tabId !== provisionTabId());
  }

  /** Событие журнала: без секретов и полных prompt. */
  function provisionEvent(event, fields = {}) {
    const state = provisionState();
    const entry = {
      at: nowIso(), event,
      requestId: String(fields.requestId || ""), jobId: String(fields.jobId || ""),
      rolePageId: String(fields.rolePageId || ""), repo: String(fields.repo || ""),
      step: String(fields.step || ""), reason: String(fields.reason || "").slice(0, 300),
    };
    state.journal = [...state.journal, entry].slice(-200);
    saveProvisionState(state);
    dbg("provision", entry);
    return entry;
  }

  const provisionDay = () => new Date().toISOString().slice(0, 10);
  function provisionDailyAllow(cfg = provisionConfig()) {
    const { daily } = provisionState();
    const day = provisionDay();
    const count = daily.date === day ? Number(daily.count) || 0 : 0;
    return count < cfg.agentProvisionDailyMax;
  }
  function provisionDailyConsume() {
    const state = provisionState();
    const day = provisionDay();
    const count = state.daily.date === day ? Number(state.daily.count) || 0 : 0;
    state.daily = { date: day, count: count + 1 };
    saveProvisionState(state);
  }

  /** Кандидат из свежей строки. Возвращает причину отказа, а не молча пропускает. */
  function provisionCandidateFromRow(row, cfg, busy = {}) {
    if (!row || !row.pageId) return { ok: false, reason: "нет строки роли" };
    if (row.agentAdmin === true) return { ok: false, reason: "админ-роль не provisioning-кандидат" };
    if ((row.agentState || "не требуется") !== "запрошен") return { ok: false, reason: "Agent State не запрошен" };
    const name = String(row.name || "").trim();
    if (!name || name.length > 100) return { ok: false, reason: "имя роли пустое или длиннее 100" };
    if (!PROVISION_FUNCTIONS.includes(row.fn)) return { ok: false, reason: "недопустимая функция" };
    const repo = normalizeProvisionRepo(row.repo);
    if (!repo) return { ok: false, reason: "репозиторий не нормализуется в owner/repo" };
    const allow = (cfg.agentProvisionRepoAllowlist || []).map(normalizeProvisionRepo);
    if (!allow.includes(repo)) return { ok: false, reason: "репозиторий вне allowlist" };
    const busyNames = busy.names || new Set();
    const busyIds = busy.ids || new Set();
    if (busyNames.has(norm(name)) || busyIds.has(norm(row.id)) || busyIds.has(norm(row.pageId))) {
      return { ok: false, reason: "по роли есть активная работа" };
    }
    const url = String(row.url || "").trim();
    const action = url ? "replace" : "create";
    return {
      ok: true,
      candidate: {
        rolePageId: row.pageId, roleName: name, fn: row.fn, repo, action,
        oldAgentUrl: action === "replace" ? url : "",
        roleAgentId: row.id || "",
      },
    };
  }

  function provisionCandidates(rows, cfg, busy = {}) {
    const candidates = [];
    const rejected = [];
    for (const row of rows || []) {
      const result = provisionCandidateFromRow(row, cfg, busy);
      if (result.ok) candidates.push(result.candidate);
      else if ((row?.agentState || "не требуется") === "запрошен" || row?.agentAdmin === true) {
        rejected.push({ rolePageId: row?.pageId || "", reason: result.reason });
      }
    }
    return { candidates: candidates.slice(0, cfg.agentProvisionMaxJobs), rejected };
  }

  /** Активная админ-роль: предпочтительно Coordinator, иначе Reviewer. */
  function provisionAdminRole(rows) {
    const admins = (rows || []).filter((r) => r.agentAdmin === true && r.status === "Активна" &&
      r.url && r.pageId && PROVISION_UUID.test(String(r.pageId)) &&
      (r.fn === "Coordinator" || r.fn === "Reviewer"));
    admins.sort((a, b) => (a.fn === b.fn ? String(a.name).localeCompare(String(b.name)) : a.fn === "Coordinator" ? -1 : 1));
    return admins[0] || null;
  }

  /** Проверка маркера одобрения по свежему Notion и выданным кандидатам. */
  function validateProvisionMarker(obj, request, freshRows, cfg = provisionConfig()) {
    if (!obj || typeof obj !== "object") return { ok: false, reason: "маркер не разобран" };
    for (const banned of ["archive", "delete", "activate", "admin", "command"]) {
      if (banned in obj) return { ok: false, reason: `запрещённая команда маркера: ${banned}` };
    }
    const requestId = String(obj.request_id || "");
    if (!PROVISION_UUID.test(requestId)) return { ok: false, reason: "request_id не UUID" };
    if (norm(requestId) !== norm(request?.requestId || "")) return { ok: false, reason: "чужой request_id" };
    if (!Array.isArray(obj.jobs)) return { ok: false, reason: "jobs не массив" };
    if (obj.jobs.length > cfg.agentProvisionMaxJobs) return { ok: false, reason: "jobs больше agentProvisionMaxJobs" };
    const sent = new Map((request?.candidates || []).map((c) => [norm(c.rolePageId), c]));
    const fresh = new Map((freshRows || []).map((r) => [norm(r.pageId), r]));
    const jobs = [];
    for (const job of obj.jobs) {
      if (!job || typeof job !== "object") return { ok: false, reason: "job не объект" };
      for (const banned of ["archive", "delete", "activate", "admin", "command"]) {
        if (banned in job) return { ok: false, reason: `запрещённая команда в job: ${banned}` };
      }
      const pageId = String(job.role_page_id || "");
      if (!PROVISION_UUID.test(pageId)) return { ok: false, reason: "role_page_id не UUID" };
      const candidate = sent.get(norm(pageId));
      if (!candidate) return { ok: false, reason: "job вне кандидатов, отправленных в prompt" };
      if (!["create", "replace"].includes(job.action)) return { ok: false, reason: "action только create или replace" };
      const row = fresh.get(norm(pageId));
      if (!row) return { ok: false, reason: "строка роли исчезла" };
      if (row.agentAdmin === true) return { ok: false, reason: "попытка одобрить админ-роль" };
      if (String(row.name || "").trim() !== String(job.role_name || "").trim()) return { ok: false, reason: "role_name не совпадает со свежей строкой" };
      const repo = normalizeProvisionRepo(row.repo);
      if (!repo || repo !== normalizeProvisionRepo(job.repo)) return { ok: false, reason: "repo не совпадает со свежей строкой" };
      const allow = (cfg.agentProvisionRepoAllowlist || []).map(normalizeProvisionRepo);
      if (!allow.includes(repo)) return { ok: false, reason: "repo вне allowlist" };
      const freshAction = String(row.url || "").trim() ? "replace" : "create";
      if (job.action !== freshAction || job.action !== candidate.action) return { ok: false, reason: "action не совпадает с текущим Agent URL" };
      jobs.push({
        rolePageId: row.pageId, roleName: String(row.name).trim(), fn: row.fn, repo,
        action: job.action, oldAgentUrl: freshAction === "replace" ? String(row.url).trim() : "",
        roleAgentId: row.id || "",
      });
    }
    return { ok: true, jobs, reason: String(obj.reason || "").slice(0, 300) };
  }

  function provisionNewJob(candidate, requestId) {
    const at = nowIso();
    return {
      id: uid(), requestId, rolePageId: candidate.rolePageId, roleName: candidate.roleName,
      fn: candidate.fn, repo: candidate.repo, action: candidate.action,
      oldAgentUrl: candidate.oldAgentUrl || "", state: "validated", agentUrl: "",
      bootstrapMsgId: "", attempts: 0, createdAt: at, updatedAt: at, error: "",
    };
  }
  const provisionJobIndex = (state, job) => state.jobs.findIndex((j) => norm(j.id) === norm(job.id));
  function provisionSaveJob(job) {
    const state = provisionState();
    const next = { ...job, updatedAt: nowIso() };
    const at = provisionJobIndex(state, next);
    if (at === -1) state.jobs.push(next);
    else state.jobs[at] = next;
    state.jobs = state.jobs.slice(-100);
    saveProvisionState(state);
    return next;
  }
  function provisionActiveJob() {
    const request = provisionRequestState();
    if (!request || !Array.isArray(request.jobIds)) return null;
    const state = provisionState();
    for (const id of request.jobIds) {
      const job = state.jobs.find((j) => norm(j.id) === norm(id));
      if (job && !["done", "error"].includes(job.state)) return job;
    }
    return null;
  }
