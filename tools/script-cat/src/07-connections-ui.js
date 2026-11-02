  // ───────────────────────────── подключения ─────────────────────────────
  /** Старые ключи остаются источником истины: обновление не сбрасывает доступ. */
  function connectionSettings() {
    return {
      notion: String(GM_getValue(K.notion, "") || "").trim(),
      gwUrl: String(GM_getValue(K.gwUrl, "") || "").trim(),
      gwKey: String(GM_getValue(K.gwKey, "") || "").trim(),
      github: String(GM_getValue(K.ghToken, "") || "").trim(),
    };
  }

  const sameConnections = (a, b) =>
    a.notion === b.notion && a.gwUrl === b.gwUrl && a.gwKey === b.gwKey && a.github === b.github;

  /** Не отправлять ключ по HTTP или на похожий на Google чужой адрес без согласия. */
  function connectionEndpoint(value) {
    if (!value) return { ok: true, standard: true, host: "" };
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password)
        return { ok: false, message: "Укажите HTTPS-адрес шлюза без имени пользователя и пароля в URL." };
      return {
        ok: true,
        standard: url.origin === "https://script.google.com" && /^\/macros\/s\/[^/]+\/exec\/?$/.test(url.pathname),
        host: url.host,
      };
    } catch {
      return { ok: false, message: "Некорректный URL шлюза: нужен полный HTTPS-адрес веб-приложения /exec." };
    }
  }

  /** Чужой ответ об ошибке не должен показать введённый или сохранённый секрет. */
  function connectionProblem(error, settings) {
    let text = String((error && error.message) || error || "неизвестная ошибка");
    for (const secret of [settings.notion, settings.gwKey, settings.github]) {
      if (secret) text = text.split(secret).join("[скрыто]");
    }
    return text.replace(/\s+/g, " ").slice(0, 280);
  }

  /** Проверка токена и доступа к источникам — только чтение, не проверка записи или всей схемы. */
  async function probeNotionConnection(settings) {
    if (!settings.notion) return { ok: false, text: "Не задан токен Notion." };
    const headers = {
      Authorization: `Bearer ${settings.notion}`,
      "Notion-Version": C.notionV,
      "Content-Type": "application/json",
    };
    try {
      const me = await request("GET", "https://api.notion.com/v1/users/me", headers);
      if (!me || me.object !== "user") throw new Error("Неожиданный ответ users/me.");
    } catch (e) {
      return { ok: false, text: `Токен Notion не проверен: ${connectionProblem(e, settings)}` };
    }
    for (const [name, id] of [["Роли", C.roles], ["Миссии", C.missions], ["Запросы", C.requests], ["Обратная связь", C.questions]]) {
      // Средняя частота Notion — около трёх запросов/с; это проверка по кнопке,
      // а не часть тика, поэтому не трогаем сторож busyAt через sleep().
      await new Promise((resolve) => setTimeout(resolve, 400));
      try {
        const source = await request("GET", `https://api.notion.com/v1/data_sources/${id}`, headers);
        if (!source || source.object !== "data_source") throw new Error("Неожиданный ответ источника.");
      } catch (e) {
        return {
          ok: false,
          text: `Токен принят, но источник «${name}» не прочитан: ${connectionProblem(e, settings)}. Проверьте доступ интеграции.`,
        };
      }
    }
    return { ok: true, text: "Токен и четыре источника читаются. Права записи, варианты и полная схема не проверялись." };
  }

  /** Проверяет тот же транспорт, что и цикл, но с введёнными, ещё не сохранёнными данными. */
  async function probeDriveConnection(settings) {
    if (!settings.gwUrl) return { ok: false, text: "Не задан URL шлюза Drive." };
    if (!settings.gwKey) return { ok: false, text: "Не задан ключ шлюза Drive." };
    try {
      const scoped = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy;
      const data = await gatewayWithCredentials("ping", "", scoped ? { projectId: ACTIVE_PROFILE.id } : {}, { url: settings.gwUrl, key: settings.gwKey });
      if (scoped && (!data || data.projectScoped !== true || data.projectId !== ACTIVE_PROFILE.id ||
          data.project?.name !== ACTIVE_PROFILE.driveFolder))
        throw new Error("Шлюз не подтвердил ID и папку этого проекта. Нужен зарегистрированный проектный шлюз 1.6.");
      const version = String((data && data.version) || "");
      const warning = !version
        ? " Версия не указана — совместимость не подтверждена."
        : gatewayIsOld(version)
          ? " Версия старше 1.5: обновите шлюз, старый может писать мимо Arena."
          : "";
      return { ok: true, warning: Boolean(warning), text: `Шлюз ответил${version ? `, версия ${version}` : ""}.${warning} Чтение и запись файлов не проверялись.` };
    } catch (e) {
      return { ok: false, text: `Шлюз Drive не проверен: ${connectionProblem(e, settings)}` };
    }
  }

  /** Репозиторий виден — не значит, что токену доступны содержимое и Pull requests. */
  async function probeGithubConnection(settings) {
    try {
      const repo = await request("GET", `https://api.github.com/repos/${C.repo}`, githubHeaders(settings.github));
      if (!repo || String(repo.full_name || "").toLowerCase() !== C.repo.toLowerCase())
        throw new Error("GitHub вернул неожиданный репозиторий.");
      return {
        ok: true,
        text: `Репозиторий ${C.repo} виден ${settings.github ? "с токеном" : "анонимно"}. Права на PR и файлы не проверялись.`,
      };
    } catch (e) {
      return { ok: false, text: `Репозиторий не проверен: ${connectionProblem(e, settings)}. Для приватного репозитория нужен токен с доступом к нему.` };
    }
  }

  /** Единая точка входа, в том числе старый адрес ?cf-auth-setup=1. */
  async function setup(force = false) {
    const url = new URL(location.href);
    const fromParam = url.searchParams.has("cf-auth-setup");
    if (!force && !fromParam) return;
    if (fromParam) {
      url.searchParams.delete("cf-auth-setup");
      history.replaceState(null, "", url.toString());
    }
    connectionDialog();
  }

  /**
   * Секреты не вставляем из хранилища в DOM. Пустое поле означает «не менять»;
   * удаление — только явным флажком. Проверка использует черновик и не сохраняет его.
   */
  function connectionDialog({ focusGithub = false } = {}) {
    const opened = document.getElementById("cfn-connections");
    if (opened) {
      if (focusGithub) {
        const note = opened.querySelector("#cfn-connections-note");
        note.textContent = "GitHub запросил доступ: проверьте токен и доступ к репозиторию.";
        opened.querySelector("#cfn-connection-github")?.focus();
      }
      return;
    }
    let saved = connectionSettings();
    let checking = false;
    let performing = false;
    const box = document.createElement("div");
    box.id = "cfn-connections";
    box.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483200", "background:rgba(5,7,12,.72)",
      "display:flex", "align-items:center", "justify-content:center", "padding:14px", "box-sizing:border-box",
      "color:#e7eaee", "font:13px/1.5 system-ui,-apple-system,sans-serif", "color-scheme:dark",
    ].join(";");
    const field = `${inputStyle()};padding:9px 10px;margin-top:5px;font:13px/1.35 ui-monospace,Menlo,Consolas,monospace`;
    const card = "border:1px solid #343b48;border-radius:10px;padding:14px;background:#1c2029";
    const action = `${btnStyle()};font:12px/1.35 system-ui,sans-serif;padding:7px 10px`;
    const quiet = "font-size:12px;color:#aab4c3;line-height:1.5";
    box.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="cfn-connections-title" tabindex="-1"
        style="width:min(680px,100%);max-height:calc(100vh - 28px);overflow:auto;background:#151922;border:1px solid #434c5c;border-radius:14px;box-shadow:0 18px 65px rgba(0,0,0,.55)">
        <header style="position:sticky;top:0;z-index:2;display:flex;align-items:flex-start;gap:14px;padding:16px 20px 12px;background:#151922;border-bottom:1px solid #343b48">
          <div style="flex:1"><div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#93a5bf">ScriptCat · Relay</div>
            <h2 id="cfn-connections-title" style="font-size:20px;line-height:1.2;margin:5px 0 6px;color:#f6f8fb">Подключения</h2>
            <div style="${quiet}">Notion, Google Drive и GitHub — в одном месте. Сохранённые секреты не показываются.</div></div>
          <button id="cfn-connections-close" type="button" aria-label="Закрыть" style="${action}">✕</button>
        </header>
        <div style="display:grid;gap:10px;padding:0 20px 18px">
          <div style="${quiet}">Текущий проект: <b id="cfn-connection-project-name"></b>. У каждого проекта свои источники, состояние и доступы. Пока окно открыто, новые шаги в этой вкладке не начинаются; начатый шаг и фоновые сторожа могут продолжаться. Используйте одну вкладку.</div>
          <div style="${quiet}">Маскировка скрывает секреты на экране, но введённые значения доступны коду страницы и расширениям. Пользуйтесь только доверенной страницей Arena.</div>
          <button id="cfn-connection-projects" type="button" style="${action};justify-self:start">Управление проектами</button>
          <button id="cfn-connection-stop-auto" type="button" style="${action};justify-self:start">Остановить автоцикл этой вкладки</button>
          <section style="${card}" aria-labelledby="cfn-connection-notion-title">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><strong id="cfn-connection-notion-title" style="font-size:15px;color:#fff">Notion</strong><span style="${quiet}">базы и очередь</span></div>
            <div id="cfn-connection-notion-status" role="status" style="${quiet};margin:4px 0 8px"></div>
            <label for="cfn-connection-notion" style="font-weight:600">Токен интеграции</label>
            <input id="cfn-connection-notion" type="password" autocomplete="off" spellcheck="false" style="${field}">
            <label style="display:block;margin-top:7px;${quiet}"><input id="cfn-connection-notion-remove" type="checkbox"> Удалить сохранённый токен при сохранении</label>
          </section>
          <section style="${card}" aria-labelledby="cfn-connection-drive-title">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><strong id="cfn-connection-drive-title" style="font-size:15px;color:#fff">Google Drive</strong><span style="${quiet}">шлюз Apps Script для файлов</span></div>
            <div id="cfn-connection-drive-status" role="status" style="${quiet};margin:4px 0 8px"></div>
            <label for="cfn-connection-url" style="font-weight:600">URL веб-приложения /exec</label>
            <input id="cfn-connection-url" type="url" autocomplete="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" style="${field}">
            <label for="cfn-connection-key" style="display:block;margin-top:9px;font-weight:600">Ключ шлюза</label>
            <input id="cfn-connection-key" type="password" autocomplete="off" spellcheck="false" style="${field}">
            <label style="display:block;margin-top:7px;${quiet}"><input id="cfn-connection-drive-remove" type="checkbox"> Удалить URL и ключ при сохранении</label>
            <label id="cfn-connection-trust-wrap" style="display:none;margin-top:7px;color:#ffd479;font-size:12px"><input id="cfn-connection-trust" type="checkbox"> Я доверяю указанному шлюзу: ему будет отправлен ключ, в том числе ранее сохранённый.</label>
            <div style="${quiet};margin-top:8px">Ключ получает владелец указанного веб-приложения, даже на script.google.com. В старом Relay проверка ping может создать Arena/logs и Arena/payloads или перенести старую папку логов; новому проекту нужен заранее зарегистрированный шлюз.</div>
          </section>
          <section style="${card}" aria-labelledby="cfn-connection-github-title">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><strong id="cfn-connection-github-title" style="font-size:15px;color:#fff">GitHub</strong><span style="${quiet}">проверка PR и ADR</span></div>
            <div id="cfn-connection-github-status" role="status" style="${quiet};margin:4px 0 8px"></div>
            <div style="${quiet};margin-bottom:8px">Репозиторий: <strong id="cfn-connection-repo" style="color:#e7eaee"></strong>. Для приватного репозитория — токен с чтением Pull requests и Contents.</div>
            <label for="cfn-connection-github" style="font-weight:600">Токен GitHub <span style="font-weight:400;${quiet}">(для публичного репозитория необязателен)</span></label>
            <input id="cfn-connection-github" type="password" autocomplete="off" spellcheck="false" style="${field}">
            <label style="display:block;margin-top:7px;${quiet}"><input id="cfn-connection-github-remove" type="checkbox"> Удалить сохранённый токен при сохранении</label>
            <button id="cfn-connection-github-open" type="button" style="${action};margin-top:7px">Открыть настройки токенов GitHub ↗</button>
          </section>
          <details style="${card}"><summary style="cursor:pointer;font-weight:600">Восстановление и уведомления</summary>
            <div style="${quiet};margin:8px 0">Восстановление использует сохранённые настройки и может изменить карточку Notion и журнал Drive. Применяйте на остановленном цикле.</div>
            <div style="display:flex;gap:7px;flex-wrap:wrap">
              <button id="cfn-connection-recover" type="button" style="${action}">Вернуть карточку</button>
              <button id="cfn-connection-adopt" type="button" style="${action}">Взять ответ из чата</button>
              <button id="cfn-connection-ntfy" type="button" style="${action}">🔔 Настроить уведомления</button>
            </div>
          </details>
          <div style="${quiet}">Пустые поля секретов сохраняют прежние значения. «Проверить всё» проверяет введённое, но не сохраняет; «Сохранить» работает отдельно и не запускает цикл.</div>
        </div>
        <footer style="position:sticky;bottom:0;background:#151922;border-top:1px solid #343b48;padding:10px 20px 14px;z-index:1">
          <div id="cfn-connections-note" role="status" aria-live="polite" style="min-height:20px;font-size:12px;color:#bfe6c4;white-space:pre-wrap"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button id="cfn-connections-check" type="button" style="${action};background:#2b4b6f;border-color:#4c77a6;font-weight:600">Проверить всё</button>
            <button id="cfn-connections-save" type="button" style="${action};background:#285638;border-color:#438a5b;font-weight:600">Сохранить</button>
          </div>
        </footer>
      </div>`;
    document.body.appendChild(box);
    const find = (id) => box.querySelector(`#cfn-connection-${id}`);
    const notionInput = find("notion"), urlInput = find("url"), keyInput = find("key"), githubInput = find("github");
    const notionRemove = find("notion-remove"), driveRemove = find("drive-remove"), githubRemove = find("github-remove");
    const trust = find("trust"), trustWrap = find("trust-wrap");
    const checkButton = box.querySelector("#cfn-connections-check"), saveButton = box.querySelector("#cfn-connections-save");
    const note = box.querySelector("#cfn-connections-note");
    find("repo").textContent = C.repo;
    find("project-name").textContent = C.projectName || "Relay";
    urlInput.value = saved.gwUrl;

    const say = (text, error = false) => {
      note.textContent = text;
      note.style.color = error ? "#ffb4ad" : "#bfe6c4";
    };
    const status = (name, text, kind = "idle") => {
      const el = find(`${name}-status`);
      el.textContent = text;
      el.style.color = kind === "ok" ? "#a6e3b5" : kind === "warn" ? "#ffd479" : kind === "error" ? "#ffb4ad" : "#aab4c3";
    };
    const placeholders = () => {
      notionInput.placeholder = saved.notion ? "Сохранён · введите новый, чтобы заменить" : "Введите токен интеграции";
      keyInput.placeholder = saved.gwKey ? "Сохранён · введите новый, чтобы заменить" : "Введите ключ шлюза";
      githubInput.placeholder = saved.github ? "Сохранён · введите новый, чтобы заменить" : "Токен или пусто для публичного репозитория";
    };
    const read = () => ({
      notion: notionRemove.checked ? "" : notionInput.value.trim() || saved.notion,
      gwUrl: driveRemove.checked ? "" : urlInput.value.trim(),
      gwKey: driveRemove.checked ? "" : keyInput.value.trim() || saved.gwKey,
      github: githubRemove.checked ? "" : githubInput.value.trim() || saved.github,
    });
    const needsTrust = (settings, endpoint = connectionEndpoint(settings.gwUrl)) =>
      endpoint.ok && Boolean(settings.gwUrl) && (!endpoint.standard ||
        (settings.gwUrl !== saved.gwUrl && Boolean(settings.gwKey) && settings.gwKey === saved.gwKey));
    const refreshForm = () => {
      const settings = read();
      const endpoint = connectionEndpoint(settings.gwUrl);
      const locked = checking || performing;
      trustWrap.style.display = needsTrust(settings, endpoint) ? "block" : "none";
      notionInput.disabled = locked || notionRemove.checked;
      urlInput.disabled = locked || driveRemove.checked;
      keyInput.disabled = locked || driveRemove.checked;
      githubInput.disabled = locked || githubRemove.checked;
      for (const element of [notionRemove, driveRemove, githubRemove, trust, checkButton, saveButton,
        find("recover"), find("adopt"), find("ntfy")]) element.disabled = locked;
      const stopAuto = find("stop-auto");
      const auto = autoOn();
      stopAuto.disabled = locked || !auto;
      stopAuto.textContent = auto ? "Остановить автоцикл этой вкладки" : "Автоцикл этой вкладки выключен";
      stopAuto.style.opacity = stopAuto.disabled ? ".6" : "1";
      stopAuto.style.cursor = stopAuto.disabled ? "default" : "pointer";
    };
    const resetStatuses = () => {
      status("notion", saved.notion ? "Сохранён · ещё не проверен" : "Не настроен");
      const endpoint = connectionEndpoint(saved.gwUrl);
      status("drive", !endpoint.ok ? "Сохранён небезопасный или неверный URL. Замените его на HTTPS." :
        saved.gwUrl && saved.gwKey ? "Сохранён · ещё не проверен" : "Не настроен полностью", endpoint.ok ? "idle" : "error");
      status("github", saved.github ? "Сохранён · ещё не проверен" : "Без токена · доступ не проверен");
    };
    const changed = () => !sameConnections(read(), saved);
    const close = () => {
      if (performing) { say("Восстановление ещё выполняется: дождитесь результата.", true); return false; }
      const messages = [];
      if (checking) messages.push("Проверка не отменится и может завершиться после закрытия.");
      if (changed()) messages.push("Несохранённые изменения будут потеряны.");
      if (messages.length && !confirm(`${messages.join("\n")}\n\nЗакрыть окно?`)) return false;
      box.remove();
      document.getElementById(ui.setup)?.focus();
      return true;
    };
    box.querySelector("#cfn-connections-close").onclick = close;
    box.onkeydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...box.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.disabled && element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); box.querySelector('[role="dialog"]')?.focus(); return; }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !focusable.includes(active))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (active === last || !focusable.includes(active))) {
        event.preventDefault(); first.focus();
      }
    };
    for (const element of [notionInput, urlInput, keyInput, githubInput, notionRemove, driveRemove, githubRemove, trust]) {
      const invalidate = (event) => {
        // Подтверждение привязано к адресу и ключу, а не к следующему вводу.
        if (event.target === urlInput || event.target === keyInput || event.target === driveRemove) trust.checked = false;
        resetStatuses();
        refreshForm();
        say("Настройки изменены в окне; проверка и сохранение выполняются отдельно.");
      };
      element.addEventListener("input", invalidate);
      element.addEventListener("change", invalidate);
    }

    checkButton.onclick = async () => {
      if (checking || performing) return;
      const settings = read();
      const endpoint = connectionEndpoint(settings.gwUrl);
      const driveAllowed = endpoint.ok && (!needsTrust(settings, endpoint) || trust.checked);
      checking = true;
      refreshForm();
      status("notion", "Проверяю токен и источники…");
      status("github", "Проверяю доступ к репозиторию…");
      status("drive", driveAllowed ? "Проверяю шлюз…" : endpoint.ok ? "Подтвердите доверие к указанному шлюзу." : endpoint.message, driveAllowed ? "idle" : "error");
      say("Проверяю введённые данные. Они ещё не сохранены; Drive ping может создать или перенести папки.");
      const watchdog = setTimeout(() => {
        say("Один из сервисов не ответил за 25 секунд. Можно закрыть окно; начатая проверка может ещё завершиться, настройки не сохраняются.", true);
      }, 25000);
      const show = async (name, probe) => {
        try {
          const result = await probe(settings);
          status(name, connectionProblem(result.text, settings), result.ok ? result.warning ? "warn" : "ok" : "error");
        } catch (e) {
          status(name, `Не удалось проверить: ${connectionProblem(e, settings)}`, "error");
        }
      };
      try {
        await Promise.all([
          show("notion", probeNotionConnection),
          ...(driveAllowed ? [show("drive", probeDriveConnection)] : []),
          show("github", probeGithubConnection),
        ]);
        say("Проверка завершена. Результаты выше относятся к текущим полям и ещё не сохраняют их.");
      } finally {
        clearTimeout(watchdog);
        checking = false;
        refreshForm();
      }
    };

    saveButton.onclick = () => {
      if (checking || performing) return;
      if (busy || (typeof projectAsyncWork === "number" && projectAsyncWork > 0) || (autoOn() && !isPaused())) {
        say("Остановите цикл или поставьте его на паузу и дождитесь завершения текущих шагов и фоновых операций перед сохранением.", true);
        return;
      }
      if (!sameConnections(connectionSettings(), saved)) {
        say("Настройки изменились в другой вкладке. Закройте это окно и откройте заново, чтобы не затереть их.", true);
        return;
      }
      const next = read();
      const endpoint = connectionEndpoint(next.gwUrl);
      const driveChanged = next.gwUrl !== saved.gwUrl || next.gwKey !== saved.gwKey;
      // Старый HTTP-адрес не отправляем на проверку и не разрешаем менять ключ
      // к нему. Но не блокируем правку другого подключения: ранее сохранённый
      // адрес остаётся неизменным и показан как небезопасный до его замены.
      if (!endpoint.ok && driveChanged) { say(endpoint.message, true); return; }
      if (driveChanged && needsTrust(next, endpoint) && !trust.checked) {
        say("Подтвердите доверие к указанному шлюзу: при работе ему будет отправлен ключ.", true);
        return;
      }
      const liveHandoff = GM_getValue(K.pending, null) || GM_getValue(K.expect, null);
      if (liveHandoff && (driveChanged || next.notion !== saved.notion) &&
          !confirm("Есть сохранённая очередь или ожидание. Новые доступы и шлюз должны видеть прежние карточки и файлы, иначе восстановление хода может не получиться. Сохранить изменения?")) {
        say("Подключения не изменены; очередь и ожидание сохранены.");
        return;
      }
      const updates = [
        [K.notion, saved.notion, next.notion], [K.gwUrl, saved.gwUrl, next.gwUrl],
        [K.gwKey, saved.gwKey, next.gwKey], [K.ghToken, saved.github, next.github],
      ].filter(([, before, after]) => before !== after);
      if (!updates.length) { say("Изменений для сохранения нет."); return; }
      // Допуск привязан к проверенным данным. Меняем доступ — сначала снимаем
      // допуск нового проекта, включая фоновые сторожа, и проверяем его заново.
      if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy)
        updates.unshift(["cfn-project-approved", GM_getValue("cfn-project-approved", false), false]);
      if (next.notion !== saved.notion) updates.push([K.rolesCache, GM_getValue(K.rolesCache, null), null]);
      if (next.github !== saved.github) updates.push([K.ghAsk, GM_getValue(K.ghAsk, 0), 0]);
      const attempted = [];
      try {
        for (const [key, before, after] of updates) {
          attempted.push([key, before]);
          GM_setValue(key, after);
        }
      } catch {
        let restored = true;
        for (const [key, before] of attempted.reverse()) {
          try { GM_setValue(key, before); } catch { restored = false; }
        }
        if (!restored && typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
          try { GM_setValue("cfn-project-approved", false); } catch { /* проверить вручную */ }
        }
        say(restored ? "Не удалось сохранить; прежние значения восстановлены." : "Не удалось полностью сохранить или восстановить настройки. Проверьте их перед запуском.", true);
        return;
      }
      saved = next;
      notionInput.value = ""; keyInput.value = ""; githubInput.value = ""; urlInput.value = saved.gwUrl;
      notionRemove.checked = false; driveRemove.checked = false; githubRemove.checked = false; trust.checked = false;
      placeholders(); resetStatuses(); refreshForm();
      const needsApproval = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy;
      say(endpoint.ok ? (needsApproval
        ? "Сохранено. Допуск проекта снят: откройте «Управление проектами» и проверьте подключения и схему заново."
        : "Сохранено. Для подтверждения доступа запустите проверку; цикл не запускался.") :
        "Сохранено. Старый URL шлюза остался небезопасным: замените его перед запуском цикла.", !endpoint.ok);
      log("Подключения сохранены; секреты в журнал не записываются.", false, { skip: true });
    };

    find("projects").onclick = () => {
      if (checking || performing) { say("Дождитесь окончания проверки или восстановления.", true); return; }
      if (changed()) { say("Сначала сохраните или отмените изменения подключений.", true); return; }
      if (close()) projectsDialog();
    };
    find("github-open").onclick = () => window.open("https://github.com/settings/tokens", "_blank", "noopener");
    find("stop-auto").onclick = () => {
      if (!autoOn()) return;
      autoSet(false);
      setStatus();
      log("Автоцикл этой вкладки выключен из окна подключений; очередь и ожидание не сняты.", false, { skip: true });
      say("Автоцикл этой вкладки выключен. Дождитесь окончания начатого шага; очередь и ожидание сохранены.");
      refreshForm();
    };
    const recover = async (operation, label) => {
      if (checking || performing) return;
      if (changed()) { say("Сначала сохраните или отмените изменения: восстановление использует сохранённые настройки.", true); return; }
      if (busy || (autoOn() && !isPaused())) { say("Остановите цикл и дождитесь окончания шага перед восстановлением.", true); return; }
      performing = true;
      refreshForm();
      say(`${label}…`);
      const watchdog = setTimeout(() => {
        say("Восстановление долго не завершается. Не запускайте его повторно: проверьте карточку и журнал; при необходимости перезагрузите вкладку.", true);
      }, 25000);
      try {
        const result = await operation();
        say(connectionProblem(result.text, saved), !result.ok);
      } catch (e) {
        say(`${label}: ${connectionProblem(e, saved)}`, true);
      } finally { clearTimeout(watchdog); performing = false; refreshForm(); }
    };
    find("recover").onclick = () => recover(recoverLastClaim, "Проверяю последнюю карточку");
    find("adopt").onclick = () => recover(adoptPageAnswer, "Читаю ответ из чата");
    find("ntfy").onclick = () => {
      if (changed()) { say("Сначала сохраните или отмените изменения подключений.", true); return; }
      if (close()) ntfyDialog();
    };
    placeholders(); resetStatuses(); refreshForm();
    if (focusGithub) {
      say("GitHub запросил доступ: проверьте токен и доступ к репозиторию.", true);
      githubInput.focus();
    } else {
      box.querySelector('[role="dialog"]')?.focus();
    }
  }
