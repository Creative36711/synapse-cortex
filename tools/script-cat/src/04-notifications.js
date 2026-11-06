  // ───────────────────────────── ntfy ─────────────────────────────
  /**
   * Громкий пуш разрешён только событию, которое остановило цикл. Ошибка в
   * журнале сама по себе этого не доказывает: например, PR без мержа может
   * вернуться Координатору, а временный сбой — повториться автоматически.
   * Тихие события ограничиваются ниже при отправке, журнал остаётся полным.
   */
  const QUIET_NTFY = [
    /→ Submitted/,
    /^Пауза снята Мастером/,
    /^Миссия завершена/,
    /вернулась в Ready/,
  ];

  function classifyNtfy(text, error = false, options = {}) {
    if (options.skip || options.ntfy === false) return null;
    const clean = String(text || "").trim();
    if (!clean) return null;
    const requestedLoud = options.ntfy === "loud" || options.urgent === true;
    if (requestedLoud && options.cycleStopped === true) {
      return {
        loud: true, priority: "5", tags: "warning,rotating_light",
        title: options.title || "Relay: цикл остановлен", cycleStopped: true, key: options.ntfyKey || "",
      };
    }
    if (requestedLoud || options.ntfy === "quiet" || QUIET_NTFY.some((re) => re.test(clean))) {
      return {
        loud: false, priority: "2", tags: "memo", title: options.title || "Relay",
        cycleStopped: options.cycleStopped === true, key: options.ntfyKey || "",
      };
    }
    // Непредусмотренная ошибка остаётся в журнале; если она остановит цикл,
    // pause() отправит одно уведомление с настоящей причиной остановки.
    return null;
  }

  /**
   * Публикация через JSON, а не через заголовки.
   *
   * Почему: `X-Title`/`X-Tags` — обычные HTTP-заголовки, а они допускают только
   * ISO-8859-1. Кириллица в заголовке отклоняется браузером ещё до отправки,
   * и запрос тихо не уходит — именно так «тест ничего не делает». В JSON-теле
   * UTF-8 разрешён, а ntfy читает topic/title/priority/tags оттуда.
   */
  /**
   * В автоцикле тик идёт каждые 15 секунд. Фразы вроде «нет активной миссии»
   * не должны занимать журнал целиком: пишем их не чаще раза в 5 минут.
   */
  const throttleAt = {};
  function logThrottled(key, text, error = false, ms = 300_000) {
    const now = Date.now();
    if (now - Number(throttleAt[key] || 0) < ms) return;
    throttleAt[key] = now;
    log(text, error);
  }

  const NTFY_BASE = "https://ntfy.sh";
  const SCRIPT_VERSION =
    (typeof GM_info !== "undefined" && GM_info?.script?.version) || "1.12.13";

  /** «https://ntfy.sh/topic?x=1» и «topic» одинаково дают topic. */
  function normalizeNtfyTopic(raw) {
    let value = String(raw || "").trim();
    if (!value) return "";
    value = value.replace(/^https?:\/\//i, "").replace(/^ntfy\.sh\//i, "");
    value = value.split(/[?#]/)[0].replace(/\/+$/, "");
    const last = value.split("/").filter(Boolean).pop() || "";
    return /^[A-Za-z0-9_-]{1,64}$/.test(last) ? last : "";
  }

  /** GM_xmlhttpRequest в обёртке: одинаковый результат и в ScriptCat, и в тестах. */
  function gmRequest({ method = "GET", url, headers = {}, body, timeout = 15000 }) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest недоступен"));
        return;
      }
      try {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: body,
          timeout,
          onload: (r) => resolve({ status: r.status, text: String(r.responseText || "").slice(0, 300) }),
          onerror: () => reject(new Error("сеть недоступна или хост не разрешён в @connect")),
          ontimeout: () => reject(new Error("таймаут")),
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Отправка пуша: сначала GM (обходит CSP страницы), затем обычный fetch —
   * ntfy отдаёт CORS-заголовки, так что второй путь работает без @connect.
   * Ошибки складываются в одно сообщение: по нему видно, где именно порвалось.
   */
  async function ntfyPublish(topic, token, { message, title = "Relay", priority = 2, tags = [] } = {}) {
    const name = normalizeNtfyTopic(topic);
    if (!name) throw new Error("топик не задан или содержит недопустимые символы");
    const payload = JSON.stringify({
      topic: name,
      message: String(message).slice(0, 3500),
      title: String(title),
      priority: Number(priority) || 2,
      tags: String(tags).split(",").map((t) => t.trim()).filter(Boolean),
    });
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = `${NTFY_BASE}/`;

    let gmError = "";
    try {
      const r = await gmRequest({ method: "POST", url, headers, body: payload });
      if (r.status >= 200 && r.status < 300) return { via: "gm", status: r.status };
      gmError = `HTTP ${r.status} ${r.text.slice(0, 120)}`.trim();
    } catch (e) {
      gmError = e.message;
    }

    try {
      // D-041: таймаут как у GM-пути ntfy (15 с) — fallback не висит вечно.
      const res = await fetchWithTimeout(url, { method: "POST", headers, body: payload }, 15000);
      if (res.ok) return { via: "fetch", status: res.status };
      const text = (await res.text()).slice(0, 120);
      throw new Error(`HTTP ${res.status} ${text}`.trim());
    } catch (e) {
      throw new Error(`GM: ${gmError}; fetch: ${e.message}`);
    }
  }

  /** Проверка связи отдельно от публикации: жив ли ntfy.sh и каким путём. */
  async function ntfyHealth() {
    const out = [];
    try {
      const r = await gmRequest({ url: `${NTFY_BASE}/v1/health` });
      out.push(`GM: HTTP ${r.status} ${r.text.slice(0, 80)}`.trim());
    } catch (e) {
      out.push(`GM: ${e.message}`);
    }
    try {
      // D-041: таймаут как у GM-пути ntfy (15 с) — fallback не висит вечно.
      const res = await fetchWithTimeout(`${NTFY_BASE}/v1/health`, { cache: "no-store" }, 15000);
      out.push(`fetch: HTTP ${res.status} ${(await res.text()).slice(0, 80)}`.trim());
    } catch (e) {
      out.push(`fetch: ${e.message}`);
    }
    return out;
  }
