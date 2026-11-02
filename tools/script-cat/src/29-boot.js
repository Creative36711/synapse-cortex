  // ───────────────────────────── старт ─────────────────────────────
  // Счётчик охватывает также проход, который сторож busy уже освободил,
  // и фоновые асинхронные операции. Переключение ждёт их завершения.
  const originalProjectTick = tick;
  tick = (...args) => trackProjectTask(originalProjectTick(...args));
  const originalProjectQuestions = refreshQuestions;
  refreshQuestions = (...args) => (!projectApproved() || projectHeld())
    ? Promise.resolve(openQuestions().rows) : trackProjectTask(originalProjectQuestions(...args));
  const originalProjectDecisions = refreshDecisions;
  refreshDecisions = (...args) => (!projectApproved() || projectHeld())
    ? Promise.resolve(openDecisions().rows) : trackProjectTask(originalProjectDecisions(...args));
  const originalProjectPollFlush = flushPollJournal;
  flushPollJournal = (...args) => trackProjectTask(originalProjectPollFlush(...args));

  entries = (GM_getValue(K.log, []) || []).slice(-C.maxLog);
  const boot = () => {
    migrateState();
    // Автоцикл не наследуется от прошлого запуска браузера: сначала — руками.
    autoForgetPersisted();
    mount();
    if (ACTIVE_PROFILE.invalid) log("Проект вкладки недоступен. Проверьте sessionStorage и список профилей; Relay автоматически не подставлен.", true);
    if (debugOn()) {
      installDebugApi();
      console.info(
        `[Relay ${SCRIPT_VERSION}] отладка включена на ${location.pathname}. ` +
          "Снимок: __relay.state(); шаг: __relay.step(); выключить: __relay.debug(false) или кнопка 🐞.",
      );
      dbg("boot", () => debugSnapshot());
    }
    if (new URL(location.href).searchParams.has("cf-auto")) {
      const clean = new URL(location.href);
      clean.searchParams.delete("cf-auto");
      history.replaceState(null, "", clean.toString());
      if (projectApproved() && !projectHeld() && !GM_getValue(K.paused, "")) {
        autoSet(true);
        log("Автоцикл включён через ссылку — только для этой вкладки.");
      } else log("Автозапуск по ссылке пропущен: проверьте допуск, удержание и сохранённую паузу.", true);
    }
    setStatus();
    setup(false);
    setInterval(() => tick(false), C.tickMs);
    // Вернулись во вкладку — не ждём очередного тика: в фоне таймеры режутся,
    // и без этого следующая проверка могла бы случиться через минуту.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick(false);
    });
    if (GM_getValue(K.step, false) && !projectHeld()) {
      GM_setValue(K.step, false);
      log("Открыл страницу роли — выполняю отложенный шаг.");
      tick(true);
      return;
    }
    tick(false);
  };
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot, { once: true });
