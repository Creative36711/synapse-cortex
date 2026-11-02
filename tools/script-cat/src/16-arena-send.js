  // ───────────────────────────── отправка ─────────────────────────────
  /**
   * Редактор агента. Селекторы — из рабочего `dispatch.user.js`, но шире:
   * `[contenteditable='true']` не совпадает с `plaintext-only`, а ProseMirror
   * вешает `role=textbox` без contenteditable. Первый найденный элемент может
   * быть скрытой копией, поэтому кандидаты перебираются с проверкой видимости.
   */
  /** Свой пульт ScriptCat — не поле ввода и не кнопка отправки. */
  const inOwnPanel = (el) => Boolean(el?.closest?.(`#${ui.panel}`));

  /**
   * Боковая панель: аккаунт, навигация, поиск.
   *
   * В разметке Arena это `div.group/sidebar-wrapper`, у кнопки аккаунта —
   * `div.fixed.z-10 … > … > ul > button`. Кнопки оттуда не нажимаются никогда:
   * 23.10 в 22:02 три «клика Send» ушли ровно в аккаунт Мастера.
   */
  const SIDEBAR_SELECTOR = `nav, aside, [role="navigation"], [data-sidebar], [class*="sidebar"]`;

  /**
   * Боковая панель — это та ветка дерева, в которой нет `main`.
   *
   * Тонкость, на которой 23.10 сломался 1.4.25: **вся страница** обёрнута в
   * `div.group/sidebar-wrapper …` — в её классе тоже есть «sidebar». Если
   * исключать всё внутри такого предка, из поиска выпадает и `main`, и поле
   * ввода с кнопкой отправки: скрипт пишет «не нашёл поле ввода», хотя оно на
   * экране. Настоящий сайдбар — сосед `main`, он `main` внутри себя не
   * содержит; обёртка страницы — содержит.
   */
  function sidebarRoot(el) {
    let node = el?.closest?.(SIDEBAR_SELECTOR) || null;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      if (!node.querySelector?.("main")) return node;
      node = node.parentElement?.closest?.(SIDEBAR_SELECTOR) || null;
    }
    return null;
  }

  const inSidebar = (el) => Boolean(sidebarRoot(el));

  /** Служебные поля вроде капчи: под селектор поля ввода они тоже подходят. */
  const isServiceField = (el) =>
    Boolean(el?.closest?.('[class*="captcha"], [name="g-recaptcha-response"]')) ||
    Boolean(el?.classList?.contains?.("g-recaptcha-response"));

  /**
   * Панель ввода: ближайший предок поля, внутри которого есть кнопки.
   *
   * В текущей разметке Arena это
   * `div.bg-surface-secondary…rounded-b-none`, а внутри — и редактор
   * (`.editor-content`), и ряд `.flex.justify-between.gap-4` с кнопкой
   * отправки. Именно эта панель, и только она, задаёт область поиска кнопки
   * Send: «Merge PR» и информация о ветке лежат выше и сюда не попадают, а
   * сайдбар — совсем в другой ветке дерева.
   *
   * До `main` и `body` не поднимаемся: там кнопок сколько угодно, и любая из
   * них — не наша.
   */
  function composerBox(editor) {
    let node = editor?.parentElement || null;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "BODY" || tag === "HTML" || tag === "MAIN") return null;
      const buttons = [...(node.querySelectorAll?.('button, [role="button"]') || [])].filter(
        (b) => visible(b) && !inSidebar(b) && !inOwnPanel(b),
      );
      if (buttons.length) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Узел действительно в документе.
   *
   * После перерисовки чата Arena заменяет поле ввода новым элементом, а у нас
   * остаётся ссылка на старый. `isConnected` у него уже false, и `addRange`
   * падает: «The given range isn't in document». Именно это случилось 23.10 в
   * 22:02 — текст «вставился» в отвязанный узел, настоящее поле осталось
   * пустым, Send — серым.
   */
  function composerAlive(el) {
    if (!el || el.isConnected === false) return false;
    try {
      return typeof document.contains === "function" ? document.contains(el) : true;
    } catch {
      return true;
    }
  }

  /**
   * Редактор сообщения.
   *
   * В живой разметке поле — это `.editor-content > div.tiptap.ProseMirror > p`,
   * и параграфов внутри может быть несколько: они разделяют строки. Редактор
   * поэтому ищется по `contenteditable`, а не по `.editor-content`: обёртка
   * сама не редактируемая.
   *
   * Сайдбар и служебные поля (капча) исключены: под те же селекторы подходят
   * чужие `[role="textbox"]` и `textarea`, а вставка в них — это не отправка
   * задания, а мусор в чужом поле.
   */
  function composer() {
    const good = (el) => el.tagName !== "INPUT" && !inOwnPanel(el) && !inSidebar(el) && !isServiceField(el);
    const candidates = [
      ...document.querySelectorAll(
        ".editor-content [contenteditable]:not([contenteditable='false']), " +
          ".editor-content .ProseMirror, .editor-content[contenteditable], " +
          "[contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
      ),
    ].filter(good);
    const shown = candidates.filter(visible);

    // 1. Редактор в панели `.editor-content` — единственный, который Arena
    //    считает полем сообщения.
    const editorContent = shown.find((el) => el.closest?.(".editor-content"));
    if (editorContent) return editorContent;

    // 2. Любой видимый, у которого есть панель с кнопками: значит, это
    //    панель ввода, а не посторонний `[role=textbox]`.
    const withBox = shown.find((el) => composerBox(el));
    if (withBox) return withBox;

    // 3. Запас: на странице агента поле ввода одно. Если под жёсткие правила
    //    оно не подошло (например, поменяли классы), лучше взять единственное
    //    видимое, чем встать: вставка и отправка всё равно проверяются дальше.
    if (shown.length === 1) {
      dbg("composer: единственное видимое поле взято запасным правилом", {
        cls: String(shown[0].className || "").slice(0, 60),
      });
      return shown[0];
    }

    const prompt = document.querySelector(".editor-content p, [data-placeholder] p");
    const nearPrompt = prompt?.closest("[contenteditable]") || null;
    if (nearPrompt && visible(nearPrompt) && good(nearPrompt)) return nearPrompt;
    return (
      [...document.querySelectorAll("textarea:not([readonly])")].find(
        (el) => good(el) && visible(el) && !el.closest?.('[class*="captcha"]'),
      ) || null
    );
  }

  /**
   * Редактор может быть на месте, но накрыт плашкой: тогда и вставка, и Send
   * уходят в оверлей. Проверяем верхний элемент в центре редактора.
   */
  function elementCovered(editor) {
    try {
      const rect = editor.getBoundingClientRect();
      if (!rect.width || !rect.height) return true;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      return !(top === editor || editor.contains(top) || top.contains(editor));
    } catch {
      return false;
    }
  }

  const labelText = (el) =>
    [
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("data-testid"),
      el?.getAttribute?.("data-test-id"),
      el?.textContent,
    ]
      .map((v) => String(v || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean);

  // Только начало подписи: «Send», «Send message», «send-button» проходят,
  // подпись аккаунта в сайдбаре — нет. Прежнее правило искало слово «send»
  // где угодно в тексте кнопки и было слишком щедрым.
  const SEND_LABEL = /^(send|submit|отправ\w*)(\b|$)/;

  // Кнопка остановки стоит на месте Send, пока агент работает. Нажимать её
  // вместо отправки нельзя: это обрывает ответ.
  const STOP_LABEL = /stop|останов|cancel|отмен/i;

  /**
   * Снимок разметки для разбора отказов.
   *
   * Когда что-то не находится, спорить о причинах бессмысленно: нужны
   * координаты и подписи того, что реально видит скрипт. Снимок пишется в
   * хранилище при отказе отправки и печатается в консоль через
   * `__relay.dom()`.
   */
  function domReport() {
    const box = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      } catch {
        return null;
      }
    };
    const about = (el) => ({
      tag: String(el.tagName || "").toLowerCase(),
      role: el.getAttribute?.("role") || "",
      ce: el.getAttribute?.("contenteditable") || "",
      label: String(labelText(el)[0] || "").slice(0, 40),
      cls: String(el.className || el.getAttribute?.("class") || "").slice(0, 70),
      box: box(el),
      alive: el.isConnected !== false,
      own: inOwnPanel(el),
      sidebar: Boolean(el.closest?.("nav, aside, [role='navigation'], [data-sidebar], [data-slot='sidebar']")),
    });
    const editors = [
      ...document.querySelectorAll(
        ".editor-content[contenteditable], .editor-content [contenteditable], " +
          "[contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
      ),
    ]
      .filter((el) => el.tagName !== "INPUT")
      .slice(0, 12)
      .map(about);
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .slice(0, 60)
      .map(about)
      .filter((b) => b.box && b.box[2] > 0 && b.box[3] > 0);
    const pick = composer();
    const dialog = openDialog();
    return {
      at: Date.now(),
      path: location.pathname,
      hidden: typeof tabHidden === "function" ? tabHidden() : null,
      pick: pick ? about(pick) : null,
      box: pick ? about(composerBox(pick) || {}) : null,
      dialog: dialog ? about(dialog) : null,
      editors,
      buttons,
    };
  }

  /**
   * Открытый диалог Arena поверх чата.
   *
   * Пока он висит, `focus()` не отдаёт каретку полю ввода, и `execCommand`
   * вставляет текст туда, где сейчас фокус. Вставка это заметит (текст не
   * появится в поле), но причину надо называть прямо, иначе Мастер видит
   * только «не удалось вставить задание».
   */
  function openDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
    return dialogs.find((el) => visible(el) && !inOwnPanel(el)) || null;
  }

  /**
   * Капча («Security Verification» с reCAPTCHA) поверх чата.
   *
   * Появляется не по расписанию, а в момент отправки — и тогда клик по Send
   * ничего не отправляет: Arena показывает окно проверки, а сообщение до
   * агента не доходит. Хуже того, поле на миг пустеет, а в транскрипте
   * появляется наша реплика, поэтому `waitSent` честно докладывал «отправлено».
   * 11:56:47 так и вышло: «Задание отправлено», а Координатор ничего не
   * получил (вопрос Мастера 53).
   *
   * Поэтому капча проверяется до клика, после клика и в ожидании доставки: пока
   * окно висит, отправки нет — что бы ни показывал счётчик сообщений.
   */
  const CAPTCHA_SELECTORS = [
    ".recaptcha-v2-container",
    'iframe[title="reCAPTCHA"]',
    'iframe[src*="recaptcha"]',
    "#g-recaptcha-response",
  ];

  function captchaDialog() {
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (!visible(el)) continue;
      if (CAPTCHA_SELECTORS.some((sel) => el.querySelector(sel))) return el;
      // Разметку Arena можно переверстать: окно всё равно узнаётся по заголовку.
      if (/(security verification|recaptcha|подтвердите, что вы человек)/i.test(String(el.textContent || ""))) return el;
    }
    for (const el of document.querySelectorAll(".recaptcha-v2-container")) {
      if (visible(el)) return el.closest?.('[role="dialog"]') || el;
    }
    return null;
  }

  /**
   * Доставка без человека невозможна: пауза с громким пушем.
   *
   * Очередь не снимается: после решения капчи «Продолжить» отправит то же
   * задание, а не начнёт ход заново. Карточка остаётся Running — ход жив, он
   * ждёт человека; вернуть её в Ready значило бы потом отказаться записывать
   * ответ («Задача уже не Running»).
   */
  function captchaPause(extra = "") {
    pause(
      `Появилась капча (Security Verification): без человека сообщение не уйдёт. ` +
        `Решите её и нажмите «Продолжить» — задание осталось в очереди.${extra}`,
      { kind: "captcha", notifyTitle: "Relay: капча — нужен человек" },
    );
  }

  /**
   * Кнопка рядом с полем ввода.
   *
   * Геометрия — единственный признак, который отличает Send от кнопки аккаунта
   * в сайдбаре: подписи у них разные, а вот «первая доступная кнопка в общем
   * контейнере» может оказаться любой. Допуски щедрые: панель ввода бывает
   * и под полем, и справа от него.
   */
  function isNearComposer(el, editor) {
    try {
      const a = editor.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (!a.width || !a.height || !b.width || !b.height) return false;
      // Границы считаются из top/left/width/height: `bottom` и `right` есть у
      // настоящего DOMRect, но полагаться только на них незачем.
      const aBottom = a.top + a.height;
      const aRight = a.left + a.width;
      const bBottom = b.top + b.height;
      const bRight = b.left + b.width;
      return (
        bBottom >= a.top - 160 &&
        b.top <= aBottom + 200 &&
        bRight >= a.left - 80 &&
        b.left <= aRight + 220
      );
    } catch {
      return false;
    }
  }

  /**
   * Кнопка отправки. Подпись важнее формы: в Arena кнопка часто лежит вне
   * `<form>` редактора, поэтому одного `type=submit` мало. Перебираем по
   * приоритету: явная подпись Send → submit внутри формы → submit рядом.
   */
  /** Расстояние от кнопки до редактора: кнопка Send всегда рядом с полем. */
  function distanceTo(editor, el) {
    try {
      const a = editor.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(b.top - a.bottom) + Math.abs(b.left - a.left) / 4;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  function sendButton(editor) {
    if (!composerAlive(editor)) return null;

    // Область поиска — панель ввода. Не документ: 23.10 в 22:02 «первая
    // доступная кнопка в родителе редактора» оказалась кнопкой аккаунта в
    // сайдбаре, и три клика ушли туда. Кнопки вне панели ввода не
    // рассматриваются вообще — ни как запасной путь, ни при нестандартной
    // вёрстке. Лучше пауза, чем клик в неизвестное место.
    const box = composerBox(editor);
    const scope = box || (editor.closest?.("form") || null);
    if (!scope) return null;

    const panels = completionPanels();
    const inPanel = (b) => panels.some((p) => p.contains?.(b));
    const usable = (b) =>
      b &&
      b.isConnected !== false &&
      !b.disabled &&
      b.getAttribute?.("aria-disabled") !== "true" &&
      b.getAttribute?.("data-disabled") !== "true" &&
      visible(b) &&
      !inPanel(b) &&
      !inOwnPanel(b) &&
      !inSidebar(b) &&
      !STOP_LABEL.test(String(labelText(b)[0] || ""));
    const controls = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(usable);
    if (!controls.length) return null;

    // 1. Явная подпись отправки. Из нескольких — последняя в панели: ряд
    //    `.flex.justify-between` держит подпись справа.
    const labelled = controls.filter((b) => labelText(b).some((l) => SEND_LABEL.test(l)));
    if (labelled.length) return labelled.at(-1);

    // 2. `type=submit` внутри панели.
    const submit = controls.filter((b) => String(b.getAttribute?.("type") || b.type || "") === "submit");
    if (submit.length) return submit.at(-1);

    // 3. Подписи нет (одна иконка). Узнать её можно только по месту: кнопка
    //    отправки стоит одна в своей группе, эта группа — последняя в ряду
    //    `.flex.justify-between`, а сама кнопка — в правой половине панели.
    //    Всё, что не подходит под это описание, отправкой не считается:
    //    скрепка и выбор модели стоят слева и в первой группе.
    const nearField = controls.filter((b) => {
      const holder = b.parentElement;
      if (!holder) return false;
      const siblings = [...holder.querySelectorAll('button, [role="button"]')].filter(usable);
      if (siblings.length !== 1) return false;
      if (holder !== holder.parentElement?.lastElementChild) return false;
      if (!isNearComposer(b, editor)) return false;
      const a = editor.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return r.left >= a.left + a.width / 2 - 40;
    });
    return nearField.at(-1) || null;
  }

  /**
   * Вставка текста в редактор.
   *
   * `execCommand("insertText")` — единственный путь, который редактор Arena
   * (ProseMirror) считает настоящим вводом: он обновляет состояние, и кнопка
   * Send становится активной. Запасной путь «присвоить textContent» нужен
   * только если execCommand недоступен — после него текст в DOM есть, а
   * состояние пустое, и Send остаётся серым.
   */
  function writePrompt(editor, text, attempt = 1) {
    // Поле могло исчезнуть из документа между поиском и вставкой — тогда
    // ищем заново, а не пишем в копию.
    let live = composerAlive(editor) ? editor : composer();
    if (!live) return false;
    if (live !== editor) dbg("writePrompt: поле ввода перечитано", { attempt });

    live.focus();
    if (live.tagName === "TEXTAREA" || live.tagName === "INPUT") {
      const proto = live.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(live, text);
      else live.value = text;
      live.dispatchEvent(new Event("input", { bubbles: true }));
      live.dispatchEvent(new Event("change", { bubbles: true }));
      if (live.value.trim().length) return true;
      return attempt < 2 ? writePrompt(composer(), text, attempt + 1) : false;
    }

    let inserted = false;
    try {
      const range = document.createRange();
      range.selectNodeContents(live);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand("insertText", false, text);
    } catch (e) {
      // «The given range isn't in document» — узел успел отвалиться.
      dbg("writePrompt: выделение не поставилось", {
        error: String(e?.message || e),
        alive: composerAlive(live),
      });
    }
    // Запасной путь — только в живой узел: у отвязанного текст «есть», но
    // редактор о нём не знает, и Send остаётся серым.
    if (!inserted && composerAlive(live)) {
      live.textContent = text;
      live.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
    if (composerAlive(live)) live.dispatchEvent(new Event("change", { bubbles: true }));

    const written = composerAlive(live) ? composerText(live).length : 0;
    dbg("writePrompt", () => ({
      via: inserted ? "execCommand" : "textContent",
      written,
      expected: text.length,
      alive: composerAlive(live),
    }));
    if (written > 0) return true;

    // Поле перерисовали: одна повторная попытка в новом узле.
    if (attempt < 2) return writePrompt(composer(), text, attempt + 1);
    return false;
  }

  const composerText = (editor) => (editor?.innerText || editor?.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Очистить поле ввода.
   *
   * 25.10 Arena вернула отклонённый текст задания обратно в поле: сообщение «не
   * ушло», а черновик остался. Если этого не заметить, следующая вставка
   * склеится со старым текстом, и вместо минимального сообщения уйдёт тот же
   * отклонённый промпт — ошибка повторится.
   */
  function clearComposer(editor) {
    const live = composerAlive(editor) ? editor : composer();
    if (!live) return false;
    if (!composerText(live)) return true;
    live.focus();
    try {
      if (live.tagName === "TEXTAREA" || live.tagName === "INPUT") {
        const proto = live.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(live, "");
        else live.value = "";
        live.dispatchEvent(new Event("input", { bubbles: true }));
        return !composerText(live);
      }
      const range = document.createRange();
      range.selectNodeContents(live);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete");
    } catch (e) {
      dbg("composer: очистка не удалась", String(e?.message || e));
    }
    // Запасной путь — как у вставки: иначе ProseMirror оставит свой старый узел.
    if (composerText(live) && composerAlive(live)) {
      live.textContent = "";
      live.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    }
    return !composerText(live);
  }

  /**
   * Плашка «задание выполнено». Два вида, оба перекрывают чат:
   *  1) панель с классом из `dispatch.user.js` и кнопкой закрытия;
   *  2) карточка в транскрипте с кнопкой `Skip` (опрос, аудио, предложение).
   * Возвращает "closed" | "blocked" | "none".
   */
  /**
   * Панель завершения. В `dispatch.user.js` селектор требовал `shadow-sm`, а в
   * текущей разметке Arena у неё `shadow-none` — совпадение по всему списку
   * классов перестало находить карточку. Держим стабильную часть и проверяем
   * кандидатов по кнопке закрытия, а не по полному имени класса.
   */
  const PANEL_SELECTORS = [
    "div.border-border-medium.bg-surface-secondary.w-full.rounded-md.border",
    "div[class*='border-border-medium'][class*='bg-surface-secondary'][class*='rounded-md']",
  ];

  function skipCardButton() {
    for (const message of document.querySelectorAll('[data-agent-transcript-message="true"]')) {
      for (const button of message.querySelectorAll("button")) {
        if (!/^skip$/i.test(`${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim())) continue;
        if (!visible(button)) continue;
        // Skip внутри группы вариантов — это вопрос агента, а не плашка.
        // Один клик закрыл бы сразу весь опросник, и остальные вопросы исчезли
        // бы, не попав ни в журнал, ни в журнал попытки (24.10, NAR-1.12).
        if (button.closest?.('[role="radiogroup"]')) continue;
        return button;
      }
    }
    return null;
  }

  /**
   * Плашка «Эта задача была выполнена успешно?» — опрос внизу чата.
   *
   * Мастер: пока она на экране, задача не выполняется — Arena не показывает
   * этот опрос во время работы. И она перекрывает поле ввода, поэтому её
   * закрывает скрипт, а не человек.
   */
  const COMPLETION_TEXT = /эта задача была выполнена успешно|was this task completed successfully|did this task complete successfully/i;

  function completionPlaque() {
    for (const panel of completionPanels()) {
      if (!COMPLETION_TEXT.test(panel.textContent || "")) continue;
      // Контейнер с целым чатом под этот селектор тоже попадает: плашкой он не
      // становится, и «закрывать» его кнопкой шапки нельзя.
      if (panel.querySelector('[data-agent-transcript-message="true"]')) continue;
      return panel;
    }
    return null;
  }

  /** Кандидаты в панель завершения: объединение обоих селекторов, без скрытых. */
  function completionPanels() {
    const found = new Set();
    for (const selector of PANEL_SELECTORS) {
      for (const panel of document.querySelectorAll(selector)) if (visible(panel)) found.add(panel);
    }
    return [...found];
  }

  /**
   * Кнопка закрытия панели. Приоритет — явная подпись (`Close review panel`,
   * `Close`, `Закрыть`), затем последняя кнопка шапки, затем единственная.
   */
  function closeButtonIn(panel) {
    // Раскрывашки (`aria-expanded`) — не закрытие: клик по ним сворачивает
    // панель, а не убирает её, и снаружи это выглядит как «плашка вернулась».
    const buttons = [...panel.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-expanded") === null,
    );
    const labelled = buttons.find((b) =>
      /close|dismiss|закрыть|скрыть/i.test(
        `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.textContent || ""}`,
      ),
    );
    const header = panel.querySelector(".flex.items-center.justify-between");
    const inHeader = [...(header?.querySelectorAll("button") || [])];
    return labelled || inHeader.at(-1) || (buttons.length === 1 ? buttons[0] : null);
  }

  /** Панель завершения: та же кнопка, что в dispatch.user.js (шапка, затем подпись). */
  function closeCompletionPanel() {
    const captcha = captchaDialog();
    const panels = completionPanels();
    for (const panel of panels) {
      // Окно проверки не плашка: его кнопки нажимает человек, а не скрипт.
      if (captcha && (panel === captcha || panel.contains(captcha))) continue;
      const close = closeButtonIn(panel);
      if (close && visible(close)) {
        close.click();
        return "closed";
      }
    }
    return panels.length ? "blocked" : "none";
  }

  /**
   * Убрать все панели завершения, а не одну.
   *
   * 24.10 в 20:15 шаг встал на «поле ввода пропало»: плашка «Эта задача была
   * выполнена успешно?» закрылась и тут же появилась снова. Клик был не при
   * чём — на странице две панели (одна в переписке, вторая липкая снизу), и
   * закрытие верхней просто показывало нижнюю. Поэтому закрываем все видимые
   * подряд, пока они не кончатся, и только потом ищем поле ввода.
   */
  async function closeCompletionPanels(max = 4) {
    let closed = 0;
    for (let pass = 0; pass < max; pass += 1) {
      const captcha = captchaDialog();
      const panels = completionPanels().filter(
        (panel) =>
          // Контейнер с целым чатом панелью не считается, окно проверки не наше.
          !panel.querySelector('[data-agent-transcript-message="true"]') &&
          !(captcha && (panel === captcha || panel.contains(captcha))),
      );
      if (!panels.length) break;
      let clicked = 0;
      for (const panel of panels) {
        const close = closeButtonIn(panel);
        if (close && visible(close)) {
          close.click();
          clicked += 1;
        }
      }
      if (!clicked) break;
      closed += clicked;
      // Пауза между проходами: вторая панель появляется после перерисовки.
      await sleep(350);
    }
    return closed;
  }

  /** Плашка любым способом: панель завершения, иначе карточка с Skip. */
  function closeCompletionPlaque() {
    const panel = closeCompletionPanel();
    if (panel !== "none") return panel;
    const skip = skipCardButton();
    if (skip) {
      skip.click();
      return "closed";
    }
    return "none";
  }
