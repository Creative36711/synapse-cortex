  // ───────────────────────────── HTTP ─────────────────────────────
  /**
   * Сбой, который имеет смысл повторить: запрос не дошёл или чужая сторона
   * ответила своей ошибкой.
   *
   * 27.10 в 19:23 POST `data_sources/…/query` получил от Notion HTTP 502 —
   * ответ на стороне Notion, карточка и ход целы. Раньше такой ответ считался
   * отказом по существу, повтора не было, и цикл вставал на паузу из-за
   * чужой пятиминутной аварии.
   */
  const networkish = (text) =>
    /сеть|таймаут|failed to fetch|network|load failed|HTTP (?:429|5\d\d)/i.test(String(text || ""));

  /**
   * Причина обрыва в читаемом виде.
   *
   * 29.10 в 10:08 цикл встал на паузе посреди шага 5.20: POST
   * `data_sources/ed076bfe-…/query` не получил вообще ничего — ни кода, ни
   * тела ответа. Notion был жив (отдельный запрос в ту же минуту это
   * подтвердил), но `onerror` не сохранял ни `statusText`, ни `error`:
   * «оборвано» и «запрещено менеджером скриптов» выглядели одинаково, а
   * фраза про `@connect` отправляла Мастера искать блокировку, которой нет.
   */
  function linkError(kind, r) {
    const detail = [r && r.statusText, r && r.error && (r.error.message || String(r.error))]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" / ");
    const err = new Error(detail ? `${kind}: ${detail}` : kind);
    err.status = 0;
    err.link = true;
    return err;
  }

  function requestOnce(method, url, headers, body, timeout = 45000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        // Строка уходит как есть: шлюз Apps Script читает `postData.contents`
        // и ждёт там JSON-текст, а не JSON-строку в кавычках.
        data: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        timeout,
        onload: (r) => {
          let parsed = null;
          try {
            parsed = r.responseText ? JSON.parse(r.responseText) : null;
          } catch {
            parsed = r.responseText;
          }
          if (r.status >= 200 && r.status < 300) resolve(parsed);
          else {
            const err = new Error(`HTTP ${r.status}: ${(parsed && (parsed.message || parsed.error)) || r.statusText}`);
            // Код нужен вызывающему: 404 приватного репозитория и 404 «PR нет» —
            // разные вещи, и различает их только наличие токена (1.4.49).
            err.status = Number(r.status) || 0;
            reject(err);
          }
        },
        onerror: (r) => reject(linkError("сеть недоступна или запрос оборвался", r)),
        ontimeout: (r) => reject(linkError("таймаут запроса", r)),
      });
    });
  }

  /**
   * Запрос с одним повтором на сетевом сбое.
   *
   * 24.10 (14:41) шаг упал на «Failed to fetch» посреди записи ответа: цикл
   * встал на паузе из-за секундного сбоя сети. Повтор дешевле, чем Мастер у
   * экрана; повторяем только то, что не дошло (сеть, таймаут), — отказ прав
   * или HTTP 4xx повторять незачем.
   */
  async function request(method, url, headers, body, opts = {}) {
    // Кому нужен свой распорядок повторов, тот просит один запрос: иначе
    // вложенные циклы перемножаются (2 × 3 = шесть попыток на один сбой), и
    // выдержка перестаёт быть предсказуемой. Так делает `notion()`.
    const tries = opts.retry === false ? 1 : 2;
    let last = null;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        return await requestOnce(method, url, headers, body);
      } catch (e) {
        last = e;
        // Выдержка — только перед следующей попыткой. Иначе последняя,
        // заведомо холостая пауза добавляла 0,7 с к каждой неудаче.
        if (attempt === tries - 1 || !networkish(e && e.message)) break;
        await sleep(700);
      }
    }
    throw last;
  }

  /**
   * Сбой, который имеет смысл повторить: обрыв, таймаут, 429 или чужая 5xx.
   *
   * Обрыв (`status 0`) раньше повторялся реже, чем 502: внешний цикл смотрел
   * только на `HTTP 429|5xx`, и секундная потеря связи стоила паузы. 29.10
   * именно так встал шаг 5.20 — на девятом часу работы, без единого отказа
   * Notion по существу.
   */
  const retriable = (e) =>
    Boolean(e) && (Number(e.status) === 0 || /HTTP (?:429|5\d\d)/i.test(String(e.message || "")));

  /**
   * Связь после обрыва: два зонда, через 5 и 15 секунд.
   *
   * `true` — Notion снова отвечает, и шаг повторяется; `false` — связи нет,
   * и пауза говорит об этом прямо. Зонд — самое дешёвое чтение: `users/me`.
   */
  async function linkBack() {
    const token = GM_getValue(K.notion, "");
    for (const wait of C.linkProbeWaits) {
      await sleep(wait);
      try {
        // Короткий таймаут: зонд — это «есть связь или нет», а не запрос данных.
        // Два зонда по 45 с растянули бы паузу сильнее, чем сама поломка.
        await requestOnce("GET", "https://api.notion.com/v1/users/me", {
          Authorization: `Bearer ${token}`,
          "Notion-Version": C.notionV,
        }, 8000);
        log(
          `Связь с Notion пропадала и вернулась через ${Math.round(wait / 1000)} с — повторяю запрос.`,
          false,
          { tone: "warn", ntfy: "quiet" },
        );
        return true;
      } catch {
        /* зонд не прошёл — ждём следующий */
      }
    }
    return false;
  }

  const isUuid = (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim());

  /**
   * Привести имена полей результата к каноническим только после проверки ID.
   * Чужие и отсутствующие значения не подменяются значениями ожидания:
   * вызывающий код оставляет ожидание и сохраняет отвергнутый результат.
   */
  function adoptIds(result, expect) {
    const fixed = { ...result };
    const stray = [];
    // Короткие ключи `dispatch`/`run` — не «чужой id», а тот же самый: 25.10
    // Tools прислал маркер с верными значениями под короткими именами, и
    // журнал получил предупреждение о битом id. Принимаем синонимы молча;
    // вслух называем только то, что действительно не совпало.
    const given = (...keys) => {
      for (const key of keys) {
        const value = fixed[key];
        if (value !== undefined && value !== null && value !== "") return String(value);
      }
      return "";
    };
    const dispatch = given("dispatch_id", "dispatch", "dispatchId");
    const run = given("run_id", "run", "runId");
    if (!isUuid(dispatch) || !isUuid(expect.ref) || norm(dispatch) !== norm(expect.ref)) {
      stray.push(`dispatch_id «${dispatch || "нет"}»`);
    }
    if (!isUuid(run) || !isUuid(expect.runId) || norm(run) !== norm(expect.runId)) {
      stray.push(`run_id «${run || "нет"}»`);
    }
    // Приводим только имена полей, не значения: чужие/пустые ID не подменяем.
    if (!stray.length) { fixed.dispatch_id = dispatch; fixed.run_id = run; }
    return { result: fixed, stray };
  }

  async function notion(method, path, body) {
    const token = GM_getValue(K.notion, "");
    if (!token) throw new Error("Не задан Notion token: откройте ?cf-auth-setup=1 и нажмите ⚙.");
    // Страховка от чужого текста в адресе: 24.10 исполнитель прислал в маркере
    // id с опечаткой, и Notion ответил HTTP 400 «path.page_id should be a valid
    // uuid», а цикл встал на паузу с нечитаемой причиной. Лучше остановиться
    // здесь и сказать по-русски, что именно не так.
    const segment = String(path).match(/^(?:pages|blocks|data_sources)\/([^/?#]+)/);
    if (segment && !isUuid(segment[1]))
      throw new Error(`в адресе записи битый id «${segment[1]}» — запрос не отправлен`);
    // Повторяем только то, что безопасно повторить: чтение, правку свойств и
    // запрос очереди. Создание страниц (`POST pages`) не повторяем никогда —
    // на 502 или на обрыве запрос мог уже пройти, и повтор сделал бы вторую
    // карточку.
    const safeToRepeat = (method !== "POST" || /\/query$/.test(String(path))) &&
      !(method === "PATCH" && /\/children$/.test(String(path)));
    const url = `https://api.notion.com/v1/${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Notion-Version": C.notionV,
      "Content-Type": "application/json",
    };
    // Распорядок один на всех: 4 попытки с выдержкой 0,8 / 2,5 / 6 с. Обрыв
    // связи повторяется так же, как 5xx: это одинаково чужой сбой.
    const tries = safeToRepeat ? C.retryWaits.length + 1 : 1;
    let last = null;
    for (let attempt = 0; attempt < tries; attempt += 1) {
      try {
        return await request(method, url, headers, body, { retry: false });
      } catch (e) {
        last = e;
        if (attempt === tries - 1 || !retriable(e)) break;
        await sleep(C.retryWaits[attempt]);
      }
    }
    // Связи нет — но это может быть сон машины или фоновая вкладка, а не
    // поломка. Прежде чем останавливать цикл, проверяем связь и повторяем.
    if (safeToRepeat && Number(last.status) === 0) {
      if (await linkBack()) {
        try {
          return await request(method, url, headers, body, { retry: false });
        } catch (e) {
          last = e;
        }
      } else {
        last.probed = true;
      }
    }
    last.relay = "notion";
    // «Не ответил», «ответил отказом» и «связь пропала» — разные поломки. 4xx
    // значит, что Notion всё получил и объяснил, что не так с данными: чинить
    // надо запрос, а не сеть. 28.10 HTTP 400 «content.length should be ≤ 2000»
    // показывался как «сеть или блокировка», и Мастер искал сеть, которой
    // ничего не было. 429 и 5xx — короткий сбой на стороне Notion.
    const raw = String(last.message || "");
    last.message =
      /HTTP 4\d\d/i.test(raw) && !/HTTP 429/i.test(raw)
        ? `Notion отказал на ${method} ${path} (он получил запрос и не принял данные): ${raw}`
        : last.probed
          ? `Notion не ответил на ${method} ${path}: ${raw}; связь не восстановилась за ` +
            `${Math.round(C.linkProbeWaits.reduce((a, b) => a + b, 0) / 1000)} с (два зонда users/me)`
          : `Notion не ответил на ${method} ${path}: ${raw}`;
    throw last;
  }

  /**
   * Вызов шлюза Drive.
   *
   * 24.10 (14:41) запись ответа упала на «Failed to fetch»: шлюз вызывался
   * обычным `fetch` из страницы Arena, а такой запрос живёт по правилам
   * страницы (CORS и её CSP). Сеть при этом была жива. Теперь первый путь —
   * `GM_xmlhttpRequest` расширения: он страницу обходит, а `@connect
   * script.google.com` в заголовке скрипта уже есть. `fetch` остался вторым,
   * как у пушей.
   */
  async function gateway(action, fileId, extra = {}) {
    const credentials = { url: GM_getValue(K.gwUrl, ""), key: GM_getValue(K.gwKey, "") };
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
      if (ACTIVE_PROFILE.invalid) throw new Error("Профиль недоступен: запрос в Drive запрещён.");
      // Шлюз 1.5 игнорирует неизвестное поле projectId. Не посылаем через него
      // ни read, ни запись, даже если адрес и ключ ошибочно принадлежат Relay.
      const ping = await gatewayWithCredentials("ping", "", { projectId: ACTIVE_PROFILE.id }, credentials);
      if (!ping || ping.projectScoped !== true || ping.projectId !== ACTIVE_PROFILE.id ||
          ping.project?.name !== ACTIVE_PROFILE.driveFolder) {
        const error = new Error("Шлюз не подтвердил этот проект и папку: нужен проектный шлюз 1.6.");
        error.relay = "gateway"; error.refused = true; error.reason = error.message; throw error;
      }
      return gatewayWithCredentials(action, fileId, { ...extra, projectId: ACTIVE_PROFILE.id }, credentials);
    }
    return gatewayWithCredentials(action, fileId, extra, credentials);
  }

  async function gatewayWithCredentials(action, fileId, extra, { url, key }) {
    if (!url) throw new Error("Не задан URL шлюза Drive: откройте ⚙ и вставьте ссылку /exec.");
    const payload = JSON.stringify({ action, fileId, key, ...extra });
    const headers = { "Content-Type": "text/plain;charset=utf-8" };

    let gmError = "";
    let refused = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const data = await request("POST", url, headers, payload);
        if (data && data.ok === true) return data;
        const why = String((data && data.error) || "шлюз вернул отказ");
        // append идемпотентен по маркеру: «duplicate» — это «запись уже в
        // журнале», а не отказ. Без этого шаг, сорвавшийся ПОСЛЕ записи
        // журнала (так было на NAR-1.10: ответ записан, запись в Notion
        // прервалась), не мог завершиться никогда: повтор упирался в
        // собственный маркер и падал на нём же.
        if (action === "append" && /duplicate/i.test(why)) return { ok: true, duplicate: true };
        // Шлюз ответил и отказал — это не молчание. Повтор и второй путь дадут
        // тот же ответ (а у append есть побочный эффект), поэтому сразу наверх:
        // Мастеру важно видеть «отказал, потому что…», а не «не ответил».
        refused = why;
        gmError = why;
        break;
      } catch (e) {
        gmError = String((e && e.message) || e);
        if (!networkish(gmError)) break;
        await sleep(700);
      }
    }

    let fetchError = "";
    if (!refused) {
      try {
        const res = await fetch(url, { method: "POST", headers, body: payload });
        const data = await res.json();
        if (data && data.ok === true) return data;
        if (action === "append" && /duplicate/i.test(String((data && data.error) || ""))) return { ok: true, duplicate: true };
        refused = String((data && data.error) || "");
        fetchError = refused || `HTTP ${res.status}`;
      } catch (e) {
        fetchError = String((e && e.message) || e);
      }
    }

    const err = new Error(
      refused
        ? `шлюз Drive отказал: ${refused}`
        : `шлюз Drive не ответил: GM: ${gmError}; fetch: ${fetchError}`,
    );
    err.relay = "gateway";
    err.refused = Boolean(refused);
    err.reason = refused;
    throw err;
  }
