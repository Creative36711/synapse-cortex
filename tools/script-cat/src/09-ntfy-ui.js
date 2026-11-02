  // ───────────────────────────── ntfy-настройка ─────────────────────────────
  function ntfyDialog() {
    document.getElementById("cfn-ntfy-dialog")?.remove();
    const box = document.createElement("div");
    box.id = "cfn-ntfy-dialog";
    box.style.cssText = [
      "position:fixed", "right:14px", "bottom:150px", "z-index:2147483001", "width:380px",
      "max-height:70vh", "overflow:auto",
      "background:#15171c", "color:#e7eaee", "border:1px solid #2b2f38", "border-radius:10px",
      "padding:10px", "font:12px/1.5 ui-monospace,Menlo,Consolas,monospace",
      "box-shadow:0 10px 30px rgba(0,0,0,.45)",
    ].join(";");
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
        <strong>ntfy</strong>
        <span style="opacity:.5;font-size:10px">v${SCRIPT_VERSION}</span>
        <span style="flex:1"></span>
        <button id="cfn-ntfy-close" title="Закрыть" style="${btnStyle()}">✕</button>
      </div>
      <div style="opacity:.7;margin-bottom:8px">Топик на ntfy.sh; пусто — уведомления выключены.<br>
      Тихие (priority 2): задание отправлено, ответ записан, пауза снята.<br>
      Громкие (priority 5): только когда цикл остановлен. Громкий тест — тоже только на паузе или при выключенном цикле.</div>
      <label style="display:block;margin-bottom:6px">Топик или ссылка<br>
        <input id="cfn-ntfy-topic" placeholder="arena-creative36711" style="${inputStyle()}"></label>
      <label style="display:block;margin-bottom:6px">Access token (необязательно)<br>
        <input id="cfn-ntfy-token" type="password" placeholder="tk_…" style="${inputStyle()}"></label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="cfn-ntfy-save" style="${btnStyle()}">Сохранить</button>
        <button id="cfn-ntfy-quiet" style="${btnStyle()}">Тихий тест</button>
        <button id="cfn-ntfy-loud" style="${btnStyle()}">Громкий тест</button>
        <button id="cfn-ntfy-health" style="${btnStyle()}">Проверка связи</button>
        <button id="cfn-ntfy-open" style="${btnStyle()}">Открыть топик</button>
        <button id="cfn-ntfy-off" style="${btnStyle()}">Выключить</button>
      </div>
      <div id="cfn-ntfy-note" style="margin-top:8px;min-height:32px;white-space:pre-wrap;opacity:.9;font-size:11px;line-height:1.45"></div>`;
    document.body.appendChild(box);

    const topic = box.querySelector("#cfn-ntfy-topic");
    const token = box.querySelector("#cfn-ntfy-token");
    const note = box.querySelector("#cfn-ntfy-note");
    topic.value = String(GM_getValue(K.ntfyTopic, "") || "");
    token.value = String(GM_getValue(K.ntfyToken, "") || "");

    const say = (text, error = false) => {
      note.textContent = text;
      note.style.color = error ? "#ff9a9a" : "#bfe6c4";
    };

    /** Топик нормализуется: ссылка и «ntfy.sh/имя» тоже принимаются. */
    const persist = () => {
      const raw = topic.value.trim();
      const name = normalizeNtfyTopic(raw);
      if (!name) {
        throw new Error(
          `Топик «${raw || "пусто"}» не подходит: нужно 1–64 символа A–Z, a–z, 0–9, дефис или подчёркивание.`,
        );
      }
      GM_setValue(K.ntfyTopic, name);
      GM_setValue(K.ntfyToken, token.value.trim());
      topic.value = name;
      return name;
    };

    const test = async (priority, tags, title, label) => {
      if (Number(priority) >= 4 && !isPaused() && autoOn()) {
        say("Громкий тест доступен только на паузе или при выключенном автоцикле.", true);
        return;
      }
      say(`Отправляю в https://ntfy.sh/${normalizeNtfyTopic(topic.value) || "…"} …`);
      // Сторож: если менеджер скриптов не ответил ни успехом, ни ошибкой,
      // молчания быть не должно — через 25 с диалог сам скажет о зависании.
      const watchdog = setTimeout(() => {
        say(
          `Нет ответа за 25 с. Нажмите «Проверка связи»: если и она молчит — ` +
            `запрос блокирует менеджер скриптов (проверьте @connect ntfy.sh), а не ntfy.`,
          true,
        );
      }, 25000);
      try {
        const name = persist();
        const result = await ntfyPublish(name, token.value.trim(), {
          message: `Relay: ${label} (priority ${priority}).`,
          title,
          priority,
          tags,
        });
        say(
          `Отправлено: ${result.via === "gm" ? "ScriptCat" : "fetch"}, HTTP ${result.status}.\n` +
            `Подписка должна быть на «${name}». Если пуша нет — нажмите «Открыть топик»: сообщение, видимое на странице ntfy.sh, до сервера дошло, значит дело в подписке телефона.`,
        );
        log(`ntfy: ${label} отправлен (${result.via}, HTTP ${result.status}).`, false, { skip: true });
      } catch (e) {
        say(`Не ушло: ${e.message}`, true);
        log(`ntfy: ${label} не отправлен — ${e.message}`, true, { skip: true });
      } finally {
        clearTimeout(watchdog);
      }
    };

    box.querySelector("#cfn-ntfy-save").onclick = () => {
      try {
        const name = persist();
        say(`Сохранено: «${name}». Проверьте тестами.`);
        log(`ntfy: топик «${name}» сохранён.`, false, { skip: true });
      } catch (e) {
        say(e.message, true);
      }
    };
    box.querySelector("#cfn-ntfy-quiet").onclick = () =>
      test(2, "memo", "Relay: тихий тест", "тихий тест");
    box.querySelector("#cfn-ntfy-loud").onclick = () =>
      test(5, "warning,rotating_light", "Relay: громкий тест", "громкий тест");
    box.querySelector("#cfn-ntfy-health").onclick = async () => {
      say("Проверяю связь с ntfy.sh…");
      const lines = await ntfyHealth();
      say(`Проверка связи:\n${lines.join("\n")}`);
    };
    box.querySelector("#cfn-ntfy-open").onclick = () => {
      const name = normalizeNtfyTopic(topic.value);
      if (!name) {
        say("Сначала введите корректный топик.", true);
        return;
      }
      window.open(`https://ntfy.sh/${encodeURIComponent(name)}`, "_blank", "noopener");
    };
    box.querySelector("#cfn-ntfy-off").onclick = () => {
      GM_setValue(K.ntfyTopic, "");
      GM_setValue(K.ntfyToken, "");
      topic.value = "";
      token.value = "";
      say("ntfy выключен: пуши больше не отправляются.");
    };
    box.querySelector("#cfn-ntfy-close").onclick = () => box.remove();
  }

  function inputStyle() {
    return "width:100%;box-sizing:border-box;background:#0f1115;color:#e7eaee;border:1px solid #343a46;border-radius:6px;padding:4px 6px;font:12px ui-monospace,Menlo,Consolas,monospace";
  }
