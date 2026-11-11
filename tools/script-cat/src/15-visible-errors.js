  // ───────────────────────── ошибка на экране ─────────────────────────
  /**
   * Tool-call limit — отдельное состояние Arena: ход уже начался, часть работы
   * могла быть сделана. Это не отказ доставки, не captcha/auth/rate и не забытый
   * маркер. Правильное действие — короткое сообщение-продолжение в тот же чат
   * (см. 30-tool-limit.js), а не повтор задания и не общая пауза по UI-ошибке.
   */
  const TOOL_LIMIT_RE = /the agent reached the tool-call limit for this turn|send a message to continue where it left off|tool[- ]call limit for this turn|лимит вызовов инструментов|достиг лимита инструментов/i;
  const TOOL_LIMIT_EXCLUDE = "pre, code, textarea, .shiki, .hljs, .prism, .monaco-editor, [data-language], [data-diff], [class*='diff'], [class*='code-block'], [contenteditable='true'], [contenteditable='']";

  /**
   * Видимый статус tool-call limit в транскрипте (role=status/alert, amber —
   * лишь дополнительный признак). Ищем в сообщениях чата, не в pre/code/diff/
   * редакторе; привязываем к ближайшему chat-message. Без id — хеш текста+позиция.
   */
  function detectToolCallLimit() {
    const nodes = messages();
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      for (const el of node.querySelectorAll('[role="status"], [role="alert"]')) {
        if (!visible(el) || el.closest(TOOL_LIMIT_EXCLUDE)) continue;
        const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !TOOL_LIMIT_RE.test(text)) continue;
        const messageId = nodeId(node) || `h${textHash(text)}:${i}`;
        return { messageId, text: text.slice(0, 300), index: i };
      }
    }
    return null;
  }

  /**
   * Arena показывает сбой двумя способами: алертом внутри последнего
   * пользовательского сообщения и красной карточкой в интерфейсе. Оба —
   * повод остановиться, а не «подождать и попробовать ещё раз»: повтор поверх
   * неизвестной ошибки отправляет агенту второй промпт и путает учёт хода.
   */
  function latestUserMessageAlert() {
    const list = messages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const node = list[i];
      if (!node.querySelector('[data-user-message-layout="true"]')) continue;
      const alert = [...node.querySelectorAll('[role="alert"]')].find(visible);
      if (!alert) return null;
      return {
        messageId: nodeId(node),
        text: String(alert.innerText || alert.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      };
    }
    return null;
  }

  function detectVisibleErrorCard() {
    const selectors = [
      'div[class*="border-red"][class*="bg-red"][class*="rounded"]',
      'div[class*="border-red-500"][class*="bg-red-500"]',
      'div[class*="border-destructive"][class*="bg-destructive"]',
    ];
    const keywords = /something went wrong|please try again|failed|error occurred|an error|rate limit|timed out|timeout|unauthorized|ошибка|попробуйте снова|что-то пошло не так|не удалось|сбой|превышен лимит/i;
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        if (!visible(card) || card.dataset.cfnSeen === "1") continue;
        if (card.closest("pre, code, textarea, .shiki, .hljs, .prism, .monaco-editor, [data-language], [data-diff], [class*='diff'], [class*='code-block']")) continue;
        const text = String(card.innerText || card.textContent || "").trim();
        if (!text) continue;
        // Tool-call limit — не UI-ошибка: его обрабатывает продолжение хода.
        if (TOOL_LIMIT_RE.test(text)) continue;
        if (text.length < 400 || keywords.test(text)) {
          card.dataset.cfnSeen = "1";
          return text.replace(/\s+/g, " ").slice(0, 300);
        }
      }
    }
    return null;
  }

  /**
   * Одну и ту же ошибку не показываем дважды: после «Продолжить» Мастер уже
   * видел её, и повторная пауза на том же месте сделала бы цикл неоживучим.
   */
  function alreadyReported(key) {
    return GM_getValue(K.errSeen, "") === key;
  }

  function markReported(key) {
    GM_setValue(K.errSeen, key);
  }

  /**
   * D-106: дневной лимит токенов Arena — отдельное состояние интерфейса.
   * Кнопка-индикатор в поле ввода (`aria-label="Daily usage limit reached"`,
   * `data-severity="blocked"`) означает, что суточная квота исчерпана и
   * отправка заблокирована целиком. Это не отказ доставки (повтор не поможет)
   * и не tool-call limit (там ход уже шёл и ждёт продолжение) — здесь нечего
   * отправлять вообще.
   *
   * Правильное действие — остановить цикл: пауза `daily-limit`, класс `master`,
   * адресат — Мастер (пункт закрытого списка `money`: квота и деньги аккаунта).
   * Окно лимита суточное: когда индикатор погаснет, цикл продолжается кнопкой
   * «Продолжить». Пока индикатор виден, повторное «Продолжить» снова ставит
   * паузу — тик не уйдёт в заблокированную отправку.
   */
  const DAILY_LIMIT_RE = /daily usage limit/i;

  function dailyUsageLimitBlocked() {
    if (typeof document === "undefined") return false;
    for (const el of document.querySelectorAll("button[aria-label]")) {
      if (!DAILY_LIMIT_RE.test(el.getAttribute("aria-label") || "")) continue;
      if (typeof visible === "function" && !visible(el)) continue;
      return true;
    }
    return false;
  }

  function monitorDailyLimit() {
    if (!dailyUsageLimitBlocked()) return false;
    pause(
      "Дневной лимит токенов Arena исчерпан: индикатор «Daily usage limit reached» в поле " +
        "ввода, отправка заблокирована — цикл остановлен. Лимит суточный: когда индикатор " +
        "погаснет, нажмите «Продолжить»; пока он виден, повторная попытка снова остановит цикл.",
      { kind: "daily-limit" },
    );
    return true;
  }

  function monitorVisibleErrors() {
    // Tool-call limit обрабатывается продолжением хода (handleToolCallLimit в
    // тике стоит раньше). Здесь не превращаем его в общую паузу по UI-ошибке.
    if (detectToolCallLimit()) return false;
    const alert = latestUserMessageAlert();
    if (alert) {
      const key = `alert:${alert.messageId}`;
      if (alreadyReported(key)) return false;
      markReported(key);
      // Ошибка поверх нашего же задания — это не «агент сломался», а «сообщение
      // не приняли». Ход не снимаем и Мастера не зовём: в очередь кладётся
      // короткая версия, её отправит ближайший тик. Пауза — только когда
      // короткие повторы уже исчерпаны.
      const expect = GM_getValue(K.expect, null);
      if (retryRejectedHandoff(expect, alert, `Arena ответила «${alert.text || "ошибка без текста"}»`)) {
        return true;
      }
      const tried = Number(expect?.arenaResend) || 0;
      if (tried > 0) {
        // Минимальное сообщение тоже не прошло: второй отказ подряд — стоп.
        pause(
          `Arena второй раз не приняла задание «${expect?.title || expect?.ref || "агента"}»: ` +
            `«${alert.text || "ошибка без текста"}». Минимальное сообщение тоже отклонено — ` +
            "цикл остановлен. Задание в очереди, карточка Running: посмотрите страницу агента.",
          { kind: "arena-error", ref: alert.messageId, runId: expect?.runId || "" },
        );
        return true;
      }
      pause(`Видимая ошибка Arena в последнем сообщении: ${alert.text || "текст ошибки пуст"}.`, {
        kind: "arena-error",
        ref: alert.messageId,
      });
      return true;
    }
    const card = detectVisibleErrorCard();
    if (card) {
      const key = `ui:${card.slice(0, 80)}`;
      if (alreadyReported(key)) return false;
      markReported(key);
      pause(`Необработанная ошибка интерфейса: ${card || "текст ошибки пуст"}.`, { kind: "ui-error" });
      return true;
    }
    return false;
  }
