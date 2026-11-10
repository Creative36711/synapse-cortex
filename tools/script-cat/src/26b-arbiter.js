  // ───────────────────────── арбитраж повторяющейся петли ─────────────────────────
  /**
   * D-053: карточку перевыдали N раз за окно — это ещё не повод будить Мастера.
   *
   * Раньше третья перевыдача одной карточки сразу ставила паузу: цикл замирал,
   * звонил телефон, и человек шёл разбираться, почему Координатор и исполнитель
   * гоняют одну работу. 07.11 на SYN-2 · S-4 так вышло трижды: исполнитель
   * честно отдал draft-PR с описанием блокера по Scope, транспорт увидел «нет
   * заявки о мерже» и вернул карточку в Rework — правила сработали, а разбирать
   * петлю было некому, кроме Мастера.
   *
   * Теперь цикл останавливается не сразу: та же карточка уходит арбитру —
   * роли с функцией Reviewer (в проекте это Warden). Арбитр видит факты (поле
   * «Ответ», состояние карточки, PR по GitHub, журнал попыток, очередь) и
   * выносит решение по карточке. Остановить цикл он тоже может — но это его
   * решение (`verdict:master`), а не первая реакция транспорта.
   *
   * Инварианты сохранены:
   *   • пауза снимается только человеком — арбитраж ничего не «продолжает» сам;
   *   • маркер арбитра несёт dispatch_id этой карточки и turn_id этого разбора;
   *   • нет активного Warden — прежняя пауза Мастера, без выдуманных решений;
   *   • Мастер остаётся последней инстанцией: и через арбитра, и через границу
   *     числа арбитражей (`arbiterLimit`);
   *   • арбитр ничего не правит руками: его выход — решение или остановка.
   */

  /** Сколько раз эту карточку отдавали арбитру в окне (ключ — сама карточка). */
  const arbiterKey = (id) => `cfn-arbiter:${id}`;
  const ARBITER_WINDOW = 3600 * 1000 * Number(C.arbiterWindowHours || 6);

  function noteArbitration(id) {
    const now = Date.now();
    const kept = (GM_getValue(arbiterKey(id), []) || []).map(Number).filter((at) => now - at < ARBITER_WINDOW);
    kept.push(now);
    GM_setValue(arbiterKey(id), kept);
    return kept.length;
  }

  function arbitrationCount(id) {
    const now = Date.now();
    return (GM_getValue(arbiterKey(id), []) || []).map(Number).filter((at) => now - at < ARBITER_WINDOW).length;
  }

  /**
   * Роль-арбитр: функция Reviewer (в проекте — Warden) с заполненным Agent URL.
   *
   * Отдельной «роли арбитра» в Notion нет намеренно: арбитраж — это работа
   * приёмки, и заводить вторую строку ради неё значило бы дать одной и той же
   * функции два разных права.
   */
  async function arbiterRole() {
    const list = await roles().catch(() => []);
    return list.find((r) => r.fn === "Reviewer" && r.url && r.status === "Активна") ||
      list.find((r) => r.fn === "Reviewer" && r.url) || null;
  }

  /** Короткая строка ответа для промпта: без разметки и лишних переводов. */
  const arbiterLine = (text, n = 400) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
  };

  /**
   * Журнал попыток этой карточки: что транспорт уже видел.
   *
   * Источник — журнал профилей промптов (`recordPromptAttempt`): время, профиль,
   * исход, класс ошибки. Без секретов и без полных текстов задания — арбитру
   * нужен ход событий, а не переписка.
   */
  function arbiterAttempts(cardId, limit = Number(C.arbiterAttempts || 6)) {
    const list = GM_getValue("cfn-prompt-journal-v1", []);
    if (!Array.isArray(list)) return "";
    return list
      .filter((row) => row && norm(row.ref) === norm(cardId))
      .slice(-limit)
      .reverse()
      .map((row) => {
        const at = String(row.at || "").replace("T", " ").slice(0, 16);
        return [`${at} · ${row.kind || "?"}`, row.profileId, `overhead ${row.overhead ?? "?"}`,
          row.outcome, row.errorClass].filter(Boolean).join(" · ");
      })
      .join("\n");
  }

  /** Состояние PR по GitHub — без догадок из чата. Ошибка не отменяет разбор. */
  async function arbiterPrState(prUrl) {
    const raw = String(prUrl || "").trim();
    const ref = raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
    if (!ref) return { pr: raw, prState: "" };
    try {
      const pr = await githubPr(`${ref[1]}/${ref[2]}`, Number(ref[3]), ghToken());
      const prState = pr?.merged || pr?.merged_at
        ? "слит"
        : String(pr?.state || "").toLowerCase() === "closed"
          ? "закрыт без мержа"
          : pr?.draft ? "draft, открыт" : "открыт";
      return { pr: raw, prState };
    } catch (e) {
      return { pr: raw, prState: `состояние не прочитано (${firstLine(e?.message || String(e), 80)})` };
    }
  }

  /**
   * Собрать дело для арбитра. Все факты читаются заново: карточка могла
   * измениться между выдачей и этим шагом. Ошибка Notion не превращается в
   * «петли нет» — просто фактов меньше, и это видно в промпте.
   */
  async function arbiterCase(card, why = "") {
    const fresh = await notion("GET", `pages/${card.id}`);
    const mission = await activeMission().catch(() => null);
    const pr = await arbiterPrState(fresh.properties?.["PR"]?.url || "");
    let queue = "";
    if (mission) {
      try { queue = (await queueOf(mission)).summary; } catch { queue = ""; }
    }
    const now = Date.now();
    const redispatch = (GM_getValue(redispatchKey(card.id), []) || []).map(Number)
      .filter((at) => now - at < REDISPATCH_WINDOW);
    return {
      cardId: card.id,
      cardTitle: taskTitle(fresh) || card.title || card.id,
      missionId: rt(fresh.properties?.["Mission ID"]).trim() || mission?.id || "",
      role: taskRole(fresh),
      redispatchCount: redispatch.length,
      redispatchLimit: REDISPATCH_LIMIT,
      windowHours: Math.round(REDISPATCH_WINDOW / 3600000),
      reason: why || redispatchWhy(fresh),
      state: taskState(fresh),
      check: fresh.properties?.["Check"]?.select?.name || "",
      answer: arbiterLine(rt(fresh.properties?.["Ответ"])),
      pr: pr.pr,
      prState: pr.prState,
      attempts: arbiterAttempts(card.id),
      queue,
      missionName: mission ? rt(mission.properties?.["Миссия"]) || mission.id : "",
    };
  }

  /** Промпт арбитра. Пустой envelope — пауза уже поставлена компилятором. */
  function arbiterPrompt(role, kase, turnId, attempt = 1) {
    return compileOrPause({
      kind: "arbiter",
      role: promptRole(role),
      mission: { id: kase.missionId, name: kase.missionName },
      turnId,
      arbiter: kase,
      delivery: { tier: "full", attempt },
    }, `arbiter ${kase.cardId}`);
  }

  /**
   * Отдать карточку арбитру вместо паузы.
   *
   * true  — ход ушёл арбитру либо цикл остановлен по лимиту арбитражей:
   *         продолжать прежний шаг нельзя;
   * false — арбитра нет (или дело не прочитать); вызывающий ставит прежнюю
   *         паузу Мастера. Порог `arbiterLimit` не даёт звать арбитра по кругу:
   *         арбитр — не бесконечный цикл, а последняя попытка разобраться.
   */
  async function escalateToWarden(card, why = "") {
    const role = await arbiterRole();
    if (!role) return false;
    const times = noteArbitration(card.id);
    if (times > Number(C.arbiterLimit || 2)) {
      pause(
        `«${taskTitle(card) || card.id}» уже ${times} раз уходила арбитру, и петля не разобрана. ` +
          "Дальше решает Мастер: посмотрите «Ответ», журнал попыток и постановку карточки. " +
          "Цикл остановлен, карточка и очередь на месте.",
        { kind: "arbiter-limit", ref: card.id, notifyTitle: "Relay: петля не разобрана" },
      );
      return true;
    }
    let kase;
    try {
      kase = await arbiterCase(card, why);
    } catch (e) {
      // Дело арбитра не прочитать — выдумывать его нельзя. Прежняя пауза
      // честнее: она называет причину, а не показывает арбитру пустоту.
      log(`Карточку «${card.id}» не прочитать для арбитража: ${e.message}`, true);
      return false;
    }
    const turnId = uid();
    log(
      `«${kase.cardTitle}» перевыдали ${kase.redispatchCount} раз за ${kase.windowHours} ч — ` +
        `передаю арбитру «${role.name}» (разбор ${times} из ${C.arbiterLimit}).`,
      true,
      { ntfy: "quiet", title: "Relay: петля у арбитра" },
    );
    await sendToRole(role, arbiterPrompt(role, kase, turnId), "arbiter", kase.cardId, {
      missionId: kase.missionId || "",
      turnId,
      title: `арбитраж «${kase.cardTitle}»`,
      arbiter: kase,
    });
    return true;
  }

  /** Ожидание арбитража всё ещё наше: карточка и ход те же. */
  function currentArbitration(expect) {
    const live = GM_getValue(K.expect, null);
    return Boolean(live && live.kind === "arbiter" && norm(live.ref) === norm(expect.ref) &&
      norm(live.turnId) === norm(expect.turnId));
  }

  /** Записать разбор в карточку: человек должен видеть причину без журнала. */
  async function recordArbitration(cardId, decision) {
    const line = [
      `Арбитраж Warden (${nowIso().slice(0, 16).replace("T", " ")}): ${decision.action}.`,
      `Причина: ${arbiterLine(decision.reason, 600)}.`,
      decision.fix ? `Правка постановки: ${arbiterLine(decision.fix, 600)}.` : "",
    ].filter(Boolean).join(" ");
    try {
      await patch(cardId, { "Ответ": { rich_text: richText(line) } });
      return true;
    } catch (e) {
      // Решение всё равно применяется: потерять разбор петли хуже, чем строку
      // в поле, но Мастер об этом узнаёт из журнала.
      log(`Разбор арбитра не записался в карточку «${cardId}»: ${e.message}`, true);
      return false;
    }
  }

  /**
   * Ход арбитра: решение по карточке или остановка цикла.
   *
   * Решения (`verdict:resolve`):
   *   ready    — та же карточка уходит в Ready заново; причина и правка
   *              постановки остаются в поле «Ответ», чтобы их увидели
   *              исполнитель и Координатор;
   *   rework   — карточка возвращается автору постановки;
   *   accepted — работа на самом деле выполнена;
   *   blocked  — карточка в Blocked, цикл идёт дальше без неё;
   * `verdict:master` — остановка цикла; дальше только человек.
   *
   * В любом решении ход возвращается Координатору: работу по-прежнему выбирает
   * он, а арбитр лишь снимает петлю и называет причину.
   */
  async function arbiterStep(role, expect, manual = false) {
    if (!expect || expect.kind !== "arbiter") {
      pause("Это не ход арбитража: решение не применяю.", { kind: "handoff-kind", ref: expect?.ref || "" });
      return true;
    }
    if (!currentArbitration(expect)) {
      pause("Ожидание арбитража изменилось: чужой ход не перезаписываю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const cardId = String(expect.ref || "").trim();
    if (!isUuid(cardId)) {
      pause("Арбитраж ссылается на несуществующую карточку: решение не применяю.", {
        kind: "marker-mismatch", ref: cardId,
      });
      return true;
    }
    const replies = messagesAfter(expect.watermark);
    const decision = replies.map((m) => parseMarker(m.raw, "CF_ARBITER_RESULT")).filter(Boolean).at(-1);
    if (!decision) return markerMissing(role, expect, "CF_ARBITER_RESULT", manual);

    const turn = String(decision.turn_id || "").trim();
    const dispatch = String(decision.dispatch_id || "").trim();
    const matches = isUuid(expect.turnId) && isUuid(turn) && isUuid(dispatch) &&
      norm(turn) === norm(expect.turnId) && norm(dispatch) === norm(cardId) &&
      (!expect.roleId || (role?.id && norm(role.id) === norm(expect.roleId)));
    if (!matches) {
      const retained = retainRejectedResult(expect, "arbiter-identity", replies);
      pause("Маркер арбитража не относится к этой карточке и этому разбору (dispatch_id / turn_id / адресат). " +
        (retained ? "Копия ответа сохранена локально; " : "Локальная копия не записалась — сохраните ответ из чата вручную; ") +
        "попросите арбитра повторить маркер с ID из этого промпта.", {
        kind: "marker-mismatch", ref: cardId, turnId: expect.turnId || "",
      });
      return true;
    }

    const verdict = String(decision.verdict || "").trim().toLowerCase();
    if (verdict === "master") {
      // Остановка цикла — право арбитра, но снимает её по-прежнему человек.
      GM_setValue(K.expect, null);
      GM_setValue(arbiterKey(cardId), []);
      pause(
        `Арбитр «${role.name}» не смог разобрать петлю по «${expect.title || cardId}»: ` +
          `${firstLine(decision.reason || decision.fix || "причина не указана")}. ` +
          "Цикл остановлен решением арбитра; карточка, очередь и «Ответ» на месте — " +
          "посмотрите их и нажмите «Продолжить».",
        { kind: "arbiter-master", ref: cardId, turnId: expect.turnId || "", notifyTitle: "Relay: арбитр остановил цикл" },
      );
      return true;
    }
    if (verdict !== "resolve") {
      pause(
        `В маркере арбитража нет verdict resolve или master (пришло «${verdict || "пусто"}»): карточку не трогаю. ` +
          "Поправьте маркер в ответе арбитра и нажмите «Продолжить».",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }

    const action = String(decision.action || "").trim().toLowerCase();
    if (!["ready", "rework", "accepted", "blocked"].includes(action)) {
      pause(
        `Арбитр вынес решение без понятного действия по карточке (action «${action || "пусто"}»). ` +
          "Нужно ready / rework / accepted / blocked: карточку не трогаю, чтобы не запустить петлю заново.",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }
    // Решение без причины — это не разбор петли, а её продолжение.
    const reason = String(decision.reason || "").trim();
    if (!reason) {
      pause(
        "Арбитр не назвал причину петли: решение без причины повторяет ту же работу и возвращает ту же беду. " +
          "Допишите reason и нажмите «Продолжить».",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }

    // Дальше карточка читается заново: между разбором и решением её могли
    // тронуть. Чужое решение вслепую не применяется.
    const card = await notion("GET", `pages/${cardId}`);
    const mission = await activeMission().catch(() => null);
    const cardMission = rt(card.properties?.["Mission ID"]).trim();
    if (mission && cardMission && norm(cardMission) !== norm(mission.id)) {
      pause("Карточка арбитража относится к другой миссии: решение не применяю.", {
        kind: "marker-mismatch", ref: cardId,
      });
      return true;
    }

    await recordArbitration(cardId, { ...decision, action, reason });
    // Решение применяется одной записью состояния. Следы прошлого ответа
    // (Submitted At, PR, Run ID, Check) снимает выдача: арбитр их не трогает,
    // иначе «Ответ» исчезнет раньше, чем его прочитают.
    if (action === "accepted") {
      await patch(cardId, { "Dispatch State": { select: { name: "Accepted" } } });
    } else if (action === "rework") {
      await patch(cardId, { "Dispatch State": { select: { name: "Rework" } } });
    } else if (action === "blocked") {
      await patch(cardId, { "Dispatch State": { select: { name: "Blocked" } } });
    } else {
      // ready: карточка возвращается в работу. Check описывает прошлый ответ,
      // который арбитр как раз и не признал, поэтому он снимается вместе с
      // решением, а не остаётся молчаливым запретом на выдачу.
      await patch(cardId, {
        "Dispatch State": { select: { name: "Ready" } },
        Check: { select: null },
      });
    }
    GM_setValue(K.expect, null);
    // Порог перевыдач обнуляется: петля разобрана и названа. Если та же карточка
    // закрутится снова, счёт начнётся заново, а не с порога.
    GM_setValue(redispatchKey(cardId), []);
    log(
      `Арбитраж по «${taskTitle(card) || cardId}»: action=${action}, причина — ${firstLine(reason)}` +
        (decision.fix ? `; правка постановки: ${firstLine(decision.fix, 160)}` : "") +
        ". Ход возвращается Координатору.",
      false,
      { tone: "ok" },
    );

    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Петля разобрана, но активного Coordinator нет: ход возвращать некому.", {
        kind: "arbiter-nocoord", ref: cardId,
      });
      return true;
    }
    if (!mission) {
      pause("Петля разобрана, но активной миссии нет: ход возвращать некому.", {
        kind: "arbiter-nomission", ref: cardId,
      });
      return true;
    }
    // D-095: разбор петли — тоже ход приёмки. Сессия Warden закрывается здесь,
    // а не при следующей отправке: следующая работа идёт в его же ветку.
    if (typeof finishReviewerTurn === "function") {
      await finishReviewerTurn("петля разобрана").catch(() => {});
    }
    const fresh = await notion("GET", `pages/${mission.id}`).catch(() => mission);
    await requestPlan(
      fresh,
      coord,
      await queueOf(fresh),
      `Warden разобрал петлю по «${taskTitle(card) || cardId}»: ${action} — ${firstLine(reason, 200)}. ` +
        (decision.fix ? `Правка постановки: ${firstLine(decision.fix, 200)}. ` : "") +
        "Учти это в следующем ходе и не выдавай карточку тем же порядком.",
      { force: true },
    );
    return true;
  }
