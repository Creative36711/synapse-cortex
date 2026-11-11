  // ───────────────────────── самовосстановление: правила ─────────────────────────
  // Остановка разбирается по причине, а не по тексту для Мастера: у каждого вида
  // паузы есть класс и маршрут. Здесь только чистые функции — их исполняет проба
  // (tests/heal-core-smoke.mjs), поэтому ни DOM, ни GM, ни сети в файле нет.
  //
  // Маршруты (D-073):
  //  • momentary — временный сбой; транспорт продолжает сам, но не бесконечно
  //    (C.healRetryMax и выдержка C.healBackoffMs); исчерпал — зовёт Мастера.
  //  • transport — поломка транспорта; ход уходит Maintainer'у, у него свой
  //    предохранитель C.healMaintainerMax; исчерпал — Мастер.
  //  • arena — сбой сайта Arena (капча, авторизация, 5xx): чинить нечего, стоп.
  //  • master — решает только человек (данные, роли, петли, оракул): стоп.
  // Нераспознанный вид паузы не чинится наугад: он идёт Мастеру и помечается
  // `unknown`, а проба требует, чтобы таблица покрывала все виды из кода.
  const HEAL_RULES_VERSION = 1;

  const HEAL_CLASS_INFO = {
    momentary: { route: "retry", repair: "self", label: "временный сбой транспорта или сети" },
    // D-092: сюда входит и то, что решает агент (постановка, очередь, зоны,
    // петли), и то, что решает только человек. Маршрут один — решение, но
    // адресат решения теперь разный, и различие несёт не класс, а
    // `MASTER_ONLY` (см. ниже): класс отвечает на «чинить или решать»,
    // адресат — на «кто решает».
    transport: { route: "maintainer", repair: "maintainer", label: "поломка транспорта" },
    arena: { route: "master", repair: "none", label: "сбой сайта Arena: чинить нечего" },
    master: { route: "master", repair: "none", label: "остановка без автоматического пути" },
  };

  /**
   * D-092: ЗАКРЫТЫЙ список того, что решает только человек.
   *
   * До 1.92.0 человек был адресатом по умолчанию: 48 из 70 видов паузы имели
   * класс `master`, и 12 из 17 фактических остановок за 08–09.11 упирались в
   * Мастера. Ни одна из этих двенадцати не требовала решения по существу:
   * восемь были установкой сборки, две — падением доставки агенту, одна —
   * разбором маркера.
   *
   * Теперь список закрыт по смыслу: новый вид паузы не может попасть к Мастеру
   * «по привычке» — только сюда, а проба не даёт таблице разойтись с ним.
   * Четыре пункта и есть «технически невозможно»:
   *   • install — установка userscript в браузер и действия в браузере;
   *   • agent — создание агента в Arena, его Agent URL и доступы;
   *   • money — лицензии, ToS, деньги, секреты;
   *   • product — переход фазы, новая миссия, границы продукта.
   * Код в `synapse` Мастеру не принадлежит — его пишет роль ядра; здесь его нет
   * намеренно, иначе «только человек» стало бы списком прав человека на код.
   */
  const MASTER_ONLY = ["install", "agent", "money", "product"];

  /** Вид паузы → пункт закрытого списка. Нет записи — Мастеру не показывать. */
  const HEAL_MASTER_ONLY = {
    // Установку сборки делает человек, но пауза за неё больше не поднимается
    // (D-085): это отметка, а не остановка. Пункт нужен, чтобы `update-recovery`
    // не ушёл агенту как «поломка транспорта».
    "update-recovery": "install",
    // D-102: `heal-await-update` здесь НЕ значится намеренно. Это не «решает
    // человек», а «ждём установку»: пауза уже стоит и уже говорит, что делать.
    // Пока вид был привязан к пункту `install`, вторая пауза шла как
    // человеческая, звонила в телефон и выглядела новым инцидентом — 10.11
    // Мастер получил две паузы подряд из одной поломки.
    // Доступы и состав: строку «Роли», Agent URL и флаг правит Мастер.
    "mission-roster": "agent",
    provision: "agent",
    "provision-no-admin": "agent",
    "project-role-origin": "agent",
    "no-reviewer": "agent",
    "heal-no-maintainer": "agent",
    // Решения уровня продукта и фаз.
    "review-needs-master": "product",
    "pilot-timeout": "product",
    "pilot-tool-limit": "product",
    // Вариант по умолчанию кончился, а вопрос — про продукт: решает человек.
    "answer-needs-master": "product",
  };

  /**
   * D-104: виды остановки, которые действительно останавливают цикл.
   *
   * До этой правки `pause()` останавливал цикл всегда, а решение «кто это
   * разбирает» принималось уже после — в `healAfterPause`. Поэтому каждая
   * поломка сначала показывалась Мастеру как ПАУЗА и только потом уходила
   * транспорту: 04.11 журнал показал «ПАУЗА (решает повтор)» три раза подряд
   * там, где цикл продолжался сам, а в конце — «ПАУЗА (решает транспорт)»
   * перед передачей Maintainer'у, которая паузой не является.
   *
   * Теперь вид остановки сам говорит, стоит ли цикл:
   *   • временный сбой и поломка транспорта — НЕ стоят: их разбирает тот, кто
   *     и так продолжит работу (повтор или передача Maintainer'у);
   *   • ожидание установки — стоит: без установки новой сборки продолжать
   *     нельзя, и это единственный случай, где нужен Мастер;
   *   • закрытый список `MASTER_ONLY` — стоит всегда: человек решает (роль,
   *     доступы, деньги, продукт);
   *   • нераспознанная остановка — стоит: чинить наугад нельзя, а запись
   *     «пауза без причины» — худший вид вранья в журнале.
   */
  const HEAL_HOLDING = [
    // Ждём установку: продолжение закрыто до новой сборки, это делает Мастер.
    "heal-await-update",
    // Разбор кончился ничем: дальше только человек.
    "heal-exhausted",
    "heal-no-maintainer",
    // Пределы и данные: без человека решение не принимается.
    "heal-maintainer-done",
    "rework-limit",
    "no-reply",
    "busy-stuck",
    "marker-mismatch",
    "poll-loop",
    "captcha",
    "auth",
    // Неоднозначность доставки: отправлять вслепую — дубль. Пока человек не
    // посмотрит чат и карточку, продолжать нечем, поэтому стоим.
    "orphan-dispatch",
    "orphan-review",
    "delivery-state-lost",
    "handoff-kind",
    "reviewer-task-check",
    "reviewer-task-pending",
    "closed-with-running",
    "closed-unreviewed",
    "mission-change-running",
    "mission-change-answer",
    "dispatch-changed",
    "answer-changed",
    "answer-return-role",
    "answer-return-send",
    "answer-return-undelivered",
    "answer-return-changed",
    "answer-return-lost",
    "orphan-answer-return",
    "update-recovery",
  ];

  /**
   * Стоит ли цикл по этой остановке. `false` — это разбор, а не пауза: цикл
   * продолжает тот, кто умеет продолжать (повтор или транспорт).
   *
   * Признак считается здесь, рядом с таблицей классов: решение должно быть в
   * одном месте, иначе `pause()` и разбор разойдутся, и в журнале снова
   * появится «ПАУЗА», после которой ничего не стоит.
   */
  function healHoldsCycle(kind, reason = "") {
    const key = String(kind || "").trim();
    if (!key) return true;
    // Явный список сильнее класса: «неоднозначность доставки» размечена
    // транспортом (её и разбирает транспорт), но продолжать вслепую нельзя —
    // отправка дала бы дубль. Поэтому сначала список, потом класс.
    if (HEAL_HOLDING.includes(key)) return true;
    const verdict = classifyPause(key, reason);
    // Закрытый список: человек решает — значит стоим.
    if (verdict.with === "master") return true;
    // Ожидание установки: Мастер ставит сборку, без неё продолжения нет.
    if (verdict.with === "install") return true;
    // D-092: нераспознанный вид — работа транспорта. Стоять на нём незачем:
    // разбор всё равно пойдёт, а ожидание нажатия только подменило бы работу.
    if (verdict.unknown) return false;
    // Временный сбой повторяется сам, поломка уходит Maintainer'у — оба идут
    // дальше без остановки.
    if (verdict.cls === "momentary" || verdict.cls === "transport") return false;
    return false;
  }

  /**
   * Вид паузы → класс причины. Список сверяется с кодом машинно: проба собирает
   * все `kind:"…"` из `pause(...)` и падает, если вид паузы не назван здесь.
   * Поэтому «нераспознанное» остаётся аварийным исходом, а не обычным путём.
   */
  const HEAL_PAUSE_CLASS = {
    // Временное: повтор сами не портит ход — состояние уже сохранено.
    nav: "momentary",
    offline: "momentary",
    step: "momentary",
    "review-cards-read": "momentary",
    error: "momentary",
    // Транспорт: чинит Maintainer, у него есть дифф, проба и версия.
    "prompt-compile": "transport",
    "handoff-kind": "transport",
    "orphan-dispatch": "transport",
    "orphan-review": "transport",
    // По умолчанию — транспорт: чаще всего это потеря доставки (очередь и
    // ожидание адресованы разным агентам). Если причина называет неактивную
    // роль, роль без URL или отсутствие варианта «Кому», класс поднимается до
    // master по тексту (HEAL_MASTER_TEXT) — править «Роли» Maintainer не вправе.
    "reviewer-task-pending": "transport",
    "reviewer-task-check": "transport",
    "dispatch-changed": "transport",
    "delivery-state-lost": "transport",
    send: "transport",
    "answer-changed": "transport",
    "answer-return-send": "transport",
    "answer-return-undelivered": "transport",
    "answer-return-changed": "transport",
    "answer-return-lost": "transport",
    "orphan-answer-return": "transport",
    // Невозможность доставить автору из-за неактивной/неполной строки — доступ
    // правит только Мастер (D-027/D-074), это не повод подменять адресата.
    "answer-return-role": "master",
    // Arena: капча, авторизация, ошибка страницы, отказ агента. Авторизация
    // приходит текстом причины, поэтому своего вида паузы у неё нет: вид
    // `auth` живёт только в healTextClass, а не в этой таблице.
    captcha: "arena",
    "arena-error": "arena",
    "ui-error": "arena",
    // Мастер: данные, роли, петли, оракул, штатные пределы.
    "no-reply": "master",
    // Задание в очереди, а адресат бесконечно «работает»: 09.11 так прошло 12
    // часов без паузы. Чинит не транспорт — либо застрял индикатор на странице
    // (тогда нужен новый разбор), либо генерация не завершается (это Arena).
    "busy-stuck": "master",
    "project-role-origin": "master",
    "project-pr-boundary": "master",
    "closed-with-running": "master",
    "closed-unreviewed": "master",
    "mission-change-running": "master",
    "mission-change-answer": "master",
    // D-084: «ответ без маркера после всех напоминаний» — дефект разбора или
    // доставки, а не решение человека. Мастер в таких случаях не понадобился
    // ни разу (09.11: маркер CF_ANSWER_RESULT был виден в тексте Warden, а
    // транспорт дважды отрапортовал «без маркера»). Ход уходит Maintainer'у, у
    // него дифф и проба; предохранитель C.healMaintainerMax остаётся.
    // D-093: повтор задания без run_id — не «поломка транспорта», а состояние
    // ожидания: чинить в профиле нечего, нужен новый ход Координатора. Это
    // работа приёмки (постановка и очередь — её предмет), а не человека.
    "retry-no-run": "master",
    marker: "transport",
    "marker-mismatch": "master",
    // D-105: адресный result при несходящейся identity нельзя безопасно
    // применить или отправить повторно; очередь сохраняется для Мастера.
    "dispatch-handoff-mismatch": "master",
    "review-handoff-mismatch": "master",
    "arbiter-handoff-mismatch": "master",
    "answer-handoff-changed": "master",
    "answer-handoff-missing": "master",
    "answer-handoff-mismatch": "master",
    "poll-loop": "master",
    "dispatch-mission": "master",
    "review-needs-master": "master",
    "review-empty": "master",
    "review-marker": "master",
    "review-nocoord": "master",
    "review-no-mission": "master",
    "review-unbound": "master",
    "review-with-open": "master",
    "rework-limit": "master",
    "no-reviewer": "master",
    "return-empty": "master",
    "plan-shift": "master",
    "plan-miss": "master",
    "blocked-norole": "master",
    "blocked-role": "master",
    "done-with-open": "master",
    "done-with-remarks": "master",
    redispatch: "master",
    "arbiter-limit": "master",
    "arbiter-master": "master",
    "arbiter-marker": "master",
    "arbiter-nocoord": "master",
    "arbiter-nomission": "master",
    "answer-needs-master": "master",
    "answer-marker": "master",
    "answer-empty": "master",
    // D-085: ответ приёмки заявляет занятый номер решения. Правит приёмка, не
    // человек: список номеров лежит в docs/DECISIONS.md и читается транспортом.
    "answer-decisions": "transport",
    // D-086: редакция ТЗ объявлена, но не опубликована. Правит приёмка вместе с
    // Координатором (PR), человек тут не нужен и не поможет.
    "answer-unpublished": "transport",
    // D-091: гейт-вопрос Координатора не удалось передать адресату. Это
    // транспорт-внутреннее: очередь не создалась или ячейки нет, роль на месте.
    // Человек тут не нужен — вопрос уже записан строкой, «Продолжить» повторит.
    "answer-handoff": "transport",
    "answer-nocoord": "master",
    "tool-limit": "master",
    "pilot-tool-limit": "master",
    "pilot-timeout": "master",
    provision: "master",
    "provision-no-admin": "master",
    // D-092: класс оставлен `master`, но пауза теперь поднимается только там,
    // где нет очереди отправки (см. 18-state-recovery.js). Тот случай — сверка,
    // а не решение; Мастеру он не показывается как вопрос (тихий).
    "update-recovery": "master",
    // D-075: нехватка роли — не поломка транспорта. Виды `reviewer-task-check`
    // и `reviewer-task-pending` по умолчанию остаются за транспортом (потеря
    // доставки), но когда причина называет неактивную роль, роль без URL или
    // отсутствие варианта «Кому», их забирает Мастер: править «Роли»
    // Maintainer не вправе (D-063, D-074). Признак — в HEAL_MASTER_TEXT.
    "mission-roster": "master",
    // Пауза самовосстановления: ждём, что Мастер поставит новую сборку.
    "heal-await-update": "master",
    "heal-maintainer-done": "master",
    "heal-exhausted": "master",
    "heal-no-maintainer": "master",
  };

  /**
   * Причина паузы текстом сильнее ярлыка: капча и сессия — это Arena, а не
   * «неизвестная остановка». Здесь ярлык — `reason`, а класс всегда один из
   * HEAL_CLASS_INFO: иначе «капча» попала бы в классы как отдельная сущность.
   */
  const HEAL_TEXT_RULES = [
    // Дефект собственного кода — не «сбой сети». 08.11 цикл дважды объявил
    // «временный сбой транспорта или сети» с текстом «draft is not defined»:
    // это ReferenceError в нашем же файле, и повтором отправки он не лечится —
    // повторы лишь заново спрашивали Координатора, пока ход стоял. Такой сбой
    // уходит Maintainer'у (он разбирает причину и предлагает дифф, D-027/D-074),
    // а класс «временный» остаётся только у настоящих обрывов.
    [/ReferenceError|TypeError|SyntaxError|is not defined|is not a function|Cannot read propert|Cannot access /i,
      "code-defect", "дефект сборки: ошибка в коде транспорта, повтором не лечится"],
    [/captcha|recaptcha|security verification|подтвердите, что вы человек|капч/i, "captcha",
      "капча: без человека сообщение не уйдёт"],
    [/войдите|авторизац|session expired|sign[ -]?in|unauthorized|\b401\b/i, "auth",
      "сессия Arena: нужен вход человеком"],
    [/HTTP 5\d\d|something went wrong|please try again|что-то пошло не так/i, "arena-error",
      "ошибка сайта Arena: чинить нечего"],
  ];

  /**
   * Некомплект ролей словами паузы. Отдельно от HEAL_TEXT_RULES, потому что
   * класс другой: там сбой Arena (`arena`), здесь решение Мастера (`master`).
   *
   * Почему текстом, а не видом паузы: `reviewer-task-check` ставится и на
   * потерю доставки, и на «адресат не подтверждён среди активных». Это разные
   * причины и разные адресаты разбора, а вид паузы в старой сборке уже стоит в
   * журнале — по нему постфактум уже не различить. Признак берётся из причины.
   */
  const HEAL_MASTER_TEXT = [
    [/Адресат рабочей очереди не найден среди активных|не найден среди активных Executor\/Auditor/i,
      "roster-recipient", "адресат рабочей очереди не подтверждён среди активных"],
    [/Статус|Agent URL|«Ролях»|нет варианта|вариантах «Кому»|роль не активна/i,
      "roster-row", "роль или её строка не готовы к выдаче"],
  ];

  /**
   * D-092: кто отвечает по существу — человек, Warden или транспорт.
   *
   * Раньше этот выбор был один на всё: класс `master` — значит человек. Но
   * `master` отвечает на другой вопрос: «нужен ход рассуждения, а не повтор».
   * Адресат рассуждения бывает разным: постановка, зоны и очередь — Warden,
   * технический дефект — Maintainer, и только закрытый список (MASTER_ONLY) —
   * человек.
   *
   * Инверсия здесь не косметическая: таблица `HEAL_PAUSE_CLASS` осталась та же,
   * но её `master` больше не значит «Мастер». Поэтому проба проверяет не
   * таблицу, а это решение.
   */
  function healResolveWith(kind, cls, config = {}) {
    const key = String(kind || "");
    const list = Array.isArray(config.masterOnly) && config.masterOnly.length ? config.masterOnly : MASTER_ONLY;
    // D-104: «ждём установку» — не решение и не поломка: адресат `install`.
    // Пункта закрытого списка у неё нет намеренно (D-102): человек здесь не
    // решает, он ставит сборку, и пауза об этом прямо и говорит.
    if (key === "heal-await-update") return { with: "install", point: "install" };
    const point = HEAL_MASTER_ONLY[key];
    // D-104: установка сборки — действие Мастера, но не решение: адресат
    // называется отдельно, чтобы `pause()` не считал её человеческой
    // остановкой и не звонил, а разбор знал, кого ждать.
    if (point === "install") return { with: "install", point };
    if (point && list.includes(point)) return { with: "master", point };
    // Капча и вход — физическое действие в браузере: его выполняет человек, но
    // это не «решение», а действие. Отдельного пункта списка у него нет, и это
    // осознанно: пункт списка даёт право решать, а нажать капчу — не решение.
    if (cls === "arena") return { with: "master", point: "" };
    if (cls === "momentary") return { with: "self", point: "" };
    if (cls === "transport") return { with: "transport", point: "" };
    if (cls === "master") {
      // Решение уровня постановки: зоны, очередь, трактовка ТЗ, петля.
      // Это D-027 п. 1 и D-066 г — предмет приёмки, а не человека.
      if (/^(review|plan|dispatch|return|done|rework|arbiter|answer|blocked|redispatch|mission)/.test(key) ||
          key === "no-reply" || key === "busy-stuck") {
        return { with: "warden", point: "" };
      }
      // Всё прочее — техническая остановка без разбора: её снимает транспорт.
      return { with: "transport", point: "" };
    }
    return { with: "transport", point: "" };
  }
  function healMasterMatch(kind, text) {
    const label = String(kind || "");
    if (label !== "reviewer-task-check" && label !== "reviewer-task-pending") return null;
    const t = String(text || "");
    for (const [re, reason, why] of HEAL_MASTER_TEXT) if (re.test(t)) return { reason, cls: "master", why };
    return null;
  }

  /**
   * Класс по тексту причины. У правил он разный: капча, вход и 5xx — сбой Arena
   * (чинить нечего), а дефект собственного кода — транспорт, у него есть дифф и
   * проба. Одно «arena» на все случаи отправляло бы ReferenceError в «сайт
   * Arena виноват» и не звало Maintainer'а.
   */
  const HEAL_TEXT_CLASS = {
    "code-defect": "transport",
  };

  function healTextMatch(text) {
    const t = String(text || "");
    for (const [re, reason, why] of HEAL_TEXT_RULES) {
      if (re.test(t)) return { reason, cls: HEAL_TEXT_CLASS[reason] || "arena", why };
    }
    return null;
  }

  /**
   * Вердикт. `by` — откуда взялся класс: `label` (вид паузы в таблице),
   * `roster` (некомплект ролей в тексте причины) или `text` (капча, вход, 5xx).
   * Без этого признака в журнале не видно, почему пауза ушла не туда, куда
   * указывает её вид.
   */
  function healVerdict(kind, cls, why, unknown = false, reason = "", by = "label") {
    const info = HEAL_CLASS_INFO[cls] || HEAL_CLASS_INFO.master;
    return {
      rules: HEAL_RULES_VERSION,
      kind: String(kind || ""),
      reason: String(reason || ""),
      by,
      cls: HEAL_CLASS_INFO[cls] ? cls : "master",
      why: String(why || ""),
      unknown: Boolean(unknown),
      route: info.route,
      repair: info.repair,
      retry: info.route === "retry",
      maintainer: info.route === "maintainer",
      // D-092: «кто решает» отдельным полем вердикта. `route` оставлен как был:
      // на него смотрит старый разбор состояния, и менять его значение значило
      // бы переписать историю в телеметрии.
      with: healResolveWith(kind, HEAL_CLASS_INFO[cls] ? cls : "master").with,
    };
  }

  /**
   * Классификатор остановки. Возвращает класс и маршрут, а не решение: решение
   * принимает `decideHeal` с учётом счётчиков этого инцидента.
   */
  function classifyPause(kind, reason) {
    const key = String(kind || "").trim();
    // Некомплект ролей проверяется раньше капчи и 5xx: текст паузы о роли может
    // содержать что угодно («не активна»), но адресат разбора у него свой.
    const byRoster = healMasterMatch(key, reason);
    if (byRoster) return healVerdict(key, byRoster.cls, byRoster.why, false, byRoster.reason, "roster");
    const byText = healTextMatch(reason);
    if (byText) return healVerdict(key, byText.cls, byText.why, false, byText.reason, "text");
    const cls = HEAL_PAUSE_CLASS[key];
    // D-092: инверсия адресата по умолчанию. Раньше нераспознанный вид уходил
    // Мастеру — «безопасно». На практике это означало, что каждый новый дефект
    // сначала зовёт человека, а агент разбирает только то, что ему разрешили
    // задним числом. Теперь неизвестная остановка уходит транспорту: он снимет
    // телеметрию и назовёт причину, а человек нужен лишь там, где без него
    // физически нельзя (MASTER_ONLY).
    // D-092: инверсия по умолчанию. Раньше здесь стояло «неизвестный вид — значит
    // Мастер», и любая опечатка в имени паузы (а их 70) будила человека ночью.
    // Неизвестное — это дефект таблицы или кода, то есть работа транспорта.
    if (!cls) return healVerdict(key, "transport", "вид остановки не назван в таблице: разбирает транспорт, а не человек", true, key);
    return healVerdict(key, cls, HEAL_CLASS_INFO[cls].label, false, key);
  }

  /**
   * Ключ инцидента. Цифры и id из текста причины вырезаются: «ждал 17 мин» и
   * «ждал 18 мин» — один инцидент, а не два повода продолжать заново.
   */
  function healIncidentKey(info = {}) {
    const core = String(info.reason || "")
      // Сначала id (UUID и длинный hex вместе с подписью), потом просто числа:
      // иначе «id <uuid>» превращается в «id #» и каждая новая выдача — новый
      // инцидент, а предохранитель обнуляется сам собой.
      .replace(/\b(?:id|шаг|ход|turn|run|dispatch|runId|turnId)\s*:?\s*[0-9a-f-]{8,}/gi, "#")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
      .replace(/[0-9a-f]{16,}/gi, "#")
      .replace(/\d+/g, "#")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    // D-084: дефект маркера — часть ключа. «Нет отчёта» и «нет dispatch_id»
    // чинятся разными правками и не должны считаться одним инцидентом, иначе
    // предохранитель Maintainer'а сгорал бы на чужой поломке.
    const defect = info.defect && (info.defect.kind || info.defect.marker)
      ? `${info.defect.kind || ""}/${info.defect.marker || ""}` : "";
    return [String(info.kind || ""), String(info.ref || ""), String(info.runId || ""),
      String(info.turnId || ""), core, defect].join("|");
  }

  const healBackoff = (retries, config = {}) => {
    const list = Array.isArray(config.healBackoffMs) && config.healBackoffMs.length
      ? config.healBackoffMs : [30000, 120000];
    return Number(list[Math.min(Math.max(retries, 0), list.length - 1)]) || 30000;
  };

  /**
   * Что делать дальше: продолжить сами, позвать Maintainer'а или остановиться.
   * Предохранители считаются по инциденту, а не по циклу целиком: второй раз за
   * сутки один и тот же сбой — это новый инцидент.
   */
  function decideHeal(verdict, counters = {}, config = {}) {
    const retryMax = Number.isFinite(Number(config.healRetryMax)) ? Number(config.healRetryMax) : 2;
    const maintMax = Number.isFinite(Number(config.healMaintainerMax)) ? Number(config.healMaintainerMax) : 2;
    const retries = Math.max(0, Number(counters.retries) || 0);
    const escalations = Math.max(0, Number(counters.escalations) || 0);
    const v = verdict || healVerdict("", "master", "причина не названа");

    if (v.route === "retry") {
      if (retries < retryMax) {
        return {
          action: "retry", attempt: retries + 1, max: retryMax,
          delayMs: healBackoff(retries, config),
          why: `${v.why}: продолжаю сам (${retries + 1} из ${retryMax})`,
        };
      }
      // D-092: повторяющийся «временный» сбой — это не решение человека, а
      // дефект: два одинаковых обрыва подряд означают, что чинит не повтор, а
      // правка. Уходит транспорту, у него дифф и проба.
      return {
        action: "maintainer",
        attempt: escalations + 1, max: maintMax,
        why: `временный сбой повторился ${retries} раз(а) (предел ${retryMax}): это дефект, а не случайность`,
      };
    }
    // D-092: адресат решения. `master` больше не значит «человек»: закрытый
    // список MASTER_ONLY отвечает за «только человек», а постановка, очередь и
    // петли уходят приёмке. Порядок важен: сначала «кто решает», потом пределы
    // этого адресата — иначе счётчик одного адресата тратился бы на другого.
    if (v.with === "warden") {
      const ticketMax = Number.isFinite(Number(config.masterTicketMax)) ? Number(config.masterTicketMax) : 1;
      const tickets = Math.max(0, Number(counters.tickets) || 0);
      if (tickets < ticketMax) {
        return {
          action: "warden", attempt: tickets + 1, max: ticketMax,
          why: `${v.why}: передаю приёмке строкой в «Обратную связь», цикл продолжается`,
        };
      }
      return {
        action: "master",
        why: `приёмка уже получала эту остановку ${tickets} раз(а) (предел ${ticketMax}) и решения нет: останавливаюсь`,
      };
    }
    if (v.with === "transport" && v.route !== "retry") {
      if (escalations < maintMax) {
        return {
          action: "maintainer", attempt: escalations + 1, max: maintMax,
          why: `${v.why}: передаю Maintainer'у (${escalations + 1} из ${maintMax})`,
        };
      }
      return {
        action: "master",
        why: `Maintainer уже ${escalations} раз(а) разбирал этот инцидент (предел ${maintMax}): останавливаю цикл`,
      };
    }
    if (v.route === "maintainer") {
      if (escalations < maintMax) {
        return {
          action: "maintainer", attempt: escalations + 1, max: maintMax,
          why: `${v.why}: передаю Maintainer'у (${escalations + 1} из ${maintMax})`,
        };
      }
      return {
        action: "master",
        why: `Maintainer уже ${escalations} раз(а) разбирал этот инцидент (предел ${maintMax}): останавливаю цикл и зову Мастера`,
      };
    }
    return { action: "master", why: v.why || "остановка без автоматического пути" };
  }

  // ───────────────────────── телеметрия: что уходит наружу ─────────────────────────
  // Наружу уходит состав журнала попыток и структурный снимок страницы. Переписки
  // и секретов там нет по построению: снимок считает элементы и длины, а не текст
  // реплик, а строки проходят через healRedact.
  const HEAL_SECRET_PATTERNS = [
    [/ntn_[A-Za-z0-9]{10,}/g, "ntn_<скрыт>"],
    [/secret_[A-Za-z0-9]{10,}/g, "secret_<скрыт>"],
    [/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_<скрыт>"],
    [/gh[pousr]_[A-Za-z0-9]{10,}/g, "gh_<скрыт>"],
    [/sk-[A-Za-z0-9]{12,}/g, "sk-<скрыт>"],
    [/[Bb]earer\s+[A-Za-z0-9._-]{8,}/g, "Bearer <скрыт>"],
    [/([?&](?:key|token|secret|code|auth)=)[^&\s"']+/gi, "$1<скрыт>"],
    [/[0-9a-f]{40,}/gi, "<hex>"],
  ];

  /** Строка без секретов и без query-строк: адрес остаётся, параметры — нет. */
  function healRedact(value) {
    let text = String(value == null ? "" : value);
    for (const [re, to] of HEAL_SECRET_PATTERNS) text = text.replace(re, to);
    text = text.replace(/(https?:\/\/[^\s"'<>]*?)\?[^\s"'<>]*/gi, "$1?<скрыто>");
    return text;
  }

  /** Рекурсивная очистка: телеметрия — дерево, а не одна строка. */
  function healRedactTree(value, depth = 0) {
    if (depth > 6) return "<глубоко>";
    if (typeof value === "string") return healRedact(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((x) => healRedactTree(x, depth + 1));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (/^(token|key|secret|password|authorization|cookie)$/i.test(k)) { out[k] = "<скрыт>"; continue; }
        out[k] = healRedactTree(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  function healByteLength(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    try {
      return new TextEncoder().encode(String(text)).length;
    } catch {
      return String(text).length * 2;
    }
  }

  /**
   * Собрать payload телеметрии и уложить его в лимит артефакта. Режем только
   * историю журнала и диагностику: сам инцидент и классификация остаются, иначе
   * файл бесполезен для разбора.
   */
  function buildHealTelemetry(input = {}, maxBytes = 200000) {
    const journal = Array.isArray(input.journal) ? input.journal.slice(-200) : [];
    const payload = healRedactTree({
      schema: "relay-heal/1",
      phase: String(input.phase || "stop"),
      at: String(input.at || ""),
      script: { version: String(input.version || ""), fingerprint: String(input.fingerprint || "") },
      profile: String(input.profile || ""),
      incident: input.incident || {},
      verdict: input.verdict || {},
      page: input.snapshot || {},
      journal,
    });
    const trimmed = [];
    if (healByteLength(payload) > maxBytes) {
      while (payload.journal.length && healByteLength(payload) > maxBytes) {
        trimmed.push(payload.journal.shift());
      }
      if (trimmed.length) payload.journalDropped = trimmed.length;
    }
    if (healByteLength(payload) > maxBytes) {
      payload.page = { truncated: true, url: payload.page?.url || "", path: payload.page?.path || "" };
    }
    if (healByteLength(payload) > maxBytes) payload.journal = [];
    return { payload, bytes: healByteLength(payload), dropped: Number(payload.journalDropped) || 0, fits: healByteLength(payload) <= maxBytes };
  }

  /**
   * Гейт версии: продолжать можно, только если работает сборка новее той, что
   * сломалась. Отпечатка в метаданных ScriptCat нет (`sctl get` даёт version и
   * updatedAt), поэтому признак двух: номер версии и вшитый сборкой отпечаток.
   */
  function decideVersionGate(input = {}) {
    const paused = String(input.pausedVersion || "");
    const now = String(input.nowVersion || "");
    const pausedPrint = String(input.pausedFingerprint || "");
    const nowPrint = String(input.nowFingerprint || "");
    const waited = Number(input.waitedMs) || 0;
    const timeout = Number(input.timeoutMs) || 900000;
    if (input.cancelled === true) return { ok: false, stop: true, why: "подтверждение новой версии отменено" };
    if (!now) return { ok: false, stop: true, why: "версия работающей сборки не прочитана" };
    if (paused && now === paused) {
      if (waited > timeout) return { ok: false, stop: true, why: `новая сборка не подтверждена за ${Math.round(timeout / 60000)} мин: работает прежняя ${now}` };
      return { ok: false, stop: false, why: `работает прежняя сборка ${now}: продолжение закрыто до установки новой` };
    }
    if (!paused) return { ok: true, stop: false, why: `работает ${now}: сравнивать не с чем, версия названа` };
    if (pausedPrint && nowPrint && pausedPrint === nowPrint) {
      return { ok: false, stop: true, why: "номер версии сменился, а отпечаток сборки тот же: установлен старый бандл под новым номером" };
    }
    return { ok: true, stop: false, why: `работает новая сборка ${now}` };
  }

  /** Строка сердцебиения: её читает сторож вне браузера, секретов в ней нет. */
  function heartbeatLine(input = {}) {
    const state = input.state === "paused" ? "paused" : "running";
    return ["hb", "1", String(input.version || ""), state, String(input.at || ""), String(input.fingerprint || ""), String(input.seq || 0)].join(" ");
  }

  function parseHeartbeat(text) {
    const m = String(text || "").trim().match(/^hb\s+(\d+)\s+(\S*)\s+(running|paused)\s+(\S*)\s+(\S*)\s+(\d+)$/);
    if (!m) return null;
    return { schema: Number(m[1]), version: m[2], state: m[3], at: m[4], fingerprint: m[5], seq: Number(m[6]) || 0 };
  }
