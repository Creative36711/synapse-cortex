  // ───────────────────────── provisioning: запрос → одобрение → job ─────────────────────────
  // Контур не пишет K.pending/K.expect и не создаёт страницы Notion. Запрос
  // уходит админ-роли напрямую; создание начинается только после маркера
  // CF_AGENT_PROVISION_RESULT с выданным request_id.

  let provisionRunning = false;

  function provisionLog(text, error = false, options = {}) {
    log(text, error, { ntfy: "quiet", title: "Relay: provisioning", ...options });
  }
  function provisionPause(reason, request, job, extra = {}) {
    const fields = {
      requestId: request?.requestId || "", jobId: job?.id || "",
      rolePageId: job?.rolePageId || "", repo: job?.repo || "",
      step: job?.state || request?.state || "", reason,
    };
    provisionEvent(extra.event || "provision_paused", fields);
    if (job) {
      job.state = extra.jobState || "paused";
      job.error = reason;
      provisionSaveJob(job);
    }
    if (request) {
      request.state = "paused";
      request.error = reason;
      saveProvisionRequest(request);
    }
    autoSet(false);
    pause(reason, { kind: "provision", ref: job?.rolePageId || request?.requestId || "", ...extra.pause });
    return true;
  }

  async function provisionFreshRole(pageId) {
    try {
      const page = await notion("GET", `pages/${pageId}`);
      return page && !page.archived ? mapRoleRow(page) : null;
    } catch (error) {
      if (/404|object_not_found|не найден/i.test(String(error?.message || error))) return null;
      throw error;
    }
  }

  async function provisionBusyContext() {
    const names = new Set();
    const ids = new Set();
    const cards = await query(C.requests, {
      or: [
        { property: "Dispatch State", select: { equals: "Running" } },
        { property: "Dispatch State", select: { equals: "Submitted" } },
      ],
    });
    for (const card of cards) {
      const name = taskRole(card);
      if (name) names.add(norm(name));
      const recipient = rt(card.properties?.["Recipient Agent ID"]);
      if (recipient) ids.add(norm(recipient));
    }
    const pending = GM_getValue(K.pending, null);
    const expect = GM_getValue(K.expect, null);
    for (const turn of [pending, expect]) {
      if (!turn) continue;
      if (turn.roleName) names.add(norm(turn.roleName));
      if (turn.roleId) ids.add(norm(turn.roleId));
      if (turn.ref) ids.add(norm(turn.ref));
    }
    return { names, ids, cards };
  }

  function provisionIdleReason(cfg = provisionConfig()) {
    if (!cfg.agentProvisionEnabled) return "provisioning выключен";
    if (!C.notion) return "нет Notion-токена профиля";
    if (GM_getValue(K.paused, "")) return "цикл на паузе";
    if (GM_getValue(K.pending, null) || GM_getValue(K.expect, null)) return "активный командный ход";
    if (GM_getValue(K.pilotWait, null)) return "идёт пилот";
    if (provisionRequestState()) return "provisioning-запрос уже выдан";
    if (provisionLockHeldByOther()) return "provisioning занят другой вкладкой";
    if (!provisionBootstrapClean(cfg.agentBootstrapPrompt)) return "bootstrap-пробник пуст или запрещён";
    if (!provisionDailyAllow(cfg)) return "суточный лимит provisioning";
    return "";
  }

  async function provisionGather(cfg = provisionConfig()) {
    const rows = await rolesFresh();
    const busy = await provisionBusyContext();
    const { candidates, rejected } = provisionCandidates(rows, cfg, busy);
    const admin = provisionAdminRole(rows);
    return { rows, busy, candidates, rejected, admin };
  }

  /** Выдать запрос админ-роли. Вызывается кнопкой или холостым автоциклом. */
  async function provisionStartRequest({ auto = false } = {}) {
    const cfg = provisionConfig();
    const why = provisionIdleReason(cfg);
    if (why) { provisionLog(`Запрос не выдан: ${why}.`); return false; }
    const { candidates, rejected, admin } = await provisionGather(cfg);
    for (const item of rejected) provisionEvent("provision_noop", { rolePageId: item.rolePageId, reason: item.reason });
    if (!admin) {
      pause("Provisioning: нет активной админ-роли (Agent Admin=true, Coordinator/Reviewer). Создайте или включите админ-роль вручную.", { kind: "provision-no-admin" });
      provisionEvent("provision_paused", { reason: "provision-no-admin" });
      return false;
    }
    if (!candidates.length) { provisionEvent("provision_noop", { reason: "нет кандидатов" }); return false; }
    const requestId = uid();
    const request = {
      requestId, state: "prepared", auto, resumeAuto: autoOn(),
      adminPageId: admin.pageId, adminAgentId: admin.id, adminRoleName: admin.name,
      adminFn: admin.fn, adminUrl: admin.url, candidates,
      jobIds: [], createdAt: nowIso(), updatedAt: nowIso(), watermark: "", seen: [],
    };
    saveProvisionRequest(request);
    provisionAcquireLock(requestId, request.resumeAuto);
    autoSet(false);
    provisionLog(`Provisioning: запрос ${requestId} подготовлен для админ-роли «${admin.name}», кандидатов ${candidates.length}.`);
    if (provisionCurrentAgentUuid() !== String(admin.id).toLowerCase()) {
      location.assign(admin.url);
      return true;
    }
    return provisionSendRequest(request);
  }

  async function provisionSendRequest(request) {
    const cfg = provisionConfig();
    const admin = await provisionFreshRole(request.adminPageId);
    if (!admin || admin.agentAdmin !== true || admin.status !== "Активна") {
      return provisionPause("Provisioning: адресат запроса больше не активная админ-роль.", request, null);
    }
    if (provisionCurrentAgentUuid() !== String(admin.id).toLowerCase()) { location.assign(admin.url); return true; }
    const compiled = PromptCompiler.compile({
      kind: "provision", role: { fn: request.adminFn, name: request.adminRoleName },
      provision: { requestId: request.requestId, candidates: request.candidates, maxJobs: cfg.agentProvisionMaxJobs },
      delivery: { tier: "full" },
    });
    if (!compiled.ok) return provisionPause(`Provisioning prompt не собран: ${compiled.error?.message || compiled.error?.code}`, request, null);
    const ready = await ensureComposer(C.pageWaitMs);
    if (!ready?.editor) return provisionPause("Provisioning: поле ввода админ-роли не появилось.", request, null);
    if (!writePrompt(ready.editor, compiled.text)) return provisionPause("Provisioning: не удалось вставить запрос админ-роли.", request, null);
    request.watermark = lastMessageId();
    request.seen = messages().map(nodeId);
    request.state = "sending";
    saveProvisionRequest(request);
    const sent = await deliver(ready.editor, compiled.text);
    if (!sent?.ok) return provisionPause("Provisioning: запрос админ-роли не доставлен.", request, null);
    request.state = "awaiting";
    request.sentAt = nowIso();
    saveProvisionRequest(request);
    provisionEvent("provision_request_sent", { requestId: request.requestId, rolePageId: request.adminPageId, step: "awaiting" });
    provisionLog(`Provisioning: запрос ${request.requestId} отправлен админ-роли «${request.adminRoleName}». Жду маркер одобрения.`);
    return true;
  }

  async function provisionConsumeApproval(request) {
    const cfg = provisionConfig();
    if (provisionCurrentAgentUuid() !== String(request.adminAgentId).toLowerCase()) { location.assign(request.adminUrl); return true; }
    if (captchaDialog()) return provisionPause("Provisioning: капча на странице админ-роли.", request, null);
    if (detectToolCallLimit()) return provisionPause("Provisioning: tool-call limit у админ-роли; продолжение запроса не поддерживается.", request, null);
    const visibleError = detectVisibleErrorCard();
    if (visibleError) return provisionPause(`Provisioning: ошибка Arena у админ-роли: ${visibleError.text || visibleError}`, request, null);
    const admin = await provisionFreshRole(request.adminPageId);
    if (!admin || admin.agentAdmin !== true || admin.status !== "Активна") {
      return provisionPause("Provisioning: право одобрения потеряно (Agent Admin/Статус изменились).", request, null);
    }
    const replies = messagesAfter(request.watermark, request.seen);
    const hit = replies.map((m) => ({ m, obj: parseMarker(m.raw, "CF_AGENT_PROVISION_RESULT") })).filter((x) => x.obj).at(-1);
    if (!hit) return true; // ждём ответ админ-роли, автоцикл выключен
    const fresh = await rolesFresh();
    const verdict = validateProvisionMarker(hit.obj, request, fresh, cfg);
    if (!verdict.ok) {
      provisionEvent("provision_rejected", { requestId: request.requestId, reason: verdict.reason });
      return provisionPause(`Provisioning: маркер одобрения отклонён — ${verdict.reason}.`, request, null);
    }
    request.state = "approved";
    request.approvedAt = nowIso();
    request.approvalReason = verdict.reason;
    request.approvedJobs = verdict.jobs;
    saveProvisionRequest(request);
    provisionEvent("provision_approved", { requestId: request.requestId, rolePageId: request.adminPageId, reason: verdict.reason || `jobs ${verdict.jobs.length}` });
    provisionLog(`Provisioning: одобрено jobs ${verdict.jobs.length}.`);
    if (!verdict.jobs.length) return provisionFinishRequest(request, "одобрено 0 jobs");
    return true;
  }

  async function provisionEnsureRecipientOption(roleName) {
    const ds = await notion("GET", `data_sources/${C.requests}`);
    const prop = ds?.properties?.["Кому"];
    if (!prop || prop.type !== "select") throw new Error("в «Запросах» нет select-поля «Кому»");
    const options = Array.isArray(prop.select?.options) ? prop.select.options : [];
    if (options.some((o) => norm(o.name) === norm(roleName))) return true;
    const next = [...options.map((o) => ({ id: o.id, name: o.name, color: o.color })), { name: roleName }];
    await notion("PATCH", `data_sources/${C.requests}`, { properties: { "Кому": { select: { options: next } } } });
    return true;
  }

  async function provisionActivationBlockReason(job, cfg) {
    const rows = await rolesFresh();
    const row = rows.find((r) => norm(r.pageId) === norm(job.rolePageId));
    if (!row) return "строка роли исчезла";
    if (row.agentAdmin === true) return "админ-роль не активируется provisioning";
    if (norm(row.url) !== norm(job.agentUrl)) return "Agent URL в Notion не равен новому";
    if (normalizeProvisionRepo(row.repo) !== job.repo) return "repo роли изменился";
    const item = provisionFindSidebarItem(provisionAgentUuid(job.agentUrl));
    if (!item || provisionText(item) !== job.roleName) return "имя sidebar не равно роли";
    const busy = await provisionBusyContext();
    if (busy.names.has(norm(job.roleName)) || busy.ids.has(norm(job.roleAgentId)) || busy.ids.has(norm(job.rolePageId))) {
      return "по роли есть активная работа";
    }
    const active = rows.filter((r) => r.status === "Активна" && r.url);
    if (job.fn === "Coordinator" && active.some((r) => r.fn === "Coordinator" && norm(r.pageId) !== norm(job.rolePageId))) {
      return "уже есть активный Coordinator";
    }
    const reviewers = active.filter((r) => r.fn === "Reviewer" && norm(r.pageId) !== norm(job.rolePageId));
    if (!reviewers.length && job.fn !== "Reviewer") return "не остаётся активного Reviewer";
    if (["Executor", "Auditor", "Auditory"].includes(job.fn)) {
      try { await provisionEnsureRecipientOption(job.roleName); }
      catch (error) { return `не удалось добавить «Кому»: ${error.message}`; }
    }
    return "";
  }

  async function provisionPatchNotion(job, request) {
    const row = await provisionFreshRole(job.rolePageId);
    if (!row) return provisionPause("Provisioning: строка роли исчезла до записи Notion.", request, job, { event: "provision_conflict" });
    if (row.agentAdmin === true) return provisionPause("Provisioning: попытка записать админ-роль.", request, job, { event: "provision_conflict" });
    const currentUrl = String(row.url || "").trim();
    const newUrl = job.agentUrl;
    if (currentUrl && norm(currentUrl) !== norm(newUrl) && norm(currentUrl) !== norm(job.oldAgentUrl)) {
      return provisionPause("Provisioning: Agent URL уже изменён другим процессом (conflict).", request, job, { event: "provision_conflict" });
    }
    if (row.status === "Активна" && currentUrl && norm(currentUrl) !== norm(newUrl)) {
      return provisionPause("Provisioning: роль уже активна с другим Agent URL.", request, job, { event: "provision_conflict" });
    }
    if (row.agentState === "не требуется") {
      return provisionPause("Provisioning: Agent State больше не запрошен.", request, job, { event: "provision_conflict" });
    }
    const alreadyUrl = norm(currentUrl) === norm(newUrl);
    const props = {
      "Agent State": { select: { name: "создан" } },
      "Agent Job ID": { rich_text: richText(job.id) },
      "Agent Created At": { date: { start: nowIso() } },
    };
    if (!alreadyUrl) props["Agent URL"] = { url: newUrl };
    if (job.action === "replace" && job.oldAgentUrl) props["Previous Agent URL"] = { url: job.oldAgentUrl };
    if (!(row.status === "Активна" && alreadyUrl)) await patch(job.rolePageId, props);
    provisionEvent("provision_notion_updated", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "notion_updated" });
    job.state = "notion_updated";
    provisionSaveJob(job);
    return false;
  }

  async function provisionArchiveOld(job, request) {
    const cfg = provisionConfig();
    if (job.action !== "replace" || !cfg.agentProvisionArchiveOld || !job.oldAgentUrl) {
      job.state = "done"; provisionSaveJob(job);
      provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
      return false;
    }
    const oldUuid = provisionAgentUuid(job.oldAgentUrl);
    const newUuid = provisionAgentUuid(job.agentUrl);
    if (!oldUuid || oldUuid === newUuid) {
      return provisionPause("Provisioning: старый Agent URL не отличим от нового; архив не выполняется.", request, job, { event: "provision_conflict" });
    }
    if (provisionCurrentAgentUuid() !== oldUuid) {
      job.state = "archiving_old"; provisionSaveJob(job);
      location.assign(job.oldAgentUrl);
      return true;
    }
    job.state = "archiving_old"; provisionSaveJob(job);
    const result = await provisionArchiveAgent(oldUuid);
    if (result.archived) {
      provisionEvent("provision_old_archived", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "archiving_old" });
    } else {
      provisionEvent("provision_old_archive_unverified", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "archiving_old", reason: result.reason });
      provisionLog(`Provisioning: архив старого агента не подтверждён (${result.reason}). Замена не откатывается; проверьте старый чат вручную.`, true, { ntfy: "normal" });
    }
    job.state = "done"; provisionSaveJob(job);
    provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
    return false;
  }

  async function provisionAdvanceJob(job, request) {
    const cfg = provisionConfig();
    const uuid = provisionAgentUuid(job.agentUrl);
    if (captchaDialog()) return provisionPause("Provisioning: капча Arena.", request, job);
    if (detectToolCallLimit()) return provisionPause("Provisioning: tool-call limit на bootstrap; продолжение не поддерживается.", request, job);
    const visibleError = detectVisibleErrorCard();
    if (visibleError) return provisionPause(`Provisioning: ошибка Arena: ${visibleError.text || visibleError}`, request, job);

    if (["validated", "creating"].includes(job.state)) {
      if (GM_getValue(K.pending, null) || GM_getValue(K.expect, null)) {
        return provisionPause("Provisioning: появился активный командный ход; создание не начинаю.", request, job);
      }
      if (!provisionDailyAllow(cfg)) return provisionPause("Provisioning: суточный лимит создания агентов.", request, job);
      if (!provisionBootstrapClean(cfg.agentBootstrapPrompt)) return provisionPause("Provisioning: bootstrap-пробник пуст или запрещён.", request, job);
      const row = await provisionFreshRole(job.rolePageId);
      if (!row || row.agentAdmin === true || !["запрошен", "создаётся"].includes(row.agentState)) {
        return provisionPause("Provisioning: строка роли изменилась до создания.", request, job, { event: "provision_conflict" });
      }
      if (provisionCurrentAgentUuid()) {
        // Новая сессия создаётся только с /agent. Если вкладка уже в чужом
        // чате, не переиспользуем его и не архивируем.
        job.state = "creating"; provisionSaveJob(job);
        location.assign(location.origin + "/agent");
        return true;
      }
      job.state = "creating"; provisionSaveJob(job);
      const selected = await provisionSelectRepository(job.repo, cfg);
      provisionEvent("provision_repo_selected", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "repo_selected", reason: selected.alreadySelected ? "already" : `attempts ${selected.attempts}` });
      job.state = "repo_selected"; provisionSaveJob(job);
    }

    if (job.state === "repo_selected") {
      const ready = await ensureComposer(C.pageWaitMs);
      if (!ready?.editor) return provisionPause("Provisioning: composer новой сессии не появился.", request, job);
      if (!writePrompt(ready.editor, cfg.agentBootstrapPrompt)) return provisionPause("Provisioning: bootstrap-пробник не вставлен.", request, job);
      job.bootstrapMsgId = lastMessageId();
      job.bootstrapSeen = messages().map(nodeId);
      job.bootstrapStartedAt = Date.now();
      job.urlWaitStartedAt = Date.now();
      job.state = "bootstrap_sent";
      provisionSaveJob(job); // до deliver: перезагрузка не должна создать вторую сессию
      const sent = await deliver(ready.editor, cfg.agentBootstrapPrompt);
      if (!sent?.ok) return provisionPause("Provisioning: bootstrap-пробник не доставлен.", request, job);
      provisionEvent("provision_bootstrap_sent", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "bootstrap_sent" });
    }

    if (job.state === "bootstrap_sent") {
      if (!job.agentUrl) {
        const current = provisionCurrentAgentUuid();
        if (current) {
          job.agentUrl = `${location.origin}/agent/${current}`;
          job.state = "url_captured";
          job.urlCapturedAt = Date.now();
          provisionSaveJob(job); // URL сохраняется до rename/Notion
          provisionEvent("provision_url_captured", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "url_captured" });
        } else {
          if (Date.now() - Number(job.urlWaitStartedAt || Date.now()) > cfg.agentUrlWaitMs) {
            return provisionPause("Provisioning: URL новой сессии не появился за agentUrlWaitMs.", request, job);
          }
          return true;
        }
      } else {
        // Восстановление после перезагрузки: URL уже захвачен, вторую сессию
        // не создаём и bootstrap повторно не отправляем.
        job.state = "url_captured";
        provisionSaveJob(job);
      }
    }

    if (job.state === "url_captured") {
      if (provisionCurrentAgentUuid() !== provisionAgentUuid(job.agentUrl)) { location.assign(job.agentUrl); return true; }
      const waited = Date.now() - Number(job.bootstrapStartedAt || Date.now());
      if (waited > cfg.agentBootstrapWaitMs) return provisionPause("Provisioning: bootstrap не завершился за agentBootstrapWaitMs.", request, job);
      if (stillWorking()) return true;
      const replies = messagesAfter(job.bootstrapMsgId, job.bootstrapSeen || []);
      if (!replies.length) return true; // смысл ответа не проверяем, нужен факт нового assistant
      job.state = "renaming"; provisionSaveJob(job);
    }

    if (job.state === "renaming") {
      try {
        await provisionRenameAgent(provisionAgentUuid(job.agentUrl), job.roleName, cfg);
      } catch (error) {
        return provisionPause(`Provisioning: rename не удался (${error.message}). URL сохранён, новая сессия не создаётся.`, request, job, { jobState: "paused" });
      }
      provisionEvent("provision_renamed", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "renamed" });
      job.state = "renamed"; provisionSaveJob(job);
    }

    if (job.state === "renamed") {
      const paused = await provisionPatchNotion(job, request);
      if (paused) return true;
    }

    if (job.state === "notion_updated") {
      if (!cfg.agentProvisionAutoActivate) {
        provisionEvent("provision_activation_blocked", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activating", reason: "autoActivate выключен" });
        job.state = "done"; provisionSaveJob(job);
        provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
        return false;
      }
      job.state = "activating"; provisionSaveJob(job);
      const block = await provisionActivationBlockReason(job, cfg);
      if (block) {
        provisionEvent("provision_activation_blocked", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activating", reason: block });
        return provisionPause(`Provisioning: автоактивация заблокирована — ${block}. URL записан, Статус остаётся прежним.`, request, job, { jobState: "paused" });
      }
      const freshRow = await provisionFreshRole(job.rolePageId);
      if (!freshRow || freshRow.status !== "Активна") {
        await patch(job.rolePageId, { "Статус": { select: { name: "Активна" } } });
      }
      provisionEvent("provision_activated", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activated" });
      job.state = "activated"; provisionSaveJob(job);
    }

    if (job.state === "activated") {
      return provisionArchiveOld(job, request);
    }
    if (job.state === "archiving_old") {
      return provisionArchiveOld(job, request);
    }
    if (job.state === "done") return false;
    return true;
  }

  async function provisionRunNextJob(request) {
    const state = provisionState();
    const active = provisionActiveJob();
    if (active) return provisionAdvanceJob(active, request);
    const nextCandidate = (request.approvedJobs || []).find((c) =>
      !state.jobs.some((j) => norm(j.requestId) === norm(request.requestId) && norm(j.rolePageId) === norm(c.rolePageId) && j.state === "done"));
    if (!nextCandidate) return provisionFinishRequest(request, "все jobs завершены");
    const existing = state.jobs.find((j) => norm(j.requestId) === norm(request.requestId) && norm(j.rolePageId) === norm(nextCandidate.rolePageId));
    let job = existing;
    if (!job) {
      if (!provisionDailyAllow()) return provisionPause("Provisioning: суточный лимит создания агентов.", request, null);
      job = provisionNewJob(nextCandidate, request.requestId);
      provisionSaveJob(job);
      request.jobIds = [...(request.jobIds || []), job.id];
      saveProvisionRequest(request);
      provisionDailyConsume();
      provisionEvent("provision_job_started", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "validated" });
      provisionLog(`Provisioning: job ${job.id} — ${job.action} «${job.roleName}» (${job.repo}).`);
    }
    return provisionAdvanceJob(job, request);
  }

  async function provisionFinishRequest(request, reason) {
    provisionEvent("provision_job_done", { requestId: request.requestId, step: "request", reason });
    const state = provisionState();
    state.history = [...state.history, { requestId: request.requestId, at: nowIso(), reason, jobs: request.jobIds || [] }].slice(-50);
    saveProvisionState(state);
    const resume = request.resumeAuto === true && !GM_getValue(K.paused, "");
    saveProvisionRequest(null);
    provisionReleaseLock();
    if (resume) autoSet(true);
    provisionLog(`Provisioning: запрос ${request.requestId} завершён (${reason}). Автоцикл ${resume ? "восстановлен" : "остаётся выключенным"}.`);
    return false;
  }

  /** Ранний вход tick. Не трогает K.pending/K.expect. */
  async function consumeProvision() {
    if (provisionRunning) return true;
    const cfg = provisionConfig();
    if (!cfg.agentProvisionEnabled) return false;
    if (provisionLockHeldByOther()) return Boolean(provisionRequestState());
    const request = provisionRequestState();
    provisionRunning = true;
    try {
      if (!request) {
        if (cfg.agentProvisionMode !== "auto" || !autoOn()) return false;
        const why = provisionIdleReason(cfg);
        if (why) return false;
        return await provisionStartRequest({ auto: true });
      }
      if (request.state === "prepared") return await provisionSendRequest(request);
      if (request.state === "sending") {
        return provisionPause("Provisioning: отправка запроса прервана; повторять запрос без проверки Мастера нельзя.", request, null);
      }
      if (request.state === "awaiting") return await provisionConsumeApproval(request);
      if (request.state === "approved") return await provisionRunNextJob(request);
      if (request.state === "paused") return true;
      if (request.state === "done") return await provisionFinishRequest(request, "done");
      return false;
    } catch (error) {
      return provisionPause(`Provisioning: ${error.message || error}`, request, provisionActiveJob());
    } finally {
      provisionRunning = false;
    }
  }

  /** Отмена ещё не одобренного запроса (кнопка UI). Активные jobs не отменяет. */
  function provisionCancelRequest() {
    const request = provisionRequestState();
    if (!request || !["prepared", "sending", "awaiting"].includes(request.state)) return false;
    provisionEvent("provision_rejected", { requestId: request.requestId, reason: "отменено Мастером" });
    const resume = request.resumeAuto === true && !GM_getValue(K.paused, "");
    saveProvisionRequest(null);
    provisionReleaseLock();
    if (resume) autoSet(true);
    return true;
  }
