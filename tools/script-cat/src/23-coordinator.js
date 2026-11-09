  // ───────────────────────────── ход Координатора ─────────────────────────────
  /**
   * Возврат «зависших» карточек в Ready.
   *
   * Это не лимит на работу агента. 45 минут — срок, после которого карточка в
   * Running считается брошенной: задание до исполнителя не дошло, ответ
   * потерялся, вкладку закрыли. Пока у скрипта есть живой ход (неотправленное
   * задание или ожидание ответа), карточка не трогается никогда: агент может
   * работать и два, и три часа, и это нормально.
   */
  /**
   * Карточки в Running, по которым у транспорта нет хода.
   *
   * В Running карточку ставит только транспорт (`dispatchTask`) — тем самым он
   * берёт её в работу. Значит Running без живого ожидания означает, что работу
   * никто не ведёт: скрипт про неё забыл (сброс кнопкой ↺, обновление, чужой
   * браузер), а в очереди она выглядит как ход. Координатор видит «1 Running»,
   * считает, что работа идёт, и выдаёт вместо неё следующую карточку — а эта
   * висит до 45 минут и потом всё равно возвращается.
   *
   * 28.10 так и вышло: ↺ снял ожидание, NAR-5.3 осталась Running, и новый ход
   * ушёл Architect'у. Теперь такие карточки возвращаются в Ready сразу — до
   * того, как Координатор увидит очередь.
   *
   * Не трогаем три вещи:
   *  • карточку текущего хода — по ней скрипт правда ждёт ответа;
   *  • всё, пока идёт отправка (`K.pending`) или транспорт занят другим ходом
   *    (ответ приёмки, вопрос, план): тогда «без хода» — наша невнимательность,
   *    а не факт;
   *  • карточку, выданную только что (`orphanGraceMs`) — ход мог уйти из
   *    другой вкладки, и `K.expect` ещё не перечитан.
   *
   * Возвращает список возвращённых карточек (для журнала и проб).
   */
  async function sweepOrphans(mission, cards = null) {
    if (!mission || GM_getValue(K.pending, null)) return [];
    const expect = GM_getValue(K.expect, null);
    if (expect && Number(expect.sentAt) && expect.kind !== "dispatch") return [];
    const live = expect && expect.kind === "dispatch" && expect.ref ? norm(expect.ref) : "";
    const running = cards || (await tasks("Running", mission));
    const swept = [];
    for (const card of running) {
      if (live && norm(card.id) === live) continue;
      const started = card.properties?.["Started At"]?.date?.start;
      const age = started ? Date.now() - Date.parse(started) : Number.POSITIVE_INFINITY;
      if (age < C.orphanGraceMs) continue;
      // `rollbackProps` сам откажется, если карточка уже отвечена («Submitted
      // At», «PR») или её Run ID сменился: чужой ход не снимаем.
      const props = rollbackProps(card, rt(card.properties?.["Run ID"]));
      if (!props) continue;
      try {
        await patch(card.id, props);
      } catch (e) {
        log(`«${taskTitle(card)}» висит в Running без хода, но статус не снялся: ${e.message}.`, true);
        continue;
      }
      GM_setValue(answerStampKey(card.id), "");
      swept.push(card);
      const how = Number.isFinite(age) ? `${Math.round(age / 60000)} мин` : "неизвестно сколько";
      log(
        `«${taskTitle(card)}» висит в Running ${how} без хода скрипта — вернул в Ready: ` +
          "ожидания по ней нет, работа по ней не идёт.",
        false,
        { tone: "warn", ntfy: "quiet", title: "Relay: карточка возвращена в Ready" },
      );
    }
    return swept;
  }

  async function releaseStalled(mission) {
    // Идёт отправка — не наше дело, что там на часах.
    if (GM_getValue(K.pending, null)) return;
    const running = await tasks("Running", mission);
    // Сироты — до всех отсчётов: карточка без хода не работает ни секунды, и
    // ждать 45 минут ей незачем. Список передаём тот же, второй раз Notion не
    // читаем.
    const swept = new Set((await sweepOrphans(mission, running) || []).map((card) => norm(card.id)));
    const expect = GM_getValue(K.expect, null);
    for (const card of running) {
      // Карточку уже вернул `sweepOrphans`: второй раз её не читаем.
      if (swept.has(norm(card.id))) continue;
      // По этой карточке скрипт как раз ждёт ответа: ход живой.
      if (expect && Number(expect.sentAt) && norm(expect.ref) === norm(card.id)) continue;
      const started = card.properties["Started At"]?.date?.start;
      if (!started) continue;
      if (Date.now() - Date.parse(started) < C.stalledMs) continue;
      // Ready — это «хода на карточке нет»: снимаем и след выдачи, иначе
      // карточка выглядит выданной, хотя её уже никто не ведёт.
      await patch(card.id, {
        "Dispatch State": { select: { name: "Ready" } },
        "Started At": { date: null },
        "Run ID": { rich_text: [] },
      });
      log(
        `«${taskTitle(card)}» висит в Running ${Math.round((Date.now() - Date.parse(started)) / 60000)} мин без хода скрипта — возвращена в Ready.`,
        false,
        { ntfy: "quiet" },
      );
    }
  }

  /**
   * Что делать по решению Координатора — без сети, чтобы это можно было
   * проверить пробой.
   *
   * `next` — имя роли из маркера. Четыре исхода:
   *   • роль есть и её карточка лежит в Ready → отправляем задание;
   *   • `next` — сам Координатор: он вернул ход себе (например, принял
   *     Submitted и не успел выдать следующую карточку). Это не ошибка и не
   *     повод для паузы — просим ещё один ход с подсказкой, что очередь пуста;
   *   • роли нет или карточки нет → тоже просим ход, но говорим, чего не
   *     хватает: имени роли или самой карточки;
   *   • второй промах подряд → пауза: дальше это уже не «не понял», а поломка.
   */
  function decisionRoute(next, { roles: list = [], directory = [], readyRoles = [], misses = 0 } = {}) {
    const name = String(next || "").trim();
    if (!name) return { kind: "ask", note: "В маркере не указано, кому передаётся ход: назови роль или done." };
    if (norm(name) === norm("done")) return { kind: "done" };
    const target = list.find((r) => norm(r.name) === norm(name)) || null;
    const rows = [...list, ...(directory || [])];
    const reviewer = rows.some((r) => r.fn === "Reviewer" &&
      (norm(r.name) === norm(name) || (target?.id && r.id && norm(r.id) === norm(target.id))));
    if (reviewer || norm(name) === norm("Warden")) {
      const why = `«${name}» — приёмка (Reviewer): обычную рабочую карточку ей не выдают. ` +
        "Переназначь её подходящему Auditor или Executor; вопросы и предложения по-прежнему направляются приёмке, " +
        "а завершённая очередь передаётся ей через next: done.";
      // D-042: отказ должен быть исполнимым. Координатор упорно называл Warden,
      // потому что не понимал, КАК исправить: карточка стояла в Ready с «Кому» =
      // Warden. Называем поле, доступные рабочие роли и что ратификация/правка
      // файлов — работа исполнителя, а приёмщик лишь отвечает на вопросы.
      const workers = list.filter((r) => ["Executor", "Auditor"].includes(r.fn)).map((r) => r.name);
      // D-091: отказ обязан отделять две разные вещи. Раньше он валил их в одну
      // фразу «карточку приёмке не выдают», и Координатор, у которого вопроса
      // нет, а есть только просьба к Warden, читал это как «и спросить нельзя».
      // Теперь сказано прямо: спросить — можно и нужно, и для этого есть поле
      // question с need; next при таком вопросе не читается вовсе.
      const how = ` Спрашивать приёмку — можно, и это отдельный канал: question с gate:true и need:"${name}" в том же маркере; ` +
        "такой вопрос передаёт ей ход, а next в этом ходе не применяется — рабочую роль называть не нужно. " +
        "А вот карточку ей не выдают: смени поле «Кому» с «" + name + "» на рабочую роль" +
        (workers.length ? ` (${workers.join(", ")})` : " (Executor или Auditor)") +
        `, оставь карточку в Ready и повтори next с этой ролью. Не ставь «Кому» = «${name}» снова: ` +
        "ратификация решений, статус ADR и любая правка файлов — работа исполнителя по карточке; приёмщик отвечает на вопросы и принимает миссию.";
      if (misses >= 2) return { kind: "pause", reason: `${why}${how} Координатор повторил запретную выдачу три раза; очередь сохранена.` };
      return { kind: "ask", note: `${why}${how}` };
    }
    if (!target) {
      // Карточка этой роли может уже лежать в Ready — тогда дело не в
      // опечатке, а в статусе роли. Молчать об этом значит гонять
      // Координатора по кругу «роли нет среди активных».
      if (readyRoles.some((r) => norm(r) === norm(name))) {
        const row = (directory || []).find((r) => norm(r.name) === norm(name));
        const state = row
          ? [`Статус «${row.status || "пуст"}»`, row.url ? "Agent URL заполнен" : "Agent URL пуст"].join(", ")
          : directory.length
            ? "такой роли нет в базе «Роли»"
            : "роль не активна";
        const why =
          `«${name}»: карточка в Ready есть, но выдать её некому — ${state}. ` +
          `Активные роли: ${list.map((r) => r.name).join(", ") || "нет"}. ` +
          "Статус роли и Agent URL ставит Мастер: агента в Arena создаёт он.";
        if (misses >= 1) {
          return {
            kind: "pause",
            reason: `${why} Нажмите «Продолжить» — Координатор получит подсказку и назначит активную роль.`,
          };
        }
        return {
          kind: "ask",
          note:
            `${why} Назначь в «Кому» активную роль (правка черновика — твоё право) и повтори next, ` +
            "либо оставь карточку в Draft и напиши, кого она ждёт.",
        };
      }
      // Третий подряд промах — уже не «модель не поняла», а поломка: без
      // человека это превращается в бесконечную переписку с Координатором.
      if (misses >= 2) {
        return {
          kind: "pause",
          reason:
            `Координатор третий раз подряд называет роль «${name}», которой нет среди активных. ` +
            "Проверьте базу «Роли»: имя в next должно совпадать с ролью.",
        };
      }
      return { kind: "ask", note: `Роли «${name}» нет среди активных. Назови роль из базы «Роли» или done.` };
    }
    if (target.fn === "Coordinator") {
      if (misses >= 2) {
        return {
          kind: "pause",
          reason:
            "Координатор третий раз подряд возвращает ход себе и не выдаёт карточку. " +
            "Похоже, он не видит очередь или не может создать карточку — посмотрите его ответ.",
        };
      }
      return {
        kind: "ask",
        note:
          "Ход вернулся Координатору. Очередь пуста — в этом ходе выдай работу сам: создай карточку " +
          "Ready или переведи в Ready подходящий Draft и назови в next исполнителя (или done, если миссия закончена).",
      };
    }
    if (!["Executor", "Auditor"].includes(target.fn)) {
      const why = `«${target.name}»: функция «${target.fn || "не указана"}» не разрешает рабочую карточку. ` +
        "Назначь активного Executor или Auditor; функцию роли устанавливает Мастер.";
      if (misses >= 2) return { kind: "pause", reason: `${why} Координатор повторил выбор три раза.` };
      return { kind: "ask", note: why };
    }
    if (readyRoles.some((r) => norm(r) === norm(target.name))) return { kind: "dispatch", roleName: target.name };
    if (misses >= 1) {
      return {
        kind: "pause",
        reason:
          `Координатор второй раз направил ход в «${target.name}», но карточки в Ready нет. ` +
          "Нажмите «Продолжить»: он получит подсказку и сможет создать карточку или выдать черновик. " +
          "Если и это не поможет — проверьте, видит ли Координатор базу «Запросы».",
      };
    }
    return {
      kind: "ask",
      note:
        `Ты направил ход в «${target.name}», но в Ready нет карточки для этой роли. ` +
        "Создай её или переведи в Ready подходящий Draft — и в этом же ответе повтори next.",
    };
  }
