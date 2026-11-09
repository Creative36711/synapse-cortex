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
   *
   * D-085: перерасход бюджета — не повод останавливать ход, пока есть что
   * сжимать. 09.11 боевой план дал 8178 при пределе 7500 (answers.delta 3346,
   * queue.snapshot 1191): отправки не было, и цикл стоял, хотя мешало не
   * задание, а размер переписки. Инструкции роли не режутся никогда (D-034) —
   * сжимаются данные: брифинг ответов и снимок очереди. Порядок — от самого
   * «жирного» блока к остальным, и каждый шаг СКАЗАН в журнале: агент должен
   * знать, что видел ответ не целиком, и что полный текст — в Notion.
   */
  function compileOrPause(request, label) {
    const result = PromptCompiler.compile(request);
    if (result.ok) return result;
    if (result.error.code === "budget_exceeded") {
      const fitted = fitRequestToBudget(request, result);
      if (fitted) {
        log(
          `Промпт не влезал (${label}): ${result.error.message}. Сжал данные — отправляю ${fitted.metrics.chars} знаков. ` +
            "Инструкции не тронуты; сжатое помечено в тексте, полные тексты — в Notion.",
          false,
          { ntfy: "quiet", title: "Relay: промпт сжат по бюджету" },
        );
        return fitted;
      }
    }
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

  /**
   * D-085: уложить переполненный запрос в предел, сжимая ТОЛЬКО данные.
   *
   * Возвращает собранный envelope или null, если даже после сжатия не влезает
   * (тогда остаётся прежняя пауза — молча не режем).
   *
   * Что считается данными: `queue.answersLine` (брифинг ответов ролей),
   * `queue.openLine` (открытые вопросы), `queue.answerLine` (журнал ответа),
   * `queue.ready` (перечень готовых карточек) — они длинные, меняются каждую
   * минуту и целиком лежат в Notion. Что не трогаем никогда: оракул, Scope,
   * инварианты, Acceptance, зону роли, правила и маркер — это задание, а не
   * переписка (D-034, D-038).
   *
   * Шаги идут по возрастанию цены: сначала наполовину, потом до строки-указателя.
   * Первый шаг, который уложился, и уходит — лишнего не режем.
   */
  function fitRequestToBudget(request, failure) {
    const queue = request?.queue;
    if (!queue || typeof queue !== "object") return null;
    const limit = Number(failure?.error?.detail?.limit) || 0;
    const note = "… (сжато под предел промпта; полный текст — в Notion, открой строку перед работой)";
    // Сколько нужно освободить: перерасход плюс небольшой запас, иначе
    // округление сжатия снова упрётся в тот же предел.
    const over = Math.max(0, Number(failure?.error?.detail?.total) || 0) - limit;
    const need = over + 120;
    const shrink = (s) => (typeof s === "string" ? s : "");
    const fields = ["answersLine", "openLine", "answerLine", "ready"].filter((k) => shrink(queue[k]));
    const steps = [];
    // Шаг 1: половина самых длинных строк. Шаг 2: до читаемого начала (240).
    for (const keep of [0.5, 240]) {
      for (const k of fields) {
        const full = shrink(queue[k]);
        const want = keep < 1 ? Math.max(400, Math.floor(full.length * keep)) : keep;
        if (full.length <= want) continue;
        steps.push({ [k]: full.slice(0, want) + " " + note });
      }
    }
    // Берём шаги подряд, пока не набрали нужное: «наполовину» по всем полям,
    // затем «до начала» по тем, которых не хватило.
    const patch = {};
    const taken = new Set();
    for (const step of steps) {
      const k = Object.keys(step)[0];
      if (taken.has(k)) continue; // для поля берём самый мягкий достаточный шаг
      if (shrink(queue[k]).length <= step[k].length) continue;
      patch[k] = step[k];
      taken.add(k);
      const freed = Object.entries(patch)
        .reduce((a, [key]) => a + (shrink(queue[key]).length - patch[key].length), 0);
      if (freed >= need) break;
    }
    if (!Object.keys(patch).length) return null;
    const next = { ...request, queue: { ...queue, ...patch } };
    const retry = PromptCompiler.compile(next);
    return retry.ok ? retry : null;
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
