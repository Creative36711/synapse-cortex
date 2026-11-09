  // ─────────────────────────── решения на Мастере (ADR) ───────────────────────
  /**
   * ADR `proposed` может появиться в `docs/decisions` без маркера question.
   * Фоновый сторож читает main и направляет такие файлы в ту же обратную связь
   * и очередь приёмки, а не показывает вторую кнопку. Содержимое кэшируется по
   * sha; ошибка чтения не останавливает цикл и не создаёт запись вслепую.
   */
  const ADR_FOLDER = "docs/decisions";
  const ADR_PROPOSED = "proposed";

  /**
   * Имена решений в тексте: номер карточки (`NAR-5.13`) и имя файла
   * (`0016-capability-registry-boundary`).
   *
   * Файл обязателен с 1.4.82. Прежде ключом был только номер вида `NAR-x.y`, и
   * предложение с описательным именем (`0016-…md`) не могло связаться со своим
   * ответом: оно навсегда оставалось в счётчике «ждёт Мастера», хотя решение
   * уже было принято. Обратное тоже ломалось: любое упоминание «NAR-5» в
   * ответе прятало все файлы миссии NAR-5, в том числе нерешённые.
   */
  function adrKeysOf(text) {
    const out = new Set();
    const src = String(text || "");
    for (const hit of src.matchAll(/\b[A-Z][A-Z0-9_]*-\d+(?:\.\d+)?(?:-[\wа-яё]+)?/gi)) out.add(hit[0].toLowerCase());
    for (const hit of src.matchAll(/([\w.-]+)\.md/gi)) out.add(hit[1].toLowerCase());
    return out;
  }

  /** Тема вопроса, не упоминания в ответе. Не угадываем при нескольких ADR. */
  function adrSubjectKeysOf(text) {
    const src = String(text || "");
    const files = new Set([...src.matchAll(/([\w.-]+)\.md/gi)].map((hit) => hit[1].toLowerCase()));
    if (files.size) return files.size === 1 ? files : new Set();
    const numbers = new Set([...src.matchAll(/\b[A-Z][A-Z0-9_]*-\d+\.\d+(?:-[\wа-яё]+)?/gi)]
      .map((hit) => hit[0].toLowerCase()));
    return numbers.size === 1 ? numbers : new Set();
  }

  /**
   * Имена решений, по которым приёмка уже ответила в «Вопросах».
   *
   * ADR остаётся `proposed`, пока решение не записано в репозиторий. Но само
   * решение может быть уже принято — ответ лежит в базе. Держать такой ADR в
   * счётчике «ждёт Мастера» значит звать человека туда, где его больше нет:
   * осталась работа агентов. 25.10 именно так висели NAR-2.14 и NAR-2.15.
   */
  async function decidedAdrNames() {
    const names = new Set();
    try {
      // «Принят дефолт» по сроку — не ответ на предложение и не решение ADR.
      const rows = await questionRows([Q.done]);
      for (const row of rows) {
        const answer = rt(row.properties?.["Ответ"]).trim();
        if (!answer) continue;
        for (const key of adrSubjectKeysOf(`${rt(row.properties?.["Вопрос"])} ${row.properties?.["Материал"]?.url || ""}`)) names.add(key);
      }
    } catch (e) {
      // `null` — «не знаю», а не «решений нет»: иначе сбой чтения вернул бы в
      // счётчик уже принятые решения и разбудил Мастера зря.
      dbg("решения: ответы Мастера не прочитаны", e.message);
      return null;
    }
    return names;
  }

  /** `Статус:` из шапки ADR; пусто — поля нет. */
  const adrStatusOf = (text) => {
    const m = String(text || "").match(/^\s*Статус:\s*(.+?)\s*$/m);
    return m ? m[1].replace(/[`*]/g, "").trim().toLowerCase() : "";
  };

  function openDecisions() {
    const cache = GM_getValue("cfn-adr-open", null);
    return cache && Array.isArray(cache.rows) ? cache : { at: 0, rows: [], known: null };
  }

  /** Содержимое файла из ответа GitHub: base64 → UTF-8, без устаревших API. */
  function b64Text(value) {
    const clean = String(value || "").replace(/\s+/g, "");
    if (!clean) return "";
    try {
      const bytes = Uint8Array.from(atob(clean), (ch) => ch.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch (e) {
      return "";
    }
  }

  /** Ключ файла предложения: `0016-capability-registry-boundary.md` → без `.md`. */
  const adrKeyOf = (file) => String(file || "").replace(/\.md$/i, "").toLowerCase();

  /**
   * D-085: какие номера решений уже заняты — по `docs/DECISIONS.md` в `main`.
   *
   * 09.11 Warden в ответе написал «свободны D-084 (зоны) и D-085 (V-2)», хотя
   * D-084 к этому моменту занимал транспорт (1.14.12, коммит 55d8480). Номер
   * выдавался по памяти модели, а не по источнику истины, и коллизию заметил
   * человек уже после публикации. Здесь список читается из репозитория; ответ
   * приёмки с занятым номером до записи не доходит.
   *
   * Кэш на `adrCheckMs`: список меняется только вместе с решением, а вызов
   * стоит на пути каждого ответа приёмки.
   */
  async function decisionNumbersTaken() {
    const cache = GM_getValue("cfn-decisions-taken", null);
    const now = Date.now();
    if (cache && Array.isArray(cache.numbers) && now - Number(cache.at || 0) < (Number(C.adrCheckMs) || 600000)) {
      return cache.numbers;
    }
    const token = GM_getValue(K.ghToken, "");
    const repo = String(C.repo || "");
    if (!token || !repo) return cache?.numbers || [];
    try {
      const url = `https://api.github.com/repos/${repo}/contents/docs/DECISIONS.md?ref=${encodeURIComponent(C.branch || "main")}`;
      const file = await request("GET", url, githubHeaders(token));
      const text = b64Text(file && file.content);
      const numbers = [...String(text || "").matchAll(/^##\s*D-(\d{3})/gm)].map((m) => `D-${m[1]}`);
      GM_setValue("cfn-decisions-taken", { at: now, numbers });
      return numbers;
    } catch (e) {
      dbg("номера решений не прочитаны", e && e.message);
      return cache?.numbers || [];
    }
  }

  /**
   * D-086: какая редакция ТЗ и очереди реально лежит в `main`.
   *
   * Признак «опубликовано» до 1.14.15 не существовал нигде: документ живёт в
   * Notion и в git, а сверять их было некому. Здесь читается шапка очереди —
   * `Передача от Warden, 2026-11-08 (**редакция 1.7**, **ТЗ 1.5**)` — прямо из
   * репозитория. Это факт, а не догадка.
   *
   * 09.11 (2-я редакция): ролей два репозитория, и документы лежат не там, где
   * работает роль. `synapse` — публичный репозиторий кода, `synapse-cortex` —
   * приватный, и в Notion «Репозиторий» роли-приёмки (`Warden`) назван cortex.
   * Поэтому читаем не `C.repo` (это репозиторий сессии роли), а
   * `C.docsRepo` → репозиторий роли-приёмки → `C.repo`. Иначе сверка ищет
   * документ не в том репозитории и всегда возвращает «не прочитано».
   */
  function docsRepository() {
    if (String(C.docsRepo || "").trim()) return String(C.docsRepo).trim();
    try {
      if (typeof roleRows === "function") {
        // Синхронного доступа к строкам «Ролей» нет; кеш пишется при чтении базы.
        const cache = GM_getValue(K.rolesCache, null);
        const rows = cache && Array.isArray(cache.rows) ? cache.rows : [];
        const owner = rows.find((r) => r && (r.fn === "Reviewer" || norm(r.name) === norm("Warden")) && String(r.repo || "").trim());
        if (owner) return String(canonicalTargetRepository(owner.repo, C.repo));
      }
    } catch { /* репозиторий роли не прочитан — ниже фолбэк */ }
    return String(C.repo || "");
  }

  async function publishedTzVersion(file = C.queueDoc || "docs/handoff/syn-3-card-queue.md") {
    const cache = GM_getValue("cfn-tz-published", null);
    const now = Date.now();
    const repo = canonicalTargetRepository(docsRepository());
    if (cache && cache.file === file && cache.repo === repo &&
        now - Number(cache.at || 0) < (Number(C.adrCheckMs) || 600000)) {
      return cache;
    }
    const token = GM_getValue(K.ghToken, "");
    if (!token || !repo) return cache && cache.file === file ? cache : null;
    try {
      const url = `https://api.github.com/repos/${repo}/contents/${file}?ref=${encodeURIComponent(C.branch || "main")}`;
      const got = await request("GET", url, githubHeaders(token));
      const text = b64Text(got && got.content);
      const tz = String(text || "").match(/ТЗ\s*\**\s*(\d+\.\d+)/i);
      const queue = String(text || "").match(/редакция\s*\**\s*(\d+\.\d+)/i);
      if (!tz && !queue) return null;
      const out = { at: now, file, repo, version: tz ? tz[1] : "", queue: queue ? queue[1] : "" };
      GM_setValue("cfn-tz-published", out);
      return out;
    } catch (e) {
      dbg("редакция ТЗ не прочитана", e && e.message);
      return cache && cache.file === file ? cache : null;
    }
  }

  /**
   * Где ответ приёмки берёт номер, который уже занят.
   *
   * Смотрим только форму «D-084» рядом со словом «свободен/номер/решение» или
   * прямо в перечислении номеров: обычная ссылка на уже принятое решение вида
   * «см. D-077» — нормальная работа, а не заявка на номер.
   */
  /**
   * Заявка на номер решения или просто упоминание — это разные вещи.
   *
   * D-088: прежняя версия смотрела на 120 знаков вокруг каждого `D-NNN` и падала на
   * любое слово «свободен/номер/решение». Живой ответ 09.11 (18:00Z) перечислял,
   * какие номера уже заняты и что в объявлении Warden было «свободны D-085 и D-086» —
   * это точный пересказ, а не заявка. Гейт остановил верный ответ и увёл ход
   * Maintainer'у (инцидент `answer-decisions`, 1 из 2).
   *
   * Поэтому «заявка» ищется только в форме присвоения: `D-087 =`, `D-087:`, `D-087 —`
   * или в предложении, где номер стоит подлежащим при глаголе присвоения
   * («номер D-087 занят», «беру D-088»). Простое перечисление занятых номеров и
   * цитата не считаются. Отрицание («D-087 не занят») заявкой тоже не считается.
   */
  const DECISION_LOOKBEHIND = /(?:^|[\s(«"',.;:—-])((?:D-)(\d{3}))(?![\d])/g;

  function decisionClaim(answer) {
    const text = String(answer || "");
    if (!text) return [];
    const out = [];
    for (const m of text.matchAll(DECISION_LOOKBEHIND)) {
      const id = m[1];
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const before = text.slice(Math.max(0, m.index - 90), m.index);
      // Прямое присвоение: «D-087 = …», «D-087: …», «D-087 — …».
      if (/^\s*(?:=|:|—|–|-)\s*\S/.test(after)) { out.push(id); continue; }
      // Глагол присвоения рядом с номером. Отрицание («D-088 не занят») — не заявка.
      // Границы слова — пробел/край строки, а не `\b`: в JS `\b` считается по ASCII,
      // и на кириллице («занят») не срабатывает вовсе.
      const verb = /(?:^|[\s(«"—])(занят|занято|занятый|свободен|свободно|беру|берём|назначаю|назначаем|выдаю|резервирую|закрепляю)(?=[\s,.;:)—]|$)/i.exec(after);
      if (verb) {
        const verbStart = verb.index + verb[0].indexOf(verb[1]);
        const lead = after.slice(0, verbStart);
        // «не занят» перед номером — это сообщение о свободе, а не заявка.
        // Хвост после номера тоже важен: «…, сейчас оба заняты» — пересказ списка,
        // а не заявка; заявка говорит о номере в единственном числе.
        const tail = after.slice(verbStart + verb[1].length, verbStart + verb[1].length + 20);
        const plural = /^\s*[.,;:]?\s*(оба|все|уже|тоже|также|сейчас|пока)\b/i.test(tail);
        const verbAtQuestion = /^\s*\S+\s+/.test(after.slice(0, verbStart));
        if (verbStart <= 24 && !/(?:^|\s)не\s*$/i.test(lead) && !plural && !verbAtQuestion) {
          out.push(id);
          continue;
        }
      }
      // Английская форма заявки: «decision D-088».
      if (/\bdecision\s*$/i.test(before)) { out.push(id); continue; }
      // «номер решения — D-087», «решение D-087», «решение о зонах §7 = D-087».
      // Вторая форма — именно то, как пишет приёмка: «решение о зонах §7 = D-087».
      if (/(?:номер\w*\s+(?:решени\w*|ADR)?|решени\w*)[^.!?\n]{0,40}[=—:-]\s*$/i.test(before)) {
        out.push(id);
        continue;
      }
      if (/=\s*$/i.test(before) && /^\s*(?:[,.;)]|$)/.test(after)) out.push(id);
    }
    return [...new Set(out)];
  }

  function decisionNumberConflict(answer, taken) {
    const free = new Set((taken || []).map((x) => String(x).toUpperCase()));
    if (!free.size) return "";
    const claimed = decisionClaim(answer).filter((id) => free.has(id.toUpperCase()));
    if (!claimed.length) return "";
    const last = [...free].map((x) => Number(String(x).replace(/\D/g, "")) || 0).sort((a, b) => b - a)[0] || 0;
    const next = `D-${String(last + 1).padStart(3, "0")}`;
    return `Ответ заявляет номером решения ${claimed.join(", ")}, но в docs/DECISIONS.md этот номер уже занят ` +
      `(последний занятый — D-${String(last).padStart(3, "0")}). Свободный номер сейчас ${next}: возьми его и повтори ответ. ` +
      "Упоминание занятых номеров в объяснении конфликтом не считается.";
  }

  /**
   * Вопрос приёмке по предложению из репозитория.
   *
   * Текст держится коротким (заголовок «Вопрос» режется на 180 знаках), а
   * полный — в теле страницы. Пересказывать предложение нельзя: приёмка
   * читает файл, иначе решение примется по моей формулировке, а не по тексту
   * агента.
   */
  function proposalQuestion(row, missionName = "") {
    const file = String(row?.file || "");
    const content = String(row?.content || "");
    if (!content.trim() || !/^[0-9a-f]{40}$/i.test(String(row?.sha || ""))) throw new Error(`Полный текст и SHA предложения ${file || "без имени"} не прочитаны.`);
    const path = `${ADR_FOLDER}/${file}`;
    // D-037: репозиторий и ветка берутся из самого предложения (сторож обходит
    // все репозитории профиля), а не только из главного C.repo/C.branch.
    const repo = String(row?.repo || C.repo || "");
    const branch = String(row?.branch || C.branch || "main");
    const url = `https://github.com/${repo}/blob/${branch.split("/").map(encodeURIComponent).join("/")}/${ADR_FOLDER}/${encodeURIComponent(file)}`;
    return {
      text: `Предложение ${path}: принять, отклонить или оставить как есть?`,
      url,
      autoAdr: true,
      contentSha: row.sha,
      contentText: content.trim(),
      fullText: fullQuestionText([
        `Предложение лежит в репозитории: ${path} (${repo}@${branch}), статус «proposed».`,
        `Материал: ${url}`,
        missionName ? `Миссия: ${missionName}` : "",
        "",
        "ЧТО РЕШИТЬ",
        "Принять как есть, отклонить или оставить как есть (вариант по умолчанию). Если принимаешь с поправкой — назови её: что поменять в предложении и по какому признаку считать решение исполненным.",
        "Статус файла меняет исполнитель карточкой: приёмка решает по существу, агенты переводят предложение в accepted или rejected с датой.",
        "Вариант по умолчанию и истечение срока не являются фактическим решением по ADR и не разрешают менять оракул.",
        "Если файл содержит несколько самостоятельных вопросов, дай отдельный выбор и обоснование по каждому; один общий verdict не заменяет отдельных ответов.",
        `CF_ADR_CONTENT ${row.sha}`,
        "ПОЛНЫЙ НЕИЗМЕНЁННЫЙ ТЕКСТ ФАЙЛА:",
        content,
        `КОНЕЦ ТЕКСТА CF_ADR_CONTENT_END ${row.sha}`,
      ]
        .filter(Boolean)
        .join("\n")),
      fallback: "оставить как есть",
      options: ["принять", "отклонить", "оставить как есть"],
      // D-080: ADR — единственный вид вопроса, который ДЕРЖИТ ход по своей
      // природе: решение приёмки по контракту нельзя заменить вариантом по
      // умолчанию. Теперь это сказано явно (`gate`), а не выводилось из
      // «вопрос вообще существует».
      gate: true,
      need: "",
    };
  }

  /**
   * Довести нерешённые предложения до приёмки.
   *
   * ADR без вопроса нельзя терять. Каждое `proposed` без принятого решения
   * получает строку в «Обратной связи» со ссылкой
   * на файл и сразу ставится в очередь приёмки. Повторная строка не
   * создаётся: `sameQuestionRow` сравнивает ссылки на решение, а отметка
   * `cfn-asked:adr:<файл>` помнит факт передачи.
   */
  async function deliverProposals(rows) {
    let missionName = "";
    try {
      const mission = await activeMission();
      if (!mission) return; // без активной миссии приёмке нечего передавать
      missionName = rt(mission.properties["Миссия"]);
    } catch (e) {
      dbg("решения: активная миссия не определена", e.message);
      return;
    }
    // Старые версии могли закрыть вопрос по сроку и принять дефолт за ответ.
    // Исходную строку не переписываем: для такого ADR создаём однократное
    // уточнение, если позднее фактического ответа не нашлось.
    let history;
    try {
      history = await questionRows([Q.done, Q.byDefault]);
    } catch (e) {
      dbg("решения: историю ответов не прочитать", e.message);
      return;
    }
    const answered = new Set();
    const unresolved = new Map();
    for (const question of history) {
      const keys = adrSubjectKeysOf(`${rt(question.properties?.["Вопрос"])} ${question.properties?.["Материал"]?.url || ""}`);
      const status = sel(question.properties?.["Статус"]);
      const answer = rt(question.properties?.["Ответ"]).trim();
      if (status === Q.done && answer) for (const key of keys) answered.add(key);
      if (status === Q.byDefault || (status === Q.done && !answer)) {
        for (const key of keys) {
          const items = unresolved.get(key) || [];
          items.push(question.id);
          unresolved.set(key, items);
        }
      }
    }
    for (const row of rows || []) {
      try {
        const fileKey = adrKeyOf(row.file);
        if (answered.has(fileKey)) continue;
        const problems = (unresolved.get(fileKey) || []).sort();
        const needsReview = problems.length > 0;
        const question = proposalQuestion(row, missionName);
        if (needsReview) {
          question.text = `Уточнение: ${question.text}`;
          question.fullText = "Предыдущий вопрос закрыт без фактического ответа (по сроку или с пустым полем): default не является решением. Нужен ответ по существу.\n\n" + question.fullText;
        }
        await askQuestion(question, {
          roleName: "Relay (транспорт)",
          card: "",
          mission: missionName,
          // Идентификаторы старых строк дают новому уточнению свой ключ, даже
          // если прежнее уточнение затем ошибочно закрыли без ответа.
          // D-037: репозиторий входит в ключ, когда он известен, — одноимённые
          // файлы из разных репозиториев не дедуплицируются между собой.
          key: needsReview
            ? `adr-full-confirm:${row.repo ? `${row.repo}/` : ""}${row.file}:${row.sha}:${problems.join(":")}`
            : `adr-full:${row.repo ? `${row.repo}/` : ""}${row.file}:${row.sha}`,
        });
      } catch (e) {
        dbg("решения: предложение не передано приёмке", e.message);
        logThrottled(`adr-material:${row.file}`, `Предложение ${row.file} не передано приёмке: ${e.message}. Полный текст не усекался; проверьте материал вручную.`, true);
      }
    }
  }

  async function refreshDecisions(force = false) {
    const cache = openDecisions();
    if (!force && Date.now() - cache.at < C.adrCheckMs) return cache.rows;
    const token = GM_getValue(K.ghToken, "");
    try {
      // D-037: сторож обходит ВСЕ репозитории профиля, а не только главный.
      // Предложение может лежать во втором репозитории (например, synapse),
      // и тогда полный текст с SHA никогда не дописывался бы в вопрос —
      // предохранитель не пропустил бы его к приёмке. 404 папки decisions
      // в одном репозитории не останавливает обход остальных.
      const repos = (Array.isArray(C.repos) && C.repos.length
        ? C.repos
        : [{ repo: C.repo, branch: C.branch || "main" }]).filter((r) => r && r.repo);
      const texts = GM_getValue("cfn-adr-text", {}) || {};
      // Плоский кэш до D-037 относился к главному репозиторию: переносим его
      // под составной ключ, чтобы имена файлов из разных репозиториев не смешивались.
      for (const key of Object.keys(texts)) {
        if (!key.includes("/")) {
          texts[`${C.repo}/${key}`] = texts[key];
          delete texts[key];
        }
      }
      const rows = [];
      for (const entry of repos) {
        const repo = String(entry.repo);
        const branch = String(entry.branch || "main");
        let list;
        try {
          list = await request(
            "GET",
            `https://api.github.com/repos/${repo}/contents/${ADR_FOLDER}?ref=${encodeURIComponent(branch)}`,
            githubHeaders(token),
          );
        } catch (e) {
          if (Number(e.status) === 404) continue; // папки decisions нет — не ошибка
          throw e;
        }
        if (!Array.isArray(list)) throw new Error("GitHub вернул не список файлов");
        for (const item of list) {
          if (!item || item.type !== "file" || !/\.md$/i.test(item.name || "")) continue;
          const cacheKey = `${repo}/${item.name}`;
          const cached = texts[cacheKey];
          let status = cached && cached.sha === item.sha ? cached.status : "";
          let content = cached && cached.sha === item.sha ? String(cached.content || "") : "";
          if (!status || (status === ADR_PROPOSED && !content)) {
            const fileUrl = `https://api.github.com/repos/${repo}/contents/${ADR_FOLDER}/${encodeURIComponent(item.name)}?ref=${encodeURIComponent(branch)}`;
            const file = await request("GET", fileUrl, githubHeaders(token));
            content = b64Text(file && file.content);
            if (!content || file.sha !== item.sha) throw new Error(`Не прочитан полный текст или изменился SHA ${item.name}.`);
            status = adrStatusOf(content) || "нет";
            texts[cacheKey] = { sha: item.sha, status, ...(status === ADR_PROPOSED ? { content } : {}) };
          }
          if (status === ADR_PROPOSED)
            rows.push({ file: item.name, sha: item.sha, url: item.html_url || "", content, repo, branch });
        }
      }
      GM_setValue("cfn-adr-text", texts);
      const answered = await decidedAdrNames();
      if (answered === null) {
        // История недоступна: не создаём дубликаты вслепую. Следующий опрос
        // повторит попытку; счётчик остаётся снимком базы обратной связи.
        return cache.rows;
      }
      const settled = rows.filter((row) => answered.has(adrKeyOf(row.file)));
      const pending = rows.filter((row) => !settled.includes(row));
      GM_setValue("cfn-adr-open", { at: Date.now(), rows: pending });
      // ADR может появиться без маркера question. Он попадает в ту же очередь
      // Notion и приёмки, без отдельного счётчика и второго уведомления.
      if (pending.length) await deliverProposals(pending);
      if (settled.length) {
        logThrottled(
          "adr-settled",
          `Решение по ADR уже записано в «Обратной связи», но в репозитории он ещё proposed: ` +
            `${settled.map((row) => row.file).join(", ")}. Это работа агентов: ` +
            "статус файла меняет исполнитель карточкой, иначе предложение выглядит нерешённым.",
          false,
          3_600_000,
        );
      }
      return pending;
    } catch (e) {
      dbg("решения: список не обновлён", e.message);
      return cache.rows;
    }
  }

  let decisionsWatch = 0;
  function watchDecisions() {
    if (typeof projectApproved === "function" && !projectApproved()) return;
    if (decisionsWatch) return;
    decisionsWatch = window.setInterval(() => {
      if (!document.getElementById("cfn-projects")) refreshDecisions().catch(() => {});
    }, C.adrCheckMs);
    refreshDecisions().catch(() => {});
  }

  // Свежие счётчики очереди: после решения Координатора старые уже неверны.
  //
  // `strict` — для хода планирования: там очередь и есть предмет решения, и
  // карточка этой миссии без привязки действительно мешает выбрать карточку.
  // По умолчанию чтение мягкое: карточка без привязки в другую миссию не
  // повод останавливать приём уже полученного ответа и запись результата.
  async function queueOf(mission, { strict = false } = {}) {
    // Страж привязок — только у выбора очереди: приём готового ответа и запись
    // результата не должны зависеть от чужих карточек. Вопрос «можно ли
    // закрыть миссию» проверяется отдельно, в ветке принятия.
    if (strict) await assertMissionBindings(mission);
    const unbound = [];
    const read = (state) => tasks(state, mission, { allowUnbound: !strict, unbound });
    const [submitted, running, ready, rework, draft, blocked] = await Promise.all([
      read("Submitted"),
      read("Running"),
      read("Ready"),
      read("Rework"),
      read("Draft"),
      read("Blocked"),
    ]);
    // Rework запоминается ради причины в журнале: право на повторную выдачу
    // даёт указание Координатора, а следы прошлого ответа снимает `dispatchTask`
    // (см. `redispatchClearProps`).
    rememberRework(rework);
    return {
      submitted,
      running,
      ready,
      rework,
      draft,
      blocked,
      // Карточки этой миссии без Mission ID: их нельзя выдать, поэтому в счёт
      // очереди они не идут, но и молчать о них нельзя.
      unbound: [...new Map(unbound.map((row) => [row.id, row])).values()],
      summary:
        `${submitted.length} Submitted, ${running.length} Running, ${ready.length} Ready, ` +
        `${rework.length} Rework, ${draft.length} Draft, ${blocked.length} Blocked`,
    };
  }

  /**
   * Черновики миссии — списком, а не числом.
   *
   * Мастер (2026-10-24): Координатор ответил «перевести Draft в Ready я не
   * вправе» и архивировал собственный черновик, чтобы создать точно такой же
   * новый. Дело было не в правах: в промпте стояла строка «Ready ставит
   * движок», а сами черновики в очереди не показывались вовсе. Теперь
   * Координатор видит свой задел и распоряжается им сам.
   */
  /**
   * Дефект адресата — один для любого состояния карточки (D-075 п. 2).
   *
   * 08.11 карточка в Ready с неактивным адресатом выглядела в промпте
   * нормальной: список ролей читал только `draftLine` (`:1081`), а `readyLine`
   * и `reworkLine` называли одно имя. Координатор узнавал о дефекте на выдаче,
   * то есть в самом дорогом месте. Теперь один и тот же разбор работает у всех
   * трёх списков, а слова — те же три случая, что в `blockedReason`.
   */
  function roleDefect(role, known = []) {
    const name = String(role || "").trim();
    if (!name) return "роль не задана";
    const seen = new Map();
    for (const item of known || []) {
      if (typeof item === "string") seen.set(norm(item), { status: "Активна", url: "есть" });
      else if (item && item.name) seen.set(norm(item.name), { status: item.status || "", url: item.url || "", fn: item.fn || "" });
    }
    if (!seen.size) return name;
    const row = seen.get(norm(name));
    if (!row) return `${name} — нет в «Ролях»`;
    if ((row.status || "") !== "Активна") return `${name} — Статус «${row.status || "пуст"}»`;
    if (!row.url) return `${name} — нет Agent URL`;
    if (row.fn && !["Coordinator", "Executor", "Auditor", "Reviewer", "Maintainer"].includes(row.fn))
      return `${name} — Функция «${row.fn}» не годится`;
    return "";
  }

  function draftLine(cards, known = []) {
    const rows = [...(cards || [])].sort((a, b) => {
      const sa = Number(a.properties?.["Sequence"]?.number ?? 0);
      const sb = Number(b.properties?.["Sequence"]?.number ?? 0);
      return sa - sb;
    });
    if (!rows.length) return "Черновиков нет — следующий шаг миссии предложи сам.";
    // Почему роль не может получить работу — тремя разными словами. 24.10
    // Мастер создал агента Build/Release и заполнил Agent URL, но оставил
    // Статус «Ждёт»: общая фраза «роль не активна» прятала это, и по ней
    // нельзя было понять, чего именно не хватает. Строки принимаются двух
    // видов: имя (значит «активна») и строка базы «Роли» целиком.
    const who = (card) => {
      const role = taskRole(card);
      const defect = roleDefect(role, known);
      return defect || role;
    };
    const shown = rows.slice(0, C.draftLineMax).map((card) => {
      const seq = card.properties?.["Sequence"]?.number;
      return `${taskTitle(card)} (${who(card)}, Sequence ${seq ?? "—"})`;
    });
    const more = rows.length > shown.length ? `; и ещё ${rows.length - shown.length}` : "";
    return `Черновики (предложения — выдаёшь их ты): ${shown.join("; ")}${more}.`;
  }

  /**
   * Что уже лежит в Ready — с ролью и номером.
   *
   * 24.10 карточка NAR-1.10 вернулась в Ready после неудачной выдачи, а в
   * строке «Очередь» видно только число: Координатор не знал, чья она, и мог
   * назвать в next не ту роль — или создать дубликат «на всякий случай».
   */
  /**
   * Отпечаток Ready: id карточки и её Sequence.
   *
   * По нему видно, та ли это очередь, по которой Координатор принимал решение.
   * 25.10 план пришёл по одной очереди, а применился к другой: Мастер вернул
   * зависшую карточку в Ready уже после запроса плана — и вместо неё ушла
   * следующая по порядку.
   */
  const readyKeyOf = (cards) =>
    (cards || [])
      .map((card) => `${card.id}:${card.properties?.["Sequence"]?.number ?? ""}`)
      .sort()
      .join(",");

  function readyLine(cards, known = []) {
    const rows = [...(cards || [])].sort((a, b) => {
      const sa = Number(a.properties?.["Sequence"]?.number ?? 0);
      const sb = Number(b.properties?.["Sequence"]?.number ?? 0);
      return sa - sb;
    });
    if (!rows.length) return "Готовы к выдаче: ничего — Ready пуст.";
    // Ready со следами прошлого ответа — это не «готова», а «нужна заново»:
    // работа уже была и не принята. Транспорт снимет следы на выдаче сам, но
    // Координатор должен понимать, что он берёт в работу отвеченную карточку,
    // а не новую.
    const shown = rows.slice(0, C.readyLineMax).map((card) => {
      const seq = card.properties?.["Sequence"]?.number;
      const stale = staleMarks(card);
      const checkFail = card.properties?.["Check"]?.select?.name === "fail";
      const warn = [
        stale.length
          ? `остались ${stale.join(", ")}: это повторная работа; следы снимет транспорт после разрешённого возврата, если повторять её не надо — убери карточку из Ready`
          : "",
        checkFail ? "Check=fail: результат не принят, сначала нужен Rework/разбор Warden" : "",
      ].filter(Boolean).join("; ");
      const named = taskRole(card) || "";
      const defect = roleDefect(named, known);
      const who = defect || named || "роль не задана";
      return `${taskTitle(card)} (${who}, Sequence ${seq ?? "—"})${warn ? ` — ${warn}.` : ""}`;
    });
    const more = rows.length > shown.length ? `; и ещё ${rows.length - shown.length}` : "";
    return `Готовы к выдаче: ${shown.join("; ")}${more}.`;
  }

  /**
   * Почему Координатор встал и что именно сделать Мастеру.
   *
   * 25.10 (пауза 19:43) он вернул `next:"blocked"` без `need`, и транспорт
   * написал «нужна роль, которой нет в «Ролях»» — при том что роль Tools в
   * базе есть, просто «Статус» = «Ждёт» и «Agent URL» пуст. Мастер по такой
   * строке пошёл бы создавать нового агента вместо того, чтобы дозаполнить
   * существующую роль. Поэтому текст паузы собирается по фактам: имя роли,
   * её настоящий статус, очередь и уже открытый вопрос.
   */
  function blockedReason({ need = "", directory = [], queue = null, open = [], ask = "", asked = false } = {}) {
    const rows = directory || [];
    const find = (name) => rows.find((r) => norm(r.name) === norm(name));
    const lacks = (row) => {
      if (!row) return "";
      const bits = [];
      if ((row.status || "") !== "Активна") bits.push(`«Статус» = «${row.status || "пуст"}»`);
      if (!row.url) bits.push("«Agent URL» пуст");
      return bits.join(", ");
    };
    const parts = [];
    const name = String(need || "").trim();
    if (name) {
      const row = find(name);
      const gap = lacks(row);
      parts.push(`Координатор остановил цикл: нужна роль «${name}».`);
      if (!row) {
        parts.push(
          `Роли «${name}» в базе «Роли» нет — создайте агента в Arena, заполните «Agent URL» и поставьте «Статус» = «Активна».`,
        );
      } else if (!gap) {
        parts.push(
          `Роль «${name}» активна и «Agent URL» заполнен — значит, Координатор её не увидел: проверьте «Функцию» и «Зону записи».`,
        );
      } else {
        parts.push(
          `Роль «${name}» в «Ролях» есть, но ${gap} — создавать агента не нужно: заполните «Agent URL» и поставьте «Статус» = «Активна».`,
        );
      }
    } else {
      // Роль не названа — показываем очередь: по ней видно, чья это работа.
      parts.push("Координатор остановил цикл, но роль не назвал.");
      const waiting = ((queue && queue.draft) || [])
        .map((card) => ({ card, role: taskRole(card) }))
        .filter(({ role }) => role && !find(role)?.url)
        .map(
          ({ card, role }) =>
            `черновик «${taskTitle(card)}» ждёт роль ${role} — ${lacks(find(role)) || "роли нет в «Ролях»"}`,
        );
      if (waiting.length) {
        parts.push(`По очереди видно: ${waiting.join("; ")}. Новый агент нужен только если роли правда нет.`);
      } else if (queue) {
        parts.push(
          (queue.rework || []).length
            ? "Черновиков, которым не хватает роли, нет — значит, причина другая: смотрите «Ответ» карточек в Rework."
            : "Черновиков, которым не хватает роли, нет, и Rework пуст — по очереди причину не видно.",
        );
      }
    }
    if (queue && queue.summary) parts.push(`Очередь: ${queue.summary}.`);
    if (queue && (queue.rework || []).length) {
      parts.push(
        "Rework — это не «нет роли»: Координатор разбирает причину из «Ответа» карточки и сам решает, выдавать снова или править карточку.",
      );
    }
    if (ask) {
      parts.push(
        `Координатор спрашивает: «${ask}». ` +
          (asked
            ? "Вопрос записан в базу «Обратная связь» — он виден там и счётчиком на панели."
            : "Вопрос в «Обратную связь» не записался — он есть только в этом сообщении, запишите его сами."),
      );
    }
    const first = (open || [])[0];
    if (first) {
      const due = first.properties?.["Срок"]?.date?.start || "";
      const when = due
        ? `, срок ${new Date(due).toLocaleString("ru-RU", {
            timeZone: "Europe/Moscow",
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "";
      parts.push(
        `Вопрос об этом уже задан: «${rt(first.properties?.["Вопрос"])}» (по умолчанию: ${rt(
          first.properties?.["По умолчанию"],
        )}${when}) — он ждёт ответа в базе «Обратная связь».`,
      );
    }
    parts.push(
      "Право на остановку у Координатора одно — роль, которая не может взять работу; пустую очередь, Rework и спорный Scope он разбирает сам.",
    );
    return parts.join(" ");
  }

  /**
   * Rework — статус, а не очередь.
   *
   * 25.10 Координатор поставил NAR-2.5 в Rework за форму ответа: код уже был в
   * main, а в отчёте не хватало цитат. Из Rework карточка сама никуда не
   * уходит — транспорт выдаёт только Ready, — а в промпте стояло «карточку с
   * ответом обратно в Ready не возвращай». Два правила вместе запирали карточку
   * навсегда. Теперь причина и путь назад названы прямо: вернуть в Ready можно,
   * а следы прошлого ответа снимает транспорт на выдаче (1.4.76 — без опоры на
   * память о Rework: 27.10 NAR-4.9 прошла Rework → Ready за один ход, и память
   * о нём не успела появиться).
   */
  const reworkCause = (card) => {
    const answer = rt(card.properties?.["Ответ"]).replace(/\s+/g, " ").trim();
    if (!answer) return "«Ответ» пуст — причина не записана";
    return answer.length > 160 ? `${answer.slice(0, 160)}…` : answer;
  };

  /**
   * Следы прошлого ответа, из-за которых выдача откажет.
   *
   * Читаются здесь, а не через `rt`: строка попадает в промпт Координатора, а
   * пробы вырезают этот блок отдельно — лишняя зависимость ломала бы их
   * песочницу ради одной строки.
   */
  const textOf = (prop) => (prop?.rich_text || prop?.title || []).map((x) => x.plain_text || "").join("");
  const staleMarks = (card) => {
    const marks = [];
    if (card.properties?.["Submitted At"]?.date?.start) marks.push("«Submitted At»");
    if (card.properties?.["PR"]?.url) marks.push("«PR»");
    if (textOf(card.properties?.["Run ID"])) marks.push("«Run ID»");
    return marks;
  };

  function reworkLine(cards, known = []) {
    const rows = [...(cards || [])].sort((a, b) => {
      const sa = Number(a.properties?.["Sequence"]?.number ?? 0);
      const sb = Number(b.properties?.["Sequence"]?.number ?? 0);
      return sa - sb;
    });
    if (!rows.length) return "";
    const shown = rows.slice(0, C.readyLineMax).map((card) => {
      const named = taskRole(card) || "";
      const who = roleDefect(named, known) || named || "роль не задана";
      return `${taskTitle(card)} (${who}) — причина: ${reworkCause(card)}`;
    });
    const more = rows.length > shown.length ? `; и ещё ${rows.length - shown.length}` : "";
    return (
      `На доработке (Rework): ${shown.join("; ")}${more}. ` +
      "Rework сам не выдаётся — исполнителю уходит только Ready. Чтобы работа пошла заново: " +
      "верни карточку в Ready — следы прошлого ответа («Submitted At», «PR», «Run ID») снимет " +
      "транспорт на выдаче, коннектором их чистить не надо. Если переделывать нечего — прими, " +
      "запиши в «Ответ», почему, и оставь карточку принятой."
    );
  }

  /**
   * «Раздел «Возврат» есть» — с учётом текста страницы миссии.
   *
   * Координатор может дописать раздел блоками на странице, а не в свойство
   * «Итог». Это тот же ответ на замечания, и пауза за него не ставится.
   */
  async function returnAnsweredWithBody(mission) {
    if (!isReturned(mission)) return true;
    if (returnAnswered(mission)) return true;
    const body = await missionBodyText(mission).catch(() => "");
    return /возврат/i.test(body);
  }

  async function coordinatorStep(role, expect, manual = false) {
    const mission = await activeMission();
    if (!mission) {
      // Миссию закрыли — говорим об этом зелёной строкой и громким пушем,
      // а не тихим «ждём»: это конец работы, а не пустая страница.
      if (await missionDoneNotice(expect)) return true;
      logThrottled(
        "no-mission",
        "Миссий в работе нет. Создайте карточку в «Миссиях» (Состояние = «Активна») и нажмите «Шаг»: ход начнётся с Координатора, он и нарежет очередь.",
      );
      return false;
    }
    GM_setValue("cfn-me", role.name);

    // Возврат миссии Мастером — событие уровня «нужен Мастер»: строка в
    // журнале и пуш. Повторно на ту же миссию не повторяем.
    if (isReturned(mission)) {
      const remarks = missionRemarks(mission);
      if (!remarks) {
        pause(
          "Миссия возвращена на доработку, но поле «Замечания» пусто: исправлять нечего. " +
            "Запишите, что именно не принято, и снимите паузу.",
          { kind: "return-empty", ref: mission.id },
        );
        return true;
      }
      // У каждого возврата свой отсчёт: ожидание, начатое раньше, — прошлый
      // ход. Снимаем его до разбора маркера, иначе `done` из прошлого хода
      // выглядит как отказ отвечать на замечания (24.10, 16:12).
      const epoch = returnEpoch(mission);
      const seen = `cfn-mission-return:${mission.id}:${textHash(epoch.fp)}`;
      // Когда возврат объявили — второй ориентир рядом с датой возврата: от
      // него видно, что ход начался уже после замечаний, даже если отметка
      // времени возврата уехала вперёд из-за правки карточки.
      // Метка прошлой версии — `true` без времени: объявление уже было, и
      // повторять его при обновлении незачем. Своя метка несёт момент.
      const rawMark = GM_getValue(seen, 0);
      const stamp = Number(rawMark);
      let markedAt = Number.isFinite(stamp) && stamp > Date.parse("2020-01-01") ? stamp : 0;
      if (!rawMark) {
        markedAt = Date.now();
        GM_setValue(seen, markedAt);
        log(
          `Миссия возвращена Мастером: ${firstLine(remarks)}. Координатор получит замечания в плане хода.`,
          false,
          // Мастер вернул миссию сам — звонить ему об этом незачем (1.4.80).
          { tone: "warn", ntfy: "quiet", title: "Relay: миссия возвращена" },
        );
      }
      if (dropStalePlan(mission, expect, { ...epoch, markedAt })) {
        expect = null;
        log(
          "Ожидание Координатора началось до возврата миссии — это прошлый ход, а не ответ на замечания. " +
            "Снимаю его и прошу новый план: замечания будут в промпте.",
          false,
          { tone: "warn" },
        );
      }
    }

    // Ход не у Координатора: ему тут делать нечего, а новый план — вреден.
    // `requestPlan` перезаписывает `K.expect`, и ожидание живого хода
    // пропадает: карточка остаётся в Running без хода, а ответ агента приходит
    // в пустоту. Ровно так теряется работа, если открыть страницу Координатора
    // (или перезагрузить её) посреди ответа исполнителя или приёмки.
    //
    // Ждём только свой ход — `plan` и `reminder` адресованы Координатору, их
    // разбирает код ниже. Всё остальное — на странице адресата: ответ читается
    // только там.
    if (expect && Number(expect.sentAt) && expect.kind !== "plan" && expect.kind !== "reminder") {
      const who = expect.roleName || expect.roleId;
      const list = await roles().catch(() => []);
      const target = list.find((r) => norm(r.id) === norm(expect.roleId)) || null;
      if (target) return navigateTo(target, "там ждёт ответа исполнитель");
      logThrottled(
        `coord-busy:${expect.ref || who}`,
        `Ход у «${who}»: жду ответа. Новый план Координатору не нужен — он перезапишет ожидание, ` +
          "и карточка останется в Running без хода.",
        false,
        C.tickMs * 4,
      );
      return true;
    }

    await releaseStalled(mission);
    // Ход планирования читает очередь строго: без привязки карточку нельзя
    // выдать, и `tasks` здесь честно останавливает шаг. Общего стража на входе
    // нет: этот же код читает ответ Координатора на план, и пауза по чужой
    // карточке не должна съедать уже полученный ответ (D-056).
    const submitted = await tasks("Submitted", mission);
    const running = await tasks("Running", mission);
    const ready = await tasks("Ready", mission);
    const rework = await tasks("Rework", mission);
    // Draft нужен гейту состава (D-075 п. 4): некомплект проверяется по всем
    // карточкам, которые ещё не выданы, включая черновики. Без этого чтения
    // `draft` в гейте не было объявлено вовсе, и ReferenceError улетал в общий
    // catch — 09.11 так дважды подряд после маркера Координатора (08.11 00:49 и
    // 01:00) цикл объявлял «временный сбой» и повторял отправку задания.
    // Чтение мягкое: черновик не повод останавливать уже полученный ответ.
    const draft = await tasks("Draft", mission).catch(() => []);

    if (expect && (expect.kind === "plan" || expect.kind === "reminder")) {
      const decision = messagesAfter(expect.watermark)
        .map((m) => parseMarker(m.raw, "CF_COORDINATOR_RESULT"))
        .filter(Boolean)
        .at(-1);
      if (!decision) return markerMissing(role, expect, "CF_COORDINATOR_RESULT", manual);

      // Решение по устаревшей очереди не применяется.
      //
      // 25.10, 21:36–21:42. Карточка NAR-2.16 висела в Running после съеденной
      // отправки; Мастер вернул её в Ready. Скрипт в это время дочитывал ответ
      // Координатора, полученный ДО правки, — в нём стояло next: "Tools", и
      // ушла NAR-2.17, хотя в Ready уже лежала NAR-2.16 с меньшим Sequence.
      // Транспорт не выбирает за Координатора, но и применять его решение к
      // другой очереди не имеет права: план посчитан по снимку, снимок устарел.
      if (expect.kind === "plan" && typeof expect.readyKey === "string") {
        const was = new Map(
          expect.readyKey
            .split(",")
            .filter(Boolean)
            .map((part) => {
              const [id, seq] = part.split(":");
              return [id, seq || ""];
            }),
        );
        const now = new Map(ready.map((card) => [card.id, String(card.properties?.["Sequence"]?.number ?? "")]));
        // Ушла из Ready, сменился её Sequence, или карточка, которая в момент
        // вопроса была в работе, снова стала Ready — всё это чужие правки:
        // план считался по другому снимку. Появление новой карточки само по
        // себе не признак: её в этом же ответе мог создать Координатор.
        const left = [...was.keys()].filter((id) => !now.has(id));
        const moved = [...was.keys()].filter((id) => now.has(id) && now.get(id) !== was.get(id));
        const returned = (Array.isArray(expect.runningIds) ? expect.runningIds : []).filter((id) => now.has(id));
        if (left.length || moved.length || returned.length) {
          const what = [
            left.length ? `ушли из Ready: ${left.join(", ")}` : "",
            moved.length ? `сменился Sequence у ${moved.join(", ")}` : "",
            returned.length ? `вернулись в Ready из работы: ${returned.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join("; ");
          const shifts = (Number(GM_getValue("cfn-plan-shift", 0)) || 0) + 1;
          GM_setValue("cfn-plan-shift", shifts);
          GM_setValue(K.expect, null);
          GM_setValue("cfn-plan-at", 0);
          if (shifts > 2) {
            pause(
              `План Координатора не совпадает с очередью уже ${shifts}-й раз (${what}). ` +
                "Решение по устаревшей очереди не применяю: проверьте карточки и нажмите «Продолжить».",
              { kind: "plan-shift", ref: mission.id },
            );
            return true;
          }
          log(
            `Пока ждали план, очередь изменилась (${what}). Решение «${decision.next}» относится к прежней очереди — ` +
              "не применяю, прошу новый план: иначе уйдёт не та карточка.",
            true,
            { ntfy: "quiet", title: "Relay: план по устаревшей очереди" },
          );
          await requestPlan(
            mission,
            role,
            await queueOf(mission),
            `Пока ты отвечал, очередь изменилась: ${what}. Пересчитай план по текущей очереди.`,
            { force: true },
          );
          return true;
        }
        GM_setValue("cfn-plan-shift", 0);
      }

      // Миссия в маркере — проверка по существу: решение чужой миссии
      // применять нельзя, тут пауза оправдана.
      //
      // turn_id — другое дело. 25.10 (ход 41) Coordinator ответил на свежий
      // вопрос, но вписал id прошлого хода (f214b8e0 вместо 8453c8ac) и
      // потерял mission_id: транспорт встал на паузу, хотя ответ был именно
      // на наш вопрос и вёл в «Runtime Auditor» — карточка уже лежала в Ready.
      // Поле, которое транспорт знает сам, — не повод останавливать цикл:
      // берём свой turn_id, решение применяем. Ошибку агента видно в журнале,
      // а от чужой выдачи защищает `decisionRoute` ниже (роль, статус, Ready).
      const sameMission = !decision.mission_id || norm(decision.mission_id) === norm(mission.id);
      const gotTurn = String(decision.turn_id || "").trim();
      const sameTurn = !expect.turnId || !gotTurn || norm(gotTurn) === norm(expect.turnId);
      // Ожидание снимается до применения решения: иначе сбой посередине
      // применит его дважды. Но снимать его «в никуда» нельзя — 08.11 сбой
      // «draft is not defined» случился сразу после найденного маркера, и ход
      // остался без ожидания при живом ответе в чате: «Продолжить» не мог
      // перечитать ничего, а «Шаг» спрашивал новый план, то есть отправлял
      // задание Координатору второй раз. Кладём снимок хода рядом: если шаг
      // сорвётся, восстановление вернёт ожидание (см. 28-cycle.js, catch).
      GM_setValue(K.planRecover, { expect, missionId: mission.id, at: Date.now() });
      GM_setValue(K.expect, null);
      if (!sameMission) {
        pause(
          `Маркер Координатора относится к другой миссии (${decision.mission_id}), а ждём ${mission.id}: ничего не запускаю.`,
          { kind: "marker-mismatch", ref: mission.id, turnId: expect.turnId },
        );
        return true;
      }
      if (!String(decision.next || "").trim()) {
        pause(
          "В маркере Координатора нет next: кому передавать ход — непонятно. Ответ без next решением не считается.",
          { kind: "marker-mismatch", ref: mission.id, turnId: expect.turnId },
        );
        return true;
      }
      if (!sameTurn) {
        log(
          `В маркере Координатора чужой turn_id «${gotTurn}» вместо «${expect.turnId}» — беру свой из выдачи, ` +
            `решение «${decision.next}» применяю: миссия та же, а id хода транспорт знает сам.`,
          true,
          { ntfy: "quiet", title: "Relay: чужой turn_id в маркере" },
        );
        decision.turn_id = expect.turnId;
      }
      log(`Маркер Координатора найден: дальше «${decision.next}» (turn ${decision.turn_id || expect.turnId}).`);
      // Счётчик ложных остановок живёт подряд: обычное решение его обнуляет.
      if (norm(decision.next) !== "blocked") GM_setValue("cfn-blocked-norole", 0);
      // Вопрос живёт строкой в базе «Вопросы». Ход он держит только с `gate`
      // (+ `need` — кому именно), а обычный вопрос не мешает next: работа идёт
      // по варианту, который агент назвал сам.
      //
      // D-083: прямой вопрос к роли — отдельный канал, и он работает при любом next.
      //
      // До этой правки ветка вопроса стояла под `next !== "blocked"`, то есть
      // вопрос, поданный вместе с остановкой, выбрасывался целиком. А
      // останавливаться Координатору было нужно именно тогда, когда без ответа
      // роль дальше не идёт: 09.11 он дважды прислал next:"blocked" + need:"Warden"
      // и оба раза получил «роль активна, решай сам» — при том что спросить
      // Warden напрямую было нечем. Теперь вопрос читается всегда, а `need`
      // называет адресата: такой вопрос не останавливает цикл, а переводит ход
      // в ответ роли, и ответ возвращается сюда же следующим планом.
      const blocked = norm(decision.next) === "blocked";
      const need = String(decision.need || "").trim();
      let askedRow = null;
      {
        // Та же история, что у исполнителя: `"question":null` — не вопрос, а
        // вопрос без варианта по умолчанию записывается с честным вариантом
        // «работа идёт по решению Координатора» — по next он и так идёт.
        const asked = questionInMarker(decision.question, blocked
          ? "Цикл стоит: дальше — по решению Мастера"
          : "Работа идёт по решению Координатора");
        if (asked.kind === "text") {
          log(
            `Вопрос Координатора пришёл без варианта по умолчанию — записан с вариантом «${asked.question.fallback}»: дальше идём по next.`,
            false,
            { ntfy: "quiet", title: "Relay: вопрос без варианта по умолчанию" },
          );
        }
        if (asked.kind !== "none") {
          // При остановке вопрос держит ход по определению: он и есть причина
          // остановки. Адресат берётся из поля вопроса, а если его там нет —
          // из need самой остановки: это одно и то же намерение.
          if (blocked) asked.question.gate = true;
          if (!asked.question.need && need) asked.question.need = need;
          askedRow = await askQuestion(asked.question, {
            roleName: role.name,
            card: "",
            mission: rt(mission.properties["Миссия"]),
            key: `${mission.id}:${decision.turn_id || expect.turnId}`,
          });
        }
      }
      // D-080: вопрос больше не съедает ход.
      //
      // Раньше здесь стояло «next не применяется — он посчитан без ответа»:
      // любой вопрос Координатора останавливал план и отдавал ход приёмке. Так
      // и выходило противоречие, на которое указал Мастер: чтобы услышать
      // мнение Warden, Координатор обязан был встать, а «спросить между делом»
      // и «встать в ступор» были одним и тем же действием.
      // Теперь ход продолжается своим next, если вопрос НЕ держит ход.
      // Держит — только явный `gate`.
      if (askedRow && (askedRow.gate === true || askedRow.need)) {
        const item = answerQueue().find((row) => row.id === askedRow.id);
        if (item && (await startAnswer(mission, item))) return true;
      }
      if (askedRow) {
        log(
          `Вопрос Координатора записан («${oneLine(askedRow.text, 90)}») — ход идёт дальше по ` +
            `next «${decision.next}»: ответ придёт следующим планом.`,
          false,
          { ntfy: "quiet" },
        );
      }
      if (blocked) {
        // D-083: остановка с адресованным вопросом — это не тупик, а прямой
        // запрос к роли. Раньше такой маркер давал либо паузу «решай сам» (роль
        // активна), либо молчание (вопрос выбрасывался). Теперь вопрос уже лёг
        // строкой и стоит в очереди приёмки; если адресат живой — ведём ход к
        // нему, и ответ вернётся Координатору следующим планом.
        const item = askedRow?.id ? answerQueue().find((row) => row.id === askedRow.id) : null;
        if (item && (item.gate === true || item.need) && (await startAnswer(mission, item))) {
          GM_setValue("cfn-blocked-norole", 0);
          return true;
        }
        // Право Координатора остановить цикл. Повод ровно один: нужной роли
        // нет, и заменить её некем — агента в Arena создаёт Мастер. Всё
        // остальное (пустая очередь, спорный Scope, неясное ТЗ) Координатор
        // решает сам, иначе «остановлю, когда мне неудобно» съедает цикл.
        //
        // 25.10 в 19:43 он вернул next:"blocked" без need, и пауза сказала
        // «нужна роль, которой нет в «Ролях»» — при том что Tools в базе была,
        // просто «Ждёт». Поэтому текст собирается по фактам (blockedReason), а
        // не по шаблону: Мастер должен видеть, что дозаполнить, а что создать.
        // `need` прочитан выше — им же адресуется прямой вопрос (D-083).
        // Остановка законна только тогда, когда названной роли действительно
        // некому отвечать: её нет в «Ролях», у неё не «Активна» или пуст
        // «Agent URL». Роль, которая активна и имеет адрес, — не повод встать:
        // работа для неё либо есть, либо решение за Координатором.
        //
        // Всё остальное («непонятно, что дальше», пустая очередь, спорный
        // Scope) — работа Координатора, а не повод будить Мастера (1.4.80).
        // Ход возвращается ему же с точной причиной; вторая такая попытка
        // подряд — уже поломка, и тогда пауза честно зовёт человека.
        const directory = need ? await roleRows().catch(() => []) : [];
        const named = need ? directory.find((r) => norm(r.name) === norm(need)) : null;
        const canTake = Boolean(named && (named.status || "") === "Активна" && named.url);
        if (!need || canTake) {
          const why = need
            ? `роль «${need}» активна и «Agent URL» заполнен — значит, Координатор её не увидел`
            : "роль не названа";
          const tries = (Number(GM_getValue("cfn-blocked-norole", 0)) || 0) + 1;
          GM_setValue("cfn-blocked-norole", tries);
          const fresh0 = await queueOf(mission).catch(() => null);
          if (tries >= 2) {
            GM_setValue("cfn-blocked-norole", 0);
            pause(
              `Координатор второй раз подряд останавливает цикл, хотя ${why} (${fresh0?.summary || "очередь не прочитана"}). ` +
                'Остановка с next = "blocked" законна только с need = "<роль>", которой не хватает: ' +
                "очередь, Scope и неясное ТЗ решает Координатор. Посмотрите «Итог» и карточки — " +
                "или назовите роль, которой действительно не хватает.",
              { kind: "blocked-norole", ref: mission.id },
            );
            return true;
          }
          log(
            `Остановка не принята (${tries} из 2): ${why}. Ход возвращается Координатору.`,
            false,
            { tone: "warn", ntfy: "quiet" },
          );
          await requestPlan(
            mission,
            role,
            fresh0 || { summary: "очередь не прочитана" },
            'Остановка не принимается: next = "blocked" законен только с need = "<роль>", которой нет ' +
              "или которая не активна. " +
              (need ? `Роль «${need}» активна и «Agent URL» заполнен — ход возможен. ` : "") +
              "Реши сам — или назови роль, которой действительно не хватает.",
            { force: true },
          );
          return true;
        }
        GM_setValue("cfn-blocked-norole", 0);
        // Вопрос при остановке раньше выбрасывался: у него нет варианта по
        // умолчанию (цикл и так стоит), а `parseQuestion` такие не принимает.
        // Мастер видел только «нужна роль», а суть вопроса оставалась в чате.
        // Теперь он записывается в «Вопросы» с прямым вариантом по умолчанию —
        // «ждать ответа Мастера» — и попадает в текст паузы.
        const rawAsk = decision.question;
        const askText = rawAsk === undefined ? "" : oneLine(typeof rawAsk === "object" && rawAsk ? rawAsk.text : rawAsk, C.questionTextMax);
        let askRow = askedRow;
        // D-083: строка уже записана выше — второй раз не пишем. Раньше вопрос
        // при остановке парсился здесь заново и со своим вариантом по умолчанию;
        // теперь это была бы вторая строка про то же самое (и она бы снова
        // ушла приёмке вместо Мастера).
        if (!askRow && askText) {
          const ask = typeof rawAsk === "object" && rawAsk ? rawAsk : {};
          const asked = parseQuestion({
            ...ask,
            text: typeof rawAsk === "object" && rawAsk ? rawAsk.text : rawAsk,
            default: questionFallback(ask.default) || "Ответ Мастера: цикл уже остановлен и ждёт его",
            // Вопрос при `blocked` задаётся уже стоящему циклу: он ждёт Мастера
            // по определению, поэтому gate здесь не про «остановиться», а про
            // «этот вопрос не закрывается сам».
            gate: true,
          });
          if (asked) {
            askRow = await askQuestion(asked, {
              roleName: role.name,
              card: "",
              mission: rt(mission.properties["Миссия"]),
              key: `${mission.id}:${decision.turn_id || expect.turnId}:blocked`,
            });
          }
        }
        const [fresh, open] = await Promise.all([
          queueOf(mission).catch(() => null),
          questionRows([Q.wait], mission).catch(() => []),
        ]);
        pause(blockedReason({ need, directory, queue: fresh, open, ask: askText, asked: Boolean(askRow) }), {
          kind: "blocked-role",
          ref: mission.id,
          need,
          notifyTitle: "Relay: нужна роль",
        });
        return true;
      }
      if (decision.next === "done") {
        // Гейт в роли говорит «done только при нуле открытых задач», но верить
        // на слово в автоцикле опасно: закрытая миссия с живыми карточками
        // останавливает весь процесс, и заметит это только человек.
        const fresh = await queueOf(mission);
        // D-085: `Rework` — это не работа в полёте, а решение по уже сданной
        // работе, и принимает его приёмка, а не текущий ход. 09.11 в 18:51
        // Координатор честно закончил ход с next:"done" при «0 Submitted,
        // 0 Running, 0 Ready, 1 Rework, 6 Draft» — и цикл встал на ровном
        // месте: Rework никто не обязан закрыть до конца этого хода.
        //
        // Поэтому `done` блокируют только карточки, которые реально в работе
        // или ждут выдачи (Submitted/Running/Ready/Blocked). Rework и Draft
        // перечисляются в журнале, но ход не останавливают: иначе любой отказ
        // исполнителя, который сам же и перевёл карточку в Rework, вешает
        // миссию по определению.
        const open = fresh.submitted.length + fresh.running.length + fresh.ready.length + (fresh.blocked || []).length;
        const waiting = fresh.rework.length + fresh.draft.length;
        if (open === 0 && waiting > 0) {
          log(
            `Миссия: ход закончен, в работе 0, но ждут решения ${fresh.rework.length} Rework ` +
              `и ${fresh.draft.length} Draft. Это очередь приёмки, а не работа в полёте — ход не останавливаю.`,
            false,
            { ntfy: "quiet" },
          );
        }
        if (open > 0) {
          pause(
            `Координатор объявил миссию завершённой, но в очереди ${fresh.summary}. ` +
              "Миссию не закрываю: сначала закройте карточки (Accepted) или уберите их из очереди.",
            { kind: "done-with-open", ref: mission.id },
          );
          return true;
        }
        const returned = isReturned(mission);
        if (returned && !(await returnAnsweredWithBody(mission))) {
          // Сюда попадает только ответ на план, запрошенный уже после
          // возврата: старый маркер снят выше. Значит, замечания правда не
          // разобраны. Снимаем троттлинг, чтобы «Продолжить» сразу вернуло
          // ход Координатору, а не ждало минуту.
          GM_setValue("cfn-plan-at", 0);
          pause(
            "Координатор ответил «done» уже после возврата миссии, но в «Итоге» нет раздела «Возврат»: " +
              "замечания не разобраны. Нажмите «Продолжить» — он получит замечания заново; " +
              "закрывать миссию без ответа на каждое замечание нельзя.",
            { kind: "done-with-remarks", ref: mission.id },
          );
          return true;
        }
        if (fresh.draft.length) {
          log(
            `Очередь закрыта, в черновиках осталось ${fresh.draft.length} — это предложения на будущее, ` +
              "а не обязательства.",
          );
        }
        // `done` — не закрытие, а передача на приёмку: миссию закрывает
        // вердикт `accept`, а не желание Координатора закончить ход.
        if (returned) log("Миссия возвращена, «Возврат» в «Итоге» есть — передаю на приёмку повторно.");
        return startReview(mission, fresh);
      }
      // D-075 п. 4: до первой выдачи карточки миссии транспорт сверяет состав.
      // Проверка стоит здесь — после разбора Submitted и до решения о выдаче:
      // принять чужую работу некомплект не мешает, а выдать карточку роли,
      // которой нет или которая не активна, не даёт. Раньше некомплект
      // всплывал на самой отправке, то есть в самом дорогом месте.
      const rosterCards = [...ready, ...(draft || [])];
      // Вся база, а не только активные строки: по ней видно, чего именно не
      // хватает — статуса, Agent URL или самой роли (D-075 п. 4).
      const directoryNow = await roleRows().catch(() => []);
      const recipientOptions = await recipientOptionNames().catch(() => []);
      const roster = missionRoster(rosterCards, { directory: directoryNow, recipientOptions });
      if (!roster.ok) {
        const provisionPlan = provisionRosterRequest(roster.broken, provisionConfig(), provisionRequestState());
        const gate = rosterGate(rosterCards, { directory: directoryNow, recipientOptions, provision: provisionPlan });
        pause(gate.reason, { kind: "mission-roster", ref: mission.id, need: roster.broken.map((r) => r.name).join(", ") });
        return true;
      }
      const route = decisionRoute(decision.next, {
        roles: await roles(),
        directory: await roleRows().catch(() => []),
        readyRoles: ready.map(taskRole),
        misses: Number(GM_getValue("cfn-plan-miss", 0)) || 0,
      });

      if (route.kind === "pause") {
        GM_setValue("cfn-plan-miss", 0);
        pause(route.reason, { kind: "plan-miss", ref: mission.id });
        return true;
      }
      if (route.kind === "dispatch") {
        GM_setValue("cfn-plan-miss", 0);
        // Только карточка этой роли. Прежний запасной вариант «или первая из
        // Ready» отдавал исполнителю чужое задание, если роль в карточке
        // записана иначе (регистр, пробелы) — и работа уходила не туда.
        // Среди карточек роли свежая идёт впереди отвеченной: возврат в работу
        // не должен подменять новую работу.
        const card = pickReadyForRole(ready, route.roleName);
        if (!card) {
          pause(
            `Координатор направил ход в «${route.roleName}», но карточки этой роли в Ready нет: ` +
              "похоже, очередь изменилась между запросом и выдачей. Нажмите «Продолжить» — ход начнётся заново.",
            { kind: "plan-miss", ref: mission.id },
          );
          return true;
        }
        const problem = await dispatchTask(card, route.roleName, mission);
        if (problem === true) {
          GM_setValue("cfn-dispatch-miss", 0);
          return true;
        }
        // Выдача не состоялась: названная карточка не в Ready или её не удалось
        // очистить. Это не повод будить Мастера с первого раза — ход остаётся у
        // Координатора, и он получает точную причину. Пауза будет, только если
        // он трижды подряд назовёт карточку, которой нет в очереди.
        const misses = (Number(GM_getValue("cfn-dispatch-miss", 0)) || 0) + 1;
        GM_setValue("cfn-dispatch-miss", misses);
        const why = `карточка «${taskTitle(card)}» не выдана: ${problem}`;
        if (misses >= 3) {
          GM_setValue("cfn-dispatch-miss", 0);
          pause(
            `Координатор третий раз подряд направляет ход в «${route.roleName}», но ${why}. ` +
              "Работа не потеряна, очередь на месте: посмотрите карточку в Notion, исправьте названную причину " +
              "(для выдачи проверьте состояние и постановку) и нажмите «Продолжить».",
            { kind: "redispatch", ref: card.id },
          );
          return true;
        }
        log(`Ход не передан: ${why}. Возвращаю Координатору.`, true, { ntfy: "quiet" });
        const fresh = await queueOf(mission);
        await requestPlan(mission, role, fresh, `Карточку выдать не удалось — ${problem} Исправь названную причину и повтори next.`, {
          force: true,
        });
        return true;
      }

      // ask: ход возвращается Координатору — это его следующий ход, а не
      // ошибка. Просим план заново, но с подсказкой, чего не хватает.
      GM_setValue("cfn-plan-miss", (Number(GM_getValue("cfn-plan-miss", 0)) || 0) + 1);
      const fresh = await queueOf(mission);
      log(`Ход снова у Координатора: ${fresh.summary}. Прошу закончить ход.`);
      await requestPlan(mission, role, fresh, route.note, { force: true });
      return true;
    }

    const note = submitted.length
      ? "Разбери Submitted — и в этом же ответе выставь следующую карточку Ready, если очередь опустеет."
      : rework.length
        ? "Есть Rework: посмотри «Ответ» — там причина (например, PR закрыт без мержа)."
        : "";
    return requestPlan(mission, role, await queueOf(mission), note, { manual });
  }

  /**
   * Запрос хода Координатора. `force` нужен, когда ход возвращается ему же по
   * его собственному решению: там минута ожидания была бы наказанием за
   * аккуратный ответ, а не защитой от спама.
   */
  async function requestPlan(mission, role, queue, note = "", { manual = false, force = false } = {}) {
    const lastPlan = GM_getValue("cfn-plan-at", 0);
    const waitMs = force ? 5_000 : 60_000;
    if (Date.now() - lastPlan < waitMs) {
      if (manual) log(`Шаг не выполнен: план запрашивали ${Math.ceil((waitMs - (Date.now() - lastPlan)) / 1000)} с назад.`);
      return false;
    }
    GM_setValue("cfn-plan-at", Date.now());
    // Новый план отменяет снимок недоприменённого ответа: он относится к
    // прошлому ходу, и восстанавливать его рядом с новым ожиданием нельзя.
    GM_setValue(K.planRecover, null);

    const summary =
      queue.summary ||
      `${queue.submitted.length} Submitted, ${queue.running.length} Running, ${queue.ready.length} Ready, ` +
        `${queue.rework.length} Rework, ${(queue.draft || []).length} Draft`;
    const turnId = uid();
    // Ход Координатора начинается с разбора Submitted: даём ссылку на журнал
    // ответа, который он принимает, а не только счётчики очереди.
    const answerLine = answerLogLine(queue.submitted);
    log(`План Координатора запрошен (${summary}).`);
    // Вся база, а не только активные: по ней видно, чего именно не хватает —
    // статуса, Agent URL или самой роли.
    const directory = await roleRows().catch(() => []);
    const drafts = draftLine(queue.draft || [], directory);
    // Вопросы к Мастеру и его ответы: ответы доставляются ровно один раз —
    // отметка ставится после того, как промпт действительно ушёл.
    const briefing = await questionBriefing(mission);
    // План запрошен до возврата или уже после него? Решается один раз, здесь,
    // и кладётся в ожидание снимком. Спрашивать об этом карточку позже нельзя:
    // Координатор допишет «Итог», «последняя правка» уедет вперёд, и уже
    // отправленный план с замечаниями будет выглядеть как план без них. 06.11:
    // так в 17:19 сняли живой ход и переспросили план через 11 минут после
    // ответа.
    //
    // Признак «после возврата» — не отметка времени, а содержимое задачи:
    // returnBlock непустой, если миссия возвращена и в карточке есть
    // «Замечания». Значит, этот план замечания несёт. Время возврата — только
    // страховка для случая без «Замечаний» (там returnBlock пуст, и возврат
    // разбирается отдельной паузой return-empty).
    const planBeforeReturn = !isReturned(mission)
      ? false
      : returnBlock(mission)
        ? false
        : Date.now() < (Number(returnEpoch(mission).at) || 0);
    // Recovery — скомпилированный профиль coordinator.recovery с теми же ID и
    // снимком очереди; ручной склейки промпта здесь больше нет.
    const recoveryEnvelope = PromptCompiler.compile({
      kind: "plan", role: promptRole(role), mission: { id: mission.id, name: rt(mission.properties["Миссия"]) },
      turnId,
      note,
      queue: { summary, ready: readyLine(queue.ready, directory), rework: reworkLine(queue.rework, directory), draft: drafts, answerLine, openLine: briefing.openLine, answersLine: briefing.answersLine },
      delivery: { tier: "recovery" },
    });
    const fallbackText = recoveryEnvelope.ok ? recoveryEnvelope.text : summary;
    const sent = await sendToRole(
      role,
      coordinatorPrompt(
        mission,
        role,
        summary,
        turnId,
        note,
        answerLine,
        drafts,
        readyLine(queue.ready, directory),
        reworkLine(queue.rework, directory),
        briefing.openLine,
        briefing.answersLine,
      ),
      "plan",
      mission.id,
      {
        missionId: mission.id,
        turnId,
        title: "план Координатора",
        fallbackText,
        planContext: summary,
        // Снимок «с замечаниями или без»: по нему снятие устаревшего
        // ожидания не переспрашивает план, ответ на который уже пришёл.
        planBeforeReturn,
        // Снимок очереди на момент вопроса: по нему видно, устарел ли ответ.
        readyKey: readyKeyOf(queue.ready),
        runningIds: (queue.running || []).map((card) => card.id),
      },
    );
    if (sent) await markDelivered(briefing.fresh);
    return true;
  }
