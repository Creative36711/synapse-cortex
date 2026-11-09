  // ───────────────────────────── вопросы к Мастеру ─────────────────────────────
  /**
   * Вопрос — не остановка.
   *
   * 25.10 фаза 2 дала два вопроса к Мастеру, и оба «потерялись»: один жил
   * строкой в поле «Ответ» карточки, второй — предложением выбрать между двумя
   * вариантами в конце хода. Регламент (`freedom.md`) запрещал вопросы вообще, а
   * единственной законной остановкой была «нет роли». Итог: либо вопрос терялся,
   * либо стоил всего цикла — третьего не было.
   *
   * Теперь у вопроса есть место и цена. Агент пишет его полем `question` в
   * маркере и обязан назвать вариант по умолчанию: транспорт записывает строку в
   * базу «Вопросы», цикл идёт дальше по этому варианту, ответ Мастера приходит
   * на следующем ходе. Без варианта по умолчанию вопрос не принимается — иначе
   * это не вопрос, а остановка.
   */
  const Q = { wait: "Ждёт", done: "Решено", byDefault: "Принят дефолт", cancelled: "Отменён" };


  // Сторож ADR, маркер агента и повтор очереди могут писать одновременно.
  // В одной вкладке проверка дубля и POST идут последовательно; между разными
  // вкладками Notion не предоставляет атомарный compare-and-set.
  let questionWriteTail = Promise.resolve();
  function withQuestionWriteLock(work) {
    const run = questionWriteTail.then(work);
    questionWriteTail = run.catch(() => {});
    return run;
  }

  // Локальные создания/закрытия, случившиеся во время чтения Notion, не должны
  // потеряться при перезаписи снимка панели более старым ответом запроса.
  let questionRevision = 0;
  const questionChanges = new Map();
  function recordQuestionChange(id, row) {
    if (!id) return;
    questionChanges.set(id, { revision: ++questionRevision, row });
  }
  function questionClosedAfter(id, since) {
    const change = questionChanges.get(id);
    return Boolean(change && change.revision > since && !change.row);
  }
  function mergeQuestionChanges(rows, since) {
    const merged = new Map((rows || []).map((row) => [row.id, row]));
    for (const [id, change] of questionChanges) {
      if (change.revision <= since) continue;
      if (change.row) merged.set(id, change.row);
      else merged.delete(id);
    }
    return [...merged.values()];
  }

  /**
   * Единая обратная связь: одна кнопка и счётчик строк Notion со статусом
   * «Ждёт», включая предложения ADR. Новые записи уведомляются тихо один раз;
   * старые запоминаются при первом опросе. Снимок хранится в ScriptCat, чтобы
   * число было видно до ответа Notion. Опрос работает также на паузе.
   */
  const qText = (row) => row.text ?? rt(row?.properties?.["Вопрос"]);
  const qFallback = (row) => row.fallback ?? rt(row?.properties?.["По умолчанию"]);

  function openQuestions() {
    const cache = GM_getValue("cfn-q-open", null);
    return cache && Array.isArray(cache.rows) ? cache : { at: 0, rows: [] };
  }

  function paintQuestions(rows) {
    // Пробы вызывают вопросы в Node: без DOM панели нет, и это не ошибка.
    if (typeof document === "undefined") return;
    const list = rows || [];
    const badge = document.getElementById(ui.qBadge);
    if (badge) {
      badge.textContent = list.length ? String(list.length) : "";
      badge.style.display = list.length ? "inline-block" : "none";
    }
    const button = document.getElementById(ui.questions);
    if (!button) return;
    const shown = list.slice(0, 3).map((row) => {
      const fallback = qFallback(row);
      return `«${qText(row)}»${fallback ? ` (по умолчанию: ${fallback})` : ""}`;
    });
    button.title = list.length
      ? `Открытых записей обратной связи: ${list.length}. ${shown.join("; ")}${
          list.length > 3 ? `; и ещё ${list.length - 3}` : ""
        }. Нажмите, чтобы открыть базу «Обратная связь».`
      : "Открытых записей нет — база «Обратная связь» в Notion";
    button.style.background = list.length ? "#3a3320" : "#242833";
    button.style.borderColor = list.length ? "#8a6b2a" : "#343a46";
    // Свёрнутая панель показывает те же числа на своей кнопке: вопрос не
    // должен потеряться только потому, что окно сжали.
    if (typeof paintPanelChrome === "function") paintPanelChrome();
  }

  /**
   * Отметить только что созданный вопрос: снимок для панели, память о
   * показанном. Сбой здесь не должен стоить вопроса — поэтому глушим его.
   */
  function noteQuestionAsked(row, q) {
    try {
      const cache = openQuestions();
      if (!questionsSeen()) rememberQuestionSeen(cache.rows.map((item) => item.id));
      rememberQuestionSeen([row.id]);
      const item = { id: row.id, text: q.text, fallback: q.fallback, due: row.properties?.["Срок"]?.date?.start || "" };
      recordQuestionChange(row.id, item);
      GM_setValue("cfn-q-open", {
        at: cache.at || Date.now(),
        rows: [...cache.rows.filter((previous) => previous.id !== row.id), item],
      });
      paintQuestions(openQuestions().rows);
    } catch (e) {
      // Счётчик — удобство, а не работа: молча продолжаем.
    }
  }

  function questionsSeen() {
    const seen = GM_getValue("cfn-q-seen", null);
    return Array.isArray(seen) ? seen : null;
  }

  function rememberQuestionSeen(ids) {
    const seen = new Set(questionsSeen() || []);
    for (const id of ids || []) if (id) seen.add(id);
    GM_setValue("cfn-q-seen", [...seen]);
  }

  /** Храним все открытые ID и хвост закрытых, чтобы не спамить и не копить историю вечно. */
  function pruneQuestionSeen(rows) {
    const seen = questionsSeen();
    if (!seen) return;
    const open = new Set((rows || []).map((row) => row.id));
    const recent = seen.filter((id) => !open.has(id)).slice(-200);
    GM_setValue("cfn-q-seen", [...recent, ...seen.filter((id) => open.has(id))]);
  }

  /** Новая запись — тихое уведомление один раз; первый запуск не спамит. */
  function notifyNewQuestions(rows) {
    const seen = questionsSeen();
    if (!seen) {
      rememberQuestionSeen((rows || []).map((row) => row.id));
      if ((rows || []).length) log(`Открытых записей обратной связи: ${rows.length}. Смотрите базу «Обратная связь».`);
      return 0;
    }
    const fresh = (rows || []).filter((row) => !seen.includes(row.id));
    if (!fresh.length) return 0;
    rememberQuestionSeen(fresh.map((row) => row.id));
    for (const row of fresh.slice(0, 3)) {
      const fallback = qFallback(row);
      log(
        `Новая обратная связь: «${qText(row)}»${fallback ? ` — по умолчанию: ${fallback}` : ""}. Отвечает приёмка.`,
        false,
        { ntfy: "quiet", title: "Relay: обратная связь" },
      );
    }
    if (fresh.length > 3) {
      log(`И ещё ${fresh.length - 3} новых записей — откройте базу «Обратная связь».`, false, {
        ntfy: "quiet",
        title: "Relay: обратная связь",
      });
    }
    return fresh.length;
  }

  /**
   * Обновить снимок открытых вопросов. Здесь же закрываются по сроку те, у
   * кого вариант по умолчанию уже наступил: это бухгалтерия, а не работа
   * цикла, поэтому она идёт и на паузе.
   */
  async function refreshQuestions({ force = false, quiet = false } = {}) {
    // Отложенные вопросы повторяются здесь же: проверка идёт и на паузе, а
    // вопрос, который ждёт Мастера, не должен зависеть от хода цикла.
    try {
      if (typeof flushQuestionBodies === "function") await flushQuestionBodies();
      await flushQuestionQueue();
    } catch (e) {
      dbg("вопросы: очередь не обработана", e.message);
    }
    const cache = openQuestions();
    if (!force && Date.now() - cache.at < C.questionCheckMs) {
      paintQuestions(cache.rows);
      return cache.rows;
    }
    try {
      const revision = questionRevision;
      const rows = await questionRows([Q.wait]);
      const closed = new Set();
      const active = await activeMission().catch(() => null);
      if (active) {
        const wanted = rt(active.properties["Миссия"]).trim();
        const mine = rows.filter((row) => {
          const value = rt(row.properties["Миссия"]).trim();
          return !questionClosedAfter(row.id, revision) && (!value || missionSame(value, wanted));
        });
        const due = expiredQuestions(mine).filter((row) => rt(row.properties["По умолчанию"]) &&
          !(typeof questionBodyPending === "function" && questionBodyPending(row.id)) &&
          !(typeof questionQueuedForRow === "function" && questionQueuedForRow(row)));
        // Скрываем только реально записанные закрытия: ошибка Notion и ADR,
        // который ждёт фактического решения, остаются видимыми и в очереди.
        await closeExpired(due, closed);
        // Строка «Ждёт» без ответа — вопрос, который ещё не передавали
        // приёмке. Проверка идёт при каждой загрузке страницы, поэтому вопрос,
        // созданный прошлой версией (или агентом без очереди), тоже доходит:
        // 28.10 строка про NAR-5 висела с 15:41 и до приёмки не дошла.
        const adopted = mine.filter(
          (row) =>
            !closed.has(row.id) &&
            !questionClosedAfter(row.id, revision) &&
            !rt(row.properties["Ответ"]).trim() &&
            !(typeof questionBodyPending === "function" && questionBodyPending(row.id)) &&
            !(typeof questionQueuedForRow === "function" && questionQueuedForRow(row)) &&
            !GM_getValue(answerHandoffKey(row.id), 0),
        );
        let handed = 0;
        for (const row of adopted) {
          try {
            // D-082: строка без статуса — это строка из рук агента. Её надо не
            // только передать приёмке, но и подписать: без «Ждёт» её не видит
            // ни одна проверка, включая чтение на других вкладках, и Мастер
            // видит в базе «пустой» вопрос. Подпись ставит транспорт, а не агент.
            if (!sel(row.properties?.["Статус"])) {
              try {
                await patch(row.id, { "Статус": { select: { name: Q.wait } } });
                row.properties["Статус"] = { select: { name: Q.wait } };
                log(`Строка обратной связи «${oneLine(rt(row.properties["Вопрос"]), 70)}» пришла без статуса — поставил «${Q.wait}».`, false, { ntfy: false });
              } catch (e) {
                dbg("вопросы: статус строки не поставлен", e.message);
              }
            }
            const q = typeof questionFromRowComplete === "function" ? await questionFromRowComplete(row) : questionFromRow(row);
            if (/github\.com\/[^\s]+\/docs\/decisions\//i.test(String(q.url || "")) &&
                !/\bCF_ADR_CONTENT\s+[0-9a-f]{40}\b/i.test(String(q.fullText || ""))) {
              logThrottled(`adr-body:${row.id}`, "Предложение из репозитория ещё не содержит полный текст с SHA. Не передаю его приёмке до безопасного дополнения страницы.", true);
              continue;
            }
            if (handWaitingRow(row, q, { roleName: "Relay (транспорт)", mission: wanted })) handed += 1;
          } catch (e) {
            dbg("вопросы: полный материал не прочитан — приёмку не вызываю", e.message);
            logThrottled(`question-body:${row.id}`, `Не удалось полностью прочитать материал вопроса «${rt(row.properties["Вопрос"])}» в Notion: приёмке его пока не передаю. Проверьте страницу.`, true);
          }
        }
        if (handed) {
          log(
            // D-069: здесь вопрос только попадает в локальную очередь приёмки —
            // ход уходит отдельным шагом. Прежняя строка «поставил в очередь,
            // она ответит на ближайшем шаге» рядом с «вопрос передан приёмке»
            // читалась как вторая передача того же вопроса.
            `Вопросов «Ждёт» без ответа, которые приёмке ещё не передавались: ${handed} — ` +
              "поставил в очередь приёмки, ход уйдёт отдельным шагом.",
            false,
            { ntfy: "quiet", title: "Relay: вопрос передан приёмке" },
          );
        }
      }
      const open = mergeQuestionChanges(rows
        .filter((row) => !closed.has(row.id))
        .map((row) => ({
          id: row.id,
          text: qText(row),
          fallback: qFallback(row),
          due: row.properties?.["Срок"]?.date?.start || "",
        })), revision);
      GM_setValue("cfn-q-open", { at: Date.now(), rows: open });
      paintQuestions(open);
      if (!quiet) notifyNewQuestions(open);
      pruneQuestionSeen(open);
      return open;
    } catch (e) {
      dbg("вопросы: список не обновлён", e.message);
      paintQuestions(cache.rows);
      return cache.rows;
    }
  }

  let questionsWatch = 0;
  function watchQuestions() {
    if (typeof projectApproved === "function" && !projectApproved()) return;
    if (questionsWatch) return;
    questionsWatch = window.setInterval(() => {
      if (!document.getElementById("cfn-projects")) refreshQuestions().catch(() => {});
    }, C.questionCheckMs);
    refreshQuestions().catch(() => {});
  }


  /** Одна строка без переводов и лишних пробелов — Notion не любит простыни. */
  const oneLine = (value, max) =>
    String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);

  /** Только HTTP(S)-ссылка: остальные значения не отправляем в поле URL Notion. */
  const questionUrl = (value) => {
    try {
      const url = new URL(String(value || "").trim());
      return ["https:", "http:"].includes(url.protocol) && url.href.length <= 2000 ? url.href : "";
    } catch (e) {
      return "";
    }
  };

  /** Если в тексте указан ADR, делаем ссылку даже у старого маркера без url. */
  const questionMaterial = (url, text) => {
    const supplied = questionUrl(url);
    if (supplied) return supplied;
    const files = new Set([...String(text || "").matchAll(/\bdocs\/decisions\/([\w.-]+\.md)\b/gi)]
      .map((hit) => hit[1]));
    if (files.size !== 1 || !C.repo) return "";
    const file = [...files][0];
    return `https://github.com/${C.repo}/blob/${(C.branch || "main").split("/").map(encodeURIComponent).join("/")}/docs/decisions/${encodeURIComponent(file)}`;
  };

  /**
   * Вариант ответа из маркера — строкой.
   *
   * 28.10 поле «Варианты» в «Вопросах» содержало «[object Object] ·
   * [object Object]»: агент прислал варианты объектами, а транспорт склеил их
   * через `String`. Объект без подписи — не вариант: читаем известные поля.
   */
  const optionLabel = (option) => {
    if (option == null) return "";
    if (typeof option === "string" || typeof option === "number") return String(option);
    if (typeof option !== "object") return String(option);
    for (const key of ["label", "text", "title", "name", "value", "id"]) {
      const value = option[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };

  /**
   * Заголовок вопроса: 180 символов в таблице «Вопросы» — предел читаемости.
   *
   * Раньше текст резался молча (`slice(0, 180)`), и Мастер видел оборванную на
   * полуслове фразу, не зная, что она короче исходной: 27.10 две карточки имели
   * ровно 180 символов и обрывались на «…(сейчас это да». Теперь рез идёт по
   * границе слова, а многоточие прямо говорит, что текст длиннее. Сам текст
   * целиком уходит в тело страницы (`appendQuestionBody`), а не теряется.
   */
  const questionTitle = (value, max) => {
    const flat = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (flat.length <= max) return flat;
    const cut = flat.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    const head = (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
    return `${head}…`;
  };

  /** Полный материал не режем: избыточный маркер требует ручной проверки. */
  function fullQuestionText(value) {
    const text = String(value == null ? "" : value).trim();
    const limit = Number(C.questionTextFull) || 12000;
    if (text.length > limit) {
      const error = new Error(`Полный вопрос превышает ${limit} знаков: не записан и не передан приёмке. Сохраните материал в Notion и разберите ход вручную.`);
      error.relay = "question-too-long";
      throw error;
    }
    return text;
  }
  /**
   * Полный текст варианта по умолчанию. Предела в 200 знаков больше нет.
   *
   * 08.11, 20:01 боевой SYN-3 встал на нём: агент дал полный и безобидный
   * вариант — «Одним PR Warden'а: ТЗ SYN-3 1.5 (ярлык, строка V-2 1/60/120,
   * сноска о неисполнимости 0), очередь 1.7, D-070 и страница миссии…» — а
   * транспорт отказался его записывать: «Вопрос или вариант по умолчанию
   * слишком длинный: ничего не усекал и приёмке не передал».
   *
   * D-072. Резать вариант нельзя: по нему идёт работа, и «сокращённый» вариант — это
   * другое решение. Места в Notion хватает: поле «По умолчанию» — rich_text,
   * длинный текст уезжает несколькими объектами (richText), а тело вопроса
   * отдельно живёт в блоке страницы. Поэтому предел теперь только физический —
   * `questionTextFull`, как у самого вопроса; выше него по-прежнему честная
   * пауза, а не молчаливое усечение.
   */
  function questionFallback(value) {
    const text = String(optionLabel(value) || "").replace(/\s+/g, " ").trim();
    const limit = Number(C.questionTextFull) || 12000;
    if (text.length > limit) {
      const error = new Error(`Вариант по умолчанию длиннее ${limit} знаков: он не может быть применён без полного текста. Разберите ход вручную.`);
      error.relay = "question-too-long";
      throw error;
    }
    return text;
  }
  function questionOptions(raw) {
    const all = Array.isArray(raw) ? raw.map((option) => String(optionLabel(option) || "").replace(/\s+/g, " ").trim()).filter(Boolean) : [];
    fullQuestionText(all.join("\n")); // ни один длинный вариант не усекать молча
    return all;
  }
  function questionWithOptions(text, all) {
    const full = fullQuestionText(text);
    // Для совместимости поле «Варианты» содержит не больше четырёх. Остальные
    // не теряются: вместе с полным набором они идут в тело страницы.
    return all.length > 4 ? fullQuestionText(`${full}\n\nВсе варианты из маркера:\n${all.map((item, i) => `${i + 1}. ${item}`).join("\n")}`) : full;
  }

  /**
   * Разбор поля `question` из маркера. `null` — вопроса нет.
   *
   * Жёстко только необходимое: текст и вариант по умолчанию. Остальное —
   * подробности для Мастера, их отсутствие вопрос не отменяет.
   */
  /**
   * `gate` из ответа модели — единственный признак «ход стоит».
   *
   * Модель пишет булево как придётся: `true`, `"true"`, `"да"`, `1`. Принимаем
   * все явные «да» и не считаем остановкой ничего невнятного: молчаливая
   * остановка хода дороже, чем лишний вопрос без неё.
   */
  function questionGate(raw) {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    return value === true || value === "true" || value === "да" || value === "yes" || value === 1 || value === "1";
  }

  function parseQuestion(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const text = questionTitle(raw.text, C.questionTextMax);
    const fallback = questionFallback(raw.default);
    if (!text || !fallback) return null;
    const allOptions = questionOptions(raw.options);
    const fullText = questionWithOptions(raw.text, allOptions);
    const options = allOptions.slice(0, 4);
    // D-080: `gate` — единственный признак «мне нужен ответ, чтобы продолжить».
    // Раньше таким признаком был сам вопрос: любой вопрос переключал ход на
    // приёмку, и цикл стоял до ответа, хотя промпт обещал «работа идёт по
    // default». Теперь вопрос по умолчанию НЕ останавливает ход, а остановку
    // просит явное поле (`gate: true` + `need`).
    const gate = questionGate(raw.gate);
    const need = gate ? oneLine(raw.need, 80) : "";
    return {
      text,
      fullText,
      fallback,
      options,
      url: questionMaterial(raw.url, raw.text),
      blocks: oneLine(raw.blocks, 200),
      gate,
      need,
    };
  }

  /**
   * Что на самом деле пришло в поле `question`.
   *
   * `"question":null` — обычный способ сказать «вопроса нет»: поле пишут явно,
   * чтобы маркер был полным. Пока проверка была на `!== undefined`, такой
   * маркер давал громкую ошибку «вопрос без варианта по умолчанию» при том,
   * что вопроса не было (25.10, NAR-2.15: `"question":null`, ошибка Мастеру).
   *
   *   none  — вопроса нет: поля нет, `null`, пустая строка, объект без текста;
   *   asked — вопрос с текстом и вариантом по умолчанию;
   *   text  — вопрос написан, а варианта по умолчанию нет.
   *
   * Вопрос из `text` не выбрасывается: он попадает в базу с честным вариантом
   * по умолчанию — тем, по которому работа и так идёт. Иначе Мастер получает
   * ошибку вместо вопроса.
   */
  function questionInMarker(raw, fallback) {
    if (raw === undefined || raw === null) return { kind: "none" };
    const obj = typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const rawText = typeof raw === "string" ? raw : obj.text;
    const text = questionTitle(rawText, C.questionTextMax);
    if (!text) return { kind: "none" };
    const asked = parseQuestion(raw);
    if (asked) return { kind: "asked", question: asked };
    const allOptions = questionOptions(obj.options);
    const options = allOptions.slice(0, 4);
    const gate = questionGate(obj.gate);
    return {
      kind: "text",
      question: {
        text,
        fullText: questionWithOptions(rawText, allOptions),
        options,
        url: questionMaterial(obj.url, rawText),
        blocks: oneLine(obj.blocks, 200),
        gate,
        need: gate ? oneLine(obj.need, 80) : "",
        fallback: questionFallback(fallback) || "Работа идёт по решению агента",
      },
    };
  }

  // D-080: сроков у обратной связи больше нет.
  //
  // Прежняя механика (`Срок` + `Принят дефолт` + `closeExpired`) задумывалась,
  // когда вопросы ждали Мастера сутками. С 1.4.80 на вопрос отвечает приёмка,
  // и отвечает за один ход: срок не успевал сработать ни разу, а в базе и в
  // промпте создавал третью, несуществующую модель («молчание = решение»).
  // Поэтому транспорт больше не пишет `Срок` и не закрывает строки по времени:
  // открытый вопрос остаётся открытым, пока на него не ответят.
  // Поле `Срок` в самом Notion не удаляется — это история; его просто никто не
  // читает (Notion не умеет надёжно удалять свойства, а история нужна).
  /** Строки, которые старый транспорт закрывал по сроку: только для отчёта. */
  function expiredQuestions(rows) {
    return (rows || []).filter((row) => {
      if (sel(row.properties?.["Статус"]) !== Q.wait) return false;
      return Boolean(row.properties?.["Срок"]?.date?.start);
    });
  }

  /** Строка об открытых вопросах: чтобы Координатор не задавал их снова. */
  function openQuestionsLine(rows) {
    const all = rows || [];
    if (!all.length) return "";
    const shown = all
      .slice(0, C.questionLineMax)
      .map((row) => `«${rt(row.properties["Вопрос"])}» (по умолчанию: ${rt(row.properties["По умолчанию"])})`);
    const more = all.length > shown.length ? `; и ещё ${all.length - shown.length}` : "";
    const head = "Обратная связь без ответа (вопросы и предложения): ";
    // Хвост — не украшение: без него агент примет сжатый текст за полный вопрос.
    // Поэтому при сжатии он уходит вперёд, вместе с отметкой (D-078).
    const tail = " Ответ придёт на следующем ходе — не задавай их снова и не останавливайся.";
    // Вторая половина общего порога — открытым вопросам. Без этого деления
    // каждая часть держалась в своём пороге, а вместе они давали 3904 и план
    // снова упирался в предел профиля (D-078).
    return head + fitBrief(shown, more, `${head}${tail}`, all.length, Math.floor(C.answerBriefMax / 2)) + tail;
  }

  /** Строка с ответами Мастера, которые агенту ещё не показывали. */
  function answersLine(rows) {
    const all = rows || [];
    if (!all.length) return "";
    const shown = all.slice(0, C.questionLineMax).map((row) => {
      const byDefault = sel(row.properties["Статус"]) === Q.byDefault;
      const title = rt(row.properties["Вопрос"]);
      const answer = rt(row.properties["Ответ"]);
      const hint = byDefault
        ? /\bADR\b|docs\/decisions\//i.test(`${title} ${row.properties?.["Материал"]?.url || ""}`)
          ? " (срок истёк: это только default, фактического решения приёмки по ADR нет)"
          : " (срок истёк, принят вариант по умолчанию)"
        : "";
      return `«${title}» → ${answer}${hint}`;
    });
    const more = all.length > shown.length ? `; и ещё ${all.length - shown.length}` : "";
    const head = "Ответы на обратную связь от Мастера и приёмки — учти их в этом ходе: ";
    // Половина общего порога — ответам, половина — открытым вопросам и журналу:
    // так обе части влезают вместе, а не по отдельности (см. fitBrief).
    return head + fitBrief(shown, more, head, all.length, Math.floor(C.answerBriefMax / 2));
  }

  /**
   * D-080: ответы на вопросы КОНКРЕТНОЙ роли — для её собственного промпта.
   *
   * `answersLine` собирает ответы для плана Координатора и берёт всё подряд.
   * Исполнителю и аудитору нужны только их строки: ответ на чужой вопрос — не
   * его дело, а в бюджет он влезает как обычный балласт. Строка-источник
   * (`Роль` в базе) пишется транспортом при записи вопроса, поэтому фильтр
   * точный, а не по догадке.
   */
  function answersMineLine(rows, roleName) {
    const mine = String(roleName || "").trim();
    if (!mine) return "";
    const own = (rows || []).filter((row) => norm(rt(row.properties?.["Роль"])) === norm(mine));
    if (!own.length) return "";
    const shown = own.slice(0, C.questionLineMax).map((row) => {
      const title = rt(row.properties["Вопрос"]);
      const answer = rt(row.properties["Ответ"]);
      return `«${title}» → ${answer}`;
    });
    const more = own.length > shown.length ? `; и ещё ${own.length - shown.length}` : "";
    // Тот же общий порог брифинга: ответы — данные, и они не должны съесть
    // инструкции профиля (D-078). Половина порога — как у answersLine.
    return fitBrief(shown, more, "", own.length, Math.floor(C.answerBriefMax / 2));
  }

  /**
   * D-078: брифинг сжимается, данные — нет.
   *
   * 11.01 боевой план Координатора не собрался: total 8178 при пределе 7500,
   * из них answers.delta 3346. Отказ был честный (D-034: молча не режем), но
   * цена — остановка всего хода из-за размера ответов Мастера, а не из-за их
   * содержания. Длину ответа транспорт не ограничивает (D-072), поэтому блок
   * рос без потолка и однажды упёрся в предел профиля.
   *
   * Правило: пока брифинг влезает в C.answerBriefMax — он идёт целиком. Не
   * влезает — каждая строка сокращается до читаемого начала (сколько успело),
   * полнота переносится в Notion, и это СКАЗАНО в тексте: агент не должен
   * думать, что видел ответ целиком. Это не молчаливое усечение: отметка есть,
   * адрес — есть, а суммарный размер известен.
   */
  function fitBrief(lines, more, head, total, maxOverride) {
    const list = lines || [];
    const full = `${head}${list.join("; ")}${more}.`;
    // Порог — общий на ВЕСЬ брифинг, а не на каждую его часть. `answers.delta`
    // склеивает три строки (ответы, открытые вопросы, журнал ответа); если
    // применять порог к каждой отдельно, две набитые дают 3904 и план снова
    // упирается в предел профиля — 11.01 это и случилось.
    const max = Number(maxOverride ?? C.answerBriefMax) || 0;
    if (!max || full.length <= max) return `${list.join("; ")}${more}.`;
    // Бюджет строки считается от самого порога и делится на все строки: иначе
    // «сжатый» брифинг всё равно выходил бы за max (первая версия этой правки
    // давала 3346 → 1727 при пороге 1700, потому что разделители и отметка не
    // входили в расчёт). Отметка о сжатии — фиксированная часть бюджета, её
    // длина считается по факту, а не на глаз.
    const note =
      ` Полных ответов ${total}, показаны все ${list.length} — начало, сжато до ${max} знаков ` +
      "из-за предела промпта: полный текст ответа — в «Вопросах» Notion, открой строку перед работой.";
    const separators = Math.max(0, list.length - 1) * 2; // "; "
    const fixed = separators + more.length + 1 /* точка */ + note.length;
    const budget = Math.max(60, Math.floor((max - fixed) / Math.max(1, list.length)));
    const mark = "… (кратко)";
    const short = list.map((line) => {
      if (line.length <= budget) return line;
      return `${line.slice(0, Math.max(0, budget - mark.length)).trimEnd()}${mark}`;
    });
    return `${short.join("; ")}${more}.${note}`;
  }

  /** Свойства строки базы «Вопросы». */
  /**
   * `Тип` строки: «Предложение» — всё, что про ADR, остальное «Вопрос».
   *
   * Правило то же, что несла формула в живой базе: ссылка на `docs/decisions/`
   * или явное слово «предложение»/«ADR». Поле не влияет на решения — это
   * подсказка Мастеру и Координатору, поэтому правило простое и проверяемое.
   */
  function questionType(q) {
    if (q && q.proposal) return "Предложение";
    const text = `${(q && q.text) || ""} ${(q && q.url) || ""} ${(q && q.fullText) || ""}`;
    return /docs\/decisions\/|предложени|\badr\b/i.test(text) ? "Предложение" : "Вопрос";
  }

  function questionProps(q, ctx = {}) {
    const text = (value) => ({ rich_text: richText(value) });
    const props = {
      "Вопрос": { title: [{ type: "text", text: { content: q.text } }] },
      "Статус": { select: { name: Q.wait } },
      "По умолчанию": text(q.fallback),
      // D-080: `Срок` больше не пишется — механики сроков нет (см. комментарий
      // у expiredQuestions). Поле остаётся в базе как история старых строк.
      "Роль": text(ctx.roleName || ""),
      "Карточка": text(ctx.card || "—"),
      // D-082: в «Миссию» идёт имя миссии, а не что попало. Раньше значение
      // брали из того, что пришло в ctx, и туда мог попасть голый UUID —
      // сравнение `missionSame` работает по словам названия, UUID им не был, и
      // строка переставала быть «своей» для той же миссии (09.11: два
      // предложения Координатора так и не дошли до Warden).
      "Миссия": text(missionLabel(ctx.mission)),
      // D-080: `Тип` — select, значение ставит транспорт. В живой базе поле было
      // формулой с ровно этим правилом; select делает то же самое, но его видно
      // в схеме и он не спорит с проверкой подключения.
      "Тип": { select: { name: questionType(q) } },
    };
    // D-081: `gate` обязан пережить запись. Раньше он жил только в промпте и в
    // памяти хода, а строка базы о нём не знала: `questionFromRow` пробовал
    // угадать остановку по словам «ждёт ответа» в «Что блокирует», но транспорт
    // этого текста никогда не писал. Итог — вопрос, который агент пометил как
    // остановку, при чтении из базы становился обычным, и приёмку никто не звал.
    //
    // Отметка дописывается к «Что блокирует», а не заменяет его: это то же
    // поле, которое видит Мастер в Notion, и оно остаётся читаемым.
    // Отметка «ждёт ответа» — переносчик `gate` в базу (D-081). Строка, а не
    // константа: пробы собирают эти функции из бандла по фрагментам и внешних
    // `const` не видят — тогда `questionProps` падал бы с ReferenceError.
    const blocks = [q.blocks, q.gate ? "ждёт ответа" : ""].filter(Boolean).join(" · ");
    if (blocks) props["Что блокирует"] = text(blocks);
    if (q.options.length) props["Варианты"] = text(q.options.join(" · "));
    const url = questionMaterial(q.url, `${q.text || ""} ${q.fullText || ""}`);
    if (url) props["Материал"] = { url };
    return props;
  }

  /**
   * Полный текст вопроса — в тело страницы.
   *
   * Заголовок «Вопрос» живёт в таблице и режется до 180 символов; тело страницы
   * ограничено только размером одного rich_text-объекта (2000 знаков), поэтому
   * длинный вопрос сохраняется целиком. Ошибка этой записи вопрос не отменяет:
   * строка в базе уже создана, агент уже идёт по варианту по умолчанию.
   */
  // Незавершённое тело хранится отдельно от очереди строк. Перед повторной
  // записью читаем блоки: таймаут мог случиться ПОСЛЕ успешного PATCH.
  const questionBodies = () => {
    const items = GM_getValue("cfn-question-bodies", []);
    return Array.isArray(items) ? items : [];
  };
  const questionBodyPending = (id) => questionBodies().some((item) => item.rowId === id);
  function rememberQuestionBody(row, q, ctx, heading = "") {
    const previous = questionBodies().find((item) => item.rowId === row.id);
    if (previous && JSON.stringify(previous.q) !== JSON.stringify(q))
      throw new Error("Предыдущее дополнение вопроса ещё не записано; новое ждёт своей очереди.");
    const list = questionBodies().filter((item) => item.rowId !== row.id);
    list.push({ rowId: row.id, q, ctx: ctx || {}, heading: heading || previous?.heading || "" });
    GM_setValue("cfn-question-bodies", list);
  }
  function forgetQuestionBody(id) {
    GM_setValue("cfn-question-bodies", questionBodies().filter((item) => item.rowId !== id));
  }
  async function questionBlocks(id) {
    const rows = [], cursors = new Set();
    let cursor = "";
    while (true) {
      const page = await notion("GET", `blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!page || !Array.isArray(page.results) || typeof page.has_more !== "boolean")
        throw new Error("Notion вернул неполный список блоков вопроса.");
      rows.push(...page.results);
      if (rows.length > 300) throw new Error("В вопросе больше 300 блоков; нужна ручная проверка полного текста.");
      if (!page.has_more) return rows;
      cursor = String(page.next_cursor || "");
      if (!cursor || cursors.has(cursor)) throw new Error("Notion не вернул новый курсор блоков вопроса.");
      cursors.add(cursor);
    }
  }
  const blockText = (block) => (block?.[block?.type]?.rich_text || [])
    .map((part) => part.plain_text || part.text?.content || "").join("");

  async function appendQuestionBody(row, q, ctx = {}) {
    const full = String(q?.fullText || "").trim();
    const title = row?.properties ? rt(row.properties["Вопрос"]) : String(q?.text || "");
    if (!row?.id || !full || full === title) return true;
    // Запись в GM выполняется ДО внешнего PATCH и переживает закрытие вкладки.
    rememberQuestionBody(row, q, ctx);
    const chunks = richText(full);
    try {
      const blocks = await questionBlocks(row.id);
      let heading = questionBodies().find((item) => item.rowId === row.id)?.heading || "";
      if (!heading) {
        const main = blocks.findIndex((block) => block.type === "heading_3" && blockText(block) === "Полный текст вопроса");
        if (main >= 0 && blockText(blocks[main + 1]) === full) {
          forgetQuestionBody(row.id);
          return true;
        }
        if (main >= 0 && !ctx.allowSupplement)
          throw new Error("Тело вопроса уже изменено; автоматическую запись не повторяю.");
        let hash = 2166136261;
        for (let i = 0; i < full.length; i += 1) hash = Math.imul(hash ^ full.charCodeAt(i), 16777619);
        heading = main >= 0 ? `Дополнение к вопросу · ${(hash >>> 0).toString(16)}-${full.length}` : "Полный текст вопроса";
        // Заголовок фиксируется до PATCH: на повторе изменённый человеком блок
        // не восстанавливается поверх его правки и не дублируется.
        rememberQuestionBody(row, q, ctx, heading);
      }
      const indexes = blocks.map((block, i) => block.type === "heading_3" && blockText(block) === heading ? i : -1).filter((i) => i >= 0);
      if (indexes.length > 1) throw new Error("У материала два одинаковых заголовка; нужна ручная проверка.");
      if (indexes.length) {
        if (blockText(blocks[indexes[0] + 1]) !== full) throw new Error("Тело вопроса уже изменено; автоматическую запись не повторяю.");
      } else {
        await notion("PATCH", `blocks/${row.id}/children`, {
          children: [
            { object: "block", type: "heading_3", heading_3: { rich_text: [{ type: "text", text: { content: heading } }] } },
            { object: "block", type: "paragraph", paragraph: { rich_text: chunks } },
          ],
        });
      }
      forgetQuestionBody(row.id);
      return true;
    } catch (e) {
      dbg("вопросы: полный текст не записался", e.message);
      return false;
    }
  }

  function supplementalQuestion(q, row) {
    const props = row?.properties || {};
    const parts = [String(q?.fullText || q?.text || "")];
    const options = Array.isArray(q?.options) ? q.options.join(" · ") : "";
    if (options && options !== rt(props["Варианты"])) parts.push(`Варианты из маркера: ${options}`);
    if (q?.fallback && q.fallback !== rt(props["По умолчанию"])) parts.push(`По умолчанию из маркера: ${q.fallback}`);
    if (q?.url && q.url !== props["Материал"]?.url) parts.push(`Материал из маркера: ${q.url}`);
    return { ...q, fullText: fullQuestionText(parts.filter(Boolean).join("\n\n")) };
  }

  async function flushQuestionBodies() {
    for (const item of questionBodies()) {
      await withQuestionWriteLock(async () => {
        if (!questionBodyPending(item.rowId)) return;
        const saved = await appendQuestionBody({ id: item.rowId }, item.q, item.ctx);
        if (!saved) return;
        // Перед повторной передачей убеждаемся, что вопрос ещё ждёт ответа.
        try {
          const row = await notion("GET", `pages/${item.rowId}`);
          if (!questionQueuedForRow(row)) {
            const complete = await questionFromRowComplete(row);
            handWaitingRow(row, complete, item.ctx);
          }
        } catch (e) {
          // Блок уже мог записаться, но полную страницу мы ещё не прочитали.
          // Очередь блокирует старый неполный промпт до следующей попытки.
          queueQuestion(item.q, item.ctx || {});
          throw e;
        }
      });
    }
  }

  // Если вопрос создали вручную в Notion или очередь потерялась после
  // перезапуска, приёмка получает тело страницы, а не только короткий заголовок.
  async function questionFromRowComplete(row) {
    const base = questionFromRow(row);
    const output = [], seen = new Set(), adrBlocks = [];
    let count = 0;
    async function visit(id, depth) {
      if (depth > 4 || seen.has(id)) throw new Error("Слишком глубокая или циклическая структура вопроса Notion.");
      seen.add(id);
      for (const block of await questionBlocks(id)) {
        count += 1;
        if (count > 300) throw new Error("В вопросе больше 300 блоков; нужна ручная проверка.");
        const type = block.type;
        const rawText = blockText(block);
        const text = rawText.trim();
        if ((type === "paragraph" || type === "code") && rawText) adrBlocks.push(rawText);
        const textual = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "quote", "code", "callout", "to_do", "toggle"];
        const containers = ["table", "column_list", "column", "synced_block", "divider", "table_of_contents"];
        const attachments = ["image", "file", "pdf", "video", "audio", "embed", "bookmark", "child_page", "link_to_page"];
        if (textual.includes(type)) {
          if (text && text !== "Полный текст вопроса" && !text.startsWith("Дополнение к вопросу · ")) {
            const check = type === "to_do" ? (block.to_do?.checked ? "[x] " : "[ ] ") : "";
            const label = type === "code" ? `[Код ${block.code?.language || "plain text"}]\n` : "";
            output.push(check + label + text);
          }
        } else if (type === "table_row") {
          const cells = block.table_row?.cells;
          if (!Array.isArray(cells) || cells.some((cell) => !Array.isArray(cell))) throw new Error("Не удалось прочитать строку таблицы вопроса.");
          output.push(cells.map((cell) => cell.map((part) => part.plain_text || part.text?.content || "").join("")).join(" | "));
        } else if (type === "equation") {
          const expression = block.equation?.expression;
          if (typeof expression !== "string") throw new Error("Формула в вопросе не читается.");
          output.push(`[Формула] ${expression}`);
        } else if (attachments.includes(type)) {
          // Подпись сохраняем, а подписанный URL файла не пересылаем.
          const caption = (block[type]?.caption || []).map((part) => part.plain_text || part.text?.content || "").join("").trim();
          if (caption) output.push(caption);
          output.push(`[Материал Notion: ${type}, блок ${block.id}; открой страницу вопроса]`);
        } else if (!containers.includes(type)) {
          throw new Error(`Неподдерживаемый блок ${type || "без типа"}: проверьте материал вручную.`);
        }
        if (block.has_children) await visit(block.id, depth + 1);
      }
    }
    await visit(row.id, 0);
    const material = output.join("\n");
    if (material.length > C.questionTextFull)
      throw new Error("Текст вопроса больше предела; передайте материал ссылкой и проверьте вручную.");
    if (material) {
      if (base.url && material.includes(base.url))
        base.fullText = base.fullText.split("\n").filter((line) => line !== `Материал: ${base.url}`).join("\n");
      base.fullText = `${base.fullText}\n\nПолный материал из Notion:\n${material}`;
    }
    // Для ADR сохраняем сырые блоки до trim: Git blob включает конечные переводы строк.
    if (/github\.com\/[^\s]+\/docs\/decisions\//i.test(String(base.url || ""))) base.adrBlocks = adrBlocks;
    return base;
  }

  /**
   * Записать вопрос в базу. Ошибка Notion ход не срывает: агент уже идёт по
   * варианту по умолчанию, а строка нужна Мастеру, а не циклу.
   */
  /**
   * Вопрос, который не записался, не теряется.
   *
   * 25.10 в 21:28 Координатор задал вопрос о пределе руководства, а строки в
   * «Вопросах» не появилось: база показала 0 «Ждёт». Вопрос жил только в
   * маркере — Мастер увидел его лишь случайно, а ❓ и пуш молчали. Notion не
   * любит отвечать быстро и иногда отказывает; запись, которая уже не
   * повторится, — потерянный вопрос. Поэтому неудача складывается в очередь и
   * повторяется при следующей проверке вопросов.
   */
  const questionIntents = () => {
    const list = GM_getValue("cfn-question-intents", []);
    return Array.isArray(list) ? list : [];
  };
  const questionQueueId = (item) => JSON.stringify([
    norm(item?.q?.text || ""), String(item?.q?.fullText || ""), String(item?.ctx?.key || ""),
  ]);
  function rememberQuestionIntent(q, ctx) {
    const item = { q, ctx: ctx || {}, at: Date.now() };
    const id = questionQueueId(item);
    if (!questionIntents().some((entry) => questionQueueId(entry) === id))
      GM_setValue("cfn-question-intents", [...questionIntents(), item]);
  }
  function forgetQuestionIntent(q, ctx) {
    const id = questionQueueId({ q, ctx });
    GM_setValue("cfn-question-intents", questionIntents().filter((item) => questionQueueId(item) !== id));
  }
  // Не выдаём незавершённую строку за полный вопрос, пока POST или PATCH ещё
  // нужно восстановить. Сопоставление повторяет правила дедупликации.
  function questionQueuedForRow(row) {
    const stored = GM_getValue(K.qQueue, []);
    const pending = [...(Array.isArray(stored) ? stored : []), ...questionIntents()];
    const title = rt(row?.properties?.["Вопрос"]);
    const material = row?.properties?.["Материал"]?.url || "";
    const got = norm(title);
    const refs = adrRefsOf(`${title} ${material}`);
    return pending.some(({ q }) => {
      if (!q?.text) return false;
      const wanted = norm(q.text);
      if (got && (got === wanted || (got.length >= 60 && wanted.length >= 60 &&
          (got.startsWith(wanted.slice(0, 60)) || wanted.startsWith(got.slice(0, 60)))))) return true;
      const other = adrRefsOf(`${q.text} ${q.url || ""} ${q.fullText || ""}`);
      return [...refs].some((ref) => other.has(ref));
    });
  }
  function questionQueuedForAnswer(item) {
    return questionQueuedForRow({ properties: {
      "Вопрос": { title: [{ plain_text: item?.text || "" }] },
      "Материал": { url: item?.url || "" },
    } });
  }

  function queueQuestion(q, ctx = {}) {
    const stored = GM_getValue(K.qQueue, []);
    const list = Array.isArray(stored) ? stored : [];
    const entry = { q, ctx, at: Date.now() };
    if (q?.text && list.some((item) => questionQueueId(item) === questionQueueId(entry))) return;
    list.push(entry);
    GM_setValue(K.qQueue, list);
  }

  async function flushQuestionQueue() {
    // После перезапуска POST мог уже создать строку, не дождавшись ответа.
    // Сначала переносим намерения в обычную очередь, затем ищем строку в Notion.
    const intents = questionIntents();
    for (const item of intents) if (item?.q?.text) queueQuestion(item.q, item.ctx || {});
    if (intents.length) GM_setValue("cfn-question-intents", []);
    const stored = GM_getValue(K.qQueue, []);
    const list = Array.isArray(stored) ? [...stored] : [];
    if (!list.length) return 0;
    const left = [];
    let saved = 0;
    for (const item of list) {
      if (!item || !item.q || !item.q.text) continue;
      // Одна блокировка с обычной записью: проверка и создание не могут
      // пересечься с обнаружением того же ADR в этой вкладке.
      const outcome = await withQuestionWriteLock(async () => {
        try {
          const same = await sameQuestionRow(item.q.text, {
            automatic: Boolean(item.q.autoAdr),
            material: questionMaterial(item.q.url, item.q.fullText || item.q.text),
          });
          if (same) {
            let complete = item.q;
            if (sel(same.row.properties?.["Статус"]) === Q.wait && !rt(same.row.properties?.["Ответ"]).trim()) {
              const supplement = item.ctx?.allowSupplement ? item.q : supplementalQuestion(item.q, same.row);
              const bodySaved = await appendQuestionBody(same.row, supplement, { ...(item.ctx || {}), allowSupplement: true });
              if (bodySaved === false) return "body-pending";
              complete = await questionFromRowComplete(same.row);
            }
            // `complete` — то, что прочитано со страницы строки. Если чтение
            // недоступно (песочница пробы, сбой сети), передаём саму строку:
            // очередь приёмки должна получить вопрос, а не пустоту.
            const handled = handWaitingRow(same.row, complete || questionFromRow(same.row), item.ctx || {});
            log(
              handled
                ? `Отложенный вопрос «${item.q.text}» уже есть в «Обратной связи» и ждёт без ответа — передаю приёмке, второй строки не пишу.`
                : `Отложенный вопрос «${item.q.text}» уже есть в «Обратной связи» с ответом — не записываю второй раз.`,
              false,
              { ntfy: false },
            );
            return "existing";
          }
          const row = await notion("POST", "pages", {
            parent: { type: "data_source_id", data_source_id: C.questions },
            properties: questionProps(item.q, item.ctx || {}),
          });
          noteQuestionAsked(row, item.q);
          const bodySaved = await appendQuestionBody(row, item.q, item.ctx || {});
          if (bodySaved === false) return "body-pending";
          // D-080: восстановленный из очереди вопрос ведёт себя так же, как
          // только что заданный: держит ход только с `gate`.
          const gate = item.q.gate === true || (item.ctx || {}).forceAnswer;
          if (gate) queueAnswer(row, item.q, item.ctx || {});
          log(
            gate
              ? `Отложенный вопрос записался: «${item.q.text}» — держит ход, ждёт ответа.`
              : `Отложенный вопрос записался: «${item.q.text}» — ход идёт по «${item.q.fallback}», ответ придёт следующим промптом.`,
            false,
            { ntfy: "quiet", title: gate ? "Relay: вопрос держит ход" : "Relay: вопрос записан" },
          );
          return "saved";
        } catch (e) {
          // Ошибка проверки дубля тоже означает повтор, а не запись вслепую.
          return "retry";
        }
      });
      if (outcome === "retry") left.push(item);
      else if (outcome === "saved") saved += 1;
    }
    // В ходе сетевого запроса другая задача могла добавить новый вопрос.
    // Не затираем такие записи снимком очереди, сделанным до запроса.
    const batch = new Set(list.map(questionQueueId));
    const latest = GM_getValue(K.qQueue, []);
    const added = (Array.isArray(latest) ? latest : []).filter((item) => !batch.has(questionQueueId(item)));
    GM_setValue(K.qQueue, [...left, ...added]);
    if (left.length && saved === 0) {
      dbg("вопросы: очередь не ушла", left.length);
    }
    return saved;
  }

  /**
   * Ссылки на решения в тексте вопроса: `docs/decisions/TEAM-2.14.md` и `TEAM-2.14`.
   * Префикс проекта не фиксирован. Номер миссии (`TEAM-2`) не используется:
   * по нему склеились бы разные вопросы одной миссии.
   */
  const adrRefsOf = (text) => {
    const out = new Set();
    const src = String(text || "");
    for (const m of src.matchAll(/docs\/decisions\/([\w.-]+?)\.md/gi)) out.add(`file:${m[1].toLowerCase()}`);
    for (const m of src.matchAll(/\b[A-Z][A-Z0-9_]*-\d+\.\d+(?:-[\wА-Яа-яЁё]+)?/gi)) out.add(`adr:${m[0].toLowerCase()}`);
    return out;
  };

  /**
   * Явная пометка «это не повтор»: по одному и тому же решению Мастера можно
   * спросить второй раз, если вопрос правда другой. Без пометки повтор про
   * уже решённый ADR не создаётся и не будит Мастера.
   */
  const followUpOf = (text) => /(уточнени|ещ[её] вопрос|новый вопрос|дополнительн|вдогонку)/i.test(String(text || ""));

  /** Варианты из строки «Вопросов» — строкой в ` · `, как их пишет `questionProps`. */
  const qOptions = (row) =>
    rt(row?.properties?.["Варианты"])
      .split("·")
      .map((item) => item.trim())
      .filter(Boolean);

  /**
   * Вопрос из самой строки «Вопросов» — без новой записи.
   *
   * Нужен, когда строка уже есть, а приёмка её не видела: повторной записи не
   * делаем, передаём то, что лежит в базе.
   */
  function questionFromRow(row) {
    const text = rt(row?.properties?.["Вопрос"]);
    const options = qOptions(row);
    const fallback = rt(row?.properties?.["По умолчанию"]);
    const blocks = rt(row?.properties?.["Что блокирует"]).trim();
    const url = questionMaterial(row?.properties?.["Материал"]?.url, text);
    const full = [
      text,
      url ? `Материал: ${url}` : "",
      options.length ? `Варианты: ${options.join(" · ")}` : "",
      fallback ? `Вариант по умолчанию: ${fallback}` : "",
      blocks ? `Что блокирует: ${blocks}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    // `gate` восстанавливается по явной отметке в «Что блокирует» (её пишет
    // questionProps). Вопрос без отметки — обычный: работа идёт по default.
    //
    // D-081: прежняя проверка искала слова «ждёт ответа», которых транспорт в
    // это поле никогда не писал, поэтому остановка терялась при любом чтении
    // строки из базы. Старая формулировка оставлена как совместимость: строки,
    // созданные до 1.14.9, могли получить её руками.
    // D-081: границы слова `\b` в JavaScript считаются по ASCII, поэтому
    // `\bждёт` не совпадает никогда: кириллица для них — не слово. Прежняя
    // проверка с `\b` не срабатывала ни разу, и остановка терялась молча.
    const gate = /ждёт ответа/i.test(blocks);
    return { text, fullText: full, fallback, options, url, gate, need: "" };
  }

  /** Отметка «эту строку приёмке уже передавали» — чтобы не гонять её кругом. */
  const answerHandoffKey = (id) => `cfn-q-handoff:${id}`;

  /**
   * Строка «Ждёт» без ответа — в очередь приёмки.
   *
   * 28.10 Мастер: «висит 1 открытый вопрос, ни то ни то не ушло к тебе». Так и
   * было: скрипт видел строку в «Вопросах», считал её уже заданной и не
   * передавал приёмке ни при создании, ни после. Строка «Ждёт» с пустым
   * «Ответом» — это долг транспорта, а не ответ Мастера.
   */
  function handWaitingRow(row, q = null, ctx = {}) {
    if (!row || !row.id) return false;
    if (typeof questionBodyPending === "function" && questionBodyPending(row.id)) return false;
    // Пустой статус — это «Ждёт» из рук агента, а не ответ: строка, которую
    // создали прямо в Notion, статуса не имеет, и раньше она молча выпадала.
    const status = sel(row.properties?.["Статус"]);
    if (status && status !== Q.wait) return false;
    if (rt(row.properties?.["Ответ"]).trim()) return false;
    GM_setValue(answerHandoffKey(row.id), Date.now());
    queueAnswer(row, q || questionFromRow(row), ctx);
    return true;
  }

  /**
   * Такой вопрос уже есть в базе? Возвращает `{ row, why }` или null.
   *
   * 25.10 Мастер заметил: уведомления приходят о том, на что он уже ответил.
   * Причин было две — повторная запись того же вопроса (старый ход Координатора
   * применён второй раз) и другой текст про уже решённое решение («как решить
   * открытый ADR NAR-2.14.md?» при готовом ответе «принять F3–F5»). Поэтому
   * сравниваются и нормализованный текст, и ссылки на ADR.
   */
  async function sameQuestionRow(text, { automatic = false, material = "" } = {}) {
    const wanted = norm(text);
    if (!wanted) return null;
    const refs = adrRefsOf(`${text} ${material}`);
    try {
      const rows = await questionRows([Q.wait, Q.done, Q.byDefault]);
      for (const row of rows) {
        const raw = rt(row.properties["Вопрос"]);
        const got = norm(raw);
        if (!got) continue;
        // Ни истёкший default, ни «Решено» с пустым ответом не являются
        // фактическим решением ADR и не должны подавлять новый запрос.
        const status = sel(row.properties?.["Статус"]);
        const adr = /\bADR\b|docs\/decisions\//i.test(`${raw} ${text} ${material} ${row.properties?.["Материал"]?.url || ""}`);
        if (adr && (status === Q.byDefault || (status === Q.done && !rt(row.properties?.["Ответ"]).trim()))) continue;
        if (got === wanted) return { row, why: "text" };
        const long = wanted.length >= 60 && got.length >= 60;
        if (long && (got.startsWith(wanted.slice(0, 60)) || wanted.startsWith(got.slice(0, 60)))) return { row, why: "text" };
        // Тот же вопрос другими словами: 25.10 про открытый ADR 2.14 спросили
        // второй раз («как решить…» вместо «принять или отклонить»), и Мастер
        // получил уведомление о том, на что уже ответил. Ссылка на решение —
        // достаточный признак: вопрос про тот же ADR уже задан.
        if (refs.size && (!followUpOf(text) || automatic)) {
          const seen = adrRefsOf(`${raw} ${row.properties?.["Материал"]?.url || ""}`);
          const shared = [...refs].find((ref) => seen.has(ref));
          if (shared) return { row, why: "adr", ref: shared.replace(/^(adr|file):/, "") };
        }
      }
    } catch (e) {
      dbg("вопросы: дубль не проверен", e.message);
      throw e;
    }
    return null;
  }

  async function askQuestion(q, ctx = {}) {
    return withQuestionWriteLock(async () => {
      try {
        const key = `cfn-asked:${ctx.key || q.text}`;
        const askedBefore = GM_getValue(key, false);
        // Для обычного маркера ключ защищает от повтора хода. Сторож ADR всё
        // равно сверяет Notion: строку могли отменить или удалить после записи.
        if (askedBefore && !q.autoAdr) {
          // D-080: повтор того же вопроса не пишет строку второй раз, но
          // `gate` обязан дойти до вызывающего: иначе «этот вопрос держит ход»
          // терялся бы ровно на повторе — там, где он нужнее всего.
          return q.gate ? { id: "", text: q.text, gate: true, need: q.need || "", repeat: true } : null;
        }
        const same = await sameQuestionRow(q.text, {
          automatic: Boolean(q.autoAdr),
          material: questionMaterial(q.url, q.fullText || q.text),
        });
        if (same) {
          // Уже переданное предложение не двигаем в очереди и не уведомляем
          // повторно; если строки нет, ниже будет создана новая.
          if (askedBefore && q.autoAdr) return same.row;
          const status = sel(same.row.properties?.["Статус"]);
          const answer = rt(same.row.properties?.["Ответ"]).replace(/\s+/g, " ").trim();
          const where = same.why === "adr" ? `По решению «${String(same.ref).toUpperCase()}»` : "Такой вопрос уже задан:";
          // Строка «Ждёт» с пустым «Ответом» — это вопрос, который не дошёл до
          // приёмки. Раньше он считался «Мастер уже ответил» и второй раз не
          // записывался: 28.10 строка про NAR-5 висела с 15:41 до вечера, а скрипт
          // писал, что отвечать нечего. Теперь такая строка передаётся приёмке.
          if (status === Q.wait && !answer) {
            // Страница могла быть подготовлена человеком или другим профилем.
            // Не дублируем полный исходник: проверяем и SHA, и весь текст,
            // а не только формальный маркер или ссылку на тот же файл.
            if (q.autoAdr && /^[0-9a-f]{40}$/i.test(String(q.contentSha || "")) && q.contentText) {
              const complete = await questionFromRowComplete(same.row);
              if (complete.fullText.includes(`CF_ADR_CONTENT ${q.contentSha}`) && complete.fullText.includes(q.contentText)) {
                GM_setValue(key, Date.now());
                handWaitingRow(same.row, complete, ctx);
                log(`${where} полный материал уже есть: передаю приёмке без дублирования.`, false, { ntfy: false });
                return same.row;
              }
            }
            rememberQuestionIntent(q, ctx);
            GM_setValue(key, Date.now());
            const supplement = supplementalQuestion(q, same.row);
            const bodySaved = await appendQuestionBody(same.row, supplement, { ...ctx, allowSupplement: true });
            if (bodySaved === false) {
              forgetQuestionIntent(q, ctx); // материал уже в очереди блоков
              log(`Полный материал «${q.text}» отложен до записи в существующую строку Notion; приёмку пока не вызываю.`, true, { ntfy: "quiet" });
              return same.row;
            }
            const complete = await questionFromRowComplete(same.row);
            forgetQuestionIntent(q, ctx);
            handWaitingRow(same.row, complete, ctx);
            log(`${where} строка есть, но она «Ждёт» без ответа: «${q.text}» — передаю приёмке, второй не пишу.`, false, {
              ntfy: false,
            });
            return same.row;
          }
          GM_setValue(key, Date.now());
          log(
            `${where} приёмка уже ответила${answer ? `: «${answer.slice(0, 140)}»` : ""} — второй раз не записываю и не уведомляю.`,
            false,
            { ntfy: false },
          );
          return null;
        }
        // До POST сохраняем намерение: при обрыве ответа и перезапуске
        // сначала найдём созданную строку и допишем материал, не создавая дубль.
        rememberQuestionIntent(q, ctx);
        const row = await notion("POST", "pages", {
          parent: { type: "data_source_id", data_source_id: C.questions },
          properties: questionProps(q, ctx),
        });
        GM_setValue(key, Date.now());
        noteQuestionAsked(row, q);
        const bodySaved = await appendQuestionBody(row, q, ctx);
        if (bodySaved === false) {
          forgetQuestionIntent(q, ctx); // материал уже сохранён в очереди блоков
          log(`Полный материал вопроса «${q.text}» отложен до записи в Notion; приёмку пока не вызываю.`, true, { ntfy: "quiet" });
          return row;
        }
        forgetQuestionIntent(q, ctx);
        // D-080: приёмку зовёт только вопрос, который ДЕРЖИТ ход (`gate`).
        // Обычный вопрос записывается и живёт строкой в базе: ход идёт дальше
        // по своему варианту по умолчанию, как и обещает промпт. Раньше любой
        // вопрос переключал цикл на приёмку, и «ступор, чтобы услышать мнение»
        // выглядел так же, как «вопрос между делом», — разницы не было.
        if (!q.gate && !ctx.forceAnswer) {
          log(
            `Вопрос записан: «${q.text}». По умолчанию работа идёт по нему: ${q.fallback}. ` +
              "Ход не останавливается — ответ придёт в следующий промпт.",
            false,
            { ntfy: "quiet", title: "Relay: вопрос записан" },
          );
          return row;
        }
        // Gate: ход стоит, пока приёмка не ответит.
        queueAnswer(row, q, ctx);
        log(
          `Вопрос записан: «${q.text}». Ход ждёт ответа${q.need ? ` от «${q.need}»` : ""} — ` +
            `по умолчанию, если ответа не будет: ${q.fallback}.`,
          false,
          { ntfy: "quiet", title: "Relay: вопрос держит ход" },
        );
        return row;
      } catch (e) {
        // Запись, которая уже не повторится, — потерянный вопрос: Мастер увидит
        // его только в маркере. Поэтому строка ждёт в очереди и повторяется.
        queueQuestion(q, ctx);
        forgetQuestionIntent(q, ctx);
        log(
          `Вопрос к Мастеру в базу не записался (${e.message}). Строка отложена и повторится сама; ` +
            `пока агент идёт по варианту по умолчанию: ${q.fallback}.`,
          true,
        );
        return null;
      }
    });
  }

  /**
   * Отметить ответы доставленными — только после того, как промпт ушёл.
   *
   * D-080: отметка адресная. Пока ответы получал один Координатор, «Доставлено»
   * значило «этот ответ обработан». С 1.14.8 ответ на свой вопрос получает ещё и
   * автор вопроса, и одна общая отметка заставляла бы его получать ответ
   * бесконечно: Координатор промпт отправил — строка «доставлена» навсегда, —
   * а роль свою копию так и не увидела.
   *
   * Правило: `markDelivered(rows)` ставит дату и означает «ответ доставлен всем,
   * кому он адресован». `markDelivered(rows, now, roleName)` пишет дату только
   * если она ещё не стоит и только для строк этой роли: получатель один.
   */
  async function markDelivered(rows, now = Date.now(), roleName = "") {
    const mine = String(roleName || "").trim();
    for (const row of rows || []) {
      try {
        if (mine && norm(rt(row.properties?.["Роль"])) !== norm(mine)) continue;
        if (mine && row.properties?.["Доставлено"]?.date?.start) continue;
        await patch(row.id, { "Доставлено": { date: { start: new Date(now).toISOString() } } });
        // Своя копия строки больше не «свежая»: второй раз в тот же промпт она
        // не попадёт, даже если цикл перечитает базу раньше Notion.
        try {
          if (row.properties) row.properties["Доставлено"] = { date: { start: new Date(now).toISOString() } };
        } catch (e) {
          dbg("ответы: локальная отметка не поставлена", e.message);
        }
      } catch (e) {
        log(`Отметка о доставке ответа не записалась: ${e.message}`, true);
      }
    }
  }

  /**
   * D-080: вопрос НЕ закрывается по времени — ни частично, ни «по умолчанию».
   *
   * Прежняя версия закрывала строку статусом «Принят дефолт» и подставляла в
   * «Ответ» вариант по умолчанию. Это третья модель обратной связи, которой
   * больше нет: при живом маршруте «вопрос → приёмка» ответ приходит за один
   * ход, а срок не срабатывал ни разу — зато в базе и в промпте он выглядел как
   * настоящее решение. Открытый вопрос теперь остаётся открытым, пока на него
   * не ответят.
   *
   * Функция сохранена (пробы и внешние вызовы), но всегда ничего не делает и
   * считает только то, что ей передали: молча подменять поведение нельзя —
   * вызывающий должен видеть ноль.
   */
  async function closeExpired(rows, closedIds = null) {
    const pending = (rows || []).filter((row) => row && row.id);
    if (pending.length) {
      log(
        `Открытых вопросов со старым полем «Срок»: ${pending.length}. По сроку они больше не закрываются — ` +
          "на вопрос отвечает приёмка, а «Принят дефолт» больше не ставится (D-080).",
        false,
        { ntfy: false },
      );
    }
    return 0;
  }

  /** Строки базы «Вопросы» с нужным статусом, в пределах миссии. */
  /**
   * Привязка строки обратной связи к миссии.
   *
   * 09.11 Координатор создал два предложения для Warden прямо в базе, и ни одно
   * из них не дошло. Причин было две, и обе — в этом сравнении:
   *
   *   1. `Статус` был пуст (агент — не транспорт, схему он не соблюдает), а
   *      запрос шёл строго `Статус = Ждёт`. Транспорт видел только то, что сам
   *      же и подписал, а руками созданная строка не видна никому: «Ждёт» без
   *      статуса — это долг транспорта, а не ответ Мастера.
   *   2. В «Миссии» стоял голый UUID миссии. `missionSame` сравнивает слова
   *      названия, UUID названием не является — строка выпадала даже со
   *      статусом. Причём транспорт пишет в это поле имя миссии, так что оба
   *      предложения пришли из разных источников.
   *
   * Поэтому привязка читается мягко: пустая «Миссия» — общая строка (как было),
   * UUID нашей миссии — тоже наша строка, а имя сравнивается по словам.
   */
  const missionKeyOf = (text) => String(text || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || "";

  /**
   * Что писать в поле «Миссия» строки обратной связи: только имя миссии.
   *
   * Поле — rich_text и в базе живёт как справка для Мастера, но от него зависит
   * привязка строки к миссии. Поэтому UUID сюда не идёт: голый UUID уже один раз
   * сделал строку «чужой» (09.11, D-082). Если пришёл UUID вместо имени (так
   * бывает, когда контекст собран из одной карточки), значение не пишется вовсе:
   * пустая «Миссия» означает «общая строка» и читается наравне со своей.
   */
  function missionLabel(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return missionKeyOf(text) && text.length <= 40 ? "" : text;
  }

  function rowInMission(row, mission) {
    const value = rt(row?.properties?.["Миссия"]).trim();
    if (!value) return true;
    if (!mission || !mission.id) return true;
    const key = missionKeyOf(value);
    if (key) return norm(key) === norm(mission.id);
    const wanted = rt(mission.properties?.["Миссия"]).trim();
    return missionSame(value, wanted);
  }

  /**
   * Строки обратной связи по статусам.
   *
   * Пустой `Статус` читается вместе с «Ждёт»: строка, созданная руками, — это
   * вопрос, который приёмка ещё не видела, а не решённый. Если бы она падала в
   * `handWaitingRow`, статус пришлось бы ставить транспорту — он и ставит, но
   * уже после того, как увидит строку.
   */
  async function questionRows(statuses, mission) {
    const wanted = [...new Set(statuses || [])];
    const or = wanted.map((name) => ({ property: "Статус", select: { equals: name } }));
    // Пустой статус — только для открытых запросов: «Решено» без статуса не
    // бывает, а вот «Ждёт» без статуса — обычное дело для строки из рук агента.
    if (wanted.includes(Q.wait)) or.push({ property: "Статус", select: { is_empty: true } });
    const rows = await query(C.questions, { or });
    if (!mission) return rows;
    return rows.filter((row) => rowInMission(row, mission));
  }

  /**
   * Что показать агенту про вопросы и что Мастер уже ответил.
   *
   * Ошибка чтения не должна ломать ход: без этой строки цикл работает, просто
   * не знает про вопросы. Поэтому `catch` здесь, а не в вызывающем коде.
   */
  async function questionBriefing(mission) {
    try {
      const [open, answered] = await Promise.all([
        questionRows([Q.wait], mission),
        questionRows([Q.done, Q.byDefault], mission),
      ]);
      const fresh = answered.filter((row) =>
        !row.properties?.["Доставлено"]?.date?.start && rt(row.properties?.["Ответ"]).trim());
      return {
        fresh,
        openLine: openQuestionsLine(open),
        answersLine: answersLine(fresh),
        answersMine: (roleName) => answersMineLine(fresh, roleName),
      };
    } catch (e) {
      log(`База «Обратная связь» не читается: ${e.message}`, true);
      return { fresh: [], openLine: "", answersLine: "" };
    }
  }
