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
      // D-083: адресат прямого вопроса обязан пережить очередь.
      //
      // `gate` держит ход, но «держать» без имени — это остановка ради
      // остановки: 09.11 Координатор ставил next:"blocked" + need:"Warden"
      // потому, что иначе позвать Warden было нечем, а транспорт такое
      // сочетание не читал вовсе. Поле лежит в `q`, а не в `ctx`: так его
      // заполняет маркер, и так же его видят `askQuestion`/`startAnswer`.
      gate: q.gate === true,
      // Адресат имеет смысл только вместе с gate: `parseQuestion` по тому же
      // правилу обнуляет `need` у обычного вопроса. Иначе «спросить между
      // делом» с именем роли уводило бы ход к ней без всякой нужды.
      need: q.gate === true ? String(q.need || "") : "",
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
    return compileOrPause({
      kind: "answer",
      role: promptRole(role),
      mission: { id: mission.id, name: rt(mission.properties["Миссия"]) || "миссия", tzUrl: mission.properties["ТЗ URL"]?.url || "" },
      turnId, // тот же turn_id; после masterEscalated новый не создаётся
      question: {
        id: item.id, turnId,
        text: item.text, fullText: item.fullText || item.text,
        options: Array.isArray(item.options) ? item.options : [],
        fallback: item.fallback, sourceUrl: item.pageUrl || item.url || "",
        role: item.role || "", card: item.card || "",
        masterEscalated: Boolean(item.masterEscalated),
        // D-082: приёмка отвечает на одну запись за ход — так устроен ход, и это
        // не изменится. Но «сколько ещё ждёт» она знать должна: 09.11 Warden
        // отвечал на предложение и не видел второго, хотя оба лежали в базе.
        // Факт ниже считает очередь приёмки, а не открытые строки базы: именно
        // эта очередь и будет отдана ей следующими ходами, по одной.
        pending: answerQueue().length,
      },
      delivery: { tier: "full", attempt: 1 },
    }, `answer ${item.id}`);
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
        if (!(await verifiedAdrMaterial(complete))) {
          const hasMarker = /\bCF_ADR_CONTENT\s+[0-9a-f]{40}\b/i.test(String(complete.fullText || ""));
          throw new Error(hasMarker
            ? "полный текст не совпадает с Git blob SHA"
            : "сторож ещё не дописал полный текст файла с Git blob SHA");
        }
        item = { ...item, fullText: complete.fullText, url: complete.url || item.url };
      } catch (e) {
        logThrottled(`adr-body:${item.id}`, `Предложение не передано приёмке: ${e.message}. Вопрос и ожидание сохранены; проверьте полный текст и SHA.`, true);
        return false;
      }
    }
    // D-083: «прямая обратная связь» — это адресованная обратная связь.
    //
    // Раньше адресата выбирала только функция роли: любой вопрос уходил
    // активному Reviewer, а `need` из маркера не читался никем. Отсюда и
    // тупик 09.11: Координатору нужен был именно Warden, назвать его было
    // нечем — `need` работал только как повод остановить цикл. Теперь имя из
    // `need` выбирает роль, а функция Reviewer остаётся запасным ответом.
    const asked = String(item.need || "").trim();
    const directory = asked ? await roleRows().catch(() => []) : [];
    const named = asked ? directory.find((r) => norm(r.name) === norm(asked)) : null;
    // Роль названа, но ответить физически не может (нет строки, не «Активна»,
    // пуст «Agent URL») — это не повод молча отдать вопрос другому: так
    // Координатор и не узнал, что звал в пустоту. Оставляем в очереди: когда
    // Мастер дозаполнит роль, вопрос уйдёт сам.
    if (asked && !(named && (named.status || "") === "Активна" && named.url)) {
      logThrottled(
        `answer-need:${item.id}`,
        `Обратная связь «${oneLine(item.text, 90)}» адресована роли «${asked}», а она не готова ` +
          `(${named ? "не активна или пуст «Agent URL»" : "нет в «Ролях»"}). Вопрос остаётся в очереди: ` +
          "как только роль дозаполнят, ход уйдёт без повторной записи.",
        true,
        { ntfy: "quiet", title: "Relay: адресат обратной связи не готов" },
      );
      return false;
    }
    const role = named || (await reviewerRole());
    if (!role) {
      log(
        "Вопрос записан, но активной роли с функцией Reviewer нет: отвечать некому, а адресат не назван — вопрос ждёт Мастера.",
        false,
        { ntfy: "quiet", title: "Relay: отвечать на вопрос некому" },
      );
      dropAnswer(item.id);
      return false;
    }
    const turnId = uid();
    // D-068: «передан» пишем только тогда, когда ход действительно поставлен в
    // очередь. Раньше строка печаталась до отправки и оставалась правдой даже
    // при защитном отказе `sendToRole` (дубль, запрещённый адресат, окно
    // настроек): в журнале ход «ушёл», а в очереди его нет — и цикл молча
    // остаётся на странице Координатора.
    const queued = await sendToRole(role, answerPrompt(mission, role, item, turnId), "answer", item.id, {
      questionId: item.id,
      missionId: mission.id,
      turnId,
      title: "ответ на вопрос агента",
    });
    if (!queued) {
      log(
        `Вопрос «${oneLine(item.text, 90)}» не передан приёмке: транспорт не поставил ход в очередь ` +
          "(защитный отказ или окно настроек). Вопрос остаётся «Ждёт» и повторится на следующем шаге.",
        true,
        { ntfy: "quiet", title: "Relay: вопрос не передан" },
      );
      return false;
    }
    log(`Вопрос «${oneLine(item.text, 90)}» передан приёмке «${role.name}».`, false, { ntfy: "quiet" });
    return true;
  }

  /**
   * D-101: реплика этой выдачи в чате — доказательство, что сообщение дошло.
   *
   * Ищем не «похожий текст», а то, за что можно зацепиться: `turn_id` этой
   * выдачи (он есть только в нашем задании), либо маркер приёмки с её
   * question_id/turn_id, либо собственный хвост вопроса. Раньше доставку считали
   * состоявшейся по одному водяному знаку: «после отметки есть сообщения» — а
   * сообщения могли быть от прошлой выдачи.
   */
  function deliveryEcho(message, expect) {
    const text = String((message && (message.raw || message.text)) || "");
    if (!text) return false;
    const turn = String(expect.turnId || "");
    if (turn && text.includes(turn)) return true;
    if (text.includes("CF_ANSWER_RESULT") && text.includes(String(expect.ref || "—"))) return true;
    // Проба вопроса из задания: маркер начала, иначе хвост текста вопроса.
    const opening = "ОТВЕТ НА ВОПРОС";
    if (text.includes(opening)) return true;
    const own = String(expect.questionFirstLine || "").trim();
    return Boolean(own && own.length > 24 && text.includes(own.slice(0, 40)));
  }

  /**
   * Ответа нет и доставка не подтверждена. Пауза здесь была бы ошибкой: она
   * запрещает повторную отправку — единственное, что в этом случае помогает.
   * Возвращаем задание в очередь и говорим об этом Мастеру один раз.
   */
  function undeliveredAnswer(expect, manual) {
    const live = GM_getValue(K.expect, null);
    const mine = live && norm(live.ref) === norm(expect.ref) && norm(live.turnId) === norm(expect.turnId);
    if (!mine && !manual) return false;
    // Возвращаем вопрос в ту же очередь приёмки: `queueAnswer` заменяет запись
    // по id, поэтому повторной пары «вопрос + копия» не образуется.
    const item = answerQueue().find((q) => norm(q.id) === norm(expect.ref)) || null;
    const restored = item || {
      id: expect.ref, text: expect.questionFirstLine || "", fullText: "",
      roleName: expect.roleName || "", card: expect.card || "", mission: expect.missionId || "",
    };
    queueAnswer({ id: expect.ref }, {
      id: expect.ref, text: restored.text || "", fullText: restored.fullText || restored.text || "",
      fallback: restored.fallback, options: restored.options, gate: restored.gate,
      need: restored.need, url: restored.url,
    }, { roleName: restored.role || restored.roleName, card: restored.card, mission: restored.mission });
    GM_setValue(K.expect, null);
    log(
      `Доставка не подтвердилась: в чате «${expect.roleName || "приёмки"}» нет ни реплики этой выдачи ` +
        `(turn ${String(expect.turnId || "").slice(0, 8)}), ни маркера. Ответа агент не видел — это сбой доставки, а не его ответ. ` +
        "Задание возвращено в очередь и уйдёт следующим шагом; если в чате пусто, обновите страницу.",
      true,
      { tone: "warn", ntfy: "quiet", title: "Relay: вопрос не дошёл до приёмки" },
    );
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
    if (!decision) {
      // D-101: «ответа не видно» и «доставка не подтвердилась» — разные беды.
      //
      // 10.11, 09:59: сообщение на вопрос 4146f0cf ушло в чат Warden и там не
      // появилось (сбой Arena), Мастер обновил страницу — и ход сразу ушёл
      // Transport Maintainer'у как marker-mismatch. Ответа не было вовсе, а
      // разбор искал несовпадение ID. Пока доставка не подтверждена (в чате нет
      // ни реплики этой выдачи, ни маркера), пауза запрещает ровно то, что
      // нужно: повторную отправку. Ждём так же, как ждёт `markerMissing`: пока
      // агент печатает и пока страница не отрисована.
      // Доставка подтверждается репликой этой выдачи: пустой чат после
      // отметки — это не «агент промолчал», а «сообщение не дошло».
      const all = messagesAfter(expect.watermark);
      const echo = all.some((m) => deliveryEcho(m, expect));
      if (!all.length || (!echo && !all.some((m) => String((m && (m.raw || m.text)) || "").trim().length > 200))) {
        if (stillWorking()) {
          if (manual) log(`${role.name} ещё отвечает (${busyLabel(busyReason())}) — подождите, потом нажмите «Шаг».`);
          return false;
        }
        const page = pageReady(expect);
        if (page.ok !== true) {
          // Ждём, но не молчим: 09:59 Мастер минуты смотрел на «ничего не
          // происходит» и не знал, что реплики в чате нет вовсе. Переотправки
          // здесь нет намеренно — агент мог думать и дольше минуты.
          const waited = Date.now() - Number(expect.sentAt || 0);
          if (waited > 60_000) {
            logThrottled(
              `answer-undelivered:${expect.ref}:${expect.turnId}`,
              `В чате «${role.name}» нет реплики этой выдачи (${page.why}) уже ${Math.round(waited / 60000)} мин. ` +
                "Похоже, сообщение не дошло. Ожидание держу: обновите страницу агента — если чат пуст, вопрос уйдёт заново.",
              true,
              { ntfy: "quiet", title: "Relay: вопрос не дошёл до приёмки" },
            );
          }
          if (manual) log(`Страница «${role.name}» ещё не отрисовалась (${page.why}) — подождите.`);
          return false;
        }
        if (!all.length) return undeliveredAnswer(expect, manual);
      }
      return markerMissing(role, expect, "CF_ANSWER_RESULT", manual);
    }
    // Одного нового сообщения в чате недостаточно: оно может относиться к
    // предыдущему вопросу или повторной попытке того же вопроса. Не очищаем
    // ожидание и не записываем решение, пока обе границы не подтверждены.
    const qid = String(decision.question_id || "").trim();
    const turn = String(decision.turn_id || "").trim();
    const live = GM_getValue(K.expect, null);
    // Живое ожидание — тот же вопрос и тот же ход, но привязка могла быть
    // восстановлена другим написанием (регистр, старый формат без дефисов).
    // Это не подмена: ID маркера совпадают с этой выдачей, и ответ — её.
    if (live && norm(live.ref) === norm(expect.ref) && norm(live.turnId) === norm(expect.turnId) &&
        norm(live.kind) === norm(expect.kind) && norm(live.turnId) === norm(turn)) {
      expect = { ...expect, ...live };
    }
    const matches = Boolean(isUuid(expect.ref) && isUuid(expect.turnId) && isUuid(qid) && isUuid(turn) && live && live.kind === "answer" &&
      norm(qid) === norm(expect.ref) && norm(turn) === norm(expect.turnId) &&
      norm(live.ref) === norm(expect.ref) && norm(live.turnId) === norm(expect.turnId) &&
      (!expect.roleId || (role?.id && norm(role.id) === norm(expect.roleId))) &&
      (!live.roleId || (expect.roleId && norm(live.roleId) === norm(expect.roleId))));
    if (!matches) {
      const retained = retainRejectedResult(expect, "answer-identity", replies);
      // Какой именно признак не сошёлся: без этого строка «question_id /
      // turn_id / адресат» отправляла Мастера проверять три вещи сразу.
      const expectQ = norm(expect.ref);
      const expectT = norm(expect.turnId);
      const liveQ = norm(live?.ref);
      const liveT = norm(live?.turnId);
      const why = [];
      if (!isUuid(qid) || !isUuid(turn)) why.push("в маркере не UUID");
      else {
        if (norm(qid) !== expectQ) why.push("question_id чужой");
        if (norm(turn) !== expectT) why.push("turn_id чужой");
      }
      if (!live || live.kind !== "answer") why.push(`ожидание уже не ответ (${live?.kind || "пусто"})`);
      else {
        if (liveQ !== expectQ) why.push("ожидание переписано другим вопросом");
        if (liveT !== expectT) why.push("ожидание переписано другим ходом");
      }
      if (expect.roleId && norm(role?.id) !== norm(expect.roleId)) why.push("адресат не тот агент");
      pause("Ответ не подтверждён для текущего вопроса и хода: " + (why.join(", ") || "признаки не сошлись") + ". " +
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
    // D-085: номер решения берётся из репозитория, а не из памяти модели.
    // 09.11 Warden предложил «D-084 (зоны)», не зная, что D-084 уже занят
    // транспортом; коллизию заметил человек. Здесь ответ не доходит до записи,
    // пока номер не сверен с docs/DECISIONS.md в main.
    if (typeof decisionNumberConflict === "function" && typeof decisionNumbersTaken === "function") {
      try {
        const conflict = decisionNumberConflict(answer, await decisionNumbersTaken());
        if (conflict) {
          pause(conflict, { kind: "answer-decisions", ref: expect.ref, notifyTitle: "Relay: номер решения занят" });
          return true;
        }
      } catch (e) {
        // Не смогли прочитать список — не блокируем ответ: номер проверит приёмка.
        logThrottled(`decisions-${expect.ref}`, `Номера решений не сверены: ${e.message}. Ответ не блокирую.`, true);
      }
    }
    // D-086: редакция ТЗ из ответа сверяется с тем, что лежит в main. 09.11
    // «ТЗ 1.6 + очередь 1.8» существовали только в переписке; карточку по ним
    // выдать было не из чего, а признака «опубликовано» не было нигде.
    if (typeof publicationGaps === "function" && typeof publishedTzVersion === "function") {
      try {
        const pub = await publishedTzVersion();
        const gap = publicationGaps(answer, pub);
        if (gap) {
          pause(gap, { kind: "answer-unpublished", ref: expect.ref, notifyTitle: "Relay: ТЗ не опубликовано" });
          return true;
        }
      } catch (e) {
        logThrottled(`tz-published-${expect.ref}`, `Редакция ТЗ не сверена: ${e.message}. Ответ не блокирую.`, true);
      }
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
    // D-096: ход приёмки заканчивается здесь, и сессия Warden должна остаться
    // рабочей. Continue после слитого PR появляется именно на этой странице;
    // без клика следующая работа пойдёт в мёртвую ветку. 10.11 её пришлось
    // нажимать Мастеру — в журнале не было даже строки об этом.
    if (typeof finishReviewerTurn === "function") {
      await finishReviewerTurn("вопрос закрыт приёмкой").catch((e) => {
        log(`Continue на странице приёмки не нажата: ${e.message}. Ход возвращается Координатору.`, true);
      });
    }
    const queue = await queueOf(mission).catch(() => ({ summary: "очередь не прочитана" }));
    const note = answerRecorded ? "Ответ на вопрос записан — учти его и продолжи план." :
      "Вопрос уже закрыт в Notion — учти сохранённое состояние и продолжи план.";
    await requestPlan(mission, coord, queue, note, { force: true });
    return true;
  }

  /**
   * D-085: пути из `Scope` против зоны роли — машинная проверка ДО выдачи.
   *
   * 09.11 на этом сгорели три круга B0: в ТЗ §7 путь был записан за Locale
   * Auditor, в «Зоне записи» той же роли его не было, а Acceptance требовал
   * буквального совпадения. Спецификация была внутренне противоречива — пройти
   * приёмку не могла ни при каком тексте карточки, а узнавалось это после
   * выдачи, прогона и отчёта, то есть самым дорогим способом.
   *
   * Проверка нарочно мягкая: ловится только ЯВНОЕ расхождение, когда у роли
   * есть перечислимая зона (шаблоны через запятую/перенос), а путь карточки не
   * попадает ни в один шаблон и не помечен создаваемым. Прозаическая зона
   * («вся папка tools/x и точка входа») не разбирается: строить по ней запрет
   * значило бы останавливать выдачу на догадке.
   */
  /**
   * D-092: зона роли — данные, а не проза.
   *
   * В базе «Роли» зона пишется разными людьми и разным почерком: у Warden это
   * абзац («Решения по постановке и приёмке; код не трогает…»), у Locale
   * Auditor — список с префиксом «synapse: ». Прежний разбор молча выбрасывал
   * всё, что не похоже на glob, и зона превращалась в пустую: проверка
   * `scopeZoneIssue` тогда ничего не проверяла, а прозу читали как «зона есть».
   *
   * Здесь два разных факта:
   *   • `roleZoneGlobs` — пути, по которым можно судить машинно (glob);
   *   • `roleZoneIsProse` — зона объявлена словами, и судить по ней нельзя.
   * Второй факт не ошибка конфигурации: он честно говорит, что граница здесь
   * человеческая, и гейт по путям к такой роли не применяется.
   */
  const roleZoneGlobs = (roleZone) => {
    const out = [];
    for (const rawLine of String(roleZone || "").split(/[\n;]+/)) {
      // Метка перед путями («synapse: », «Зона записи: ») — не путь, а подпись.
      // Раньше она приклеивалась к первому шаблону, и зона начиналась со
      // второго: у Locale Auditor `locales/**` молча выпадал.
      const line = rawLine.replace(/^\s*[^:\s][^:]{0,30}:\s*/, "").trim();
      if (!line) continue;
      const tokens = line.split(/[\s,]+/).map((x) => x.trim().replace(/^`|`$/g, "")).filter(Boolean);
      if (!tokens.length) continue;
      // Строка целиком должна быть списком путей. Если в ней есть слова, это
      // прозаическая зона: судить по ней машинно нельзя, и притворяться, что
      // можно, — хуже, чем не проверять вовсе (D-092).
      const globby = tokens.every((x) => /^[\w.@*/-]+$/.test(x) && /[/*]/.test(x));
      if (!globby) continue;
      out.push(...tokens);
    }
    return [...new Set(out)];
  };
  const roleZoneIsProse = (roleZone) => {
    const text = String(roleZone || "").trim();
    if (!text) return false;
    if (roleZoneGlobs(text).length) return false;
    // Слова без единого пути — зона описана прозой. Это допустимо, но тогда
    // проверять по ней нечего, и решение принимает человек/приёмка.
    return /\s/.test(text) || /[а-яё]/i.test(text);
  };

  function scopeZoneIssue(cardZone, roleZone) {
    const paths = String(cardZone || "").split(/[\n,;]+/).map((x) => x.trim().replace(/^`|`$/g, "")).filter(Boolean);
    const globs = roleZoneGlobs(roleZone);
    if (!paths.length || !globs.length) return "";
    const asRe = (glob) => new RegExp("^" + glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    const res = globs.map(asRe);
    const bad = [];
    for (const path of paths) {
      if (/созда|нов|new/i.test(path)) continue; // путь может появиться в этой работе
      const clean = path.split(/\s+/)[0].replace(/\/+$/, "");
      if (!clean || !/[./]/.test(clean)) continue;
      if (!res.some((re) => re.test(clean))) bad.push(clean);
    }
    if (!bad.length) return "";
    return `Scope карточки выходит за «Зону записи» роли: ${bad.slice(0, 4).join(", ")}` +
      `${bad.length > 4 ? ` и ещё ${bad.length - 4}` : ""}. Правь постановку: либо сузь Scope до зоны роли, ` +
      "либо отдай эти пути тому, за кем они в «Ролях» (D-085)";
  }

  /**
   * D-092: путь из `Scope` не принадлежит никому.
   *
   * Вторая половина правила о зонах. Первая (`scopeZoneIssue`) спрашивает
   * «входит ли путь в зону адресата»; она молчит, когда зон несколько и путь
   * есть у соседа, и молчит, когда зона адресата описана прозой. Из-за этого
   * карточка с путём `tools/i18n/**` уходила Executor'у без зоны вовсе: путь
   * не в зоне никого, но проверить это было нечем.
   *
   * Здесь вопрос другой: существует ли вообще роль, которой этот путь
   * разрешён. Нет такой роли — карточка чинится постановкой (либо в «Ролях»
   * появляется зона, либо путь убирают из `Scope`), и это решение приёмки, а
   * не ход исполнителя. `roles` передаются снаружи: функция чистая.
   */
  function unownedPaths(cardZone, roleRowsList) {
    const paths = String(cardZone || "").split(/[\n,;]+/).map((x) => x.trim().replace(/^`|`$/g, "")).filter(Boolean);
    if (!paths.length) return [];
    const owners = (roleRowsList || [])
      .filter((row) => row && (row.status || "") === "Активна")
      .flatMap((row) => roleZoneGlobs(row.zone || ""));
    // Ни у одной активной роли зон нет — судить не о чем: пустой ответ честнее
    // обвинения. Так бывает на чистой базе, и это не дефект постановки.
    if (!owners.length) return [];
    const asRe = (glob) => new RegExp("^" + glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
    const res = owners.map(asRe);
    const bad = [];
    for (const path of paths) {
      if (/созда|нов|new/i.test(path)) continue;
      const clean = path.split(/\s+/)[0].replace(/\/+$/, "");
      if (!clean || !/[./]/.test(clean)) continue;
      if (!res.some((re) => re.test(clean))) bad.push(clean);
    }
    return bad;
  }

  /** Проверка постановки и подтверждённых зависимостей, до изменения карточки. */
  async function taskPreflight(card, mission, roleZone = "") {
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
    // D-085: дефект постановки ловится здесь, а не на приёмке после прогона.
    const zoneIssue = scopeZoneIssue(rt(props["Scope"]), roleZone);
    if (zoneIssue) return zoneIssue;
    // D-092: вторая половина — путь не принадлежит никому. Спрашиваем только
    // там, где зона адресата не проза: если она описана словами, машинного
    // ответа нет, и обвинять постановку было бы догадкой.
    if (!roleZoneIsProse(roleZone)) {
      const owners = await roleRows().catch(() => []);
      const loose = unownedPaths(rt(props["Scope"]), owners);
      if (loose.length) {
        return `пути Scope не входят в зону ни одной активной роли: ${loose.slice(0, 4).join(", ")}` +
          `${loose.length > 4 ? ` и ещё ${loose.length - 4}` : ""}. Это дефект постановки: ` +
          "путь отдают в «Зону записи» роли или убирают из Scope (D-092)";
      }
    }
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
    const preflight = await taskPreflight(fresh, mission, confirmed[0].zone || "");
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
    // D-086: и последнее — репозиторий цели против подключения самой роли.
    // «Кто к какому репозиторию подключён, тот тот и правит» (Мастер, 09.11).
    const repoIssue = typeof roleRepoVerdict === "function" ? roleRepoVerdict(targetRepo, role) : "";
    if (repoIssue) return repoIssue;
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
        // D-053: повторяющаяся петля — сначала арбитраж, а не пауза. Warden
        // видит «Ответ», состояние карточки, PR и журнал попыток и решает, что
        // делать с карточкой; остановить цикл он тоже может — своим решением.
        // Пауза остаётся запасным путём: нет активного Warden, дело не читается
        // или исчерпан предел арбитражей — тогда, как и раньше, нужен Мастер.
        if (await escalateToWarden(fresh, why)) return true;
        GM_setValue(redispatchKey(fresh.id), []);
        pause(
          `«${taskTitle(fresh)}» перевыдали ${times} раз за шесть часов — похоже, Координатор и исполнитель ` +
            "гоняют одну и ту же карточку и не замечают этого. Разобрать петлю арбитру некому " +
            "(нет активной роли с функцией Reviewer), поэтому решает Мастер: посмотрите «Ответ» и журнал, " +
            "поправьте постановку и нажмите «Продолжить».",
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
    // 08.11, 18:34: поле «Payload Drive File ID» у B1 перечисляло два файла
    // через запятую — и скрипт отправил шлюзу всю строку как один id, получив
    // «Некорректный Drive file ID». Сеть и карточка были в порядке: отказ
    // разбирался как сбой записи в Notion и ход вставал до утра. Теперь id
    // разбираются по одному и читаются по очереди.
    const payloadIds = driveFileIds(rt(fresh.properties["Payload Drive File ID"]));
    const payloadId = payloadIds[0] || "";
    const payloadParts = [];
    for (const id of payloadIds) {
      try {
        payloadParts.push({ id, text: (await gateway("read", id)).content || "" });
      } catch (e) {
        // Называет файл, а не только «Payload не прочитан»: в карточке их может
        // быть несколько, и Мастеру важно знать, какой именно не открылся.
        throw new Error(`Payload не прочитан (файл ${id}): ${e.message}`);
      }
    }
    const payload = joinPayloadFiles(payloadParts);
    const previousLogId = rt(fresh.properties["Output Drive File ID"]);
    // D-034: снимок большого payload фиксируется до сборки сообщения. D-043:
    // сам промпт проверяется ДО журнала и Running. Иначе oversized-карточка
    // создавала журнал/ожидание, затем откатывалась, а null назывался дублем.
    let payloadRefId = payloadId;
    let payloadPointer = false;
    if (payloadId && payload.trim().length > (C.payloadInlineMax || 1500)) {
      const saved = await gateway("savePayload", "", { name: `${card.id}_${runId}__assignment.md`, content: payload });
      payloadRefId = String(saved?.fileId || "").trim();
      if (!payloadRefId) throw new Error("Шлюз не вернул ID снимка задания (payload).");
      payloadPointer = true;
    }
    const dispatchCtx = { repo: targetRepo, branch: targetBranch };
    if (payloadRefId) {
      dispatchCtx.payloadRef = { fileId: payloadRefId, url: `https://drive.google.com/file/d/${payloadRefId}/view` };
      dispatchCtx.payloadPointer = payloadPointer;
    }
    let compileProblem = "";
    // D-080: ответы на вопросы ЭТОЙ роли. Читаются здесь, а не в сборщике:
    // сборка промпта — чистая функция, а база «Обратная связь» — сеть.
    // Ошибка чтения не отменяет выдачу: карточка важнее брифинга.
    let answersMine = "";
    try {
      const briefing = await questionBriefing(mission).catch(() => null);
      answersMine = briefing?.answersMine ? briefing.answersMine(role.name) : "";
    } catch (e) {
      dbg("ответы роли не прочитаны", e.message);
    }
    // logId в промпт не входит; журнал создаётся только после успешной сборки.
    const prompt = executorPrompt(fresh, role, payload, "", runId, mission?.id || "", {
      ...dispatchCtx,
      answersMine,
      onCompileError: (reason) => { compileProblem = reason; },
    });
    // Ответ, который ушёл роли в этом промпте, отмечается ей же — после того,
    // как отправка подтвердилась (ниже). Здесь только запоминаем, что показали.
    const answersShown = answersMine ? fresh : [];
    if (!prompt) {
      // Это отказ сборки, а не дубль и не сетевой сбой. Счётчик промахов ещё
      // не сброшен: Координатор получает причину через plan.note (D-042), а
      // третий одинаковый отказ останавливает цикл штатной защитой.
      return `${compileProblem || `Промпт не собран (dispatch ${card.id}); карточка осталась Ready, агенту ничего не отправлено.`} ` +
        "Журнал выдачи не создавался; статус карточки не менял.";
    }
    // Каждому новому Run — свой журнал. Поле карточки может указывать на
    // прошлую попытку или даже чужую миссию; его нельзя использовать повторно.
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
    GM_setValue("cfn-dispatch-miss", 0);
    // D-080: промпт собран и карточка уходит в Running — ответы, показанные
    // этой роли, считаются доставленными ей. Общая отметка (для Координатора)
    // поставится его планом; здесь — только её собственные строки.
    if (answersShown.length) await markDelivered(answersShown, Date.now(), role.name);
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
    // Отправляем уже проверенный текст. Null сюда больше не приходит из-за
    // бюджета; отказ очереди по-прежнему разбирает сторож неотправленной выдачи.
    const queued = await sendToRole(role, prompt, "dispatch", card.id, {
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
      // Очередь не создалась: возможен повтор, запрещённый адресат или другой
      // защитный отказ sendToRole. Хода нет, а карточка уже Running; возвращаем
      // Ready, не выдавая неподтверждённую причину за доказанный дубль (D-043).
      const left = GM_getValue(K.expect, null);
      if (!left || norm(left.ref) !== norm(card.id)) {
        await releaseUndelivered(
          { kind: "dispatch", ref: card.id, runId, title: taskTitle(card) },
          "задание не поставлено в очередь",
        );
        return "задание не поставлено в очередь (отправка не подтверждена; возможен защитный отказ от дубля или адресата)";
      }
    }
    return true;
  }
