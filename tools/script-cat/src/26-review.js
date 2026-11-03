  // ───────────────────────────── приёмка миссии ─────────────────────────────
  /**
   * Конец миссии решает приёмка, а не Координатор.
   *
   * До 1.4.79 цикл останавливался по `next: "done"`: Координатор объявлял
   * миссию выполненной, скрипт ставил «Завершена» и гасил автоцикл. Проверка
   * была формальной — «в очереди ноль карточек», — и отвечала на вопрос «всё ли
   * выдано», а не «получилось ли то, о чём миссия». Настоящую ошибку видел
   * только человек, и только если открывал «Итог».
   *
   * Теперь `done` — это передача на приёмку. Роль с функцией `Reviewer`
   * получает промпт с оракулом, очередью и «Итогом» и отвечает маркером
   * `CF_REVIEW_RESULT`:
   *   accept → миссия «Завершена», автоцикл выключен, громкий пуш;
   *   rework → «Возвращена», круг +1, замечания в карточку миссии, ход
   *            Координатору — он разбирает их карточками.
   *
   * Доработок больше `reworkLimit` не бывает: следующий возврат не запускает
   * работу, а останавливает цикл и зовёт Мастера. Приёмка, которая возвращает
   * бесконечно, — не контроль, а вечный цикл.
   */
  const reviewerRole = async () => (await roles()).find((r) => r.fn === "Reviewer") || null;

  const missionRound = (mission) => {
    const n = mission?.properties?.["Круг"]?.number;
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  };

  /** Принятые карточки списком: что именно принято, с ответом и PR. */
  function reviewCards(cards) {
    const rows = Array.isArray(cards) ? cards : [];
    if (!rows.length) return "Принятых карточек нет — миссия закрывается без работы?";
    return rows
      .map((card) => {
        const id = taskTitle(card).split("·")[0].trim() || taskTitle(card);
        const who = taskRole(card) || "—";
        const pr = card.properties?.["PR"]?.url || "";
        const check = card.properties?.["Check"]?.select?.name || "";
        const answer = rt(card.properties["Ответ"]).replace(/\s+/g, " ").slice(0, 160);
        return `- ${id} · ${who}${pr ? ` · ${pr}` : ""}${answer ? ` · ответ: ${answer}` : ""}` +
          `${check ? ` · Check=${check}` : ""}${card.url ? ` · ${card.url}` : card.id ? ` · id: ${card.id}` : ""}`;
      })
      .join("\n");
  }

  function reviewPrompt(mission, role, turnId, round, queue, accepted) {
    const name = rt(mission.properties["Миссия"]) || "миссия";
    const tz = mission.properties["ТЗ URL"]?.url || "не задано";
    const result = rt(mission.properties["Итог"]).trim();
    return [
      technicalInfo(role),
      "",
      roleContext(role),
      "",
      `Миссия: ${name}`,
      `ТЗ и оракул: ${tz}`,
      `Круг: ${round} (доработок было ${round}, предел ${C.reworkLimit})`,
      `Очередь: ${queue.summary}`,
      "",
      `ПРИНЯТЫЕ КАРТОЧКИ (${accepted.length}; краткий список, ответ и PR могут быть сокращены):`,
      reviewCards(accepted),
      "Открой карточки и полные ответы/журналы для проверки: Accepted — состояние карточки, не доказательство pass; Check=fail и остатки не скрывай.",
      "",
      result
        ? `ИТОГ МИССИИ (как его записал Координатор):\n${result}`
        : "ИТОГ МИССИИ: поле «Итог» пусто — это уже повод не принимать.",
      "",
      "ЧТО ОТ ТЕБЯ ТРЕБУЕТСЯ",
      "Ты — приёмка миссии, а не исполнитель. Ничего не правь: ни карточки, ни код, ни документы. Смотри, выполнено ли то, о чём миссия, а не только «всё ли выдано».",
      "Проверяй по оракулу из ТЗ: каждый его пункт должен закрываться командой или артефактом, а не фразой. Если команду нельзя запустить — это и есть замечание.",
      "",
      "Решай по существу:",
      "1) Заявленное в «Итоге» совпадает с тем, что реально сделано карточками? Есть ли работа, которой нет в отчёте, и отчёт без работы?",
      "2) Оракул закрыт целиком? Проверки не ослаблены, не подменены и не «зелёные по договорённости»?",
      "3) Остались ли долги, обещанные «в следующий раз» без карточки и без записи в реестре?",
      "Принимаешь — цикл останавливается. Возвращаешь — Координатор получает замечания и разбирает их карточками.",
      "",
      "ОТВЕТ — одной строкой в конце:",
      `CF_REVIEW_RESULT {"mission_id":"${mission.id}","turn_id":"${turnId}","verdict":"accept","summary":"<одна строка: на что опирался>"}`,
      "или",
      `CF_REVIEW_RESULT {"mission_id":"${mission.id}","turn_id":"${turnId}","verdict":"rework","remarks":"1) <что не принято и чем это проверяется> 2) …"}`,
      "или, если без Мастера решить нельзя (нужен новый агент, доступ, смена ТЗ или оракула):",
      `CF_REVIEW_RESULT {"mission_id":"${mission.id}","turn_id":"${turnId}","verdict":"master","reason":"<чего именно не хватает>"}`,
      "Замечания — по пунктам и проверяемо: «не соответствует», «нет команды», «долг без записи». Придирка без проверки вернётся тебе же на четвёртом круге.",
      `Предел доработок: ${C.reworkLimit}. Следующий возврат не запускает работу, а будит Мастера — возвращай то, без чего миссию нельзя считать сделанной, а не то, что можно доделать следующим ТЗ.`,
      "verdict master — не «мне не нравится»: это остановка цикла и вызов Мастера. Только когда без него физически нельзя.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  /** Передать миссию на приёмку. Возвращает true: ход уже не у Координатора. */
  async function startReview(mission, queue) {
    const reviewer = await reviewerRole().catch(() => null);
    if (!reviewer) {
      // Приёмки нет — закрывать «за компанию» нельзя: миссия без вердикта
      // ничем не отличается от миссии, которую никто не проверял. Цикл стоит,
      // Мастер заводит роль (или закрывает миссию сам, зная, что принял её).
      pause(
        "Миссия готова к приёмке, но в базе «Роли» нет активной роли с функцией Reviewer: " +
          "принимать некому. Заведите роль (например, Warden с Agent URL) или закройте миссию сами — " +
          "без вердикта она не закроется.",
        { kind: "no-reviewer", ref: mission.id, notifyTitle: "Relay: приёмка не настроена" },
      );
      return true;
    }
    const round = missionRound(mission);
    let accepted;
    try {
      accepted = await tasks("Accepted", mission);
    } catch (e) {
      pause(`Не удалось полностью прочитать принятые карточки (${e.message}): приёмку не передаю с неполной очередью. Повторите после восстановления Notion.`,
        { kind: "review-cards-read", ref: mission.id });
      return true;
    }
    const turnId = uid();
    log(`Миссия готова к приёмке: круг ${round}, принято карточек ${accepted.length}. Передаю «${reviewer.name}».`);
    await sendToRole(reviewer, reviewPrompt(mission, reviewer, turnId, round, queue, accepted), "review", mission.id, {
      missionId: mission.id,
      turnId,
      round,
      title: "приёмка миссии",
    });
    return true;
  }

  /** Закрыть миссию. Право на это есть только у приёмки и у Мастера. */
  async function closeMission(mission, reviewer) {
    const at = nowIso();
    const returnedAt = mission.properties?.["Возвращена"]?.date?.start || "";
    await patch(mission.id, {
      "Состояние": { select: { name: "Завершена" } },
      "Завершена": { date: { start: at } },
    });
    // Событие объявляем сами и один раз: иначе `missionDoneNotice` следующим
    // тиком повторит тот же пуш про ту же дату.
    GM_setValue(`cfn-mission-done:${mission.id}:${at}:${returnedAt}`, true);
    // Отметка «закрыто приёмкой»: по ней `missionDoneNotice` отличает наше
    // закрытие от того, что агент поставил «Завершена» своей рукой.
    GM_setValue(`cfn-review:${mission.id}`, "accept");
    autoSet(false);
    const name = rt(mission.properties["Миссия"]) || "миссия";
    log(
      `Миссия «${name}» принята «${reviewer.name}»: закрыта, автоцикл остановлен. ` +
        "Следующая работа — новым ТЗ и новой миссией, а не хвостом этой.",
      false,
      { tone: "ok", ntfy: "loud", cycleStopped: true, title: "Relay: миссия принята" },
    );
    return true;
  }

  /** Вернуть миссию Координатору с замечаниями — или остановиться на пределе. */
  async function returnMission(mission, verdict, reviewer) {
    const round = missionRound(mission);
    const next = round + 1;
    const remarks = String(verdict.remarks || "").trim();
    if (!remarks) {
      pause(
        `«${reviewer.name}» вернул миссию без замечаний: исправлять нечего. Приёмка без причины — не приёмка: ` +
          "допишите замечания в карточку миссии и снимите паузу.",
        { kind: "review-empty", ref: mission.id },
      );
      return true;
    }
    if (next > C.reworkLimit) {
      // Предел доработок — не «ещё круг», а вызов Мастера: если три раза не
      // сошлось, четвёртый не сойдётся тоже. Расходится постановка, а не работа.
      pause(
        `Миссия прошла ${round} кругов доработки, и приёмка снова не приняла работу. Дальше решаете вы: ` +
          "сократить объём миссии, разделить её на две или принять как есть. Последние замечания:\n" +
          remarks,
        { kind: "rework-limit", ref: mission.id, notifyTitle: "Relay: миссия застряла в доработке" },
      );
      return true;
    }
    await patch(mission.id, {
      "Состояние": { select: { name: "Возвращена" } },
      "Возвращена": { date: { start: nowIso() } },
      "Круг": { number: next },
      "Замечания": { rich_text: richText(remarks) },
    });
    GM_setValue("cfn-plan-at", 0);
    GM_setValue(`cfn-review:${mission.id}`, "rework");
    log(
      `«${reviewer.name}» не принял миссию (круг ${next} из ${C.reworkLimit}): ${firstLine(remarks)}. ` +
        "Замечания в карточке миссии, ход — Координатору.",
      false,
      { tone: "warn", ntfy: "quiet", title: "Relay: миссия возвращена" },
    );
    const fresh = await notion("GET", `pages/${mission.id}`).catch(() => mission);
    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Миссия возвращена с приёмки, но активного Coordinator нет: ход возвращать некому.", {
        kind: "review-nocoord",
        ref: mission.id,
      });
      return true;
    }
    await requestPlan(fresh, coord, await queueOf(fresh), "Миссия возвращена с приёмки: разбери замечания карточками.", {
      force: true,
    });
    return true;
  }

  /** Ход отдельной приёмки миссии; вердикт по карточке сюда не относится. */
  async function reviewStep(role, expect, manual = false) {
    if (!expect || expect.kind !== "review") {
      pause("Это не отдельный ход приёмки миссии: вердикт не применяю.", {
        kind: "handoff-kind", ref: expect?.ref || "",
      });
      return true;
    }
    const currentReview = () => {
      const live = GM_getValue(K.expect, null);
      return Boolean(live && live.kind === "review" && norm(live.ref) === norm(expect.ref) &&
        norm(live.turnId) === norm(expect.turnId));
    };
    if (!currentReview()) {
      pause("Ожидание приёмки изменилось: чужой ход не перезаписываю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const mission = await activeMission();
    if (!mission) {
      pause("Приёмка ждёт ответа, а активной миссии нет: закрывать нечего.", {
        kind: "review-no-mission", ref: expect.ref || "",
      });
      return true;
    }
    if (norm(expect.ref) !== norm(mission.id) || (expect.missionId && norm(expect.missionId) !== norm(mission.id))) {
      pause("Ожидание приёмки относится к другой миссии: ничего не меняю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const replies = messagesAfter(expect.watermark);
    const decision = replies.map((m) => parseMarker(m.raw, "CF_REVIEW_RESULT"))
      .filter(Boolean)
      .at(-1);
    if (!decision) return markerMissing(role, expect, "CF_REVIEW_RESULT", manual);
    if (!isUuid(mission.id) || !isUuid(expect.turnId) || !isUuid(decision.mission_id) || !isUuid(decision.turn_id) ||
        norm(decision.mission_id) !== norm(mission.id) || norm(decision.turn_id) !== norm(expect.turnId) ||
        decision.dispatch_id || decision.run_id) {
      const retained = retainRejectedResult(expect, "mission-review-identity", replies);
      pause("Маркер не относится к этому ходу приёмки миссии (mission_id / turn_id / карточка): ничего не меняю. " +
        (retained ? "Копия ответа сохранена локально." : "Локальная копия не записалась — сохраните ответ из чата вручную."), {
        kind: "marker-mismatch", ref: mission.id, turnId: expect.turnId || "",
      });
      return true;
    }
    const verdict = String(decision.verdict || "").trim().toLowerCase();
    if (verdict === "accept") {
      // Очередь могла измениться, пока Reviewer проверял миссию. Старый
      // вердикт не распространяется на новые или незакрытые карточки.
      const fresh = await queueOf(mission);
      const open = fresh.submitted.length + fresh.running.length + fresh.ready.length + fresh.rework.length + (fresh.blocked || []).length;
      if (open) {
        if (currentReview()) GM_setValue(K.expect, null); // старое принятие нельзя повторить после обработки новой работы
        pause(`Пока шла приёмка, очередь изменилась: ${fresh.summary}. Миссия не закрыта; ` +
          "разберите карточки и запустите приёмку заново.", {
          kind: "review-with-open", ref: mission.id,
        });
        return true;
      }
      const stillActive = await activeMission();
      if (!stillActive || norm(stillActive.id) !== norm(mission.id) || !currentReview()) {
        pause("Пока шла приёмка, активная миссия или ожидание изменились: ничего не закрываю.", {
          kind: "marker-mismatch", ref: mission.id,
        });
        return true;
      }
      if (decision.summary) log(`Приёмка: ${oneLine(decision.summary, 300)}`);
      const closed = await closeMission(stillActive, role);
      if (currentReview()) GM_setValue(K.expect, null); // только после подтверждённой записи миссии
      return closed;
    }
    if (verdict === "rework") {
      if (!currentReview()) {
        pause("Ожидание приёмки изменилось: возврат не применяю.", { kind: "marker-mismatch", ref: mission.id });
        return true;
      }
      GM_setValue(K.expect, null);
      try {
        return await returnMission(mission, decision, role);
      } catch (e) {
        if (!GM_getValue(K.expect, null)) GM_setValue(K.expect, expect);
        throw e;
      }
    }
    if (verdict === "master") {
      pause(`Приёмка просит Мастера: ${firstLine(decision.reason || decision.remarks || "причина не указана")}. Миссия не закрыта.`, {
        kind: "review-needs-master", ref: mission.id,
      });
      return true;
    }
    pause(
      `В маркере приёмки нет verdict accept, rework или master (пришло «${verdict || "пусто"}»): миссию не трогаю. ` +
        "Поправьте маркер в ответе приёмки и нажмите «Продолжить».",
      { kind: "review-marker", ref: mission.id },
    );
    return true;
  }
