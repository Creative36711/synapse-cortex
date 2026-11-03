  // ─────────────────────── вопросы: отвечает приёмка ───────────────────────
  /**
   * Вопрос агента больше не ждёт Мастера.
   *
   * Раньше вопрос ложился строкой в «Вопросы» со сроком, цикл шёл по варианту
   * по умолчанию, а ответ Мастера мог прийти через сутки или не прийти вовсе.
   * 28.10 Мастер сказал прямо: на вопросы отвечает приёмка, и отвечает сразу —
   * ход переключается на неё, как только вопрос записан.
   *
   * Теперь у вопроса две судьбы:
   *   answer — приёмка решила по существу: «Ответ» записан, «Статус» =
   *            «Решено», и ответ уезжает агентам обычным путём на следующем
   *            ходе («Ответы на вопросы» в промпте);
   *   master — без Мастера физически нельзя (нужен новый агент, доступ, смена
   *            ТЗ или оракула): только тогда цикл встаёт и зовёт его.
   *
   * Предел срока (`Срок`, «Принят дефолт») остаётся страховкой обычных
   * вопросов. Для ADR default не заменяет фактического решения приёмки.
   */
  const answerQueue = () => {
    const stored = GM_getValue(K.answers, []);
    return Array.isArray(stored) ? stored : [];
  };

  /** Поставить вопрос в очередь приёмки. Повтор с тем же id не дублируется. */
  function queueAnswer(row, q, ctx = {}) {
    if (!row || !row.id) return null;
    const item = {
      id: row.id,
      pageUrl: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(row.id))
        ? `https://www.notion.so/${String(row.id).replace(/-/g, "")}` : "",
      text: q.text,
      fullText: q.fullText || q.text,
      fallback: q.fallback,
      options: Array.isArray(q.options) ? q.options : [],
      url: questionMaterial(q.url, `${q.text || ""} ${q.fullText || ""}`),
      role: ctx.roleName || "",
      card: ctx.card || "",
      mission: ctx.mission || "",
      at: Date.now(),
    };
    const list = answerQueue().filter((row0) => row0.id !== item.id);
    list.push(item);
    GM_setValue(K.answers, list);
    return item;
  }

  const dropAnswer = (id) => GM_setValue(K.answers, answerQueue().filter((item) => item.id !== id));

  const answerPending = () => answerQueue()[0] || null;

  /** Промпт приёмке: ответить на вопрос агента по существу или позвать Мастера. */
  function answerPrompt(mission, role, item, turnId) {
    const name = rt(mission.properties["Миссия"]) || "миссия";
    const tz = mission.properties["ТЗ URL"]?.url || "не задано";
    return [
      technicalInfo(role),
      "",
      roleContext(role),
      "",
      `Миссия: ${name}`,
      `ТЗ и оракул: ${tz}`,
      `Вопрос задал: ${item.role || "агент"}${item.card ? ` · карточка «${item.card}»` : ""}`,
      item.pageUrl ? `Страница вопроса в Notion: ${item.pageUrl}` : "",
      "",
      "ВОПРОС",
      item.fullText,
      item.url && !String(item.fullText || "").includes(item.url) ? `Материал: ${item.url}` : "",
      "",
      item.options.length ? `Варианты, которые предложил агент: ${item.options.join(" · ")}` : "",
      `Вариант по умолчанию (по нему работа идёт прямо сейчас): ${item.fallback}`,
      "",
      "ЧТО ОТ ТЕБЯ ТРЕБУЕТСЯ",
      "Ты — приёмка миссии и на вопросы агентов отвечаешь вместо Мастера. Решай по существу: что правильнее для миссии и её оракула, а не что проще согласовать.",
      "Ответ увидят исполнитель и Координатор на следующем ходе — пиши решение, а не рассуждение: что делать, где граница, по какому признаку считать сделанным.",
      "Твой ответ записывается в «Ответ» этой строки, статус становится «Решено», и на следующем ходе он уезжает агентам строкой «Ответы на вопросы». Поэтому ответ должен быть самодостаточным: агент увидит его без твоего чата.",
      "Если вопрос про новое предложение в Notion (ADR:), читай полный материал страницы и решай по существу; одного срока или default недостаточно.",
      "Если вопрос про предложение (`docs/decisions/*.md`, статус `proposed`) — отвечай решением по существу: принять, отклонить или явно оставить как есть (отклонить изменение), и что именно сделать. Статус файла меняет исполнитель карточкой, не ты.",
      "Ничего не правь: ни карточки, ни код, ни документы. Твой выход — ответ или вызов Мастера.",
      "Мастера зовёшь только тогда, когда без него физически нельзя: нужен новый агент в Arena, доступ или решение, для которого по ТЗ необходимы полномочия Мастера. По ADR решай в пределах делегированных полномочий; сам оракул или файлы не меняй. «Так спокойнее» и «пусть подтвердит» — не повод.",
      "",
      "ОТВЕТ — одной строкой в конце, ровно один маркер:",
      `CF_ANSWER_RESULT {"question_id":"${item.id}","turn_id":"${turnId}","verdict":"answer","answer":"<решение: что делать и по какому признаку считать сделанным>"}`,
      "или, если без Мастера физически нельзя:",
      `CF_ANSWER_RESULT {"question_id":"${item.id}","turn_id":"${turnId}","verdict":"master","reason":"<чего именно не хватает: роль, доступ, решение по ТЗ>"}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Проверяем настоящий Git blob текста, а не один формальный маркер SHA. */
  async function verifiedAdrMaterial(item) {
    const shas = [...String(item?.fullText || "").matchAll(/\bCF_ADR_CONTENT\s+([0-9a-f]{40})\b/gi)].map((m) => m[1].toLowerCase());
    if (!shas.length || !Array.isArray(item.adrBlocks) || !globalThis.crypto?.subtle) return false;
    const candidates = [];
    for (const raw of item.adrBlocks) {
      candidates.push(String(raw)); // отдельно сохранённый исходный файл
      const full = String(raw).match(/ПОЛНЫЙ НЕИЗМЕНЁННЫЙ ТЕКСТ ФАЙЛА:\n([\s\S]*?)\nКОНЕЦ ТЕКСТА CF_ADR_CONTENT_END [0-9a-f]{40}/i);
      if (full) candidates.push(full[1]); // текст внутри дополнения watcher
    }
    for (const text of candidates) {
      const body = new TextEncoder().encode(text);
      const prefix = new TextEncoder().encode(`blob ${body.byteLength}\0`);
      const data = new Uint8Array(prefix.length + body.length);
      data.set(prefix); data.set(body, prefix.length);
      const digest = await globalThis.crypto.subtle.digest("SHA-1", data);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (shas.includes(hash)) return true;
    }
    return false;
  }

  /**
   * Передать вопрос приёмке. `true` — ход ушёл ей; `false` — отвечать некому
   * (вопрос остаётся «Ждёт»; обычный может закрыться сроком, ADR ждёт ответа).
   */
  async function startAnswer(mission, item) {
    if (typeof questionBodyPending === "function" && questionBodyPending(item.id)) return false;
    if (typeof questionQueuedForAnswer === "function" && questionQueuedForAnswer(item)) return false;
    if (/github\.com\/[^\s]+\/docs\/decisions\//i.test(String(item.url || ""))) {
      try {
        const page = await notion("GET", `pages/${item.id}`);
        if (sel(page.properties?.["Статус"]) !== Q.wait) return false;
        const complete = await questionFromRowComplete(page);
        if (!(await verifiedAdrMaterial(complete))) throw new Error("полный текст не совпадает с Git blob SHA");
        item = { ...item, fullText: complete.fullText, url: complete.url || item.url };
      } catch (e) {
        logThrottled(`adr-body:${item.id}`, `Предложение не передано приёмке: ${e.message}. Вопрос и ожидание сохранены; проверьте полный текст и SHA.`, true);
        return false;
      }
    }
    const role = await reviewerRole();
    if (!role) {
      log(
        "Вопрос записан, но активной роли с функцией Reviewer нет: отвечать некому — вопрос ждёт Мастера.",
        false,
        { ntfy: "quiet", title: "Relay: отвечать на вопрос некому" },
      );
      dropAnswer(item.id);
      return false;
    }
    const turnId = uid();
    log(`Вопрос «${oneLine(item.text, 90)}» передан приёмке «${role.name}».`, false, { ntfy: "quiet" });
    await sendToRole(role, answerPrompt(mission, role, item, turnId), "answer", item.id, {
      questionId: item.id,
      missionId: mission.id,
      turnId,
      title: "ответ на вопрос агента",
    });
    return true;
  }

  /** Ход приёмки по вопросу: записать ответ или позвать Мастера. */
  async function answerStep(role, expect, manual = false) {
    const replies = messagesAfter(expect.watermark);
    let decision = replies.map((m) => parseMarker(m.raw, "CF_ANSWER_RESULT"))
      .filter(Boolean)
      .at(-1);
    // A `master` verdict pauses the cycle, but the Master may then answer in
    // the same Warden conversation. Also accept an answer they entered directly
    // in Notion before pressing Continue. Both paths remain bound to this exact
    // question/turn and never overwrite a completed row.
    if (!decision && expect.masterEscalated) {
      try {
        const row = await notion("GET", `pages/${expect.ref}`);
        const state = row?.properties?.["Статус"]?.select?.name || "";
        const savedAnswer = rt(row?.properties?.["Ответ"] || "").trim();
        if (state === Q.done && savedAnswer) {
          decision = { question_id: expect.ref, turn_id: expect.turnId, verdict: "answer", answer: savedAnswer };
        }
      } catch (e) {
        logThrottled(`master-answer-read:${expect.ref}`, `Не удалось проверить ручной ответ Мастера: ${e.message}. Ожидание сохранено.`, true);
      }
    }
    if (!decision) return markerMissing(role, expect, "CF_ANSWER_RESULT", manual);
    // Одного нового сообщения в чате недостаточно: оно может относиться к
    // предыдущему вопросу или повторной попытке того же вопроса. Не очищаем
    // ожидание и не записываем решение, пока обе границы не подтверждены.
    const qid = String(decision.question_id || "").trim();
    const turn = String(decision.turn_id || "").trim();
    const live = GM_getValue(K.expect, null);
    const matches = Boolean(isUuid(expect.ref) && isUuid(expect.turnId) && isUuid(qid) && isUuid(turn) && live && live.kind === "answer" &&
      norm(qid) === norm(expect.ref) && norm(turn) === norm(expect.turnId) &&
      norm(live.ref) === norm(expect.ref) && norm(live.turnId) === norm(expect.turnId) &&
      (!expect.roleId || (role?.id && norm(role.id) === norm(expect.roleId))) &&
      (!live.roleId || (expect.roleId && norm(live.roleId) === norm(expect.roleId))));
    if (!matches) {
      const retained = retainRejectedResult(expect, "answer-identity", replies);
      pause("Ответ не подтверждён для текущего вопроса и хода (question_id / turn_id / адресат). " +
        (retained ? "Ожидание и копия ответа сохранены локально; " : "Ожидание сохранено, локальная копия не записалась — сохраните ответ из чата вручную; ") +
        "попросите приёмку повторить маркер с ID этой выдачи.", {
        kind: "marker-mismatch", ref: expect.ref || "", turnId: expect.turnId || "",
      });
      return true;
    }
    const verdict = String(decision.verdict || "").trim().toLowerCase();
    const answer = String(decision.answer || "").trim();
    if (verdict === "master") {
      const reason = firstLine(String(decision.reason || answer || "").trim()) || "приёмка не назвала причину";
      // Keep the exact answer expectation alive across the Master pause. A later
      // Warden answer marker (or a manual Notion resolution) can then be safely
      // matched to this question and turn instead of letting the cycle jump to
      // Coordinator and strand the response.
      GM_setValue(K.expect, {
        ...expect,
        watermark: replies.at(-1)?.id || expect.watermark,
        masterEscalated: true,
        tries: 0,
        lastReplySig: "",
        lastReplyAt: 0,
      });
      pause(
        `Приёмка не может ответить на вопрос без Мастера: ${reason}. Вопрос остался в базе «Обратная связь» со статусом ` +
          "«Ждёт». После ответа Мастера продолжите здесь: приму маркер Warden только для этого question_id/turn_id; " +
          "если ответ внесён вручную в Notion, поставьте «Решено» и нажмите «Продолжить».",
        { kind: "answer-needs-master", ref: expect.ref, notifyTitle: "Relay: вопрос ждёт Мастера" },
      );
      return true;
    }
    if (verdict !== "answer") {
      pause(
        `В маркере ответа нет verdict answer или master (пришло «${verdict || "пусто"}»): вопрос не закрываю. ` +
          "Поправьте маркер в ответе приёмки и нажмите «Продолжить».",
        { kind: "answer-marker", ref: expect.ref },
      );
      return true;
    }
    if (!answer) {
      pause("Приёмка ответила без текста решения: пустой ответ ничего не меняет, вопрос остаётся открытым.", {
        kind: "answer-empty",
        ref: expect.ref,
      });
      return true;
    }
    // Вопрос могли закрыть руками, пока приёмка думала: тогда её ответ уже
    // никому не нужен, и перезаписывать чужое решение нельзя.
    let stage = "read";
    let result;
    try {
      // Та же блокировка, что у закрытия по сроку: два действия одной вкладки
      // не могут перезаписать решение друг друга между чтением и записью.
      result = await withQuestionWriteLock(async () => {
        const row = await notion("GET", `pages/${expect.ref}`);
        const state = row?.properties?.["Статус"]?.select?.name || "";
        if (!state) throw new Error("статус строки не прочитан");
        if (state !== Q.wait) return { state, answerRecorded: false };
        const current = GM_getValue(K.expect, null);
        if (!current || current.kind !== "answer" || norm(current.ref) !== norm(expect.ref) ||
            norm(current.turnId) !== norm(expect.turnId) ||
            (expect.roleId && norm(current.roleId) !== norm(expect.roleId))) {
          return { state, answerRecorded: false, changed: true };
        }
        stage = "write";
        await patch(expect.ref, {
          "Статус": { select: { name: Q.done } },
          "Ответ": { rich_text: richText(answer) },
        });
        return { state, answerRecorded: true };
      });
    } catch (e) {
      // Не восстанавливаем снимок поверх нового хода, возникшего во время сети.
      const current = GM_getValue(K.expect, null);
      const same = current?.kind === "answer" && norm(current.ref) === norm(expect.ref) &&
        norm(current.turnId) === norm(expect.turnId);
      logThrottled(`answer-${stage}:${expect.ref}`, `Не удалось ${stage === "read" ? "проверить строку" : "записать ответ"} обратной связи (${e.message}): ` +
        (same ? "ожидание сохранено, повторю проверку." : "текущее ожидание изменилось; не перезаписываю, проверьте оба хода."), true);
      return true;
    }
    const { state, answerRecorded } = result;
    // Не снимаем ожидание другого хода, если оно изменилось во время сети.
    const afterWrite = GM_getValue(K.expect, null);
    if (afterWrite && afterWrite.kind === "answer" && norm(afterWrite.ref) === norm(expect.ref) &&
        norm(afterWrite.turnId) === norm(expect.turnId)) GM_setValue(K.expect, null);
    else {
      pause("Вопрос обработан, но ожидание изменилось во время записи. Проверьте обе попытки; новое ожидание сохранено.", {
        kind: "answer-changed", ref: expect.ref, turnId: expect.turnId,
      });
      return true;
    }
    dropAnswer(expect.ref);
    if (!answerRecorded) {
      log(
        `Вопрос закрыт раньше приёмки («${state}») — ответ не перезаписываю, ход возвращается Координатору.`,
        false,
        { tone: "warn", ntfy: "quiet" },
      );
    }
    // Панель знает про ответ сразу: вопрос больше не «Ждёт».
    try {
      recordQuestionChange(expect.ref, null);
      const cache = openQuestions();
      GM_setValue("cfn-q-open", { at: cache.at, rows: cache.rows.filter((row) => row.id !== expect.ref) });
      paintQuestions(openQuestions().rows);
    } catch (e) {
      dbg("вопросы: панель не обновилась", e.message);
    }
    if (answerRecorded)
      log(`Вопрос закрыт приёмкой «${role.name}»: ${oneLine(answer, 160)}`, false, { tone: "ok", ntfy: "quiet" });
    // Ход возвращается Координатору: ответ придёт ему строкой в промпте
    // («Ответы на вопросы»), а next из хода, где вопрос был задан, не
    // применялся — он посчитан без ответа.
    const mission = await activeMission().catch(() => null);
    if (!mission) {
      log("Вопрос закрыт, но активной миссии нет: продолжать не с чего.");
      return true;
    }
    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Вопрос закрыт, но активного Coordinator нет: ход возвращать некому.", {
        kind: "answer-nocoord",
        ref: mission.id,
      });
      return true;
    }
    const queue = await queueOf(mission).catch(() => ({ summary: "очередь не прочитана" }));
    const note = answerRecorded ? "Ответ на вопрос записан — учти его и продолжи план." :
      "Вопрос уже закрыт в Notion — учти сохранённое состояние и продолжи план.";
    await requestPlan(mission, coord, queue, note, { force: true });
    return true;
  }

  /** Проверка постановки и подтверждённых зависимостей, до изменения карточки. */
  async function taskPreflight(card, mission) {
    const active = await activeMission(); // откажет и при нескольких активных миссиях
    if (!mission || !active || norm(active.id) !== norm(mission.id) || !cardInMission(card, active))
      return "Mission ID карточки отсутствует или не совпадает с единственной активной миссией";
    const bindingIssue = cardBindingIssue(card, await query(C.missions));
    if (bindingIssue) return bindingIssue;
    const props = card?.properties || {};
    const empty = ["Намерение", "Инварианты", "Acceptance", "Scope"].filter((name) => !rt(props[name]).trim());
    if (!taskTitle(card).trim()) empty.unshift("Запрос");
    if (typeof props["Sequence"]?.number !== "number" || !Number.isFinite(props["Sequence"].number)) empty.push("Sequence");
    if (empty.length) return `не заполнены обязательные поля: ${empty.join(", ")}`;
    if (!props["Dependency"] || props["Dependency"].type && props["Dependency"].type !== "rich_text")
      return "в схеме нет текстового поля Dependency";
    const value = rt(props["Dependency"]).trim();
    if (!value || /^(нет|none|n\/a|—|-)$/i.test(value)) return "";
    const ids = value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length || ids.some((id) => !isUuid(id)) || new Set(ids.map(norm)).size !== ids.length)
      return "Dependency: перечисли UUID карточек через запятую или оставь поле пустым; названия и неоднозначные ссылки не проверяются";
    for (const id of ids) {
      if (norm(id) === norm(card.id)) return "Dependency ссылается на саму карточку";
      const dependency = await notion("GET", `pages/${id}`);
      if (!cardInMission(dependency, active)) return `Dependency ${id}: карточка другой миссии или без Mission ID`;
      if (taskState(dependency) !== "Accepted") return `Dependency ${id}: карточка ещё не Accepted`;
      if (dependency.properties?.["Check"]?.select?.name === "fail") return `Dependency ${id}: Check = fail, разберись с остатком`;
    }
    return "";
  }

  async function dispatchTask(card, roleName, mission = null) {
    const role = (await roles()).find((r) => r.name === roleName);
    if (!role) throw new Error(`Роль «${roleName}» не найдена среди активных.`);
    // Защита перед любыми чтениями/записями карточки и журнала: повторная
    // выдача не должна даже очистить следы прежнего ответа Reviewer.
    if (role.fn === "Reviewer" || String(role.name || "").toLowerCase() === "warden")
      return "Reviewer принимает миссии и отвечает на вопросы; рабочую карточку переназначь Auditor или Executor";
    if (!["Executor", "Auditor"].includes(role.fn))
      return `функция роли «${role.fn || "не указана"}» не разрешает выдачу; выбери Executor или Auditor`;
    // На границе выдачи кеш недостаточен: функция или Agent URL могли только
    // что измениться. Ошибка чтения не разрешает выдачу по устаревшим данным.
    const directory = await roleRows({ fresh: true, requireFresh: true });
    if (role.id && directory.some((r) => r.fn === "Reviewer" && r.id && norm(r.id) === norm(role.id)))
      return "этот Agent URL принадлежит Reviewer; рабочую карточку переназначь другому агенту";
    const confirmed = directory.filter((r) => norm(r.name) === norm(role.name) && r.id && role.id &&
      norm(r.id) === norm(role.id) && r.url && r.status === "Активна");
    if (confirmed.length !== 1 || confirmed[0].fn !== role.fn || !["Executor", "Auditor"].includes(confirmed[0].fn))
      return "роль или её функция изменились перед выдачей; перечитай базу «Роли» и выбери активного исполнителя или аудитора";

    // Цель выдачи — репозиторий сессии роли (карта route репозиториев профиля)
    // и его базовая ветка. Техблок, команды gh и проверка PR берутся из этого
    // контекста, а не из глобального C.repo/C.branch, чтобы один профиль
    // обслуживал несколько репозиториев без смены UUID.
    // The freshly re-read Notion role row is the live assignment source. The
    // profile map is a compatibility fallback for older role rows without a
    // repository field; it must not route Executor Core into the profile's
    // default cortex repo when Notion explicitly assigns it to synapse.
    const sessionRepo = canonicalTargetRepository(confirmed[0].repo || profileSessionRepo(role.id) || "", C.repo);

    // Карточка перечитывается прямо перед выдачей: между выбором из списка и
    // отправкой её мог тронуть Координатор, прошлый тик или человек. 23.10
    // NAR-1.7 выдали второй раз с новым run — она была в списке Ready уже
    // отвеченной, и агент честно повторил ту же работу.
    const fresh = await notion("GET", `pages/${card.id}`);
    const preflight = await taskPreflight(fresh, mission);
    if (preflight) return `предварительная проверка: ${preflight}; карточку и историю не меняю`;
    const recipient = taskRole(fresh);
    if (!recipient || norm(recipient) !== norm(role.name))
      return `адресат карточки изменился на «${recipient || "не указан"}»; перечитай её и назови верную роль`;
    const state = taskState(fresh);
    const targetRepo = taskTargetRepository(fresh, sessionRepo);
    if (!targetRepo) return "у карточки и назначенной роли не задан целевой репозиторий";
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
      const entry = (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).find(
        (item) => item && String(item.repo || "").toLowerCase() === targetRepo.toLowerCase(),
      );
      if (!entry) return `репозиторий карточки ${targetRepo} не разрешён в профиле; карточку и очередь не меняю`;
    } else if (String(C.repo || "").toLowerCase() !== targetRepo.toLowerCase()) {
      return `репозиторий карточки ${targetRepo} не совпадает с legacy-профилем ${C.repo}; выдачу не начинаю`;
    }
    const targetBranch = profileRepoBranch(targetRepo);
    if (fresh.properties?.Check?.select?.name === "fail" && !reworkSeen(fresh.id)) {
      // Не ставим общую паузу на первой попытке: coordinatorStep вернёт
      // Coordinator точную техническую причину и переспросит план. Это не
      // разрешает выдачу — карточка и следы остаются нетронуты. Три одинаковых
      // отказа подряд уже ограничены cfn-dispatch-miss и приведут к паузе.
      return `«${taskTitle(fresh)}» имеет Check=fail, но ScriptCat не зафиксировал состояние Rework. ` +
        "Не выдавал карточку и не менял её поля: Submitted At, PR и Run ID сохранены. " +
        "Сначала оставь карточку в Rework, чтобы транспорт успел увидеть явный возврат; " +
        "после разбора результата и решения Warden можно отдельным следующим шагом вернуть её в Ready. " +
        "Не ставь Rework и Ready одним ответом: Check=fail не означает pass и не подтверждает, что предыдущий результат разобран.";
    }
    let prLink = fresh.properties["PR"]?.url || "";
    let submittedAt = fresh.properties["Submitted At"]?.date?.start || "";
    // Карточку, которую Координатор снова направил в работу, транспорт чистит
    // сам: следы прошлого ответа («Submitted At», «PR», «Run ID») ставит выдача,
    // и только она имеет право их снять. Координатор их не трогает — коннектор
    // отвечает validation_error, а ждать, пока Rework попадёт в опрос, нельзя:
    // 27.10 на NAR-4.9 он длился меньше одного тика и выдача отказала.
    const clearing = redispatchClearProps(fresh);
    if (clearing) {
      const why = redispatchWhy(fresh);
      try {
        await patch(fresh.id, clearing);
        // Ответа на карточке больше нет — и отметка о нём тоже: следующий
        // ответ поставит новую.
        GM_setValue(answerStampKey(fresh.id), "");
      } catch (e) {
        log(
          `«${taskTitle(fresh)}» вернулась в работу (${why}), но следы прошлого ответа не снялись (${e.message}) — выдача отменена.`,
          true,
        );
        return `следы прошлого ответа не снялись: ${e.message}`;
      }
      GM_setValue(reworkKey(fresh.id), 0);
      submittedAt = "";
      prLink = "";
      log(`«${taskTitle(fresh)}» снова в работе — ${why}: снял «Submitted At», «PR» и «Run ID», выдаю заново.`, false, {
        tone: "ok",
      });
      const times = noteRedispatch(fresh.id);
      if (times >= REDISPATCH_LIMIT) {
        GM_setValue(redispatchKey(fresh.id), []);
        pause(
          `«${taskTitle(fresh)}» перевыдали ${times} раз за шесть часов — похоже, Координатор и исполнитель ` +
            "гоняют одну и ту же карточку и не замечают этого. Очередь и карточка на месте: посмотрите «Ответ» " +
            "и журнал, поправьте постановку и нажмите «Продолжить».",
          { kind: "redispatch", ref: fresh.id },
        );
        return true;
      }
    }
    if (state !== "Ready" || submittedAt || prLink) {
      const why =
        state !== "Ready"
          ? `уже ${state || "не в Ready"}`
          : `уже отвечена${prLink ? ` (${prLink})` : ""}`;
      log(`«${taskTitle(fresh)}» ${why} — повторно не выдаю.`, true, {
        ntfy: "quiet",
        title: "Relay: повторная выдача отменена",
      });
      // Карточка не в Ready — значит Координатор назвал работой ту, которую сам
      // же не вернул в очередь. Это его ход, а не сбой сети: пауза ставится
      // только на третьем повторе (см. ветку `dispatch` в `coordinatorStep`),
      // а до тех пор ход возвращается Координатору с точной причиной.
      return state !== "Ready"
        ? `сейчас она в «${state || "неизвестном состоянии"}», а не в Ready`
        : "на ней остались следы прошлого ответа";
    }
    GM_setValue("cfn-dispatch-miss", 0);

    // Карточку выдали заново — прошлое неотправленное задание к ней больше не
    // относится: иначе оно ушло бы вторым сообщением уже после новой выдачи.
    const stale = GM_getValue(K.pending, null);
    const staleExpect = GM_getValue(K.expect, null);
    if (stale && stale.undelivered && staleExpect && norm(staleExpect.ref) === norm(card.id)) {
      GM_setValue(K.pending, null);
      GM_setValue(K.expect, null);
      log("Карточку выдали заново — прошлая неотправленная очередь снята.");
    }

    const runId = uid();
    const payloadId = rt(fresh.properties["Payload Drive File ID"]);
    let payload = "";
    if (payloadId) {
      try {
        payload = (await gateway("read", payloadId)).content || "";
      } catch (e) {
        throw new Error(`Payload не прочитан: ${e.message}`);
      }
    }
    // Каждому новому Run — свой журнал. Поле карточки может указывать на
    // прошлую попытку или даже чужую миссию; его нельзя использовать повторно.
    const previousLogId = rt(fresh.properties["Output Drive File ID"]);
    const created = await gateway("createLog", "", { dispatchId: card.id, runId });
    const logId = String(created?.fileId || "").trim();
    if (!logId) throw new Error("Шлюз не вернул ID журнала новой выдачи.");
    const beforeWrite = await notion("GET", `pages/${card.id}`);
    const recheck = await taskPreflight(beforeWrite, mission);
    if (recheck || taskState(beforeWrite) !== "Ready" || norm(taskRole(beforeWrite)) !== norm(role.name) ||
        beforeWrite.properties?.["Submitted At"]?.date?.start || beforeWrite.properties?.["PR"]?.url) {
      return `карточка изменилась перед выдачей (${recheck || "состояние, адресат или следы ответа"}); ` +
        `статус не меняю, созданный пустой журнал ${logId} оставлен для проверки`;
    }
    await patch(card.id, {
      "Dispatch State": { select: { name: "Running" } },
      "Run ID": { rich_text: [{ type: "text", text: { content: runId } }] },
      "Recipient Agent ID": { rich_text: [{ type: "text", text: { content: role.id } }] },
      "Output Drive File ID": { rich_text: [{ type: "text", text: { content: logId } }] },
      "Started At": { date: { start: nowIso() } },
      ...(Object.prototype.hasOwnProperty.call(fresh.properties || {}, "Repository")
        ? { Repository: { rich_text: richText(targetRepo) } }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fresh.properties || {}, "Репозиторий")
        ? { "Репозиторий": { rich_text: richText(targetRepo) } }
        : {}),
      Check: { select: null },
    });
    // Файл журнала создаётся пустым, поэтому задание пишем в него сразу:
    // иначе агент получает ссылку на пустой файл и не понимает, зачем она.
    try {
      await gateway("append", logId, {
        marker: `<!-- CF_DISPATCH ${card.id}:${runId}:task -->`,
        entry: taskLogEntry(fresh, role, payload, runId) +
          (previousLogId && previousLogId !== logId
            ? `\nРанее указанная ссылка на журнал (принадлежность не проверена): https://drive.google.com/file/d/${encodeURIComponent(previousLogId)}/view\n`
            : ""),
      });
    } catch (e) {
      log(`Задание не записалось в журнал попытки: ${e.message}`, true);
    }
    log(
      `Выдан ход ${roleName}: «${taskTitle(fresh)}»` +
        (payload.trim() ? "." : " (отдельного файла с заданием нет — текст собран из карточки)."),
    );
    // Карточка уже в Running, задание в очереди: отсюда выдача состоялась, даже
    // если `sendToRole` не отправил текст (тот же текст уходил минуту назад —
    // это защита от дубля, а не отказ). Отказ отправки разбирает сторож
    // неотправленной очереди, а не вызывающий.
    const dispatchCtx = { repo: targetRepo, branch: targetBranch };
    const queued = await sendToRole(role, executorPrompt(fresh, role, payload, logId, runId, mission?.id || "", dispatchCtx), "dispatch", card.id, {
      runId,
      missionId: mission?.id || "",
      logId,
      targetRepo,
      targetBranch: targetBranch,
      title: taskTitle(fresh),
      // Ссылка нужна минимальному повтору: «прочитай карточку сам».
      url: fresh.url || "",
    });
    if (!queued) {
      // Очередь не создалась (сработала защита от повтора — тот же текст уже
      // уходил этой роли минуту назад). Значит хода нет, а карточка уже
      // Running: без ожидания её никто не поведёт, и Координатор увидит
      // «работу», которой нет. Возвращаем в Ready и говорим об этом прямо.
      const left = GM_getValue(K.expect, null);
      if (!left || norm(left.ref) !== norm(card.id)) {
        await releaseUndelivered(
          { kind: "dispatch", ref: card.id, runId, title: taskTitle(card) },
          "задание не поставлено в очередь",
        );
        return "задание не поставлено в очередь (то же сообщение уже уходило)";
      }
    }
    return true;
  }
