  // ───────────────────── следы прошлых попыток (очистка) ─────────────────────
  /**
   * Хранилище ScriptCat не обнуляется при обновлении скрипта.
   *
   * Поэтому очередь и ожидание, записанные прошлой версией, «всплывали» уже
   * в новом запуске: шаг ссылался на отправку, которой не было, а журнал
   * выглядел так, будто скрипт помнит что-то постороннее. Начиная с 1.4.9
   * состояние помечается версией и после обновления снимается один раз.
   */
  function transientState() {
    return {
      pending: GM_getValue(K.pending, null),
      expect: GM_getValue(K.expect, null),
      last: GM_getValue(K.lastSend, null),
      // Ход Координатора, чей ответ получен, но не применён (см. 25-legacy-adr):
      // Мастер должен видеть его в «Снять ход?», а не узнавать о нём по паузе.
      recover: GM_getValue(K.planRecover, null),
    };
  }

  /** Понятное описание того, что накопилось: без чтения кода. */
  function describeTransient(state) {
    const parts = [];
    if (state.pending) {
      parts.push(
        `очередь: «${state.pending.roleId}», ${String(state.pending.text || "").length} симв.`,
      );
    }
    if (state.expect) {
      parts.push(
        `ожидание: «${state.expect.roleName || state.expect.roleId}», ${state.expect.kind || "?"}` +
          (state.expect.sentAt ? "" : ", без отметки отправки"),
      );
    }
    if (state.recover?.expect) {
      parts.push(`ответ Координатора получен, но не применён (turn ${state.recover.expect.turnId || "?"})`);
    }
    if (state.last) parts.push("защита от повторов");
    return parts.join("; ");
  }

  /** Снять очередь, ожидание и защиту от повторов. Журнал и настройки не трогаем. */
  function resetState() {
    const state = transientState();
    GM_setValue(K.pending, null);
    GM_setValue(K.expect, null);
    GM_setValue(K.lastSend, null);
    // Снимок недоприменённого хода — часть хода: ↺ снимает его вместе с
    // очередью и ожиданием, иначе «Продолжить» вернул бы снятое Мастером.
    GM_setValue(K.planRecover, null);
    GM_setValue("cfn-plan-at", 0);
    GM_setValue(K.step, false);
    GM_setValue(K.stateV, SCRIPT_VERSION);
    return { ...state, text: describeTransient(state) };
  }

  /** После обновления ни очередь, ни ожидание не считаются доказанным фантомом. */
  function migrateState() {
    const seen = String(GM_getValue(K.stateV, "") || "");
    if (seen === SCRIPT_VERSION) return "";
    GM_setValue(K.stateV, SCRIPT_VERSION);
    // D-073: смена сборки — это и есть «восстановление» после остановки. Наружу
    // уходит вторая точка телеметрии (первая — сама остановка), а предохранители
    // инцидента не сбрасываются: новую сборку ещё нужно подтвердить.
    if (typeof healAfterUpdate === "function" && seen) {
      Promise.resolve()
        .then(() => healAfterUpdate(seen))
        .catch((e) => log(`Восстановление после обновления не отмечено: ${(e && e.message) || e}`, true, { ntfy: false }));
    }
    const expect = GM_getValue(K.expect, null);
    const pending = GM_getValue(K.pending, null);
    if (!expect && !pending) return "";
    const who = expect ? `«${expect.roleName || expect.roleId || "?"}», ${expect.kind || "?"}` : "очередь отправки";
    const message = `Обновление ${seen || "неизвестной версии"} → ${SCRIPT_VERSION}: сохранены ${who} и очередь. ` +
      "Проверьте доставку в чате, карточку и журнал до ручного продолжения; отсутствие sentAt не доказывает, что отправки не было.";
    GM_setValue(K.paused, message);
    GM_setValue(K.pause, { kind: "update-recovery", ref: expect?.ref || "", runId: expect?.runId || "", turnId: expect?.turnId || "" });
    log(message, false, { skip: true });
    return who;
  }

  /**
   * Кнопка ↺: снять ход, а не только память транспорта.
   *
   * 28.10 Мастер нажал ↺, когда задание не ушло. Очередь и ожидание в
   * хранилище снялись — а карточка NAR-5.3 осталась в Notion в Running.
   * Координатор увидел «1 Running», решил, что работа идёт, и выдал следующую
   * карточку; прежняя так и висела. Сброс, после которого карточка выглядит
   * выданной, — это не сброс, а потерянная работа.
   *
   * Поэтому теперь ↺ делает три вещи по порядку:
   *  1) возвращает в Ready карточку текущего хода (`releaseUndelivered`);
   *  2) чистит очередь, ожидание и защиту от повторов (`resetState`);
   *  3) возвращает в Ready все карточки, висящие в Running без хода, — в том
   *     числе оставшиеся от прошлых сбросов и обновлений (`sweepOrphans`).
   *
   * Отмена в диалоге не трогает ничего.
   */
  async function resetStateDialog() {
    const state = transientState();
    const what = describeTransient(state);
    const handoff = state.expect && state.expect.kind === "dispatch" && state.expect.ref ? state.expect : null;
    const cardLine = handoff
      ? `Карточка «${handoff.title || handoff.ref}» вернётся в Ready: сниму «Run ID» и «Started At», ` +
        "чтобы она не висела в Running без хода. Если агент ещё работает, его ответ придёт в чат уже без карточки."
      : what
        ? "Карточку текущего хода верну в Ready, если она висит в Running."
        : "";
    const plan = [
      what ? `Снять с транспорта: ${what}.` : "На транспорте пусто: очереди и ожидания нет.",
      cardLine,
      "Карточки миссии, которые висят в Running без хода, тоже вернутся в Ready.",
      "Журнал и настройки останутся.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const head = what ? "Снять ход?" : "Проверить карточки в Running?";
    if (!confirm(`${head}\n\n${plan}`)) return;

    // 1. Карточка текущего хода — до очистки: после неё `expect` уже не найти.
    let rolled = false;
    if (handoff) {
      rolled = await releaseUndelivered(handoff, "ход снят Мастером кнопкой ↺", { cause: "manual-reset" });
    }
    // 2. Память транспорта.
    resetState();
    if (what) log(`Снял ход вручную (${what}).`);

    // 3. Остальные Running без хода — на любой странице и в любой момент.
    let swept = [];
    try {
      const mission = await activeMission();
      if (mission) swept = await sweepOrphans(mission);
    } catch (e) {
      dbg("сброс: карточки в Running не проверены", e.message);
    }

    if (!what && !swept.length) {
      log("Снимать нечего: очередь пуста, ожидания нет, в Running без хода тоже ничего не висит.");
      return;
    }
    log(
      `Готово: ${what ? "очередь и ожидание сняты" : "транспорт был пуст"}` +
        `${rolled ? ", карточка хода возвращена в Ready" : ""}` +
        `${swept.length ? `, без хода висели ${swept.length} — тоже в Ready` : ""}. ` +
        "Нажмите «Шаг», чтобы начать с чистого листа.",
    );
    setStatus();
  }
