  // ───────────────────────────── отладка ─────────────────────────────
  /**
   * Отладка в консоль браузера (F12), а не только в панель.
   *
   * Включается тремя способами: `?cfn-debug` в адресе, кнопка 🐞 в панели и
   * `__relay.debug(true)` в консоли. Состояние хранится в ScriptCat, поэтому
   * переживает переходы между страницами агентов — именно там всё и ломается.
   *
   * В консоль печатается не «шаг выполнен», а решение и его причина: какие
   * селекторы сработали, сколько элементов нашли, активна ли кнопка Send, что
   * перекрывает клик, сколько сообщений в чате до и после.
   */
  const debugOn = () => {
    try {
      if (new URL(location.href).searchParams.has("cfn-debug")) return true;
    } catch {
      /* адрес нечитаем — решает сохранённый флаг */
    }
    return GM_getValue(K.debug, false) === true;
  };

  function dbg(step, data) {
    if (!debugOn()) return;
    // Снимок можно передать функцией: в выключенном режиме он не считается.
    let payload = data;
    if (typeof data === "function") {
      try {
        payload = data();
      } catch (e) {
        payload = `снимок не удался: ${e.message}`;
      }
    }
    const line = `[Relay ${SCRIPT_VERSION}] ${step}`;
    try {
      if (payload === undefined) console.log(line);
      else console.log(line, payload);
    } catch {
      /* консоль недоступна — молча */
    }
  }

  /** Короткое описание элемента: по нему видно, что нашли, а что нет. */
  function describe(el) {
    if (!el) return "нет";
    const cls = String(el.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(".");
    const label = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
    return `${String(el.tagName || "?").toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}${label ? ` [${label}]` : ""}`;
  }

  /** Кнопка Send «как её видит скрипт»: найдена, активна, не перекрыта. */
  function debugSendButton(editor) {
    let btn = null;
    try {
      btn = editor ? sendButton(editor) : null;
    } catch {
      btn = null;
    }
    if (!btn) return { found: false };
    return {
      found: true,
      el: describe(btn),
      disabled: Boolean(btn.disabled),
      ariaDisabled: btn.getAttribute?.("aria-disabled") || "",
      covered: elementCovered(btn),
    };
  }

  /** Снимок страницы для консоли: одним объектом, без догадок. */
  function debugSnapshot() {
    const editor = composer();
    return {
      url: location.href,
      path: location.pathname,
      role: roleFromPath() || "—",
      auto: autoOn(),
      paused: GM_getValue(K.paused, "") || false,
      pending: GM_getValue(K.pending, null),
      expect: GM_getValue(K.expect, null),
      generating: generating(),
      busy: busyReason(),
      editor: {
        found: Boolean(editor),
        el: describe(editor),
        covered: editor ? elementCovered(editor) : null,
        textLength: editor ? composerText(editor).length : 0,
      },
      send: debugSendButton(editor),
      panels: completionPanels().map((panel) => ({
        el: describe(panel),
        close: describe(closeButtonIn(panel)),
      })),
      skipCard: Boolean(skipCardButton()),
      messages: messages().length,
      lastMessage: lastMessageId() || "—",
      diagnostics: composerDiagnostics(),
    };
  }

  /** `__relay` — ручной пульт в консоли браузера. */
  const debugApi = {
    version: SCRIPT_VERSION,
    debug(on = true) {
      GM_setValue(K.debug, Boolean(on));
      if (on) installDebugApi();
      console.info(`[Relay] отладка ${on ? "включена: подробные сообщения пойдут в эту консоль" : "выключена"}.`);
      return Boolean(on);
    },
    state: () => debugSnapshot(),
    composer: () => composer(),
    /** Что скрипт видит вокруг поля ввода: кандидаты, кнопки, координаты. */
    dom: () => {
      const report = domReport();
      console.info("[Relay] снимок разметки:", report);
      return report;
    },
    /** Снимок, сохранённый при последнем отказе отправки. */
    sendDebug: () => GM_getValue("cfn-send-debug", null),
    sendButton: () => debugSendButton(composer()),
    /**
     * Что скрипт видит про отправку прямо сейчас.
     *
     * Нужен, когда журнал говорит «отправлено», а глаза видят другое: в снимке
     * поле ввода, кнопка Send, ключ доставки, свои реплики с id и временем из
     * id. В консоли: `copy(JSON.stringify(__relay.send(), null, 2))`.
     */
    send: () => {
      const pending = GM_getValue(K.pending, null);
      const live = composer();
      return {
        version: SCRIPT_VERSION,
        at: new Date().toISOString(),
        composer: live
          ? {
              found: true,
              inDocument: composerAlive(live),
              length: composerText(live).length,
              head: composerText(live).slice(0, 120),
            }
          : { found: false, why: composerDiagnostics() },
        button: live ? debugSendButton(live) : null,
        pending: pending
          ? {
              role: pending.roleName || pending.roleId,
              at: pending.at,
              length: String(pending.text || "").length,
              undelivered: Boolean(pending.undelivered),
              captcha: Boolean(pending.captcha),
            }
          : null,
        key: pending ? sendKey(pending.text) || flat(pending.text).slice(0, 60) : "",
        deadSend: GM_getValue(K.deadSend, ""),
        own: userMessages().map((node) => {
          const id = String(node.id || "").replace("chat-message-", "");
          return { id, at: idTime(id) || 0, head: flat(node.textContent || "").slice(0, 80) };
        }),
        lastRefusal: GM_getValue("cfn-send-debug", null),
      };
    },
    panels: () => completionPanels().map(describe),
    /** Капча на экране: без человека цикл не пойдёт. */
    captcha: () => Boolean(captchaDialog()),
    closePanel: () => closeCompletionPlaque(),
    messages: () => messages().map((n) => ({ id: nodeId(n), head: messageText(n).slice(0, 60) })),
    /** Что скрипт считает ответом после водяного знака — с хвостом и маркером. */
    replies: () => {
      const waiting = GM_getValue(K.expect, null);
      return messagesAfter(waiting?.watermark || "").map((m) => ({
        id: m.id,
        length: m.raw.length,
        tail: tail(m.text, 220),
        marker:
          parseMarker(m.raw, "CF_COORDINATOR_RESULT") || parseMarker(m.raw, "CF_AGENT_RESULT") ||
          parseMarker(m.raw, "CF_REVIEW_RESULT") || parseMarker(m.raw, "CF_ARBITER_RESULT") || null,
      }));
    },
    resend: () => {
      const waiting = GM_getValue(K.expect, null);
      if (!waiting?.text) return "в ожидании нет текста задания";
      if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
          String(waiting.roleName || "").toLowerCase() === "warden"))
        return "Старую или нераспознанную карточку Reviewer не переотправляю: ожидание сохранено, проверьте чат и Run ID.";
      if (["review", "answer", "arbiter"].includes(waiting.kind)) {
        // Приёмка и ответы сохраняют связь с исходной миссией/вопросом.
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, sentAt: null, verified: false });
        GM_setValue(K.pending, { roleId: waiting.roleId, text: waiting.text, at: Date.now() });
        return "задание возвращено в очередь";
      }
      GM_setValue(K.expect, null);
      GM_setValue(K.pending, { roleId: waiting.roleId, text: waiting.text, at: Date.now() });
      return "задание возвращено в очередь";
    },
    step: () => tick(true),
    /** Снять очередь и ожидание прошлой попытки, не трогая журнал. */
    reset: () => resetStateDialog(),
  };
  /** Пульт появляется в консоли только когда отладка включена. */
  function installDebugApi() {
    if (!debugOn()) return;
    window.__relay = debugApi;
  }

  // Повтор одной тихой вехи подавляется на 10 минут. Не больше восьми обычных
  // тихих пушей на топик за это окно; тихая остановка не теряется из-за лимита.
  // История лежит в ScriptCat, поэтому действует и после перехода страницы.
  const NTFY_QUIET_WINDOW_MS = 10 * 60_000;
  const NTFY_QUIET_LIMIT = 8;
  function allowQuietNtfy(topic, key, essential = false, now = Date.now()) {
    const saved = GM_getValue("cfn-ntfy-recent", []);
    const recent = (Array.isArray(saved) ? saved : []).filter((item) =>
      item && typeof item.key === "string" && Number.isFinite(Number(item.at)) &&
      Number(item.at) <= now && now - Number(item.at) < NTFY_QUIET_WINDOW_MS,
    );
    const eventKey = `${topic}:${String(key).slice(0, 350)}`;
    if (recent.some((item) => item.key === eventKey)) return false;
    if (!essential && recent.filter((item) => item.topic === topic && !item.essential).length >= NTFY_QUIET_LIMIT) {
      return false;
    }
    GM_setValue("cfn-ntfy-recent", [...recent, { topic, key: eventKey, at: now, essential }].slice(-100));
    return true;
  }

  function notifyNtfy(text, { title = "Relay", priority = "2", tags = "memo", cycleStopped = false, key = "" } = {}) {
    try {
      if (typeof C !== "undefined" && C.projectName && C.projectName !== "Relay")
        title = String(title).replace(/^Relay(?=[:\s]|$)/, C.projectName);
      const topic = normalizeNtfyTopic(GM_getValue(K.ntfyTopic, ""));
      if (!topic) return;
      // Последняя защита: даже ошибочно помеченная «громкой» запись не звонит,
      // пока автоцикл действительно идёт и пауза не поставлена.
      const stopped = cycleStopped && (isPaused() || !autoOn());
      if (Number(priority) >= 4 && !stopped) {
        priority = "2";
        tags = "memo";
      }
      if (Number(priority) < 4 && !allowQuietNtfy(topic, key || `${title}:${text}`, stopped)) return;
      ntfyPublish(topic, GM_getValue(K.ntfyToken, ""), { message: text, title, priority, tags }).catch((e) => {
        console.warn("[Relay ntfy]", e.message);
        try {
          log(`ntfy: пуш не ушёл — ${e.message}`, true, { skip: true });
        } catch (logError) {
          console.warn("[Relay ntfy] не удалось записать ошибку:", logError);
        }
      });
    } catch (e) {
      // Уведомление не должно остановить живую выдачу, даже если хранилище
      // ScriptCat недоступно. В таком случае диагностика остаётся в консоли.
      console.warn("[Relay ntfy] уведомление пропущено:", e);
    }
  }

  /** Гудок в браузере: страховка, если ntfy не настроен или телефон молчит. */
  let alertCtx = null;
  function playAlert() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = alertCtx || (alertCtx = new Ctx());
      const play = () => {
        const start = ctx.currentTime + 0.03;
        [880, 660, 880].forEach((frequency, index) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const at = start + index * 0.22;
          osc.type = "sine";
          osc.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.16, at + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.18);
        });
      };
      if (ctx.state === "suspended") ctx.resume().then(play).catch(() => {});
      else play();
    } catch (e) {
      console.warn("[Relay alert]", e);
    }
  }
