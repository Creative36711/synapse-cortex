  // ───────────────────────────── управление проектами ─────────────────────────────
  // Смена адресов источников у уже работающего профиля не переносит очередь:
  // изменённая копия получает новый UUID и новое пространство состояния.
  let projectAsyncWork = 0;
  const PROJECT_HOLD_PREFIX = "cfn-project-switch-hold:";
  function projectHeld() {
    try { return sessionStorage.getItem(PROJECT_HOLD_PREFIX + ACTIVE_PROFILE.id) === "1"; }
    catch { return true; }
  }
  function releaseProjectHold() {
    try {
      const held = projectHeld();
      sessionStorage.removeItem(PROJECT_HOLD_PREFIX + ACTIVE_PROFILE.id);
      // Отложенный шаг старой сессии не должен запуститься второй раз при
      // следующей навигации: пользователь сейчас запускает этот шаг вручную.
      if (held) GM_setValue(K.step, false);
      return true;
    } catch { return false; }
  }
  function projectRoleAllowed(role) {
    if (ACTIVE_PROFILE.legacy) return true;
    try {
      const target = new URL(role.url, location.href);
      if (target.origin === location.origin && /^\/agent\/[\w-]+\/?$/.test(target.pathname)) return true;
    } catch { /* остановка ниже */ }
    pause("Адрес роли должен быть страницей агента Arena на том же домене, что и эта вкладка. " +
      "Иначе браузер потеряет выбранный профиль: поправьте Agent URL в базе «Роли».",
      { kind: "project-role-origin", ref: role.id || "" });
    return false;
  }
  function trackProjectTask(promise) {
    projectAsyncWork += 1;
    return Promise.resolve(promise).finally(() => { projectAsyncWork -= 1; });
  }

  /** Проверка схемы и ролей только чтением, до включения фоновых сторожей. */
  async function validateProjectSchema(settings) {
    const headers = { Authorization: `Bearer ${settings.notion}`, "Notion-Version": C.notionV, "Content-Type": "application/json" };
    const contracts = [
      ["Роли", C.roles, { "Роль": "title", "Функция": "select", "Статус": "select", "Agent URL": "url", "Зона записи": "rich_text", "Гейт": "rich_text", "Репозиторий": "rich_text" },
        { "Функция": ["Coordinator", "Executor", "Auditor", "Reviewer"], "Статус": ["Активна"] }],
      ["Миссии", C.missions, { "Миссия": "title", "Состояние": "select", "Создана": "date", "Завершена": "date", "Возвращена": "date", "Круг": "number", "Замечания": "rich_text", "Итог": "rich_text", "ТЗ URL": "url" },
        { "Состояние": ["Активна", "Возвращена", "Завершена", "Провалена"] }],
      ["Запросы", C.requests, { "Запрос": "title", "Миссия": "rich_text", "Mission ID": "rich_text", "Dependency": "rich_text", "Кому": "select", "Sequence": "number", "Dispatch State": "select", "Run ID": "rich_text", "Recipient Agent ID": "rich_text", "Started At": "date", "Submitted At": "date", "PR": "url", "Check": "select", "Output Drive File ID": "rich_text", "Payload Drive File ID": "rich_text", "Намерение": "rich_text", "Инварианты": "rich_text", "Acceptance": "rich_text", "Свободно": "rich_text", "Scope": "rich_text", "Ответ": "rich_text", "Branch": "rich_text", "Report SHA": "rich_text" },
        { "Dispatch State": ["Draft", "Ready", "Running", "Submitted", "Accepted", "Rework", "Blocked"], "Check": ["pass", "fail"] }],
      ["Обратная связь", C.questions, { "Вопрос": "title", "Статус": "select", "По умолчанию": "rich_text", "Ответ": "rich_text", "Варианты": "rich_text", "Срок": "date", "Доставлено": "date", "Материал": "url", "Роль": "rich_text", "Карточка": "rich_text", "Миссия": "rich_text", "Что блокирует": "rich_text" },
        { "Статус": ["Ждёт", "Решено", "Принят дефолт", "Отменён"] }],
    ];
    const schemas = {};
    try {
      for (const [label, id, fields, options] of contracts) {
        const source = await request("GET", `https://api.notion.com/v1/data_sources/${id}`, headers);
        if (!source || source.object !== "data_source" || !source.properties) throw new Error(`«${label}»: источник не вернул схему.`);
        const errors = [];
        for (const [name, type] of Object.entries(fields)) {
          if (source.properties[name]?.type !== type) errors.push(`${name}: нужен ${type}`);
        }
        // Repository — additive for existing databases; absent cards inherit
        // the freshly-read role repo. If present, it must be a text property.
        for (const name of ["Repository", "Репозиторий"]) {
          if (source.properties[name] && source.properties[name].type !== "rich_text") errors.push(`${name}: нужен rich_text`);
        }
        for (const [name, required] of Object.entries(options)) {
          const actual = source.properties[name]?.select?.options;
          if (!Array.isArray(actual)) errors.push(`${name}: нет списка select`);
          else for (const value of required) if (!actual.some((option) => option.name === value)) errors.push(`${name}: нет «${value}»`);
        }
        if (errors.length) throw new Error(`«${label}»: ${errors.join(", ")}.`);
        schemas[label] = source.properties;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      const rows = [], cursors = new Set();
      let cursor = "";
      while (true) {
        const page = await request("POST", `https://api.notion.com/v1/data_sources/${C.roles}/query`, headers,
          { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, { retry: false });
        if (!page || !Array.isArray(page.results) || typeof page.has_more !== "boolean") throw new Error("База «Роли» вернула неполный список.");
        rows.push(...page.results);
        if (rows.length > 1000) throw new Error("База «Роли» слишком велика для проверки.");
        if (!page.has_more) break;
        cursor = String(page.next_cursor || "");
        if (!cursor || cursors.has(cursor)) throw new Error("База «Роли» вернула неверный курсор.");
        cursors.add(cursor);
      }
      const active = rows.map(mapRoleRow).filter((role) => role.status === "Активна");
      if (active.filter((role) => role.fn === "Coordinator").length !== 1) throw new Error("Нужен ровно один активный Coordinator.");
      if (!active.some((role) => role.fn === "Reviewer")) throw new Error("Нужна активная роль Reviewer для приёмки и вопросов.");
      if (!active.some((role) => ["Executor", "Auditor"].includes(role.fn))) throw new Error("Нужен активный исполнитель или аудитор.");
      const roleIds = new Set();
      const recipientOptions = schemas["Запросы"]["Кому"].select.options || [];
      for (const role of active) {
        let url;
        try { url = new URL(role.url); } catch { throw new Error(`У роли «${role.name}» некорректный Agent URL.`); }
        if (url.origin !== location.origin || !/^\/agent\/[\w-]+\/?$/.test(url.pathname) || !role.id)
          throw new Error(`У роли «${role.name}» Agent URL должен быть страницей агента на домене этой вкладки.`);
        if (roleIds.has(role.id.toLowerCase())) throw new Error("Несколько активных ролей используют один Agent URL.");
        roleIds.add(role.id.toLowerCase());
        if (["Executor", "Auditor"].includes(role.fn) && !recipientOptions.some((option) => option.name === role.name))
          throw new Error(`В «Запросы → Кому» отсутствует вариант «${role.name}».`);
      }
      const branch = await request("GET", `https://api.github.com/repos/${C.repo}/branches/${encodeURIComponent(C.branch)}`, githubHeaders(settings.github));
      if (!branch || branch.name !== C.branch) throw new Error(`GitHub не подтвердил ветку ${C.branch}.`);
      return { ok: true, text: "Основные поля, варианты select, роли и базовая ветка читаются. Права записи и содержимое старых карточек не проверялись." };
    } catch (e) {
      return { ok: false, text: `Схема или роли не прошли проверку: ${connectionProblem(e, settings)}` };
    }
  }

  /** UUID базы из HTTPS-ссылки Notion; ID представления в query не используется. */
  function notionDatabaseId(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || url.username || url.password ||
          !["app.notion.com", "notion.so", "www.notion.so"].includes(url.hostname)) return "";
      const path = decodeURIComponent(url.pathname);
      const matches = path.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/ig) || [];
      const id = (matches.at(-1) || "").replace(/-/g, "").toLowerCase();
      return id.length === 32 ? `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}` : "";
    } catch { return ""; }
  }

  /** Read-only план миграции: никаких fuzzy-сопоставлений и молчаливых правок. */
  async function inspectMissionMigration() {
    const [missions, cards] = await Promise.all([query(C.missions), query(C.requests)]);
    const active = missions.filter((row) => ["Активна", "Возвращена"].includes(sel(row.properties?.["Состояние"])));
    const states = new Set(["Draft", "Ready", "Running", "Submitted", "Accepted", "Rework", "Blocked"]);
    const mapped = [], existing = [], conflicts = [];
    for (const row of cards) {
      const label = rt(row.properties?.["Миссия"]).trim();
      const current = cardMissionId(row);
      const title = taskTitle(row) || "без названия";
      const matches = label ? missions.filter((item) => rt(item.properties?.["Миссия"]).trim() === label ||
        (isUuid(label) && norm(item.id) === norm(label))) : [];
      if (!states.has(taskState(row))) { conflicts.push({ row, why: "пустое или неизвестное состояние" }); continue; }
      if (current) {
        const problem = cardBindingIssue(row, missions);
        if (problem) conflicts.push({ row, why: problem });
        else existing.push({ row, id: current });
        continue;
      }
      if (matches.length !== 1) {
        conflicts.push({ row, why: !label ? "пустое название миссии" :
          matches.length ? "несколько миссий с таким названием" : "нет точного совпадения названия или ID" });
        continue;
      }
      mapped.push({ row, mission: matches[0], id: matches[0].id, title, label });
    }
    if (active.length > 1) conflicts.push({ row: null, why: `активных или возвращённых миссий: ${active.length}` });
    if (cards.some((row) => taskState(row) === "Running"))
      conflicts.push({ row: null, why: "есть карточки Running: сначала завершите или разберите текущие ходы" });
    return { mapped, existing, conflicts, count: cards.length };
  }

  function formatMissionMigration(plan) {
    const lines = [`Карточек: ${plan.count}; уже привязано: ${plan.existing.length}; ` +
      `точных предложений: ${plan.mapped.length}; требуют ручной проверки: ${plan.conflicts.length}.`];
    for (const item of plan.mapped) lines.push(`ПРЕДЛОЖЕНИЕ ${item.row.id} · ${item.title} → ${item.id} · ${item.label}`);
    for (const item of plan.conflicts) lines.push(`ПРОВЕРИТЬ ${item.row?.id || "общая проверка"} · ${item.row ? taskTitle(item.row) : ""}: ${item.why}`);
    lines.push("Сверьте каждую строку с карточкой и миссией. Названия, состояния, ответы, Run ID и журналы не меняются.");
    return lines.join("\n");
  }

  async function applyMissionMigration(plan) {
    let written = 0;
    for (const item of plan.mapped) {
      // Не используем старый снимок, если карточку или миссию поправили после
      // предпросмотра. Notion не поддерживает атомарный compare-and-set.
      const [row, mission] = await Promise.all([
        notion("GET", `pages/${item.row.id}`), notion("GET", `pages/${item.id}`),
      ]);
      if (row.last_edited_time !== item.row.last_edited_time || mission.last_edited_time !== item.mission.last_edited_time ||
          cardMissionId(row) || rt(row.properties?.["Миссия"]).trim() !== item.label || taskState(row) === "Running" ||
          norm(mission.id) !== norm(item.id)) {
        throw new Error(`Изменение карточки или миссии ${item.row.id}; уже записано ${written}. Обновите предпросмотр.`);
      }
      await patch(item.row.id, { "Mission ID": { rich_text: richText(item.id) } });
      written += 1;
    }
    return written;
  }

  function projectsDialog() {
    if (document.getElementById("cfn-projects")) return;
    const box = document.createElement("div");
    box.id = "cfn-projects";
    box.style.cssText = "position:fixed;inset:0;z-index:2147483201;background:rgba(5,7,12,.76);display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;color:#e7eaee;font:13px/1.5 system-ui;color-scheme:dark";
    const field = `${inputStyle()};padding:8px;margin-top:4px;font:13px/1.35 ui-monospace,monospace`;
    const action = `${btnStyle()};font:12px/1.3 system-ui;padding:8px 10px`;
    box.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="cfn-projects-title" tabindex="-1" style="width:min(700px,100%);max-height:calc(100vh - 28px);overflow:auto;background:#151922;border:1px solid #434c5c;border-radius:14px;padding:18px">
        <div style="display:flex;gap:12px;align-items:start"><div style="flex:1"><h2 id="cfn-projects-title" style="margin:0 0 4px">Проекты</h2>
          <div style="color:#aab4c3">Текущий проект: <b id="cfn-project-current"></b>. Выбор закрепляется за этой вкладкой. Для одного проекта используйте только одну активную вкладку.</div></div>
          <button id="cfn-project-close" style="${action}" aria-label="Закрыть">✕</button></div>
        <label style="display:block;margin-top:14px">Сохранённые профили<select id="cfn-project-list" style="${field}"></select></label>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin:10px 0">
          <button id="cfn-project-switch" style="${action}">Открыть выбранный проект</button>
          <button id="cfn-project-new" style="${action}">Новый профиль</button>
          <button id="cfn-project-copy" style="${action}">Создать на основе выбранного</button>
          <button id="cfn-project-edit" style="${action}">Исправить текущий до первого допуска</button>
        </div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin:8px 0">
          <button id="cfn-project-export-config" type="button" style="${action}">Экспортировать конфигурацию</button>
          <button id="cfn-project-import-config" type="button" style="${action}">Импортировать проект из файла</button>
          <input id="cfn-project-import-file" type="file" accept="application/json,.json" style="display:none">
        </div>
        <div style="color:#aab4c3;font-size:12px;margin-bottom:8px">Импорт сам создаёт профиль — заранее создавать пустой проект не нужно. Переносятся настройки, но не ключи, очередь и состояние автоцикла; подключения сохраните заново и повторно разрешите проект.</div>
        <div id="cfn-project-info" style="color:#aab4c3;white-space:pre-wrap"></div>
        <button id="cfn-project-enable" style="${action};margin-top:8px;background:#285638">Проверить подключения и разрешить работу</button>
        <div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:8px">
          <button id="cfn-project-migration-preview" style="${action}">Проверить Mission ID карточек</button>
          <button id="cfn-project-migration-apply" style="${action}">Записать проверенные Mission ID</button>
          <button id="cfn-project-import" style="${action}">Перенести прежнее локальное состояние</button>
          <button id="cfn-project-rejected" style="${action}">Посмотреть сохранённые ответы</button>
        </div>
        <div style="margin:8px 0;color:#ffd479;font-size:12px">Для нового проекта необходим шлюз 1.6 с отдельным ключом. После разрешения фоновые сторожа вопросов и старых ADR могут создавать записи; сам автоцикл не запускается.</div>
        <div id="cfn-project-form" style="display:none;border-top:1px solid #343b48;margin-top:14px;padding-top:12px">
          <h3 id="cfn-project-form-title" style="margin:0 0 6px">Новый профиль</h3>
          <div style="color:#aab4c3;font-size:12px">Нужны ID именно источников данных Notion, а не ID представлений или баз. Используйте отдельную копию четырёх баз с той же схемой и ролями Coordinator и Reviewer. Доступы сохраняются отдельно в «Подключениях» после переключения.</div>
          <div style="display:grid;gap:9px;margin-top:10px">
            <label>Имя проекта<input id="cfn-project-name" style="${field}" maxlength="80"></label>
            <label>Notion: источник «Роли»<input id="cfn-project-roles" style="${field}" placeholder="UUID источника или ссылка на базу"></label>
            <label>Notion: источник «Миссии»<input id="cfn-project-missions" style="${field}" placeholder="UUID источника или ссылка на базу"></label>
            <label>Notion: источник «Запросы»<input id="cfn-project-requests" style="${field}" placeholder="UUID источника или ссылка на базу"></label>
            <label>Notion: источник «Обратная связь»<input id="cfn-project-questions" style="${field}" placeholder="UUID источника или ссылка на базу"></label>
            <div style="border:1px solid #343b48;border-radius:8px;padding:10px;color:#aab4c3;font-size:12px">
              Если у вас ссылки на четыре отдельные базы, вставьте их выше и временно введите токен интеграции: кнопка прочитает ID источников. Токен не сохраняется и после поиска очищается; вводите его только на доверенной странице.
              <label style="display:block;margin-top:6px">Токен для поиска ID<input id="cfn-project-lookup-notion" type="password" autocomplete="off" style="${field}" placeholder="Токен Notion (не сохраняется)"></label>
              <button id="cfn-project-resolve" type="button" style="${action};margin-top:7px">Найти ID источников по ссылкам</button>
            </div>
            <label>URL регламента проекта в Notion<input id="cfn-project-pageUrl" style="${field}" placeholder="https://…"></label>
            <label>URL базы «Обратная связь» в Notion<input id="cfn-project-questionsUrl" style="${field}" placeholder="https://…"></label>
            <label>GitHub репозиторий<input id="cfn-project-repo" style="${field}" placeholder="owner/repository"></label>
            <label>Базовая ветка<input id="cfn-project-branch" style="${field}" value="main"></label>
            <label>Папка проекта внутри Arena (латиница)<input id="cfn-project-driveFolder" style="${field}" placeholder="synapse"></label>
          </div>
          <div id="cfn-project-repos" style="border:1px solid #343b48;border-radius:8px;padding:10px;margin-top:14px;display:none">
            <h4 style="margin:0 0 6px">Репозитории профиля</h4>
            <div style="color:#aab4c3;font-size:12px">Один профиль может работать с несколькими репозиториями (одна история, очередь и Gateway на профиль, но разные цели выдачи). Ровно один репозиторий — главный: он совпадает с полями «Репозиторий» и «Ветка» выше.</div>
            <div id="cfn-project-repos-list"></div>
            <button id="cfn-project-repo-add" type="button" style="${action};margin-top:7px">Добавить репозиторий</button>
          </div>
          <div id="cfn-project-routes" style="border:1px solid #343b48;border-radius:8px;padding:10px;margin-top:10px;display:none">
            <h4 style="margin:0 0 6px">Маршрутизация ролей к репозиториям</h4>
            <div style="color:#aab4c3;font-size:12px">Каждой роли ставится в соответствие репозиторий, в котором она работает (ID роли — UUID страницы в базе «Роли», а не её имя). Executor Core → synapse, Executor Cortex → synapse-cortex, аудит из сессии Cortex — явный маршрут или полная ссылка на PR. Роли без маршрута работают в главном репозитории.</div>
            <div id="cfn-project-routes-list"></div>
            <button id="cfn-project-route-add" type="button" style="${action};margin-top:7px">Добавить маршрут роли</button>
            <button id="cfn-project-roles-autofill" type="button" style="${action};margin-top:7px;margin-left:7px">Автозаполнить маршруты ролей</button>
          </div>
          <div id="cfn-project-provision" style="border:1px solid #343b48;border-radius:8px;padding:10px;margin-top:10px">
            <h4 style="margin:0 0 6px">Provisioning Arena-агентов</h4>
            <div style="color:#aab4c3;font-size:12px">Выключено по умолчанию. Создание/замена агентов выполняется только после одобрения активной админ-роли (Agent Admin=true). Пустой allowlist или пустой bootstrap-пробник блокируют создание. Проектные имена не зашиваются.</div>
            <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input id="cfn-project-prov-enabled" type="checkbox"> Включить provisioning</label>
            <label>Режим<select id="cfn-project-prov-mode" style="${field}"><option value="manual">manual — кнопка «🤖 Агенты»</option><option value="auto">auto — холостой цикл</option></select></label>
            <label>Allowlist репозиториев (по одному owner/repo на строку)<textarea id="cfn-project-prov-allowlist" style="${field};min-height:54px" placeholder="owner/repository"></textarea></label>
            <label>Bootstrap-пробник (без внутренних токенов и ссылок)<textarea id="cfn-project-prov-bootstrap" style="${field};min-height:54px" placeholder="Что изображено на картинке test.jpg в репозитории https://github.com/OWNER/test?"></textarea></label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <label>Max jobs за запрос<input id="cfn-project-prov-maxjobs" type="number" min="1" max="20" style="${field}"></label>
              <label>Суточный максимум<input id="cfn-project-prov-dailymax" type="number" min="1" max="100" style="${field}"></label>
              <label>Ожидание bootstrap, мс<input id="cfn-project-prov-bootstrapwait" type="number" min="1000" style="${field}"></label>
              <label>Ожидание URL, мс<input id="cfn-project-prov-urlwait" type="number" min="1000" style="${field}"></label>
              <label>Попытки rename<input id="cfn-project-prov-renameattempts" type="number" min="1" max="10" style="${field}"></label>
            </div>
            <label style="display:flex;gap:6px;align-items:center;margin-top:8px"><input id="cfn-project-prov-autoactivate" type="checkbox"> Автоактивация после проверки</label>
            <label style="display:flex;gap:6px;align-items:center;margin-top:4px"><input id="cfn-project-prov-archiveold" type="checkbox"> Архивировать старого агента при replace</label>
          </div>
          <button id="cfn-project-save" style="${action};margin-top:12px;background:#285638">Создать профиль</button>
        </div>
        <div id="cfn-project-note" role="status" style="white-space:pre-wrap;color:#bfe6c4;margin-top:12px"></div>
      </div>`;
    document.body.appendChild(box);
    const find = (key) => box.querySelector(`#cfn-project-${key}`);
    const list = find("list"), note = find("note"), form = find("form");
    const fields = ["name", "roles", "missions", "requests", "questions", "pageUrl", "questionsUrl", "repo", "branch", "driveFolder"];
    const say = (message, error = false) => { note.textContent = message; note.style.color = error ? "#ffb4ad" : "#bfe6c4"; };
    let checking = false;
    let editingId = "";
    let migrationPlan = null;
    // Репозитории и маршруты ролей редактируются отдельными списками; поля
    // «Репозиторий» и «Ветка» выше дублируют главную запись.
    let repos = [{ repo: "", branch: "main", main: true }];
    let routes = []; // {roleId, repo}
    const reposList = find("repos-list");
    const routesList = find("routes-list");
    let openingRevision = JSON.stringify(profileRegistry());

    const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
    const ensureMain = () => { if (repos.length && !repos.some((r) => r.main)) repos[0].main = true; };
    const onlyOneMain = (i) => { repos.forEach((r, k) => { r.main = k === i; }); };

    const renderRepos = () => {
      reposList.textContent = "";
      const hint = document.createElement("div");
      hint.style.cssText = "color:#aab4c3;font-size:12px;margin:0 0 6px";
      hint.textContent = repos.length ? "Ровно один репозиторий должен быть главным — он совпадает с полями «Репозиторий» и «Ветка» выше." : "Добавьте хотя бы один репозиторий.";
      reposList.appendChild(hint);
      for (let i = 0; i < repos.length; i++) {
        const r = repos[i];
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:1fr 120px auto auto;gap:7px;align-items:center;border:1px solid #343b48;border-radius:7px;padding:7px;margin:6px 0";
        const inpRepo = document.createElement("input");
        inpRepo.id = `cfn-repo-${i}`; inpRepo.style.cssText = field; inpRepo.placeholder = "owner/repository"; inpRepo.value = r.repo;
        inpRepo.oninput = () => { r.repo = inpRepo.value.trim(); };
        const inpBranch = document.createElement("input");
        inpBranch.id = `cfn-repo-branch-${i}`; inpBranch.style.cssText = field; inpBranch.placeholder = "main"; inpBranch.value = r.branch;
        inpBranch.oninput = () => { r.branch = inpBranch.value.trim() || "main"; };
        const mainLabel = document.createElement("label");
        mainLabel.style.cssText = "display:flex;align-items:center;gap:5px;cursor:pointer";
        const mainRadio = document.createElement("input");
        mainRadio.type = "radio"; mainRadio.name = "cfn-repo-main"; mainRadio.value = i; mainRadio.checked = r.main;
        mainRadio.onchange = () => { onlyOneMain(i); };
        mainLabel.appendChild(mainRadio); mainLabel.append(document.createTextNode("Главный"));
        const removeBtn = document.createElement("button");
        removeBtn.type = "button"; removeBtn.textContent = "Удалить";
        removeBtn.style.cssText = `${action};padding:6px 8px;font-size:12px`;
        removeBtn.onclick = () => { repos.splice(i, 1); ensureMain(); renderRepos(); };
        row.appendChild(inpRepo); row.appendChild(inpBranch); row.appendChild(mainLabel); row.appendChild(removeBtn);
        reposList.appendChild(row);
      }
    };

    const renderRoutes = () => {
      routesList.textContent = "";
      const hint = document.createElement("div");
      hint.style.cssText = "color:#aab4c3;font-size:12px;margin:0 0 6px";
      hint.textContent = "ID роли — UUID страницы роли в базе «Роли» (имя столбца «Роль» — заголовок, а не ID). Роли без маршрута работают в главном репозитории.";
      routesList.appendChild(hint);
      const repoSelectHtml = (selected) => repos.map((r) => `<option value="${escHtml(r.repo)}" ${r.repo === selected ? "selected" : ""}>${escHtml(r.repo)} (${escHtml(r.branch)})</option>`).join("") || '<option value="">(добавьте репозиторий выше)</option>';
      for (let i = 0; i < routes.length; i++) {
        const rt = routes[i];
        const row = document.createElement("div");
        row.style.cssText = "display:grid;grid-template-columns:1fr 1fr auto;gap:7px;align-items:center;border:1px solid #343b48;border-radius:7px;padding:7px;margin:6px 0";
        const inpRole = document.createElement("input");
        inpRole.id = `cfn-route-role-${i}`; inpRole.style.cssText = field; inpRole.placeholder = "UUID роли"; inpRole.value = rt.roleId;
        inpRole.oninput = () => { rt.roleId = inpRole.value.trim(); };
        const selRepo = document.createElement("select");
        selRepo.id = `cfn-route-repo-${i}`; selRepo.style.cssText = field; selRepo.innerHTML = repoSelectHtml(rt.repo);
        selRepo.onchange = () => { rt.repo = selRepo.value; };
        const removeBtn = document.createElement("button");
        removeBtn.type = "button"; removeBtn.textContent = "Удалить";
        removeBtn.style.cssText = `${action};padding:6px 8px;font-size:12px`;
        removeBtn.onclick = () => { routes.splice(i, 1); renderRoutes(); };
        row.appendChild(inpRole); row.appendChild(selRepo); row.appendChild(removeBtn);
        routesList.appendChild(row);
      }
    };

    const loadProfileUi = (p) => {
      repos = (Array.isArray(p.repos) && p.repos.length ? p.repos : [{ repo: p.repo || "", branch: p.branch || "main", main: true }])
        .map((r) => ({ repo: String(r.repo || "").trim(), branch: String(r.branch || "main").trim() || "main", main: Boolean(r.main) }));
      ensureMain();
      routes = (Array.isArray(p.roleRepos) ? p.roleRepos : []).map((rt) => ({ roleId: String(rt.roleId || "").trim(), repo: String(rt.repo || "").trim() })).filter((rt) => rt.roleId || rt.repo);
      renderRepos(); renderRoutes();
      const prov = normalizeProvisionConfig(p);
      find("prov-enabled").checked = prov.agentProvisionEnabled;
      find("prov-mode").value = prov.agentProvisionMode;
      find("prov-allowlist").value = prov.agentProvisionRepoAllowlist.join("\n");
      find("prov-bootstrap").value = prov.agentBootstrapPrompt;
      find("prov-maxjobs").value = prov.agentProvisionMaxJobs;
      find("prov-dailymax").value = prov.agentProvisionDailyMax;
      find("prov-bootstrapwait").value = prov.agentBootstrapWaitMs;
      find("prov-urlwait").value = prov.agentUrlWaitMs;
      find("prov-renameattempts").value = prov.agentRenameAttempts;
      find("prov-autoactivate").checked = prov.agentProvisionAutoActivate;
      find("prov-archiveold").checked = prov.agentProvisionArchiveOld;
    };

    const saveProfileUi = () => {
      if (checking) { say("Дождитесь окончания поиска или проверки.", true); return; }
      const p = { id: editingId || crypto.randomUUID() };
      for (const field of fields) p[field] = find(field).value.trim();
      p.driveFolder = p.driveFolder.toLowerCase();
      p.repos = repos.map((r) => ({ repo: r.repo, branch: r.branch, main: r.main })).filter((r) => r.repo);
      if (!p.repos.length) p.repos = [{ repo: p.repo || "", branch: p.branch || "main", main: true }];
      const mains = p.repos.filter((r) => r.main).length;
      if (mains !== 1) { say("Укажите ровно один главный репозиторий.", true); return; }
      p.roleRepos = routes.filter((rt) => rt.roleId && rt.repo);
      Object.assign(p, normalizeProvisionConfig({
        agentProvisionEnabled: find("prov-enabled").checked,
        agentProvisionMode: find("prov-mode").value,
        agentProvisionRepoAllowlist: find("prov-allowlist").value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
        agentBootstrapPrompt: find("prov-bootstrap").value,
        agentProvisionMaxJobs: find("prov-maxjobs").value,
        agentProvisionDailyMax: find("prov-dailymax").value,
        agentBootstrapWaitMs: find("prov-bootstrapwait").value,
        agentUrlWaitMs: find("prov-urlwait").value,
        agentRenameAttempts: find("prov-renameattempts").value,
        agentProvisionAutoActivate: find("prov-autoactivate").checked,
        agentProvisionArchiveOld: find("prov-archiveold").checked,
      }));
      if (p.agentProvisionEnabled && !provisionBootstrapClean(p.agentBootstrapPrompt)) {
        say("Provisioning включён, но bootstrap-пробник пуст или содержит запрещённые внутренние токены/ссылки.", true); return;
      }
      if (!validProfile(p)) {
        const routeProblem = p.roleRepos.some((route) =>
          !PROJECT_UUID.test(String(route.roleId || "")) ||
          !p.repos.some((entry) => String(entry.repo || "").toLowerCase() === String(route.repo || "").toLowerCase()));
        say(routeProblem
          ? "Не сохранено: проверьте автозаполненные маршруты ролей. Для каждой роли нужен UUID страницы из базы «Роли», а выбранный owner/repository должен быть в списке репозиториев профиля."
          : "Проверьте четыре разных UUID источников, HTTPS-ссылки Notion, owner/repository, допустимую ветку и имя папки из латинских букв, цифр, . _ -.", true);
        return;
      }
      const known = [LEGACY_PROFILE, ...profileRegistry().filter((item) => validProfile(item) && item.id !== editingId)];
      const sourceIds = new Set(known.flatMap((item) => [item.roles, item.missions, item.requests, item.questions]).map((id) => id.toLowerCase()));
      if ([p.roles, p.missions, p.requests, p.questions].some((id) => sourceIds.has(id.toLowerCase()))) {
        say("Один из источников уже используется другим профилем. Создайте отдельные копии всех четырёх баз, чтобы не смешать очереди и роли.", true); return;
      }
      const usedRepos = new Set(known.filter((item) => !item.legacy).flatMap((item) =>
        Array.isArray(item.repos) ? item.repos.map((r) => String(r.repo || "").toLowerCase()) : [String(item.repo || "").toLowerCase()]));
      const clashRepo = p.repos.find((r) => usedRepos.has(String(r.repo).toLowerCase()));
      if (clashRepo &&
          !confirm(`Репозиторий ${clashRepo.repo} уже используется другим профилем. Проекты смогут видеть и изменять один репозиторий. Продолжить?`)) return;
      if (JSON.stringify(profileRegistry()) !== openingRevision ||
          (editingId && (projectApproved() || GM_getValue("cfn-project-ever-approved", false)))) {
        say("Профиль или его допуск изменился во время подтверждения. Откройте окно заново.", true); return;
      }
      try {
        if (editingId) {
          // Сначала ставим удержание, останавливаем автоцикл, затем меняем реестр и перезагружаем вкладку.
          autoSet(false);
          sessionStorage.setItem(PROJECT_HOLD_PREFIX + p.id, "1");
          rawSet(PROFILE_REGISTRY_KEY, profileRegistry().map((item) => item.id === editingId ? p : item));
          location.reload();
          return;
        }
        rawSet(PROFILE_REGISTRY_KEY, [...profileRegistry(), p]);
        openingRevision = JSON.stringify(profileRegistry());
      } catch { say("Не удалось сохранить профиль или перезагрузить вкладку. Проверьте настройки и обновите страницу вручную.", true); return; }
      form.style.display = "none"; render(p.id);
      say(`Профиль создан. ID: ${p.id}\nТеперь зарегистрируйте его в шлюзе Drive, откройте этот профиль и сохраните отдельные подключения.`);
    };
    const profiles = () => [LEGACY_PROFILE, ...profileRegistry().filter(validProfile)];
    const chosen = () => profiles().find((p) => p.id === list.value);
    const render = (selected = ACTIVE_PROFILE.id) => {
      list.textContent = "";
      for (const profile of profiles()) {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name;
        list.appendChild(option);
      }
      list.value = profiles().some((p) => p.id === selected) ? selected : LEGACY_PROFILE_ID;
      find("current").textContent = ACTIVE_PROFILE.name;
      const p = chosen();
      const repos = Array.isArray(p?.repos) && p.repos.length ? p.repos : [{ repo: p.repo || "", branch: p.branch || "main", main: true }];
      const main = repos.find((r) => r.main) || repos[0];
      find("info").textContent = p
        ? `ID: ${p.id}\nРепозитории: ${repos.map((r) => `${r.repo || p.repo} (${r.branch || "main"}${r.main ? ", главный" : ""}`).join("; ") || p.repo}\nМаршрутов ролей: ${Array.isArray(p.roleRepos) ? p.roleRepos.length : 0}\nDrive: ${p.legacy ? "Arena/logs и Arena/payloads (совместимость)" : `Arena/${p.driveFolder}/{logs,payloads}`}`
        : "Профиль не найден.";
      find("enable").style.display = !ACTIVE_PROFILE.legacy && !ACTIVE_PROFILE.invalid && !projectApproved() ? "inline-block" : "none";
      const everApproved = !ACTIVE_PROFILE.legacy && (GM_getValue("cfn-project-ever-approved", false) || projectApproved());
      find("edit").style.display = !ACTIVE_PROFILE.legacy && !ACTIVE_PROFILE.invalid && !everApproved ? "inline-block" : "none";
    };
    const transferProfile = (profile) => ({
      id: String(profile.id), name: String(profile.name),
      roles: String(profile.roles), missions: String(profile.missions),
      requests: String(profile.requests), questions: String(profile.questions),
      pageUrl: String(profile.pageUrl), questionsUrl: String(profile.questionsUrl),
      repo: String(profile.repo), branch: String(profile.branch), driveFolder: String(profile.driveFolder),
      repos: (Array.isArray(profile.repos) ? profile.repos : []).map((entry) => ({
        repo: String(entry.repo || ""), branch: String(entry.branch || "main"), main: entry.main === true,
      })),
      roleRepos: (Array.isArray(profile.roleRepos) ? profile.roleRepos : []).map((route) => ({
        roleId: String(route.roleId || ""), repo: String(route.repo || ""),
      })),
      ...normalizeProvisionConfig(profile),
    });
    find("export-config").onclick = () => {
      const profile = chosen();
      if (!profile || profile.legacy || !validProfile(profile)) { say("Выберите корректный проект для экспорта.", true); return; }
      try {
        const backup = { format: "scriptcat-project-config", version: 1, profile: transferProfile(profile) };
        const blob = new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `scriptcat-${profile.name.replace(/[^A-Za-z0-9._-]+/g, "-")}-${profile.id}.json`;
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        say("Конфигурация экспортирована. В файле только метаданные проекта: секреты, подключения и состояние работы не включены.");
      } catch { say("Не удалось экспортировать конфигурацию проекта.", true); }
    };
    find("import-config").onclick = () => {
      if (checking || autoOn() || busy || projectAsyncWork > 0) {
        say("Остановите автоцикл и дождитесь завершения текущих операций перед импортом.", true); return;
      }
      find("import-file").value = "";
      find("import-file").click();
    };
    find("import-file").onchange = async () => {
      const file = find("import-file").files?.[0];
      if (!file) return;
      if (checking || autoOn() || busy || projectAsyncWork > 0) {
        say("Остановите автоцикл и дождитесь завершения текущих операций перед импортом.", true); return;
      }
      checking = true;
      try {
        if (file.size > 128 * 1024) throw new Error("Файл больше 128 КБ; выберите экспорт ScriptCat конфигурации проекта.");
        const parsed = JSON.parse(await file.text());
        if (!parsed || parsed.format !== "scriptcat-project-config" || parsed.version !== 1 ||
            !parsed.profile || typeof parsed.profile !== "object" || Array.isArray(parsed.profile))
          throw new Error("Формат файла не распознан. Импортируйте экспорт конфигурации ScriptCat.");
        // Whitelist deliberately excludes connection credentials and runtime state.
        const profile = transferProfile(parsed.profile);
        if (!validProfile(profile)) throw new Error("Профиль не прошёл проверку: проверьте UUID, HTTPS-ссылки, репозитории, ветки и папку проекта.");
        const registry = profileRegistry();
        if (registry.some((item) => item?.id === profile.id)) throw new Error("Профиль с таким ID уже существует на этом компьютере.");
        if (JSON.stringify(registry) !== openingRevision) throw new Error("Реестр проектов изменился в другой вкладке. Закройте окно и повторите импорт.");
        const known = [LEGACY_PROFILE, ...registry.filter(validProfile)];
        const usedSources = new Set(known.flatMap((item) => [item.roles, item.missions, item.requests, item.questions]).map((id) => String(id || "").toLowerCase()));
        if ([profile.roles, profile.missions, profile.requests, profile.questions].some((id) => usedSources.has(id.toLowerCase())))
          throw new Error("Один из источников уже используется другим профилем на этом компьютере.");
        const usedRepos = new Set(known.filter((item) => !item.legacy).flatMap((item) =>
          Array.isArray(item.repos) ? item.repos.map((entry) => String(entry.repo || "").toLowerCase()) : [String(item.repo || "").toLowerCase()]));
        const clash = profile.repos.find((entry) => usedRepos.has(entry.repo.toLowerCase()));
        if (clash && !confirm(`Репозиторий ${clash.repo} уже используется другим профилем. Продолжить импорт?`)) return;
        if (JSON.stringify(profileRegistry()) !== openingRevision || autoOn() || busy || projectAsyncWork > 0)
          throw new Error("Проект или активность изменились во время импорта; операция отменена.");
        rawSet(PROFILE_REGISTRY_KEY, [...registry, profile]);
        openingRevision = JSON.stringify(profileRegistry());
        form.style.display = "none";
        render(profile.id);
        say(`Импортирован проект «${profile.name}». Ключи и локальное состояние не импортируются. Откройте проект, заново сохраните подключения и проверьте его перед разрешением работы. Автоцикл выключен.`);
      } catch (e) { say(`Импорт не выполнен: ${e.message}`, true); }
      finally { checking = false; find("import-file").value = ""; }
    };
    const close = () => {
      if (checking) { say("Дождитесь завершения проверки проекта.", true); return; }
      find("lookup-notion").value = "";
      box.remove();
      document.getElementById(ui.setup)?.focus();
    };
    find("close").onclick = close;
    box.onkeydown = (event) => {
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key !== "Tab") return;
      const all = [...box.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.disabled && el.getClientRects().length);
      if (!all.length) return;
      if (event.shiftKey && (document.activeElement === all[0] || !all.includes(document.activeElement))) { event.preventDefault(); all.at(-1).focus(); }
      else if (!event.shiftKey && (document.activeElement === all.at(-1) || !all.includes(document.activeElement))) { event.preventDefault(); all[0].focus(); }
    };
    list.onchange = () => render(list.value);
    find("new").onclick = () => {
      editingId = "";
      find("save").textContent = "Создать профиль";
      find("form-title").textContent = "Новый профиль";
      repos = [{ repo: "", branch: "main", main: true }];
      routes = [];
      renderRepos(); renderRoutes();
      find("repos").style.display = "block";
      find("routes").style.display = "block";
      for (const field of fields) find(field).value = field === "branch" ? "main" : "";
      form.style.display = "block"; say("Заполните настройки. Ничего в сервисах не создаётся автоматически.");
      find("name").focus();
    };
    find("copy").onclick = () => {
      editingId = "";
      find("save").textContent = "Создать профиль";
      find("form-title").textContent = "Новый профиль";
      const p = chosen(); if (!p) return;
      for (const field of fields) find(field).value = p[field] || (field === "branch" ? "main" : "");
      find("name").value = `${p.name} — новая настройка`;
      loadProfileUi(p);
      find("repos").style.display = "block";
      find("routes").style.display = "block";
      form.style.display = "block";
      say("Будет создан новый профиль с пустым состоянием и отдельными доступами; старый профиль не изменится.");
      find("name").focus();
    };
    find("edit").onclick = () => {
      if (ACTIVE_PROFILE.legacy || ACTIVE_PROFILE.invalid || projectApproved() || GM_getValue("cfn-project-ever-approved", false)) {
        say("Этот профиль уже использовался. Для других источников создайте новый профиль, не перенося очередь автоматически.", true); return;
      }
      if (checking || autoOn() || busy || projectAsyncWork > 0) {
        say("Дождитесь окончания всех начатых операций.", true); return;
      }
      editingId = ACTIVE_PROFILE.id;
      for (const field of fields) find(field).value = ACTIVE_PROFILE[field] || (field === "branch" ? "main" : "");
      loadProfileUi(ACTIVE_PROFILE);
      find("repos").style.display = "block";
      find("routes").style.display = "block";
      find("save").textContent = "Сохранить исправления и перезагрузить вкладку";
      find("form-title").textContent = "Исправить текущий профиль";
      form.style.display = "block";
      say("Исправляется текущий профиль до первого допуска. Выбранный ID и сохранённые доступы остаются; схема и подключения будут проверены заново.");
      find("name").focus();
    };
    find("resolve").onclick = async () => {
      if (checking) return;
      const names = ["roles", "missions", "requests", "questions"];
      const values = names.map((name) => find(name).value.trim());
      const ids = values.map(notionDatabaseId);
      const token = find("lookup-notion").value.trim();
      if (!token || ids.some((id) => !id) || new Set(ids).size !== 4) {
        find("lookup-notion").value = "";
        say("Для поиска введите токен и четыре разные HTTPS-ссылки на базы Notion (не ссылки на представления).", true); return;
      }
      checking = true;
      say("Читаю источники четырёх баз в Notion; ничего не меняю и токен не сохраняю…");
      try {
        const headers = { Authorization: `Bearer ${token}`, "Notion-Version": C.notionV, "Content-Type": "application/json" };
        const sources = [];
        for (const id of ids) {
          const database = await request("GET", `https://api.notion.com/v1/databases/${id}`, headers);
          const list = database?.data_sources;
          if (!Array.isArray(list) || list.length !== 1 || !PROJECT_UUID.test(String(list[0]?.id || "")))
            throw new Error("У базы не ровно один доступный источник: укажите ID нужного data source вручную.");
          sources.push(list[0].id);
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        if (names.some((name, i) => find(name).value.trim() !== values[i]) || find("lookup-notion").value.trim() !== token) {
          say("Поля изменились во время поиска: результаты не подставлены, повторите проверку.", true); return;
        }
        if (new Set(sources.map((id) => id.toLowerCase())).size !== 4)
          throw new Error("У четырёх баз должны быть разные источники.");
        names.forEach((name, i) => { find(name).value = sources[i]; });
        say("ID четырёх источников найдены и подставлены. Это чтение не проверяет права записи или схему.");
      } catch (e) {
        say(`Поиск ID не завершён: ${connectionProblem(e, { notion: token, gwKey: "", github: "" })}`, true);
      } finally {
        find("lookup-notion").value = "";
        checking = false;
      }
    };
    find("save").onclick = saveProfileUi;
    find("repo-add").onclick = () => {
      repos.push({ repo: "", branch: "main", main: false });
      ensureMain();
      renderRepos();
    };
    find("route-add").onclick = () => {
      routes.push({ roleId: "", repo: "" });
      renderRoutes();
    };
    find("roles-autofill").onclick = async () => {
      if (checking) { say("Дождитесь окончания операции.", true); return; }
      checking = true;
      try {
        const notionToken = String(GM_getValue(K.notion, "") || "").trim();
        if (!notionToken) throw new Error("Токен Notion не задан. Укажите его в «Подключениях».");
        const headers = { Authorization: `Bearer ${notionToken}`, "Notion-Version": C.notionV, "Content-Type": "application/json" };
        const rows = [];
        let cursor = "";
        while (true) {
          const page = await request("POST", `https://api.notion.com/v1/data_sources/${C.roles}/query`, headers,
            { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, { retry: false });
          if (!page || !Array.isArray(page.results) || typeof page.has_more !== "boolean") throw new Error("База «Роли» вернула неполный список.");
          rows.push(...page.results);
          if (!page.has_more) break;
          cursor = String(page.next_cursor || "");
          if (!cursor) break;
        }
        const configuredRepos = (Array.isArray(repos) ? repos : [])
          .map((entry) => String(entry.repo || "").trim()).filter(Boolean);
        const defaultOwner = String(find("repo").value || "").trim().split("/")[0];
        const fullRepo = (value) => {
          const raw = String(value || "").trim();
          if (!raw || raw.includes(" ")) return "";
          if (raw.includes("/")) return raw;
          const configured = configuredRepos.find((repo) => repo.split("/").at(-1).toLowerCase() === raw.toLowerCase());
          return configured || (defaultOwner ? `${defaultOwner}/${raw}` : "");
        };
        const roles = rows.map((p) => ({
          // Role routes use the Notion page UUID, never the Agent URL slug.
          id: String(p.id || "").trim(),
          name: rt(p.properties["Роль"]),
          fn: sel(p.properties["Функция"]),
          status: sel(p.properties["Статус"]),
          // Role tables often store just a repository slug; qualify it with the
          // configured owner so it satisfies the profile's owner/repository contract.
          repo: fullRepo(rt(p.properties["Репозиторий"])),
        }));
        const active = roles.filter((r) => r.status === "Активна");
        if (!active.length) throw new Error("Нет активных ролей в базе «Роли».");
        const warden = active.find((r) => r.name === "Warden");
        if (!warden || !warden.repo) throw new Error("Роль Warden не найдена или у неё не указан репозиторий в поле «Репозиторий».");
        const mainRepo = warden.repo;
        const uniqueRepos = [];
        for (const r of active) {
          if (r.repo && !uniqueRepos.some((u) => u.repo === r.repo)) {
            uniqueRepos.push({ repo: r.repo, branch: "main", main: r.repo === mainRepo });
          }
        }
        if (!uniqueRepos.some((u) => u.main)) {
          uniqueRepos[0].main = true;
        }
        repos = uniqueRepos;
        ensureMain();
        const mainEntry = repos.find((entry) => entry.main) || repos[0];
        if (mainEntry) {
          find("repo").value = mainEntry.repo;
          find("branch").value = mainEntry.branch;
        }
        renderRepos();
        routes = active.map((r) => ({ roleId: r.id, repo: r.repo || mainRepo })).filter((rt) => rt.roleId && rt.repo);
        renderRoutes();
        say(`Автозаполнено: главный репозиторий ${mainRepo} (по роли Warden), ${routes.length} маршрутов ролей.`);
      } catch (e) {
        say(`Ошибка автозаполнения: ${e.message}`, true);
      } finally {
        checking = false;
      }
    };
    find("switch").onclick = () => {
      const target = chosen();
      if (!target || target.id === ACTIVE_PROFILE.id) { say("Этот проект уже выбран."); return; }
      if (checking || autoOn() || busy || projectAsyncWork > 0) {
        say("Остановите автоцикл и дождитесь окончания всех начатых шагов и фоновых запросов. Затем повторите.", true); return;
      }
      const handoff = GM_getValue(K.pending, null) || GM_getValue(K.expect, null);
      if (!confirm(`Открыть «${target.name}»? Вкладка перезагрузится, автоцикл останется выключенным.${handoff ? "\nУ текущего проекта есть очередь или ожидание: они останутся в его профиле." : ""}\nПри возвращении к проекту ожидающий ход не продолжится без ручного шага.`)) return;
      try {
        sessionStorage.removeItem(projectStorageKey(target.id, "cfn-auto-enabled"));
        sessionStorage.setItem(PROJECT_HOLD_PREFIX + target.id, "1");
        sessionStorage.setItem(PROFILE_SESSION_KEY, target.id);
        location.reload();
      } catch { say("Не удалось сохранить выбор во вкладке; проект не переключён.", true); }
    };
    const migrationSafe = () => !ACTIVE_PROFILE.invalid && !ACTIVE_PROFILE.legacy &&
      !autoOn() && !busy && projectAsyncWork === 0;
    const migrationSignature = (plan) => JSON.stringify({
      mapped: plan.mapped.map((item) => [item.row.id, item.row.last_edited_time, item.id, item.mission.last_edited_time, item.label]),
      existing: plan.existing.map((item) => [item.row.id, item.row.last_edited_time, item.id]),
      conflicts: plan.conflicts.map((item) => [item.row?.id || "", item.why]), count: plan.count,
    });
    find("rejected").onclick = () => {
      const saved = GM_getValue("cfn-rejected-results-v1", []);
      if (!Array.isArray(saved) || !saved.length) { say("Сохранённых отклонённых ответов в этом профиле нет."); return; }
      say("Локальные копии могут содержать данные проекта; не публикуйте их и не отправляйте секреты в чат.\n\n" +
        saved.map((item) => `${item.at} · ${item.kind} · ${item.ref} · run ${item.runId || "—"} · turn ${item.turnId || "—"}\n${item.raw}`).join("\n\n---\n\n"));
    };
    find("migration-preview").onclick = async () => {
      if (checking || !migrationSafe()) { say("Откройте настроенный профиль, остановите цикл и дождитесь всех операций.", true); return; }
      checking = true; migrationPlan = null;
      try {
        const source = await notion("GET", `data_sources/${C.requests}`);
        if (source.properties?.["Mission ID"]?.type !== "rich_text")
          throw new Error("В базе «Запросы» сначала создайте поле Mission ID типа text.");
        migrationPlan = await inspectMissionMigration();
        say(formatMissionMigration(migrationPlan), migrationPlan.conflicts.length > 0);
      } catch (e) { say(`Предпросмотр не выполнен: ${connectionProblem(e, connectionSettings())}`, true); }
      finally { checking = false; }
    };
    find("migration-apply").onclick = async () => {
      if (checking || !migrationSafe() || !migrationPlan) { say("Сначала остановите цикл и выполните предпросмотр.", true); return; }
      if (migrationPlan.conflicts.length) { say(formatMissionMigration(migrationPlan) + "\nСначала вручную разберите все строки ПРОВЕРИТЬ и обновите предпросмотр.", true); return; }
      if (GM_getValue(K.pending, null) || GM_getValue(K.expect, null)) {
        say("Сохранены незавершённая очередь или ожидание. Сначала разберите их и проверьте чат и журнал; миграция ничего не снимает.", true); return;
      }
      if (!migrationPlan.mapped.length) { say("Все карточки уже привязаны; записывать нечего."); return; }
      if (migrationPlan.mapped.some((item) => !item.row.last_edited_time || !item.mission.last_edited_time)) {
        say("Notion не вернул время последнего изменения. Без него автоматическую запись не выполняю.", true); return;
      }
      if (!confirm(`Записать Mission ID в ${migrationPlan.mapped.length} карточек?\n\nПроверьте ВСЕ строки предпросмотра. Запись только в пустые поля. Остановите другие вкладки и внешние изменения; атомарной блокировки Notion нет.`)) return;
      checking = true;
      try {
        const fresh = await inspectMissionMigration();
        if (!migrationSafe() || GM_getValue(K.pending, null) || GM_getValue(K.expect, null) ||
            migrationSignature(fresh) !== migrationSignature(migrationPlan))
          throw new Error("Данные или состояние цикла изменились после предпросмотра; запись отменена.");
        const count = await applyMissionMigration(migrationPlan);
        migrationPlan = null;
        const verified = await inspectMissionMigration();
        say(`Записано Mission ID: ${count}. Проверка после записи:\n${formatMissionMigration(verified)}`, verified.conflicts.length > 0 || verified.mapped.length > 0);
      } catch (e) { migrationPlan = null; say(`Миграция прервана: ${connectionProblem(e, connectionSettings())}\nЧасть строк могла сохраниться. История не удалялась; выполните предпросмотр заново.`, true); }
      finally { checking = false; }
    };
    find("import").onclick = async () => {
      const target = chosen();
      if (checking || autoOn() || busy || projectAsyncWork > 0 || !target || target.legacy || !validProfile(target)) {
        say("Остановите все операции и выберите созданный, ещё не открытый новый профиль.", true); return;
      }
      if (target.id === ACTIVE_PROFILE.id) { say("Для переноса выберите ещё не открытый профиль, чтобы не смешать состояния.", true); return; }
      checking = true;
      try {
        const keys = typeof GM_listValues === "function" ? await Promise.resolve(GM_listValues()) : [];
        if (!Array.isArray(keys)) throw new Error("Менеджер скриптов не вернул список локальных ключей.");
        const legacy = keys.filter((key) => key.startsWith("cfn-") && key !== PROFILE_REGISTRY_KEY &&
          !["cfn-project-approved", "cfn-project-ever-approved", "cfn-auto-enabled", "cfn-step-request"].includes(key));
        if (!legacy.length) throw new Error("Прежнее локальное хранилище не найдено. Возможно, установлена отдельная копия; не удаляйте старый скрипт.");
        if (keys.some((key) => key.startsWith(`project:${target.id}:`))) throw new Error("В выбранном профиле уже есть локальное состояние; поверх него не копирую.");
        if (!confirm(`Скопировать ${legacy.length} локальных ключей в «${target.name}»?\n\nПодтвердите, что профиль вручную указывает на ТОТ ЖЕ проект и что все другие вкладки остановлены. Секреты, очередь и ожидания будут скопированы локально; старые ключи останутся. Автозапуск и допуск не переносятся.`)) return;
        const after = typeof GM_listValues === "function" ? await Promise.resolve(GM_listValues()) : [];
        if (autoOn() || busy || projectAsyncWork > 0 || after.some((key) => key.startsWith(`project:${target.id}:`)))
          throw new Error("Состояние изменилось во время подтверждения; копирование отменено.");
        for (const key of legacy) rawSet(projectStorageKey(target.id, key), rawGet(key, null));
        rawSet(projectStorageKey(target.id, "cfn-project-approved"), false);
        say(`Скопировано ключей: ${legacy.length}. Старые ключи сохранены. Откройте профиль, проверьте ожидание и журнал, настройте проектный шлюз и выполните проверку подключений. Автоцикл не запущен.`);
      } catch (e) { say(`Перенос не выполнен полностью: ${e.message}. Старые ключи не удалены; проверьте новый профиль.`, true); }
      finally { checking = false; }
    };
    find("enable").onclick = async () => {
      if (checking || ACTIVE_PROFILE.invalid || ACTIVE_PROFILE.legacy) return;
      if (autoOn() || busy || projectAsyncWork > 0) { say("Сначала остановите цикл и дождитесь завершения операций.", true); return; }
      const settings = connectionSettings();
      const profileUnchanged = () => JSON.stringify(resolveProfile(ACTIVE_PROFILE.id)) === JSON.stringify(ACTIVE_PROFILE);
      if (!profileUnchanged()) { say("Профиль изменён в другой вкладке: обновите страницу и проверьте его заново.", true); return; }
      if (!settings.notion || !settings.gwUrl || !settings.gwKey) { say("Сначала сохраните Notion и Drive в «Подключениях»; затем вернитесь сюда.", true); return; }
      checking = true; say("Проверяю сохранённые подключения, проектный шлюз, основные поля Notion и роли…");
      try {
        const results = await Promise.all([probeNotionConnection(settings), probeDriveConnection(settings), probeGithubConnection(settings)]);
        if (results.some((result) => !result.ok)) { say(results.map((result) => result.text).join("\n"), true); return; }
        const schema = await validateProjectSchema(settings);
        if (!schema.ok) { say(schema.text, true); return; }
        if (!profileUnchanged()) { say("Профиль изменён в другой вкладке: обновите страницу и проверьте его заново.", true); return; }
        if (!sameConnections(settings, connectionSettings())) { say("Подключения изменились в другой вкладке; проверьте проект заново.", true); return; }
        if (!confirm("Источники, основные поля, роли, ветка и проектный шлюз проверены. Права записи и содержимое старых карточек не проверены.\n\nРазрешить работу? Фоновые сторожа вопросов и предложений могут создавать записи в Notion; автоцикл не запустится.")) return;
        if (!profileUnchanged()) { say("Профиль изменён во время подтверждения: обновите страницу и проверьте его заново.", true); return; }
        if (!sameConnections(settings, connectionSettings())) { say("Подключения изменились во время подтверждения; проверьте проект заново.", true); return; }
        GM_setValue("cfn-project-ever-approved", true);
        GM_setValue("cfn-project-approved", true);
        watchQuestions(); watchDecisions(); render();
        say("Работа проекта разрешена. Автоцикл выключен; запустите его вручную только после проверки схемы и ролей.");
      } catch (e) { say(`Проверка не завершена: ${connectionProblem(e, settings)}`, true); }
      finally { checking = false; }
    };
    render();
    find("close").focus();
  }

