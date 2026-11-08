  // ───────────────────────────── опрос агента ─────────────────────────────

  /**
   * Опрос вместо ответа.
   *
   * 24.10 Kernel на середине NAR-1.12 остановился и выставил карточку с
   * вопросом «May I expand the write zone for this task?»: кнопки с вариантами,
   * свободное поле и `Skip`. Для цикла это конец хода без маркера — работа не
   * сдана, карточка висит в Running, ждать нечего.
   *
   * Отвечать за человека скрипт не берётся, но и молчать нельзя: он
   * перечисляет вопросы и варианты в журнал попытки и отправляет один и тот же
   * универсальный ответ. Он повторяет то, что и так написано в промпте: решай
   * сам в рамках Scope и запиши допущение. Такой ответ годится на любой вопрос
   * агента — про зону, про формат, про выбор из вариантов. `Skip` не годится:
   * он закрывает весь опросник разом, и остальные вопросы пропали бы бесследно.
   */
  const POLL_REPLY = "Реши сам в рамках Scope карточки и продолжай; допущение запиши в отчёт.";

  const buttonLabel = (b) =>
    `${(b && b.getAttribute && b.getAttribute("aria-label")) || ""} ${(b && b.textContent) || ""}`.trim();

  /** Текст вопроса: подпись группы, иначе заголовок карточки. */
  function pollQuestionText(group) {
    const label = String(group.getAttribute("aria-label") || "").trim();
    if (label) return label;
    const head = group.querySelector(".body-base, .body-sm");
    const text = String((head && (head.innerText || head.textContent)) || group.innerText || "");
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Вопросы в последнем ответе агента.
   *
   * Смотрим только последнее сообщение: отвеченные карточки прошлых ходов
   * остаются в транскрипте, и трогать их нельзя. В одном опросе может быть
   * несколько вопросов — у каждого своя группа `radiogroup`, свои варианты и
   * своё поле свободного ответа.
   */
  function pollQuestions(root = document) {
    const last = [...root.querySelectorAll('[data-agent-transcript-message="true"]')]
      .filter((n) => !n.querySelector('[data-user-message-layout="true"]'))
      .at(-1);
    if (!last) return [];
    const id = nodeId(last);
    const out = [];
    for (const group of last.querySelectorAll('[role="radiogroup"]')) {
      if (!visible(group)) continue;
      const buttons = [...group.querySelectorAll("button")];
      out.push({
        id,
        el: group,
        question: pollQuestionText(group),
        options: [...group.querySelectorAll('[role="radio"]')].map((b) =>
          String(b.innerText || b.textContent || "").replace(/\s+/g, " ").trim(),
        ),
        input: group.querySelector('input[type="text"], input:not([type])') || null,
        submit: buttons.find((b) => /submit custom response|отправить/i.test(buttonLabel(b))) || null,
        skip: buttons.find((b) => /^skip$/i.test(buttonLabel(b))) || null,
      });
    }
    return out;
  }

  /**
   * Записать текст в поле так, чтобы это увидел React.
   *
   * `input.value = …` меняет свойство экземпляра, а React читает сеттер
   * прототипа: без него кнопка Submit остаётся disabled и ответ не уходит.
   */
  function fillInput(input, value) {
    const doc = input.ownerDocument || document;
    const view = doc.defaultView || window;
    const set = (text) => {
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      for (const name of ["input", "change"]) {
        input.dispatchEvent(new view.Event(name, { bubbles: true }));
      }
    };
    // Пустая строка перед текстом: если прошлая попытка уже оставила здесь
    // этот же текст, React не увидит изменения и не включит Submit.
    if (String(input.value || "")) set("");
    set(value);
  }

  /**
   * Ждём, пока условие станет истинным.
   *
   * После вставки текста карточка перерисовывается, и кнопка Submit оживает не
   * в тот же кадр: клик «одновременно с текстом» уходит в ещё выключенную
   * кнопку, а текст остаётся висеть в поле (24.10, 18:50).
   */
  async function pollWait(check, timeoutMs = 4000, stepMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = check();
      if (found) return found;
      await sleep(stepMs);
    }
    return check() || null;
  }

  // Снимок опроса сохраняется до Submit/Skip: после клика карточка может
  // исчезнуть, а сеть или сама вкладка — оборваться. Очередь живёт отдельно от
  // очереди ответов Notion и не зависит от текущей миссии или режима цикла.
  const POLL_JOURNAL_QUEUE = "cfn-poll-journal-queue";
  const POLL_JOURNAL_CAPTURE_MS = 300000; // после аварии незавершённый снимок тоже можно дописать

  /** Маркер совместим с обоими шлюзами: append разрешён только для CF_DISPATCH. */
  function pollLogEntry(role, questions, reply, expect = null, outcomes = [], at = nowIso(), attempt = 1) {
    const safePart = (value) => String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
    const hash = textHash(JSON.stringify(questions.map((q) => [q.id, q.question, q.options])));
    const marker = `<!-- CF_DISPATCH ${safePart(expect?.ref)}:${safePart(expect?.runId || expect?.turnId)}:poll:${hash}:${attempt} -->`;
    return [
      marker,
      `## Вопрос агента вместо работы (${(role && role.name) || "агент"})`,
      "",
      `- когда: ${at}`,
      `- универсальный вариант ответа: «${reply}»`,
      "- ответ человека не запрашивался; результат каждой попытки указан ниже",
      "",
      ...questions.flatMap((q, i) => [
        `### Вопрос ${i + 1}`,
        q.question || "(без текста)",
        "",
        ...(q.options.length ? q.options.map((o) => `- ${o}`) : ["- вариантов не было"]),
        `- результат при обработке: ${outcomes[i] || "не подтверждён"}`,
        "",
      ]),
    ].join("\n");
  }

  const pollJournalQueue = () => {
    const saved = GM_getValue(POLL_JOURNAL_QUEUE, []);
    return Array.isArray(saved) ? saved : [];
  };
  const samePollRecord = (a, b) => a && b && a.fileId === b.fileId && a.marker === b.marker;

  /** Сохраняем снимок до клика; старый не перезаписываем при новом проходе. */
  function queuePollJournal(record) {
    const list = pollJournalQueue();
    if (list.some((item) => samePollRecord(item, record))) return false;
    GM_setValue(POLL_JOURNAL_QUEUE, [...list, record]);
    return true;
  }

  /** После обработки можно записать фактический исход, не выдумывая успех. */
  function finishPollJournal(record, entry) {
    const list = pollJournalQueue();
    const index = list.findIndex((item) => samePollRecord(item, record));
    if (index < 0) return;
    list[index] = { ...list[index], entry: `\n\n${entry}\n`, readyAt: 0 };
    GM_setValue(POLL_JOURNAL_QUEUE, list);
  }

  let pollJournalBusy = false;
  /**
   * Отдельный повтор записи, никогда не повторяет Submit. Даже если шлюз уже
   * записал файл, но ответ потерялся, его маркер превращает повтор в duplicate.
   * Читаем очередь заново после каждого await, чтобы не затереть новые записи.
   */
  async function flushPollJournal() {
    if (pollJournalBusy) return;
    pollJournalBusy = true;
    try {
      const due = pollJournalQueue().filter((item) =>
        item && item.fileId && item.marker && item.entry &&
        Date.now() >= Number(item.readyAt || 0) && Date.now() >= Number(item.nextAt || 0),
      ).slice(0, 10);
      for (const item of due) {
        try {
          const result = await gateway("append", item.fileId, { marker: item.marker, entry: item.entry });
          if (!result || result.ok !== true) throw new Error("шлюз не подтвердил запись");
          GM_setValue(POLL_JOURNAL_QUEUE, pollJournalQueue().filter((row) => !samePollRecord(row, item)));
          const duplicate = result.duplicate || result.result === "duplicate";
          log(
            `${item.roleName}: вопрос и варианты ${duplicate ? "уже были" : "записаны"} в журнале попытки.`,
            false,
            { ntfy: false },
          );
        } catch (e) {
          const list = pollJournalQueue();
          const index = list.findIndex((row) => samePollRecord(row, item));
          if (index < 0) continue;
          const attempts = (Number(list[index].attempts) || 0) + 1;
          const wait = Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
          list[index] = { ...list[index], attempts, nextAt: Date.now() + wait };
          GM_setValue(POLL_JOURNAL_QUEUE, list);
          if (attempts === 1) {
            log(
              `Вопрос агента не записался в журнал попытки: ${(e && e.message) || e}. ` +
                "Снимок сохранён в ScriptCat, запись повторится без повторного ответа агенту.",
              true,
              { ntfy: "quiet", title: "Relay: запись опроса отложена" },
            );
          }
        }
      }
    } finally {
      pollJournalBusy = false;
    }
  }

  let pollBusy = false;

  /**
   * Разобрать опрос: перечислить вопросы, ответить «Решай сам», записать в
   * журнал попытки.
   *
   * Возвращает `"answered"` (только что ответили), `"waiting"` (опрос уже
   * отвечен, агент ещё не продолжил) или `null` (опроса нет).
   */
  async function answerPolls(role, expect = null) {
    if (pollBusy) return "waiting";
    const found = pollQuestions();
    if (!found.length) return null;
    // Последняя реплика агента может быть старой, даже если ниже уже стоит
    // наше новое задание. Не отвечаем ей заново и не пишем в чужую попытку.
    const messageId = found[0].id;
    if (expect && messageId &&
        (messageId === expect.watermark || (Array.isArray(expect.seen) && expect.seen.includes(messageId)))) return null;
    const who = (role && role.name) || (expect && expect.roleName) || "агент";
    // Ключ — ход агента: повторный тик не отвечает на тот же вопрос дважды.
    // Метки 1.4.45 сюда не читаются: они ставились без проверки, что Submit
    // сработал, и на живом опросе Kernel заблокировали бы повтор.
    const key = `cfn-poll2:${(expect && (expect.runId || expect.turnId || expect.ref)) || location.pathname}`;
    const handled = new Set(GM_getValue(key, []));
    const pending = found.filter((q) => !handled.has(`${q.id}:${q.question}`));
    if (!pending.length) return "waiting";

    pollBusy = true;
    const all = pending.map(({ id, question, options }) => ({ id, question, options }));
    const outcomes = all.map(() => "не подтверждён");
    const at = nowIso();
    let journal = null;
    let journalAttempt = 1;
    try {
      const logId = expect && expect.logId;
      if (logId) {
        // Новая попытка ответить на тот же вопрос — отдельное событие с новым
        // исходом. Сетевые повторы этого события используют сохранённый маркер.
        const attemptKey = `${key}:journal-attempt`;
        journalAttempt = (Number(GM_getValue(attemptKey, 0)) || 0) + 1;
        GM_setValue(attemptKey, journalAttempt);
        const entry = pollLogEntry({ name: who }, all, POLL_REPLY, expect, outcomes, at, journalAttempt);
        journal = {
          fileId: logId,
          marker: entry.split("\n")[0],
          entry: `\n\n${entry}\n`,
          roleName: who,
          readyAt: Date.now() + POLL_JOURNAL_CAPTURE_MS,
          attempts: 0,
          nextAt: 0,
        };
        queuePollJournal(journal);
      } else {
        // Без привязки к достоверному ходу нельзя угадывать чужой Drive-файл.
        // Сохраняем то, что удалось прочитать, в панели для ручного переноса.
        log("Вопрос агента не записан в журнал попытки: нет ID журнала для этого хода. Вопрос и варианты ниже — для ручного переноса.", true, { ntfy: "quiet" });
        for (const q of all) {
          log(`Для ручного переноса: ${q.question || "(без текста)"} — варианты: ${q.options.join("; ") || "нет"}.`, false, { ntfy: false });
        }
      }
      // Вопросы перечисляются ДО ответа: после Submit карточка
      // перерисовывается, и остальные могли бы исчезнуть вместе с ней.
      for (const q of pending) {
        log(
          `${who} спросил вместо работы: «${firstLine(q.question, 200)}»` +
            `${q.options.length ? ` — вариантов ${q.options.length}` : ""}.`,
          false,
          { tone: "warn", ntfy: "quiet", title: "Relay: агент спросил" },
        );
      }
      let answered = 0;
      const failed = [];
      for (const [index, first] of pending.entries()) {
        // После Submit карточка перерисовывается: узлы вопроса уже отвязаны.
        // Поэтому перед каждым ответом берём живые узлы заново.
        const live = () => pollQuestions().find((x) => x.question === first.question) || null;
        const q = live();
        // Вопрос пропал — его уже закрыли, это не наша забота. Вопрос есть, а
        // свободного поля нет — ответить некуда, и это уже потеря.
        if (!q) {
          outcomes[index] = "карточка исчезла до подтверждения ответа";
          continue;
        }
        if (!q.input) {
          outcomes[index] = "нет поля для ответа";
          failed.push({ first, index });
          continue;
        }
        fillInput(q.input, POLL_REPLY);
        // Ответ считается ушедшим, только если поле перестало держать наш
        // текст или вопрос пропал из карточки. Иначе текст висит в поле, а
        // Submit остаётся выключенным — это и случилось 24.10 в 18:50.
        const sent = () => {
          const now = live();
          return !now || !now.input || String(now.input.value || "") !== POLL_REPLY;
        };
        let done = false;
        for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
          const button = await pollWait(() => {
            const now = live();
            return now && now.submit && now.submit.disabled === false && now.submit.isConnected !== false
              ? now.submit
              : null;
          }, attempt === 1 ? 4000 : 2000);
          if (button) button.click();
          if (await pollWait(() => (sent() ? true : null), 2000)) done = true;
          else if (attempt === 2 && q.input) {
            const view = (q.input.ownerDocument || document).defaultView || window;
            q.input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            if (await pollWait(() => (sent() ? true : null), 1500)) done = true;
          }
        }
        if (done) {
          handled.add(`${first.id}:${first.question}`);
          // После Submit Arena может сразу перезагрузить вкладку: не ждём конца
          // остальных вопросов, чтобы не ответить на этот второй раз.
          GM_setValue(key, [...handled].slice(-25));
          answered += 1;
          outcomes[index] = "универсальный ответ отправлен";
        } else {
          outcomes[index] = "отправка ответа не подтверждена";
          failed.push({ first, index });
        }
        await sleep(300);
      }
      if (!answered && failed.length) {
        // Ни один ответ не ушёл. Опрос нельзя оставить висеть: он держит ход.
        // Skip закрывает сразу весь опросник, поэтому идём на него только
        // здесь — вопросы уже перечислены в журнале — и говорим, что теряем.
        const remaining = () => pollQuestions().filter((q) =>
          failed.some(({ first }) => first.id === q.id && first.question === q.question),
        );
        const skip = remaining().find((q) => q.skip && q.skip.disabled !== true && q.skip.isConnected !== false)?.skip;
        if (skip) {
          skip.click();
          const closed = await pollWait(() => (remaining().length ? null : true), 2500);
          for (const { first, index } of failed) {
            if (closed) handled.add(`${first.id}:${first.question}`);
            outcomes[index] = closed ? "нажат Skip, ответ не отправлен" : "Skip нажат, закрытие не подтверждено";
          }
          log(
            closed
              ? `${who}: ответ на вопрос не отправился — Skip закрыл опрос.`
              : `${who}: Skip нажат, но опрос не исчез. Закрытие не подтверждено; проверьте чат.`,
            true,
            { tone: "warn", ntfy: closed ? "quiet" : "loud", title: closed ? "Relay: опрос закрыт кнопкой Skip" : "Relay: опрос держит ход" },
          );
        } else {
          log(
            `${who}: ответ на вопрос не отправился, и Skip не нашёлся — опрос держит ход. ` +
              "Нажмите кнопку ответа в чате вручную.",
            true,
            { tone: "warn", ntfy: "loud", title: "Relay: опрос держит ход" },
          );
        }
      }
      GM_setValue(key, [...handled].slice(-25));
      if (answered) {
        log(
          `Ответил ${who} на опрос: «${firstLine(POLL_REPLY, 90)}» (вопросов ${answered}).`,
          false,
          { tone: "warn" },
        );
      }
      if (answered && expect && expect.runId) {
        const strikes = (Number(GM_getValue(`cfn-poll-count:${key}`, 0)) || 0) + 1;
        GM_setValue(`cfn-poll-count:${key}`, strikes);
        if (strikes >= C.pollPauseCount) {
          pause(
            `${who} спрашивает вместо работы ${strikes} раз за ход. Это не случайность: ` +
              "противоречие в карточке или в промпте. Проверьте Scope и зону записи, " +
              "затем нажмите «Продолжить».",
            { kind: "poll-loop", ref: (expect && expect.ref) || "", runId: (expect && expect.runId) || "" },
          );
        }
      }
      return answered ? "answered" : "waiting";
    } finally {
      try {
        if (journal) {
          finishPollJournal(journal, pollLogEntry({ name: who }, all, POLL_REPLY, expect, outcomes, at, journalAttempt));
        }
      } finally {
        pollBusy = false;
      }
      if (journal) await flushPollJournal();
    }
  }

  /**
   * Ждём появления редактора.
   *
   * Карточку закрываем только если редактора нет вовсе: она рисуется сверху,
   * но программный ввод и клик её не боятся. Прошлый цикл «закрыть → проверить
   * → закрыть заново» и давал мигание, которое видно глазом.
   */
  async function ensureComposer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let closed = 0;
    let polled = 0;
    while (Date.now() < deadline) {
      const editor = composer();
      if (editor) return { editor, closed, polled, overlay: false };

      // Панелей завершения может быть больше одной: закрытая верхняя
      // открывает нижнюю — снаружи это выглядит как «плашка вернулась».
      if (closed < 6 && completionPanels().length) {
        const n = await closeCompletionPanels();
        if (n) {
          closed += n;
          dbg("editor: поля ввода нет — убрал панели и жду", { closed });
          await sleep(600);
          continue;
        }
      }
      // Поле не находится, а в чате висит вопрос агента: отвечаем на него, а не
      // жмём Skip. K.expect здесь относится к ещё не отправленному заданию;
      // привязать старый опрос к его журналу было бы записью в чужую попытку.
      // Без достоверного ID answerPolls прямо предупредит и выведет снимок.
      if ((await answerPolls(null)) === "answered") {
        polled += 1;
        dbg("editor: ответил на вопрос агента");
        await sleep(700);
        continue;
      }
      await sleep(400);
    }
    return { editor: null, closed, polled, overlay: completionPanels().length > 0 };
  }

  /** Короткая диагностика, почему поле не нашлось: без неё остаётся гадать. */
  function composerDiagnostics() {
    const count = (selector) => document.querySelectorAll(selector).length;
    // Сколько кандидатов отброшено и по какой причине: без этого «не нашёл
    // поле ввода» не отличить от «нашёл, но исключил своим же фильтром».
    let droppedSidebar = 0;
    let droppedHidden = 0;
    let droppedOwn = 0;
    let droppedService = 0;
    // `textarea` в перечне не было, а зря: 25.10 в 14:57 диагностика
    // показывала «contenteditable 0, textarea 1», и по ней нельзя было
    // понять, чьё это поле — сайдбара, капчи или нашей же панели.
    for (const el of document.querySelectorAll(
      "textarea:not([readonly]), [contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
    )) {
      if (el.tagName === "INPUT") continue;
      if (isServiceField(el)) droppedService += 1;
      else if (inOwnPanel(el)) droppedOwn += 1;
      else if (inSidebar(el)) droppedSidebar += 1;
      else if (!visible(el)) droppedHidden += 1;
    }
    const parts = [
      `contenteditable ${count("[contenteditable]")}`,
      `textarea ${count("textarea")}`,
      `textbox ${count("[role='textbox']")}`,
      droppedSidebar ? `в сайдбаре ${droppedSidebar}` : "",
      droppedHidden ? `скрытых ${droppedHidden}` : "",
      droppedOwn ? `в своей панели ${droppedOwn}` : "",
      droppedService ? `служебных ${droppedService}` : "",
      `панель ${completionPanels().length}`,
      `skip ${count('[data-agent-transcript-message="true"] button') && skipCardButton() ? "да" : "нет"}`,
      `путь ${location?.pathname || "/"}`
    ].filter(Boolean);
    return parts.join(", ");
  }

  /** Ждём активную кнопку Send (ниже — единственная реализация). */
  /** Почему Send не нажимается: список кандидатов вокруг редактора. */
  function sendDiagnostics(editor) {
    const scope = editor?.closest?.("form") || document;
    return [...scope.querySelectorAll('button, [role="button"]')]
      .slice(0, 8)
      .map((b) => ({
        el: describe(b),
        labels: labelText(b).slice(0, 3),
        visible: visible(b),
        disabled: Boolean(b.disabled),
        ariaDisabled: b.getAttribute?.("aria-disabled") || "",
        covered: elementCovered(b),
      }));
  }

  /**
   * Нажатие Send с проверкой результата. Плашка возвращается на место после
   * закрытия (решает backend), поэтому кнопка может оказаться под оверлеем —
   * такой клик не доходит, и раньше мы всё равно писали «Задание отправлено».
   */
  /**
   * Ждём активную кнопку Send.
   *
   * Программный `button.click()` не проходит через оверлей — карточка клик не
   * ловит. Мешает другое: пока редактор не зарегистрировал ввод, кнопка
   * `disabled`, и клик по ней ничего не делает. Поэтому ждём именно активности.
   */
  async function waitForSendReady(editor, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      const btn = sendButton(editor);
      if (btn) return btn;
      attempts += 1;
      if (attempts === 4 || attempts === 12) {
        // Половина времени ожидания прошла без активной кнопки: повторяем ввод.
        dbg("Send: кнопка неактивна, повторяю вставку текста", () => debugSendButton(editor));
        return null;
      }
      await sleep(250);
    }
    return null;
  }

  /**
   * Поле и кнопка отправки готовы принять клик.
   *
   * `sendButton()` уже отбрасывает `disabled`, поэтому «кнопки нет» и «кнопка
   * есть, но заблокирована» здесь — одно состояние: страница ещё не готова.
   */
  function sendReady(editor) {
    const live = editor && composerAlive(editor) ? editor : composer();
    if (!live) return { ok: false, why: "поле ввода не найдено" };
    const state = String(document.readyState || "");
    if (state && state !== "complete" && state !== "interactive") {
      return { ok: false, why: `страница грузится (${state})`, editor: live };
    }
    const btn = sendButton(live);
    if (!btn) return { ok: false, why: "кнопка Send ещё неактивна", editor: live };
    return { ok: true, btn, editor: live };
  }

  /**
   * Ждём активную кнопку Send, не снимая задание.
   *
   * 17:30:24 (25.10): два фиксированных ожидания по 1,5 и 3 с закончились
   * раньше, чем страница дорисовала транскрипт, и отказ ушёл в паузу с
   * откатом карточки. Ждать надо столько, сколько рисуется страница, а текст
   * в поле — возвращать, если его стёрла перерисовка.
   */
  async function waitSendReady(editor, text, timeoutMs = C.sendReadyMs) {
    const started = Date.now();
    // Пустая настройка не должна превращать ожидание в NaN: без числа
    // deadline был бы NaN, и кнопка считалась бы недоступной мгновенно.
    const deadline = started + (Number(timeoutMs) || 20000);
    let lastPrompt = 0;
    let told = false;
    while (Date.now() < deadline) {
      const probe = sendReady(editor);
      if (probe.ok) return probe.btn;
      if (probe.editor && Date.now() - lastPrompt > 1500) {
        lastPrompt = Date.now();
        writePrompt(probe.editor, text);
      }
      if (!told && Date.now() - started > 3000) {
        told = true;
        log("Страница дорисовывается: кнопка Send ещё неактивна — жду. Задание остаётся в очереди.");
      }
      await sleep(300);
    }
    return null;
  }

  /**
   * Отличительная строка задания: по ней видно, что в чат ушло именно это
   * сообщение, а не предыдущее. Первые строки промпта у всех заданий
   * одинаковые (технический блок), поэтому ключ берётся из строки с
   * `dispatch <id>` и `run <id>`.
   *
   * Ключ обязан быть своим у каждой ВЫДАЧИ, а не у карточки. 28.10 карточку
   * NAR-5.3 выдали второй раз («проверка ответа не прошла, выдаю заново»);
   * строка задания у обеих выдач начинается одинаково, а прежний ключ —
   * первые 90 знаков этой строки — обрезался раньше номера выдачи. Прошлое
   * сообщение с тем же ключом лежало в чате, проверка «моё сообщение уже в
   * чате» подтвердила отправку, которой не было (19:38:49: текст остался в
   * поле ввода). Поэтому в ключ идут оба номера: `dispatch` — карточка,
   * `run` — выдача; выдача у повторной отправки новая.
   */
  function sendKey(text) {
    const src = String(text || "");
    const lines = src.split("\n");
    const task = lines.find((l) => /Задача .*\(dispatch /.test(l));
    if (task) {
      const ids = task.match(/\(dispatch\s+([^,)]+)(?:,\s*run\s*([^)]*))?\)/i);
      if (ids) {
        const dispatch = String(ids[1] || "").trim();
        const run = String(ids[2] || "").trim();
        if (dispatch) return flat(`dispatch ${dispatch}${run ? `, run ${run}` : ""}`);
      }
      return flat(task).slice(0, 90);
    }
    // Напоминание отличается от задания первой строкой «1 из 2», «2 из 2».
    const reminder = lines.find((l) => /НАПОМИНАНИЕ/.test(l));
    if (reminder) return flat(reminder).slice(0, 90);
    // D-045: боевой промпт начинается строкой «Карточка «…» · dispatch … ·
    // run …», а не «Задача … (dispatch …)». Без этой ветки ключа не было, и
    // доставкой заведовали первые 60 знаков — они обрезаются внутри dispatch id
    // и не доходят до номера выдачи: повторная выдача той же карточки получала
    // тот же ключ, ровно как в случае 28.10 19:38.
    const ids = promptDispatchIds(src);
    if (ids) return flat(ids.raw);
    // Ход Координатора опознаётся по номеру хода: он свой у каждого запроса.
    const turn = src.match(/"turn_id"\s*:\s*"([^"]+)"/);
    if (turn) return flat(turn[1]);
    // Короткое сообщение (напоминание, реплика) опознаётся целиком; длинный
    // промпт без опознавательных строк — нет, иначе ключом стал бы общий
    // технический блок.
    const plain = flat(src);
    return plain.length <= 120 ? plain : "";
  }

  /**
   * Dispatch/run из текста задания — во всех формах, которые реально уходят.
   *
   * D-045: компилятор печатает «Карточка «…» · dispatch … · run …»
   * (`identity.task`), минимальный повтор и продолжение — «IDs прежние:
   * dispatch_id=…, run_id=…» (`identity.continue`), строка плана и пример
   * маркера несут свои формы. Прежний разбор знал только скобочную
   * «Задача … (dispatch …, run …)», которой в промпте выдачи нет вовсе:
   * поиск своей реплики в чате не находил ничего, и восстановление по
   * реплике (D-044) молча не работало на боевом формате.
   *
   * `raw` — дословный совпавший кусок: он годится ключом доставки, потому что
   * действительно встречается в тексте сообщения.
   */
  function promptDispatchIds(text) {
    const src = String(text || "");
    const id = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    const shapes = [
      // «… · dispatch <id> · run <id>» и «… (dispatch <id>, run <id>)».
      new RegExp(`\\bdispatch\\s+${id}\\s*[·,]\\s*run\\s+${id}`, "i"),
      // «IDs прежние: dispatch_id=<id>, run_id=<id>.»
      new RegExp(`\\bdispatch_id\\s*=\\s*${id}\\s*,\\s*run_id\\s*=\\s*${id}`, "i"),
      // Пример маркера внутри промпта: {"dispatch_id":"<id>","run_id":"<id>"…}
      new RegExp(`"dispatch_id"\\s*:\\s*"${id}"\\s*,\\s*"run_id"\\s*:\\s*"${id}"`, "i"),
    ];
    for (const shape of shapes) {
      const hit = src.match(shape);
      if (hit) return { dispatch: hit[1], run: hit[2], raw: hit[0] };
    }
    return null;
  }

  /**
   * Ход приёмки, ответа на вопрос или арбитража — законная адресация роли с
   * функцией Reviewer, а не рабочая карточка.
   *
   * Вид хода ставит `sendToRole` в ожидание (`kind`), и пока ожидание живо,
   * верить надо ему: роль могли перевести из Executor в Reviewer уже после
   * постановки в очередь, а `roleFn` в записи остался прежним. 07.11 в 22:05
   * именно так ход приёмки, у которого не было только `sentAt`, попал в
   * проверку «адресат — Reviewer» и цикл встал до Мастера.
   */
  const REVIEW_TURN_KINDS = ["review", "answer", "arbiter"];
  const isReviewTurnKind = (kind) => REVIEW_TURN_KINDS.includes(String(kind || ""));

  /** Своё сообщение в транскрипте — независимо от того, как оно обёрнуто. */
  function userMessages() {
    const found = new Set();
    for (const el of document.querySelectorAll('[data-user-message-layout="true"]')) {
      found.add(el.closest('[data-agent-transcript-message="true"]') || el);
    }
    return [...found];
  }

  /** В чате уже есть наше сообщение с этой строкой? Это и есть доставка. */
  function lastUserSays(key) {
    if (!key) return false;
    const list = userMessages();
    const last = list.at(-1);
    if (!last) return false;
    // Сообщение, которое Arena съела ошибкой, осталось в транскрипте — но
    // агенту оно не ушло. Принять его за новую отправку значило бы снова
    // поверить в доставку, которой нет (25.10, 21:24).
    const dead = GM_getValue(K.deadSend, "");
    if (dead && nodeId(last) === dead) return false;
    return flat(last.textContent || "").includes(key);
  }

  /** id «своих» реплик в транскрипте — снимок до отправки. */
  function userNodeIds() {
    return userMessages()
      .map((node) => String(node.id || "").replace("chat-message-", ""))
      .filter(Boolean);
  }

  /**
   * Своё сообщение, которого до попытки отправки не было.
   *
   * `lastUserSays` отвечает на вопрос «в чате есть реплика с этой строкой», и
   * для доставки этого мало: ключ повторной выдачи совпадает с прошлой, а
   * прошлая реплика из транскрипта никуда не девается. 28.10 в 19:38 именно
   * так и вышло — проверка нашла СТАРОЕ сообщение, вернула «отправлено» через
   * секунду после вставки, текст остался в поле ввода, и цикл ждал ответа на
   * задание, которого агент не получал.
   *
   * Поэтому доставкой считается только реплика с id, которого нет в снимке
   * `known` (снимок снимается перед кликом). Две страховки:
   *  • сообщение, которое Arena съела ошибкой (`K.deadSend`), не в счёт;
   *  • реплика с явно старым id-временем не в счёт — так выглядит старый
   *    транскрипт, который доехал уже после снимка.
   */
  function userSaysSince(key, known, since = 0) {
    if (!key) return null;
    const seen = known instanceof Set ? known : new Set(known || []);
    const dead = GM_getValue(K.deadSend, "");
    const list = userMessages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const node = list[i];
      const id = String(node.id || "").replace("chat-message-", "");
      if (!id || seen.has(id)) continue;
      if (dead && id === dead) continue;
      if (!flat(node.textContent || "").includes(key)) continue;
      // `idTime` — подсказка, а не истина: если генератор id не UUIDv7,
      // проверка просто не срабатывает. Допуск две минуты — время от вставки
      // текста до отрисовки сообщения бывает и таким.
      const at = idTime(id);
      if (since && at && at < since - 120000) continue;
      return { id, at };
    }
    return null;
  }

  /**
   * Ждём подтверждение доставки: новое своё сообщение в чате, а не «поле
   * опустело».
   *
   * Подтверждением не считаются ни выросший счётчик сообщений, ни пустое поле
   * при работающем агенте (1.4.82: 28.10, 19:08), ни реплика, лежавшая в чате
   * до попытки (1.4.84: 19:38 — повторная выдача той же карточки дала тот же
   * ключ, и старая реплика сошла за новую).
   *
   * Возвращает `{ id }` — id сообщения, которым подтверждена отправка: по нему
   * видно в журнале, что именно ушло. Пустая строка — доставка не доказана.
   */
  async function waitSent(key, known, timeoutMs, text = "", since = 0) {
    // Ожидание не должно стать бесконечным из-за пустой настройки: без числа
    // deadline был бы NaN, и опрос шёл бы вечно.
    const deadline = Date.now() + (Number(timeoutMs) || 6000);
    for (;;) {
      // Капча важнее любого признака: Arena успевает показать нашу реплику до
      // проверки, а до агента она не доходит. Признак «отправлено» в это
      // время — ложь, из-за которой 11:56:47 задание считалось ушедшим.
      if (captchaDialog()) return "";
      // Текст в поле ввода — veto: пока он там, отправки не было, какую бы
      // реплику ни нашлось в транскрипте.
      if (!composerHolds(key, text)) {
        const sent = userSaysSince(key, known, since);
        if (sent) return sent;
      }
      if (Date.now() >= deadline) return "";
      await sleep(300);
    }
  }

  /**
   * Текст задания всё ещё в поле ввода?
   *
   * Это второй признак доставки, и он нужен именно вместе с первым. 28.10 в
   * 19:08 скрипт написал «Задание отправлено (7829 символов)», а текст остался
   * в поле: клик по Send ушёл в перерисованное поле, сообщение не появилось, а
   * ожидание подтвердилось счётчиком сообщений (страница в этот момент
   * догружала транскрипт). Пока наш текст лежит в поле, отправки не было —
   * каким бы ни был счётчик.
   */
  function composerHolds(key, text) {
    const live = composer();
    if (!live) return false;
    const body = flat(composerText(live));
    if (!body) return false;
    const probe = flat(key || "").trim() || flat(text || "").slice(0, 60);
    if (!probe) return false;
    return body.includes(probe);
  }

  /**
   * Капча после «отправлено».
   *
   * 24.10 задание ушло в 13:47:03, а окно Security Verification всплыло в
   * 13:47:15 — через двенадцать секунд. К этому времени очередь уже была
   * снята, отметка доставки поставлена, и «Продолжить» после решения капчи
   * стало ждать ответа на сообщение, которого агент не получал.
   *
   * Поэтому успешная отправка подтверждается не сразу: короткий карантин, в
   * котором появление капчи отменяет её так же, как капча до клика.
   */
  async function captchaGuard() {
    const deadline = Date.now() + (Number(C.captchaGuardMs) || 8000);
    while (Date.now() < deadline) {
      if (captchaDialog()) return true;
      await sleep(400);
    }
    return Boolean(captchaDialog());
  }

  /** Enter в поле ввода: второй канал отправки, если клик не дошёл. */
  function pressEnter(editor) {
    if (!editor) return false;
    try {
      editor.focus();
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ["keydown", "keypress", "keyup"]) editor.dispatchEvent(new KeyboardEvent(type, opts));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Нажатие Send с проверкой появления своего сообщения.
   *
   * До 1.4.20 доставка подтверждалась косвенными признаками: счётчик сообщений
   * вырос, поле опустело или агент уже печатает. Каждый обманывает: счётчик
   * обновляется только после отрисовки, поле «пусто» у отвязанного узла от
   * прошлого рендера, а кнопка Stop бывает от прошлой генерации. 23.10 из-за
   * этого три клика прошли впустую: шаг встал на паузу «Send нажат, но
   * сообщение не появилось», хотя сказать, что именно не сработало, было
   * нельзя.
   *
   * Теперь подтверждение — само сообщение с отличительной строкой задания.
   * Поле и кнопка перечитываются из живого DOM перед каждой попыткой, а
   * ожидание длится `sendVerifyMs`: в фоновой вкладке браузер режет таймеры,
   * и одной секунды на отрисовку мало.
   */
  async function deliver(editor, text) {
    const before = messages().length;
    // Ключ доставки — отличительная строка задания. Если её нет (короткий
    // промпт без маркера), берём начало текста: без ключа подтвердить отправку
    // нечем, и «сообщение ушло» пришлось бы брать на веру.
    const key = sendKey(text) || flat(text).slice(0, 60);
    // Снимок «своих» реплик и время начала попытки. Доставка — это сообщение,
    // которого в снимке нет: старая реплика с тем же текстом (повторная выдача
    // той же карточки) доставкой не считается.
    const known = userNodeIds();
    const since = Date.now();
    let live = composerAlive(editor) ? editor : composer();
    dbg("Send: начало", () => ({
      messages: before,
      own: known.length,
      button: debugSendButton(live),
      textLength: composerText(live).length,
    }));

    const why = [];
    let clicked = 0;
    /**
     * Доставка доказана новым сообщением. Если поле при этом ещё держит текст,
     * второй раз не кликаем: Arena не всегда очищает поле сразу, а повторный
     * клик отправил бы то же задание дважды. Пишем об этом в журнал — пусть
     * Мастер видит, что поле осталось неубранным.
     */
    const accepted = (found) => {
      const holds = composerHolds(key, text);
      if (holds) {
        dbg("Send: новое сообщение есть, а текст ещё в поле", { id: found.id });
        log(
          `В чате появилось новое сообщение (${found.id}), но текст остался в поле ввода — повторно не отправляю, ` +
            "поле можно очистить вручную.",
          false,
          { ntfy: false, tone: "warn" },
        );
      }
      return { ok: true, via: "message", msgId: found.id, draftLeft: holds };
    };
    const blocked = () => ({
      ok: false,
      captcha: true,
      reason: "Появилась капча (Security Verification) — сообщение не ушло",
      detail: clicked ? `клик ${clicked}: вместо отправки окно проверки` : "окно проверки до клика",
    });
    if (captchaDialog()) return blocked();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Сообщение могло уйти с прошлой попытки — проверяем до нового клика.
      // Только новое сообщение: старая реплика с тем же ключом подтверждала
      // отправку, которой не было (28.10, 19:38).
      if (captchaDialog()) return blocked();
      const already = userSaysSince(key, known, since);
      if (already) {
        dbg("Send: сообщение уже в чате до клика", { id: already.id, attempt });
        return accepted(already);
      }

      // Узел редактора мог смениться при перерисовке чата: тогда и вставка,
      // и клик уходят в копию, которой уже нет в документе.
      if (!composerAlive(live)) {
        live = composer();
        if (!live) {
          // Плашка «задача выполнена» закрывает поле ввода и могла всплыть
          // между вставкой и кликом (24.10, 20:15). Убираем панели — но ждём
          // поле ВСЕГДА, даже если панелей не нашлось.
          //
          // 25.10 в 14:57 было иначе: панель на месте, кнопки закрытия в ней
          // нет, `closeCompletionPanels()` вернул 0 — и ожидание пропускалось.
          // Скрипт сдался через три секунды после вставки, хотя страница ещё
          // дорисовывала транскрипт (сообщений 0 → 15, contenteditable 0),
          // вернул карточку в Ready и встал на паузу. Работы по карточке не
          // было — виновата не отправка, а нетерпение.
          const panels = await closeCompletionPanels();
          if (panels) {
            log(`Поле ввода пропало посреди отправки: убрал панелей ${panels}.`);
            why.push(`поле ввода пропало — убрал панелей ${panels}`);
          }
          live = await waitFor(composer, C.composerGraceMs, 300);
          if (live) {
            dbg("Send: поле вернулось после перерисовки", { attempt, panels });
            writePrompt(live, text);
          }
        }
        dbg("Send: редактор перечитан", { found: Boolean(live), attempt });
        if (!live) {
          why.push("поле ввода пропало");
          break;
        }
      }

      // Ждём столько, сколько рисуется страница: кнопка Send появляется
      // активной только после того, как редактор зарегистрировал ввод.
      // Два коротких ожидания (1,5 и 3 с) кончались раньше, чем Arena
      // успевала смонтировать транскрипт.
      let btn = await waitSendReady(live, text);
      if (!btn) {
        why.push(
          `активной кнопки Send нет за ${Math.round((Number(C.sendReadyMs) || 20000) / 1000)} с (${composerDiagnostics()})`,
        );
        break;
      }

      // Текст мог пропасть вместе с перерисованным полем: тогда клик по Send
      // ничего не отправит. Проверяем перед каждым кликом.
      const probe = key || flat(text).slice(0, 40);
      if (probe && !flat(composerText(live)).includes(probe)) {
        dbg("Send: текст в поле пропал — вставляю заново", { attempt });
        if (!writePrompt(live, text)) {
          why.push("текст не удержался в поле ввода");
          break;
        }
        await sleep(300);
        const again = sendButton(live);
        if (!again) {
          why.push("после повторной вставки кнопки Send нет");
          break;
        }
        btn = again;
      }

      // Человек не отправляет через миллисекунду после ввода: даём паузу.
      await sleep(500 + Math.floor(Math.random() * 1200));
      const meanwhile = userSaysSince(key, known, since);
      if (meanwhile) {
        dbg("Send: сообщение появилось до клика", { id: meanwhile.id, attempt });
        return accepted(meanwhile);
      }
      if (!composerAlive(live)) {
        why.push(`клик ${attempt}: поле перерисовано`);
        continue;
      }
      // Кнопка пересчитывается в последний момент: за паузу DOM мог смениться.
      const latest = sendButton(live);
      if (!latest) {
        why.push(`клик ${attempt}: кнопка Send пропала`);
        break;
      }
      btn = latest;
      if (captchaDialog()) return blocked();
      dbg(`Send: клик ${attempt}`, () => debugSendButton(live));
      btn.click();
      clicked += 1;

      let via = await waitSent(key, known, C.sendVerifyMs, text, since);
      if (!via && attempt === 3) {
        // Последняя попытка: если клик не дошёл, отправляем с клавиатуры.
        dbg("Send: клик не дал сообщения — пробую Enter");
        pressEnter(live);
        via = await waitSent(key, known, C.sendVerifyMs, text, since);
      }
      if (via) {
        // Клик прошёл, но поверх чата висит проверка: сообщение могло не
        // дойти, даже если отрисовалось. Считаем отправку неудачной — ход
        // повторится после того, как человек решит капчу.
        if (captchaDialog()) return blocked();
        // Проверка не разовая: окно проверки всплывает через несколько секунд.
        if (await captchaGuard()) return blocked();
        // Последняя проверка перед словом «отправлено»: текст задания не
        // должен остаться в поле ввода. 19:08 он там остался, а журнал сказал,
        // что задание ушло (7829 символов) — и цикл ждал ответа впустую.
        //
        // Но новое сообщение — сильнее поля: если в чате появилась реплика,
        // которой до попытки не было, отправка состоялась, а текст в поле —
        // черновик, который Arena не убрала. Повторный клик отправил бы то же
        // задание второй раз, поэтому здесь мысль не «нажмём ещё», а «скажем
        // об этом в журнале».
        if (composerHolds(key, text)) {
          const fresh = userSaysSince(key, known, since);
          if (fresh && fresh.id === via.id) return accepted(fresh);
          why.push(`клик ${attempt}: текст остался в поле ввода`);
          dbg("Send: текст в поле после клика — отправки не было", { attempt });
          await sleep(500);
          continue;
        }
        dbg("Send: сообщение в чате", { via, attempt });
        return { ok: true, via: "message", msgId: via.id || "" };
      }
      if (captchaDialog()) return blocked();

      // Не дошло. Карточка могла появиться между вставкой и кликом — убираем
      // её один раз и повторяем; гоняться за ней циклом смысла нет.
      const plaque = closeCompletionPlaque();
      dbg("Send: сообщение не появилось", { plaque, attempt });
      why.push(plaque === "none" ? `клик ${attempt} без следа` : `клик ${attempt}: закрыл плашку`);
      await sleep(500);
    }

    // Капча могла появиться уже после кликов — в ожидании доставки. Тогда
    // причина отказа именно она, а не «кнопка не нашлась»: от неё зависит,
    // снимать ли очередь (её не снимаем — ждём человека).
    if (captchaDialog()) return blocked();

    const now = composer();
    const button = now ? sendButton(now) : null;
    const dialog = openDialog();
    dbg("Send: кандидаты у поля", () => ({ dialog: Boolean(dialog), candidates: sendDiagnostics(now) }));
    const detail = [
      `поле ${now ? (composerAlive(now) ? "в документе" : "отвязано") : "не найдено"}`,
      `в поле ${now ? composerText(now).length : "—"} симв.`,
      `кнопка ${button ? `«${String(labelText(button)[0] || "").slice(0, 28)}»` : "не найдена"}`,
      `сообщений ${before} → ${messages().length}`,
      `своих ${userMessages().length}`,
      `панелей ${completionPanels().length}`,
      ...(dialog ? ["поверх чата открыт диалог Arena"] : []),
      ...why,
    ].join(", ");
    const report = domReport();
    GM_setValue("cfn-send-debug", { at: Date.now(), detail, key, text: String(text).slice(0, 300), report });
    console.warn("[Relay] снимок разметки при отказе отправки:", report);
    return {
      ok: false,
      // Ни одного клика и поля ввода нет — это не отказ доставки, а
      // недорисованная страница. Задание осталось в очереди, ход не начат:
      // откат карточки и пауза тут дороже, чем ещё один тик ожидания.
      // Клика не было вовсе — сообщение никуда не ушло, и виновата не
      // доставка, а недорисованная страница: поле есть, кнопка ещё `disabled`,
      // транскрипт монтируется. Задание остаётся в очереди до `sendRetries`.
      retry: clicked === 0,
      // Без единого клика причина другая: кнопка не нашлась, а не «нажали
      // и ничего не вышло». Смешивать их нельзя — по причине чинят.
      reason: clicked
        ? "Send нажат, но своё сообщение в чате не появилось"
        : "Кнопка Send неактивна или не найдена — редактор не принял текст",
      detail,
    };
  }

  /** Короткий хеш текста: нужен, чтобы не отправить одно и то же дважды. */
  function textHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h);
  }

  async function sendToRole(role, input, kind, ref, extra = {}) {
    // Адаптеры передают envelope компилятора; null означает, что компиляция
    // не прошла и пауза уже поставлена — в Arena ничего не уходит.
    if (input == null) return false;
    const envelope = typeof input === "object" && input && typeof input.text === "string" ? input : null;
    const text = envelope ? envelope.text : String(input);
    if (!text.trim()) return false;
    if (typeof projectRoleAllowed === "function" && !projectRoleAllowed(role)) return false;
    // Ранее выданную Reviewer карточку можно завершить и напомнить о маркере,
    // но новой рабочей выдачи через общий транспорт быть не должно.
    if (kind === "dispatch" && (role.fn === "Reviewer" || norm(role.name) === norm("Warden"))) {
      const previous = GM_getValue(K.expect, null);
      const reminder = extra.isDispatchReminder === true && previous?.kind === "dispatch" &&
        Number(previous.sentAt) > 0 && previous.verified === true && norm(previous.roleId) === norm(role.id) &&
        norm(previous.ref) === norm(ref) && previous.runId && norm(previous.runId) === norm(extra.runId);
      if (!reminder) {
        log(`«${role.name}» — Reviewer: обычные карточки ему не выдаются; приёмка и вопросы идут отдельно.`, true, { ntfy: "quiet" });
        return false;
      }
    }
    const force = extra.force === true;
    const payload = { ...extra };
    delete payload.force;

    // Двойная обработка одного ответа (нажали «Шаг» дважды, сработал
    // автоцикл) отправляла агенту второй такой же текст. Агент отвечал на
    // него ещё раз, и чат превращался в переписку с самим собой.
    const last = GM_getValue(K.lastSend, null);
    if (!force && last && norm(last.roleId) === norm(role.id) && last.hash === textHash(text)) {
      const ageSec = Math.round((Date.now() - Number(last.at || 0)) / 1000);
      if (ageSec < 300) {
        log(
          `Такое же сообщение уже уходило «${role.name}» ${ageSec} с назад — не дублирую, жду ответа.`,
          true,
        );
        return false;
      }
    }
    GM_setValue(K.lastSend, { roleId: role.id, hash: textHash(text), at: Date.now() });

    // Снимок цели выдачи: репозиторий сессии роли, целевой репозиторий работы
    // или проверки и его базовая ветка. По умолчанию цель — репозиторий сессии
    // роли (Executor работает в своём, аудитор может проверять чужой через
    // extra.targetRepo/extra.targetBranch; полный URL PR тоже называет репозиторий).
    const sessionRepo = profileSessionRepo(role.id);
    const targetRepo = (payload && payload.targetRepo) || sessionRepo || C.repo;
    const targetBranch = (payload && payload.targetBranch) || profileRepoBranch(targetRepo);

    // D-045: ожидание пишется ДО очереди. Записи GM уходят в хранилище
    // асинхронно, и навигация обрезает хвост пачки. При прежнем порядке
    // выживала очередь без ожидания — она отправляла задание и оставляла
    // цикл без хозяина хода. Теперь усечение теряет очередь, а ожидание
    // остаётся: такой ход разбирается штатной уборкой фантомов.
    // Снимок «план уже с замечаниями» переживает напоминание: иначе повтор
    // промпта по тому же плану теряет признак, и следующий шаг снова смотрит
    // на время правки карточки — ровно то, из-за чего 06.11 ушёл второй план.
    // D-053: дело арбитража переживает напоминание и продолжение — арбитр
    // должен видеть те же факты, что и в первом промпте, а не пустую карточку.
    const arbiterCarry = kind === "arbiter" && extra.arbiter ? { arbiter: extra.arbiter } : {};
    const previousPlan = GM_getValue(K.expect, null);
    const planCarry = kind === "plan" && previousPlan && previousPlan.kind === "plan" &&
      norm(previousPlan.ref) === norm(ref) && "planBeforeReturn" in previousPlan
      ? { planBeforeReturn: previousPlan.planBeforeReturn }
      : {};
    GM_setValue(K.expect, {
      roleId: role.id,
      roleName: role.name,
      roleUrl: role.url,
      roleFn: role.fn || "",
      kind,
      ref,
      watermark: lastMessageId(),
      // Снимок id на момент выдачи: водяной знак может исчезнуть из разметки
      // при перерисовке транскрипта, а «после отправки» должно остаться верным.
      seen: messages().map(nodeId).slice(-40),
      at: Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      // Текст нужен, чтобы повторить отправку, если клик по Send не дошёл.
      text,
      prompt: envelope || null,
      ...arbiterCarry,
      ...planCarry,
      ...payload,
      sessionRepo,
      targetRepo,
      targetBranch,
    });
    if (envelope) {
      recordPromptAttempt(envelope, { kind, ref, role: role.name, attempt: payload.attempt || 1, outcome: "queued" });
    }
    // Очередь несёт опознавательные данные хода: если запись ожидания всё же
    // потеряется, оно восстанавливается по ним со сверкой Notion, а не
    // угадывается по тексту письма.
    GM_setValue(K.pending, {
      roleId: role.id,
      roleName: role.name,
      roleUrl: role.url,
      roleFn: role.fn || "",
      kind,
      ref,
      runId: payload.runId || "",
      missionId: payload.missionId || "",
      turnId: payload.turnId || "",
      questionId: payload.questionId || "",
      logId: payload.logId || "",
      title: payload.title || "",
      url: payload.url || "",
      sessionRepo,
      targetRepo,
      targetBranch,
      text,
      at: Date.now(),
    });
    dbg("sendToRole: задание в очереди", { role: role.name, kind, ref, длина: text.length });
    GM_setValue("cfn-me", role.name);
    setStatus();

    // Если адресат — текущая страница, перезагружать её незачем: чат уже
    // открыт, и задание уйдёт со следующего тика (человек видит, что кнопка
    // сработала, без мигания страницы).
    let same = false;
    try {
      same = new URL(role.url, location.href).pathname === location.pathname;
    } catch {
      same = false;
    }
    if (same) {
      log(`«${role.name}» уже открыт — отправляю задание здесь.`);
      setTimeout(() => tick(false), 400);
    } else {
      log(`Перехожу к «${role.name}», чтобы отправить задание.`);
      // Уход со страницы — только после подтверждения записи (D-045).
      await flushBeforeNavigate(handoffKeys());
      location.assign(role.url);
    }
    return true;
  }

  /** Перейти на страницу роли без задания: используется для возврата хода. */
  async function goTo(role) {
    GM_setValue(K.pending, null);
    GM_setValue("cfn-me", role.name);
    setStatus();
    await navigateTo(role, "туда возвращается ход");
  }

  // Одно и то же ожидание не должно заливать журнал каждые пару секунд.
  let pendingNoticeAt = 0;
  // Отказы вставки считаются подряд: плашка или поздняя отрисовка проходят
  // следующим тиком через 15 секунд, и будить Мастера из-за них незачем.
  let insertFail = { at: 0, count: 0 };
  const pendingSay = (pending, text, error = false) => {
    if (pendingNoticeAt === pending.at) return;
    pendingNoticeAt = pending.at;
    log(text, error);
  };

  /**
   * D-044: квитанция подтверждённой доставки живёт отдельно от `expect`.
   *
   * K-30 (05.11, 23:28–23:35): журнал зафиксировал «Задание отправлено»
   * с id сообщения, агент закончил ход и прислал маркер этой выдачи, но
   * позднее `expect.sentAt` оказался пуст — и уборка фантомов вернула
   * карточку в Ready со словами «работы не было». Отсутствие локальной
   * отметки не доказывает отсутствие доставки: запись ожидания могла быть
   * перезаписана/потеряна после подтверждения. Поэтому факт «сообщение
   * найдено в чате» сохраняется отдельной квитанцией до снятия очереди.
   */
  const DELIVERY_RECEIPT_KEY = "cfn-delivery-receipts-v1";
  function handoffReceiptKey(expect) {
    return [
      expect?.kind || "", norm(expect?.ref), norm(expect?.runId),
      norm(expect?.turnId), norm(expect?.questionId), norm(expect?.roleId),
    ].join("|");
  }
  function recordDeliveryReceipt(expect, delivery) {
    if (!expect || !delivery?.messageId) return;
    const key = handoffReceiptKey(expect);
    const prior = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    const list = Array.isArray(prior) ? prior.filter((item) => item && item.key !== key) : [];
    list.push({
      key,
      kind: expect.kind || "", ref: expect.ref || "", runId: expect.runId || "",
      turnId: expect.turnId || "", questionId: expect.questionId || "",
      roleId: expect.roleId || "", messageId: delivery.messageId,
      sentAt: Number(delivery.sentAt) || Date.now(),
      watermark: delivery.watermark || delivery.messageId,
      seen: Array.isArray(delivery.seen) ? delivery.seen.slice(-40) : [],
    });
    GM_setValue(DELIVERY_RECEIPT_KEY, list.slice(-100));
  }
  function deliveryReceipt(expect) {
    if (!expect) return null;
    const key = handoffReceiptKey(expect);
    const list = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    const hit = (Array.isArray(list) ? list : []).find((item) =>
      item && item.key === key && item.messageId && Number(item.sentAt) > 0 &&
      (!expect.roleId || norm(item.roleId) === norm(expect.roleId)));
    return hit || null;
  }
  /** Намеренный отказ доставки (капча/ошибка Arena/повтор) гасит квитанцию. */
  function forgetDeliveryReceipt(expect) {
    if (!expect) return;
    const key = handoffReceiptKey(expect);
    const prior = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    if (!Array.isArray(prior) || !prior.some((item) => item && item.key === key)) return;
    GM_setValue(DELIVERY_RECEIPT_KEY, prior.filter((item) => item && item.key !== key));
  }

  /** Своя реплика именно этой выдачи в открытом чате адресата. */
  function dispatchPromptInChat(expect) {
    if (!expect || expect.kind !== "dispatch" || !isUuid(expect.ref) || !isUuid(expect.runId) ||
        !expect.roleId || norm(roleFromPath()) !== norm(expect.roleId)) return null;
    // Капча/ошибка Arena могли оставить реплику в транскрипте, но ход не принять.
    // Такая реплика не доказывает доставку; квитанция к этому моменту погашена.
    if (expect.captcha === true || GM_getValue(K.pending, null)?.captcha === true) return null;
    const dead = GM_getValue(K.deadSend, "");
    const nodes = userMessages();
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const raw = messageRaw(nodes[i]);
      // D-045: разбор общий с ключом доставки. Скобочная форма «Задача …
      // (dispatch …, run …)» в промпте выдачи не встречается вовсе — прежний
      // regexp не находил ни одной боевой реплики, и восстановление по чату
      // было мертво именно там, где оно нужнее всего.
      const ids = promptDispatchIds(raw);
      if (!ids || norm(ids.dispatch) !== norm(expect.ref) || norm(ids.run) !== norm(expect.runId)) continue;
      const id = nodeId(nodes[i]);
      if (!id || (dead && id === dead)) continue;
      return { id, at: idTime(id) };
    }
    return null;
  }

  /**
   * Своя реплика хода приёмки в чате адресата.
   *
   * Приёмка миссии, ответ на вопрос и арбитраж не несут `dispatch_id`/`run_id` —
   * у них свой номер хода (`turn_id`), и именно он напечатан в тексте задания.
   * Без этой проверки `restoreMissingSendMark` умел доказывать доставку только
   * рабочей карточки: у хода приёмки доказательство не находилось никогда, и
   * `dropGhostHandoff` снимал живой ход как фантом. 07.11 в 22:05 цикл из-за
   * этого открыл страницу Warden и встал на «Очередь адресована Reviewer».
   */
  function reviewTurnInChat(expect) {
    const turnId = String(expect?.turnId || "");
    if (!isReviewTurnKind(expect?.kind) || !isUuid(turnId)) return null;
    if (!expect.roleId || norm(roleFromPath()) !== norm(expect.roleId)) return null;
    if (expect.captcha === true || GM_getValue(K.pending, null)?.captcha === true) return null;
    const dead = GM_getValue(K.deadSend, "");
    const nodes = userMessages();
    // Номер хода печатается двояко: строкой задания `turn_id: <id>` и внутри
    // примера маркера `"turn_id":"<id>"`. Оба вида — одна и та же выдача.
    const shape = new RegExp(`turn_id"?\\s*[:=]\\s*"?${turnId}\\b`, "i");
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (!shape.test(messageRaw(nodes[i]))) continue;
      const id = nodeId(nodes[i]);
      if (!id || (dead && id === dead)) continue;
      return { id, at: idTime(id) };
    }
    return null;
  }

  /**
   * Восстановить отметку отправки по квитанции или по самой реплике в чате.
   * Возвращает восстановленное ожидание либо null, если доказательств нет.
   */
  function restoreMissingSendMark(expect) {
    if (!expect || Number(expect.sentAt)) return expect || null;
    const receipt = deliveryReceipt(expect);
    const proof = receipt
      ? { messageId: receipt.messageId, sentAt: Number(receipt.sentAt), watermark: receipt.watermark, seen: receipt.seen, source: "квитанция доставки" }
      : (() => {
          const node = dispatchPromptInChat(expect) || reviewTurnInChat(expect);
          if (!node) return null;
          return {
            messageId: node.id, sentAt: node.at || Number(expect.at) || Date.now(),
            watermark: node.id, seen: expect.seen || [], source: "реплика задания в чате",
          };
        })();
    if (!proof) return null;
    const restored = {
      ...expect,
      sentAt: proof.sentAt,
      verified: true,
      watermark: proof.watermark || proof.messageId,
      seen: Array.isArray(proof.seen) ? proof.seen : (expect.seen || []),
      ...(expect.kind === "dispatch" && !expect.isDispatchReminder && !(Number(expect.tries) > 0)
        ? { dispatchSentAt: Number(expect.dispatchSentAt) || proof.sentAt }
        : {}),
    };
    GM_setValue(K.expect, restored);
    log(
      `Отметка отправки «${expect.title || expect.ref || expect.kind}» восстановлена: ${proof.source} ` +
        `(сообщение ${proof.messageId}). Карточку в Ready не возвращаю; читаю ответ этой выдачи.`,
      false,
      { ntfy: "quiet", title: "Relay: доставка восстановлена" },
    );
    return restored;
  }

  /**
   * Ожидание без отметки отправки — след прошлой попытки, а не ход.
   *
   * 24.10 в 16:35 карточка NAR-1.12 ушла в Running, а страница Arena упала до
   * отправки: сообщение в чат Kernel не попало. Через 34 минуты очередь
   * снялась, но карточку скрипт не тронул — он стоял не на странице адресата,
   * а откат статуса был привязан к ней. В Running карточка ждала ещё 11 минут
   * до `releaseStalled`, и всё это время Координатор видел «1 Running» и
   * выдавать её не мог.
   *
   * D-044: прежде чем объявить ход фантомом, ищем квитанцию доставки и саму
   * реплику этой выдачи в чате. Если доказательство есть — восстанавливаем
   * ожидание и не трогаем карточку. Настоящий фантом (нет ни квитанции, ни
   * реплики) по-прежнему возвращается в Ready.
   *
   * `ignoreQueue` — очередь уже признана просроченной и снимается этим же
   * шагом: тогда она не повод оставить карточку в Running.
   *
   * Возвращает `{ expect, rolled }`, если след был снят, иначе `null`.
   */
  async function dropGhostHandoff(why, { ignoreQueue = false } = {}) {
    const expect = GM_getValue(K.expect, null);
    if (!expect || Number(expect.sentAt)) return null;
    if (!ignoreQueue && GM_getValue(K.pending, null)) return null;
    if (restoreMissingSendMark(expect)) return null;
    const rolled = await releaseUndelivered(expect, why);
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    return { expect, rolled };
  }

  /** Уведомление и время относятся только к той очереди, что совпала с ходом. */
  function isDispatchAssignment(expect, pending, me) {
    return Boolean(expect && pending && expect.kind === "dispatch" && expect.ref && expect.runId &&
      !expect.isDispatchReminder && !(Number(expect.tries) > 0) && norm(expect.roleId) === norm(me) &&
      typeof expect.text === "string" && expect.text === pending.text);
  }

  /** Тихая веха только для подтверждённой доставки текущего хода карточки. */
  function dispatchDeliveryNtfy(expect, pending, me) {
    if (!isDispatchAssignment(expect, pending, me)) return { ntfy: false };
    return {
      ntfy: "quiet",
      title: "Relay: задание отправлено",
      ntfyText: `«${expect.title || expect.ref}» — задание отправлено в чат «${expect.roleName || "исполнителя"}».`,
      ntfyKey: `dispatch-sent:${expect.ref}:${expect.runId}`,
    };
  }

  /**
   * Очередь без ожидания — потерянный ход, а не новое задание.
   *
   * D-045 (06.11.2026): на K-27 запись `K.expect` не дожила до перехода на
   * страницу Executor Core, а `K.pending` дожил. Очередь отправила задание,
   * подтвердила его в чате — и обнаружила, что хозяина хода нет: пауза
   * `delivery-state-lost` при уже готовом ответе агента. Отправлять в таком
   * состоянии вслепую нельзя: это второй экземпляр той же работы.
   *
   * Порядок разбора: опознавательные данные очереди → карточка в Notion →
   * квитанция доставки или сама реплика в чате. Карточка совпала и сообщение
   * уже в чате — снимаем очередь и читаем ответ, ничего не отправляя. Карточка
   * совпала, а сообщения нет — восстанавливаем ожидание и отправляем ровно один
   * раз обычным путём. Не совпала или Notion недоступен — пауза без отправки.
   *
   * Разбираем только рабочие выдачи: план, приёмка и вопросы идут своим
   * порядком и в сверке по карточке не нуждаются.
   *
   * Возвращает true, если ход разобран здесь; false — можно продолжать.
   */
  /**
   * Очередь хода приёмки без ожидания — восстанавливается по номеру хода.
   *
   * D-045 научил сверять с карточкой рабочую выдачу, но приёмка миссии, ответ
   * на вопрос и арбитраж карточки не имеют: их опознавательный знак — `turn_id`,
   * который напечатан в самом задании. Без этой ветки потерянное ожидание
   * такого хода уходило в общую паузу «очередь без ожидания» с советом сверять
   * Run ID, которого не существует (07.11, 22:05).
   *
   * Порядок тот же, что у карточки: опознавательные данные очереди → страница
   * адресата → доказательство доставки по `turn_id` в чате. Доказано — очередь
   * снимаем и читаем ответ, ничего не отправляя. Не доказано — восстанавливаем
   * ожидание и отправляем ровно один раз обычным путём. Номер не читается —
   * пауза: угадывать здесь значит отправить ход второй раз.
   *
   * Возвращает true, если ход разобран здесь; false — можно продолжать.
   */
  /**
   * Адрес адресата очереди — для перехода на его страницу.
   *
   * Сверить чат можно только в чате: и подтверждение доставки, и сам ответ
   * живут на странице агента. Раньше переход брали из `roles()`, но она
   * отдаёт лишь активные роли, а очередь живёт дольше смены статуса; поэтому
   * берём строку базы по id, а кеш ролей — запасной путь. Пусто — адреса нет,
   * и тогда нужна пауза, а не тик, который повторяет «сейчас открою».
   */
  async function roleAddress(pending) {
    const id = String(pending?.roleId || "");
    if (!id) return null;
    const fromRow = (row) => (row && row.url
      ? { id: row.id, name: row.name || pending.roleName || "", url: row.url, fn: row.fn || pending.roleFn || "", status: row.status || "Активна" }
      : null);
    try {
      const rows = await roleRows().catch(() => []);
      const found = fromRow(rows.find((row) => row.id && norm(row.id) === norm(id)));
      if (found) return found;
    } catch {
      /* ниже пробуем кеш */
    }
    try {
      const active = await roles().catch(() => []);
      const found = fromRow(active.find((row) => row.id && norm(row.id) === norm(id)));
      if (found) return found;
    } catch {
      /* адреса нет */
    }
    const stored = pending.roleUrl
      ? { id, name: pending.roleName || "", url: pending.roleUrl, fn: pending.roleFn || "", status: "Активна" }
      : null;
    return stored;
  }

  async function adoptOrphanReview(pending, me) {
    if (GM_getValue(K.expect, null)) return false;
    const kind = String(pending.kind || "");
    if (!isReviewTurnKind(kind)) return false;
    const turnId = String(pending.turnId || "");
    const ref = String(pending.ref || "");
    if (!isUuid(turnId) || !isUuid(ref) || !pending.roleId) {
      pause(
        "В очереди остался ход приёмки без ожидания, и номер хода из него не читается. " +
          "Не отправляю и ничего не меняю: сверьте чат адресата и номер хода, затем продолжите вручную.",
        { kind: "orphan-review", ref, runId: "" },
      );
      return true;
    }
    // Сверять чат можно только на странице адресата — и открыть её обязан этот
    // же проход.
    //
    // 08.11, 17:45. Вопрос Координатора ушёл приёмке, ожидание хода не
    // записалось, в очереди остался `kind: answer`. Ветка говорила «открываю
    // страницу адресата» и возвращала true — а открывать было некому: строка
    // только писалась в журнал, цикл оставался на странице Координатора и на
    // каждом тике повторял тот же текст. Перехода не было ни разу, работа
    // встала на пять часов.
    if (!me || norm(me) !== norm(pending.roleId)) {
      const who = await roleAddress(pending);
      if (who) {
        pendingSay(pending, `Ход приёмки остался без ожидания: открываю «${who.name}», чтобы сверить чат по номеру хода.`);
        return navigateTo(who, "там ждёт ход приёмки без ожидания");
      }
      pause(
        `В очереди остался ход приёмки без ожидания, но адрес адресата «${pending.roleName || pending.roleId || "?"}» ` +
          "не читается из базы «Роли». Открыть чат для сверки не по чему: задание не отправляю и ничего не меняю. " +
          "Проверьте «Agent URL» этой роли и нажмите «Продолжить».",
        { kind: "orphan-review", ref, runId: "" },
      );
      return true;
    }
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Ход приёмки остался без ожидания; страница ещё грузится (${shell.why}) — сверю чат, когда она откроется.`);
      return true;
    }
    const restored = {
      roleId: pending.roleId,
      roleName: pending.roleName || "",
      roleUrl: pending.roleUrl || "",
      roleFn: pending.roleFn || "",
      kind,
      ref,
      runId: "",
      missionId: String(pending.missionId || ""),
      turnId,
      questionId: String(pending.questionId || ""),
      logId: String(pending.logId || ""),
      title: pending.title || "",
      url: pending.url || "",
      watermark: "",
      seen: [],
      at: Number(pending.at) || Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      text: pending.text,
      prompt: null,
      adoptedFromQueue: true,
    };
    if (restoreMissingSendMark(restored)) {
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      log(
        `Ход приёмки «${restored.title || ref}» восстановлен из очереди: доставка доказана номером хода. ` +
          "Отправку не повторяю — читаю ответ.",
        true,
        { ntfy: "quiet", title: "Relay: ход восстановлен" },
      );
      return true;
    }
    GM_setValue(K.expect, restored);
    log(
      `Ход приёмки «${restored.title || ref}» остался без ожидания, а сообщения в чате нет: ` +
        "ожидание восстановлено по очереди, отправляю его один раз обычным путём.",
      true,
      { ntfy: "quiet", title: "Relay: ход восстановлен" },
    );
    return false;
  }

  async function adoptOrphanDispatch(pending, me) {
    if (GM_getValue(K.expect, null)) return false;
    const text = String(pending.text || "");
    const isWork = pending.kind === "dispatch" || (/CF_AGENT_RESULT/.test(text) && /dispatch_id/.test(text));
    if (!isWork) return false;
    const ids = promptDispatchIds(text);
    const ref = String(pending.ref || ids?.dispatch || "");
    const runId = String(pending.runId || ids?.run || "");
    // Текст и поля очереди обязаны называть одну и ту же выдачу: расхождение
    // означает, что очередь собрана из разных попыток, и верить ей нельзя.
    if (!isUuid(ref) || !isUuid(runId) ||
        (ids && (norm(ids.dispatch) !== norm(ref) || norm(ids.run) !== norm(runId)))) {
      pause(
        "В очереди осталось задание без ожидания, и номер выдачи из него не читается. " +
          "Не отправляю и ничего не меняю: сверьте чат адресата, карточку и Run ID, затем продолжите вручную.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    let page;
    try {
      page = await notion("GET", `pages/${ref}`);
    } catch (e) {
      pause(
        `Не удалось прочитать карточку потерянного хода (${e.message}). Задание осталось в очереди, ` +
          "отправку не повторяю: без сверки это был бы дубль.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    const cardRun = rt(page.properties?.["Run ID"]);
    const owner = rt(page.properties?.["Recipient Agent ID"]);
    const cardMission = rt(page.properties?.["Mission ID"]).trim();
    const missionId = String(pending.missionId || cardMission).trim();
    const mismatch =
      taskState(page) !== "Running" ? `карточка в состоянии «${taskState(page) || "без состояния"}», а не Running`
        : !cardRun || norm(cardRun) !== norm(runId) ? "Run ID карточки не совпадает с очередью"
          : owner && norm(owner) !== norm(pending.roleId) ? "карточка выдана другому агенту"
            : !isUuid(cardMission) || !isUuid(missionId) ? "у хода нет корректного Mission ID"
              : norm(cardMission) !== norm(missionId) ? "Mission ID карточки не совпадает с очередью"
                : "";
    if (mismatch) {
      pause(
        `Задание без ожидания не сходится с карточкой: ${mismatch}. Очередь и карточку сохраняю, ` +
          "отправку не повторяю — нужна проверка Мастером.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    const restored = {
      roleId: pending.roleId,
      roleName: pending.roleName || "",
      roleUrl: pending.roleUrl || "",
      roleFn: pending.roleFn || "",
      kind: "dispatch",
      ref,
      runId,
      missionId,
      logId: String(pending.logId || rt(page.properties?.["Output Drive File ID"])),
      title: pending.title || taskTitle(page),
      url: pending.url || page.url || "",
      sessionRepo: pending.sessionRepo || "",
      targetRepo: pending.targetRepo || "",
      targetBranch: pending.targetBranch || "",
      watermark: "",
      seen: [],
      at: Number(pending.at) || Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      text: pending.text,
      prompt: null,
      // Отметка нужна журналу: ход собран из очереди, а не выдан заново.
      adoptedFromQueue: true,
    };
    // Квитанция доставки проверяется с любой страницы; реплика в чате — только
    // на странице адресата. Порядок важен: доказанную выдачу нельзя потерять
    // из-за того, что вкладка стоит не там.
    if (restoreMissingSendMark(restored)) {
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      log(
        `Ход «${restored.title || ref}» восстановлен из очереди: доставка этой выдачи доказана. ` +
          "Отправку не повторяю — читаю ответ.",
        true,
        { ntfy: "quiet", title: "Relay: ход восстановлен" },
      );
      return true;
    }
    // Без доказательства судить по чату можно только со страницы адресата.
    // Очередь сохраняем, а страницу открываем здесь же: обещание «цикл сам
    // откроет» без самого перехода — это тик, который навсегда повторяет одну
    // и ту же строку (08.11, ход приёмки: пять часов на одном месте).
    if (!me || norm(me) !== norm(pending.roleId)) {
      const who = await roleAddress(pending);
      if (who) {
        pendingSay(pending, `Ход «${restored.title || ref}» потерял ожидание: открываю «${who.name}», чтобы сверить чат. Задание пока не отправляю.`);
        return navigateTo(who, "там ждёт ход без ожидания");
      }
      pause(
        `Ход «${restored.title || ref}» потерял ожидание, но адрес адресата ` +
          `«${pending.roleName || pending.roleId || "?"}» не читается из базы «Роли». ` +
          "Сверить чат не по чему: задание не отправляю, очередь и карточку сохраняю. " +
          "Проверьте «Agent URL» этой роли и нажмите «Продолжить».",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    // Пустой транскрипт недорисованной страницы не доказывает, что реплики нет:
    // вывод «отправляю» делается только на отрисованной странице.
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Ход «${restored.title || ref}» потерял ожидание; страница ещё грузится (${shell.why}) — сверю чат, когда она откроется.`);
      return true;
    }
    GM_setValue(K.expect, restored);
    // Карточка только что сверена: это новая попытка отправки того же хода,
    // а не залежавшийся остаток. Иначе разбор просрочки снял бы очередь сразу.
    GM_setValue(K.pending, { ...pending, at: Date.now() });
    log(
      `Ожидание хода «${restored.title || ref}» было потеряно, но карточка Running и сообщения в чате нет. ` +
        "Восстановил ожидание по карточке; отправляю задание один раз, без нового хода Координатора.",
      true,
      { ntfy: "quiet", title: "Relay: ход восстановлен" },
    );
    return false;
  }

  /**
   * Досылает задание, сохранённое перед переходом на страницу адресата.
   *
   * Возвращает true, если ход этим и занят: отправлено, ждём редактор или ждём
   * конца ответа агента. Молчаливых выходов нет — каждый пишет в журнал,
   * иначе нажатый «Шаг» выглядит как неработающая кнопка.
   */
  async function consumePending(manual = false) {
    let pending = GM_getValue(K.pending, null);
    if (!pending) return false;
    const me = roleFromPath();
    const waitingForPolicy = GM_getValue(K.expect, null);
    // Очередь могла остаться от старого скрипта. Нельзя угадывать, не дошла ли
    // она до чата: не отправляем и не откатываем карточку/Run ID вслепую.
    // Напоминание к уже доставленной карточке — не новая выдача.
    const oldReminder = waitingForPolicy?.kind === "dispatch" && (
      waitingForPolicy.isDispatchReminder || (Number(waitingForPolicy.tries) > 0 &&
        Number(waitingForPolicy.dispatchSentAt) > 0 && waitingForPolicy.text === pending.text));
    const workPending = waitingForPolicy?.kind === "dispatch" && !oldReminder;
    const orphanPending = !waitingForPolicy;
    const orphanWork = orphanPending && /CF_AGENT_RESULT/.test(String(pending.text || "")) &&
      /dispatch_id/.test(String(pending.text || ""));
    // Рабочая карточка адресована роли с функцией Reviewer — отправку не
    // повторяем и карточку не трогаем. Это ровно про карточку: приёмка,
    // ответ на вопрос и арбитраж приходят тому же адресату по закону, и
    // путать их с рабочей выдачей нельзя (07.11, 22:05).
    // Вид хода известен из живого ожидания; если ожидание уже снято, остаётся
    // маркер, который ход просит вернуть. Нераспознанная очередь сохраняет
    // прежнее осторожное поведение — её не отправляем.
    const queueText = String(pending.text || "");
    const reviewQueue = isReviewTurnKind(waitingForPolicy?.kind) ||
      (!waitingForPolicy && /\bCF_(REVIEW|ANSWER|ARBITER)_RESULT\b/.test(queueText));
    if (workPending && (waitingForPolicy.roleFn === "Reviewer" ||
        norm(waitingForPolicy.roleName) === norm("Warden"))) {
      pause("В очереди осталась рабочая карточка Reviewer от прежней версии. Не отправляю её и не меняю карточку, очередь или ожидание: проверьте чат и Run ID.",
        { kind: "reviewer-task-pending", ref: waitingForPolicy.ref || "", runId: waitingForPolicy.runId || "" });
      return true;
    }
    if (workPending || orphanPending) {
      // Старые очереди без roleFn, псевдонимы с тем же URL и роли, изменившиеся
      // после постановки в очередь. На границе отправки нельзя верить кешу.
      if (workPending && norm(waitingForPolicy.roleId) !== norm(pending.roleId)) {
        pause("Ожидание и очередь адресованы разным агентам. Оба сохранены; проверьте чат и Run ID.",
          { kind: "reviewer-task-check", ref: waitingForPolicy.ref || "" });
        return true;
      }
      let owners;
      try {
        owners = (await roleRows({ fresh: true, requireFresh: true })).filter((r) => r.id && norm(r.id) === norm(pending.roleId));
      } catch (e) {
        pause(`Не удалось определить функцию адресата старой карточки (${e.message}). Отправка, очередь и карточка сохранены.`,
          { kind: "reviewer-task-check", ref: pending.roleId || "" });
        return true;
      }
      // Здесь стояло безусловное «Очередь адресована Reviewer» — и ход
      // приёмки, у которого потерялось ожидание, стоял до Мастера с советом
      // «проверьте чат», хотя ни карточки, ни Run ID у такого хода нет.
      if (!reviewQueue && owners.some((r) => r.fn === "Reviewer" || norm(r.name) === norm("Warden"))) {
        pause("Очередь адресована Reviewer. Проверьте чат и карточку: отправку не повторяю, очередь сохранена.",
          { kind: "reviewer-task-pending", ref: waitingForPolicy?.ref || "", runId: waitingForPolicy?.runId || "" });
        return true;
      }
      const valid = owners.some((r) => r.status === "Активна" && ["Executor", "Auditor"].includes(r.fn) &&
        (!waitingForPolicy?.roleFn || waitingForPolicy.roleFn === r.fn));
      // Ход приёмки не отправляем молча и не откатываем: карточки работы он
      // не несёт, а повтор выдал бы её второй раз. Дальше по шагу такой ход
      // разбирается своим порядком — сверка по карточке и чату, напоминание,
      // затем срок очереди; пауза Мастера здесь ничего не добавляет.
      if (!reviewQueue && (!owners.length || ((workPending || orphanWork) && !valid))) {
        pause("Адресат рабочей очереди не найден среди активных Executor/Auditor или его функция изменилась. Очередь сохранена.",
          { kind: "reviewer-task-check", ref: waitingForPolicy?.ref || "" });
        return true;
      }
    }

    // Ход приёмки без ожидания сверяется по номеру хода, а не по карточке:
    // карточки у него нет (D-055).
    if (await adoptOrphanReview(pending, me)) return true;

    // D-045: очередь без ожидания сперва сверяется с карточкой и чатом — и
    // ДО разбора просрочки. Потерянный ход K-27 пролежал бы в очереди часы:
    // прежний порядок снял бы его как «остаток прошлой попытки», хотя сообщение
    // было в чате и агент уже ответил. Отправка вслепую здесь означала бы
    // второй экземпляр той же работы.
    if (await adoptOrphanDispatch(pending, me)) return true;
    // Сверка могла обновить очередь (тот же ход, новая попытка отправки).
    pending = GM_getValue(K.pending, null) || pending;

    // Просроченная отправка — остаток прошлой попытки (в том числе от старой
    // версии скрипта). Задание до адресата не дошло, значит и ожидание маркера
    // бессмысленно: снимаем оба и продолжаем шаг, а не глотаем нажатие.
    const age = Date.now() - Number(pending.at || 0);
    // Неотправленное задание ждёт Мастера дольше: он узнаёт о паузе не сразу,
    // а очередь — это тот же ход, который не надо начинать заново.
    if (age > (pending.undelivered ? C.undeliveredTtlMs : C.pendingTtlMs)) {
      GM_setValue(K.pending, null);
      // Карточку возвращаем с любой страницы: отметки отправки нет, работы не
      // было, и ждать 45 минут `releaseStalled` ей незачем.
      const ghost = await dropGhostHandoff("очередь отправки просрочена", { ignoreQueue: true });
      // В ручном режиме шаг делает только нажатие: на загрузке страницы
      // ограничиваемся уборкой, а не отправкой плана за спиной Мастера.
      const act = manual || autoOn();
      const next = GM_getValue(K.expect, null)
        ? "Сообщение в чате есть — ожидание ответа оставлено."
        : ghost && ghost.rolled
          ? "Карточка возвращена в Ready — Координатор выдаст её заново."
          : act
            ? "Продолжаю шаг с чистого листа."
            : "Нажмите «Шаг», чтобы начать заново.";
      log(
        `Снял просроченную отправку из очереди (${Math.round(age / 60000)} мин): задание до адресата не дошло, ` +
          `это остаток прошлой попытки. ${next}`,
        true,
      );
      return !act;
    }

    // Страница ещё не отрисована: вставлять текст некуда, а «не нашёл поле»
    // на недогруженной странице — не повод откатывать карточку. Ждём тик.
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Страница ещё грузится (${shell.why}) — задание подождёт.`);
      return true;
    }

    if (!me || norm(me) !== norm(pending.roleId)) return false;

    // Задание, которое не ушло в прошлый раз. Карточку тогда вернули в Ready,
    // чтобы она не ждала 45 минут впустую, но текст остался в очереди:
    // «Продолжить» отправляет его этой же карточке и с тем же Run ID — новый
    // ход Координатора для этого не нужен (24.10, NAR-1.15).
    if (pending.undelivered) {
      const waiting = GM_getValue(K.expect, null);
      if (waiting && waiting.ref && waiting.runId) {
        let fresh = null;
        try {
          fresh = await notion("GET", `pages/${waiting.ref}`);
        } catch (e) {
          log(`Карточку «${waiting.ref}» не прочитать — отправку не начинаю: ${e.message}`, true);
          return true;
        }
        const state = taskState(fresh);
        if (state !== "Ready" && state !== "Running") {
          GM_setValue(K.pending, null);
          GM_setValue(K.expect, null);
          pause(
            `Задание не ушло, а карточка уже «${state || "без состояния"}» — повторную отправку отменяю.`,
            { kind: "send", ref: waiting.ref },
          );
          return true;
        }
        if (state === "Ready") {
          try {
            await patch(waiting.ref, {
              "Dispatch State": { select: { name: "Running" } },
              "Run ID": { rich_text: [{ type: "text", text: { content: waiting.runId } }] },
              "Recipient Agent ID": { rich_text: [{ type: "text", text: { content: pending.roleId } }] },
              "Started At": { date: { start: nowIso() } },
            });
            log("Карточка снова Running: отправляю задание из очереди, новый ход Координатора не нужен.");
          } catch (e) {
            log(`Карточка не вернулась в Running (${e.message}) — задание осталось в очереди.`, true);
            return true;
          }
        }
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, undelivered: false, cardRolled: false, sentAt: null, verified: false });
        GM_setValue(K.pending, { ...pending, undelivered: false, at: Date.now() });
      }
    }

    // Сообщение могло уйти, пока человек решал капчу. Тогда повторная
    // отправка была бы дублем: в чате уже есть эта реплика.
    // Ключ и снимок — те же, что при обычной отправке: доставкой считается
    // реплика, которой до выдачи не было, и только если текст не остался в
    // поле. Прошлая реплика с тем же ключом (повторная выдача карточки) —
    // по-прежнему не доказательство (28.10, 19:38).
    const captchaKey = sendKey(pending.text) || flat(pending.text).slice(0, 60);
    const captchaHandoff = GM_getValue(K.expect, null);
    const captchaKnown = Array.isArray(captchaHandoff?.seen) ? captchaHandoff.seen : null;
    const captchaSent =
      captchaKnown && !composerHolds(captchaKey, pending.text)
        ? userSaysSince(captchaKey, captchaKnown)
        : !composerHolds(captchaKey, pending.text) && lastUserSays(captchaKey)
          ? { id: "message" }
          : null;
    if (pending.captcha && !captchaDialog() && captchaSent) {
      const waiting = GM_getValue(K.expect, null);
      // Водяной знак не переписываем: он снят до отправки. Если за время
      // капчи агент успел ответить, последним сообщением окажется уже ответ —
      // и граница «после отправки» съела бы его целиком.
      if (waiting) {
        const sentAt = Date.now();
        GM_setValue(K.expect, {
          ...waiting, sentAt, verified: true, captcha: false,
          ...(isDispatchAssignment(waiting, pending, me) ? { dispatchSentAt: captchaKnown ? sentAt : 0 } : {}),
        });
      }
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      // Старое ожидание без снимка распознаётся по последней реплике только
      // ради совместимости. Для пуша о доставке нужно более сильное
      // подтверждение: новая реплика относительно снимка до отправки.
      log(
        "После капчи сообщение уже в чате — отправку не повторяю, жду ответа.",
        false,
        captchaKnown ? dispatchDeliveryNtfy(waiting, pending, me) : { ntfy: false },
      );
      return true;
    }

    // Один кадр ничего не доказывает: сразу после перехода Arena показывает
    // Stop на время загрузки транскрипта. Признак подтверждается вторым
    // чтением через секунду — так же, как это уже сделано для «Шага».
    const busy = await busySettled();
    if (busy) {
      pendingSay(
        pending,
        `Агент ещё отвечает: задание из очереди подождёт и уйдёт, как только он закончит (${busyLabel(busy)}).`,
      );
      return true;
    }

    // Капча висит поверх чата: ни вставлять, ни кликать некуда. Ждём человека.
    if (captchaDialog()) {
      captchaPause();
      return true;
    }

    // Ветка прошлого хода слита — сначала Continue, потом текст.
    //
    // 27.10 в 21:15 Архитектор слил PR #97 и записал ответ; Continue после
    // этого не нажалась (память о мерже была на карточку, а не на выдачу).
    // В 21:18 Координатор вернул ту же карточку в работу, задание ушло в чат со
    // старой веткой `arena/73b6f5a4-relay` — статус `pr_merged`. Агент
    // отказался работать («нажмите Continue»), маркера не прислал, и цикл встал
    // на маркер-паузу. Проверяем страницу сами: пока Continue видна, задание
    // отправлять некуда.
    await ensureFreshBranch("Задание в очереди");

    // Плашка «Эта задача была выполнена успешно?» закрывает поле ввода. Мастер
    // просит убирать её скриптом: человек не должен щёлкать по опросу, чтобы
    // цикл поехал дальше.
    //
    // Закрываем её ОДИН раз и только тогда, когда поле ввода правда не
    // находится. Прежняя попытка «закрыть заранее» не срабатывала (backend
    // возвращал плашку при перерисовке) и давала вторую такую же строку в
    // журнале — со счётчиком закрытий, который Мастер читал как сбой.
    const { editor, closed, overlay } = await ensureComposer();
    if (closed) log("Убрал плашку «задача выполнена» — она закрывала поле ввода.");
    if (!editor) {
      journalDelivery(GM_getValue(K.expect, null), "editor_not_found", "editor_not_found");
      pendingSay(
        pending,
        `Не нашёл поле ввода на странице адресата (${composerDiagnostics()}): задание осталось в очереди и не потеряется.` +
          (overlay ? " Поле перекрыто, а кнопки закрытия не видно — закройте плашку вручную." : ""),
        true,
      );
      setTimeout(() => tick(false), 5000);
      return true;
    }

    // Что было в поле, не важно: задание в очереди — это текущий ход. Но сначала
    // поле очищается: Arena возвращает туда отклонённый текст, и вставка поверх
    // склеила бы минимальное сообщение со старым промптом.
    if (composerText(editor)) {
      const cleared = clearComposer(editor);
      log(
        cleared
          ? "В поле ввода был текст (Arena возвращает туда отклонённое) — очистил перед вставкой задания."
          : "Поле ввода не очистилось — вставляю задание поверх: вставка заменяет текст целиком.",
        !cleared,
      );
    }

    // Не вставляем мгновенно после загрузки страницы: ровный машинный ритм
    // выглядит как бот и мешает живому диалогу.
    await sleep(450 + Math.floor(Math.random() * 900));
    if (!writePrompt(editor, pending.text)) {
      const dialog = openDialog();
      const report = domReport();
      GM_setValue("cfn-send-debug", { at: Date.now(), detail: "вставка не удалась", text: String(pending.text).slice(0, 300), report });
      console.warn("[Relay] снимок разметки при отказе вставки:", report);
      if (insertFail.at !== pending.at) insertFail = { at: pending.at, count: 0 };
      insertFail.count += 1;
      const attempt = insertFail.count;
      const hint = dialog ? " Поверх чата открыт диалог Arena — закройте его." : "";
      if (attempt === 1 || attempt >= C.insertRetries) {
        pendingNoticeAt = pending.at; // чтобы pendingSay не сказал то же второй раз
        log(
          attempt < C.insertRetries
            ? `Не удалось вставить задание в редактор — повторю через 15 секунд, задание в очереди.${hint}`
            : `Вставка не проходит ${attempt}-й раз: задание в очереди и само не уйдёт.${hint} Нажмите «Шаг».`,
          attempt >= C.insertRetries,
          attempt >= C.insertRetries ? {} : { ntfy: false },
        );
      }
      return true;
    }
    insertFail = { at: 0, count: 0 };
    await sleep(600);

    // Водяной знак — id последнего сообщения ДО отправки. На странице
    // отправителя он был бы чужим, и «ответ без маркера» нельзя было бы
    // отличить от старой переписки.
    const watermark = lastMessageId();
    const seen = messages().map(nodeId).slice(-40);
    const delivery = await deliver(editor, pending.text);
    // Капча — не обычный отказ: очередь не снимается, карточка не
    // откатывается, ждём человека. Отметки отправки при этом не появляется:
    // «откат отправки» и значит, что `sentAt` не ставится.
    if (delivery.captcha) {
      const waiting = GM_getValue(K.expect, null);
      journalDelivery(waiting, "captcha", "captcha");
      if (waiting) {
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, captcha: true, sentAt: null, verified: false });
      }
      // Очередь остаётся, но с отметкой: после решения капчи сначала надо
      // посмотреть, не дошло ли сообщение всё-таки. Отсчёт TTL начинается
      // заново — человек решает капчу не за десять секунд.
      GM_setValue(K.pending, { ...pending, captcha: true, at: Date.now() });
      captchaPause();
      return true;
    }
    // Поле ввода не нашлось ни на одной попытке — страница ещё дорисовывается
    // (25.10, 14:57: шестнадцать секунд после перехода, транскрипт 0 → 15
    // сообщений, `contenteditable` в документе ноль). Клика не было, значит
    // работы по карточке нет: держим очередь, карточку не трогаем и повторяем
    // отправку следующим тиком. Пауза и откат в Ready — только когда ожидание
    // исчерпано, иначе Мастеру достаётся остановка из-за чужой перерисовки.
    if (delivery.retry) {
      const tries = Number(pending.sendTries || 0) + 1;
      if (tries <= C.sendRetries) {
        GM_setValue(K.pending, { ...pending, sendTries: tries, at: Date.now() });
        log(
          `Страница адресата ещё дорисовывается — повторю отправку через ${Math.round(C.tickMs / 1000)} с ` +
            `(попытка ${tries} из ${C.sendRetries}). Задание в очереди, карточка не тронута.`,
          false,
          { ntfy: false },
        );
        setTimeout(() => tick(false), C.tickMs);
        return true;
      }
      log(`Поле ввода не вернулось за ${C.sendRetries} попыток — останавливаюсь и жду Мастера.`, true);
    }

    if (!delivery.ok) {
      // Сообщение в чат не попало — работы по карточке нет, и в Running ей
      // делать нечего. Очередь снимается вместе со статусом: иначе ответ по
      // этой же карточке пришёл бы, когда она уже не Running, и
      // `submitExecutor` честно отказался бы его записывать.
      const failed = GM_getValue(K.expect, null);
      journalDelivery(failed, "failed", classifyArenaFailure(`${delivery.reason} ${delivery.detail || ""}`));
      const rolled = await releaseUndelivered(
        failed,
        `сообщение не ушло (${String(delivery.reason).toLowerCase()})`,
      );
      if (rolled) {
        // Ход НЕ снимаем: текст задания остаётся в очереди, и «Продолжить»
        // отправит его этой же карточке. Карточка возвращена в Ready только
        // затем, чтобы не висеть в Running 45 минут; перед отправкой она
        // снова станет Running с тем же Run ID.
        GM_setValue(K.pending, { ...pending, undelivered: true, sendTries: 0, at: Date.now() });
        if (failed) {
          forgetDeliveryReceipt(failed);
          GM_setValue(K.expect, {
            ...failed,
            undelivered: true,
            cardRolled: true,
            sentAt: null,
            verified: false,
          });
        }
        pendingNoticeAt = 0;
      }
      pause(
        `${delivery.reason}${delivery.detail ? ` (${delivery.detail})` : ""}. ` +
          (rolled
            ? "Задание осталось в очереди: нажмите «Продолжить» — оно уйдёт этой же карточке, " +
              "без нового хода Координатора."
            : "Задание осталось в поле ввода и в очереди: поправьте и нажмите «Продолжить»."),
        { kind: "send" },
      );
      return true;
    }
    const expect = GM_getValue(K.expect, null);
    // D-045: квитанция пишется и тогда, когда ожидание потеряно. Доставка
    // состоялась и подтверждена id сообщения — этот факт не должен зависеть
    // от того, дожила ли запись `K.expect` до перехода. Без квитанции пауза
    // `delivery-state-lost` оставляла Мастеру вручную искать доказательство,
    // которое скрипт только что держал в руках (K-27, 06.11).
    if (delivery.msgId && (!expect || norm(expect.roleId) !== norm(me))) {
      recordDeliveryReceipt(
        expect && norm(expect.roleId) === norm(me) ? expect : {
          kind: pending.kind || "dispatch",
          ref: pending.ref || expect?.ref || "",
          runId: pending.runId || expect?.runId || "",
          turnId: pending.turnId || "",
          questionId: pending.questionId || "",
          roleId: pending.roleId,
        },
        { messageId: delivery.msgId, sentAt: Date.now(), watermark: delivery.msgId || watermark, seen },
      );
    }
    // D-044: сообщение в чате есть, а ожидание потеряно/подменено — это не
    // «отправлено и можно забыть». Не снимаем очередь молча и не пишем успех:
    // нужна сверка, иначе следующий шаг потеряет ход или продублирует его.
    if (!expect || norm(expect.roleId) !== norm(me)) {
      pause(
        `Сообщение подтверждено в чате (${delivery.msgId || "id не получен"}), но ожидание выдачи ` +
          "потеряно или относится другому агенту. Очередь сохранена; автоматически не повторяю. " +
          "«Продолжить» сначала сверит чат и карточку и не отправит задание вторично; " +
          "кнопка ↺ снимает ход.",
        { kind: "delivery-state-lost", ref: expect?.ref || "", runId: expect?.runId || "" },
      );
      return true;
    }
    // Граница «после отправки» — id подтвердившего сообщения, а не последнего
    // перед отправкой: ответ агента читается строго после нашей реплики, и
    // старое сообщение с тем же текстом границу не сдвигает (1.4.84).
    // Если id не пришёл (старая ветка), остаётся прежний водяной знак.
    const mark = delivery.msgId || watermark;
    const sentAt = Date.now();
    // Квитанция пишется ДО снятия очереди: даже если запись `expect` позднее
    // потеряет `sentAt`, факт доставки этой выдачи останется проверяемым.
    if (delivery.msgId) recordDeliveryReceipt(expect, { messageId: delivery.msgId, sentAt, watermark: mark, seen });
    GM_setValue(K.expect, {
      ...expect, watermark: mark, sentAt, verified: true, seen,
      // sentAt обновляется также для напоминаний; отдельная отметка нужна
      // только для продолжительности работы и не управляет состоянием хода.
      ...(isDispatchAssignment(expect, pending, me) ? { dispatchSentAt: sentAt } : {}),
    });
    dbg("Send: доставка подтверждена, отметка внутри чата", { watermark: mark, via: delivery.via || "message" });
    journalDelivery(expect, "delivered");
    GM_setValue(K.pending, null);
    GM_setValue(K.deadSend, "");
    pendingNoticeAt = 0;
    // Длина — в журнал: по ней видно, какое сообщение Arena не приняла, и
    // сравнить его с коротким повтором (25.10: дважды на задании 2.16).
    // id сообщения — по той же причине: «отправлено» должно быть проверяемо,
    // иначе Мастеру остаётся верить журналу на слово (28.10, 19:38).
    log(
      `Задание отправлено (${String(pending.text || "").length} символов` +
        `${delivery.msgId ? `, сообщение ${delivery.msgId}` : ""}).`,
      false,
      dispatchDeliveryNtfy(expect, pending, me),
    );
    return true;
  }
