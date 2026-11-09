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
      // D-092: сколько раз эта остановка уже была записана приёмке строкой.
      // Третий счётчик рядом с двумя прежними: у каждого адресата свой предел,
      // иначе «передал приёмке» считалось бы передачей транспорту.
      tickets: Math.max(0, Number(found.tickets) || 0),
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

  /**
   * D-092: метрика автономности — сколько остановок на сто ходов решает человек.
   *
   * Без числа «стало автономнее» — обещание, а не измерение. Считается дёшево и
   * без сети: знаменатель — счётчик шагов цикла, числитель — остановки, у
   * которых адресат `master`. Правило D-092 требует, чтобы числитель падал, а не
   * перераспределялся: поэтому хранится ещё и разбивка по адресатам.
   */
  function healAutonomyMetric() {
    const state = healState();
    const turns = Math.max(0, Number(state.turns) || 0);
    const tally = state.stops && typeof state.stops === "object" ? state.stops : {};
    const forHuman = Math.max(0, Number(tally.master) || 0);
    const total = Object.values(tally).reduce((sum, value) => sum + (Number(value) || 0), 0);
    const per100 = turns ? Math.round((forHuman / turns) * 1000) / 10 : 0;
    return {
      turns, stops: total, forHuman,
      with: Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, Number(v) || 0])),
      // Один знак после запятой: «3,4 на 100 ходов» читается, «3,4375» — нет.
      per100,
      share: total ? Math.round((forHuman / total) * 1000) / 10 : 0,
    };
  }

  /** Шаг цикла состоялся: знаменатель метрики. Дёшево — два числа в хранилище. */
  function healCountTurn() {
    const state = healState();
    saveHealState({ ...state, turns: Math.max(0, Number(state.turns) || 0) + 1 });
  }

  /** Остановка состоялась: числитель и разбивка по адресатам. */
  function healCountStop(withWho) {
    const state = healState();
    const stops = { ...(state.stops || {}) };
    const key = String(withWho || "master");
    stops[key] = Math.max(0, Number(stops[key]) || 0) + 1;
    saveHealState({ ...state, stops });
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
   * Приватность получателя телеметрии: кеш на сессию, ошибка чтения — «не знаю».
   *
   * `false` здесь означает «нельзя писать»: при сомнении телеметрия остаётся на
   * Drive, а не уезжает в публичный репозиторий кода.
   */
  const telemetryPrivacy = new Map();
  function telemetryRepoPrivate(repo) {
    const key = String(repo || "").toLowerCase();
    if (!key) return false;
    if (telemetryPrivacy.has(key)) return telemetryPrivacy.get(key);
    telemetryPrivacy.set(key, false); // по умолчанию — не пишем
    const token = GM_getValue(K.ghToken, "");
    if (!token) return false;
    request("GET", `https://api.github.com/repos/${repo}`, githubHeaders(token))
      .then((meta) => {
        if (meta && meta.private === true) telemetryPrivacy.set(key, true);
        else dbg("телеметрия: репозиторий не приватный", repo);
        return null;
      })
      .catch((e) => dbg("телеметрия: видимость репозитория не прочитана", e && e.message));
    return false;
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
    // D-086: телеметрия НЕ пишется в репозиторий проекта.
    //
    // 09.11 в `main` лежало 17 коммитов `telemetry:` — все прямые пуши, ни один
    // не связан с PR. Правила процесса (ветка, приёмка, ревью) действуют для
    // агентов и не действовали для самого транспорта: он же и обходил
    // ветвление, о котором пишет агентам. Хуже того, каждый такой коммит — это
    // изменение `main` без проверки, то есть шум в истории рядом с настоящими
    // решениями.
    //
    // Поэтому наружу телеметрия уходит только по двум каналам: Drive (шлюз
    // проекта, уже выше) и отдельный приватный репозиторий, если Мастер его
    // завёл (`C.telemetryRepo`). Нет репозитория — телеметрия остаётся на Drive,
    // и это не ошибка, а норма.
    // 09.11 (2-я редакция): репозитории разной видимости — `synapse` публичный,
    // `synapse-cortex` приватный. Телеметрия содержит тексты карточек, зоны
    // ролей и куски переписки, поэтому разрешён только приватный получатель.
    // Проверяем один раз на сессию: лишний GET на каждую паузу не нужен.
    const tRepo = String(C.telemetryRepo || "");
    if (tRepo && !telemetryRepoPrivate(tRepo)) {
      out.github = { ok: false, skipped: `телеметрия не пишется в публичный репозиторий ${tRepo} (D-086); выгружена на Drive` };
      return out;
    }
    if (!tRepo) {
      out.github = { ok: false, skipped: "телеметрия в репозиторий проекта не пишется (D-086); выгружена на Drive" };
    } else if (!token) {
      out.github = { ok: false, skipped: "нет GitHub-токена" };
    } else {
      try {
        const path = `telemetry/${name.name.replace(/\.json$/, "")}__${String(payload.script?.fingerprint || "") || "nofp"}.json`;
        const res = await request("PUT", `https://api.github.com/repos/${tRepo}/contents/${encodeURI(path)}`,
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
        out.github = { ok: true, path, sha: String(res?.content?.sha || ""), repo: tRepo };
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
    // Статус проверяется по той же причине, по которой он назван в тексте
    // отказа: «нет активной роли». Раньше код брал первую строку с заполненным
    // URL и молча считал её активной — роль со статусом «Ждёт» уезжала разбор,
    // которого Мастер ещё не разрешил (D-074 п. 3: строка и доступ — разные шаги).
    const hit = list.find((r) => r.fn === "Maintainer" && r.url && r.status === "Активна") || null;
    if (!hit) {
      const seenRow = list.find((r) => r.fn === "Maintainer") || null;
      const why = !seenRow
        ? "в базе «Роли» нет строки с функцией Maintainer"
        : !seenRow.url
          ? "у роли Maintainer пуст «Agent URL» — разбор передавать некуда"
          : `роль Maintainer есть, но «Статус» = «${seenRow.status || "пуст"}»: нужна активная строка`;
      return { role: null, why };
    }
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
        // D-084: что именно не сошлось в ответе агента (дефект маркера, имя
        // маркера, хвост текста). Без этого разбор начинается с нуля, хотя
        // ответ уже прочитан транспортом.
        defect: info.defect ? {
          kind: String(info.defect.kind || ""), hint: String(info.defect.hint || "").slice(0, 300),
          marker: String(info.defect.marker || ""), role: String(info.defect.role || ""),
          tail: healRedact(String(info.defect.tail || "")).slice(0, 400),
        } : null,
      },
      verdict: { ...verdict, decision },
      autonomy: healAutonomyMetric(),
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
      info.defect
        ? `Маркер «${info.defect.marker || "?"}» от «${info.defect.role || "?"}»: ${info.defect.hint || "чего не хватило — не названо"}. ` +
            "Хвост ответа — в телеметрии ниже; копия всего ответа сохранена локально."
        : "Маркер разбирать не пришлось: причина названа видом остановки.",
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
      heal: {
        kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || ""),
        ...(info.defect ? { defect: info.defect } : {}),
      },
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
      // D-084: дефект маркера переживает передачу. Иначе разбор «исправлено»
      // нечем проверить: Maintainer не знает, что именно не сошлось.
      defect: pending.defect || expect.heal?.defect || null,
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
        pause(
          `Maintainer «${role.name}» назвал поломку исправленной, но ${gate.why}. ` +
            "Продолжение закрыто до установки новой сборки: установите её и нажмите «Продолжить».",
          {
            kind: "heal-await-update", ref: info.ref, runId: info.runId, turnId: info.turnId,
            // Дефект переезжает в следующую остановку: после установки сборки
            // разбор должен видеть тот же ответ, а не пустую паузу.
            heal: info.defect ? { defect: info.defect } : undefined,
          },
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
      {
        kind: "heal-maintainer-done", ref: info.ref, runId: info.runId, turnId: info.turnId,
        // Сюда цикл доходит уже после разбора: Мастеру звонить не нужно, он
        // увидит остановку в панели. Телефонный звонок остаётся только там, где
        // без человека физически нельзя.
        quiet: true,
        heal: info.defect ? { defect: info.defect } : undefined,
      },
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
    // D-092: каждая остановка попадает в метрику с адресатом решения. Считается
    // до действия: даже если передача не удалась, факт «человека звали» важнее.
    healCountStop(verdict.with);
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

    // D-092: остановка, которую решает приёмка, а не человек.
    //
    // `master` раньше означал «стоп и человек». Но постановка, зоны, очередь и
    // петли — предмет приёмки (D-027 п. 1, D-066 г), и человек там нужен только
    // для пунктов закрытого списка (MASTER_ONLY). Поэтому такая остановка
    // становится СТРОКОЙ В «Обратной связи»: приёмка отвечает обычным ходом,
    // ответ ложится в её «Ответ», а цикл не стоит и не ждёт нажатия.
    if (decision.action === "warden") {
      healBump(key, "tickets");
      try {
        const row = await askQuestion(
          {
            // Вопрос — сама остановка, дословно: приёмка должна видеть причину,
            // а не пересказ. Полный текст уходит в тело страницы.
            text: `${verdict.why || "остановка"}: ${oneLine(info.reason, 160)}`,
            fullText: healDiagnosis(info, verdict, decision, upload),
            // Вариант по умолчанию — «работу не останавливать»: она и так не
            // остановлена, а приёмка отвечает, не задерживая очередь.
            fallback: "работу не останавливать: решение придёт ответом в «Обратной связи»",
            gate: false,
            options: [],
            url: "",
          },
          {
            key: `heal:${key}`,
            roleName: "Transport",
            card: String(info.ref || ""),
            mission: String(info.missionId || ""),
            forceAnswer: true,
            blocks: `остановка транспорта · ${verdict.kind || "без вида"}`,
          },
        );
        if (row && row.id) {
          log(
            `Остановка «${verdict.kind || "без вида"}» записана приёмке строкой ${row.id}: ` +
              "цикл не останавливаю — ответ придёт в её «Ответ» и в следующий план.",
            false,
            { ntfy: "quiet", title: "Relay: вопрос приёмке" },
          );
          return { verdict, decision, ticketed: true, questionId: row.id };
        }
      } catch (e) {
        log(`Строку приёмке записать не удалось (${e.message}): останавливаюсь, чтобы не потерять причину.`, true);
      }
      // Не записалось — честнее остановиться, чем молча продолжать: причина
      // остановки должна существовать хотя бы в панели.
      pause(`${verdict.why || "остановка"}: ${oneLine(info.reason, 300)}`,
        { kind: "heal-exhausted", ref: info.ref, runId: info.runId, turnId: info.turnId, quiet: true });
      return { verdict, decision, ticketed: false, stopped: true };
    }

    // D-092: маршрут к Maintainer'у решает не класс, а решение (`action`).
    // Повтор, который исчерпал свои пределы, — тоже дефект, а не «стоп»: раньше
    // он падал в общую ветку и оставлял цикл без адресата.
    if (decision.action === "maintainer") {
      saveHealState({
        ...healState(),
        pending: {
          kind: String(info.kind || ""), ref: String(info.ref || ""), runId: String(info.runId || ""),
          reason: String(info.reason || ""), cls: verdict.cls, at: nowIso(),
          defect: info.defect || null,
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
      // D-084: шаг передачи считается здесь, а не в ветке «доставка не удалась».
      // Иначе один и тот же дефект маркера уходил бы транспортy бесконечно:
      // каждое «FIXED» без новой сборки ставило heal-await-update, а после
      // «Продолжить» счётчик оставался нулевым.
      healBump(key, "escalations");
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
