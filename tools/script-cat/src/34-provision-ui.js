  // ───────────────────────── provisioning: диалог Мастера ─────────────────────────

  async function provisionOpenDialog() {
    if (typeof projectApproved === "function" && !projectApproved()) {
      log("Provisioning: проект ещё не разрешён к работе.", true); return;
    }
    document.getElementById("cfn-provision-dialog")?.remove();
    const cfg = provisionConfig();
    const box = document.createElement("div");
    box.id = "cfn-provision-dialog";
    box.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center";
    const card = document.createElement("div");
    card.style.cssText = "width:min(720px,94vw);max-height:88vh;overflow:auto;background:#15171c;color:#e7eaee;border:1px solid #2b2f38;border-radius:10px;padding:16px;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace";
    card.innerHTML = `<h3 style="margin:0 0 8px">🤖 Provisioning Arena-агентов</h3><div id="cfn-provision-body">Читаю свежие роли…</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button id="cfn-provision-request" style="padding:6px 10px">Запросить создание/замену</button>
        <button id="cfn-provision-cancel" style="padding:6px 10px">Отменить запрос</button>
        <button id="cfn-provision-close" style="padding:6px 10px">Закрыть</button>
      </div>`;
    box.appendChild(card);
    document.body.appendChild(box);
    const body = card.querySelector("#cfn-provision-body");
    const requestBtn = card.querySelector("#cfn-provision-request");
    const cancelBtn = card.querySelector("#cfn-provision-cancel");
    card.querySelector("#cfn-provision-close").onclick = () => box.remove();
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    requestBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const request = provisionRequestState();
      const state = provisionState();
      const active = provisionActiveJob();
      let html = `<div style="color:#aab4c3">enabled=${cfg.agentProvisionEnabled} mode=${cfg.agentProvisionMode} allowlist=${cfg.agentProvisionRepoAllowlist.length} maxJobs=${cfg.agentProvisionMaxJobs} dailyMax=${cfg.agentProvisionDailyMax} bootstrap=${provisionBootstrapClean(cfg.agentBootstrapPrompt) ? "ok" : "пуст/запрещён"}</div>`;
      if (request) {
        html += `<div style="margin-top:8px">Запрос ${escapeHtml(request.requestId)}: ${escapeHtml(request.state)}; админ «${escapeHtml(request.adminRoleName || "")}»; jobs ${(request.jobIds || []).length}.</div>`;
        cancelBtn.disabled = !["prepared", "sending", "awaiting"].includes(request.state);
      }
      if (active) html += `<div style="margin-top:6px">Активный job ${escapeHtml(active.id)}: ${escapeHtml(active.state)} «${escapeHtml(active.roleName)}» ${escapeHtml(active.repo)}${active.agentUrl ? ` URL ${escapeHtml(active.agentUrl)}` : ""}.</div>`;
      if (!cfg.agentProvisionEnabled) {
        html += `<p>Provisioning выключен в профиле. Включите его в управлении проектами и задайте allowlist/bootstrap.</p>`;
        body.innerHTML = html;
        return;
      }
      const { candidates, rejected, admin } = await provisionGather(cfg);
      html += `<div style="margin-top:8px">Админ-роль: ${admin ? `«${escapeHtml(admin.name)}» (${escapeHtml(admin.fn)})` : "<b>нет активной админ-роли</b>"}.</div>`;
      if (candidates.length) {
        html += `<table style="width:100%;border-collapse:collapse;margin-top:8px"><tr><th align="left">Роль</th><th align="left">Функция</th><th align="left">Repo</th><th align="left">Action</th></tr>`;
        for (const c of candidates) html += `<tr><td>${escapeHtml(c.roleName)}</td><td>${escapeHtml(c.fn)}</td><td>${escapeHtml(c.repo)}</td><td>${escapeHtml(c.action)}</td></tr>`;
        html += `</table>`;
      } else html += `<p>Кандидатов нет. Нужны строки с Agent State=запрошен, не админ, repo в allowlist, без активной работы.</p>`;
      if (rejected.length) html += `<div style="margin-top:8px;color:#ffd479">Отклонено: ${rejected.map((r) => `${escapeHtml(r.rolePageId)} — ${escapeHtml(r.reason)}`).join("; ")}</div>`;
      const idle = provisionIdleReason(cfg);
      if (idle) html += `<div style="margin-top:8px;color:#ffd479">Запрос сейчас не будет выдан: ${escapeHtml(idle)}.</div>`;
      const journal = state.journal.slice(-8).map((e) => `${escapeHtml(e.at)} ${escapeHtml(e.event)} ${escapeHtml(e.reason || e.step || "")}`).join("<br>");
      if (journal) html += `<div style="margin-top:10px;color:#aab4c3;font-size:12px">${journal}</div>`;
      body.innerHTML = html;
      requestBtn.disabled = Boolean(idle) || !candidates.length || !admin || Boolean(request);
      requestBtn.onclick = async () => {
        if (!confirm(`Выдать запрос админ-роли «${admin.name}» на ${candidates.length} кандидат(ов)? Создание начнётся только после маркера одобрения.`)) return;
        requestBtn.disabled = true;
        box.remove();
        await provisionStartRequest({ auto: false });
      };
      cancelBtn.onclick = () => {
        if (provisionCancelRequest()) { log("Provisioning: запрос отменён Мастером."); box.remove(); }
      };
    } catch (error) {
      body.textContent = `Не удалось прочитать кандидатов: ${error.message || error}`;
    }
  }
