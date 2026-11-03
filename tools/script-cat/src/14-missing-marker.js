  // ───────────────────────── ответ без маркера ─────────────────────────
  /**
   * Агент может ответить по делу и забыть маркер. Раньше это тонуло в журнале
   * («ждём следующего хода»), и цикл стоял до 45-минутного таймаута. Теперь
   * лестница: подождать, напомнить (до markerReminders раз), остановиться.
   * Число попыток живёт в ожидании, а не в счётчике страницы: перезагрузка
   * его не сбрасывает.
   *
   * tries — сколько напоминаний уже отправлено; лимит считается по ним.
   */
  function markerStep(tries, max = C.markerReminders) {
    return Number(tries) >= Number(max) ? "pause" : "remind";
  }

  /**
   * Напоминание о формате. Две формулировки — чтобы подряд идущие напоминания
   * не выглядели механической копией, и чтобы в чате не было слова ScriptCat.
   *
   * why = "thin" — маркер есть, а отчёта нет (NAR-1.8, 23.10.2026: агент понял
   * «ответь одной последней строкой» буквально, а в журнал попал только маркер).
   */
  function markerReminder(role, expect, attempt, markerName, why = "") {
    // Формат маркера зависит от вида хода: их четыре, и путать их нельзя —
    // напоминание не должно просить у приёмки маркер исполнителя.
    let line;
    if (expect.kind === "answer") {
      line = `CF_ANSWER_RESULT {"question_id":"${expect.ref}","turn_id":"${expect.turnId || ""}","verdict":"answer","answer":"<решение>"}`;
    } else if (expect.kind === "plan") {
      line = `CF_COORDINATOR_RESULT {"mission_id":"${expect.missionId || expect.ref}","turn_id":"${expect.turnId || ""}","status":"completed","next":"<роль|done>"}`;
    } else if (expect.kind === "review") {
      line = `CF_REVIEW_RESULT {"mission_id":"${expect.missionId || expect.ref}","turn_id":"${expect.turnId || ""}","verdict":"accept|rework","remarks":"<пункты замечаний>"}`;
    } else if (role.fn === "Reviewer" && markerName === "CF_REVIEW_RESULT") {
      line = `CF_REVIEW_RESULT {"mission_id":"${expect.missionId || ""}","dispatch_id":"${expect.ref}","run_id":"${expect.runId || ""}","verdict":"accept|rework|master","remarks":"<причина или замечания>"}`;
    } else if (role.fn === "Reviewer") {
      line = `CF_AGENT_RESULT {"dispatch_id":"${expect.ref}","run_id":"${expect.runId || ""}","status":"submitted","pr":null}`;
    } else if (role.fn === "Auditor") {
      line = `CF_AGENT_RESULT {"dispatch_id":"${expect.ref}","run_id":"${expect.runId || ""}","status":"submitted","check":0,"report":"<путь к отчёту>"}`;
    } else {
      line = `CF_AGENT_RESULT {"dispatch_id":"${expect.ref}","run_id":"${expect.runId || ""}","status":"submitted","check":0,"report":"<путь>","pr":<номер PR|null>,"merged":true}`;
    }
    const about = expect.title ? ` по «${expect.title}»` : "";
    const variants = [
      [
        `ТЕХНИЧЕСКОЕ НАПОМИНАНИЕ (${attempt} из ${C.markerReminders}; это не задание и не новый ход).`,
        `Твой предыдущий ответ${about} пришёл без обязательного маркера ${markerName}.`,
        "Без него нельзя понять, закончена работа или нет, поэтому ответ не засчитан.",
      ],
      [
        `НАПОМИНАНИЕ О ФОРМАТЕ (${attempt} из ${C.markerReminders}; повторять работу не нужно).`,
        `В ответе${about} не нашлось последней строки с ${markerName}.`,
        "Остальное в чате на месте — не хватает только служебной строки.",
      ],
    ];
    // Маркер вместо отчёта. Просить «одну последнюю строку» нельзя: агент
    // присылает ровно её, отчёт остаётся в чате, а журнал хода пустеет.
    const thin = [
      `ОТЧЁТ НЕ ЗАПИСАН (${attempt} из ${C.markerReminders}; это не задание и не новый ход).`,
      `В последнем ответе${about} пришла только служебная строка ${markerName}, без отчёта.`,
      "Маркер без фактов не считается ответом: по нему нельзя принять работу.",
    ];
    return [
      ...(why === "thin" ? thin : variants[(attempt - 1) % variants.length]),
      "Не повторяй уже сделанное и не жди Мастера — это ошибка формата, а не работы.",
      why === "thin"
        ? "Пришли ответ ещё раз целиком: что изменил, что показали команды, какие числа получились — и последней строкой маркер."
        : "Пришли ответ ещё раз целиком и последней строкой добавь маркер: одним маркером вместо отчёта отвечать нельзя.",
      "",
      roleContext(role),
      "",
      "ФОРМАТ ОТВЕТА — последняя строка, ровно одна:",
      line,
      "Строка должна быть последней, без блока кода и без текста после неё.",
    ].filter(Boolean).join("\n");
  }

  /**
   * Признаки того, что агент ещё работает: кнопка Stop и «думающая» плашка.
   * Пока они видны, любой текст в чате — черновик, а не ответ.
   */
  function stillWorking() {
    return Boolean(busyReason());
  }

  /** Хвост текста для журнала: по нему видно, ответ это или «думаю…». */
  const tail = (text, n = 120) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : `…${flat.slice(-n)}`;
  };

  /**
   * Заявка «почти по формату»: id выдачи есть, номер PR есть, признак мержа
   * есть, а литерала маркера нет. Пример, на котором это понадобилось:
   * «NAR-1.7 RESULT — dispatch 4016f0cf-…; run 8abe7712-…; PR #31 MERGED.»
   */
  function looseResult(raw, role, expect) {
    if (role.fn === "Auditor") return null;
    const text = String(raw || "");
    const ref = String((expect && expect.ref) || "");
    const runId = String((expect && expect.runId) || "");
    if (!text || !ref || !runId) return null;
    const pr = Number((text.match(/\bPR\s*#?\s*(\d+)/i) || text.match(/\/pull\/(\d+)/) || [])[1]) || null;
    if (!pr) return null;
    const merged = /\bmerged\b|слит|слито|слита|слиты|\bв main\b/i.test(text);
    // ID должны стоять именно после своих подписей, а не просто встречаться в
    // произвольной цитате. Противоречивые повторные поля тоже недопустимы.
    const dispatches = [...text.matchAll(/\bdispatch(?:[_\s-]*id)?[`"'\s:=]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]);
    const runs = [...text.matchAll(/\brun(?:[_\s-]*id)?[`"'\s:=]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]);
    if (!dispatches.length || !runs.length || dispatches.some((id) => norm(id) !== norm(ref)) ||
        runs.some((id) => norm(id) !== norm(runId))) return null;
    return { dispatch_id: dispatches[0], run_id: runs[0], status: "submitted", pr, merged };
  }

  /**
   * Текст ответа для журнала: все сообщения агента за ход, а не только последнее.
   *
   * Инцидент NAR-1.8 (23.10.2026). Kernel отчитался без маркера, получил
   * напоминание и прислал одну строку маркера. В журнал попал только маркер:
   * Координатор прочитал его, не увидел работы и поставил Rework при слитом PR.
   * Теперь журнал собирается из всего хода, а одинаковые части не дублируются.
   */
  function runAnswer(expect, hit) {
    const seen = new Set();
    const parts = [];
    const push = (m) => {
      const text = String((m && m.text) || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      parts.push(text);
    };
    messagesAfter(expect.watermark).forEach(push);
    push(hit);
    const text = parts
      .map((part, i) => (parts.length > 1 ? `### Часть ${i + 1} из ${parts.length}\n\n${part}` : part))
      .join("\n\n");
    return { text, parts: parts.length, body: answerBody(text) };
  }

  /** Длина текста без служебных строк маркера: по ней видно, есть ли отчёт. */
  const answerBody = (text) =>
    String(text || "")
      .split("\n")
      .filter((line) => !/^\s*CF_(AGENT|COORDINATOR|REVIEW|ANSWER)_RESULT\b/.test(line) && !/^### Часть \d+ из \d+/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim().length;

  /**
   * Минимальное сообщение вместо отклонённого задания.
   *
   * 25.10 задание Architect (NAR-2.16) не принималось трижды: «Something went
   * wrong. Please try again.» — и на полном тексте (7 586 символов), и на
   * сокращённом техблоке (7 610 после переотправки). Дело не в длине и не в
   * разметке: Arena отклоняет сам текст задания. Поэтому повтор — это не
   * пересказ, а просьба прочитать задание самому: ссылка на карточку, номера
   * выдачи и формат маркера. Всё остальное агент берёт из карточки.
   */
  function minimalPrompt(expect) {
    // Coordinator plan is not a dispatch: its ref is the mission page, not a
    // task card. Preserve a compact queue snapshot and the Coordinator marker.
    if (expect.kind === "plan") {
      const missionId = String(expect.missionId || expect.ref || "");
      const turnId = String(expect.turnId || "");
      return expect.fallbackText || [
        `Продолжи ход Координатора по миссии ${missionId}; turn_id ${turnId}.`,
        expect.url || (missionId ? `https://app.notion.com/p/${missionId.replace(/-/g, "")}` : ""),
        expect.planContext || "Прочитай очередь миссии и продолжи планирование по её актуальному состоянию.",
        "Обработай Submitted/Rework и выдай следующий Ready/Draft согласно правилам Coordinator. Не создавай исполнительскую задачу вместо плана.",
        `Последней строкой: CF_COORDINATOR_RESULT {"mission_id":"${missionId}","turn_id":"${turnId}","status":"completed","next":"<роль|done>"}`,
      ].filter(Boolean).join("\n");
    }
    const id = String(expect.ref || "");
    const url = expect.url || (id ? `https://app.notion.com/p/${id.replace(/-/g, "")}` : "");
    return [
      `Задание ${expect.title || id} (dispatch ${id}, run ${expect.runId || ""}).`,
      "Полный текст Arena не приняла ошибкой. Прочитай задание сам — оно в карточке:",
      url || `(карточка Notion ${id})`,
      "Поля карточки — Намерение, Инварианты, Оракул (Acceptance), Scope — и есть задание.",
      expect.roleFn === "Reviewer"
        ? "Проверь оракул и дай отчёт. Код, ветки и PR не меняй. Если карточка требует CF_REVIEW_RESULT, включи в него dispatch_id и run_id этой выдачи."
        : "Работай только в своей зоне, PR мержи сам (`gh pr merge --squash`), оракул не ослабляй.",
      "Последней строкой ответа — ровно один маркер сдачи карточки:",
      expect.roleFn === "Reviewer"
        ? `CF_AGENT_RESULT {"dispatch_id":"${id}","run_id":"${expect.runId || ""}","status":"submitted","pr":null}`
        : `CF_AGENT_RESULT {"dispatch_id":"${id}","run_id":"${expect.runId || ""}","status":"submitted","check":0,"report":"<путь>","pr":<номер PR>,"merged":true}`,
      'Работа без PR — `"pr": null`.',
    ].join("\n");
  }

  /**
   * Задание, которое Arena съела ошибкой, возвращается в очередь минимальным
   * сообщением. Повтор один: второй отказ подряд — пауза, а не цикл.
   *
   * «Задание отправлено» в этом случае врёт: сообщение в транскрипте есть, ход у
   * агента не начался. Отметка доставки снимается, id «мёртвого» сообщения
   * запоминается (иначе `lastUserSays` примет старую копию за новую отправку).
   */
  function retryRejectedHandoff(expect, alert, why) {
    if (!expect || !expect.roleId) return false;
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" ||
        String(expect.roleName || "").toLowerCase() === "warden")) return false;
    if (!expect.sentAt) return false;
    if (Date.now() - Number(expect.sentAt || 0) > C.arenaRetryMs) return false;
    const done = Number(expect.arenaResend) || 0;
    if (done >= C.arenaResendMax) return false;
    const text = minimalPrompt(expect);
    GM_setValue(K.deadSend, (alert && alert.messageId) || "");
    GM_setValue(K.pending, {
      roleId: expect.roleId,
      roleName: expect.roleName,
      roleUrl: expect.roleUrl,
      text,
      at: Date.now(),
      sendTries: 0,
    });
    GM_setValue(K.expect, {
      ...expect,
      text,
      sentAt: null,
      verified: false,
      undelivered: true,
      cardRolled: false,
      arenaResend: done + 1,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
    });
    log(
      `${why}: задание до «${expect.roleName || "агента"}» не принялось — повторяю минимальным сообщением ` +
        `«прочитай карточку сам» (${text.length} символов вместо ${String(expect.text || "").length}). ` +
        "Второй отказ подряд — пауза. Новый ход Координатора не нужен.",
      true,
      { ntfy: "quiet", title: "Relay: повторяю задание" },
    );
    return true;
  }

  /**
   * Отказ из-за уже слитой ветки.
   *
   * 27.10 Архитектор получил новый прогон на ветке со статусом `pr_merged`
   * (PR #97 той же карточки) и ответил честно: «не могу выполнить прогон на
   * слитой ветке; нажмите Continue рядом со статусом PR». Это не ответ на
   * задание и не «агент молчит»: работа не начиналась, маркера не будет,
   * напоминания бесполезны — они уйдут в ту же мёртвую ветку.
   *
   * Признак требует сразу четырёх вещей: отказ, слово о ветке, слово о мерже
   * и подсказку про Continue. Обычный отчёт («PR #97 слит, ветка …») без
   * отказа под него не попадает — и он всё равно приходит с маркером.
   */
  function staleBranchRefusal(raw) {
    const text = String(raw || "");
    if (!text) return false;
    const refusal = /не могу|не получается|невозможно|cannot|can'?t|unable/i;
    // Границы слова `\b` в JavaScript считаются по ASCII, поэтому на кириллице
    // они не срабатывают: «ветка» — это не слово для регулярки. Берём основу.
    const branch = /pr_merged|\bbranch\b|ветк[а-яё]/iu;
    const merged = /слит|merged|pr_merged/i;
    const hint = /continue|продолж/i;
    return refusal.test(text) && branch.test(text) && merged.test(text) && hint.test(text);
  }

  /**
   * Повторить выдачу в чистую ветку, если агент отказался из-за `pr_merged`.
   *
   * Карточка остаётся Running с тем же Run ID: работа по ней не начиналась,
   * новый ход Координатора не нужен, откат в Ready только запутал бы очередь.
   * Повтор один: второй такой отказ — пауза с точной причиной, а не цикл.
   */
  function retryStaleBranchHandoff(expect) {
    if (!expect || !expect.roleId || !expect.sentAt) return false;
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" ||
        String(expect.roleName || "").toLowerCase() === "warden")) return false;
    const done = Number(expect.branchResend) || 0;
    if (done >= 1) return false;
    // Наша реплика с заданием — последняя в чате. Без этой отметки `deliver`
    // увидит её и решит, что сообщение уже отправлено, — повтор молча не уйдёт.
    const mine = messages().filter(isUserNode).at(-1);
    GM_setValue(K.deadSend, mine ? nodeId(mine) : "");
    GM_setValue(K.pending, {
      roleId: expect.roleId,
      roleName: expect.roleName,
      roleUrl: expect.roleUrl,
      text: expect.text,
      at: Date.now(),
      sendTries: 0,
    });
    GM_setValue(K.expect, {
      ...expect,
      sentAt: null,
      verified: false,
      branchResend: done + 1,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
    });
    log(
      `${expect.roleName || "Агент"} отказался начинать ход: его ветка уже слита (pr_merged). ` +
        "Это не ответ на задание — работы не было. Нажимаю Continue и отправляю задание заново, " +
        "в чистую ветку.",
      true,
      { ntfy: "quiet", title: "Relay: ветка слита, повторяю выдачу" },
    );
    return true;
  }

  /**
   * Ждём ответ без маркера. Возвращает true, если ход уже обработан
   * (напоминание ушло или цикл поставлен на паузу).
   *
   * why = "thin" — маркер пришёл, а отчёта в нём нет.
   */
  async function markerMissing(role, expect, markerName, manual = false, why = "") {
    // Пока агент печатает или «думает», ответа ещё нет: молчим, но по нажатию
    // «Шаг» объясняем, что именно ждём.
    if (stillWorking()) {
      if (manual) log(`${role.name} ещё отвечает (${busyLabel(busyReason())}) — подождите, потом нажмите «Шаг».`);
      return false;
    }
    // Страница ещё не отрисована — «маркера нет» говорить нельзя: его просто
    // не видно. То же правило, что в сторожe тишины, распространено на ручной
    // «Шаг»: пустая страница — не пустой чат.
    const page = pageReady(expect);
    if (!page.ok) {
      if (manual) {
        log(
          `Страница «${role.name}» ещё не отрисовалась (${page.why}) — подождите: ` +
            "читаю ответ из чата, а не из пустой страницы.",
        );
      }
      return false;
    }

    const replies = messagesAfter(expect.watermark || "");
    const last = replies.at(-1);
    if (!last) {
      // Ошибка Arena поверх нашего задания: сообщение в чате есть, а ход не
      // начался. От «агент думает» это отличается только самой ошибкой, поэтому
      // проверка стоит здесь. Первая переотправка — автоматическая (Мастер уже
      // нажал «Продолжить»); вторая подряд — пауза с честной причиной.
      const eaten = latestUserMessageAlert();
      if (eaten && expect.sentAt) {
        if (retryRejectedHandoff(expect, eaten, `Arena ответила «${eaten.text}»`)) {
          // Отправляем прямо здесь, а не «следующим тиком»: шаг уже выполняется,
          // и отложенный тик был бы молча проглочен сторожем блокировки.
          const again = await consumePending(true);
          if (!again) {
            log("Переотправка на этой странице не началась — задание осталось в очереди и уйдёт на следующем шаге.", true, {
              ntfy: "quiet",
            });
          }
          return true;
        }
        const isReloadable = /something went wrong|please try again/i.test(eaten.text || "");
        if (isReloadable) {
          const reloadKey = `${C.reloadCountPrefix}${expect.dispatchId || expect.ref || "unknown"}`;
          const count = Number(await GM_getValue(reloadKey, 0)) || 0;
          if (count < C.maxReloadAttempts) {
            await GM_setValue(reloadKey, count + 1);
            log(
              `Ошибка Arena «${eaten.text}»: перезагрузка страницы (попытка ${count + 1} из ${C.maxReloadAttempts}) и повтор отправки.`,
              true,
              { ntfy: "quiet" },
            );
            location.reload();
            return true;
          }
          await pause(
            `Ошибка Arena «${eaten.text}» повторился ${C.maxReloadAttempts} раз. Страница не восстанавливается автоматически; требуется Мастер.`,
            { kind: "arena-error", ref: eaten.messageId },
          );
          return true;
        }
        pause(
          `Arena снова не приняла задание: «${eaten.text}» (коротких повторов подряд: ${C.arenaResendMax}). ` +
            "Задание осталось в очереди — нажмите «Продолжить», оно уйдёт этой же карточке, " +
            "без нового хода Координатора.",
          { kind: "arena-error", ref: eaten.messageId },
        );
        return true;
      }
      // Нормальное ожидание, но нажатый «Шаг» должен получить ответ, а не тишину.
      if (manual) {
        const sentMin = expect.sentAt ? Math.max(1, Math.round((Date.now() - expect.sentAt) / 60000)) : 0;
        const delivered = expect.verified === true ? "доставка подтверждена" : "доставка не подтверждена";
        // Молчаливое «новых сообщений нет» уже один раз скрыло готовый ответ,
        // поэтому в журнал идёт разбор чата: сколько наших реплик, сколько
        // ответов и какой из них последний.
        const chat = messages();
        const mine = chat.filter(isUserNode).length;
        const answers = chat.filter((n) => !isUserNode(n));
        const lastAnswer = answers.at(-1);
        log(
          `Жду ответ ${role.name}: сообщений агента после нашего задания нет` +
            `${sentMin ? ` (отправлено ${sentMin} мин назад, ${delivered})` : " (ещё не отправлено)"}` +
            `, в чате ${chat.length} (наших ${mine}, ответов агента ${answers.length}` +
            `${lastAnswer ? `, последний ${nodeId(lastAnswer)}` : ""}). Маркера этой выдачи в чате нет.`,
        );
        dbg("ожидание ответа", { role: role.name, watermark: expect.watermark, sentAt: expect.sentAt, verified: expect.verified });
      }
      return false;
    }

    // Подпись считается по сырому тексту: текст, который «дописывается»,
    // каждый раз даёт другую подпись и откладывает решение.
    const signature = `${last.id}:${last.raw.length}`;
    // Ответ, который Arena уже закрыла, читается сразу: ждать «стабильности»
    // незачем, иначе нажатый «Шаг» дважды отвечает «дописывает».
    if (!last.ended && expect.lastReplySig !== signature) {
      GM_setValue(K.expect, { ...expect, lastReplySig: signature, lastReplyAt: Date.now() });
      if (manual) log(`${role.name} дописывает ответ — дочитаю, когда закончит.`);
      return false;
    }
    if (!last.ended && Date.now() - (expect.lastReplyAt || Date.now()) < C.markerIdleMs) {
      if (manual) log(`Ответ ${role.name} ещё может дописаться — подождите.`);
      return false;
    }

    dbg("ответ без маркера", { id: last.id, length: last.raw.length, tail: tail(last.raw, 300), why });
    const sent = Number(expect.tries) || 0;
    // Маркер мог быть и отвергнутым: «нет маркера» и «есть, но разбор его
    // выбросил» — разные поломки, и журнал обязан их различать.
    const reject = markerRejectHint(markerName);
    if (markerStep(sent) === "remind") {
      log(
        why === "thin"
          ? `${role.name} прислал только маркер ${markerName}, без отчёта — напоминание ${sent + 1} из ${C.markerReminders}.`
          : `${role.name} ответил без маркера ${markerName} — напоминание ${sent + 1} из ${C.markerReminders}. ` +
              `Прочитан хвост: «${tail(last.text, 110)}»${reject}`,
        true,
        { ntfy: "quiet", title: why === "thin" ? "Relay: маркер без отчёта" : "Relay: нет маркера" },
      );
      await sendToRole(role, markerReminder(role, expect, sent + 1, markerName, why), expect.kind, expect.ref, {
        missionId: expect.missionId,
        turnId: expect.turnId,
        runId: expect.runId,
        logId: expect.logId,
        title: expect.title,
        url: expect.url,
        tries: sent + 1,
        // Не считать время с напоминания временем работы по карточке.
        // Старые ожидания без отметки используют Started At из карточки.
        ...(expect.kind === "dispatch" ? {
          dispatchSentAt: Number(expect.dispatchSentAt) || 0,
          isDispatchReminder: true,
        } : {}),
      });
      return true;
    }

    const retained = retainRejectedResult(expect, "missing-marker", replies);
    const preservation = retained ? "Копия ответа сохранена локально; ожидание не снято." :
      "Ожидание не снято; локальную копию записать не удалось, сохраните ответ из чата вручную.";
    pause(
      (why === "thin"
        ? `${role.name} присылает только маркер ${markerName}, без отчёта, после ${C.markerReminders} напоминаний. ` +
            "Нужен Мастер: проверьте страницу агента. "
        : `${role.name} ответил без маркера ${markerName} после ${C.markerReminders} напоминаний. ` +
            `Нужен Мастер: проверьте страницу агента.${reject} `) + preservation,
      { kind: "marker", ref: expect.ref, runId: expect.runId, turnId: expect.turnId, tries: sent },
    );
    return true;
  }
