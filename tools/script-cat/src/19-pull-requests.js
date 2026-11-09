  // ───────────────────────────── PR ─────────────────────────────
  /**
   * Проверка видимости — общая (`visible` в утилитах). Поймано пробой на
   * разметке Arena: скрытый бейдж «Merged» остаётся в DOM рядом с видимым
   * «Closed», а поиск по одному querySelector находил именно скрытый и считал
   * закрытый PR слитым.
   */
  /**
   * Бейдж ищем только среди видимых. В DOM Arena остаются скрытые элементы
   * прошлых состояний: без этой проверки «Merged» находился на странице, где
   * показан только «Closed».
   */
  const badgeVisible = (label) =>
    [...document.querySelectorAll(`[aria-label="${label}"]`)].some(visible);

  // Кнопка PR считается доступной, только когда её можно нажать: пока
  // страница дорисовывается, Arena держит их `disabled`, и клик по такой
  // кнопке — это не «нажал», а «ничего не произошло» с записью в журнал.
  const pressable = (b) =>
    Boolean(b) &&
    b.isConnected !== false &&
    !b.disabled &&
    b.getAttribute?.("aria-disabled") !== "true" &&
    visible(b);

  const createPr = () =>
    [...document.querySelectorAll('button[aria-label="Create pull request"]')].find(pressable) || null;

  const mergePr = () =>
    [...document.querySelectorAll('button[aria-label="Merge pull request"]')].find(pressable) || null;

  const mergedFlag = () => badgeVisible("Pull request merged");

  /**
   * «Closed» — не синоним ошибки. Так выглядит и PR, слитый через GitHub, и PR,
   * закрытый без мержа. Что именно произошло, решает маркер исполнителя
   * (`merged: true`), а не бейдж. С 1.4.48 заявка проверяется по GitHub API.
   */
  const closedFlag = () => badgeVisible("Pull request closed");

  /**
   * Кнопка «Continue» — та, что после мержа выдаёт агенту новую ветку.
   *
   * Подпись ищем и в тексте, и в `aria-label`: в разметке Arena рядом с текстом
   * лежит иконка, а её `<title>` тоже попадает в `textContent` («ContinueContinue»).
   * Точное сравнение с "Continue" из-за этого не срабатывало, и клика не было.
   */
  const isContinueLabel = (raw) =>
    /^((continue|продолжить)\s*){1,2}$/i.test(String(raw || "").replace(/\s+/g, " ").trim());

  function continueButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      if (!visible(b) || b.disabled || b.getAttribute("aria-hidden") === "true") return false;
      const text = (b.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (b.getAttribute("aria-label") || "").trim();
      return isContinueLabel(text) || isContinueLabel(aria);
    }) || null;
  }

  /**
   * Свежая ветка перед выдачей хода.
   *
   * Continue на странице агента означает ровно одно: прошлый ход закончился
   * слитым (или закрытым) PR, и сессия стоит на ветке, работать в которой уже
   * нельзя. Агент это видит как `pr_merged` и отказывается: «нажмите Continue
   * рядом со статусом PR». Пока Continue не нажата, любое задание в этот чат
   * уходит в мёртвую ветку — работа не начинается, маркера нет, цикл встаёт
   * (27.10, NAR-4.9, ветка `arena/73b6f5a4-relay` после PR #97).
   *
   * Клик по Continue — это не реплика агенту и не команда в репозиторий: Arena
   * просто выдаёт новую ветку от последней базовой версии. Поэтому проверка
   * стоит перед КАЖДОЙ отправкой из очереди, а не только в конце хода: пропуск
   * в одном месте (память о мерже, потерянный клик, ручная правка карточки)
   * больше не превращается в паузу.
   */
  async function ensureFreshBranch(why = "перед выдачей") {
    let cont = continueButton();
    if (!cont && mergedFlag()) {
      // Бейдж «Pull request merged» уже есть, а кнопка ещё не дорисовалась.
      // Ждать дешевле, чем отправить задание в слитую ветку.
      cont = await waitFor(() => continueButton(), patience(4000), 400);
    }
    if (!cont) return "none";
    cont.click();
    log(
      `${why}: на странице видна Continue — ветка прошлого хода слита, работать в ней агент не может. ` +
        "Нажал Continue: Arena выдаст чистую ветку.",
      false,
      { tone: "ok" },
    );
    const gone = await waitFor(() => !continueButton(), patience(8000), 500);
    if (!gone) {
      const again = continueButton();
      if (again) {
        again.click();
        log("Continue осталась на месте — нажал ещё раз.", true);
        await waitFor(() => !continueButton(), patience(6000), 500);
      }
    }
    // После Continue страница перерисовывается: поле ввода и водяной знак
    // читаются уже в новой сессии, поэтому ждём дорисовку до вставки.
    await sleep(1200);
    return continueButton() ? "stuck" : "pressed";
  }

  /** Что из PR-интерфейса видно прямо сейчас. */
  const prSurface = () => ({
    merged: mergedFlag(),
    closed: closedFlag(),
    cont: continueButton(),
    create: createPr(),
    merge: mergePr(),
  });

  const hasPrUi = () => {
    // Кнопка «Create pull request» из плашки «задача выполнена» — это действие
    // чата, а не PR-интерфейс: нажатие отправляет агенту реплику «Please open a
    // pull request…». 24.10 (14:48) именно так в чат Build/Release улетело
    // лишнее сообщение, и агент бросил работу отвечать на него.
    if (completionPlaque()) return false;
    const s = prSurface();
    return Boolean(s.merged || s.closed || s.cont || s.create || s.merge);
  };

  /**
   * Фоновая вкладка.
   *
   * Фокус скрипту не нужен: он ищет элементы и кликает из кода, поэтому цикл
   * идёт и в скрытой вкладке. Но браузер режет там таймеры — сначала до
   * секунды, а через пять минут до одного пробуждения в минуту. Из-за этого
   * короткие ожидания («Continue» за 20 с, карточка PR за 8 с) успевают
   * истечь раньше, чем скрипт проснётся. В фоне растягиваем их: лучше
   * подождать минуту, чем решить, что кнопки нет.
   */
  const tabHidden = () => {
    try {
      return document.visibilityState === "hidden";
    } catch {
      return false;
    }
  };
  const patience = (ms) => (tabHidden() ? Math.max(ms * 3, 60_000) : ms);

  /** Ждём, пока условие станет истинным. Возвращает значение или null. */
  async function waitFor(check, timeoutMs, stepMs = 700) {
    const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const value = check();
      if (value) return value;
      stepAlive();
      if (Date.now() >= until) return null;
      await sleep(stepMs);
    }
  }

  /**
   * Имя текущей ветки. В разметке Arena `span.min-w-0.truncate` встречается
   * несколько раз (заголовок чата, ветка), поэтому берём то, что похоже на
   * ветку, и предпочитаем `arena/…`.
   */
  function branchName() {
    const candidates = [...document.querySelectorAll("span.min-w-0.truncate")]
      .map((el) => (el.textContent || "").trim())
      .filter((text) => /^[\w./-]{3,120}$/.test(text));
    const branchy = candidates.filter((text) => /^(arena|nar|cf)\//.test(text));
    return (branchy.at(-1) || candidates.at(-1) || "");
  }

  /**
   * Ждём, что PR слит. Агент делает это сам (`gh pr merge`). Кнопки — запасной
   * путь: если агент не запушил, Create PR активна, и мы нажимаем её; ответ
   * агента при этом не считается результатом задания (водяной знак).
   *
   * Бейджи PR живут на странице PR, а ответ агента читается на его странице:
   * ни Merge, ни Continue там нет. Поэтому, если никакого PR-интерфейса на
   * экране нет, ждать пять минут бессмысленно — решает маркер (`pr` +
   * `merged: true`). Для legacy Relay при недоступном GitHub остаётся
   * прежняя заявка без подтверждения; новый проект требует проверяемый PR и
   * базовую ветку, а DOM-состояние повторно сверяется с GitHub.
   */
  async function ensureMerged(task, result) {
    const target = dispatchTarget();
    const foreign = typeof projectPrBoundary === "function" ? projectPrBoundary(result, target ? target.repo : null) : "";
    if (foreign) { lastMergeCheck = { status: "boundary", why: foreign }; return "boundary"; }
    const scopedProject = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy;
    let projectCheck = null;
    if (scopedProject) {
      // И до запасных кнопок нужен конкретный PR, его репозиторий и base.
      // Бейдж Arena сам по себе не доказывает, что PR относится к проекту.
      // Проверяем именно цель выдачи (репозиторий + базовая ветка из снимка),
      // а не всегда глобальный C.repo.
      projectCheck = await verifyMergeClaim(result, ghToken(), target || undefined);
      if (projectCheck.status === "boundary" || projectCheck.status === "unknown") {
        lastMergeCheck = projectCheck;
        return "boundary";
      }
    }
    // Память о мерже — на выдачу, а не на карточку.
    //
    // 27.10 NAR-4.9 ответили дважды: PR #95 в 16:41 и PR #97 в 21:15. Ключ был
    // один на карточку, поэтому после второго мержа `ensureMerged` сразу
    // отвечал «already»: ни бейджа, ни Continue скрипт не искал, Continue не
    // нажималась, и сессия Архитектора осталась на ветке
    // `arena/73b6f5a4-relay` со статусом `pr_merged`. Следующая выдача ушла
    // в мёртвую ветку, агент отказался работать, маркера не было, и цикл встал.
    // Повторная работа по той же карточке — это новая выдача, у неё свой run.
    const runId = String(result.run_id || rt(task.properties?.["Run ID"]) || "").trim();
    // Для новых проектов память привязана ещё и к PR: другая ссылка в том же
    // Run не может воспользоваться подтверждением предыдущего PR. Legacy-ключ
    // остаётся прежним. Даже сохранённый успех сверяется с текущим GitHub.
    const projectRef = scopedProject ? prRef(result, target?.repo || C.repo) : null;
    if (scopedProject && !projectRef) {
      lastMergeCheck = { status: "boundary", why: "Не удалось определить PR для этого проекта." };
      return "boundary";
    }
    const key = `${K.merged}${task.id}:${runId || "run"}${projectRef ? `:repo-${encodeURIComponent(projectRef.repo)}:pr-${projectRef.number}:base-${encodeURIComponent(target?.branch || C.branch || "main")}` : ""}`;
    if (GM_getValue(key, false)) {
      if (scopedProject && projectCheck.status !== "merged") {
        lastMergeCheck = projectCheck;
        return "boundary";
      }
      return "already";
    }

    // Карточка PR может отрисоваться на пару секунд позже ответа. Без неё мы не
    // нажмём Continue, и агент останется на уже слитой ветке — поэтому ждём.
    const prUi = hasPrUi() ? true : Boolean(await waitFor(hasPrUi, patience(C.prCardWaitMs), 500));
    if (!prUi) {
      if (!hasMergedClaim(result)) {
        log(`PR на странице нет и в ответе нет заявки о мерже — считаю, что работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала.`, true);
        return "unconfirmed";
      }
      return claimMerge(task, result, key, " (PR-интерфейс живёт на странице PR, а не в чате)");
    }

    const started = Date.now();
    const grace = Date.now() + C.mergeGraceMs;
    let clickedCreate = false;
    let clickedMerge = false;

    while (Date.now() - started < C.prWaitMs) {
      if (mergedFlag()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "merged") { lastMergeCheck = check; return "boundary"; }
        }
        return finishMerge(task, key);
      }
      if (closedFlag()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "closed") { lastMergeCheck = check; return "boundary"; }
        }
        return finishClosed(task, key);
      }
      if (continueButton()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "merged") { lastMergeCheck = check; return "boundary"; }
        }
        return finishMerge(task, key);
      }

      // Агент уже заявил о мерже — кнопки PR не трогаем вовсе, даже если
      // «Create pull request» видна. 24.10 (14:48) именно этот клик отправил в
      // чат Build/Release реплику «Please open a pull request…», и агент вместо
      // работы начал отвечать на неё. Заявка — тот же сигнал, что и в ветке
      // «PR-интерфейса нет вовсе»: заявка о мерже проверяется по GitHub API.
      if (hasMergedClaim(result)) {
        return claimMerge(
          task,
          result,
          key,
          " (кнопки Create/Merge не нажимаю — они отправят агенту лишнюю реплику)",
        );
      }

      if (Date.now() > grace) {
        const create = createPr();
        if (create && !clickedCreate) {
          clickedCreate = true;
          create.click();
          log("Агент не открыл PR сам — нажата «Create pull request» (запасной путь).");
          await sleep(6000);
          continue;
        }
        const merge = mergePr();
        if (merge && !clickedMerge) {
          clickedMerge = true;
          merge.click();
          log("PR не слит — нажата «Merge pull request» (запасной путь).");
          await sleep(6000);
          continue;
        }
      }
      await sleep(2500);
    }
    return "timeout";
  }

  async function finishMerge(task, key) {
    // Continue появляется не мгновенно после бейджа Merged. Раньше кнопку
    // искали один раз: если её ещё не было, клика не происходило вовсе, и
    // агент не получал новую ветку — молча, без единой строки в журнале.
    const cont = await waitFor(continueButton, patience(C.continueWaitMs), 700);
    if (cont) {
      cont.click();
      log("PR слит: нажата Continue — агент получит новую ветку.");
      const gone = await waitFor(() => !continueButton(), 8000, 500);
      if (!gone) {
        const again = continueButton();
        if (again) {
          again.click();
          log("Continue осталась на месте — нажал ещё раз.", true);
          await waitFor(() => !continueButton(), 6000, 500);
        }
      }
      await sleep(3000);
      if (continueButton()) {
        log("Continue всё ещё видна: клик не дошёл. Ветка может остаться прежней — проверьте страницу агента.", true);
      } else {
        log("Continue принята: страница обновилась.");
      }
    } else {
      log(
        `Бейдж Merged есть, а Continue не появилась за ${Math.round(C.continueWaitMs / 1000)} с: ` +
          "продолжаю без неё. Новая ветка появится, когда агент получит следующий ход.",
      );
    }
    const branch = branchName();
    if (branch) {
      GM_setValue(K.branch, branch);
      try {
        await patch(task.id, { Branch: { rich_text: [{ type: "text", text: { content: branch } }] } });
        log(`Рабочая ветка: ${branch}`);
      } catch (e) {
        throw new Error(`PR слит, но ветка ${branch} не записана в Notion: ${e.message}`);
      }
    } else {
      log("Имя ветки на странице не нашлось — в Notion не записываю, карточка останется без «Branch».");
    }
    GM_setValue(key, true);
    return "merged";
  }

  /**
   * Мерж заявлен маркером, PR-интерфейса на странице ещё нет.
   *
   * Кнопки Create/Merge не трогаем: они отправляют агенту лишнюю реплику
   * (24.10 в 14:48 именно так в чат ушло «Please open a pull request…»). Но
   * Continue — это не реплика, а выдача новой ветки, и Arena дорисовывает её
   * уже после того, как узнала о мерже. До 1.4.42 здесь был немедленный
   * выход, поэтому Continue оставалась ненажатой: NAR-1.11, PR #35 — Мастер
   * жал её руками. Ждём бейдж или Continue до mergeGraceMs.
   */
  async function claimMerge(task, result, key, note = "") {
    // Маркеру верим не на слово: «merged: true» — это заявка, а не факт.
    // 24.10 на экране Build/Release висела активная «Create PR» (Arena не
    // знает о PR, слитом через `gh`), и отличить сделанную работу от
    // выдуманной было нечем. Теперь состояние спрашиваем у GitHub.
    const target = dispatchTarget();
    const check = await verifyMergeClaim(result, ghToken(), target || undefined);
    lastMergeCheck = check;
    if (check.status === "boundary" || (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && check.status === "unknown"))
      return "boundary";
    // Проверка не дошла до GitHub (нет токена, отказ прав, сеть). Заявку это не
    // отменяет: без проверки действует прежнее правило, но мастер должен знать,
    // что «слит» принято на слово, и что делать.
    if (check.status === "unknown" && check.needsToken) {
      log(
        `GitHub не проверил ${prLabelOf(result)}: ${check.why}. Заявка принимается по маркеру; ` +
          "чтобы проверять по GitHub, откройте «⚙ Подключения» и сохраните токен.",
        false,
        { tone: "warn", ntfy: "quiet", title: "Relay: GitHub без токена" },
      );
    }
    if (check.notFound) {
      // Самая дорогая ошибка суток: слитый PR #37 объявили отсутствующим, и
      // готовая работа уехала в Rework. 404 не доказывает, что PR нет.
      log(
        `GitHub не читает ${prLabelOf(result)}: ${check.why}. ` +
          "Заявка принимается по маркеру, карточку в Rework за 404 не отправляю.",
        true,
        { tone: "warn", ntfy: "quiet", title: "Relay: PR не виден по API" },
      );
    }
    if (check.status === "open" || check.status === "closed") {
      log(
        `Заявка «${prLabelOf(result)} слит» не подтвердилась: ${check.why}. ` +
          `Карточка вернётся в Rework — работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала.`,
        true,
        // Итоговый тихий пуш с названием карточки отправляется после Rework.
        { tone: "warn", ntfy: false },
      );
      return "claim-rejected";
    }
    const seen = await waitFor(() => mergedFlag() || continueButton(), patience(C.mergeGraceMs), 1000);
    if (seen) return finishMerge(task, key);
    GM_setValue(key, true);
    const proof =
      check.status === "merged"
        ? `, GitHub подтвердил (${check.why})`
        : `; проверить по GitHub не удалось — ${check.why}`;
    log(
      `${prLabelOf(result)} слит: принято по маркеру агента${note}${proof}. ` +
        `Бейджа Merged и Continue на странице нет и через ${Math.round(patience(C.mergeGraceMs) / 1000)} с: ` +
        "если Continue появится позже, нажмите её сами — на запись результата это уже не влияет.",
    );
    return "claimed";
  }

  /**
   * PR закрыт. Дальше на странице остаётся только Continue — жмём её, чтобы
   * цикл не встал, и читаем новую рабочую ветку. Решение «слито или провалено»
   * принимает вызывающий код по маркеру исполнителя.
   */
  async function finishClosed(task, key) {
    const cont = await waitFor(continueButton, patience(Math.min(C.continueWaitMs, 10000)), 700);
    if (cont) {
      cont.click();
      log("PR закрыт: нажата Continue, состояние передано дальше.");
      await waitFor(() => !continueButton(), 8000, 500);
      await sleep(3000);
    } else {
      log("PR закрыт, но Continue на странице нет: перехожу дальше без неё.");
    }
    const branch = branchName();
    if (branch) {
      GM_setValue(K.branch, branch);
      try {
        await patch(task.id, { Branch: { rich_text: [{ type: "text", text: { content: branch } }] } });
        log(`Рабочая ветка: ${branch}`);
      } catch (e) {
        throw new Error(`PR закрыт, но ветка ${branch} не записана в Notion: ${e.message}`);
      }
    }
    GM_setValue(key, "closed");
    return "closed";
  }

  /**
   * Токен GitHub.
   *
   * 24.10 репозиторий `example/relay-fixture` оказался приватным: анонимный
   * запрос к API отвечает на него «404 Not Found» — так же, как на PR, которого
   * нет. 1.4.48 приняла этот ответ за правду и отправила готовую работу
   * (PR #37) в Rework. Токен читает состояние PR; хранится в ScriptCat и в
   * журнал не попадает.
   */
  const ghToken = () => String(GM_getValue(K.ghToken, "") || "").trim();

  /** Ссылка на PR: принимаем и номер, и готовый URL. `repo` — репозиторий цели выдачи. */
  function prUrl(pr, repo = C.repo) {
    const value = String(pr ?? "").trim().replace(/^#/, "");
    if (!value) return "";
    if (/^https?:\/\//.test(value)) return value;
    return /^\d+$/.test(value) ? `https://github.com/${repo}/pull/${value}` : "";
  }

  /** Подпись PR для журнала: номер или ссылка из маркера. */
  const prLabelOf = (result) => {
    const pr = String((result && result.pr) ?? "").trim();
    return !pr ? "PR" : /^https?:/i.test(pr) ? pr : `PR #${pr.replace(/^#/, "")}`;
  };

  /**
   * Номер и репозиторий PR из маркера.
   *
   * Принимаем и число, и «#37», и полный адрес: агент может сослаться на PR
   * словами. Адрес важнее номера — он называет репозиторий. Номер без
   * репозитория проверяется в репозитории цели выдачи (`targetRepo`), а не
   * всегда в `C.repo`.
   */
  function prRef(result, targetRepo = C.repo) {
    const raw = String((result && result.pr) ?? "").trim();
    if (!raw) return null;
    const url = raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
    if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
    const num = raw.replace(/^#/, "").match(/^(\d+)$/);
    return num ? { repo: String(targetRepo || C.repo || ""), number: Number(num[1]) } : null;
  }

  /** Снимок цели выдачи из текущего ожидания: репозиторий и базовая ветка. */
  function dispatchTarget() {
    try {
      const expect = GM_getValue(K.expect, null);
      if (expect && (expect.targetRepo || expect.targetBranch)) {
        return {
          repo: canonicalTargetRepository(expect.targetRepo || C.repo || "", C.repo),
          branch: String(expect.targetBranch || C.branch || "main"),
        };
      }
    } catch { /* ожидание недоступно — работаем с глобальным конфигом */ }
    return null;
  }

  /**
   * Разрешить короткий slug из старых Notion-полей в owner/repo профиля.
   * Role rows давно допускали значение `synapse`, хотя GitHub API требует
   * `Creative36711/synapse`; приоритет — точное уникальное совпадение профиля.
   */
  function canonicalTargetRepository(value, fallback = C.repo) {
    const raw = String(value || fallback || C.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "");
    if (!raw || raw.includes("/")) return raw;
    const repos = typeof ACTIVE_PROFILE !== "undefined" && Array.isArray(ACTIVE_PROFILE.repos)
      ? ACTIVE_PROFILE.repos : [];
    const matches = repos.filter((entry) => entry && String(entry.repo || "").split("/").at(-1).toLowerCase() === raw.toLowerCase());
    return matches.length === 1 ? String(matches[0].repo) : raw;
  }

  /**
   * D-086: может ли эта роль вообще править этот репозиторий.
   *
   * 09.11 Мастер назвал правило прямым текстом: «у нас два репозитория, кто к
   * какому подключён, тот может тот и править; кто к чему подключён — смотри в
   * Notion в базе «Роли», там есть Репозиторий». До сих пор `repo` роли был
   * только источником значения по умолчанию: карточка с полем «Репозиторий»
   * перебивала его, и роль, подключённая к публичному `synapse`, могла получить
   * выдачу в приватный cortex (или наоборот) — ровно так выглядит «у роли не тот
   * репозиторий», на который жалуются агенты.
   *
   * Правило мягкое там, где назначение неизвестно: нет поля у роли — берём repo
   * сессии профиля, как раньше. Расхождение с объявленным репозиторием роли —
   * отказ с названием обеих сторон, а не тихая выдача.
   */
  function roleRepoVerdict(targetRepo, role = null) {
    const target = canonicalTargetRepository(targetRepo || C.repo || "");
    if (!target) return "";
    const declared = String((role && role.repo) || "").trim();
    if (!declared) return "";
    const allowed = canonicalTargetRepository(declared, C.repo);
    if (!allowed || allowed.toLowerCase() === target.toLowerCase()) return "";
    return `репозиторий карточки ${target} не тот, к которому подключена роль: в «Ролях» у ` +
      `${(role && role.name) || "роли"} указан ${allowed}. Выдачу не начинаю — ` +
      "правь поле «Репозиторий» в карточке или подключение роли (D-086)";
  }

  /** Целевой repo карточки; старые карточки наследуют repo активной роли. */
  function taskTargetRepository(card, fallback = C.repo) {
    const props = card && card.properties || {};
    const value = rt(props.Repository).trim() || rt(props["Репозиторий"]).trim();
    return canonicalTargetRepository(value || fallback);
  }

  /** Явная чужая или некорректная ссылка не доказывает мерж нашего проекта. */
  function projectPrBoundary(result, targetRepo = null) {
    const repo = String(targetRepo || C.repo || "");
    const raw = String((result && result.pr) ?? "").trim();
    if (!raw || /^(none|null|no|нет|—|-)$/i.test(raw)) {
      return typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && hasMergedClaim(result)
        ? "В маркере нет номера PR для проверки репозитория и базовой ветки." : "";
    }
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
        !/^https?:/i.test(raw) && !/^#?\d+$/.test(raw)) return "Укажите номер PR или полную HTTPS-ссылку GitHub.";
    if (/^https?:/i.test(raw)) {
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
            !/^\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(url.pathname))
          return "Ссылка PR не является адресом GitHub pull request.";
      } catch { return "Некорректная ссылка PR."; }
    }
    const ref = prRef(result, repo);
    if (ref && ref.repo.toLowerCase() !== repo.toLowerCase()) {
      // Full URL explicitly names the task repo. Accept it only when that repo
      // is registered in this profile; this check runs before GitHub merge
      // verification too, so it must use the same multi-repo resolution there.
      const configured = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
        (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).some(
          (entry) => entry && String(entry.repo || "").toLowerCase() === ref.repo.toLowerCase(),
        );
      if (!configured) return `PR относится к ${ref.repo}, а цель выдачи работает с ${repo}.`;
    }
    return "";
  }

  /** Заголовки GitHub API. Без токена запрос остаётся анонимным (60 в час). */
  function githubHeaders(token) {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "relay-scriptcat",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Состояние PR по GitHub API.
   *
   * Проверка идёт один раз за ход. Приватному репозиторию нужен токен:
   * без него GitHub отвечает 404 независимо от того, есть PR или нет.
   */
  async function githubPr(repo, number, token = "") {
    return request(
      "GET",
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      githubHeaders(token),
      undefined,
      { anonymous: !token },
    );
  }

  async function githubRepo(repo, token = "") {
    return request(
      "GET",
      `https://api.github.com/repos/${repo}`,
      githubHeaders(token),
      undefined,
      { anonymous: !token },
    );
  }

  /**
   * Проверка «PR слит» из маркера.
   *
   * `status`: merged — GitHub подтвердил; open / closed — заявка ложная,
   * принимать её нельзя; unknown — проверить не удалось (сеть, лимит, нет
   * номера, нет токена, PR не читается), и тогда остаётся прежнее правило
   * «верим маркеру, но говорим об этом в журнале». Статуса «PR нет» больше
   * нет: 404 означает только «не видно».
   *
   * `needsToken` — проверка упёрлась в доступ, а не в состояние PR: приватный
   * репозиторий без токена отвечает 404, и это нельзя читать как «PR нет».
   */
  async function verifyMergeClaim(result, token = "", target = null) {
    let repo = canonicalTargetRepository((target && target.repo) || C.repo || "", C.repo);
    let branch = String((target && target.branch) || C.branch || "main");
    const ref = prRef(result, repo);
    // A full PR URL is authoritative when it points to another repository
    // explicitly configured in this project profile. This supports roles
    // whose session repo differs from the task repo without accepting arbitrary
    // external links. The PR base and branch are still verified below.
    if (ref && ref.repo.toLowerCase() !== repo.toLowerCase() &&
        typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
      const entry = (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).find(
        (item) => item && String(item.repo || "").toLowerCase() === ref.repo.toLowerCase(),
      );
      if (entry) {
        repo = ref.repo;
        branch = String(entry.branch || "main");
      }
    }
    const foreign = typeof projectPrBoundary === "function" ? projectPrBoundary(result, repo) : "";
    if (foreign) return { status: "boundary", why: foreign };
    if (!ref) return { status: "unknown", why: "в маркере нет номера PR" };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repo))
      return { status: "boundary", why: `Целевой репозиторий «${ref.repo}» задан не как owner/repo; GitHub-запрос не отправлял.` };
    try {
      const pr = await githubPr(ref.repo, ref.number, token);
      if (!pr || typeof pr !== "object") return { status: "unknown", why: "GitHub ответил пустым ответом" };
      if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
          String(pr.base?.repo?.full_name || "").toLowerCase() !== repo.toLowerCase())
        return { status: "boundary", why: `GitHub не подтвердил репозиторий базовой ветки PR цели выдачи (${repo}).` };
      if (pr.base?.ref && branch && pr.base.ref !== branch)
        return { status: "boundary", why: `PR направлен в ${pr.base.ref}, а базовая ветка цели выдачи — ${branch}.` };
      if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && !pr.base?.ref)
        return { status: "boundary", why: "GitHub не подтвердил базовую ветку PR цели выдачи." };
      const merged = pr.merged === true || Boolean(pr.merged_at);
      if (merged) return { status: "merged", why: `PR #${ref.number} слит ${pr.merged_at || ""}`.trim(), pr };
      if (String(pr.state || "").toLowerCase() === "closed")
        return { status: "closed", why: `PR #${ref.number} закрыт без мержа`, pr };
      return { status: "open", why: `PR #${ref.number} ещё открыт`, pr };
    } catch (e) {
      const raw = String((e && e.message) || e);
      const code = Number((e && e.status) || (raw.match(/HTTP (\d{3})/) || [])[1] || 0);
      // GitHub иногда отвечает на PR-эндпоинт 401/403/404 из-за сохранённого
      // fine-grained token, даже когда PR публичен. Повторяем запрос без
      // Authorization: публичный PR остаётся проверяемым, а приватный по-прежнему
      // возвращает unknown и не принимается за отсутствующий.
      if (token && [401, 403, 404].includes(code)) {
        const anonymous = await verifyMergeClaim(result, "", target);
        if (anonymous.status !== "unknown") return anonymous;
        return {
          ...anonymous,
          needsToken: Boolean(anonymous.needsToken),
          notFound: code === 404 || anonymous.notFound,
          why: `GitHub ответил HTTP ${code} с токеном; анонимная проверка не подтвердила PR: ${anonymous.why}`,
        };
      }
      // Не называем PR-404 проблемой токена, пока не проверили сам repo тем
      // же строго анонимным транспортом. Для публичного repo 200 + PR 404
      // означает расхождение URL/номера/эндпоинта, а не нехватку прав.
      if (code === 404) {
        try {
          const repository = await githubRepo(ref.repo, "");
          if (repository && String(repository.full_name || "").toLowerCase() === ref.repo.toLowerCase()) {
            return {
              status: "unknown",
              notFound: true,
              why: `Репозиторий ${ref.repo} читается анонимно, но GitHub вернул 404 на PR #${ref.number}; проверьте точную ссылку/номер PR`,
            };
          }
          return { status: "unknown", why: `GitHub вернул неожиданный ответ репозитория ${ref.repo} при анонимной проверке PR #${ref.number}` };
        } catch (repoError) {
          const repoRaw = String((repoError && repoError.message) || repoError);
          const repoCode = Number((repoError && repoError.status) || (repoRaw.match(/HTTP (\d{3})/) || [])[1] || 0);
          if (repoCode === 404) {
            return {
              status: "unknown",
              needsToken: true,
              why: `Анонимный GitHub API вернул 404 и на PR #${ref.number}, и на репозиторий ${ref.repo}; доступ/ответ API не подтверждён (проверьте видимость и запрос)`,
            };
          }
          return {
            status: "unknown",
            why: `Анонимный запрос PR #${ref.number} вернул HTTP 404, а запрос repo — ${repoCode ? `HTTP ${repoCode}` : repoRaw}`,
            code: repoCode,
          };
        }
      }
      if (code === 401 || code === 403)
        return {
          status: "unknown",
          why: `GitHub отклонил анонимный запрос (HTTP ${code}); состояние PR не подтверждено`,
          code,
        };
      if (!code) return { status: "unknown", why: `GitHub не ответил: ${raw}` };
      return { status: "unknown", why: `GitHub ответил HTTP ${code}`, code };
    }
  }

  /**
   * Вернуть карточку, которую проверка ошибочно отправила в Rework.
   *
   * 24.10 NAR-1.13 лежала в Rework при слитом PR #37: работа в main, а
   * Координатор уже готовил повторную выдачу. Кнопка «Подключения» → «Вернуть карточку»
   * спрашивает GitHub ещё раз и, если мерж подтверждён, ставит ровно то, что
   * поставила бы удачная проверка: Submitted, Submitted At, PR и отметку в
   * «Ответ». Ready не трогаем: если карточку уже выдали заново, решает Мастер.
   */
  async function recoverLastClaim(adopt = true) {
    const last = GM_getValue(K.lastResult, null);
    if (!last || !last.dispatch_id) return { ok: false, text: "Нет запомненной выдачи: возвращать нечего." };
    const target = last && (last.targetRepo || last.targetBranch)
      ? { repo: last.targetRepo, branch: last.targetBranch } : null;
    const check = await verifyMergeClaim(last.result || last, ghToken(), target);
    if (check.status !== "merged")
      return { ok: false, text: `GitHub мерж не подтверждает: ${check.why}. Карточка не тронута.` };
    const page = await notion("GET", `pages/${last.dispatch_id}`);
    const state = taskState(page);
    const name = last.task || last.dispatch_id;
    if (state === "Ready")
      return {
        ok: false,
        text: `«${name}» уже вернулась в Ready: её могли выдать заново. Правку не делаю — решение за Мастером.`,
      };
    const link = prUrl((check.pr && check.pr.html_url) || last.pr);
    const note =
      `Восстановлено после ложного отказа проверки: GitHub подтвердил мерж ${link || `PR #${last.pr}`}` +
      ` (${check.why}). Повторная работа по карточке не нужна.`;

    // Журнал важнее карточки: Координатор принимает по нему. 24.10 в 19:57
    // случилось ровно это — карточка уже была возвращена в Submitted, а в
    // журнале остался блок «Заявка о мерже не подтвердилась», и Координатор
    // снова поставил Rework, хотя PR #37 лежал в main. Опровержение пишется
    // отдельным маркером, поэтому повторный клик его не дублирует.
    let logFix = "";
    if (last.logId) {
      const marker = `<!-- CF_DISPATCH ${last.dispatch_id}:${last.run_id}:recovered -->`;
      try {
        const wrote = await gateway("append", last.logId, {
          marker,
          entry: `\n\n${marker}\n## Проверка мержа исправлена\n\n${note}\n`,
        });
        logFix = wrote && wrote.duplicate ? " Опровержение уже было в журнале." : " Опровержение записано в журнал.";
      } catch (e) {
        logFix = ` Опровержение в журнал записать не удалось: ${e.message}.`;
      }
    }

    if (state === "Submitted" || state === "Accepted") {
      log(`«${name}» уже ${state}: журнал проверен${logFix ? "," : ""}${logFix}`, false, { tone: "ok" });
      return { ok: true, text: `«${name}» уже ${state}.${logFix}` };
    }

    // Rework — это отказ, при котором ответ агента так и не был прочитан
    // (24.10: работа в main, а карточка ушла в Rework). Такую карточку
    // возвращаем не в Submitted, а в Running: иначе ответ останется в чате
    // невычитанным, и следующая выдача станет дублем («Подключения» → «Взять ответ из чата»).
    if (state === "Rework" || state === "Running") {
      if (state === "Rework") {
        const props = {
          "Dispatch State": { select: { name: "Running" } },
          "Ответ": { rich_text: richText(note) },
        };
        if (link) props["PR"] = { url: link };
        await patch(last.dispatch_id, props);
      }
      GM_setValue(`cfn-done:${last.dispatch_id}:${last.run_id}`, false);
      GM_setValue(K.lastResult, { ...last, recoveredAt: Date.now(), verdict: "Running" });
      let taken = "";
      try {
        const here = adopt && typeof roleFromPath === "function" ? roleFromPath() : "";
        if (here && norm(here) === norm(last.roleId)) {
          const got = await adoptPageAnswer();
          taken =
            got && got.ok
              ? " Ответ прочитан и оформлен обычным путём."
              : ` Ответ сразу не прочитан: ${(got && got.text) || "неизвестно"}.`;
        } else {
          taken =
            ` Откройте страницу «${last.roleName || "исполнителя"}» и нажмите «Взять ответ»:` +
            " карточка снова Running, ответ ждёт.";
        }
      } catch (e) {
        taken = ` Ответ сразу не прочитан: ${e.message}. Кнопка «Взять ответ» на странице роли.`;
      }
      log(`«${name}» возвращена в Running: GitHub подтвердил мерж ${link || ""}`.trim() + logFix, false, {
        tone: "ok",
        ntfy: "quiet",
        title: "Relay: карточка возвращена в работу",
      });
      return { ok: true, text: `Готово: «${name}» снова Running, ${link || `PR #${last.pr}`}.${logFix}${taken}` };
    }

    const props = {
      "Dispatch State": { select: { name: "Submitted" } },
      "Ответ": { rich_text: richText(note) },
      "Submitted At": { date: { start: nowIso() } },
    };
    if (link) props["PR"] = { url: link };
    await patch(last.dispatch_id, props);
    GM_setValue(`cfn-done:${last.dispatch_id}:${last.run_id}`, true);
    GM_setValue(K.lastResult, { ...last, recoveredAt: Date.now(), verdict: "Submitted" });
    log(`«${name}» возвращена в Submitted: GitHub подтвердил мерж ${link || ""}`.trim() + logFix, false, {
      tone: "ok",
      ntfy: "quiet",
      title: "Relay: карточка восстановлена",
    });
    return { ok: true, text: `Готово: «${name}» снова Submitted, ${link || `PR #${last.pr}`}.${logFix}` };
  }

  /**
   * Ложный отказ чинится сам, не дожидаясь Мастера.
   *
   * 24.10 транспорт дважды возвращал слитую работу в Rework: человек узнавал
   * об этом от Координатора, а не от скрипта. Если последняя проверка сказала
   * «заявка не подтвердилась», а GitHub теперь говорит «слит», это уже
   * известный дефект — карточка и журнал исправляются без кликов. Ответ при
   * этом не берётся: его читают кнопкой на странице роли, иначе ход пойдёт
   * мимо очереди.
   */
  let healedThisPage = false;
  async function selfHealClaim() {
    if (healedThisPage) return;
    const last = GM_getValue(K.lastResult, null);
    if (!last || last.verdict !== "claim-rejected" || last.recoveredAt) return;
    healedThisPage = true;
    const target = last && (last.targetRepo || last.targetBranch)
      ? { repo: last.targetRepo, branch: last.targetBranch } : null;
    const check = await verifyMergeClaim(last.result || last, ghToken(), target);
    if (check.status !== "merged") return;
    log(
      `Проверка ошиблась: GitHub подтвердил мерж ${prLabelOf(last.result || last)} — ` +
        "возвращаю карточку и исправляю журнал.",
      false,
      { tone: "ok", ntfy: "quiet", title: "Relay: ложный отказ исправлен" },
    );
    await recoverLastClaim(false);
  }

  /**
   * Ответ уже в чате, а ожидания нет.
   *
   * Скрипт перезапускался, страницу перезагружали, прошлая попытка снимала
   * ожидание — а агент ответил, и карточка осталась в Running. Тогда
   * Координатор ждёт ход, которого никто не начнёт, и через 45 минут карточка
   * уедет в Ready как «брошенная» — то есть работа пойдёт по второму кругу.
   * Кнопка «Взять ответ» читает последний маркер этой страницы и отдаёт его
   * обычному пути submitExecutor. Ничего не додумывает: нужен маркер, карточка
   * в Running, тот же адресат и отсутствие отметки «уже обработано».
   */
  async function adoptPageAnswer() {
    if (GM_getValue(K.expect, null) || GM_getValue(K.pending, null)) {
      return { ok: false, text: "Уже есть ожидание или очередь отправки: сначала завершите текущий ход; для него нажмите «Шаг»." };
    }
    const roleId = roleFromPath();
    if (!roleId) return { ok: false, text: "Откройте страницу агента: брать ответ не с кого." };
    const list = await roles();
    const role = list.find((r) => norm(r.id) === norm(roleId));
    if (!role) return { ok: false, text: "Страница не привязана к активной роли — проверьте «Agent URL»." };
    if (role.fn === "Coordinator")
      return { ok: false, text: "Это страница Координатора: его ход читается кнопкой «Шаг», а не отсюда." };
    const all = messages();
    const last = [...all].reverse().find((n) => !isUserNode(n));
    if (!last) return { ok: false, text: "В чате нет ответов агента." };
    const result = parseMarker(messageRaw(last), "CF_AGENT_RESULT") || parseMarker(messageRaw(last), "CF_COORDINATOR_RESULT") || parseMarker(messageRaw(last), "CF_REVIEW_RESULT");
    if (!result) return { ok: false, text: "В последнем ответе нет маркера выдачи — читать нечего." };
    const ref = String(result.dispatch_id || result.dispatch || result.dispatchId || "").trim();
    if (!isUuid(ref)) return { ok: false, text: `В маркере нет корректного dispatch_id («${ref || "нет"}») — карточку не угадываю.` };
    const run = String(result.run_id || result.run || result.runId || "").trim();
    if (!isUuid(run)) return { ok: false, text: "В маркере нет корректного run_id — чужую выдачу не угадываю." };
    if (GM_getValue(`cfn-done:${ref}:${run}`, false))
      return { ok: false, text: "Эта выдача уже обработана — второй раз не читаю." };
    const page = await notion("GET", `pages/${ref}`);
    const state = taskState(page);
    if (state !== "Running")
      return { ok: false, text: `Карточка уже «${state || "без состояния"}» — читать нечего.` };
    const owner = norm(rt(page.properties["Recipient Agent ID"]));
    if (owner && owner !== norm(role.id))
      return { ok: false, text: "Ответ принадлежит другому агенту — не беру." };
    const mission = await activeMission();
    if (!mission || !cardInMission(page, mission))
      return { ok: false, text: "Mission ID карточки не совпадает с единственной активной миссией — ответ не беру." };
    // Граница — сообщение перед ответом: в журнал попадёт только он.
    const at = all.indexOf(last);
    const watermark = at > 0 ? nodeId(all[at - 1]) : "";
    const expect = {
      ref,
      runId: run,
      missionId: mission.id,
      roleId: role.id,
      roleName: role.name,
      kind: "dispatch",
      sentAt: Date.now(),
      verified: true,
      watermark,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      adopted: true,
    };
    if (GM_getValue(K.expect, null) || GM_getValue(K.pending, null)) {
      return { ok: false, text: "Пока читалась карточка, начался другой ход: его ожидание не перезаписываю." };
    }
    GM_setValue(K.expect, expect);
    await submitExecutor(role, expect, true);
    const updated = await notion("GET", `pages/${ref}`);
    const finished = norm(rt(updated.properties?.["Run ID"])) === norm(run) &&
      ["Submitted", "Accepted", "Rework"].includes(taskState(updated));
    return finished
      ? { ok: true, text: `Ответ ${role.name} обработан: состояние карточки «${taskState(updated)}».` }
      : { ok: false, text: "Карточка ещё не оформлена: проверьте сообщение в панели, ожидание сохранено." };
  }

  /** Последняя проверка заявки — причина для карточки Rework. */
  let lastMergeCheck = null;

  /** Исполнитель утверждает, что слил PR сам. Единственный доступный сигнал. */
  const hasMergedClaim = (result) =>
    !!result && (result.merged === true || String(result.status || "").toLowerCase() === "merged");

  /**
   * Значение `pr` говорит «PR не будет» — само по себе, без заявки о мерже.
   *
   * Выделено из `prDeclined`, чтобы D-046 мог отличить явный отказ от PR
   * (`"pr": null`) от забывчивости (поля нет вовсе), не снимая проверку мержа.
   */
  const prNoneValue = (pr) =>
    pr === null || pr === undefined || /^(none|null|no|нет|—|-)$/i.test(String(pr).trim());

  /**
   * «У этой работы нет PR» — сказано в маркере явно.
   *
   * Отчёт, аудит, запись решения в Notion: кода нет, мержить нечего. Пропуск
   * `pr` значит «забыл» и по-прежнему ведёт в Rework, а вот `"pr": null`,
   * `"none"`, `"-"` или `"нет"` — это заявка «PR не будет», и ждать мерж по ней
   * нельзя: исполнитель честно ничего не пушил (Arena, 24.10: Build/Release на
   * карточке-отчёте получил «Please open a pull request…» на пустом месте).
   *
   * Аудитору PR не нужен никогда: он не меняет репозиторий. Это правило живёт
   * в `submitExecutor` по `role.fn`, а не здесь.
   */
  const prDeclined = (result) => {
    // Новый проект не может одновременно заявлять «PR нет» и «слит»: такую
    // заявку должен остановить projectPrBoundary, не обходить проверку PR.
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && hasMergedClaim(result)) return false;
    if (!result || !("pr" in result)) return false;
    return prNoneValue(result.pr);
  };

  /**
   * D-046: маркер заявляет «PR нет» и «слит» одновременно.
   *
   * Боевой K-34 (06.11.2026, 13:50:39): проверочная карточка без изменений
   * ответила `"pr":null,"merged":true` — ровно как учил шаблон промпта, где
   * рядом с `"pr":"<URL|null>"` стоял литерал `"merged":true`. `prDeclined`
   * из-за заявки о мерже отвечал false, `projectPrBoundary` требовал номер PR,
   * карточка уходила в Blocked и цикл вставал. Второй раз за день (13:05:39 —
   * K-27), первый Мастер правил вручную.
   *
   * Противоречие не принимается и не угадывается: `merged` без PR проверить
   * нечем, а верить слову «слит» нельзя — так можно провести в main код без
   * сверки репозитория и базовой ветки. Но это дефект формата, а не отказ
   * среды: работа сделана, поэтому просим поправить одну строку маркера
   * через обычную лестницу напоминаний (`markerReminders`), а не останавливаем
   * миссию. Инвариант `projectPrBoundary` при этом не ослаблен: если такой
   * маркер всё же дойдёт до проверки мержа, он по-прежнему её не пройдёт.
   *
   * Аудитор и Reviewer сюда не попадают: у них PR нет по роли, и `merged`
   * в их маркере не спрашивается.
   */
  const prMergeConflict = (result) =>
    Boolean(result) && ("pr" in result) && prNoneValue(result.pr) && hasMergedClaim(result);
