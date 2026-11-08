  // ───────────────────────────── цикл ─────────────────────────────
  let busy = false;
  /** Сколько раз подряд шаг снимали с блокировки по тишине. */
  let stepRestarts = 0;

  /**
   * «Шаг жив». Сторож снимает блокировку через две минуты, а ожидание мержа
   * длится до пяти — без этой отметки долгий, но честный шаг выглядел
   * зависанием, и второй тик запускал его заново поверх первого (24.10, 14:48).
   */
  function stepAlive() {
    busyAt = Date.now();
  }

  /**
   * Перейти на страницу роли. Один и тот же переход из одного и того же места
   * дважды за 30 секунд — это не «ещё раз», а зацикливание: значит страница не
   * открылась или адрес в «Ролях» указывает не туда. Тогда пауза и понятная
   * причина, а не бесконечные прыжки.
   */
  async function navigateTo(role, why) {
    if (typeof projectRoleAllowed === "function" && !projectRoleAllowed(role)) return false;
    const from = location.pathname || "/";
    const last = GM_getValue("cfn-nav", null);
    const recent =
      last &&
      norm(last.roleId) === norm(role.id) &&
      last.from === from &&
      Date.now() - Number(last.at || 0) < 30_000;
    if (recent) {
      pause(
        `Не удалось открыть страницу «${role.name}»: остаюсь на ${from}. ` +
          "Страница не открылась за два перехода подряд — возможно, медленная загрузка или адрес в «Ролях» неверен. Проверьте адрес и нажмите «Продолжить».",
        { kind: "nav", ref: role.id },
      );
      return true;
    }
    GM_setValue("cfn-nav", { roleId: role.id, from, at: Date.now() });
    log(`Сейчас ${from} — открываю страницу «${role.name}»: ${why}.`);
    // D-045: отметку перехода и журнал надо довести до хранилища до ухода со
    // страницы, иначе защита от петли прочитает прежнюю отметку и цикл прыгнет
    // снова — уже без памяти о первом переходе.
    await flushBeforeNavigate(handoffKeys());
    location.assign(role.url);
    return true;
  }

  // Ожидание, снятое как фантом, — чтобы тик мог вернуть его карточку в Ready.
  let droppedHandoff = null;
  // Ожидание, снятое обновлением скрипта: карточку вернёт первый же шаг.
  let ghostAfterUpdate = null;

  /**
   * Отправка без подтверждения — не отправка.
   *
   * До 1.4.7 `sentAt` ставился сразу после клика, не глядя, дошёл ли он:
   * карточка «review panel» возвращалась и накрывала кнопку Send, сообщение
   * не появлялось, а скрипт потом честно ждал ответа на несуществующий
   * вопрос. Такое ожидание возвращаем в очередь и отправляем заново.
   */
  function reviveUnverifiedHandoff() {
    const waiting = GM_getValue(K.expect, null);
    if (!waiting || !Number(waiting.sentAt) || waiting.verified === true) return "";

    // Водяной знак относится к чату адресата. На чужой странице чужой ответ
    // нельзя принять за подтверждение доставки старой карточки Reviewer.
    if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
        norm(waiting.roleName) === norm("Warden")) && !waiting.isDispatchReminder &&
        (!waiting.roleId || norm(roleFromPath()) !== norm(waiting.roleId))) {
      pause("Доставка старой карточки Reviewer не подтверждена, а открыт другой чат. Ожидание сохранено: проверьте чат адресата и Run ID.",
        { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
      return "reviewer-held";
    }

    // Если после водяного знака в чате уже что-то появилось, отправка всё-таки
    // дошла (или агент успел ответить): повторять нельзя, иначе будет дубль.
    if (messagesAfter(waiting.watermark || "", waiting.seen).length) {
      GM_setValue(K.expect, { ...waiting, verified: true });
      dbg("revive: после водяного знака есть сообщения — считаю отправку доставленной");
      return "";
    }

    // Это может быть старый уже отправленный ход Reviewer с потерянным
    // подтверждением. Не переотправляем рабочую карточку и не стираем ход.
    if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
        norm(waiting.roleName) === norm("Warden")) && !waiting.isDispatchReminder) {
      pause("Отправка старой или нераспознанной карточки Reviewer не подтверждена. Не повторяю её и сохраняю ожидание и карточку: проверьте чат и Run ID.",
        { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
      return "reviewer-held";
    }
    const text = String(waiting.text || "");
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    if (!text) {
      droppedHandoff = waiting;
      log(
        "Снял ожидание без подтверждённой отправки: в чат ничего не ушло, текста задания не сохранилось. " +
          "Нажмите «Шаг», чтобы начать ход заново.",
        true,
      );
      return "dropped";
    }
    GM_setValue(K.pending, {
      roleId: waiting.roleId,
      roleName: waiting.roleName,
      roleUrl: waiting.roleUrl,
      text,
      at: Date.now(),
    });
    log(
      `Прошлая отправка «${waiting.title || waiting.kind}» не подтверждена (сообщение в чате не появилось) — ` +
        "ставлю задание обратно в очередь и отправляю заново.",
      true,
    );
    return "revived";
  }

  /** Не снимаем потенциально живую старую выдачу Reviewer без очереди. */
  async function holdLegacyUnsentDispatch() {
    const waiting = GM_getValue(K.expect, null);
    if (!waiting || waiting.kind !== "dispatch" || Number(waiting.sentAt) || GM_getValue(K.pending, null)) return false;
    let hold = waiting.roleFn === "Reviewer" || norm(waiting.roleName) === norm("Warden");
    if (!hold) {
      try {
        const owners = (await roleRows({ fresh: true, requireFresh: true }))
          .filter((r) => r.id && norm(r.id) === norm(waiting.roleId));
        hold = !owners.length || owners.some((r) => r.fn === "Reviewer" || norm(r.name) === norm("Warden")) ||
          !owners.some((r) => r.status === "Активна" && ["Executor", "Auditor"].includes(r.fn));
      } catch {
        hold = true;
      }
    }
    if (!hold) return false;
    pause("Старая выдача Reviewer или её адресат не подтверждены. Карточку не откатываю, ожидание сохранено: проверьте чат и Run ID.",
      { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
    return true;
  }

  /**
   * Один отложенный повтор нажатого «Шага». Он ничего не отправляет: первый
   * проход остановился до любой отправки, значит дубля не будет. Нужен потому,
   * что кнопка Stop может быть мгновенной заставкой загрузки страницы.
   */
  let stepRetry = 0;
  function scheduleStepRetry(delayMs = 4000) {
    if (stepRetry >= 2) return;
    stepRetry += 1;
    log(`Проверю ещё раз через ${Math.round(delayMs / 1000)} с: если это была заставка загрузки, шаг пойдёт сам.`);
    setTimeout(() => {
      if (busyReason()?.kind === "stop") {
        log("Кнопка Stop всё ещё на месте — шаг остаётся на паузе до вашего нажатия.");
        stepRetry = 0;
        return;
      }
      stepRetry = 0;
      tick(true);
    }, delayMs);
  }

  async function tick(fromToggle = false) {
    if (typeof projectApproved === "function" && !projectApproved()) {
      if (fromToggle) log("Проект ещё не разрешён к работе: проверьте его в управлении проектами.", true);
      return;
    }
    if (typeof projectHeld === "function" && projectHeld()) {
      // fromToggle используется и отложенными автоматическими шагами: право
      // снять удержание есть только у явных кнопок «Шаг»/«Включить».
      if (fromToggle) log("Проект ждёт ручного запуска после переключения.");
      return;
    }
    if (typeof document !== "undefined" && document.getElementById?.("cfn-projects")) return;
    // Асинхронное окно не блокирует event loop как прежние prompt. Пока оно
    // открыто, не начинаем новые шаги со старыми подключениями; уже запущенные
    // операции и независимые сторожа этим не отменяются.
    if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) {
      if (fromToggle) log("Шаг отложен: завершите настройку или закройте окно подключений.");
      return;
    }
    // Фоновая вкладка в журнале не отмечается: Мастер работает в другой
    // вкладке постоянно, и строка «браузер режет таймеры» превращалась в шум.
    // Растянутые ожидания (`patience`) от этого никуда не делись.
    if (busy) {
      // Шаг мог повиснуть на сетевом запросе без таймаута. Тогда «Шаг» и
      // автоцикл молчат навсегда — снимаем блокировку и говорим об этом.
      //
      // Тишина здесь настоящая: `sleep` и `waitFor` отмечаются в `busyAt`
      // каждые несколько секунд, поэтому живого шага этот сторож не касается.
      // Старый проход остаётся стоять на await, который уже не завершится, —
      // значит перезапуск не дубль, а выход из тупика. Но третий раз подряд —
      // это не сбой одного запроса, а поломка: дальше решает Мастер.
      const silentMs = Date.now() - busyAt;
      if (silentMs < 120000) {
        if (fromToggle) log("Шаг уже выполняется: дождитесь его конца, повторный не нужен.");
        return;
      }
      stepRestarts += 1;
      log(
        `Предыдущий шаг молчал ${Math.round(silentMs / 1000)} с (ни одной отметки жизни) — ` +
          `снимаю блокировку и запускаю заново: ${stepRestarts} из 2.`,
        true,
      );
      busy = false;
      if (stepRestarts > 2) {
        pause(
          "Шаг трижды подряд переставал отвечать на одном и том же месте. Параллельных запусков нет: " +
            "снятый проход не продолжается. Проверьте страницу агента и нажмите «Продолжить».",
          { kind: "step" },
        );
        return;
      }
    }
    // Повтор записи снимка не запускает ход и работает также в ручном режиме
    // и на паузе. Его не ждём: сетевой шлюз не должен блокировать «Шаг».
    flushPollJournal().catch((e) => log(`Очередь записи опросов не обработана: ${e.message}`, true));
    // Ложный отказ проверки мержа чинится сам: иначе карточка ждёт Мастера,
    // а работа уже лежит в main (24.10 так было дважды).
    try {
      await selfHealClaim();
    } catch (e) {
      log(`Самопроверка последнего отказа не удалась: ${e.message}`, true);
    }
    // Окно могли открыть во время асинхронной самопроверки выше.
    if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) return;
    // Provisioning Arena-агентов — отдельный административный контур. Он читает
    // свой request/job/lock до auto/pending-логики и не трогает K.pending/K.expect.
    // Пока запрос или job активен, обычный командный цикл не начинается.
    if (typeof consumeProvision === "function" && await consumeProvision()) return;
    // Незавершённая отправка живёт в очереди и не зависит от автоцикла:
    // иначе после перехода на страницу адресата задание никто не досылал.
    const auto = autoOn();
    const pending = GM_getValue(K.pending, null);
    const waiting = GM_getValue(K.expect, null);
    if (!auto && !fromToggle && !pending && !waiting) return;
    // Пауза снимается только человеком: тик не имеет права её обойти.
    if (isPaused()) {
      // Единственное исключение — пауза, поставленная прошлой миссией: к
      // текущей она не относится и молча держала бы новый цикл.
      if (!(await clearStaleMissionPause())) {
        if (fromToggle) log(`Шаг не выполнен: цикл на паузе (${GM_getValue(K.paused, "")}).`, true);
        return;
      }
    }
    // Вопросы к Мастеру живут отдельным сторожем (`watchQuestions`): они видны
    // и на паузе, а тик до паузы не доходит.
    busy = true;
    busyAt = Date.now();
    try {
      // Капча важнее любого шага: она останавливает и отправку, и ответ.
      if (captchaDialog()) {
        // «Отправлено» перед капчей ничего не доказывает: Arena рисует реплику
        // раньше, чем проверка её пропустит. В журнале должно быть «доставка не
        // подтверждена» — иначе непонятно, зачем переотправлять задание.
        const seen = GM_getValue(K.expect, null);
        if (seen?.sentAt && seen.verified !== false) {
          GM_setValue(K.expect, { ...seen, captcha: true, verified: false });
        }
        captchaPause();
        return;
      }
      // Tool-call limit — продолжение того же хода, раньше общей паузы по ошибке.
      if (await handleToolCallLimit()) return;
      // Ошибка на экране важнее любого шага: сначала остановиться.
      if (monitorVisibleErrors()) return;
      await setup(false);
      // Если параметр setup открыл окно из тика, выйти через finally и снять
      // busy: ожидание закрытия здесь заблокировало бы само сохранение.
      if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) return;
      // Новая миссия — новый ход: остатки прошлой снимаются до любых решений.
      try {
        if (await syncMissionState()) return;
      } catch (e) {
        dbg("миссия: сверка не удалась", e.message);
        const held = GM_getValue(K.expect, null);
        if (held?.kind === "dispatch" || (held?.kind === "reminder" && held.runId)) {
          logThrottled("dispatch-mission-check", "Не удалось сверить миссию выдачи с Notion: ожидание сохранено, повторю проверку на следующем шаге.", true);
          return;
        }
      }
      dbg("tick: состояние", {
        fromToggle,
        path: location.pathname,
        pending: Boolean(GM_getValue(K.pending, null)),
        expect: GM_getValue(K.expect, null) && {
          kind: GM_getValue(K.expect, null).kind,
          sentAt: GM_getValue(K.expect, null).sentAt,
          verified: GM_getValue(K.expect, null).verified,
        },
      });
      const revived = reviveUnverifiedHandoff();
      if (revived === "reviewer-held") return;
      if (droppedHandoff) {
        const gone = droppedHandoff;
        droppedHandoff = null;
        await releaseUndelivered(gone, "отправка не подтвердилась, текста задания не сохранилось");
      }
      if (ghostAfterUpdate) {
        const gone = ghostAfterUpdate;
        ghostAfterUpdate = null;
        await releaseUndelivered(gone, "обновление скрипта: задание не уходило");
      }
      // Эфемерные пилоты SYN-P1 читаются до командного транспорта и живут в
      // отдельном namespace; на странице команды consumePilot возвращает false.
      if (await consumePilot()) return;
      if (await consumePending(fromToggle)) return;
      // Фантом старой версии снят, повторять нечего: без нажатия не начинаем ход.
      if (revived === "dropped" && !auto && !fromToggle) return;
      // Ожидание без отметки отправки и без очереди — след упавшей попытки:
      // сообщения в чате нет, карточке в Running делать нечего. Убираем это
      // на любой странице, иначе Координатор видит живой ход там, где работы
      // не начиналось (24.10, NAR-1.12).
      if (await holdLegacyUnsentDispatch()) return;
      const ghost = await dropGhostHandoff("задание не дошло: отметки отправки нет");
      if (ghost) {
        log(
          `${ghost.expect.roleName || ghost.expect.roleId}: ожидание без отметки отправки — это прошлый ход, ` +
            "а не работа. " +
            (ghost.rolled
              ? "Карточка возвращена в Ready — ход начнётся заново."
              : "Ожидание снято, ход начнётся заново."),
          false,
          { tone: "warn" },
        );
      }
      // Ручной режим: нажатие «Шаг» делает ровно один шаг. Фон (таймер)
      // досылает очередь после перехода, но не читает ответы и не выдаёт
      // новые задания: иначе один ход превращался в цепочку из трёх отправок.
      if (!auto && !fromToggle) return;
      if (fromToggle) dbg("шаг: начало", () => debugSnapshot());

      // Неотправленное задание важнее всего остального: пока оно в очереди,
      // ни план, ни новый ход не начинаются. В автоцикле страницу адресата
      // открываем сами — иначе после перезагрузки вкладки очередь стояла бы
      // вечно, а браузер ждал бы человека.
      const pendingNow = GM_getValue(K.pending, null);
      if (pendingNow && (fromToggle || autoOn())) {
        const here = roleFromPath();
        if (norm(here) !== norm(pendingNow.roleId)) {
          const all = await roles();
          const target = all.find((r) => norm(r.id) === norm(pendingNow.roleId)) || null;
          if (target) return navigateTo(target, "там ждёт отправки задание");
        }
      }

      const meId = roleFromPath();
      if (!meId) {
        // Мастер не обязан помнить, на какой странице стоит цикл, но и угадывать
        // ему не нужно: «Шаг» открывает ту страницу, где действительно есть
        // работа. Сначала — адресат неотправленного задания, потом — тот, чей
        // ответ ждём, и только потом Координатор (там начинается новый ход).
        // В автоцикле Мастер не жмёт «Шаг»: цикл сам открывает ту страницу,
        // где есть работа. Иначе «Включить» на главной ничего не делал.
        if (!fromToggle && !autoOn()) return;
        const list = await roles();
        const pendingNow = GM_getValue(K.pending, null);
        const waitingNow = GM_getValue(K.expect, null);
        const byId = (id) => (id ? list.find((r) => norm(r.id) === norm(id)) || null : null);
        const pendingRole = pendingNow ? byId(pendingNow.roleId) : null;
        const waitingRole = waitingNow ? byId(waitingNow.roleId) : null;
        const coord = list.find((r) => r.fn === "Coordinator");
        const target = pendingRole || waitingRole || coord;
        if (!target) {
          log(
            list.length
              ? "Шаг не выполнен: нет активного Coordinator с заполненным «Agent URL»."
              : "Шаг не выполнен: нет ни одной активной роли с заполненным «Agent URL» — заполните поле в базе «Роли».",
            true,
          );
          return;
        }
        // В ручном режиме отложенный шаг выполняет уже открытая страница.
        // В автоцикле он не нужен: следующий тик продолжит сам.
        if (!pendingNow && fromToggle) GM_setValue(K.step, true);
        const why = target === pendingRole
          ? "там ждёт отправки задание"
          : target === waitingRole
            ? `ждём ответа «${target.name}»`
            : "там начинается ход";
        return navigateTo(target, why);
      }
      const list = await roles();
      let me = list.find((r) => norm(r.id) === norm(meId));
      // Список мог устареть в кеше: Мастер только что вписал этот Agent URL.
      // Один перечит мимо кеша дешевле, чем «страница не привязана к роли».
      if (!me) me = (await rolesFresh().catch(() => [])).find((r) => norm(r.id) === norm(meId));
      if (!me) {
        if (fromToggle)
          log(
            list.length
              ? `Шаг не выполнен: страница ${meId} не привязана к активной роли. Проверьте её «Agent URL».`
              : "Шаг не выполнен: нет ни одной активной роли с заполненным «Agent URL» — заполните поле в базе «Роли».",
            true,
          );
        return;
      }
      GM_setValue("cfn-me", me.name);
      setStatus();

      // Страница не догружена — шаг ничего не делает. Ни вставки, ни кликов,
      // ни закрытия панелей: на недорисованной странице любое действие либо
      // уходит в пустоту, либо бьёт по чужому элементу.
      const shell = appReady();
      if (!shell.ok) {
        logThrottled(
          "app-ready",
          `Страница ещё грузится (${shell.why}) — ничего не делаю, жду.`,
          false,
          C.tickMs * 4,
        );
        return;
      }

      const working = fromToggle ? await busySettled() : busyReason();
      if (working) {
        if (fromToggle) {
          log(`Шаг не выполнен: агент ещё отвечает (${busyLabel(working)}).`);
          // Ложный Stop исчезает сам: не заставляем Мастера жать второй раз.
          if (working.kind === "stop") scheduleStepRetry();
        }
        return;
      }

      let expect = GM_getValue(K.expect, null);
      if (expect && norm(expect.roleId) !== norm(me.id)) {
        const owner = list.find((r) => norm(r.id) === norm(expect.roleId)) || null;
        const ownerName = expect.roleName || owner?.name || "другой роли";
        if ((fromToggle || autoOn()) && owner) {
          let samePage = false;
          try {
            samePage = new URL(owner.url, location.href).pathname === location.pathname;
          } catch {
            samePage = false;
          }
          // Стоим не там, где идёт работа: открываем нужную страницу, а не
          // просим Мастера перейти вручную.
          if (!samePage) {
            if (fromToggle) GM_setValue(K.step, true);
            return navigateTo(owner, `ждём ответа «${owner.name}», а не «${me.name}»`);
          }
        }
        if (fromToggle) log(`Шаг не выполнен: ход ждёт ответа «${ownerName}», а не «${me.name}».`);
        return;
      }

      // Старая версия помечала напоминание отдельным видом ожидания, и после
      // него Координатор «не узнавал» свой ход и запрашивал новый план —
      // отсюда вторая и третья отправки подряд. Приводим к исходному виду.
      if (expect && expect.kind === "reminder") {
        expect = {
          ...expect,
          kind: expect.runId
            ? "dispatch"
            : expect.questionId
              ? "answer"
              : me.fn === "Coordinator" ? "plan" : me.fn === "Reviewer" ? "review" : "dispatch",
        };
        GM_setValue(K.expect, expect);
      }

      // Ожидание без отметки отправки — не ожидание, но только если доставка
      // не доказана. D-044: dropGhostHandoff сначала ищет квитанцию/реплику
      // этой выдачи и восстанавливает `sentAt`; локальный снимок `expect`
      // мог устареть за время сетевых шагов, поэтому решение принимается по
      // живому состоянию, а не по старому объекту.
      if (expect && !Number(expect.sentAt)) {
        const ghost2 = await dropGhostHandoff("задание не дошло: отметки отправки нет");
        const live = GM_getValue(K.expect, null);
        if (!ghost2 && live && Number(live.sentAt)) {
          expect = live;
        } else {
          GM_setValue(K.expect, null);
          GM_setValue("cfn-plan-at", 0);
          log(
            `${me.name}: в чате нет отметки прошлой отправки — это след прошлой попытки, снимаю ожидание и начинаю ход заново.` +
              (ghost2 && ghost2.rolled ? " Карточка возвращена в Ready." : ""),
            true,
          );
          expect = null;
        }
      }

      // Опрос вместо ответа — не ответ. Разбираем его раньше любых
      // напоминаний: иначе «маркера нет» превращается в напоминание агенту,
      // который просто ждёт ответа на свой вопрос (24.10, NAR-1.12).
      const poll = await answerPolls(me, expect);
      if (poll === "answered") {
        log(`Жду, что ${me.name} напишет после ответа на вопрос.`);
        return;
      }
      if (poll === "waiting") {
        // Опрос уже отвечен, продолжения ещё нет. Ждём, но не бесконечно:
        // вопрос в чате — не «свежее сообщение», и общий сторож тишины на нём
        // не сработал бы, оставив карточку в Running навсегда.
        const since = Number((expect && (expect.sentAt || expect.at)) || 0);
        const waitedPoll = since ? Date.now() - since : 0;
        if (expect && waitedPoll > C.replyWaitMs) {
          const stuck = expect;
          dropHandoff(
            `${me.name}: опрос отвечен, но продолжения нет ${Math.round(waitedPoll / 60000)} мин — ` +
              "похоже, ход встал. Очередь и ожидание сняты; нажмите «Продолжить» и пройдите шаг заново.",
          );
          await releaseUndelivered(stuck, "агент не продолжил после ответа на вопрос");
        }
        return;
      }

      // Ждать ответа бесконечно нельзя: если агент не прислал ни строки за
      // replyWaitMs, задание до него, скорее всего, не дошло (например,
      // осталось от старой версии). Молчание тут — ошибка, а не терпение.
      //
      // Но молчание и работа — разные вещи. Задача может идти часами: пока
      // виден Stop или плашка «думает», ход живой, и снимать передачу нельзя —
      // иначе агент останется без ответа, а карточка вернётся в Ready.
      //
      // И третья разница, из-за которой этот блок переписан 25.10: отсутствие
      // ответа на ещё не отрисованной странице — не молчание, а загрузка.
      if (expect) {
        const since = Number(expect.sentAt || expect.at) || 0;
        const waited = Date.now() - since;

        // Отсчёт наблюдения — с того момента, когда страница адресата открылась
        // в этой попытке, а не с отправки: после обрыва связи и «Продолжить»
        // скрипт заходит на страницу, которой ещё секунду назад не видел.
        const path = location.pathname || "/";
        if (expect.seenPath !== path || !Number(expect.seenAt)) {
          expect = { ...expect, seenPath: path, seenAt: Date.now(), readyAt: 0, pageReloaded: false };
          GM_setValue(K.expect, expect);
        }
        const watched = Date.now() - Number(expect.seenAt || Date.now());

        // Пока транскрипт не отрисован, о молчании агента не судим: пустая
        // страница — это загрузка или сеть, а не «задание не дошло».
        const page = pageReady(expect);
        if (page.ok && !Number(expect.readyAt)) {
          // Дальше короткая выдержка: сразу после отрисовки ответ может ещё
          // доезжать, и «пусто» в этот момент ничего не доказывает.
          expect = { ...expect, readyAt: Date.now() };
          GM_setValue(K.expect, expect);
        }
        if (!page.ok) {
          if (watched > C.pageWaitMs) {
            // Ожидание НЕ снимаем и карточку НЕ трогаем: работа могла быть
            // сделана, а ответ — лежать в чате. Это пауза про связь, а не про
            // исполнителя, поэтому после «Продолжить» всё перечитывается.
            expect = { ...expect, seenAt: 0, readyAt: 0, pageReloaded: false };
            GM_setValue(K.expect, expect);
            pause(
              `Страница «${me.name}» не открылась за ${Math.round(watched / 1000)} с (${page.why}). ` +
                "Это не молчание агента: ожидание, очередь и карточка на месте. " +
                "Проверьте связь и нажмите «Продолжить» — скрипт перечитает страницу и заберёт ответ.",
              { kind: "offline", ref: me.id, runId: expect.runId || "" },
            );
            return;
          }
          if (watched > C.pageReloadMs && !expect.pageReloaded) {
            expect = { ...expect, pageReloaded: true };
            GM_setValue(K.expect, expect);
            log(
              `Страница «${me.name}» не отрисовалась за ${Math.round(watched / 1000)} с (${page.why}) — ` +
                "перечитываю её. Ожидание не снимаю: ответ агента остаётся в чате.",
            );
            // D-045: отметка `pageReloaded` должна пережить перезагрузку,
            // иначе страница перечитывается бесконечно.
            await flushBeforeNavigate([K.expect, K.log]);
            location.reload();
            return;
          }
          logThrottled(
            `page-render:${me.id}`,
            `Страница «${me.name}» ещё не отрисовалась (${page.why}) — жду, ответ не снимаю.`,
            false,
            C.tickMs,
          );
          return;
        }

        const observed = Number(expect.readyAt) ? Date.now() - Number(expect.readyAt) : 0;
        const fresh = messagesAfter(expect.watermark || "").length;
        const working = stillWorking();
        if (waited > C.replyWaitMs && observed > C.observeGraceMs && !fresh && !working) {
          const stuck = expect;
          dropHandoff(
            `${me.name} не ответил ни одним сообщением за ${Math.round(waited / 60000)} мин и ничего не делает: ` +
              `страница открыта и видна, ответа в ней нет — похоже, задание до него не дошло. ` +
              `Очередь и ожидание сняты — нажмите «Продолжить» и пройдите шаг заново.`,
          );
          await releaseUndelivered(stuck, "агент не ответил и ничего не делает");
          return;
        }
        if (waited > C.longWaitNoticeMs) {
          logThrottled(
            `long-wait:${expect.ref || expect.roleId || ""}`,
            `Жду ответа «${expect.roleName || expect.roleId}» ${Math.round(waited / 60000)} мин` +
              `${fresh ? " — агент уже отвечает" : working ? " — агент работает" : ""}. ` +
              "Длинная задача может идти часами: ждём, передачу не снимаю.",
            false,
            C.longWaitNoticeMs,
          );
        }
      }

      // Вопрос, который ещё не отвечен, важнее нового хода: как только вопрос
      // записан, ход переходит приёмке (1.4.80). Проверка стоит до выбора
      // роли, поэтому работает и на странице исполнителя, и на странице
      // Координатора — с любой из них транспорт уходит к приёмке сам.
      if (!expect && me.fn !== "Reviewer") {
        const item = answerPending();
        if (item && (fromToggle || autoOn())) {
          const mission = await activeMission().catch(() => null);
          if (mission && (await startAnswer(mission, item))) return;
        }
      }

      if (expect?.kind === "dispatch") {
        // У Reviewer тоже бывают карточки. Их вердикт — ответ по карточке,
        // а не назначенная отдельно приёмка миссии.
        await submitExecutor(me, expect, fromToggle);
      } else if (me.fn === "Coordinator") {
        await coordinatorStep(me, expect, fromToggle);
      } else if (me.fn === "Reviewer" && expect) {
        if (expect.kind === "answer") await answerStep(me, expect, fromToggle);
        else if (expect.kind === "review") await reviewStep(me, expect, fromToggle);
        // D-053: арбитраж петли — отдельный ход приёмки со своим маркером.
        else if (expect.kind === "arbiter") await arbiterStep(me, expect, fromToggle);
        else pause(`Неизвестный вид хода приёмки «${expect.kind || "пусто"}»: ничего не меняю.`, {
          kind: "handoff-kind", ref: expect.ref || "",
        });
      } else if (!expect) {
        // Без ожидания `messagesAfter(expect.watermark)` упал бы в catch,
        // и «Шаг» на странице исполнителя ставил бы паузу вместо ответа.
        const coord = list.find((r) => r.fn === "Coordinator");
        if (fromToggle && coord) {
          // «Шаг» не должен упираться в тупик: работа начинается у
          // Координатора, туда и ведём. Раньше здесь была только строка в
          // журнале, и на опустевшей странице исполнителя жать было некуда —
          // например, после того как задание сняли как просроченное.
          log(`У «${me.name}» нет задания в очереди — открываю Координатора: там начинается ход.`);
          GM_setValue(K.step, true);
          return navigateTo(coord, "там начинается ход");
        }
        if (fromToggle) {
          log(`Шаг не выполнен: у «${me.name}» нет задания в очереди. Ход начинается с Координатора.`, true);
        } else if (autoOn() && coord) {
          // В автоцикле незанятая страница исполнителя — не повод стоять:
          // новый ход начинается у Координатора, туда и переходим.
          return navigateTo(coord, "там начинается ход");
        }
      } else {
        pause(`Неизвестный вид хода «${expect.kind || "пусто"}»: карточку и миссию не меняю.`, {
          kind: "handoff-kind", ref: expect.ref || "",
        });
      }
    } catch (e) {
      // «HTTP 400: path failed validation» Мастеру ничего не говорит. Сначала
      // что случилось и что делать, потом техническая строка — она нужна,
      // если придётся разбираться.
      const raw = String((e && e.message) || e);
      // Причина называется по источнику: «Notion» и «шлюз Drive» — разные
      // поломки и разные действия Мастера.
      const plain = e && e.relay === "question-too-long"
        ? "Вопрос или вариант по умолчанию слишком длинный: ничего не усекал и приёмке не передал. " +
          "Сохраните полный материал в Notion и разберите текущий ход вручную."
        : e && e.relay === "binding"
          ? "Мешает привязка карточек: в «Запросах» есть карточки без Mission ID " +
            "или с неизвестным состоянием. Пока неясно, чьи они, очередь этой миссии не собрать: " +
            "выдавать и принимать такие карточки нельзя. Привяжите их через " +
            "«Управление проектами → Проверить Mission ID карточек» и нажмите «Продолжить» — " +
            "полученный ответ и сами карточки не потеряны, я их не скрываю и не меняю."
          : /битый id|valid uuid|path failed validation/i.test(raw)
        ? "Notion не принял адрес записи: в нём оказался битый id — обычно это " +
          "опечатка в строке-маркере ответа."
        : e && e.relay === "gateway"
          ? e.refused
            ? `Шлюз Drive ответил отказом: ${e.reason} Запись не сделана, в Диске ничего не менялось. ` +
              "Если отказ про папку — в карточке указан не журнал: «Output Drive File ID» должен " +
              `указывать на файл из ${C.driveFolder ? `Arena/${C.driveFolder}/logs` : "Arena/logs"}; скрипт вернёт его сам после обновления.`
            : "Шлюз Drive не ответил, ответ агента в журнал не записан. Проверьте, что " +
              "развёртывание Apps Script открыто «любому, у кого есть ссылка», и что ссылка в ⚙ та же."
          : /HTTP (?:429|5\d\d)/i.test(raw)
            ? "Notion ответил сбоем на своей стороне — это не ошибка карточки и не потерянный ход. " +
              "Скрипт повторил запрос и подождал; Notion не восстановился за это время. Обычно проходит за минуту-другую."
            : /HTTP 4\d\d/i.test(raw)
              ? "Notion отклонил запись: он ответил, и сеть тут ни при чём — данные не прошли его проверку. " +
                (/length should be/i.test(raw)
                  ? "Не поместился текст: одно поле принимает не больше 2000 знаков на объект — " +
                    "это дефект скрипта, а не ошибка карточки или ответа. "
                  : "") +
                "Запись не сделана, ход не потерян."
              : e && e.relay === "notion" && e.link
                ? "Связь с Notion пропала: запрос не дошёл, и два зонда (через 5 и 15 с) её не вернули. " +
                  "Обычно это сон машины или вкладка в фоне — проверьте интернет и нажмите «Продолжить». " +
                  "Запись не сделана, ход не потерян."
                : e && e.relay === "notion" || networkish(raw)
                  ? "Notion не ответил: сеть или блокировка запроса. Запись не сделана."
              : "Шаг прервался на записи в Notion.";
      pause(
        `Цикл остановлен. ${plain} Ход не потерян: очередь и карточка на месте, ` +
          `после «Продолжить» скрипт перечитает ответ.\nТехнически: ${raw}`,
        { kind: "error" },
      );
    } finally {
      busy = false;
      stepRestarts = 0;
      setStatus();
    }
  }
