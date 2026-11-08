  // ───────────────────────── факты и компиляция ─────────────────────────
  // Источник фактов для компилятора промптов. Ручного склеивания промпта здесь
  // больше нет: состав, порядок, маркер и бюджет проверяет PromptCompiler.
  // Блоки и профили живут в prompt-blocks.js / prompt-profiles.js.

  const promptRole = (role) => ({
    id: role?.id || "", name: role?.name || "", fn: role?.fn || "",
    repo: role?.repo || "", zone: role?.zone || "", gate: role?.gate || "",
  });

  const promptTarget = (ctx = {}) => ({
    repo: ctx.repo || C.repo || "",
    baseBranch: ctx.branch || ctx.baseBranch || C.branch || "main",
    startSha: ctx.startSha || "",
  });

  /** Журнал попыток доставки: профиль, объём, исход. Без секретов. */
  function recordPromptAttempt(envelope, meta = {}) {
    if (!envelope || !envelope.metrics) return;
    try {
      const key = "cfn-prompt-journal-v1";
      const prior = GM_getValue(key, []);
      const list = Array.isArray(prior) ? prior : [];
      list.push({
        at: nowIso(),
        profileId: envelope.profileId, tier: envelope.tier, hash: envelope.hash,
        blocks: envelope.blocks, ruleIds: envelope.ruleIds,
        chars: envelope.metrics.chars, utf8Bytes: envelope.metrics.utf8Bytes,
        lines: envelope.metrics.lines, overhead: envelope.metrics.overheadChars,
        kind: meta.kind || "", ref: meta.ref || "", role: meta.role || "",
        attempt: meta.attempt || 1, outcome: meta.outcome || "queued",
        errorClass: meta.errorClass || "",
        messageId: meta.messageId || "",
      });
      GM_setValue(key, list.slice(-200));
    } catch (e) { dbg("prompt-journal", String(e?.message || e)); }
  }

  /** Классификация отказа доставки/страницы для журнала попытки. */
  function classifyArenaFailure(text) {
    const t = String(text || "").toLowerCase();
    if (/captcha|recaptcha|security verification|подтвердите, что вы человек/.test(t)) return "captcha";
    if (/sign in|log in|unauthorized|\b401\b|authentication|войдите|авторизац/.test(t)) return "auth";
    if (/agent[^\n]{0,24}(unavailable|not found)|агент[^\n]{0,24}недоступ/.test(t)) return "agent_unavailable";
    // tool-call limit — ход уже начался; это не budget/rate/generic. Проверяем
    // раньше budget|лимит|превышен, иначе слово «limit» уводит в budget_exceeded.
    if (/the agent reached the tool-call limit for this turn|send a message to continue where it left off|tool[- ]call limit for this turn|лимит вызовов инструментов|достиг лимита инструментов/.test(t)) return "tool_call_limit";
    if (/rate limit|too many requests|\b429\b|слишком много запросов/.test(t)) return "rate_limit";
    if (/something went wrong|please try again|попробуйте ещё|что-то пошло не так/.test(t)) return "arena_generic_error";
    if (/send[^\n]{0,24}(disabled|недоступ)|кнопка[^\n]{0,24}неактив/.test(t)) return "send_disabled";
    if (/не нашёл поле|поле ввода|editor|contenteditable/.test(t)) return "editor_not_found";
    if (/network|failed to fetch|timeout|timed out|сеть|тайм-аут|не удалось загрузить/.test(t)) return "network";
    if (/budget|лимит|превышен/.test(t)) return "budget_exceeded";
    return "unknown";
  }

  /** Записать исход доставки в журнал попытки (профиль уже сохранён в expect). */
  function journalDelivery(expect, outcome, errorClass = "") {
    if (!expect || !expect.prompt) return;
    recordPromptAttempt(expect.prompt, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName,
      attempt: (Number(expect.tries) || 0) + 1, outcome, errorClass,
    });
  }

  /**
   * Скомпилировать запрос или поставить локальную паузу с причиной.
   * Ошибка компиляции не отправляется в Arena. Возвращает envelope или null.
   */
  function compileOrPause(request, label) {
    const result = PromptCompiler.compile(request);
    if (result.ok) return result;
    // Перерасход бюджета — это поломка профиля/блоков, а не данных Мастера:
    // такой разбор уходит Maintainer'у (D-073). Текст паузы говорит правду о
    // том, что произошло, и не обещает Мастеру ручную правку, которой от него
    // не требуется: 08.11 в 00:24 боевой цикл встал на budget_exceeded и
    // простоял до утра, хотя чинить должен был транспорт.
    const budget = result.error.code === "budget_exceeded";
    pause(
      `Промпт не собран (${label}): ${result.error.code} — ${result.error.message}. ` +
        `${budgetBreakdownLine(result.error)}` +
        (budget
          ? "Отправка не выполнялась. Это поломка профиля промпта, а не фактов миссии: транспорт передаёт разбор Maintainer'у и продолжит сам, если разбор не потребует Мастера."
          : "Отправка не выполнялась; исправьте факты или профиль — транспорт передаёт разбор Maintainer'у."),
      { kind: "prompt-compile", ref: request?.task?.id || request?.mission?.id || request?.question?.id || "" },
    );
    return null;
  }

  /** D-034/D-043: какие блоки съели бюджет — топ-4 по связанному лимиту.
   * При total показываем полный размер fact-блоков, а не их нулевой overhead:
   * K-29 упёрлась в оракул/Scope, но прежняя диагностика называла marker/git. */
  function budgetBreakdownLine(error) {
    const blocks = error?.detail?.blocks;
    if (!Array.isArray(blocks) || !blocks.length) return "";
    const total = Number(error?.detail?.total) > 0;
    const key = total ? "chars" : "overhead";
    const top = blocks.filter((b) => b[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 4)
      .map((b) => `${b.id} ${b[key]}`).join(", ");
    if (!top) return "";
    return total ? `Размер блоков (знаки): ${top}. ` : `Overhead по блокам: ${top}. `;
  }
