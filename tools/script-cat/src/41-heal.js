  // ───────────────────────── самовосстановление: шаги ─────────────────────────
  // Правила (класс, маршрут, предохранители, гейт версии, телеметрия) живут в
  // 40-heal-core.js и проверяются чистым исполнением. Здесь только то, что нельзя
  // проверить без сети и DOM: выгрузка наружу, разговор с Maintainer'ом и
  // продолжение хода. Ни один шаг этого файла не ослабляет оракул: «приём без
  // маркера» и штатные остановки (вопрос, план, пилот, приёмка, предел доработок)
  // в маршрут восстановления не попадают вовсе — у них класс `master`.

  const heartbeatKey = () => K.heartbeat;

  /** Состояние самовосстановления: счётчики по инциденту + какая сборка сломалась. */
  function healState() {
    const raw = GM_getValue(K.heal, null);
    const state = raw && typeof raw === "object" ? raw : {};
    return {
      ...state,
      incident: state.incident && typeof state.incident === "object" ? state.incident : {},
    };
  }

  function saveHealState(next) {
    // Больше 20 инцидентов не храним: это счётчики, а не история.
    const incidents = Object.entries(next.incident || {}).slice(-20);
    GM_setValue(K.heal, { ...next, incident: Object.fromEntries(incidents) });
  }

  /** Счётчики этого инцидента; заодно продлеваем его в конце списка. */
  function healCounters(key) {
    const state = healState();
    const found = state.incident[key] || {};
    const counters = {
      retries: Math.max(0, Number(found.retries) || 0),
      escalations: Math.max(0, Number(found.escalations) || 0),
      firstAt: found.firstAt || nowIso(),
      lastAt: found.lastAt || "",
    };
    state.incident = { ...state.incident, [key]: counters };
    saveHealState(state);
    return counters;
  }

  function healBump(key, field) {
    const state = healState();
    const found = state.incident[key] || { retries: 0, escalations: 0, firstAt: nowIso() };
    found[field] = Math.max(0, Number(found[field]) || 0) + 1;
    found.lastAt = nowIso();
    state.incident = { ...state.incident, [key]: found };
    saveHealState(state);
    return found;
  }

  /** Журнал попыток доставки как состав (без текста промптов). */
  function healJournal() {
    const raw = GM_getValue("cfn-prompt-journal-v1", []);
    return Array.isArray(raw) ? raw.slice(-200) : [];
  }

  /**
   * Структурный снимок страницы.
   *
   * Это не переписка: считаются элементы, длины и признаки состояния. Тексты
   * реплик не выгружаются — только их количество, id последнего и длина.
   */
  function healPageSnapshot() {
    const count = (sel) => {
      try { return document.querySelectorAll(sel).length; } catch { return 0; }
    };
    const editor = (() => { try { return composer(); } catch { return null; } })();
    const last = (() => { try { return lastMessageId() || ""; } catch { return ""; } })();
    const msgs = (() => { try { return messages(); } catch { return []; } })();
    const tails = msgs.slice(-3).map((node) => {
      const text = (() => { try { return messageText(node); } catch { return ""; } })();
      return { id: String(node.id || "").replace("chat-message-", ""), chars: String(text || "").length };
    });
    return healRedactTree({
      url: location.href,
      path: location.pathname,
      origin: location.origin,
      roleFromPath: (() => { try { return roleFromPath() || ""; } catch { return ""; } })(),
      title: document.title,
      readyState: String(document.readyState || ""),
      messages: msgs.length,
      lastMessageId: last,
      tail: tails,
      editor: {
        found: Boolean(editor),
        covered: editor ? (() => { try { return elementCovered(editor); } catch { return null; } })() : null,
        textLength: editor ? (() => { try { return composerText(editor).length; } catch { return 0; } })() : 0,
      },
      generating: (() => { try { return generating(); } catch { return false; } })(),
      busy: (() => { try { return busyReason()?.kind || ""; } catch { return ""; } })(),
      counts: {
        buttons: count("button, [role=\"button\"]"),
        alerts: count("[role=\"alert\"]"),
        statuses: count("[role=\"status\"]"),
        transcripts: count("[data-agent-transcript-message=\"true\"]"),
        userMessages: count("[data-user-message-layout=\"true\"]"),
        prose: count(".prose"),
        textarea: count("textarea"),
        contenteditable: count("[contenteditable=\"true\"]"),
        dialogs: count("[role=\"dialog\"]"),
      },
      captcha: (() => { try { return Boolean(captchaDialog()); } catch { return false; } })(),
      skipCard: (() => { try { return Boolean(skipCardButton()); } catch { return false; } })(),
      panels: (() => { try { return completionPanels().length; } catch { return 0; } })(),
      diagnostics: (() => { try { return composerDiagnostics(); } catch { return null; } })(),
    });
  }

  /** Имя выгрузки по схеме D-031: <МИССИЯ>__<КАРТОЧКА>__<вид>__<дата|SHA>. */
  function healArtifactName(info = {}, at = new Date()) {
    const mission = (() => {
      try {
        const row = GM_getValue(K.rolesCache, null);
        const rows = Array.isArray(row) ? row : row?.rows || [];
        const path = roleFromPath();
        const hit = rows.find((r) => norm(r.id) === norm(path));
        return hit?.id || "";
      } catch { return ""; }
    })();
    const card = String(info.ref || "").trim();
    const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    const day = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`;
    const kind = String(info.kind || "pause").replace(/[^A-Za-z0-9-]/g, "").slice(0, 24) || "pause";
    const tag = isUuid(card) ? card : `turn-${kind}`;
    // Миссию в имени передаём только когда она похожа на D-031; иначе шлюз
    // откажет по имени, а телеметрия не должна теряться из-за формата.
    if (mission && /^[A-Za-z][A-Za-z0-9]{0,15}-[A-Za-z0-9][A-Za-z0-9-]{0,15}$/.test(mission) && isUuid(card)) {
      return { name: `${mission}__${tag}__logs__${day}.json`, subdir: mission };
    }
    return { name: `manual__${String(C.driveFolder || "project").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 20) || "project"}__heal-${kind}__${day}.json`, subdir: "" };
  }

  /**
   * Выгрузка наружу: Drive (шлюз проекта) и GitHub (если есть токен).
   *
   * Идемпотентно: повтор с тем же содержимым — `duplicate`, а не второй файл.
   * Отказ выгрузки не меняет решение по ходу: он попадает в журнал.
   */
  async function healUpload(payload, info = {}) {
    const text = JSON.stringify(payload, null, 2);
    const out = { drive: null, github: null, bytes: healByteLength(text) };
    const name = healArtifactName(info);
    try {
      const saved = await gateway("saveArtifact", "", {
        name: name.name, content: text, encoding: "utf8", ...(name.subdir ? { subdir: name.subdir } : {}),
      });
      out.drive = { ok: true, fileId: String(saved?.fileId || ""), name: name.name, duplicate: Boolean(saved?.duplicate) };
    } catch (e) {
      out.drive = { ok: false, name: name.name, error: String((e && e.message) || e).slice(0, 200) };
    }
    const token = GM_getValue(K.ghToken, "");
    const repo = String(C.repo || "");
    if (!token || !repo) {
      out.github = { ok: false, skipped: !token ? "нет GitHub-токена" : "нет репозитория проекта" };
    } else {
      try {
        const path = `telemetry/${name.name.replace(/\.json$/, "")}__${String(payload.script?.fingerprint || "") || "nofp"}.json`;
        const res = await request("PUT", `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`,
          githubHeaders(token),
          {
            message: `telemetry: ${info.kind || "pause"} ${info.ref || ""}`.slice(0, 120),
            content: (() => {
              // btoa не берёт кириллицу: сначала байты UTF-8.
              const bytes = new TextEncoder().encode(text);
              let bin = "";
              for (const byte of bytes) bin += String.fromCharCode(byte);
              return btoa(bin);
            })(),
          });
        out.github = { ok: true, path, sha: String(res?.content?.sha || "") };
      } catch (e) {
        out.github = { ok: false, path: "", error: String((e && e.message) || e).slice(0, 200) };
      }
    }
    return out;
  }

  /** Полный цикл выгрузки: собрать (с усечением под лимит) и отправить. */
  async function healPublish(phase, info, verdict) {
    const built = buildHealTelemetry({
      phase,
      at: nowIso(),
      version: SCRIPT_VERSION,
      fingerprint: C.buildFingerprint || "",
      profile: String(C.projectName || ""),
      incident: {
        kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || ""),
        turnId: String(info.turnId || ""), reason: String(info.reason || "").slice(0, 600),
        tries: info.tries ?? null, at: nowIso(),
      },
      verdict: verdict || {},
      snapshot: healPageSnapshot(),
      journal: healJournal(),
    }, Number(C.healTelemetryMaxBytes) || 200000);
    const sent = await healUpload(built.payload, info);
    GM_setValue("cfn-heal-last-upload", { at: nowIso(), phase, ...sent, dropped: built.dropped });
    return { built, sent };
  }

  /**
   * Сердцебиение для сторожа вне браузера.
   *
   * Канал — ntfy, тот же сервер, что уже разрешён в `@connect`; отдельный топик
   * `<топик проекта>-hb`, чтобы пульс не звонил в телефон и не мешал истории
   * обычного топика. Сторож (`tools/relay-watchdog.mjs`) — отдельный процесс: он
   * читает пульс с сервера и не умирает вместе с браузером. GitHub-коммит на
   * каждый пульс не годится: это сотня коммитов в сутки.
   */
  async function beatHeartbeat() {
    const state = healState();
    const seq = Number(state.beatSeq || 0) + 1;
    const line = heartbeatLine({
      version: SCRIPT_VERSION,
      fingerprint: C.buildFingerprint || "",
      state: isPaused() ? "paused" : "running",
      at: nowIso(),
      seq,
    });
    saveHealState({ ...state, beatSeq: seq, lastBeatAt: nowIso(), lastBeatLine: line });
    GM_setValue(heartbeatKey(), { at: Date.now(), line, seq });
    const base = normalizeNtfyTopic(GM_getValue(K.ntfyTopic, ""));
    if (!base) return { ok: false, skipped: "топик ntfy не задан" };
    try {
      await ntfyPublish(`${base}-hb`, GM_getValue(K.ntfyToken, ""), {
        message: line, title: "Relay heartbeat", priority: 1, tags: "white_small_square",
      });
      return { ok: true, seq };
    } catch (e) {
      // Пульс — диагностика, а не работа: его пропажа не останавливает цикл.
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  /** Maintainer — закулисная роль транспорта: карточек не берёт, работает вне очереди. */
  async function maintainerRole() {
    let list = [];
    try {
      list = await roles();
    } catch (e) {
      log(`База «Роли» не ответила при поиске Maintainer'а: ${e.message}`, true, { ntfy: "quiet" });
      return { role: null, why: `список ролей не прочитан: ${e.message}` };
    }
    const hit = list.find((r) => r.fn === "Maintainer" && r.url) || null;
    if (!hit) return { role: null, why: "в базе «Роли» нет активной роли с функцией Maintainer" };
    return { role: hit, why: "" };
  }

  /**
   * Диагноз для Maintainer'а: факты инцидента, а не текст для Мастера.
   *
   * В промпт идут: класс и маршрут, причина паузы, структурный снимок, хвост
   * журнала попыток, версия и отпечаток сборки. Переписки здесь нет.
   */
  function healDiagnosis(info, verdict, decision, upload) {
    const built = buildHealTelemetry({
      phase: "maintainer",
      at: nowIso(),
      version: SCRIPT_VERSION,
      fingerprint: C.buildFingerprint || "",
      profile: String(C.projectName || ""),
      incident: {
        kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || ""),
        turnId: String(info.turnId || ""), reason: String(info.reason || "").slice(0, 400),
      },
      verdict: { ...verdict, decision },
      snapshot: healPageSnapshot(),
      journal: healJournal().slice(-12),
    }, 8000);
    const where = [
      upload?.drive?.ok ? `Drive ${upload.drive.name} (id ${upload.drive.fileId || "не получен"})` : "",
      upload?.github?.ok ? `GitHub ${upload.github.path}` : "",
    ].filter(Boolean).join("; ");
    return [
      `ИНЦИДЕНТ ТРАНСПОРТА · класс ${verdict.cls} · ${verdict.why}.`,
      `Остановка: «${String(info.reason || "").slice(0, 300)}»`,
      `Вид паузы: ${info.kind || "пусто"}; карточка ${info.ref || "—"}; run ${info.runId || "—"}; ход ${info.turnId || "—"}.`,
      `Разбор ${decision.attempt} из ${decision.max}. Сборка ${SCRIPT_VERSION} @ ${C.buildFingerprint || "без отпечатка"}.`,
      where ? `Полная телеметрия: ${where}.` : "Полная телеметрия наружу не ушла — вложение ниже.",
      "СНИМОК СТРАНИЦЫ И ЖУРНАЛ ПОПЫТОК (без переписки и секретов):",
      JSON.stringify(built.payload, null, 2),
      "",
      "Правило ответа: первой строкой FIXED <что именно исправлено и в какой сборке> либо NOTFIXED <почему не берёшься>.",
      "По D-027 ты предлагаешь дифф и пробу; коммит и установку делает Мастер. Без вердикта ход не продолжается.",
    ].join("\n");
  }

  /**
   * Отправить Maintainer'у передачу, дождавшись подтверждённой доставки.
   *
   * `sendToRole` кладёт ход в очередь; сама отправка происходит на его странице
   * (`consumePending`). Поэтому здесь ждём подтверждения ограниченное время, а
   * «не подтвердили» — это честный отказ, а не повод продолжать: без ответа
   * Maintainer'а чинить наугад нельзя.
   */
  async function sendMaintainerTurn(role, text, turnId, info) {
    const queued = await sendToRole(role, text, "heal", String(info.ref || turnId), {
      turnId,
      title: `транспорт: ${info.kind || "остановка"}`,
      heal: { kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || "") },
    });
    if (!queued) return { ok: false, why: "передача не поставлена в очередь" };
    const ready = await maintainerTurnReady(role, turnId, 45000);
    if (!ready.ok) return { ok: false, why: ready.why };
    return { ok: true, role, turnId };
  }

  /**
   * Ожидание готовности передачи Maintainer'у.
   *
   * Три состояния различаются честно:
   *  • ход доставлен (`verified`) — передача состоялась;
   *  • очередь ушла и ровно этот ход стал ожиданием — состоялась;
   *  • очередь ещё ждёт — ждём, но не дольше предела.
   */
  function maintainerTurnReady(role, turnId, timeoutMs) {
    const limit = Math.max(3000, Number(timeoutMs) || 45000);
    const started = Date.now();
    const deadline = started + limit;
    return new Promise((resolve) => {
      const step = () => {
        const expect = GM_getValue(K.expect, null);
        const pending = GM_getValue(K.pending, null);
        const mine = expect && expect.kind === "heal" && norm(expect.turnId) === norm(turnId);
        if (mine && (expect.verified === true || !pending)) {
          resolve({ ok: true });
          return;
        }
        if (!expect && !pending && Date.now() - started > 5000) {
          resolve({ ok: false, why: "очередь и ожидание пусты: передача не подтверждена" });
          return;
        }
        if (Date.now() > deadline) {
          resolve({ ok: false, why: `доставка Maintainer'у «${role.name}» не подтверждена за ${Math.round(limit / 1000)} с` });
          return;
        }
        setTimeout(step, 500);
      };
      step();
    });
  }

  /**
   * Передать ход Maintainer'у и дождаться его ответа.
   *
   * Возвращает { ok, resumed, decision, verdict }. «Ответ не пришёл» — не повод
   * продолжать наугад: вызывающий ставит паузу, а не чинит сам.
   */
  async function escalateToMaintainer(info, verdict, decision) {
    const found = await maintainerRole();
    if (!found.role) return { ok: false, why: found.why };
    const role = found.role;
    const upload = GM_getValue("cfn-heal-last-upload", null) || {};
    const turnId = uid();
    const text = healDiagnosis(info, verdict, decision, upload);
    const sent = await sendMaintainerTurn(role, text, turnId, info);
    if (!sent.ok) return sent;
    log(
      `Ход передаю Maintainer'у «${role.name}» (разбор ${decision.attempt} из ${decision.max}): ${verdict.why}.`,
      true,
      { ntfy: "quiet", title: "Relay: разбор транспорта" },
    );
    return { ok: true, role, turnId };
  }

  /**
   * Ответ Maintainer'а по нашей передаче.
   *
   * Профиль `heal.report` без маркера: решение читается по правилу «первая строка
   * — вердикт». Так «приём без маркера» не появляется: у этой передачи правило
   * ответа своё и без маркера, а у рабочих ходов маркер по-прежнему обязателен.
   */
  async function healStep(role, expect, manual = false) {
    if (!expect || expect.kind !== "heal") {
      pause("Это не ход разбора транспорта: решение не применяю.",
        { kind: "handoff-kind", ref: expect?.ref || "" });
      return true;
    }
    const live = GM_getValue(K.expect, null);
    if (!live || live.kind !== "heal" || norm(live.turnId) !== norm(expect.turnId)) {
      pause("Ожидание разбора транспорта изменилось: чужой ход не перезаписываю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const page = pageReady(expect);
    if (!page.ok && !manual) return true;
    const replies = messagesAfter(expect.watermark);
    const last = replies.filter((m) => m.ended && String(m.text || "").trim()).at(-1);
    if (!last) {
      if (manual) log(`${role.name} ещё не ответил по разбору транспорта — подождите.`, true);
      return true;
    }
    const verdict = healReportVerdict(last.text);
    const state = healState();
    const pending = state.pending || {};
    const info = {
      kind: pending.kind || expect.heal?.kind || "", ref: expect.ref || "",
      runId: pending.runId || expect.heal?.runId || "", turnId: expect.turnId || "",
      reason: pending.reason || "",
    };
    // Передача закончилась: ожидание и очередь снимаются до применения решения,
    // иначе повторный тик применит его дважды.
    GM_setValue(K.expect, null);
    GM_setValue(K.pending, null);
    if (verdict.kind === "fixed") {
      const gate = decideVersionGate({
        pausedVersion: state.pausedVersion || "",
        nowVersion: SCRIPT_VERSION,
        pausedFingerprint: state.pausedFingerprint || "",
        nowFingerprint: C.buildFingerprint || "",
        waitedMs: Date.now() - Number(state.pausedAt || 0),
        timeoutMs: Number(C.healVersionTimeoutMs) || 900000,
      });
      if (!gate.ok) {
        const key = healIncidentKey(info);
        healBump(key, "escalations");
        pause(
          `Maintainer «${role.name}» назвал поломку исправленной, но ${gate.why}. ` +
            "Продолжение закрыто до установки новой сборки: установите её и нажмите «Продолжить».",
          { kind: "heal-await-update", ref: info.ref, runId: info.runId, turnId: info.turnId },
        );
        return true;
      }
      log(`Maintainer «${role.name}»: поломка исправлена. ${gate.why}. Продолжаю ход с прежним ожиданием.`, true,
        { ntfy: "quiet", title: "Relay: транспорт исправлен" });
      saveHealState({ ...healState(), pending: null, resolvedAt: nowIso(), resolvedBy: "maintainer" });
      resume("исправлено Maintainer'ом");
      return true;
    }
    saveHealState({ ...healState(), pending: null });
    pause(
      `Maintainer «${role.name}» не смог исправить поломку: ${verdict.reason || "причина не названа"}. ` +
        "Цикл остановлен, ход не потерян: карточка и очередь на месте. Телеметрия выгружена — " +
        "посмотрите её и решите вручную.",
      { kind: "heal-maintainer-done", ref: info.ref, runId: info.runId, turnId: info.turnId },
    );
    return true;
  }

  /**
   * Вердикт Maintainer'а: первая содержательная строка начинается с
   * `FIXED`/`NOTFIXED`. Форма другая, чем у маркера, поэтому и разбор другой;
   * это не ослабление: у рабочих ходов маркер остаётся обязательным.
   */
  function healReportVerdict(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines.slice(0, 8)) {
      const m = line.match(/^(FIXED|NOTFIXED)\b[\s:—-]*(.*)$/i);
      if (!m) continue;
      const reason = m[2].replace(/^[—:,\-\s]+/, "").slice(0, 600);
      const kind = m[1].toUpperCase() === "FIXED" ? "fixed" : "notfixed";
      if (kind === "fixed" && !reason) return { kind: "notfixed", reason: "FIXED без объяснения: что именно исправлено — не названо" };
      return { kind, reason };
    }
    return { kind: "notfixed", reason: "ответ без вердикта FIXED или NOTFIXED" };
  }

  /**
   * Разбор остановки: классификация → предохранитель → действие.
   *
   * Вызывается из `pause()` уже ПОСЛЕ того, как состояние сохранено и Мастер
   * уведомлён: даже полный отказ этого шага не должен оставлять цикл без причины.
   */
  async function healAfterPause(info) {
    const verdict = classifyPause(info.kind, info.reason);
    const key = healIncidentKey(info);
    const counters = healCounters(key);
    const decision = decideHeal(verdict, counters, C);
    saveHealState({
      ...healState(),
      last: { kind: verdict.kind, cls: verdict.cls, route: verdict.route, why: verdict.why, at: nowIso() },
      pausedVersion: String(info.version || SCRIPT_VERSION),
      pausedFingerprint: String(info.fingerprint ?? C.buildFingerprint ?? ""),
      pausedAt: Date.now(),
    });
    // Телеметрия — на остановке и на восстановлении, не каждый тик: квота Drive и
    // GitHub не бесконечная, а пауза уже означает «ход встал».
    let upload = null;
    try {
      upload = await healPublish("stop", info, { ...verdict, decision });
    } catch (e) {
      log(`Телеметрия остановки не выгружена: ${e.message}`, true, { ntfy: false });
    }

    if (verdict.cls === "momentary" && decision.action === "retry") {
      healBump(key, "retries");
      log(
        `${decision.why}. Продолжу сам через ${Math.round(decision.delayMs / 1000)} с: ` +
          "состояние хода сохранено, оракул не трогается.",
        false,
        { ntfy: "quiet", title: "Relay: временный сбой" },
      );
      setTimeout(() => {
        if (!isPaused() || String(GM_getValue(K.paused, "")) !== String(info.reason)) return;
        resume(`временный сбой: автопродолжение ${decision.attempt} из ${decision.max}`);
      }, Math.max(1000, decision.delayMs));
      return { verdict, decision, retried: true };
    }

    if (verdict.cls === "transport" && decision.action === "maintainer") {
      saveHealState({
        ...healState(),
        pending: {
          kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || ""),
          reason: String(info.reason || ""), cls: verdict.cls, at: nowIso(),
        },
      });
      const sent = await escalateToMaintainer(info, verdict, decision);
      if (!sent.ok) {
        // Доставка до Maintainer'а не сработала — это тот самый случай «сломана
        // сама доставка»: не повторяем вслепую, зовём Мастера прямым путём.
        healBump(key, "escalations");
        pause(
          `${decision.why}, но передать ход не удалось: ${sent.why}. ` +
            "Это поломка самой доставки — разбирает Мастер. Телеметрия выгружена, ход не потерян.",
          { kind: "heal-no-maintainer", ref: info.ref, runId: info.runId, turnId: info.turnId, quiet: true },
        );
        return { verdict, decision, escalated: false, why: sent.why };
      }
      return { verdict, decision, escalated: true };
    }

    // Всё остальное — стоп и Мастер: чинить нечего или предохранитель исчерпан.
    const tail = decision.action === "master" && verdict.route !== "master" ? ` ${decision.why}.` : "";
    const why = verdict.unknown
      ? "Вид остановки не распознан: чинить наугад нельзя."
      : verdict.cls === "arena" ? "Это сбой сайта Arena: транспорту чинить нечего."
        : "Автоматического пути нет.";
    if (decision.action === "master" && verdict.route !== "master") {
      pause(`${why}${tail} Телеметрия выгружена: состав журнала и структурный снимок страницы.`,
        { kind: "heal-exhausted", ref: info.ref, runId: info.runId, turnId: info.turnId, quiet: true });
    }
    return { verdict, decision, stopped: true };
  }

  /** Восстановление после установки новой сборки: выгрузка и сброс предохранителей. */
  async function healAfterUpdate(fromVersion) {
    try {
      await healPublish("recovered", {
        kind: "update-recovery", ref: "", runId: "", turnId: "",
        reason: `сборка ${fromVersion || "неизвестной версии"} заменена на ${SCRIPT_VERSION} @ ${C.buildFingerprint || "без отпечатка"}`,
      }, { cls: "master", route: "master", why: "установлена новая сборка" });
    } catch (e) {
      log(`Телеметрия восстановления не выгружена: ${e.message}`, true, { ntfy: false });
    }
    saveHealState({ ...healState(), pending: null, recoveredAt: nowIso(), recoveredFrom: String(fromVersion || "") });
  }
