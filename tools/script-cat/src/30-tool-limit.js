  // ───────────────────────── tool-call limit: продолжение хода ─────────────────────────
  // Arena: "The agent reached the tool-call limit for this turn. Send a message
  // to continue where it left off." Ход уже начался, часть работы могла быть
  // сделана. Отправляем КОРОТКОЕ сообщение-продолжение в тот же чат: не повторяем
  // задание, не шлём compact-retry и не напоминаем о маркере, не создаём новые
  // Run/turn/question IDs и не трогаем карточку Notion/PR/терминальные поля.
  //
  // Состояние живёт в ожидании (K.expect) отдельными полями и НЕ смешивается с
  // arenaResend (повтор недоставленного), tries (напоминания) и branchResend
  // (повтор из-за слитой ветки): toolLimitContinuations, lastToolLimitMessageId,
  // lastToolLimitAt, toolLimitNoProgress, continuationWatermark.
  //
  // Отправка идёт напрямую (ensureComposer → writePrompt → deliver), а не через
  // K.pending/consumePending: провал продолжения НЕ должен откатывать карточку в
  // Ready — работа по ней уже началась. Исходный watermark не сдвигается, поэтому
  // финальный журнал (runAnswer) собирает весь ход: части до лимита + отчёт после.

  const markerForExpect = (e) =>
    e.kind === "plan" ? "CF_COORDINATOR_RESULT"
      : e.kind === "review" ? "CF_REVIEW_RESULT"
        : e.kind === "answer" ? "CF_ANSWER_RESULT"
        : e.kind === "arbiter" ? "CF_ARBITER_RESULT"
          : "CF_AGENT_RESULT";

  const toolLimitRoleFn = (e) =>
    e.kind === "plan" ? "Coordinator"
      : (e.kind === "review" || e.kind === "arbiter") ? "Reviewer"
        : e.kind === "answer" ? (e.roleFn || "Reviewer")
          : (e.roleFn || "Executor");

  /** Запись исхода tool-limit в журнал попытки. Без секретов и полных текстов. */
  function journalToolLimit(expect, status, outcome, envelope) {
    const env = envelope || expect.prompt;
    if (!env || !env.metrics) return;
    recordPromptAttempt(env, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName,
      attempt: (Number(expect.toolLimitContinuations) || 0) + 1,
      outcome, errorClass: "tool_call_limit", messageId: status.messageId,
    });
  }

  /** Активный пилотный ход на текущей странице (собственный namespace). */
  function activePilotOnPage() {
    const waits = listPilots()
      .map((p) => GM_getValue(K.pilotWait + p.id, null))
      .filter((w) => w && w.status === "running" && Number(w.sentAt));
    return waits.find(pilotOnPage) || null;
  }

  /**
   * Оркестратор: вызывается в тике ДО monitorVisibleErrors. Возвращает true,
   * если ход занят продолжением/паузой по tool-limit. Пилот — в своём namespace.
   */
  async function handleToolCallLimit() {
    const status = detectToolCallLimit();
    if (!status) return false;
    const pilotWait = activePilotOnPage();
    if (pilotWait) return continuePilotToolLimit(pilotWait, status);
    const expect = GM_getValue(K.expect, null);
    if (!expect || GM_getValue(K.pending, null)) return false;
    return continueToolLimitTurn(expect, status);
  }

  async function continueToolLimitTurn(expect, status) {
    // Страница должна быть того агента, которого ждём.
    const me = roleFromPath();
    if (!me || norm(me) !== norm(expect.roleId)) return false;
    if (!["dispatch", "plan", "review", "answer", "arbiter"].includes(expect.kind)) return false;
    // Одно и то же статусное сообщение не порождает два продолжения.
    if (expect.lastToolLimitMessageId === status.messageId) return false;
    // Агент ещё генерирует / виден Stop — ждём, не вмешиваемся.
    if (stillWorking()) return false;
    // Доставка исходного хода не подтверждена и ход не начинался — не продолжаем.
    if (!expect.sentAt) return false;
    const replies = messagesAfter(expect.watermark || "", expect.seen);
    const started = expect.verified === true || replies.length > 0;
    if (!started) return false;
    // Ход уже завершён маркером, а статус лимита остался в DOM — не продолжаем.
    const markerName = markerForExpect(expect);
    if (replies.some((m) => String(m.raw || "").includes(markerName))) return false;

    // Рабочая карточка Reviewer: продолжение не шаблонизировано, guard запрещает
    // рабочую выдачу — честно зовём Мастера, карточку не меняем.
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" || norm(expect.roleName) === norm("Warden"))) {
      journalToolLimit(expect, status, "tool_limit_paused");
      pause(
        `Лимит инструментов на рабочей карточке Reviewer «${expect.ref}»: продолжение не шаблонизировано, карточку и IDs не меняю. Нужен Мастер.`,
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
      );
      return true;
    }

    const done = Number(expect.toolLimitContinuations) || 0;
    if (done >= C.toolLimitContinueMax) {
      journalToolLimit(expect, status, "tool_limit_paused");
      pause(
        `Лимит инструментов достигнут снова после ${done} продолжений (предел ${C.toolLimitContinueMax}). ` +
          "Ход не завершён; карточку, PR и IDs не меняю. Нужен Мастер: проверьте страницу агента.",
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "", turnId: expect.turnId || "" },
      );
      return true;
    }
    // После продолжения нет новых содержательных сообщений — только повторный
    // лимит. Продолжать бессмысленно: пауза раньше лимита.
    if (done > 0) {
      const since = messagesAfter(expect.continuationWatermark || expect.watermark || "", expect.seen);
      const substantive = since.filter((m) => String(m.text || "").trim() && !TOOL_LIMIT_RE.test(String(m.text || "")));
      if (!substantive.length) {
        journalToolLimit(expect, status, "tool_limit_no_progress");
        pause(
          "После продолжения агент не дал новых содержательных сообщений — только повторный лимит инструментов. " +
            "Продолжать бессмысленно; карточку и IDs не меняю. Нужен Мастер.",
          { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
        );
        return true;
      }
    }

    const fn = toolLimitRoleFn(expect);
    const ctx = {
      kind: expect.kind, role: { fn, name: expect.roleName || fn },
      turnId: expect.turnId || "", delivery: { tier: "tool_limit", attempt: done + 1 },
    };
    if (expect.kind === "dispatch") ctx.task = { id: expect.ref, runId: expect.runId };
    else if (expect.kind === "answer") ctx.question = { id: expect.ref, turnId: expect.turnId, masterEscalated: expect.masterEscalated === true };
    else if (expect.kind === "arbiter") ctx.arbiter = { cardId: expect.ref, ...(expect.arbiter || {}) };
    else ctx.mission = { id: expect.missionId || expect.ref };
    const envelope = compileOrPause(ctx, `tool-limit continuation ${expect.kind}`);
    if (!envelope) { journalToolLimit(expect, status, "tool_limit_paused"); return true; } // пауза уже поставлена

    const busy = await busySettled();
    if (busy) return false;
    const { editor } = await ensureComposer();
    const failSend = (why) => {
      journalToolLimit(expect, status, "tool_limit_paused", envelope);
      pause(
        `Не удалось отправить продолжение после лимита инструментов (${why}). Карточку, PR и IDs не меняю; нужен Мастер.`,
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
      );
      return true;
    };
    if (!editor) return failSend("поле ввода недоступно");
    if (composerText(editor)) clearComposer(editor);
    if (!writePrompt(editor, envelope.text)) return failSend("текст не встал в редактор");
    const contMark = lastMessageId();
    const delivery = await deliver(editor, envelope.text);
    if (delivery.captcha) { captchaPause(); return true; }
    if (!delivery.ok) return failSend(String(delivery.reason || "отправка не прошла").toLowerCase());

    // IDs, карточка, PR и терминальные поля прежние. Исходный watermark НЕ
    // сдвигаем: финальный журнал соберёт части до лимита и отчёт после.
    GM_setValue(K.expect, {
      ...expect,
      prompt: envelope,
      toolLimitContinuations: done + 1,
      lastToolLimitMessageId: status.messageId,
      lastToolLimitAt: Date.now(),
      toolLimitNoProgress: false,
      continuationWatermark: delivery.msgId || contMark,
      sentAt: Date.now(), verified: true,
      tries: 0, lastReplySig: "", lastReplyAt: 0,
    });
    recordPromptAttempt(envelope, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName, attempt: done + 1,
      outcome: "tool_limit_continued", errorClass: "tool_call_limit", messageId: status.messageId,
    });
    log(
      `Лимит инструментов: отправлено продолжение ${done + 1}/${C.toolLimitContinueMax} тому же ходу ` +
        `(${envelope.metrics.chars} символов). IDs прежние, карточка и терминальные поля не тронуты.`,
      true, { ntfy: "quiet", title: "Relay: tool-call limit" },
    );
    return true;
  }

  /** Продолжение пилотного хода: без CF_* и внутренних ссылок, свой namespace. */
  async function continuePilotToolLimit(wait, status) {
    if (wait.lastToolLimitMessageId === status.messageId) return false;
    if (stillWorking()) return false;
    const pilot = getPilot(wait.id);
    const done = Number(wait.toolLimitContinuations) || 0;
    const stop = (outcome, why) => {
      GM_setValue(K.pilotWait + wait.id, { ...wait, status: "tool-limit-paused", lastToolLimitMessageId: status.messageId, lastToolLimitAt: Date.now() });
      if (wait.prompt?.metrics) recordPromptAttempt(wait.prompt, { kind: "pilot", ref: wait.id, role: "pilot", attempt: done + 1, outcome, errorClass: "tool_call_limit", messageId: status.messageId });
      pause(`Пилот ${pilot?.variant || ""}: ${why} Сырой транскрипт сохранён; нужен Мастер.`, { kind: "pilot-tool-limit", ref: wait.id });
      return true;
    };
    if (done >= C.toolLimitContinueMax) return stop("tool_limit_paused", `лимит инструментов после ${done} продолжений (предел ${C.toolLimitContinueMax}).`);
    if (done > 0) {
      const since = messagesAfter(wait.continuationWatermark || wait.watermark || "");
      if (!since.filter((m) => String(m.text || "").trim() && !TOOL_LIMIT_RE.test(String(m.text || ""))).length) {
        return stop("tool_limit_no_progress", "после продолжения нет новых содержательных сообщений, только повторный лимит.");
      }
    }
    const envelope = PromptCompiler.compile({
      kind: "pilot", role: { fn: "pilot", name: `pilot-${pilot?.variant || ""}` },
      delivery: { tier: "tool_limit", attempt: done + 1 },
    });
    if (!envelope.ok) return stop("tool_limit_paused", `продолжение не собрано (${envelope.error.message}).`);
    const busy = await busySettled();
    if (busy) return false;
    const { editor } = await ensureComposer();
    if (!editor) return true;
    if (composerText(editor)) clearComposer(editor);
    if (!writePrompt(editor, envelope.text)) return true;
    const contMark = lastMessageId();
    const delivery = await deliver(editor, envelope.text);
    if (delivery.captcha) { captchaPause(); return true; }
    if (!delivery.ok) { log(`Пилот: продолжение не отправилось (${delivery.reason}).`, true); return true; }
    GM_setValue(K.pilotWait + wait.id, {
      ...wait, toolLimitContinuations: done + 1, lastToolLimitMessageId: status.messageId,
      lastToolLimitAt: Date.now(), continuationWatermark: delivery.msgId || contMark, prompt: envelope,
    });
    recordPromptAttempt(envelope, { kind: "pilot", ref: wait.id, role: "pilot", attempt: done + 1, outcome: "tool_limit_continued", errorClass: "tool_call_limit", messageId: status.messageId });
    log(`Пилот ${pilot?.variant || ""}: продолжение ${done + 1}/${C.toolLimitContinueMax} после лимита инструментов (без командных маркеров).`, true, { ntfy: "quiet" });
    return true;
  }
