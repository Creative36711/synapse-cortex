  // ───────────────────────── эфемерные пилоты SYN-P1 ─────────────────────────
  // Пилот — разовый прогон публичного брифа на отдельном Arena-агенте, URL
  // которого предоставляет Мастер вручную. Создание/клонирование агентов НЕ
  // реализовано (отдельное ТЗ). Состояние пилота живёт в собственном namespace
  // (K.pilots / K.pilotWait / K.pilotTranscript) и никогда не трогает
  // K.pending / K.expect командного транспорта.

  const PILOT_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 часа до вызова Мастера
  const PILOT_FORBIDDEN = [
    /CF_[A-Z]+_RESULT/, /\bCF_[A-Z_]+\b/, /notion/i, /cortex/i,
    /REGULATION/, /WARDEN/i, /DECISIONS/, /synapse-cortex/i,
  ];
  const pilotBriefClean = (brief) => {
    const text = String(brief || "");
    return text.trim().length > 0 && !PILOT_FORBIDDEN.some((re) => re.test(text));
  };
  const pilotVariant = (brief) => {
    const m = String(brief || "").trim().match(/^(?:бриф\s+)?([ABC])\b/i);
    return m ? m[1].toUpperCase() : "";
  };

  const listPilots = () => {
    const raw = GM_getValue(K.pilots, []);
    return Array.isArray(raw) ? raw : [];
  };
  const savePilots = (list) => GM_setValue(K.pilots, list.slice(-50));

  /**
   * Регистрация пилотного агента. URL даёт Мастер; автосоздания нет.
   * Идемпотентно по URL: повторная регистрация возвращает тот же id.
   * Изоляция: бриф только публичный (A/B/C), без внутренних токенов; URL не
   * должен совпадать с боевой ролью команды; startSha — 40 hex.
   */
  function registerPilotAgent({ url, brief, startSha, isolation = "" } = {}) {
    const clean = String(url || "").trim();
    if (!/^https:\/\//i.test(clean)) return { ok: false, error: "pilot URL должен быть https" };
    let host = ""; let path = "";
    try { const u = new URL(clean); host = u.host; path = u.pathname; } catch { return { ok: false, error: "pilot URL не разбирается" }; }
    if (!/arena|e2b|app/i.test(host)) return { ok: false, error: "pilot URL не похож на страницу Arena-агента" };
    if (!/^[0-9a-f]{40}$/i.test(String(startSha || ""))) return { ok: false, error: "startSha должен быть 40-hex SHA коммита synapse" };
    if (!pilotBriefClean(brief)) return { ok: false, error: "бриф содержит внутренние токены (CF_/Notion/cortex/REGULATION/WARDEN/DECISIONS) или пуст" };
    const variant = pilotVariant(brief);
    if (!["A", "B", "C"].includes(variant)) return { ok: false, error: "бриф должен быть помечен вариантом A, B или C" };
    if (!String(isolation || "").trim()) return { ok: false, error: "нужно подтверждение изоляции от Мастера (isolation)" };
    // Не боевая роль: сверяем с кешем ролей и с known team-путями.
    const roles = GM_getValue(K.rolesCache, []);
    const roleList = Array.isArray(roles) ? roles : (roles?.rows || []);
    if (roleList.some((r) => norm(r.url) === norm(clean))) {
      return { ok: false, error: "pilot URL совпадает с боевой ролью команды — изоляция нарушена" };
    }
    const existing = listPilots().find((p) => norm(p.url) === norm(clean));
    if (existing) return { ok: true, id: existing.id, reused: true };
    const id = uid();
    savePilots([...listPilots(), {
      id, url: clean, host, path, variant, startSha: String(startSha).toLowerCase(),
      briefHash: PromptCompiler.hash(String(brief)), brief: String(brief),
      isolation: String(isolation), registeredAt: nowIso(), status: "registered",
    }]);
    return { ok: true, id, reused: false };
  }

  const getPilot = (id) => listPilots().find((p) => p.id === id) || null;

  /** Поставить пилот в очередь отправки (отдельный namespace) и перейти на URL. */
  function sendToEphemeralAgent(id) {
    const pilot = getPilot(id);
    if (!pilot) return { ok: false, error: "пилот не зарегистрирован" };
    const envelope = PromptCompiler.compile({
      kind: "pilot", role: { fn: "pilot", name: `pilot-${pilot.variant}` },
      pilot: { brief: pilot.brief, repo: "Creative36711/synapse", startSha: pilot.startSha },
      delivery: { tier: "full" },
    });
    if (!envelope.ok) return { ok: false, error: envelope.error.message };
    GM_setValue(K.pilotWait + id, {
      id, url: pilot.url, text: envelope.text, prompt: envelope,
      at: Date.now(), sentAt: 0, watermark: "", seen: [], status: "queued",
    });
    savePilots(listPilots().map((p) => (p.id === id ? { ...p, status: "queued" } : p)));
    log(`Пилот ${pilot.variant} (${id.slice(0, 8)}) поставлен в очередь; перехожу на ${pilot.url}.`, true, { ntfy: "quiet", title: "Relay: пилот SYN-P1" });
    location.assign(pilot.url);
    return { ok: true, id };
  }

  const pilotOnPage = (wait) => {
    try { return new URL(wait.url, location.href).pathname === location.pathname; } catch { return false; }
  };

  /**
   * Тик пилота: вызывается ДО consumePending. Возвращает true, если ход занят
   * пилотом. Завершение — по фактам (idle + финальный отчёт), не по маркеру.
   */
  async function consumePilot() {
    const waits = listPilots()
      .map((p) => GM_getValue(K.pilotWait + p.id, null))
      .filter((w) => w && w.status !== "done");
    if (!waits.length) return false;
    const wait = waits.find(pilotOnPage) || null;
    if (!wait) return false; // пилот ждёт своей страницы; командный ход не блокируем
    const pilot = getPilot(wait.id);

    if (Date.now() - Number(wait.at || 0) > PILOT_TIMEOUT_MS) {
      GM_setValue(K.pilotWait + wait.id, { ...wait, status: "timeout" });
      pause(`Пилот ${pilot?.variant || ""} не завершился за 4 часа. Сырой транскрипт сохранён; нужен Мастер.`, { kind: "pilot-timeout", ref: wait.id });
      return true;
    }

    // Ещё не отправляли: вставляем бриф и отправляем (page-scoped механика).
    if (!wait.sentAt) {
      const busy = await busySettled();
      if (busy) return true;
      const { editor } = await ensureComposer();
      if (!editor) return true;
      if (composerText(editor)) clearComposer(editor);
      if (!writePrompt(editor, wait.text)) return true;
      const watermark = lastMessageId();
      const seen = messages().map(nodeId).slice(-40);
      const delivery = await deliver(editor, wait.text);
      if (delivery.captcha) { captchaPause(); return true; }
      if (!delivery.ok) { log(`Пилот: отправка не прошла (${delivery.reason}).`, true); return true; }
      GM_setValue(K.pilotWait + wait.id, { ...wait, sentAt: Date.now(), watermark: delivery.msgId || watermark, seen, status: "running" });
      savePilots(listPilots().map((p) => (p.id === wait.id ? { ...p, status: "running" } : p)));
      log(`Пилот ${pilot?.variant || ""}: бриф отправлен, жду финальный отчёт (маркер не требуется).`);
      return true;
    }

    // Отправлено: читаем транскрипт после водяного знака.
    const replies = messagesAfter(wait.watermark || "");
    const last = replies.at(-1);
    if (!last) return true;
    if (!last.ended) return true; // ещё пишет
    const busy = await busySettled();
    if (busy) return true;
    const transcript = replies.map((m) => m.text).join("\n\n");
    // Сохраняем сырой транскрипт (без интерпретации маркеров).
    GM_setValue(K.pilotTranscript + wait.id, { at: nowIso(), text: transcript, parts: replies.length });
    const questions = replies.filter((m) => /\?\s*$/.test(String(m.text || "").trim()) || /вопрос к мастеру/i.test(m.text || ""));
    if (questions.length) {
      log(`Пилот ${pilot?.variant || ""} задал вопрос Мастеру: «${tail(questions.at(-1).text, 140)}».`, true, { ntfy: "quiet", title: "Relay: вопрос пилота" });
    }
    // Финальный отчёт: idle + содержательный текст без служебных маркеров команды.
    const hasReport = transcript.replace(/\s+/g, " ").trim().length > 200;
    if (hasReport && !busy) {
      GM_setValue(K.pilotWait + wait.id, { ...wait, status: "done", doneAt: Date.now() });
      savePilots(listPilots().map((p) => (p.id === wait.id ? { ...p, status: "done", doneAt: nowIso() } : p)));
      log(`Пилот ${pilot?.variant || ""} завершён по фактам: финальный отчёт получен (${transcript.length} символов). Сырой транскрипт сохранён.`, true, { ntfy: "quiet", title: "Relay: пилот завершён" });
      return true;
    }
    return true;
  }
