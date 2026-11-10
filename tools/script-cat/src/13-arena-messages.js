  // ───────────────────────────── сообщения чата ─────────────────────────────
  function messages() {
    return [...document.querySelectorAll('[data-agent-transcript-message="true"][id^="chat-message-"]')];
  }

  /**
   * Тело сообщения — последний настоящий блок `.prose`.
   *
   * В живой разметке Arena первым `[class*="prose"]` оказывается `not-prose`:
   * свёрнутая плашка «Thought for 2 seconds» с черновиком рассуждения. Из-за
   * этого ответом считалось рассуждение без маркера: шаг писал «дописывает
   * ответ» и готовил напоминание, хотя настоящий ответ с маркером лежал
   * следующим блоком.
   */
  const proseBlocks = (node) =>
    [...node.querySelectorAll(".prose")].filter(
      (el) => !el.classList.contains("not-prose") && !el.closest(".not-prose"),
    );

  function messageBody(node) {
    const blocks = proseBlocks(node);
    return blocks.at(-1) || node;
  }

  function messageText(node) {
    const prose = messageBody(node);
    const clone = prose.cloneNode(true);
    clone.querySelectorAll("button,svg,[role='alert']").forEach((n) => n.remove());
    const shown = clone.innerText?.trim() || "";
    return shown || String(clone.textContent || "").trim();
  }

  /**
   * Сырой текст сообщения — для разбора маркера.
   *
   * `textContent` не зависит от раскладки: не вставляет переносов на границах
   * абзацев и не склеивает строки так, как это делает `innerText` у detached
   * клона. Именно на этом разбор маркера и падал в живом чате.
   */
  function messageRaw(node) {
    const blocks = proseBlocks(node);
    // Разбор идёт по всем настоящим блокам: маркер может оказаться не в
    // последнем, а рассуждения из `not-prose` в него не попадают вовсе.
    return (blocks.length ? blocks : [node])
      .map((el) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll("button,svg,[role='alert']").forEach((n) => n.remove());
        return String(clone.textContent || "");
      })
      .join("\n")
      .replace(/\u00a0/g, " ");
  }

  /**
   * Наши собственные служебные сообщения (задание и напоминание) несут
   * `CF_TECH`. Их нельзя читать как ответ агента: в них есть пример маркера.
   */
  const isOwnPrompt = (raw) => /CF_TECH/.test(String(raw || ""));

  function lastMessageId() {
    const list = messages();
    return list.length ? list.at(-1).id.replace("chat-message-", "") : "";
  }

  /**
   * Страница адресата отрисована — и только тогда по ней можно судить.
   *
   * 25.10, 16:55:59–16:56:07. Мастер снял паузу после обрыва связи, скрипт
   * открыл страницу Turn Runtime, а через 8 секунд решил, что агент молчит
   * 77 минут: транскрипт ещё не отрисовался, `messagesAfter()` вернул пусто,
   * кнопка Stop не нарисована. Ожидание сняли, карточку вернули в Ready —
   * а ответ лежал в чате: агент отработал 17 м 53 с и прислал маркер.
   *
   * «Пусто на странице» и «агент молчит» — разные вещи. Пока транскрипт не
   * отрисован, о молчании не судим вовсе: это либо загрузка, либо сеть.
   */
  function pageReady(expect) {
    const state = String((typeof document !== "undefined" && document.readyState) || "");
    if (state && state !== "interactive" && state !== "complete") {
      return { ok: false, why: `страница ещё грузится (${state})` };
    }
    // Ошибка связи в самой странице: чат остаётся пустым, сколько ни жди.
    const broken = [...document.querySelectorAll('[role="alert"]')].find((el) => {
      if (!visible(el)) return false;
      const text = shortLabel(el) || String(el.textContent || "");
      return /connection|соединени|network|reconnect|переподключ/i.test(text);
    });
    if (broken) return { ok: false, why: "страница не догрузилась: нет связи" };
    const nodes = messages();
    if (nodes.length) return { ok: true, why: `сообщений ${nodes.length}` };
    // Задание отправлено и подтверждено — значит в этом чате есть как минимум
    // наша реплика. Пустой транскрипт при этом значит одно: список сообщений
    // ещё не смонтирован. 25.10 в 17:47 поле ввода уже было, сообщений 0 —
    // и скрипт по нажатому «Шагу» написал «маркера этой выдачи в чате нет»,
    // хотя маркер лежал в чате.
    if (userMessages().length) return { ok: true, why: "свои реплики видны, транскрипт отрисован" };
    if (expect && Number(expect.sentAt)) {
      return { ok: false, why: "транскрипт ещё не отрисован: своих реплик не видно" };
    }
    // Пустой транскрипт ещё не значит «ответа нет»: у только что открытой
    // страницы поле ввода рисуется раньше истории. Готовой считаем страницу,
    // где видно поле ввода или плашку завершения, — там уже есть что читать.
    if (composer() || completionPlaque()) return { ok: true, why: "поле ввода на месте, транскрипт пуст" };
    return { ok: false, why: "ни реплик, ни поля ввода — страница не отрисовалась" };
  }

  /**
   * Приложение Arena отрисовалось — только тогда на странице можно что-то делать.
   *
   * 25.10, 17:30:24–17:30:44. Скрипт перешёл на страницу Turn Runtime и через
   * 20 секунд попытался отправить задание: поле ввода уже было, текст встал
   * (9186 символов), кнопка Send была в разметке — но `disabled`, потому что
   * транскрипт в этот момент монтировался (сообщений 0 → 18). Скрипт решил,
   * что редактор «не принял текст», вернул карточку NAR-2.12 в Ready и встал
   * на паузу. Работы по карточке не было — виновата спешка.
   *
   * Правило: пока документ не догружен, скрипт не делает ничего — ни вставки,
   * ни кликов, ни закрытия панелей. Ожидание дешевле отката карточки.
   */
  function appReady() {
    if (typeof document === "undefined") return { ok: false, why: "нет документа" };
    const state = String(document.readyState || "");
    if (state && state !== "complete" && state !== "interactive") {
      return { ok: false, why: `документ грузится (${state})` };
    }
    // Оболочка приложения: без неё на странице нечего читать и некуда писать.
    if (!document.querySelector('main, [data-agent-transcript-message], .editor-content, [role="textbox"]')) {
      return { ok: false, why: "оболочка приложения не отрисована" };
    }
    return { ok: true, why: "" };
  }

  /** Кнопка действительно готова: в документе, видима и не заблокирована. */
  async function clickReady(el, timeoutMs = C.clickReadyMs) {
    if (pressable(el)) return true;
    const found = await waitFor(() => (pressable(el) ? el : null), timeoutMs, 250);
    return Boolean(found);
  }

  /** Наша реплика: в транскрипте Arena она помечена отдельным layout. */
  const isUserNode = (n) => Boolean(n.querySelector('[data-user-message-layout="true"]'));

  /** Строка-результат: такая реплика — ответ, даже если цитирует задание. */
  const RESULT_LINE = /\bCF_(?:AGENT|COORDINATOR|REVIEW|ANSWER)_RESULT\b/;

  /**
   * Наша служебная реплика, потерявшая разметку пользователя.
   *
   * `CF_TECH` есть только в задании и напоминании, но проверять его в лоб
   * нельзя: агент вправе процитировать задание в отчёте, и тогда настоящий
   * ответ выпадал бы из чтения. Цитата с маркером остаётся ответом.
   */
  const looksLikeOwnTask = (raw) => {
    const text = String(raw || "");
    if (RESULT_LINE.test(text)) return false;
    return isOwnPrompt(text) || /^\s*(?:###\s*)?(?:Задача|НАПОМИНАНИЕ)\b/i.test(text);
  };

  /**
   * Время из id сообщения — только как подсказка «из этого хода или из
   * прошлого круга». Arena выдаёт id в формате UUIDv7 (первые 48 бит —
   * миллисекунды), но опираться на это в основной логике нельзя: у неё есть
   * сборки и с другим генератором id. Неправдоподобное время возвращает 0.
   */
  function idTime(id) {
    const hex = String(id || "").replace(/-/g, "");
    if (hex.length < 13) return 0;
    const ms = Number.parseInt(hex.slice(0, 12), 16);
    // Мусор и чужие эпохи — «времени нет». Всё, что попало в разумный
    // диапазон, считается временем сообщения: по нему видно, из этого хода
    // оно или из прошлого круга.
    const floor = Date.UTC(2020, 0, 1);
    if (!Number.isFinite(ms) || ms < floor || ms > Date.now() + 24 * 3600 * 1000) return 0;
    return ms;
  }

  /**
   * Сообщения, появившиеся ПОСЛЕ водяного знака. Водяной знак — id последнего
   * сообщения на момент отправки задания. Без него скрипт читал бы старые
   * ответы: кнопки Create/Merge PR тоже порождают сообщения агента.
   *
   * Граница считается по ПОЛНОМУ списку, вместе с нашими репликами. Прежде
   * она считалась по списку одних ответов, а водяной знак — это id нашей же
   * отправки: в отфильтрованном списке он не находился, и «новых сообщений»
   * не оставалось вовсе. Так 24.10 в 14:27 скрипт сказал «новых сообщений
   * нет», хотя ответ Build/Release с маркером лежал в чате: id сообщений
   * Arena не упорядочены по времени (ответ `01a16da4-10b2…` пришёл позже
   * запроса `01a16da4-1dc9…`, но меньше его).
   */
  function messagesAfter(watermark, seen) {
    const all = messages();
    const one = (n) => ({ id: nodeId(n), text: messageText(n), raw: messageRaw(n), ended: replyEnded(n) });

    let cut = -1;
    if (watermark) cut = all.findIndex((n) => nodeId(n) === watermark);
    if (cut === -1 && Array.isArray(seen) && seen.length) {
      // Водяного знака в разметке нет (транскрипт перерисовали) — границу
      // держит снимок id, снятый перед отправкой.
      const known = new Set(seen);
      const firstNew = all.findIndex((n) => !known.has(nodeId(n)));
      cut = firstNew === -1 ? all.length - 1 : firstNew - 1;
    }
    const tail = cut >= 0 ? all.slice(cut + 1) : all;

    const list = tail.filter((n) => !isUserNode(n) && !looksLikeOwnTask(messageRaw(n))).map(one);
    if (list.length) return list;
    return rescueReplies();
  }

  /**
   * Страховка от ошибки в границе: ответ агента с маркером ТЕКУЩЕЙ выдачи.
   *
   * Проверки две и обе обязательны: маркер ссылается на нашу выдачу, а само
   * сообщение — из этого хода, а не из прошлого круга (id-время, допуск
   * две минуты). Порядок в разметке здесь не используется: ответ может
   * оказаться и выше нашего задания.
   *
   * Смысл: молчаливое «новых сообщений нет» при лежащем в чате ответе
   * недопустимо, поэтому ответ ищется ещё и по маркеру.
   */
  function rescueReplies() {
    const waiting = GM_getValue(K.expect, null);
    const ref = norm(waiting && waiting.ref);
    if (!ref) return [];
    const since = Number((waiting && (waiting.sentAt || waiting.at)) || 0);
    const all = messages();
    const one = (n) => ({ id: nodeId(n), text: messageText(n), raw: messageRaw(n), ended: replyEnded(n) });
    // Ответ этого хода стоит НИЖЕ нашего последнего задания. Это главная
    // защита от прошлого круга: ответ по той же карточке (Rework) в старом
    // месте разметки не должен сойти за новый.
    let from = 0;
    let sawTask = false;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (isUserNode(all[i])) {
        from = i + 1;
        sawTask = true;
        break;
      }
    }
    const mine = (m) => {
        const result = parseMarker(m.raw, "CF_AGENT_RESULT") || parseMarker(m.raw, "CF_COORDINATOR_RESULT") ||
          parseMarker(m.raw, "CF_REVIEW_RESULT") || parseMarker(m.raw, "CF_ARBITER_RESULT");
      if (!result) return false;
      const ids = [result.dispatch_id, result.turn_id, result.mission_id].map(norm);
      if (!ids.includes(ref)) return false;
      const at = idTime(m.id);
      return !(since && at && at < since - 120000);
    };
    let found = all.slice(from).filter((n) => !isUserNode(n)).map(one).filter(mine);
    if (!found.length && !sawTask) {
      // Наших реплик в разметке нет — место ответа взять неоткуда, остаётся
      // маркер вместе с временем id.
      found = all.filter((n) => !isUserNode(n)).map(one).filter(mine);
    }
    if (!found.length) return [];
    const last = found.at(-1);
    logThrottled(
      `rescue:${ref}:${last.id}`,
      `Ответ «${(waiting && waiting.roleName) || (waiting && waiting.roleId) || ""}» найден по маркеру выдачи ` +
        `(сообщение ${last.id}): граница «после отправки» его пропускала. Ответ принят, повторять работу не нужно.`,
      false,
      C.longWaitNoticeMs,
    );
    return found;
  }

  const nodeId = (n) => n.id.replace("chat-message-", "");

  /**
   * Ответ закончен — по разметке Arena, а не по таймеру.
   *
   * Внизу завершённого ответа стоит `data-latest-assistant-response-bottom`,
   * а у времени ответа есть подпись «Response ended …». Это точный признак:
   * не нужно ждать 20 секунд «стабильности», чтобы прочитать уже готовый
   * ответ. Пока агент печатает, подписи нет.
   */
  function replyEnded(node) {
    if (!node) return false;
    const labels = [...node.querySelectorAll("[aria-label]")].map((el) => el.getAttribute("aria-label") || "");
    if (labels.some((text) => /response ended|ответ заверш|generation complete/i.test(text))) return true;
    const bottom = document.querySelector('[data-latest-assistant-response-bottom="true"]');
    if (!bottom) return false;
    // Узел идёт в документе раньше отметки о конце ответа.
    return Boolean(node.compareDocumentPosition(bottom) & 4);
  }

  /**
   * Вырезает первый сбалансированный JSON-объект, начиная с ближайшей `{`.
   *
   * Раньше маркер искался по строкам `innerText`. Это ломалось на живой
   * разметке: `innerText` у клона (а `messageText` клонирует узел) может
   * склеить абзацы, переносы внутри `{"..."}` рвут JSON, а пояснение вокруг
   * маркера добавляет хвост в ту же строку. Скобочный разбор не зависит от
   * того, как браузер разложил текст.
   */
  function braceJson(rest) {
    const start = rest.indexOf("{");
    if (start === -1 || start > 400) return "";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < rest.length; i += 1) {
      const ch = rest[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return rest.slice(start, i + 1);
      }
    }
    return "";
  }

  /** JSON из маркера: пробуем как есть, затем с переносами и HTML-сущностями. */
  function markerJson(raw) {
    const variants = [
      raw,
      raw.replace(/\s*\n\s*/g, " "),
      raw
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&"),
    ];
    for (const text of variants) {
      try {
        return JSON.parse(text);
      } catch {
        /* пробуем следующий вариант */
      }
    }
    // Ступень 4: «почти JSON». Агент пишет по памяти и ставит одинарные
    // кавычки, типографские кавычки вокруг ключа или запятую перед закрытием.
    // Это всё ещё его ответ с его ID — отказываться от него из-за кавычки
    // значит звать Мастера там, где работа уже сделана.
    const loose = variants
      .map((text) =>
        text
          .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
          .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
          .replace(/,\s*([}\]])/g, "$1")
          .replace(/([{,]\s*)'([^'\\\n]{1,80})'(\s*:)/g, '$1"$2"$3')
          .replace(/(:\s*)'([^'\\\n]*?)'(\s*[,}])/g, '$1"$2"$3'),
      );
    for (const text of loose) {
      try {
        return JSON.parse(text);
      } catch {
        /* следующий вариант */
      }
    }
    return null;
  }

  /**
   * Шаблонное значение (`<роль|done>`, `<путь>`, `<решение: …>`) — это наш же
   * пример из задания или напоминания, а не ответ агента. Такой «маркер» не
   * принимаем: иначе собственный промпт засчитывается как готовый ответ.
   *
   * Ловим пару скобок вокруг описания, а не знак «меньше» вообще. Прежнее
   * правило искало `[<>]` в любом месте строки и требовало, чтобы всё
   * значение было ASCII-путём: живой ответ «6<7, порог не достигнут»
   * (кириллица, пробелы) попадал в «шаблоны» и молча выбрасывался.
   * 28.10 18:19 приёмка трижды «ответила без маркера» именно из-за «6<7»:
   * маркер был, а разбор его отклонял — и в журнале это выглядело как
   * отсутствие маркера.
   *
   * D-100: проверять «шаблонность» надо там, где стоит пометка пустого поля.
   * 10.11 09:47 приёмка ответила настоящим маркером, но в прозе ответа была
   * цитата нашего же правила — `FIXED <что именно исправлено и в какой
   * сборке>`. Скобки в прозе `answer` сделали шаблоном весь маркер: два
   * напоминания, пауза и потерянный разбор. Пустоту поля видно по подписи
   * внутри `<комментарий>` — именно её подставляет шаблон. Проза — не
   * шаблон, что бы в ней ни цитировали, и кириллица внутри скобок не признак
   * подписи: `<уточнить>` — живое значение, а не пример.
   */

  /**
   * Поля-идентификаторы: здесь всегда UUID (или пусто). Угловая скобка в ID —
   * признак примера из промпта `<dispatch_id>`, `<mission_id>`, как бы она ни
   * выглядела внутри: живой ID латиницу в скобках не несёт.
   */
  const ID_FIELDS = new Set([
    "mission_id", "dispatch_id", "run_id", "turn_id", "question_id", "request_id", "id",
  ]);

  /**
   * Шаблонная ли строка.
   *
   * D-100: шаблон — это значение, которое ЦЕЛИКОМ является подписью (`<путь>`,
   * `<роль|done>`, `<чего не хватает: роль, доступ>`), либо скобки в поле-ID.
   * Скобки внутри живой прозы шаблоном не считаются: 10.11 09:47 приёмка
   * процитировала в ответе наше же правило «FIXED <что именно исправлено>», и
   * разбор, искавший `<…>` в любом месте строки, объявил шаблоном весь маркер —
   * два напоминания и пауза при готовом ответе.
   *
   * Все наши примеры маркеров подпись ставят целиком (report, summary, answer,
   * reason, next, pr), поэтому потерянного прикрытия нет: пример из промпта
   * по-прежнему отклоняется, а проза agent'а — нет.
   */
  const placeholderShape = (value, field = "") => {
    const text = String(value || "").trim();
    if (!text) return false;
    if (ID_FIELDS.has(field)) return /<[^<>\n]{1,200}>/.test(text);
    return /^<[^<>\n]{1,200}>$/.test(text);
  };

  function isPlaceholderMarker(obj) {
    // Поле решает, а не значение само по себе: подпись пустого поля стоит в
    // данных и в ID, а вердикт — закрытый список, шаблона там быть не может.
    return Object.entries(obj || {}).some(([field, v]) => typeof v === "string" && placeholderShape(v, field));
  }

  /**
   * «Лестница» чтения маркера (D-067).
   *
   * 07.11.2026, 16:56. Координатор ответил по делу, но последняя строка была
   * JSON-ом без имени маркера:
   *   {"next":"Contract Architect","question":{"id":"SYN3-ADR-V2-FRAMES-0",…}}
   * Разбор искал только литерал `CF_COORDINATOR_RESULT`, не находил его — и
   * цикл трижды просил «не хватило последней строки», хотя строка была. Агент
   * повторял ровно тот же хвост, и через два напоминания шаг встал на паузу
   * при полностью информативном ответе.
   *
   * Поэтому маркер ищется по ступеням, от строгой к мягкой:
   *   1. точное имя + JSON (как было);
   *   2. имя написано иначе — регистр, дефисы, подчёркивания, лишние пробелы;
   *   3. имени нет, но JSON несёт характерный набор ключей этого маркера;
   *   4. «почти JSON» — разбор в `markerJson`.
   *
   * Мягкие ступени ничего не разрешают сами по себе: идентичность (ID этой
   * выдачи, mission_id этой миссии, next — существующая роль) по-прежнему
   * проверяет вызывающий, и его отказ остаётся отказом. Поэтому ступени идут
   * после строгой: разбор, а не доверчивость.
   */
  // Пары ключей — «подпись» маркера: по ней узнаём JSON без имени. Порядок
  // важен: первым идёт более узкая подпись, иначе арбитраж с dispatch_id был бы
  // принят за сдачу карточки.
  const MARKER_STEPS = {
    CF_ANSWER_RESULT: [["question_id"]],
    CF_AGENT_PROVISION_RESULT: [["request_id"], ["jobs"]],
    CF_ARBITER_RESULT: [["verdict", "action"], ["action", "fix"]],
    CF_REVIEW_RESULT: [["verdict"]],
    // У сдачи карточки нет вердикта: вердикт — это приёмка или арбитраж, и
    // подписи ниже не пересекаются с ними именно поэтому (без этого вердикт с
    // dispatch_id/run_id засчитывался бы как ответ исполнителя — проверено
    // пробой relay-review-dispatch-integration).
    CF_AGENT_RESULT: [["dispatch_id", "status"], ["dispatch_id", "run_id"], ["dispatch", "run"], ["run_id", "status"]],
    CF_COORDINATOR_RESULT: [["next"]],
  };
  const MARKER_NAMES = Object.keys(MARKER_STEPS);

  /** Похож ли объект на этот маркер: характерный набор ключей. */
  const looksLikeMarker = (obj, name) => {
    const o = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
    const pairs = MARKER_STEPS[name] || [];
    if (!o || !pairs.length) return false;
    if (Object.keys(o).length > 14) return false;
    return pairs.some((keys) => keys.every((k) => k in o));
  };

  /** Объект подходит хоть одному маркеру — и если да, то какому (по порядку). */
  const markerOwner = (obj) => MARKER_NAMES.find((name) => looksLikeMarker(obj, name)) || "";

  /**
   * Последний настоящий JSON-объект текста: ответ мог быть без имени, но с JSON.
   *
   * Берём `{` только на нулевой глубине. Иначе «последняя скобка» оказывается
   * вложенным объектом: у живого ответа Координатора
   * `{"next":…,"question":{"id":…,"default":"A"}}` разбор доставал внутренний
   * `question` — и вместо решения получался «JSON без next».
   */
  function lastJsonObject(text) {
    const src = String(text || "");
    const starts = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") {
        if (depth === 0) starts.push(i);
        depth += 1;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
    for (let k = starts.length - 1; k >= 0; k -= 1) {
      const raw = braceJson(src.slice(starts[k]));
      const obj = markerJson(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return { obj, raw };
    }
    return null;
  }

  /**
   * Имя маркера в мягком написании: `cf-coordinator-result`, `CF COORDINATOR
   * RESULT`, `CF_COORDINATOR_RESULT`. Возвращает позицию находки или -1.
   *
   * Ступень 2 нужна из-за живых случаев: агент «переписывает» имя по-своему и
   * получает «маркера нет» при готовом решении.
   */
  function looseMarkerAt(text, name) {
    const src = String(text || "");
    const core = name.replace(/^CF_/, "");
    const pattern = core.split("_").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]*");
    const rx = new RegExp(`CF[\\s_-]*${pattern}`, "gi");
    let last = -1;
    let m;
    while ((m = rx.exec(src))) {
      last = m.index;
      if (m[0].length === 0) rx.lastIndex += 1;
    }
    return last;
  }

  /**
   * Почему последний разбор не сложился: по имени маркера храним причину и
   * начало отвергнутого JSON. Журналу это нужно, чтобы «маркер есть, но он
   * отвергнут как шаблон» не сливалось с «маркера нет» — разные беды и чинятся
   * по-разному.
   */
  const markerNotes = {};

  function parseMarker(text, name) {
    const src = String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n?/g, "\n");
    if (!src.trim()) {
      delete markerNotes[name];
      return null;
    }

    // ── ступень 1: точное имя + JSON (прежнее поведение, без изменений) ──
    let from = src.length;
    let rejected = "";
    while (from > 0) {
      const at = src.lastIndexOf(name, from - 1);
      if (at === -1) break;
      const raw = braceJson(src.slice(at + name.length));
      const obj = markerJson(raw);
      if (obj && !isPlaceholderMarker(obj)) {
        delete markerNotes[name];
        return obj;
      }
      if (obj && !rejected) rejected = raw.replace(/\s+/g, " ").trim().slice(0, 160);
      from = at;
    }
    if (rejected) {
      markerNotes[name] = { reason: "placeholder", sample: rejected, rung: 1 };
      return null;
    }

    // ── ступень 2: имя в другом написании ──
    const loose = looseMarkerAt(src, name);
    if (loose >= 0) {
      const raw = braceJson(src.slice(loose));
      const obj = markerJson(raw);
      if (obj && !isPlaceholderMarker(obj)) {
        markerNotes[name] = { reason: "loose-name", rung: 2 };
        return obj;
      }
    }

    // ── ступень 3: имени нет, но JSON несёт ключи этого маркера ──
    const tail = lastJsonObject(src);
    if (tail && !isPlaceholderMarker(tail.obj)) {
      const owner = markerOwner(tail.obj);
      // JSON засчитывается только за своим маркером: подпись должна совпасть
      // именно с ожидаемым. Чужой JSON (вердикт вместо сдачи, сдача вместо
      // решения) — не ответ на это ожидание, и подменять его нельзя.
      if (owner === name) {
        markerNotes[name] = { reason: "bare-json", rung: 3 };
        return tail.obj;
      }
      if (owner) {
        markerNotes[name] = { reason: "foreign-json", owner, sample: JSON.stringify(tail.obj).slice(0, 160), rung: 3 };
        return null;
      }
    }

    delete markerNotes[name];
    return null;
  }

  /** Пояснение к «маркера нет», если маркер был, но его отверг разбор. */
  const markerRejectHint = (name) => {
    const note = markerNotes[name];
    if (!note) return "";
    if (note.reason === "placeholder") {
      return (
        ` В ответе есть ${name}, но разбор счёл его шаблоном из задания` +
        `${note.sample ? ` (${note.sample})` : ""} — это дефект разбора, а не ответ агента.`
      );
    }
    if (note.reason === "foreign-json") {
      return (
        ` Последний JSON в ответе — ${note.owner || "другой маркер"}` +
        `${note.sample ? ` (${note.sample})` : ""}: он не считается ответом на это ожидание.`
      );
    }
    return "";
  };

  /**
   * Что чинить: короткая причина для напоминания.
   *
   * Напоминание «не хватило последней строки» бесполезно, если строка есть, а
   * в ней нет имени: агент видит свой JSON и повторяет его же. Поэтому причина
   * называется точно, и по ней собирается отдельный текст напоминания.
   */
  const MARKER_REJECT_LABELS = {
    "bare-json": "no-name",
    "loose-name": "loose-name",
    "foreign-json": "foreign-json",
    placeholder: "placeholder",
  };
  const markerRejectReason = (name) => MARKER_REJECT_LABELS[markerNotes[name]?.reason] || "";

  /** Короткая подпись элемента для журнала: без разметки и лишнего текста. */
  /**
   * Полная подпись элемента — до обрезки.
   *
   * `shortLabel` режет до 60 знаков, и по обрезанному тексту нельзя отличить
   * индикатор от транскрипта: проверка «длинный текст — это транскрипт»
   * (`length > 80`) на обрезанной строке не срабатывает НИКОГДА. 09.11 так
   * завис цикл: наша же реплика «Карточка «SYN-3 · B5 · Анализатор литералов
   * fail-closed» · dispatch …» попала в `[aria-live]`, слово «Анализ» совпало с
   * шаблоном «thinking|анализ», и транспорт 12 часов считал агента работающим —
   * без ошибки и без паузы («задание из очереди подождёт, а агент ещё
   * отвечает»). Проверять длину надо по полному тексту.
   */
  const fullLabel = (el) =>
    `${el?.getAttribute?.("aria-label") || el?.getAttribute?.("title") || el?.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim();

  const shortLabel = (el) => fullLabel(el).slice(0, 60);

  /**
   * Причина «агент ещё работает» — или null.
   *
   * Раньше это были два независимых поиска, и любой ложный признак держал шаг.
   * Теперь признак один и у него есть причина, которую видно в журнале:
   *   • кнопка Stop — только с площадью, не disabled и не прозрачная;
   *   • «думающая» плашка — только короткая подпись, не свёрнутая история
   *     («Thought for 2 seconds» — это прошлое, а не работа) и не транскрипт.
   */
  /**
   * Кнопка «Stop» может быть видимой самой по себе, но лежать в скрытом
   * контейнере: в Arena панель действий сообщения гасится `opacity: 0` на
   * обёртке и проявляется при наведении. Собственная прозрачность кнопки при
   * этом — единица, площадь есть, `display` не тронут. Именно такая кнопка
   * прошлой генерации и держала шаг: «агент ещё отвечает», хотя ответ давно
   * закончен.
   */
  const hiddenByAncestor = (el) => {
    let node = el;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (node.getAttribute?.("aria-hidden") === "true") return true;
      if (node.hasAttribute?.("inert") || node.hasAttribute?.("hidden")) return true;
      const style = getComputedStyle(node);
      if (Number(style.opacity) === 0) return true;
      if (style.visibility === "hidden" || style.display === "none") return true;
      node = node.parentElement;
    }
    return false;
  };

  /** Где живёт кнопка — нужно только для понятной строки в журнале. */
  const whereIs = (el) => {
    if (!el?.closest) return "";
    if (el.closest("[data-agent-transcript-message]")) return " в сообщении";
    if (el.closest('form, footer, [class*="composer"], [data-testid*="composer"]')) return " в поле ввода";
    return "";
  };

  /**
   * Кнопка стоит в слоте отправки панели ввода. Send и Stop рисуются в одном
   * месте и помечены `data-perf-target="send"`; Мастер 24.10 прислал разметку:
   * `<button aria-label="Stop generating" data-perf-target="send">` в
   * `div.bg-surface-secondary.rounded-[14px]`.
   *
   * В покое этой кнопки в разметке нет вовсе («когда он не активен, его нигде
   * не видно»), поэтому Stop в слоте — честный признак генерации, и правило
   * «ответ закончился — значит призрак» к нему не применяется.
   */
  const composerSlot = (el) => Boolean(el?.closest?.('[data-perf-target="send"]'));

  /**
   * Кнопка Stop из уже законченного сообщения — протухшая: Arena оставляет
   * панель действий в DOM и после окончания ответа. Такой признак не должен
   * останавливать шаг, иначе «Шаг» навсегда упирается в прошлую генерацию.
   *
   * Это правило — только для кнопок в панели действий сообщения. Stop в слоте
   * отправки не протухает никогда: в покое его нет в разметке вовсе.
   */
  const stopIsStale = (el) => {
    const all = [...document.querySelectorAll("[data-agent-transcript-message]")];
    const msg = el?.closest?.("[data-agent-transcript-message]");
    // Кнопка вне сообщений — панель над полем ввода. Приписать её конкретному
    // ответу нельзя, поэтому смотрим на последний ответ: если он закончился,
    // генерации нет и это остаток прошлой отрисовки (24.10, 14:20: сразу
    // после перехода к Build/Release «Шаг» сказал «агент ещё отвечает», хотя
    // агент был спокоен, а ответ ещё не начинался). Ответа в чате ещё нет
    // вовсе (первый ход) — тогда верим кнопке.
    // Наша реплика — это вопрос, а не ответ: «закончился» к ней неприменимо.
    // Если последним в чате стоит наше задание, значит ответа ещё нет и Stop
    // настоящий.
    const last = all.at(-1);
    const answered =
      Boolean(last) && !last.querySelector?.('[data-user-message-layout="true"]') && replyEnded(last);
    if (!msg) return answered;
    if (replyEnded(msg)) return true;
    return all.length > 0 && all.at(-1) !== msg;
  };

  function busyReason() {
    // Плашка «задача выполнена» — самый точный признак покоя: Arena показывает
    // её только после законченного хода. 24.10 в 14:48 скрипт ещё считал агента
    // работающим, хотя плашка уже висела, а агент отвечал на прошлый ход.
    if (completionPlaque()) return null;
    // Сначала подпись (дешёвое чтение атрибутов), потом геометрия и стили:
    // иначе на каждый тик пересчитываются стили сотни посторонних кнопок.
    const stop = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      if (!/stop generating|остановить генерац|stop response/i.test(shortLabel(b))) return false;
      if (!visible(b) || b.disabled) return false;
      if (b.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(b);
      if (Number(style.opacity) === 0) return false;
      if (style.pointerEvents === "none") return false;
      if (hiddenByAncestor(b)) return false;
      // Stop в слоте отправки — настоящий: в покое Arena не рисует его вовсе.
      if (!composerSlot(b) && stopIsStale(b)) return false;
      return true;
    });
    if (stop)
      return {
        kind: "stop",
        label: shortLabel(stop) || "кнопка Stop",
        where: whereIs(stop),
        slot: composerSlot(stop),
      };

    const marks = document.querySelectorAll(
      '[role="status"], [aria-live], [class*="thinking"], [class*="reasoning"], [class*="typing"]',
    );
    for (const el of marks) {
      if (!visible(el)) continue;
      // Свёрнутая история рассуждений — это уже прошлое.
      if (el.closest('[data-state="closed"], .not-prose')) continue;
      // Своя реплика и транскрипт — не индикатор: транспорт сам отправляет
      // длинные задания, и они лежат в чате в контейнерах с `aria-live`.
      if (el.closest('[data-user-message-layout="true"], [data-agent-transcript-message]')) continue;
      // Длину сверяем по ПОЛНОМУ тексту: `shortLabel` режет до 60, и проверка
      // `> 80` по нему была мёртвой (09.11 — 12 часов ложной работы).
      const full = fullLabel(el);
      if (!full || full.length > 80) continue; // длинный текст — транскрипт, а не индикатор
      // Слово в кавычках или часть имени («Анализатор литералов») — не индикатор.
      // Индикатор — это короткая фраза о состоянии, а не упоминание слова.
      const label = shortLabel(el);
      if (!/^(?:\S+\s+){0,3}?(?:thinking|reasoning|typing|дума|размышл|анализ)/i.test(label)) continue;
      if (/^thought\b|^думал|^размышлял/i.test(label)) continue; // прошедшее время
      return { kind: "status", label };
    }
    return null;
  }

  const generating = () => busyReason()?.kind === "stop";

  /**
   * «Агент ещё работает» — это состояние, а не кадр.
   *
   * Сразу после перехода на страницу агента Arena успевает показать кнопку
   * Stop на время загрузки транскрипта, хотя ответ давно закончен. Один
   * мгновенный кадр не должен останавливать нажатый «Шаг»: подтверждаем
   * признак повторной проверкой через секунду. Настоящая генерация никуда не
   * денется, а ложная исчезнет — и шаг пойдёт дальше.
   */
  async function busySettled(stepMs = 1200) {
    const first = busyReason();
    if (!first) return null;
    await sleep(stepMs);
    const second = busyReason();
    if (!second) {
      dbg("Stop был мгновенным: страница ещё дорисовывалась, шаг продолжается.");
      return null;
    }
    return second;
  }

  const busyLabel = (reason) =>
    reason?.kind === "stop"
      ? `кнопка «${reason.label}»${reason.where || ""}`
      : `плашка «${reason?.label || "думает"}»`;
