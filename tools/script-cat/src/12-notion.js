  // ───────────────────────────── Notion ─────────────────────────────
  // Notion возвращает не больше 100 строк за раз. Неполная очередь опаснее
  // ошибки: она могла скрыть открытые карточки или часть принятых от приёмки.
  // Не возвращаем частичный результат при ошибке или сломанном курсоре.
  const query = async (ds, filter, sorts) => {
    const rows = [];
    const cursors = new Set();
    let cursor = "";
    while (true) {
      const page = await notion("POST", `data_sources/${ds}/query`, {
        page_size: 100,
        ...(filter ? { filter } : {}),
        ...(sorts ? { sorts } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      if (!page || !Array.isArray(page.results) || typeof page.has_more !== "boolean")
        throw new Error("Notion вернул неполную страницу запроса.");
      rows.push(...page.results);
      if (!page.has_more) return rows;
      const next = String(page.next_cursor || "");
      if (!next || cursors.has(next)) throw new Error("Notion не вернул новый курсор запроса.");
      cursors.add(next);
      cursor = next;
    }
  };

  const patch = (pageId, properties) => notion("PATCH", `pages/${pageId}`, { properties });

  /** id агента выводится из ссылки: отдельное поле в Notion не нужно. */
  function agentIdFromUrl(url) {
    const m = String(url || "").match(/\/agent\/([\w-]+)/);
    return m ? m[1] : "";
  }

  /** Строка базы «Роли» в том виде, в каком её видит остальной скрипт. */
  const mapRoleRow = (p) => {
    const url = p.properties["Agent URL"]?.url || "";
    return {
      id: agentIdFromUrl(url),
      name: rt(p.properties["Роль"]),
      url,
      fn: sel(p.properties["Функция"]),
      status: sel(p.properties["Статус"]),
      zone: rt(p.properties["Зона записи"]),
      gate: rt(p.properties["Гейт"]),
      repo: rt(p.properties["Репозиторий"]),
      pageId: p.id,
      // Аддитивные поля provisioning. Старые строки без них читаются как
      // «не админ» и «не требуется»; старые поля не переименовываются.
      agentAdmin: p.properties["Agent Admin"]?.checkbox === true,
      agentState: sel(p.properties["Agent State"]) || "не требуется",
      agentJobId: rt(p.properties["Agent Job ID"]),
      agentCreatedAt: p.properties["Agent Created At"]?.date?.start || "",
      previousAgentUrl: p.properties["Previous Agent URL"]?.url || "",
    };
  };

  /**
   * Вся база «Роли»: и активные, и те, что Мастер ещё не включил.
   *
   * Кеш на 10 минут — потому что это настройка, а не данные миссии: список
   * агентов читается в начале каждого шага, а меняет его человек. 29.10 обрыв
   * связи именно на этом чтении остановил цикл на девятом часу работы; с
   * кешем шаг переживает потерю сети, а не ждёт Мастера у экрана.
   *
   * `fresh: true` — мимо кеша: смена токена в ⚙ и случаи, где список только
   * что правили руками.
   */
  async function roleRows({ fresh = false, requireFresh = false } = {}) {
    const cached = GM_getValue(K.rolesCache, null);
    const usable = cached && Array.isArray(cached.rows) && cached.rows.length ? cached : null;
    const age = usable ? Date.now() - Number(usable.at || 0) : Number.POSITIVE_INFINITY;
    if (!fresh && !requireFresh && usable && age < C.rolesCacheMs) return usable.rows;
    try {
      const rows = (await query(C.roles)).map(mapRoleRow);
      if (rows.length) GM_setValue(K.rolesCache, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      if (!usable || requireFresh) throw e;
      log(
        `База «Роли» не ответила (${firstLine(String((e && e.message) || e))}) — работаю по кешу ` +
          `${Math.max(1, Math.round(age / 60000))} мин назад: список агентов с тех пор не менялся.`,
        false,
        { tone: "warn", ntfy: "quiet" },
      );
      return usable.rows;
    }
  }

  /** Свежий список ролей: сбросить кеш и перечитать. */
  async function rolesFresh() {
    GM_setValue(K.rolesCache, null);
    return roles();
  }

  async function roles() {
    const rows = await roleRows();
    const active = rows.filter((r) => r.id && r.url && r.status === "Активна");
    const ids = active.map((r) => norm(r.id));
    if (new Set(ids).size !== ids.length) throw new Error("Две активные роли указывают на один Agent URL.");
    if (active.filter((r) => r.fn === "Coordinator").length > 1)
      throw new Error("Активных Coordinator больше одного.");
    return active;
  }

  /**
   * Активная миссия — это «Активна» ИЛИ «Возвращена».
   *
   * «Возвращена» ставит Мастер, когда миссия закрыта, а работа не принята:
   * замечания лежат в полях карточки миссии. Если не учитывать это состояние,
   * возврат выглядит как «нет активной миссии», и цикл просто стоит.
   */
  async function activeMission() {
    const rows = await query(
      C.missions,
      {
        or: [
          { property: "Состояние", select: { equals: "Активна" } },
          { property: "Состояние", select: { equals: "Возвращена" } },
        ],
      },
      [{ property: "Создана", direction: "descending" }],
    );
    if (rows.length > 1) {
      throw new Error(`Найдено несколько активных или возвращённых миссий (${rows.map((row) => row.id).join(", ")}). ` +
        "Оставьте ровно одну активную миссию; автоматически выбирать по дате нельзя.");
    }
    return rows[0] || null;
  }

  const missionKind = (p) => sel(p.properties["Состояние"]);
  const isReturned = (p) => missionKind(p) === "Возвращена";
  const missionRemarks = (p) => rt(p.properties["Замечания"]).trim();

  /**
   * Первая строка длинного текста: список замечаний в строку журнала не влезет.
   *
   * 24.10 Мастер записал три замечания одним абзацем без переводов строки, и
   * `firstLine` вернула все три целиком — строка журнала на тысячу символов.
   * Теперь длинная строка режется по границе слова: в журнале и пуше видно
   * суть первого замечания, а полный текст остаётся в Notion и в плане.
   */
  const firstLine = (text, max = 220) => {
    const line =
      String(text || "")
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)[0] || "";
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
  };

  /**
   * Замечания — по пунктам. Мастер пишет их и списком с переводом строки, и
   * одним абзацем «1) … 2) … 3) …». Координатору нужны отдельные пункты:
   * правило возврата — на каждое замечание своя карточка.
   */
  const remarkItems = (text) =>
    String(text || "")
      // Граница пункта — пробел или точка перед «2) », а не только перевод
      // строки: Notion хранит замечания несколькими rich_text-элементами, и
      // `rt` склеивает их без разделителя («…не менялся.2) docs…»).
      .replace(/([.\s])(\d{1,2}[).]\s)/g, "$1\n$2")
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);

  /** Последняя закрытая миссия: по ней видно, что цикл остановился не «просто так». */
  async function lastClosedMission() {
    const rows = await query(
      C.missions,
      {
        or: [
          { property: "Состояние", select: { equals: "Завершена" } },
          { property: "Состояние", select: { equals: "Провалена" } },
        ],
      },
      [{ property: "Завершена", direction: "descending" }],
    );
    return rows[0] || null;
  }

  /**
   * Конец миссии — событие, а не тишина.
   *
   * 24.10 в 15:49 Координатор закрыл NAR-1, а ScriptCat сказал только «Нет
   * активной миссии — ждём»: ни зелёной строки, ни пуша, ни выключенного
   * автоцикла. Мастер узнал о конце миссии из чата. Теперь событие
   * объявляется один раз на миссию: зелёная строка, громкий пуш, автоцикл
   * выключен, ожидание снято.
   */
  async function missionDoneNotice(expect) {
    let closed = null;
    try {
      closed = await lastClosedMission();
    } catch {
      return false; // Notion не ответил — не выдумываем событие
    }
    if (!closed) return false;
    if (expect?.kind === "dispatch" || expect?.kind === "answer" || expect?.kind === "review" || (expect?.kind === "reminder" && expect.runId)) {
      // Закрытие извне не доказывает, что ответ карточки или вопроса записан.
      // Не теряем его идентификаторы и не принимаем остальные ходы «за компанию».
      autoSet(false);
      pause("Миссия уже закрыта, но есть незавершённое ожидание карточки или вопроса. " +
        "Ответ и ID сохраняю; проверьте чат, карточку и журнал, прежде чем снимать ожидание.", {
        kind: "closed-with-running", ref: expect.ref || "", runId: expect.runId || "", turnId: expect.turnId || "",
      });
      return true;
    }
    const at = closed.properties?.["Завершена"]?.date?.start || "";
    // «Ждали ход» — любое незавершённое ожидание, а не только план или
    // напоминание. 28.10 NAR-4 закрыли своим ходом, в памяти осталось
    // ожидание вида «marker» — конец миссии прошёл молча.
    const waited = Boolean(expect && expect.kind);
    // «Завершена» — дата без времени, `Date.parse` даёт полночь. Прежние
    // десять минут означали: закрытие, увиденное через полчаса, уже «старое»,
    // и о нём не сообщали. Сутки покрывают любую дату закрытия этого дня.
    const age = at ? Date.now() - Date.parse(at) : Infinity;
    const recent = Number.isFinite(age) && age < 24 * 60 * 60 * 1000;
    // Включённый автоцикл сам по себе довод: он крутится, работы нет —
    // значит, миссия кончилась, и он обязан встать и сказать об этом.
    const running = autoOn();
    // Обычное «миссии пока нет» остаётся тишиной: закрытая миссия недельной
    // давности не повод пушить при каждом открытии страницы. Но автоцикл
    // гасим и здесь — закрытая миссия означает конец работы.
    if (!waited && !recent && !running) {
      autoSet(false);
      setStatus();
      return false;
    }

    // Отсчёт закрытия, а не только id: миссию возвращают и закрывают снова,
    // и второе закрытие — такое же событие, как первое. 28.10 NAR-4 закрыли
    // повторно после возврата, флаг по одному id остался с 27.10 — Мастер
    // не получил ни пуша, ни выключенного автоцикла. Поэтому в ключ входит
    // дата возврата: у каждой пары «возврат → закрытие» свой отсчёт.
    const returnedAt = closed.properties?.["Возвращена"]?.date?.start || "";
    const key = `cfn-mission-done:${closed.id}:${at}:${returnedAt}`;
    const announced = Boolean(GM_getValue(key, false));
    // Закрытие в обход приёмки. Миссию закрывает вердикт Reviewer, и только он:
    // если «Завершена» появилась без отметки `cfn-review:<id>`, значит её
    // поставил агент (или человек руками). Это не конец работы, а конец
    // проверки — про такое Мастер должен узнать сразу, а не через неделю.
    const verdict = String(GM_getValue(`cfn-review:${closed.id}`, "") || "");
    const ackKey = `cfn-review-ack:${closed.id}:${at}`;
    // Пауза — только когда закрытие кого-то застало: шёл ход или крутился
    // автоцикл. Миссию, закрытую Мастером на тихом стенде, будить незачем.
    if (!announced && !verdict && recent && (waited || running) && !GM_getValue(ackKey, false)) {
      GM_setValue(ackKey, true);
      if (waited) GM_setValue(K.expect, null);
      const name = rt(closed.properties["Миссия"]) || "миссия";
      pause(
        `Миссию «${name}» закрыли, но приёмка вердикта не давала: «Завершена» стоит в обход приёмки. ` +
          "Если работу действительно приняли — нажмите «Продолжить», цикл закроет миссию как обычно. " +
          "Если нет — верните её в «Возвращена», напишите «Замечания» и нажмите «Продолжить»: " +
          "Координатор разберёт их карточками.",
        {
          kind: "closed-unreviewed",
          ref: closed.id,
          quiet: true,
          notifyTitle: "Relay: миссия закрыта без приёмки",
        },
      );
      return true;
    }
    if (waited) GM_setValue(K.expect, null);
    // Автоцикл гасим и при повторном проходе: закрытая миссия означает конец
    // работы, даже если строку с пушем уже печатали (перезагрузка страницы,
    // второй «Шаг» по той же очереди).
    if (announced) {
      autoSet(false);
      setStatus();
      return waited;
    }

    GM_setValue(key, true);
    autoSet(false);
    const name = rt(closed.properties["Миссия"]) || "миссия";
    const failed = missionKind(closed) === "Провалена";
    log(
      failed
        ? `Миссия «${name}» закрыта как «Провалена». Автоцикл остановлен: дальше решает Мастер.`
        : `Миссия «${name}» завершена${at ? ` (${String(at).slice(0, 10)})` : ""}: очередь пуста, цикл остановлен. ` +
            "Следующая работа — новым ТЗ и новой миссией, а не хвостом этой.",
      false,
      {
        tone: failed ? "warn" : "ok",
        // Принятую миссию объявляет сама приёмка (`closeMission`) — громко и
        // один раз. Провал звонит, только если остановил работающий цикл или
        // незавершённый ход; на уже выключенном стенде достаточно тихо.
        ntfy: failed && (running || waited) ? "loud" : "quiet",
        cycleStopped: true,
        title: failed ? "Relay: миссия провалена" : "Relay: миссия завершена",
      },
    );
    return true;
  }

  /** Активная миссия и сменилась ли она относительно той, что помнит транспорт. */
  async function missionProbe() {
    const mission = await activeMission();
    const known = String(GM_getValue(K.mission, "") || "");
    return { mission, known, changed: Boolean(mission && known) && known !== mission.id };
  }

  /**
   * Паузы, которые миссией не ограничены.
   *
   * Капча, сломанная страница и ошибка на экране ждут человека, а не хода
   * внутри миссии: снимать их сменой миссии нельзя. Всё остальное — остановки
   * конкретного хода, и к новой миссии они отношения не имеют.
   */
  const PAUSE_BEYOND_MISSION = new Set(["captcha", "ui-error", "arena-error", "mission-change-running", "mission-change-answer", "marker-mismatch", "update-recovery"]);

  /** Пауза прошлого хода к новой миссии не относится. */
  function dropPauseOfMission(cleared = []) {
    if (!GM_getValue(K.paused, "")) return false;
    const ctx = GM_getValue(K.pause, null);
    if (ctx && PAUSE_BEYOND_MISSION.has(ctx.kind)) return false;
    GM_setValue(K.paused, "");
    GM_setValue(K.pause, null);
    cleared.push(`пауза прошлой миссии (${ctx?.kind || "без контекста"})`);
    return true;
  }

  /**
   * Смена миссии обнуляет прошлый ход.
   *
   * 24.10 миссия NAR-1 закрылась, а следующая начинается новой карточкой в
   * «Миссиях». Ожидание ответа и очередь отправки от прошлой миссии к новой не
   * относятся — но именно они решают, куда пойдёт «Шаг»: транспорт повёл бы
   * Мастера на страницу исполнителя, который уже ничего не делает, и новая
   * миссия не началась бы вовсе. Поэтому при смене миссии остатки снимаются,
   * а запись в журнале говорит, что именно.
   */
  async function syncMissionState() {
    const probe = await missionProbe();
    const live = GM_getValue(K.expect, null);
    const liveDispatch = live?.kind === "dispatch" || (live?.kind === "reminder" && !!live.runId);
    const liveAnswer = live?.kind === "answer" || live?.kind === "review";
    if (!probe.mission) {
      const missionId = (liveDispatch || liveAnswer) && (live.missionId || probe.known);
      if (missionId) {
        const previous = await notion("GET", `pages/${missionId}`);
        const state = previous?.properties?.["Состояние"]?.select?.name || "";
        if (["Завершена", "Провалена"].includes(state)) {
          autoSet(false);
          pause("Миссия уже закрыта, но есть незавершённое ожидание карточки или вопроса. " +
            "Ответ и ID сохраняю; проверьте чат и журнал, прежде чем снимать ожидание.", {
            kind: "closed-with-running", ref: live.ref || "", runId: live.runId || "", turnId: live.turnId || "",
          });
          return true;
        }
      }
      return;
    }
    const changed = probe.changed || (live?.missionId && norm(live.missionId) !== norm(probe.mission.id));
    if (changed && (liveDispatch || liveAnswer)) {
      // Новая миссия не доказывает, что старая карточка или вопрос обработаны.
      pause("Появилась новая миссия, пока ждём ответ по карточке или вопросу прошлой. " +
        "Ожидание и ID сохранены: сначала сверьте чат, старую карточку и журнал.", {
        kind: liveAnswer ? "mission-change-answer" : "mission-change-running",
        ref: live.ref || "", runId: live.runId || "", turnId: live.turnId || "",
      });
      return true;
    }
    GM_setValue(K.mission, probe.mission.id);
    if (!probe.changed) return;

    const cleared = [];
    if (GM_getValue(K.expect, null)) {
      GM_setValue(K.expect, null);
      cleared.push("ожидание ответа");
    }
    if (GM_getValue(K.pending, null)) {
      GM_setValue(K.pending, null);
      cleared.push("очередь отправки");
    }
    // Вопросы прошлой миссии к новой не относятся: ответ на них теперь
    // бессмысленен, а очередь ответов иначе держала бы цикл (1.4.80).
    const pendingAnswers = GM_getValue(K.answers || "cfn-answer-queue", null);
    if (Array.isArray(pendingAnswers) && pendingAnswers.length) {
      GM_setValue(K.answers || "cfn-answer-queue", []);
      cleared.push("очередь ответов на вопросы");
    }
    GM_setValue("cfn-blocked-norole", 0);
    GM_setValue("cfn-plan-at", 0);
    GM_setValue("cfn-plan-miss", 0);
    dropPauseOfMission(cleared);

    const name = rt(probe.mission.properties["Миссия"]) || "без названия";
    log(
      `Новая миссия «${name}»: ${cleared.length ? `снял прошлый ход — ${cleared.join(", ")}` : "прошлый ход был чистым"}. ` +
        "Ход начинается с Координатора.",
      false,
      { tone: "ok" },
    );
  }

  /**
   * Пауза прошлой миссии не имеет права держать новую.
   *
   * Проверка стоит до общего стража паузы: иначе тик молча выходил бы, а
   * «Шаг» на любой странице отвечал бы «цикл на паузе» — и новая миссия не
   * начиналась бы, пока Мастер не нажмёт «Продолжить» без причины.
   */
  async function clearStaleMissionPause() {
    try {
      const probe = await missionProbe();
      if (!probe.changed) return false;
      const live = GM_getValue(K.expect, null);
      if (live?.kind === "dispatch" || live?.kind === "answer" || live?.kind === "review" || (live?.kind === "reminder" && live.runId)) {
        // И эта ранняя ветка не должна закрепить новую миссию до сверки
        // старой выдачи, иначе syncMissionState уже не увидит смену.
        const context = GM_getValue(K.pause, null);
        if (!PAUSE_BEYOND_MISSION.has(context?.kind)) {
          pause("Появилась новая миссия, пока ждём ответ по карточке прошлой. " +
            "Ожидание и Run ID сохранены: сначала сверьте старую карточку и журнал, затем продолжайте.", {
            kind: "mission-change-running", ref: live.ref || "", runId: live.runId || "",
          });
        }
        return false;
      }
      const cleared = [];
      dropPauseOfMission(cleared);
      if (!cleared.length) return false;
      GM_setValue(K.mission, probe.mission.id);
      const name = rt(probe.mission.properties["Миссия"]) || "без названия";
      log(`Пауза относилась к прошлой миссии — снимаю: новая «${name}» начинается с чистого хода.`, false, { tone: "ok" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Блок замечаний Мастера в плане Координатора. Без него «Возвращена» —
   * просто слово в Notion: агент не знает, что именно не принято.
   */
  function returnBlock(mission) {
    if (!isReturned(mission)) return "";
    const remarks = missionRemarks(mission);
    if (!remarks) return "";
    const at = mission.properties["Возвращена"]?.date?.start || "";
    const items = remarkItems(remarks).map((line) => `- ${line}`);
    return [
      `МИССИЯ ВОЗВРАЩЕНА МАСТЕРОМ${at ? ` ${String(at).slice(0, 10)}` : ""} НА ДОРАБОТКУ. Замечания:`,
      ...items,
      "Правила возврата: на каждое замечание — отдельная карточка с оракулом, который именно это замечание проверяет; переделывать фазу целиком нельзя. " +
        "Миссию можно закрыть только когда все замечания закрыты карточками, а в «Итоге» есть раздел «Возврат» с ответом на каждое.",
    ].join("\n");
  }

  /**
   * Отпечаток возврата: дата, круг и замечания.
   *
   * Повторный возврат той же миссии (новый круг или новые замечания) — это
   * новое событие, а не продолжение прошлого: у него свой отсчёт.
   */
  const returnFingerprint = (mission) =>
    [
      mission.properties?.["Возвращена"]?.date?.start || "",
      String(mission.properties?.["Круг"]?.number ?? ""),
      missionRemarks(mission),
    ].join("|");

  /**
   * Момент, с которого возврат миссии известен скрипту.
   *
   * 24.10 в 15:47 Координатор ответил `done`, миссия закрылась, а ожидание
   * плана осталось висеть: 1.4.41 на «нет активной миссии» его не снимала.
   * В 16:07 Мастер вернул миссию, и в 16:12 шаг принял тот старый `done` за
   * ответ на замечания — пауза «в «Итоге» нет раздела «Возврат»», хотя нового
   * хода Координатора не было вовсе.
   *
   * Поэтому у каждого возврата свой отсчёт: всё, что запрошено раньше, —
   * прошлый ход. Оно снимается, а Координатор получает новый план с
   * замечаниями. Как только план запрошен после отсчёта, он уже не старый:
   * перезагрузка страницы и повторный шаг его не трогают.
   */
  function returnEpoch(mission) {
    const key = `cfn-mission-return-at:${mission.id}`;
    const fp = returnFingerprint(mission);
    const saved = GM_getValue(key, null);
    if (saved && saved.fp === fp && Number(saved.at)) return saved;
    // Время возврата — последняя правка карточки миссии: именно тогда Мастер
    // поставил «Возвращена» и написал замечания. Оно точнее, чем «первый шаг
    // после обновления»: план, запрошенный уже после возврата (например, ещё
    // на 1.4.42), не снимается как прошлый. Нет правки — считаем по часам.
    const edited = Date.parse(mission.last_edited_time || "");
    const fresh = { at: Number.isFinite(edited) && edited <= Date.now() ? edited : Date.now(), fp };
    GM_setValue(key, fresh);
    // 1.4.42 объявляла возврат меткой без отпечатка. Если она есть, этот
    // возврат уже был в журнале — переносим метку, чтобы обновление не дало
    // вторую такую же строку. Дальше метка живёт с отпечатком, и новый
    // возврат (другой круг или замечания) объявляется заново.
    const legacy = `cfn-mission-return:${mission.id}`;
    if (!saved && GM_getValue(legacy, false)) {
      GM_setValue(`cfn-mission-return:${mission.id}:${textHash(fp)}`, true);
    }
    return fresh;
  }

  /**
   * Ответ на замечания уже есть: в «Итоге» раздел «Возврат».
   *
   * Того же раздела требует returnBlock, поэтому «есть раздел» и «этот ход
   * получил замечания» — одно и то же утверждение, а не догадка по времени.
   */
  const returnAnswered = (mission) =>
    isReturned(mission) && Boolean(missionRemarks(mission)) &&
    /возврат/i.test(rt(mission?.properties?.["Итог"]));

  /**
   * Ожидание Координатора началось до возврата — это прошлый ход, а не ответ
   * на замечания. Снимаем его и разрешаем новый план немедленно: иначе
   * `done` из прошлого хода выглядит как отказ работать, и цикл встаёт на
   * паузу, которой не за что стоять.
   *
   * Признаков «этот ход уже с замечаниями» три, и первый сильнее остальных:
   * снимок `planBeforeReturn` (делается до отправки плана), раздел «Возврат» в
   * «Итоге» (его требует returnBlock того же возврата) и отметка `markedAt` —
   * когда возврат объявили строкой в журнале. Все они не зависят от того, когда
   * в последний раз правили карточку миссии.
   */
  function dropStalePlan(mission, expect, epoch) {
    if (!isReturned(mission) || !expect) return false;
    const at = Number(expect.at) || Number(expect.sentAt) || 0;
    const since = Number(epoch && epoch.at) || returnEpoch(mission).at;
    const marked = Number(epoch && epoch.markedAt) || 0;
    // 06.11, SYN-1. Возврат в 17:07:32, план с замечаниями в 17:07:57.
    // Координатор к 17:18 создал K-38…K-41 и дописал раздел «Возврат» в
    // «Итог» — «последняя правка» карточки уехала на 17:18, и отсчёт вместе с
    // ней. Ожидание 17:07:57 стало «начатым до возврата»: шаг в 17:19:30 снял
    // живой ход, в 17:19:54 ушёл второй план подряд — ещё 11 минут работы
    // агента и лишний расход лимитов.
    //
    // Время правки карточки для этого вопроса вообще не годится: Координатор
    // пишет в «Итог» в том же ходе. Поэтому сначала снимок плана, затем
    // карточка — раздел «Возврат» означает, что замечания уже разобраны этим
    // ходом. И только если ни того, ни другого нет, решает время.
    const stale = expect.planBeforeReturn === true
      ? true
      : expect.planBeforeReturn === false
        ? false
        : !returnAnswered(mission) && !(marked && at && at >= marked) && !(at && at >= since);
    if (!stale) return false;
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    return true;
  }

  const taskTitle = (p) => rt(p.properties["Запрос"]);
  const taskState = (p) => sel(p.properties["Dispatch State"]);
  const taskRole = (p) => sel(p.properties["Кому"]);

  /**
   * Слова названия миссии — без знаков и связок.
   *
   * 25.10 (фаза 2) Координатор создал NAR-2.14 и NAR-2.15 с «Миссией»
   * «NAR-2 · Шов движок и пак», а миссия называется «NAR-2 · Шов «движок /
   * пак»». Сравнение строк в лоб (`includes`) не совпало, обе карточки
   * выпали из очереди, и транспорт дважды просил план с «0 Ready, 0 Draft»,
   * хотя карточки лежали в базе, — а потом встал на паузу «в Ready нет
   * карточки». Поэтому имена сравниваются по словам: кавычки, «·», «/» и
   * связки «и» на смысл не влияют.
   */
  const MISSION_STOPWORDS = new Set(["и", "миссия", "миссии", "фаза", "этап"]);
  const missionWords = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((w) => w && !MISSION_STOPWORDS.has(w));

  /**
   * Одна ли это миссия. Точное совпадение слов — да; перестановка слов и
   * лишнее слово — тоже да, если короткое название содержит не меньше трёх
   * слов, чтобы короткое название не цепляло соседние миссии. Это сравнение
   * используется для обратной связи; привязка карточек проверяется по Mission ID.
   */
  function missionSame(a, b) {
    const left = missionWords(a);
    const right = missionWords(b);
    if (!left.length || !right.length) return false;
    const key = (list) => [...list].sort().join(" ");
    if (key(left) === key(right)) return true;
    const [small, big] = left.length <= right.length ? [left, right] : [right, left];
    return small.length >= 3 && small.every((w) => big.includes(w));
  }

  /** Поле названия показывается человеку; граница очереди — только UUID миссии. */
  const cardMissionId = (row) => rt(row?.properties?.["Mission ID"]).trim();
  const cardInMission = (row, mission) => Boolean(mission?.id && isUuid(mission.id) &&
    isUuid(cardMissionId(row)) && norm(cardMissionId(row)) === norm(mission.id));

  function cardBindingIssue(row, missions) {
    const id = cardMissionId(row);
    const label = rt(row?.properties?.["Миссия"]).trim();
    const named = label ? missions.filter((item) => rt(item.properties?.["Миссия"]).trim() === label ||
      (isUuid(label) && norm(item.id) === norm(label))) : [];
    if (!isUuid(id) || !missions.some((item) => norm(item.id) === norm(id))) return "Mission ID пуст, ошибочен или не найден";
    if (named.length === 1 && norm(named[0].id) !== norm(id)) return "название и Mission ID указывают на разные миссии";
    return "";
  }

  /** Не прячем записи с пустым состоянием или неизвестной привязкой. */
  async function assertMissionBindings(mission) {
    if (!mission || !isUuid(mission.id)) throw new Error("Нет однозначного UUID миссии.");
    const [missions, cards] = await Promise.all([query(C.missions), query(C.requests)]);
    const states = new Set(["Draft", "Ready", "Running", "Submitted", "Accepted", "Rework", "Blocked"]);
    const problems = cards.filter((row) => cardBindingIssue(row, missions) || !states.has(taskState(row)));
    if (problems.length) {
      const examples = problems.slice(0, 8).map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
      throw new Error(`В «Запросах» ${problems.length} карточек с пустым/неизвестным Mission ID или состоянием: ${examples}. ` +
        "Исправьте их по плану миграции; ни одну не скрываю и не изменяю.");
    }
    return cards;
  }

  /** Сказать про карточки другой миссии один раз на набор, а не на каждый план. */
  const missionSkipSeen = new Set();

  async function tasks(state, mission) {
    if (!mission || !isUuid(mission.id)) throw new Error("Очередь нельзя прочитать без однозначного UUID миссии.");
    const rows = await query(
      C.requests,
      { property: "Dispatch State", select: { equals: state } },
      [{ property: "Sequence", direction: "ascending" }],
    );
    // Непривязанные записи нельзя молча исключить: среди них может быть и
    // карточка текущей миссии, в том числе Accepted для приёмки.
    const unresolved = rows.filter((row) => !isUuid(cardMissionId(row)));
    if (unresolved.length) {
      const examples = unresolved.slice(0, 8).map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
      throw new Error(`В «${state}» ${unresolved.length} карточек без корректного Mission ID: ${examples}. ` +
        "Проверьте и перенесите привязки; историю и состояния карточек не меняю.");
    }
    const wanted = rt(mission.properties["Миссия"]).trim();
    const skipped = rows.filter((row) => !cardInMission(row, mission));
    const kept = rows.filter((row) => cardInMission(row, mission));
    if (skipped.length) {
      const key = `${state}|${skipped.map((row) => row.id).join(",")}`;
      if (!missionSkipSeen.has(key)) {
        missionSkipSeen.add(key);
        const list = skipped.map((row) => `«${firstLine(taskTitle(row), 40)}» — ${cardMissionId(row)}`).join("; ");
        log(`В «${state}» есть карточки другой миссии, они не в очереди: ${list}. ` +
          `Очередь миссии «${firstLine(wanted, 60)}».`, false,
          { tone: "warn", ntfy: "quiet", title: "Relay: карточка вне миссии" });
      }
    }
    return kept;
  }
