  // ───────────────────────────── утилиты ─────────────────────────────
  /**
   * Момент последнего признака жизни шага. Объявлен здесь, а не рядом с циклом:
   * `sleep` нужен всем, и он же отмечает, что шаг жив.
   */
  let busyAt = 0;

  /**
   * Пауза с отметкой «шаг жив». Сторож снимает блокировку по двухминутной
   * тишине, поэтому долгая, но честная работа не должна выглядеть зависанием:
   * 24.10 в 14:48 живого шага как раз и перезапустили поверх первого.
   */
  const sleep = (ms) => {
    busyAt = Date.now();
    return new Promise((r) => setTimeout(r, ms));
  };
  const norm = (x) => String(x || "").replace(/-/g, "").toLowerCase();
  /** Текст для сравнения: без разницы в регистре и пробелах. */
  const flat = (x) => String(x || "").replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();
  const nowIso = () => new Date().toISOString();
  const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || "").join("");

  /** Локальный архив непригодных маркеров: не исправляем и не отправляем наружу. */
  function retainRejectedResult(expect, kind, replies) {
    try {
      const key = "cfn-rejected-results-v1";
      const prior = GM_getValue(key, []);
      if (!Array.isArray(prior)) return false;
      const raw = (replies || []).map((message) => String(message.raw || message.text || "")).filter(Boolean).join("\n\n");
      if (!raw) return false;
      const item = { kind, ref: String(expect?.ref || ""), runId: String(expect?.runId || ""),
        turnId: String(expect?.turnId || ""), at: nowIso(), raw };
      if (prior.some((old) => old.kind === kind && old.ref === item.ref && old.runId === item.runId &&
          old.turnId === item.turnId && old.raw === raw)) return true;
      // Не выбрасываем старые ответы при переполнении; предупредим, что
      // остался только оригинал в чате и его нужно сохранить вручную.
      if (prior.length >= 100) return false;
      GM_setValue(key, [...prior, item]);
      return true;
    } catch { return false; }
  }

  /**
   * `rich_text` для поля Notion: один объект — не больше 2000 знаков.
   *
   * 28.10 в 22:00 цикл дважды подряд встал на записи ответа приёмки: Notion
   * ответил HTTP 400 «body.properties.Ответ.rich_text[0].text.content.length
   * should be ≤ 2000, instead was 2296». Ответ был верный и полный — длина
   * решения не порок, а предел одного объекта. Notion принимает до 100
   * объектов в массиве, поэтому длинный текст режется на части и уезжает
   * целиком, без потери второй половины решения.
   *
   * Ошибка транспорта была второй и худшей: любой HTTP-ответ, включая 400,
   * назывался «Notion не ответил: сеть или блокировка запроса» — сеть тут ни
   * при чём, Notion ответил и объяснил причину.
   */
  function richText(value, step = 1900) {
    const text = String(value == null ? "" : value);
    const parts = [];
    let at = 0;
    while (at < text.length && parts.length < 100) {
      let end = Math.min(text.length, at + step);
      // Суррогатная пара на границе: половина эмодзи ломает JSON запроса.
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      parts.push({ type: "text", text: { content: text.slice(at, end) } });
      at = end;
    }
    return parts;
  }
  const sel = (p) => p?.select?.name || "";
  const uid = () => crypto.randomUUID();

  /**
   * Видимость по геометрии плюс computed style. Одного querySelector мало:
   * в DOM Arena остаются скрытые бейджи и кнопки прошлых состояний, и без
   * проверки «Stop» находится на странице, где агент давно молчит.
   */
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    // Нулевая площадь — не «видно». В DOM Arena остаются кнопки и плашки
    // прошлых состояний: rect у них есть, а ширины и высоты нет. Именно такая
    // кнопка Stop от прошлой генерации держала шаг в ожидании.
    const rect = el.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  /** Шлюз 1.5 — первый, который пишет только в Arena; всё старше — предупреждение. */
  const gatewayIsOld = (version) => {
    const [major, minor] = String(version).split(".").map((x) => Number(x) || 0);
    return major < 1 || (major === 1 && minor < 5);
  };

  let entries = [];

  /**
   * Журнал живёт в ScriptCat и не должен расти бесконечно: храним только
   * последние maxLog записей, а старые отбрасываем при каждой записи и при
   * загрузке страницы. Кнопка «Очистить» удаляет и память, и сохранённый хвост.
   */
  /**
   * Цвет строки журнала. Красный — ошибка и пауза, зелёный — событие, которое
   * Мастеру важно увидеть (миссия завершена), жёлтый — предупреждение.
   * До 1.4.42 состояний было два, и «задача → Submitted» или конец миссии
   * выглядели как рутина наравне с «открыл страницу роли».
   */
  const logColor = (e) =>
    e.error ? "#ff9a9a" : e.tone === "ok" ? "#8ee28e" : e.tone === "warn" ? "#ffd479" : "inherit";

  function renderLog() {
    const el = document.getElementById(ui.log);
    if (!el) return;
    el.innerHTML = entries
      .slice(-C.maxLog)
      .map((e) => `<div style="opacity:${e.error ? 1 : 0.85};color:${logColor(e)}">${escapeHtml(e.t)}</div>`)
      .join("");
    el.scrollTop = el.scrollHeight;
    const counter = document.getElementById(ui.count);
    if (counter) counter.textContent = `${entries.length}/${C.maxLog}`;
  }

  const escapeHtml = (text) =>
    String(text).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

  function clearLog() {
    entries = [];
    GM_setValue(K.log, []);
    console.log("[Relay] журнал очищен");
    renderLog();
    setStatus();
    log("Журнал очищен.");
  }

  /**
   * В журнал попадает всё; в ntfy — только важное. Тем самым «тихий» и
   * «громкий» поток разделены: см. classifyNtfy ниже.
   */
  function log(text, error = false, options = {}) {
    entries.push({ t: `${new Date().toLocaleTimeString("ru-RU")} ${text}`, error, tone: options.tone || "" });
    entries = entries.slice(-C.maxLog);
    GM_setValue(K.log, entries);
    console.log(`[Relay] ${text}`);
    renderLog();
    setStatus();
    const plan = classifyNtfy(text, error, options);
    if (plan) notifyNtfy(options.ntfyText || text, plan);
  }
