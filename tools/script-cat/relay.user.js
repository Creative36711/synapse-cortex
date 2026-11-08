// ==UserScript==
// @name         Relay — передача хода между агентами
// @namespace    https://arena.ai/
// @version      1.12.20
// @description  Цикл Координатор → исполнитель → Координатор: агент сам коммитит, пушит и мержит PR; ScriptCat ждёт мерж и нажимает Continue.
// @match        https://arena.ai/*
// @match        https://www.arena.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_listValues
// @connect      api.notion.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      ntfy.sh
// @connect      api.github.com
// ==/UserScript==

/**
 * Relay dispatch — тонкий транспорт.
 *
 * Разделение труда (важно, иначе всё ломается):
 *  - АГЕНТ сам делает `git commit`, `git push`, `gh pr create`, `gh pr merge`
 *    и заканчивает ответ маркером результата.
 *  - SCRIPT ждёт состояние «PR merged», нажимает Continue и пишет ветку.
 *    Кнопки Create/Merge — только запасной путь, если агент не справился сам:
 *    каждая кнопка порождает ответ агента, то есть новый chat-message.
 *  - РЕШЕНИЯ о работе (какая задача, принята ли карточка) принимает
 *    Координатор. Конец миссии — не его решение: next:"done" передаёт миссию
 *    приёмке (роль с функцией Reviewer), и только её `accept` останавливает
 *    цикл. Больше трёх доработок не бывает: четвёртый возврат будит Мастера.
 *
 * Состояния PR, которые скрипт различает:
 *   Merged   — бейдж «Pull request merged»; мерж подтверждён интерфейсом.
 *   Closed   — бейдж «Pull request closed». Так выглядит и PR, слитый через
 *              GitHub, и PR, закрытый без мержа; что именно — решает маркер
 *              исполнителя (`merged: true`). Без заявки о мерже карточка
 *              уходит в Rework с причиной, а цикл продолжается.
 *   Timeout  — за prWaitMs мерж не появился: пауза, решение за человеком.
 *
 * Требует совместимого шлюза Drive с CF_DISPATCH, Notion-токена с доступом
 * к источникам и GitHub-токена на чтение PR: приватный репозиторий отвечает 404.
 */

((GM_getValue, GM_setValue) => {
  "use strict";

  // ───────────────────────────── конфиг ─────────────────────────────
  const C = {
    notionV: "2025-09-03",
    // Никаких проектных ресурсов по умолчанию: их вводит владелец профиля.
    roles: "",
    missions: "",
    requests: "",
    questions: "",
    questionsUrl: "",
    questionHours: 24, // срок молчания по умолчанию: дальше действует вариант агента
    questionLineMax: 3, // сколько вопросов и ответов видно в одном промпте
    questionTextMax: 180, // столько влезает в заголовок «Вопрос» читаемо
    questionTextFull: 12000, // выше предела — явная пауза, не молчаливое усечение
    questionDefaultMax: 200,
    questionCheckMs: 600000, // как часто проверять сроки вопросов (10 минут)
    adrCheckMs: 600000, // как часто смотреть docs/decisions на proposed (10 минут)
    pageUrl: "",
    // Краткий регламент вшивается сборкой из docs/regulation-digest.md: агент получает
    // правила вместе с заданием, а страница по pageUrl остаётся справочником для деталей.
    regulationDigest: "# Регламент · краткая версия (вход для агентов)\n\nВерсия 1.5 · 2026-11-03. Вход, а не весь регламент: полная версия — страница «Регламент команды\nSynapse» в Notion (ссылка в промпте), репозиторная копия — `docs/REGULATION.md`. При расхождении\nверна полная. Этот текст уже пришёл в твоём задании: страницу регламента открывать и листать\nне нужно.\n\n## 1. Роли (D-021, имена заморожены)\n\n| Роль | Функция | Репозиторий | Делает |\n|---|---|---|---|\n| **Мастер** | Owner | — | направление, доступы, лицензии, деньги, финальные ADR; секреты вводит только он |\n| **Warden** | Reviewer | cortex | ТЗ миссий, приёмка по оракулу (accept/rework/master), ответы на вопросы и ADR |\n| **Coordinator** | Coordinator | cortex | очередь `Draft → Ready`, нарезка карточек, «Итог»; код и PR не пишет |\n| **Executor Core** | Executor | только `synapse` | карточки ядра: CLI, валидатор, рантайм, примеры, локали, шрифты |\n| **Executor Platform** | Executor | cortex | платформа мастерской, backend, сервисы; в миссиях ядра не участвует |\n| **Contract Architect** | Executor | только `synapse` | контракты и ADR ядра: `GameSpec`, манифест модуля, коды ошибок; фичи не пишет |\n| **Spec Auditor** | Auditor | cortex | независимая проверка оракула и содержания ошибок; код не правит |\n| **Locale Auditor** | Auditor | только `synapse` | глоссарий, каталоги, i18n-проверки; переводов не пишет |\n\nСтарые имена (`Executor Cortex`, `Auditor`, `Architect`) — устарели.\n\n## 2. Репозитории и доступы (D-022)\n\nРабота идёт в двух репозиториях — это разделение, а не дубль:\n\n- **`Creative36711/synapse`** — открытое ядро (MIT): конструктор игр, CLI, рантайм, локали и\n  **инструменты агентов** (Godot, Blender, хромакей). Пишут только три роли ядра.\n- **`Creative36711/synapse-cortex`** — закрытая часть: транспорт ScriptCat, платформа мастерской,\n  коммерция, документы процесса. Пишут `Warden` и `Executor Platform`, читают `Coordinator` и\n  `Spec Auditor`; роли ядра его **не видят**.\n\nДоступы:\n\n- Роли ядра видят только `synapse`; роли cortex видят оба, но пишут только в cortex.\n- Требование для роли ядра — **текстом в карточке**: ссылка на файл в cortex бесполезна,\n  ссылка на cortex внутри `synapse` — дефект (INV-1).\n- Свой репозиторий и ветка — в техблоке задания. Нужен файл, которого не видишь, — ошибка\n  карточки: пиши в отчёт, ход не останавливай.\n- Согласованность ядра и платформы проверяет только Warden: он читает оба.\n\n## 3. Инструменты уже в репозитории — ставить с нуля не нужно\n\nГотовые сборки лежат в `Creative36711/synapse`: движок не скачивают и не компилируют, работает\nв песочнице без интернета, GPU и экрана.\n\n- `tools/godot/install.sh --check` — Godot 4.7.2 (2D+3D) + SwiftShader (Vulkan на CPU, офскрин,\n  скриншоты). Ставится в `/tmp/synapse-godot`; `/tmp` не переживает сессию — повтори в начале хода.\n- `tools/godot/agent_bridge/` — управление запущенной игрой из shell и скриншоты по шагам.\n- `tools/modeling/setup_bpy.sh --check` — Blender 4.5 без экрана (`bpy`): модели, GLB, Cycles.\n- `tools/media/setup.sh --check` — хромакей `#00FF00` для ассетов.\n\nИнструкция — `AGENTS.md` в корне репозитория: читать до первой правки. Пересборка движка\n(`build_from_source.sh`) — только отдельной карточкой.\n\n## 4. Зоны и гейты\n\n| Зона | Что можно |\n|---|---|\n| Своя | править всё, что проходит гейт |\n| Чужая | только читать; правка — карточкой владельцу |\n| Оракул | только дополнять; ослаблять нельзя никому, включая Warden и Coordinator |\n\n- `synapse/**` — пишут три роли ядра. Гейт: PR в `main`, merge после зелёного оракула карточки.\n- `synapse-cortex/**` — пишут Warden и Executor Platform; Coordinator и Spec Auditor читают.\n  Гейт: PR в `main` cortex, merge после приёмки Warden.\n- `tools/script-cat/**` — защищённая зона: только отдельной карточкой/миссией, не «под проект».\n- Секреты (токены Notion/GitHub, ключ шлюза, реестр) не попадают в чат, логи, документы и Git.\n\n## 5. Цикл хода\n\n1. Warden пишет ТЗ → строка в «Миссиях». 2. Coordinator: `Draft → Ready` и выдача хода.\n3. Transport пишет лог в Drive, карточка идёт `Running → Submitted`. 4. Исполнитель завершает\nотчёт маркером `CF_AGENT_RESULT` с реальными `dispatch_id`/`run_id`; `merged: true` — только после\nфактического merge. 5. Coordinator: `Accepted` или `Rework` с причиной. 6. `next: \"done\"` —\nпередача Warden. 7. Warden: `accept` / `rework` / `master`. 8. `master` — только когда без\nМастера физически нельзя.\n\nЗелёная карточка не заменяет финальный оракул миссии. Маркер не заменяет отчёт.\n\nФормат финальной строки всегда стоит в самом конце задания — читай его там, а не по памяти.\nНе восстанавливай маркер из старых миссий, чужих баз и Drive: формат из другого проекта хуже,\nчем честное «маркер не виден». Если строки формата нет — сдай отчёт и скажи об этом.\n\n## 6. Доказательство вместо отчёта\n\n`not run`, тайм-аут, зелёный CI и мок **не равны** pass. Карточка закрывается командой, кодом\nвозврата, артефактом и SHA. Визуальный критерий — агент сам открыл PNG и описал, что видит.\n\nОракул берётся из ТЗ миссии и поля Acceptance карточки: платформенные — `npm run verify` (успех =\nкод 0 и `# fail 0`), карточки ядра — команды из ТЗ (см. §3), i18n-проверки, прогон примера.\n\n## 7. Вопросы и ADR\n\nВопрос — только полем `question` в маркере, с вариантом по умолчанию (по нему работа идёт сразу).\nНеоднозначность решай сам: минимальное изменение + строка «Допущение: …» в отчёт. Изменение\nконтракта, оракула или границ продукта — предложение `ADR:` с тремя вариантами и `default:\n«оставить как есть»`; срок и дефолт решением не являются. Опрос «можно?» — остановка хода.\n\nБез Мастера не решается: лицензии и ToS, деньги и комиссии, платные серверы, исполнение\nпользовательского кода на платформе, целевая аудитория, доступы и аккаунты.\n\n## 8. Запреты фаз 0–4\n\nНе строить платежи, каталог, загрузку пакетов, аккаунты до их фаз. Не запускать пользовательский\nкод на платформе. Не обещать авторам долю от монетизации, не ограничивать экспорт игр, не вводить\nвиртуальную валюту и комиссию с внешних транзакций. Не разворачивать платную инфраструктуру без\nлимита. Не называть ядро open source без одобренной OSI лицензии. Не создавать пустые сервисы\n«под будущие фазы».\n\n## 9. Мультиязычность (не «потом»)\n\n8 локалей: `en` (по умолчанию, юридически аутентичен), `ru`, `zh-Hans`, `ja`, `pt-BR`, `de`, `fr`,\n`ko`. Пользовательский текст — только в каталогах перевода; диагностика — код + параметры, текст\nиз каталога. Смена локали не меняет правил игры. Нативных ревьюеров нет: перевод и проверка — силами\nИИ-агентов.",
    repo: "", // для ссылки на PR из номера
    tickMs: 15000,
    mergeGraceMs: 90000, // сколько ждём мерж, прежде чем нажать кнопки за агента
    arenaResendMax: 1, // один минимальный повтор после ошибки Arena; второй отказ — пауза
    toolLimitContinueMax: 2, // продолжений после tool-call limit; дальше — пауза и Мастер
    arenaRetryMs: 180000, // ошибка старше трёх минут уже не про нашу отправку
    maxReloadAttempts: 3, // максимум автоматических перезагрузок страницы при ошибке Arena
    reloadCountPrefix: "cf-auto-error-reload-count:", // префикс ключа счётчика перезагрузок
    continueWaitMs: 20000, // после Merged ждём Continue: без неё агент не получит новую ветку
    prCardWaitMs: 8000, // карточка PR может отрисоваться позже ответа
    prWaitMs: 300000, // общий предел ожидания мержа
    maxLog: 200, // журнал хранится в ScriptCat; панель показывает хвост
    markerIdleMs: 20000, // ответ стабилен столько — считаем, что маркера не будет
    markerReminders: 2, // напоминаний до паузы: дальше решает Мастер
    minAnswerChars: 200, // маркер без отчёта — не ответ: короче — просим отчёт заново
    draftLineMax: 6, // сколько черновиков Координатор видит списком в промпте
    readyLineMax: 6, // сколько карточек Ready Координатор видит списком в промпте
    payloadInlineMax: 1500, // D-034: задание длиннее — в Drive payloads и указатель, не инлайн
    insertRetries: 3, // с какой попытки вставки в редактор звать Мастера (раньше — сами)
    composerGraceMs: 8000, // сколько ждём возврата поля ввода, если оно исчезло при перерисовке
    sendRetries: 3, // сколько тиков ждём дорисовку страницы, прежде чем звать Мастера
    sendReadyMs: 20000, // столько ждём активную кнопку Send на дорисовывающейся странице
    clickReadyMs: 8000, // столько ждём кнопку, прежде чем считать её недоступной
    pendingTtlMs: 600000, // отправка старше 10 минут не досылается: адресат её не получил
    undeliveredTtlMs: 7200000, // неотправленное задание ждёт Мастера два часа, а не десять минут
    replyWaitMs: 1800000, // 30 минут без единого сообщения — повод остановиться
    pageWaitMs: 90000, // страница адресата не отрисовалась — это «нет связи», а не молчание агента
    pageReloadMs: 20000, // столько ждём отрисовку, прежде чем перечитать страницу один раз
    observeGraceMs: 30000, // сколько смотрим на отрисованную страницу, прежде чем судить о молчании
    sendVerifyMs: 6000, // сколько ждём своё сообщение в чате после нажатия Send
    captchaGuardMs: 8000, // сколько после «отправлено» ждём капчу: она всплывает с задержкой
    stalledMs: 2700000, // 45 минут — и только для карточки, по которой ход потерян
    orphanGraceMs: 120000, // столько ждём, прежде чем вернуть в Ready карточку без хода
    longWaitNoticeMs: 600000, // раз в 10 минут напоминаем, что долгое ожидание — норма
    pollPauseCount: 3, // столько опросов подряд — уже поломка промпта, а не случайность
    reworkLimit: 3, // доработок миссии больше этого — стоп и вызов Мастера
    // D-053: повторяющаяся петля — не повод будить Мастера первым. Столько раз
    // одну карточку можно отдать арбитру (Warden); исчерпали — пауза
    // `arbiter-limit`, дальше решает человек.
    arbiterLimit: 2,
    arbiterWindowHours: 6, // окно, в котором считаются перевыдачи карточки
    arbiterAttempts: 6, // сколько последних попыток выдачи показывать арбитру
    retryWaits: [800, 2500, 6000], // выдержки перед повторами: 4 попытки, ~9 с
    linkProbeWaits: [5000, 15000], // зонды связи после обрыва: 5 и 15 с
    rolesCacheMs: 600000, // база «Роли» — настройка: кеш на 10 минут
  };

  // ───────────────────────────── профили проекта ─────────────────────────────
  // Метаданные не содержат секретов. Каждый рабочий профиль получает свой
  // префикс UUID. Старые ключи остаются нетронутыми и копируются только явно.
  const rawGet = GM_getValue;
  const rawSet = GM_setValue;
  const PROFILE_REGISTRY_KEY = "cfn-project-profiles-v1";
  const PROFILE_SESSION_KEY = "cfn-active-project-v1";
  const LEGACY_PROFILE_ID = "unconfigured";
  const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const LEGACY_PROFILE = Object.freeze({
    id: LEGACY_PROFILE_ID, name: "Проект не настроен", legacy: true, invalid: true,
    roles: "", missions: "", requests: "", questions: "", pageUrl: "", questionsUrl: "", repo: "",
    branch: "main", driveFolder: "", repos: [], roleRepos: [],
  });

  /** Один репозиторий профиля и его базовая ветка. */
  const REPO_ENTRY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  const BRANCH_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

  // Provisioning Arena-агентов: выключен по умолчанию и не содержит проектных
  // имён. Bootstrap-пробник задаётся владельцем профиля; пустой пробник не
  // отправляется. Значения ниже — аддитивные настройки старых профилей.
  const PROVISION_DEFAULTS = Object.freeze({
    agentProvisionEnabled: false,
    agentProvisionMode: "manual",
    agentProvisionRepoAllowlist: [],
    agentBootstrapPrompt: "",
    agentProvisionMaxJobs: 3,
    agentProvisionDailyMax: 5,
    agentBootstrapWaitMs: 600000,
    agentUrlWaitMs: 30000,
    agentRenameAttempts: 3,
    agentProvisionAutoActivate: true,
    agentProvisionArchiveOld: true,
  });
  const provisionInt = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
  };
  function normalizeProvisionConfig(profile = {}) {
    const allow = Array.isArray(profile.agentProvisionRepoAllowlist)
      ? [...new Set(profile.agentProvisionRepoAllowlist.map((x) => String(x || "").trim()).filter(Boolean))]
      : [];
    return {
      agentProvisionEnabled: profile.agentProvisionEnabled === true,
      agentProvisionMode: profile.agentProvisionMode === "auto" ? "auto" : "manual",
      agentProvisionRepoAllowlist: allow,
      agentBootstrapPrompt: String(profile.agentBootstrapPrompt || ""),
      agentProvisionMaxJobs: provisionInt(profile.agentProvisionMaxJobs, PROVISION_DEFAULTS.agentProvisionMaxJobs, 1, 20),
      agentProvisionDailyMax: provisionInt(profile.agentProvisionDailyMax, PROVISION_DEFAULTS.agentProvisionDailyMax, 1, 100),
      agentBootstrapWaitMs: provisionInt(profile.agentBootstrapWaitMs, PROVISION_DEFAULTS.agentBootstrapWaitMs, 1000, 3600000),
      agentUrlWaitMs: provisionInt(profile.agentUrlWaitMs, PROVISION_DEFAULTS.agentUrlWaitMs, 1000, 300000),
      agentRenameAttempts: provisionInt(profile.agentRenameAttempts, PROVISION_DEFAULTS.agentRenameAttempts, 1, 10),
      agentProvisionAutoActivate: profile.agentProvisionAutoActivate !== false,
      agentProvisionArchiveOld: profile.agentProvisionArchiveOld !== false,
    };
  }

  /**
   * Привести профиль к единой форме без смены UUID и без сброса состояния.
   * У старых профилей (без `repos`) единственный репозиторий из `repo`/`branch`
   * становится главным; у новых `repo`/`branch` всегда дублируют главную запись.
   */
  function normalizeProfile(profile) {
    if (!profile || typeof profile !== "object") return profile;
    const p = { ...profile };
    const repos = Array.isArray(p.repos) ? p.repos.slice() : [];
    if (repos.length === 0 && (p.repo || p.branch)) {
      repos.push({ repo: p.repo || "", branch: p.branch || "main", main: true });
    }
    let main = repos.find((r) => r && r.main === true);
    if (!main && repos.length) main = repos[0];
    if (main) {
      p.repo = String(main.repo || "");
      p.branch = String(main.branch || "main");
    }
    if (repos.length) p.repos = repos;
    if (!Array.isArray(p.roleRepos)) p.roleRepos = [];
    Object.assign(p, normalizeProvisionConfig(p));
    return p;
  }

  function profileMainEntry(profile = ACTIVE_PROFILE) {
    const repos = Array.isArray(profile?.repos) ? profile.repos : [];
    const main = repos.find((r) => r && r.main === true);
    return main || repos[0] || null;
  }

  function profileRepoBranch(repo, profile = ACTIVE_PROFILE) {
    const entry = (Array.isArray(profile?.repos) ? profile.repos : []).find(
      (r) => r && String(r.repo || "").toLowerCase() === String(repo || "").toLowerCase(),
    );
    return entry ? String(entry.branch || "main") : String(profile?.branch || "main");
  }

  function profileSessionRepo(roleId) {
    if (!roleId) return String(C.repo || "");
    const map = Array.isArray(C.roleRepos) ? C.roleRepos : [];
    const hit = map.find((m) => m && String(m.roleId || "").toLowerCase() === String(roleId).toLowerCase());
    return hit ? String(hit.repo || "") : String(C.repo || "");
  }

  function profileRegistry() {
    const value = rawGet(PROFILE_REGISTRY_KEY, []);
    return Array.isArray(value) ? value : [];
  }
  function validProfile(profile) {
    if (!profile || !PROJECT_UUID.test(String(profile.id || "")) ||
        !String(profile.name || "").trim() || String(profile.name).length > 80) return false;
    const ids = [profile.roles, profile.missions, profile.requests, profile.questions];
    if (ids.some((id) => !PROJECT_UUID.test(String(id || ""))) ||
        new Set(ids.map((id) => id.toLowerCase())).size !== 4) return false;
    try {
      for (const value of [profile.pageUrl, profile.questionsUrl]) {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password ||
            !["app.notion.com", "notion.so", "www.notion.so"].includes(url.hostname)) return false;
      }
    } catch { return false; }
    const p = normalizeProfile(profile);
    const repos = Array.isArray(p.repos) ? p.repos : [];
    if (!repos.length) return false;
    let mainSeen = 0;
    const repoSet = new Set();
    for (const entry of repos) {
      if (!entry || typeof entry !== "object" || !REPO_ENTRY.test(String(entry.repo || "")) ||
          String(entry.repo).includes("..") ||
          !BRANCH_ENTRY.test(String(entry.branch || "")) || String(entry.branch).includes("..") ||
          String(entry.branch).includes("//") || String(entry.branch).includes("/.") ||
          String(entry.branch).endsWith("/") || String(entry.branch).endsWith(".") ||
          String(entry.branch).endsWith(".lock"))
        return false;
      const key = String(entry.repo).toLowerCase();
      if (repoSet.has(key)) return false;
      repoSet.add(key);
      if (entry.main === true) mainSeen += 1;
    }
    if (mainSeen !== 1) return false;
    const roleRepos = Array.isArray(p.roleRepos) ? p.roleRepos : [];
    const reposLower = new Set(repos.map((r) => String(r.repo).toLowerCase()));
    for (const m of roleRepos) {
      if (!m || typeof m !== "object" || !PROJECT_UUID.test(String(m.roleId || "")) ||
          !reposLower.has(String(m.repo || "").toLowerCase())) return false;
    }
    const folder = String(p.driveFolder || "");
    if (!/^[a-z0-9][a-z0-9._-]{0,50}$/.test(folder) || folder.includes("..") ||
      ["logs", "payloads", "artifacts"].includes(folder)) return false;
    const prov = normalizeProvisionConfig(p);
    return prov.agentProvisionRepoAllowlist.every((r) => REPO_ENTRY.test(r) && !r.includes(".."));
  }
  function selectedProfileId() {
    try { return sessionStorage.getItem(PROFILE_SESSION_KEY) || LEGACY_PROFILE_ID; }
    catch {
      // Профиль вкладки неизвестен: не подменяем его рабочим Relay.
      return "session-storage-unavailable";
    }
  }
  function resolveProfile(id) {
    if (id === LEGACY_PROFILE_ID) return LEGACY_PROFILE;
    const matches = profileRegistry().filter((p) => p && p.id === id);
    if (matches.length !== 1 || !validProfile(matches[0])) {
      // Никогда не подменяем повреждённый/удалённый профиль на Relay.
      return Object.freeze({ id: String(id || "invalid"), name: "Профиль недоступен", invalid: true,
        roles: "", missions: "", requests: "", questions: "", pageUrl: "", questionsUrl: "",
        repo: "", branch: "main", driveFolder: "" });
    }
    // Копия и closure неизменяемы до полной перезагрузки вкладки.
    return Object.freeze({ ...matches[0], legacy: false, invalid: false });
  }
  const ACTIVE_PROFILE = Object.freeze(normalizeProfile(resolveProfile(selectedProfileId())));
  const projectStorageKey = (id, key) => `project:${id}:${String(key)}`;
  GM_getValue = (key, fallback) => rawGet(projectStorageKey(ACTIVE_PROFILE.id, key), fallback);
  GM_setValue = (key, value) => rawSet(projectStorageKey(ACTIVE_PROFILE.id, key), value);
  const mainEntry = profileMainEntry(ACTIVE_PROFILE);
  Object.assign(C, {
    roles: ACTIVE_PROFILE.roles, missions: ACTIVE_PROFILE.missions, requests: ACTIVE_PROFILE.requests,
    questions: ACTIVE_PROFILE.questions, pageUrl: ACTIVE_PROFILE.pageUrl, questionsUrl: ACTIVE_PROFILE.questionsUrl,
    repo: (mainEntry && mainEntry.repo) || "", branch: (mainEntry && mainEntry.branch) || "main",
    projectName: ACTIVE_PROFILE.name, driveFolder: ACTIVE_PROFILE.driveFolder,
    repos: Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : [],
    roleRepos: Array.isArray(ACTIVE_PROFILE.roleRepos) ? ACTIVE_PROFILE.roleRepos : [],
    ...normalizeProvisionConfig(ACTIVE_PROFILE),
  });
  Object.freeze(C);
  const projectApproved = () => !ACTIVE_PROFILE.invalid && !ACTIVE_PROFILE.legacy &&
    GM_getValue("cfn-project-approved", false) === true;

  const K = {
    notion: "cfn-notion-token",
    gwUrl: "cfn-gw-url",
    gwKey: "cfn-gw-key",
    auto: "cfn-auto-enabled",
    paused: "cfn-paused",
    log: "cfn-console-log",
    pending: "cfn-pending",
    expect: "cfn-expect",
    mission: "cfn-mission-id",
    merged: "cfn-merged:",
    branch: "cfn-branch",
    pause: "cfn-pause-context",
    ntfyTopic: "cfn-ntfy-topic",
    ntfyToken: "cfn-ntfy-token",
    ghToken: "cfn-github-token",
    ghAsk: "cfn-github-ask",
    lastResult: "cfn-last-result",
    errSeen: "cfn-error-seen",
    step: "cfn-step-request",
    debug: "cfn-debug",
    lastSend: "cfn-last-send",
    deadSend: "cfn-dead-send",
    qQueue: "cfn-q-queue",
    answers: "cfn-answer-queue",
    collapsed: "cfn-panel-collapsed",
    stateV: "cfn-state-v",
    rolesCache: "cfn-roles-cache",
    // Эфемерные пилоты SYN-P1: отдельный namespace, НЕ K.pending/K.expect.
    pilots: "cfn-pilots-v1",
    pilotWait: "cfn-pilot-wait:",
    pilotTranscript: "cfn-pilot-transcript:",
    // Provisioning Arena-агентов: отдельный namespace, не K.pending/K.expect.
    provision: "cfn-agent-provision-v1",
    provisionRequest: "cfn-agent-provision-request-v1",
    provisionLock: "cfn-agent-provision-lock",
  };

  // sessionStorage также разделён; выбранный ID хранится отдельно на вкладку.
  if (!ACTIVE_PROFILE.legacy) K.auto = projectStorageKey(ACTIVE_PROFILE.id, K.auto);

  const ui = {
    panel: "cfn-panel",
    log: "cfn-log",
    status: "cfn-status",
    toggle: "cfn-toggle",
    step: "cfn-step",
    setup: "cfn-setup",
    stop: "cfn-stop",
    clear: "cfn-clear",
    reset: "cfn-reset",
    questions: "cfn-questions",
    qBadge: "cfn-q-badge",
    collapse: "cfn-collapse",
    count: "cfn-log-count",
    debug: "cfn-debug-toggle",
    agents: "cfn-agents",
  };

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

  /**
   * `fetch` с таймаутом: запасной сетевой путь не имеет права висеть вечно.
   *
   * D-041 (05.11.2026): GM-путь ограничен (45 с шлюз, 15 с ntfy), а fallback
   * `fetch` без AbortController мог зависнуть навсегда. Шаг молчал, сторож
   * тишины через 120 с перезапускал его посреди выдачи: карточка уже стояла в
   * Running, а ожидание и промпт ещё не создались — Координатор получал план
   * заново при живой карточке. Таймаут делает отказ явным и ловимым: вызывающий
   * разбирает его (журнал попытки не записался — выдача продолжается), а не
   * зависает. Отметку жизни НЕ ставим: это сетевой запрос, а не честная пауза.
   */
  function fetchWithTimeout(url, opts = {}, ms = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`таймаут запроса ${Math.round(ms / 1000)} с`)), ms);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  /**
   * Довести записи до хранилища расширения ПРЕЖДЕ, чем уйти со страницы.
   *
   * D-045 (06.11.2026): `GM_setValue` в ScriptCat синхронен только наполовину.
   * Он кладёт значение в память вкладки и отправляет сообщение service worker'у,
   * который пишет его в базу уже потом, — и ничего не ждёт. `location.assign`
   * сразу за записью убивает канал, и хвост пачки теряется. На K-27 так пропали
   * `K.expect`, журнал промптов и строка журнала, а `K.pending` остался: очередь
   * без ожидания ушла в чат, и цикл встал на `delivery-state-lost` при живом
   * ответе агента.
   *
   * `GM.setValue` — та же запись, но с обещанием, которое исполняется, когда
   * хранилище подтвердило приём. Перезаписываем ключи им и ждём — но не дольше
   * `ms`: подтверждение может не прийти вовсе (у вкладки нет слушателя
   * значений), и зависнуть здесь хуже, чем уйти. Менеджер без `GM.setValue`
   * получает короткую паузу: она даёт сообщению уйти до навигации.
   *
   * Отметку жизни шага ставит `sleep`: ожидание записи — честная работа, а не
   * зависание, и сторож тишины не должен снимать блокировку посреди неё.
   */
  async function flushBeforeNavigate(keys, ms = 4000) {
    const list = [...new Set((Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === "string" && key))];
    if (!list.length) return true;
    const setter = typeof GM !== "undefined" && GM && typeof GM.setValue === "function" ? GM.setValue.bind(GM) : null;
    if (!setter) {
      await sleep(150);
      return false;
    }
    // Отсутствующий ключ не создаём: GM.setValue(key, null) записал бы null
    // там, где значения не было вовсе. Метка — строка, а не объект: менеджер
    // вправе вернуть клон значения, и сравнение по ссылке тогда соврёт.
    const absent = "__cfn-absent-key__";
    const payload = list
      .map((key) => [key, GM_getValue(key, absent)])
      .filter(([, value]) => value !== absent && value !== undefined);
    if (!payload.length) return true;
    let ok = true;
    const writes = payload.map(([key, value]) =>
      Promise.resolve().then(() => setter(key, value)).catch((e) => {
        ok = false;
        dbg("flush: запись не подтверждена", `${key}: ${String(e?.message || e)}`);
      }));
    await Promise.race([Promise.all(writes), sleep(ms).then(() => { ok = false; })]);
    if (!ok) dbg("flush: ухожу без полного подтверждения", { keys: payload.map(([key]) => key), ms });
    return ok;
  }

  /** Ключи, потеря которых при переходе ломает ход, а не только удобство. */
  const handoffKeys = () => [K.expect, K.pending, K.lastSend, K.log, "cfn-me", "cfn-nav", "cfn-prompt-journal-v1"];

  const norm = (x) => String(x || "").replace(/-/g, "").toLowerCase();
  /** Текст для сравнения: без разницы в регистре и пробелах. */
  const flat = (x) => String(x || "").replace(/[\s\u00a0]+/g, " ").trim().toLowerCase();
  const nowIso = () => new Date().toISOString();
  const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || "").join("");

  /**
   * D-069: в поле «Payload Drive File ID» Мастер вправе перечислить несколько
   * файлов — «id1, id2 (имя.md)». Скрипт читал всю строку как один id и получал
   * отказ шлюза «Некорректный Drive file ID», хотя файлы на месте. Разбираем
   * строку на id: по одному на строку, через запятую/точку с запятой, либо
   * просто несколько id подряд. Имя файла и пояснения в скобках — не id.
   */
  function driveFileIds(value) {
    const text = String(value || "");
    const tokens = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const token of tokens) {
      const clean = token.replace(/^[(\[]|[)\]]$/g, "");
      if (/^[A-Za-z0-9_-]{25,}$/.test(clean) && !out.includes(clean)) out.push(clean);
      else if (/^https?:\/\//i.test(clean)) {
        const id = clean.match(/\/d\/([A-Za-z0-9_-]{20,})/);
        if (id && !out.includes(id[1])) out.push(id[1]);
      }
    }
    return out;
  }

  /**
   * Склейка нескольких файлов задания: каждый начинается со своего заголовка,
   * чтобы агент видел, где кончается один и начинается другой. Пустой файл не
   * добавляет ни строки — «нет файла» и «файл пуст» не должны выглядеть по-разному.
   */
  function joinPayloadFiles(parts) {
    const filled = parts.filter((p) => String(p.text || "").trim());
    if (filled.length === 0) return "";
    if (filled.length === 1) return String(filled[0].text || "").trim();
    return filled.map((p, i) => `--- файл ${i + 1} из ${filled.length}: ${p.id} ---\n${String(p.text || "").trim()}`).join("\n\n");
  }

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
    (typeof GM_info !== "undefined" && GM_info?.script?.version) || "1.12.20";

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

  // ───────────────────────────── отладка ─────────────────────────────
  /**
   * Отладка в консоль браузера (F12), а не только в панель.
   *
   * Включается тремя способами: `?cfn-debug` в адресе, кнопка 🐞 в панели и
   * `__relay.debug(true)` в консоли. Состояние хранится в ScriptCat, поэтому
   * переживает переходы между страницами агентов — именно там всё и ломается.
   *
   * В консоль печатается не «шаг выполнен», а решение и его причина: какие
   * селекторы сработали, сколько элементов нашли, активна ли кнопка Send, что
   * перекрывает клик, сколько сообщений в чате до и после.
   */
  const debugOn = () => {
    try {
      if (new URL(location.href).searchParams.has("cfn-debug")) return true;
    } catch {
      /* адрес нечитаем — решает сохранённый флаг */
    }
    return GM_getValue(K.debug, false) === true;
  };

  function dbg(step, data) {
    if (!debugOn()) return;
    // Снимок можно передать функцией: в выключенном режиме он не считается.
    let payload = data;
    if (typeof data === "function") {
      try {
        payload = data();
      } catch (e) {
        payload = `снимок не удался: ${e.message}`;
      }
    }
    const line = `[Relay ${SCRIPT_VERSION}] ${step}`;
    try {
      if (payload === undefined) console.log(line);
      else console.log(line, payload);
    } catch {
      /* консоль недоступна — молча */
    }
  }

  /** Короткое описание элемента: по нему видно, что нашли, а что нет. */
  function describe(el) {
    if (!el) return "нет";
    const cls = String(el.className || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(".");
    const label = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || "";
    return `${String(el.tagName || "?").toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? `.${cls}` : ""}${label ? ` [${label}]` : ""}`;
  }

  /** Кнопка Send «как её видит скрипт»: найдена, активна, не перекрыта. */
  function debugSendButton(editor) {
    let btn = null;
    try {
      btn = editor ? sendButton(editor) : null;
    } catch {
      btn = null;
    }
    if (!btn) return { found: false };
    return {
      found: true,
      el: describe(btn),
      disabled: Boolean(btn.disabled),
      ariaDisabled: btn.getAttribute?.("aria-disabled") || "",
      covered: elementCovered(btn),
    };
  }

  /** Снимок страницы для консоли: одним объектом, без догадок. */
  function debugSnapshot() {
    const editor = composer();
    return {
      url: location.href,
      path: location.pathname,
      role: roleFromPath() || "—",
      auto: autoOn(),
      paused: GM_getValue(K.paused, "") || false,
      pending: GM_getValue(K.pending, null),
      expect: GM_getValue(K.expect, null),
      generating: generating(),
      busy: busyReason(),
      editor: {
        found: Boolean(editor),
        el: describe(editor),
        covered: editor ? elementCovered(editor) : null,
        textLength: editor ? composerText(editor).length : 0,
      },
      send: debugSendButton(editor),
      panels: completionPanels().map((panel) => ({
        el: describe(panel),
        close: describe(closeButtonIn(panel)),
      })),
      skipCard: Boolean(skipCardButton()),
      messages: messages().length,
      lastMessage: lastMessageId() || "—",
      diagnostics: composerDiagnostics(),
    };
  }

  /** `__relay` — ручной пульт в консоли браузера. */
  const debugApi = {
    version: SCRIPT_VERSION,
    debug(on = true) {
      GM_setValue(K.debug, Boolean(on));
      if (on) installDebugApi();
      console.info(`[Relay] отладка ${on ? "включена: подробные сообщения пойдут в эту консоль" : "выключена"}.`);
      return Boolean(on);
    },
    state: () => debugSnapshot(),
    composer: () => composer(),
    /** Что скрипт видит вокруг поля ввода: кандидаты, кнопки, координаты. */
    dom: () => {
      const report = domReport();
      console.info("[Relay] снимок разметки:", report);
      return report;
    },
    /** Снимок, сохранённый при последнем отказе отправки. */
    sendDebug: () => GM_getValue("cfn-send-debug", null),
    sendButton: () => debugSendButton(composer()),
    /**
     * Что скрипт видит про отправку прямо сейчас.
     *
     * Нужен, когда журнал говорит «отправлено», а глаза видят другое: в снимке
     * поле ввода, кнопка Send, ключ доставки, свои реплики с id и временем из
     * id. В консоли: `copy(JSON.stringify(__relay.send(), null, 2))`.
     */
    send: () => {
      const pending = GM_getValue(K.pending, null);
      const live = composer();
      return {
        version: SCRIPT_VERSION,
        at: new Date().toISOString(),
        composer: live
          ? {
              found: true,
              inDocument: composerAlive(live),
              length: composerText(live).length,
              head: composerText(live).slice(0, 120),
            }
          : { found: false, why: composerDiagnostics() },
        button: live ? debugSendButton(live) : null,
        pending: pending
          ? {
              role: pending.roleName || pending.roleId,
              at: pending.at,
              length: String(pending.text || "").length,
              undelivered: Boolean(pending.undelivered),
              captcha: Boolean(pending.captcha),
            }
          : null,
        key: pending ? sendKey(pending.text) || flat(pending.text).slice(0, 60) : "",
        deadSend: GM_getValue(K.deadSend, ""),
        own: userMessages().map((node) => {
          const id = String(node.id || "").replace("chat-message-", "");
          return { id, at: idTime(id) || 0, head: flat(node.textContent || "").slice(0, 80) };
        }),
        lastRefusal: GM_getValue("cfn-send-debug", null),
      };
    },
    panels: () => completionPanels().map(describe),
    /** Капча на экране: без человека цикл не пойдёт. */
    captcha: () => Boolean(captchaDialog()),
    closePanel: () => closeCompletionPlaque(),
    messages: () => messages().map((n) => ({ id: nodeId(n), head: messageText(n).slice(0, 60) })),
    /** Что скрипт считает ответом после водяного знака — с хвостом и маркером. */
    replies: () => {
      const waiting = GM_getValue(K.expect, null);
      return messagesAfter(waiting?.watermark || "").map((m) => ({
        id: m.id,
        length: m.raw.length,
        tail: tail(m.text, 220),
        marker:
          parseMarker(m.raw, "CF_COORDINATOR_RESULT") || parseMarker(m.raw, "CF_AGENT_RESULT") ||
          parseMarker(m.raw, "CF_REVIEW_RESULT") || parseMarker(m.raw, "CF_ARBITER_RESULT") || null,
      }));
    },
    resend: () => {
      const waiting = GM_getValue(K.expect, null);
      if (!waiting?.text) return "в ожидании нет текста задания";
      if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
          String(waiting.roleName || "").toLowerCase() === "warden"))
        return "Старую или нераспознанную карточку Reviewer не переотправляю: ожидание сохранено, проверьте чат и Run ID.";
      if (["review", "answer", "arbiter"].includes(waiting.kind)) {
        // Приёмка и ответы сохраняют связь с исходной миссией/вопросом.
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, sentAt: null, verified: false });
        GM_setValue(K.pending, { roleId: waiting.roleId, text: waiting.text, at: Date.now() });
        return "задание возвращено в очередь";
      }
      GM_setValue(K.expect, null);
      GM_setValue(K.pending, { roleId: waiting.roleId, text: waiting.text, at: Date.now() });
      return "задание возвращено в очередь";
    },
    step: () => tick(true),
    /** Снять очередь и ожидание прошлой попытки, не трогая журнал. */
    reset: () => resetStateDialog(),
  };
  /** Пульт появляется в консоли только когда отладка включена. */
  function installDebugApi() {
    if (!debugOn()) return;
    window.__relay = debugApi;
  }

  // Повтор одной тихой вехи подавляется на 10 минут. Не больше восьми обычных
  // тихих пушей на топик за это окно; тихая остановка не теряется из-за лимита.
  // История лежит в ScriptCat, поэтому действует и после перехода страницы.
  const NTFY_QUIET_WINDOW_MS = 10 * 60_000;
  const NTFY_QUIET_LIMIT = 8;
  function allowQuietNtfy(topic, key, essential = false, now = Date.now()) {
    const saved = GM_getValue("cfn-ntfy-recent", []);
    const recent = (Array.isArray(saved) ? saved : []).filter((item) =>
      item && typeof item.key === "string" && Number.isFinite(Number(item.at)) &&
      Number(item.at) <= now && now - Number(item.at) < NTFY_QUIET_WINDOW_MS,
    );
    const eventKey = `${topic}:${String(key).slice(0, 350)}`;
    if (recent.some((item) => item.key === eventKey)) return false;
    if (!essential && recent.filter((item) => item.topic === topic && !item.essential).length >= NTFY_QUIET_LIMIT) {
      return false;
    }
    GM_setValue("cfn-ntfy-recent", [...recent, { topic, key: eventKey, at: now, essential }].slice(-100));
    return true;
  }

  function notifyNtfy(text, { title = "Relay", priority = "2", tags = "memo", cycleStopped = false, key = "" } = {}) {
    try {
      if (typeof C !== "undefined" && C.projectName && C.projectName !== "Relay")
        title = String(title).replace(/^Relay(?=[:\s]|$)/, C.projectName);
      const topic = normalizeNtfyTopic(GM_getValue(K.ntfyTopic, ""));
      if (!topic) return;
      // Последняя защита: даже ошибочно помеченная «громкой» запись не звонит,
      // пока автоцикл действительно идёт и пауза не поставлена.
      const stopped = cycleStopped && (isPaused() || !autoOn());
      if (Number(priority) >= 4 && !stopped) {
        priority = "2";
        tags = "memo";
      }
      if (Number(priority) < 4 && !allowQuietNtfy(topic, key || `${title}:${text}`, stopped)) return;
      ntfyPublish(topic, GM_getValue(K.ntfyToken, ""), { message: text, title, priority, tags }).catch((e) => {
        console.warn("[Relay ntfy]", e.message);
        try {
          log(`ntfy: пуш не ушёл — ${e.message}`, true, { skip: true });
        } catch (logError) {
          console.warn("[Relay ntfy] не удалось записать ошибку:", logError);
        }
      });
    } catch (e) {
      // Уведомление не должно остановить живую выдачу, даже если хранилище
      // ScriptCat недоступно. В таком случае диагностика остаётся в консоли.
      console.warn("[Relay ntfy] уведомление пропущено:", e);
    }
  }

  /** Гудок в браузере: страховка, если ntfy не настроен или телефон молчит. */
  let alertCtx = null;
  function playAlert() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = alertCtx || (alertCtx = new Ctx());
      const play = () => {
        const start = ctx.currentTime + 0.03;
        [880, 660, 880].forEach((frequency, index) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const at = start + index * 0.22;
          osc.type = "sine";
          osc.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, at);
          gain.gain.exponentialRampToValueAtTime(0.16, at + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(at);
          osc.stop(at + 0.18);
        });
      };
      if (ctx.state === "suspended") ctx.resume().then(play).catch(() => {});
      else play();
    } catch (e) {
      console.warn("[Relay alert]", e);
    }
  }

  // ───────────────────────────── пауза ─────────────────────────────
  const isPaused = () => Boolean(GM_getValue(K.paused, ""));

  /**
   * Автоцикл — состояние ОКНА, а не хранилища скрипта.
   *
   * Хранилище ScriptCat переживает браузер: включённый однажды автоцикл
   * подхватывал процесс при следующем открытии страницы, без единого нажатия.
   * Теперь флаг лежит в `sessionStorage`: переживает переходы между страницами
   * агентов в той же вкладке, но исчезает вместе с браузером. Новый запуск
   * всегда начинается с ручного «Включить».
   */
  let autoMem = false;
  function autoOn() {
    try {
      return sessionStorage.getItem(K.auto) === "1";
    } catch {
      return autoMem;
    }
  }
  function autoSet(on) {
    autoMem = Boolean(on);
    try {
      if (on) sessionStorage.setItem(K.auto, "1");
      else sessionStorage.removeItem(K.auto);
    } catch {
      // Приватный режим или запрет storage: остаётся память вкладки.
    }
  }

  /** Старое значение в хранилище скрипта снимаем: оно больше не управляет циклом. */
  function autoForgetPersisted() {
    const stale = GM_getValue(K.auto, false);
    GM_setValue(K.auto, false);
    if (stale) {
      log(
        "Автоцикл прошлой сессии снят: он включается только вручную, кнопкой «Включить».",
        false,
        { skip: true },
      );
    }
  }

  /**
   * Единственная точка остановки. Любая ошибка на экране, таймаут или
   * невыданный маркер приводят сюда: цикл замирает, статус краснеет, уходит
   * громкий пуш, а продолжает только Мастер — кнопкой «Продолжить».
   */
  function pause(reason, context = {}) {
    const info = {
      kind: context.kind || "error",
      reason: String(reason),
      at: Date.now(),
      ref: context.ref || "",
      runId: context.runId || "",
      turnId: context.turnId || "",
      tries: context.tries ?? null,
      wasAuto: autoOn(),
    };
    GM_setValue(K.paused, info.reason);
    GM_setValue(K.pause, info);
    log(`ПАУЗА: ${info.reason}`, true, { skip: true });
    // Тихая пауза — для остановок, которые Мастер не разбирает: вопрос ушёл
    // приёмке, миссию закрыли в обход неё, приёмка сама решает по существу.
    // С 1.4.80 такие события не повод звонить в телефон: их закрывает приёмка,
    // а Мастер нужен только там, где без него физически нельзя (нет роли,
    // нет прав, предел доработок).
    if (context.quiet) {
      notifyNtfy(`Цикл остановлен: ${info.reason}`, {
        title: context.notifyTitle || "Relay: пауза",
        priority: "2",
        tags: "memo",
        cycleStopped: true,
        key: `pause:${info.kind}:${info.ref}:${info.runId}:${info.turnId}:${info.reason}`,
      });
      setStatus();
      return;
    }
    notifyNtfy(`Цикл остановлен и ждёт Мастера: ${info.reason}`, {
      title: context.notifyTitle || "Relay: пауза",
      priority: "5",
      tags: "warning,rotating_light",
      cycleStopped: true,
    });
    playAlert();
    setStatus();
  }

  /**
   * Передача потерялась: очередь и ожидание маркера относятся к ходу, которого
   * уже нет. Снимаем оба и ставим паузу, чтобы Мастер увидел причину, а не
   * бесконечное «жду ответа».
   */
  function dropHandoff(reason) {
    GM_setValue(K.pending, null);
    GM_setValue(K.expect, null);
    pause(reason, { kind: "no-reply" });
  }

  /**
   * Ход не дошёл до исполнителя — карточка не имеет права оставаться Running.
   *
   * «Running», «Started At» и «Run ID» ставит выдача (`dispatchTask`), и ставит
   * до отправки: иначе Координатор успел бы выдать ту же карточку второй раз.
   * Но «выдана» и «дошла» — разные вещи. Пока сообщения в чате нет, работы по
   * карточке тоже нет, а в Running она ждала бы `releaseStalled` — 45 минут
   * впустую, и всё это время человек видит Running там, где ничего не начато.
   * Вопрос Мастера (53) был ровно про это.
   *
   * Возвращаем Ready и снимаем Run ID со Started At. Своего «Submitted At» и PR
   * у такой карточки нет, поэтому повторная выдача не запрещена.
   */
  function rollbackProps(card, runId) {
    const props = card && card.properties;
    if (!props) return null;
    if (props["Dispatch State"]?.select?.name !== "Running") return null;
    if (props["Submitted At"]?.date?.start || props["PR"]?.url) return null;
    const onCard = rt(props["Run ID"]);
    if (runId && onCard && norm(onCard) !== norm(runId)) return null;
    return {
      "Dispatch State": { select: { name: "Ready" } },
      "Started At": { date: null },
      "Run ID": { rich_text: [] },
    };
  }

  /**
   * Признаки прошлого ответа на карточке: дата, ссылка на PR и номер прогона.
   *
   * Поля эти ставит транспорт, поэтому снимает их тоже он, а не Координатор
   * через коннектор: 25.10 коннектор отвечал `validation_error` на очистку, и
   * карточка запиралась (NAR-2.3).
   */
  const answeredMarks = (card) => {
    const props = (card && card.properties) || {};
    return {
      "Submitted At": Boolean(props["Submitted At"]?.date?.start),
      "PR": Boolean(props["PR"]?.url),
      "Run ID": Boolean(rt(props["Run ID"])),
    };
  };
  const answeredCard = (card) => Object.values(answeredMarks(card)).some(Boolean);

  /**
   * Доказательство явного возврата в Rework для карточек с Check=fail.
   *
   * Отметка ставится только по снимку очереди, поэтому краткий переход
   * Rework→Ready между опросами может быть пропущен. В таком случае выдача
   * безопасно откажет и вернёт Coordinator техническую инструкцию оставить
   * карточку в Rework до следующего наблюдаемого опроса — без общей паузы на
   * первой попытке и без очистки Submitted At / PR / Run ID.
   */
  const reworkKey = (id) => `cfn-rework:${id}`;
  const reworkSeen = (id) =>
    Boolean(id) && typeof GM_getValue === "function" && Number(GM_getValue(reworkKey(id), 0)) > 0;

  function rememberRework(cards) {
    if (typeof GM_setValue !== "function") return;
    for (const card of cards || []) if (card && card.id) GM_setValue(reworkKey(card.id), Date.now());
  }

  /**
   * Отметка «вот в таком виде страницу оставил ответ».
   *
   * «Submitted At» пишет браузер, «last_edited_time» — Notion: часы у них
   * разные, сравнивать эти два времени напрямую нельзя. Поэтому запоминаем
   * ровно то время, которое Notion вернул на записи ответа: любая правка после
   * него — чужая, то есть карточку трогали уже после вердикта.
   */
  const answerStampKey = (id) => `cfn-answer-stamp:${id}`;
  function rememberAnswerStamp(id, page) {
    const at = page && page.last_edited_time;
    if (id && at && typeof GM_setValue === "function") GM_setValue(answerStampKey(id), String(at));
  }
  function editedSinceAnswer(card) {
    const stamp = card && card.id && GM_getValue(answerStampKey(card.id), "");
    if (!stamp || !card.last_edited_time) return false;
    return String(card.last_edited_time) !== String(stamp);
  }

  /**
   * Почему карточка снова идёт в работу — для журнала.
   *
   * Ни один из этих признаков не обязателен: право на повторную выдачу даёт
   * указание Координатора (см. `redispatchClearProps`). Признаки нужны, чтобы
   * Мастер видел причину, а не догадывался по логу Notion.
   */
  function redispatchWhy(card) {
    if (reworkSeen(card && card.id)) return "её видели в Rework";
    if (card?.properties?.["Check"]?.select?.name === "fail") return "проверка ответа не прошла (Check=fail)";
    if (editedSinceAnswer(card)) return "карточку правили после ответа";
    return "Координатор направил её в работу снова";
  }

  /**
   * Что снять с карточки, которую Координатор снова направил в работу.
   *
   * Ход в Ready направляет только Координатор — транспорт сам из Ready ничего
   * не берёт. Поэтому если он назвал эту карточку, значит работа нужна заново,
   * и следы прошлого ответа снимаются: без этого выдача отказывала и цикл
   * вставал (NAR-4.9, 27.10).
   *
   * Осторожность сохранена там, где она нужна: если у роли в Ready есть и
   * свежая карточка, и отвеченная, берётся свежая (см. `pickReadyForRole`), —
   * повторная работа не подменяет новую.
   *
   * Чистка идёт одной записью: «Submitted At» (date), «PR» (url) и «Run ID»
   * (rich_text) снимаются пустыми значениями Notion — `null` и `[]`.
   */
  function redispatchClearProps(card) {
    const props = card && card.properties;
    if (!props) return null;
    if (props["Dispatch State"]?.select?.name !== "Ready") return null;
    // A failed check is not, by itself, authorization to erase the prior Run.
    // Only an observed Rework→Ready transition permits the clean redispatch path.
    if (props["Check"]?.select?.name === "fail" && !reworkSeen(card.id)) return null;
    if (!answeredCard(card)) return null;
    return {
      "Submitted At": { date: null },
      "PR": { url: null },
      "Run ID": { rich_text: [] },
    };
  }

  /**
   * Карточка этой роли из Ready: свежая вперёд.
   *
   * Отвеченная карточка — это Rework, а не новая работа. Если Координатор
   * направил ход роли, а у неё в Ready лежат обе, выдавать надо ту, которую ещё
   * не отвечали: иначе повторная работа подменит новую и Мастер получит две
   * копии одного задания.
   */
  function pickReadyForRole(ready, roleName) {
    const mine = (ready || []).filter((t) => norm(taskRole(t)) === norm(roleName));
    if (!mine.length) return null;
    return mine.find((t) => !answeredCard(t)) || mine[0];
  }

  /**
   * Счётчик повторных выдач одной карточки.
   *
   * Одна повторная выдача — нормальный Rework. Третья подряд за шесть часов —
   * это уже зацикливание: Координатор и исполнитель гоняют одну и ту же работу
   * и не замечают этого. Такую петлю показываем Мастеру, а счётчик обнуляем,
   * чтобы «Продолжить» действительно продолжало, а не упиралось в тот же
   * порог.
   */
  const redispatchKey = (id) => `cfn-redispatch:${id}`;
  const REDISPATCH_WINDOW = 6 * 3600 * 1000;
  const REDISPATCH_LIMIT = 3;
  function noteRedispatch(id) {
    const now = Date.now();
    const kept = (GM_getValue(redispatchKey(id), []) || []).map(Number).filter((at) => now - at < REDISPATCH_WINDOW);
    kept.push(now);
    GM_setValue(redispatchKey(id), kept);
    return kept.length;
  }

  /**
   * Вернуть карточку в Ready, если ход так и не ушёл.
   *
   * true — карточка действительно переписана; вызывающий по этому признаку
   * решает, снимать ли очередь и ожидание. Ошибка Notion ход не съедает: всё
   * остаётся как было, и работает прежнее правило 45 минут.
   */
  async function releaseUndelivered(expect, why, { cause = "undelivered" } = {}) {
    if (!expect || expect.kind !== "dispatch" || !expect.ref) return false;
    let card;
    try {
      card = await notion("GET", `pages/${expect.ref}`);
    } catch (e) {
      log(`Карточку «${expect.ref}» не прочитать — статус не снимаю: ${e.message}`, true);
      return false;
    }
    const runId = rt(card.properties["Run ID"]);
    // Сверяем с выдачей, которая не ушла: если карточку уже перевыдали с другим
    // Run ID, откат снял бы чужой, живой ход.
    const props = rollbackProps(card, expect.runId || runId);
    if (!props) return false;
    try {
      await patch(card.id, props);
    } catch (e) {
      log(`«${taskTitle(card)}» осталась в Running: статус не снялся (${e.message}).`, true);
      return false;
    }
    const logId = rt(card.properties["Output Drive File ID"]);
    if (logId) {
      try {
        await gateway("append", logId, {
          marker: `<!-- CF_DISPATCH ${card.id}:${runId}:${cause} -->`,
          entry:
            `\n\n<!-- CF_DISPATCH ${card.id}:${runId}:${cause} -->\n## ` +
            `${cause === "manual-reset" ? "Ход снят Мастером" : "Ход не дошёл до исполнителя"}\n\n` +
            `${why}\n\nКарточка возвращена в Ready, «Started At» и «Run ID» сняты: работы по ней не было.\n`,
        });
      } catch (e) {
        log(`Отметка о неудачной отправке не записалась в журнал: ${e.message}`, true);
      }
    }
    log(
      `«${taskTitle(card)}» возвращена в Ready: ${why}.` +
        (cause === "manual-reset" ? "" : " В Running она бы ждала 45 минут."),
      true,
      { ntfy: "quiet", title: "Relay: карточка возвращена в Ready" },
    );
    return true;
  }

  function resume(reason = "проверено Мастером") {
    const before = GM_getValue(K.paused, "");
    if (!before) return;
    const paused = GM_getValue(K.pause, null);
    GM_setValue(K.paused, "");
    GM_setValue(K.pause, null);
    // Пауза из-за «Something went wrong»: сообщение не приняли, и ожидание
    // ответа — фикция. «Продолжить» — это и есть просьба отправить заново,
    // поэтому окно свежести ошибки (`arenaRetryMs`) считается от нажатия, а в
    // очередь кладётся минимальное сообщение «прочитай карточку сам». Старая
    // отметка «эту ошибку уже видели» снимается: иначе новый код её не тронет.
    if (paused && paused.kind === "arena-error") {
      GM_setValue(K.errSeen, "");
      const waiting = GM_getValue(K.expect, null);
      if (waiting && waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
          String(waiting.roleName || "").toLowerCase() === "warden")) {
        pause("Ошибка Arena на старой или нераспознанной карточке Reviewer: не повторяю выдачу и сохраняю ожидание. Проверьте чат и Run ID.",
          { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
        return;
      }
      if (waiting) {
        GM_setValue(K.expect, {
          ...waiting,
          sentAt: Date.now(),
          verified: false,
          arenaResend: 0,
        });
        retryRejectedHandoff(
          GM_getValue(K.expect, null),
          { messageId: paused.ref || "" },
          "Пауза была из-за ошибки Arena",
        );
      } else {
        log("Пауза была из-за ошибки Arena, а ожидания уже нет: нажмите «Шаг», чтобы начать ход заново.", true);
      }
    }
    // Новый бюджет напоминаний: Мастер уже посмотрел, почему агент молчал.
    const expect = GM_getValue(K.expect, null);
    if (expect) {
      // «Продолжить» возвращает право и на автоматический повтор после ошибки
      // Arena (`arenaResend`), и на напоминания: Мастер уже увидел ошибку и ждёт,
      // что задание уйдёт само.
      GM_setValue(K.expect, {
        ...expect,
        tries: 0,
        autoResend: 0,
        arenaResend: 0,
        lastReplySig: "",
        lastReplyAt: 0,
      });
    }
    log(`Пауза снята Мастером (${reason}). Продолжаю.`, false, { ntfy: "quiet" });
    if (GM_getValue(K.pending, null)) {
      // D-045: при потерянном ожидании сообщение уже могло уйти. Обещать
      // повторную отправку нельзя — сначала сверка карточки и чата. Так же и
      // после обновления скрипта: очередь без ожидания разбирает сверка.
      log(
        (paused && paused.kind === "delivery-state-lost") || !expect
          ? "Задание в очереди, но сообщение могло уже уйти: сначала сверю чат и карточку и только потом решу, нужна ли отправка."
          : "Задание уже в очереди — отправляю его заново, новый ход Координатора не нужен.",
        false,
        { ntfy: "quiet" },
      );
    }
  }

  /**
   * Проверка после капчи: задание действительно дошло до агента?
   *
   * 24.10 (13:47) отправка была засчитана в 13:47:03, окно проверки всплыло в
   * 13:47:15. Мастер решил капчу и нажал «Продолжить» — а скрипт, у которого
   * очередь уже была снята, честно ждал ответа на сообщение, которого агент не
   * получал: тридцать минут впустую и карточка в Running.
   *
   * Признак настоящей доставки — поздний: агент начал ход. Если после отметки
   * нет ни одного его сообщения и он не работает, ход потерян.
   */
  async function verifyAfterCaptcha(ctx) {
    if (!ctx || ctx.kind !== "captcha") return false;
    const expect = GM_getValue(K.expect, null);
    if (!expect || !expect.sentAt) return false;
    // Агенту нужно время, чтобы начать: сразу после «Продолжить» он молчит и
    // при доставленном задании.
    for (let i = 0; i < 3; i += 1) {
      await sleep(1500);
      if (stillWorking() || generating()) return false;
    }
    if (messagesAfter(expect.watermark || "").length) return false;
    const isDispatch = expect.kind === "dispatch" && Boolean(expect.ref);
    const rolled = isDispatch ? await releaseUndelivered(expect, "капча не пропустила задание") : true;
    GM_setValue(K.expect, null);
    GM_setValue(K.pending, null);
    if (!rolled) {
      log("Задание до агента не дошло: капча закрыла отправку, а карточку вернуть в Ready не удалось. Статус оставлен как есть.", true);
      return false;
    }
    log(
      isDispatch
        ? "Задание до агента не дошло: капча закрыла отправку, ответа нет. Карточка возвращена в Ready — выдаю заново."
        : "Ход Координатора до агента не дошёл: капча закрыла отправку. Запрошу план заново.",
      true,
      { ntfy: "quiet", title: "Relay: задание не дошло, выдаю заново" },
    );
    return true;
  }

  function roleFromPath() {
    const id = (location.pathname.match(/\/agent\/([\w-]+)/) || [])[1];
    return id || "";
  }

  function setStatus(extra) {
    const el = document.getElementById(ui.status);
    if (!el) return;
    const auto = autoOn();
    const paused = GM_getValue(K.paused, "");
    const me = GM_getValue("cfn-me", "");
    const short = paused.length > 70 ? `${paused.slice(0, 70)}…` : paused;
    const text = extra || (paused ? `Пауза: ${short}` : auto ? "Работает" : "Выключен");
    el.textContent = me ? `${text} · ${me}` : text;
    el.title = paused || text;
    el.style.color = paused ? "#ff9a9a" : auto ? "#8ee28e" : "inherit";
    const toggle = document.getElementById(ui.toggle);
    if (toggle) {
      toggle.textContent = paused ? "▶ Продолжить" : auto ? "⏸ Стоп" : "▶ Включить";
      toggle.style.background = paused ? "#3a3320" : auto ? "#3a2a2a" : "#24402a";
      toggle.style.borderColor = paused ? "#6b5a2a" : auto ? "#6b3a3a" : "#3f6b45";
    }
  }

  const paintDebugButton = () => {
    const el = document.getElementById(ui.debug);
    if (!el) return;
    const on = debugOn();
    el.style.background = on ? "#2c4a6b" : "#242833";
    el.style.borderColor = on ? "#4a7ba7" : "#343a46";
    el.title = on ? "Отладка включена: подробности в консоли браузера" : "Отладка в консоли браузера (F12)";
  };

  /**
   * Свёрнутая панель.
   *
   * 28.10 Мастер попросил свернуть окно приложения: панель занимает угол
   * страницы агента и мешает читать чат. Свёрнутое состояние — только полоса с
   * названием, статусом и кнопкой «Стоп»: журнал и остальные кнопки скрыты, но
   * счётчики вопросов и решений остаются на самой кнопке, чтобы свёрнутое окно
   * не прятало работу, которая ждёт человека. Состояние помнится в ScriptCat и
   * переживает перезагрузку страницы.
   */
  const panelCollapsed = () => GM_getValue(K.collapsed, false) === true;

  function paintPanelChrome() {
    const panel = document.getElementById(ui.panel);
    if (!panel) return;
    const collapsed = panelCollapsed();
    panel.classList.toggle("cfn-panel-collapsed", collapsed);
    panel.style.width = collapsed ? "208px" : "360px";
    const log = document.getElementById(ui.log);
    if (log) log.style.display = collapsed ? "none" : "";
    for (const id of [ui.step, ui.questions, ui.debug, ui.reset, ui.clear, ui.setup]) {
      const el = document.getElementById(id);
      if (el) el.style.display = collapsed ? "none" : "";
    }
    const status = document.getElementById(ui.status);
    if (status) status.style.maxWidth = collapsed ? "120px" : "190px";
    const button = document.getElementById(ui.collapse);
    if (!button) return;
    const count = (id) => Number(document.getElementById(id)?.textContent || 0) || 0;
    const openQ = count(ui.qBadge);
    const marks = openQ ? ` 💬${openQ}` : "";
    button.textContent = collapsed ? `▸${marks}` : "▾";
    button.title = collapsed
      ? `Развернуть панель${openQ ? ` (открытых записей обратной связи: ${openQ})` : ""}`
      : "Свернуть панель";
    button.style.background = collapsed ? "#2c3a2f" : "#242833";
  }

  function togglePanel() {
    GM_setValue(K.collapsed, !panelCollapsed());
    paintPanelChrome();
  }

  function mount() {
    if (document.getElementById(ui.panel)) return;
    const panel = document.createElement("div");
    panel.id = ui.panel;
    panel.style.cssText = [
      "position:fixed", "right:14px", "bottom:14px", "z-index:2147483000",
      "width:360px", "background:#15171c", "color:#e7eaee", "border:1px solid #2b2f38",
      "border-radius:10px", "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace",
      "box-shadow:0 10px 30px rgba(0,0,0,.45)", "overflow:hidden",
    ].join(";");
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1b1e25;border-bottom:1px solid #2b2f38;flex-wrap:wrap">
        <strong id="cfn-panel-project" style="font-size:12px">Relay</strong>
        <span style="opacity:.45;font-size:10px" title="версия скрипта">v${SCRIPT_VERSION}</span>
        <span id="${ui.status}" style="opacity:.75;font-size:11px;max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">…</span>
        <span id="${ui.count}" style="opacity:.45;font-size:10px">0/${C.maxLog}</span>
        <span style="flex:1"></span>
        <button id="${ui.step}" title="Один шаг цикла" style="${btnStyle()}">Шаг</button>
        <button id="${ui.toggle}" style="${btnStyle()}">▶ Включить</button>
        <button id="${ui.questions}" aria-label="Открыть обратную связь в Notion" title="Обратная связь — вопросы и предложения в Notion" style="${btnStyle()}">💬 Обратная связь<span id="${ui.qBadge}" style="display:none;margin-left:3px;padding:0 4px;border-radius:7px;background:#b23b3b;color:#fff;font-size:10px;line-height:14px;vertical-align:middle">0</span></button>
        <button id="${ui.agents}" title="Provisioning Arena-агентов: создание и замена ролей" style="${btnStyle()}">🤖 Агенты</button>
        <button id="${ui.debug}" title="Отладка в консоли браузера (F12)" style="${btnStyle()}">🐞</button>
        <button id="${ui.reset}" title="Снять ход: очередь, ожидание и карточки в Running без хода (журнал и настройки останутся)" style="${btnStyle()}">↺</button>
        <button id="${ui.clear}" title="Очистить журнал; очередь снимается кнопкой ↺" style="${btnStyle()}">🧹</button>
        <button id="${ui.setup}" title="Notion, Google Drive, GitHub и уведомления" style="${btnStyle()}">⚙ Подключения</button>
        <button id="${ui.stop}" title="Остановить цикл и снять паузу" style="${btnStyle()}">✕</button>
        <button id="${ui.collapse}" title="Свернуть панель" style="${btnStyle()}">▾</button>
      </div>
      <div id="${ui.log}" style="max-height:200px;overflow:auto;padding:6px 10px"></div>`;
    document.body.appendChild(panel);

    document.getElementById(ui.collapse).onclick = () => togglePanel();

    document.getElementById(ui.setup).onclick = () => setup(true);
    document.getElementById(ui.reset).onclick = () => {
      // Сброс теперь ходит в Notion: без перехвата отказ сети остался бы
      // необработанным обещанием и молчаливой кнопкой.
      const work = resetStateDialog();
      (typeof trackProjectTask === "function" ? trackProjectTask(work) : work)
        .catch((e) => log(`Сброс не удался: ${e.message}`, true));
    };
    document.getElementById(ui.clear).onclick = () => clearLog();
    document.getElementById(ui.debug).onclick = () => {
      const on = !debugOn();
      GM_setValue(K.debug, on);
      debugApi.debug(on);
      installDebugApi();
      log(
        on
          ? "Отладка включена: подробности идут в консоль браузера (F12), панель — только вехи. Команды: __relay.state(), __relay.step()."
          : "Отладка выключена.",
      );
      paintDebugButton();
    };
    document.getElementById(ui.questions).onclick = () => window.open(C.questionsUrl, "_blank", "noopener");
    const agentsButton = document.getElementById(ui.agents);
    if (agentsButton) agentsButton.onclick = () => {
      if (typeof provisionOpenDialog === "function") provisionOpenDialog();
    };
    document.getElementById(ui.stop).onclick = () => {
      GM_setValue(K.paused, "");
      GM_setValue(K.pause, null);
      autoSet(false);
      log("Автоцикл остановлен вручную.");
    };
    document.getElementById(ui.step).onclick = () => {
      if (typeof projectApproved === "function" && !projectApproved()) {
        log("Проект ещё не разрешён к работе: проверьте его в управлении проектами.", true); return;
      }
      const reason = GM_getValue(K.paused, "");
      if (reason && !confirm(`Снять паузу и выполнить один шаг?\n\n${reason}`)) return;
      if (reason) resume("ручной шаг");
      if (typeof releaseProjectHold === "function" && !releaseProjectHold()) {
        log("Вкладка не может сохранить выбор проекта; ручной шаг не запущен.", true); return;
      }
      log("Шаг нажат: смотрю страницу, очередь и задание.");
      tick(true);
    };
    document.getElementById(ui.toggle).onclick = () => {
      const work = toggleAuto();
      return typeof trackProjectTask === "function" ? trackProjectTask(work) : work;
    };
    const projectLabel = document.getElementById("cfn-panel-project");
    if (projectLabel) projectLabel.textContent = C.projectName || "Relay";
    renderLog();
    setStatus();
    paintDebugButton();
    paintPanelChrome();
    paintQuestions(openQuestions().rows);
    watchQuestions();
    // ADR без записи всё ещё обнаруживается в фоне и попадает в ту же базу.
    watchDecisions();
    maybeGhDialog();
  }

  async function toggleAuto() {
    if (typeof projectApproved === "function" && !projectApproved()) {
      log("Проект не разрешён к работе: откройте «Подключения → Управление проектами» и проверьте его.", true); return;
    }
    const auto = autoOn();
    const reason = GM_getValue(K.paused, "");

    // Пауза. Снять её может только человек: подтверждение показывает причину.
    if (reason) {
      if (!confirm(`Цикл стоит на паузе.\n\nПричина: ${reason}\n\nСнять паузу и продолжить?`)) return;
      if (typeof releaseProjectHold === "function" && !releaseProjectHold()) return;
      const ctx = GM_getValue(K.pause, null) || {};
      // Возвращаем тот режим, в котором цикл стоял: пауза не должна
      // превращать ручной шаг в постоянный автоцикл.
      autoSet(ctx.wasAuto === true);
      resume("кнопка «Продолжить»");
      // Капча могла всплыть уже после того, как скрипт записал «отправлено»:
      // тогда без этой проверки «Продолжить» ждёт ответа на неотправленное.
      await verifyAfterCaptcha(ctx);
      tick(true);
      return;
    }

    if (auto) {
      autoSet(false);
      log("Автоцикл выключен.");
      return;
    }

    if (typeof releaseProjectHold === "function" && !releaseProjectHold()) return;
    autoSet(true);
    log("Автоцикл включён.");
    // Обычный тик, а не «Шаг»: в автоцикле нет нажатия, и следующая страница
    // открывается сама, если работы нет на текущей.
    tick(false);
  }

  function btnStyle() {
    return "background:#242833;color:#e7eaee;border:1px solid #343a46;border-radius:6px;padding:2px 6px;cursor:pointer;font:11px/1.2 inherit";
  }

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

  // ───────────────────────────── GitHub ─────────────────────────────
  function githubDialog() {
    connectionDialog({ focusGithub: true });
  }

  /** Один раз после ложного отказа сами показываем, где взять токен. */
  function maybeGhDialog() {
    if (!GM_getValue(K.ghAsk, 0)) return;
    GM_setValue(K.ghAsk, 0);
    setTimeout(() => githubDialog(), 400);
  }

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

  function requestOnce(method, url, headers, body, timeout = 45000, opts = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url,
        headers,
        // Строка уходит как есть: шлюз Apps Script читает `postData.contents`
        // и ждёт там JSON-текст, а не JSON-строку в кавычках.
        data: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        timeout,
        ...(opts.anonymous === true ? { anonymous: true, withCredentials: false } : {}),
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
        return await requestOnce(method, url, headers, body, 45000, opts);
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
          ping.project?.name !== ACTIVE_PROFILE.driveFolder || ping.artifacts?.name !== "artifacts") {
        const error = new Error("Шлюз не подтвердил этот проект, папку и artifacts: нужен проектный шлюз 1.8.");
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
        // D-041: запасной путь с таймаутом как у GM (45 с). Без него fetch висел
        // вечно, шаг молчал, и сторож перезапускал выдачу посреди Running.
        const res = await fetchWithTimeout(url, { method: "POST", headers, body: payload }, 45000);
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

  // ───────────────────────────── Notion ─────────────────────────────
  // Notion возвращает не больше 100 строк за раз. Неполная очередь опаснее
  // ошибки: она могла скрыть открытые карточки или часть принятых от приёмки.
  // Не возвращаем частичный результат при ошибке или сломанном курсоре.
  const query = async (ds, filter, sorts) => {
    const rows = [];
    const cursors = new Set();
    let cursor = "";
    while (true) {
      const page = await notion("POST", `data_sources/${ds}/query`, {
        page_size: 100,
        ...(filter ? { filter } : {}),
        ...(sorts ? { sorts } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      if (!page || !Array.isArray(page.results) || typeof page.has_more !== "boolean")
        throw new Error("Notion вернул неполную страницу запроса.");
      rows.push(...page.results);
      if (!page.has_more) return rows;
      const next = String(page.next_cursor || "");
      if (!next || cursors.has(next)) throw new Error("Notion не вернул новый курсор запроса.");
      cursors.add(next);
      cursor = next;
    }
  };

  const patch = (pageId, properties) => notion("PATCH", `pages/${pageId}`, { properties });

  /** id агента выводится из ссылки: отдельное поле в Notion не нужно. */
  function agentIdFromUrl(url) {
    const m = String(url || "").match(/\/agent\/([\w-]+)/);
    return m ? m[1] : "";
  }

  /** Строка базы «Роли» в том виде, в каком её видит остальной скрипт. */
  const mapRoleRow = (p) => {
    const url = p.properties["Agent URL"]?.url || "";
    return {
      id: agentIdFromUrl(url),
      name: rt(p.properties["Роль"]),
      url,
      fn: sel(p.properties["Функция"]),
      status: sel(p.properties["Статус"]),
      zone: rt(p.properties["Зона записи"]),
      gate: rt(p.properties["Гейт"]),
      repo: rt(p.properties["Репозиторий"]),
      pageId: p.id,
      // Аддитивные поля provisioning. Старые строки без них читаются как
      // «не админ» и «не требуется»; старые поля не переименовываются.
      agentAdmin: p.properties["Agent Admin"]?.checkbox === true,
      agentState: sel(p.properties["Agent State"]) || "не требуется",
      agentJobId: rt(p.properties["Agent Job ID"]),
      agentCreatedAt: p.properties["Agent Created At"]?.date?.start || "",
      previousAgentUrl: p.properties["Previous Agent URL"]?.url || "",
    };
  };

  /**
   * Вся база «Роли»: и активные, и те, что Мастер ещё не включил.
   *
   * Кеш на 10 минут — потому что это настройка, а не данные миссии: список
   * агентов читается в начале каждого шага, а меняет его человек. 29.10 обрыв
   * связи именно на этом чтении остановил цикл на девятом часу работы; с
   * кешем шаг переживает потерю сети, а не ждёт Мастера у экрана.
   *
   * `fresh: true` — мимо кеша: смена токена в ⚙ и случаи, где список только
   * что правили руками.
   */
  async function roleRows({ fresh = false, requireFresh = false } = {}) {
    const cached = GM_getValue(K.rolesCache, null);
    const usable = cached && Array.isArray(cached.rows) && cached.rows.length ? cached : null;
    const age = usable ? Date.now() - Number(usable.at || 0) : Number.POSITIVE_INFINITY;
    if (!fresh && !requireFresh && usable && age < C.rolesCacheMs) return usable.rows;
    try {
      const rows = (await query(C.roles)).map(mapRoleRow);
      if (rows.length) GM_setValue(K.rolesCache, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      if (!usable || requireFresh) throw e;
      log(
        `База «Роли» не ответила (${firstLine(String((e && e.message) || e))}) — работаю по кешу ` +
          `${Math.max(1, Math.round(age / 60000))} мин назад: список агентов с тех пор не менялся.`,
        false,
        { tone: "warn", ntfy: "quiet" },
      );
      return usable.rows;
    }
  }

  /** Свежий список ролей: сбросить кеш и перечитать. */
  async function rolesFresh() {
    GM_setValue(K.rolesCache, null);
    return roles();
  }

  async function roles() {
    const rows = await roleRows();
    const active = rows.filter((r) => r.id && r.url && r.status === "Активна");
    const ids = active.map((r) => norm(r.id));
    if (new Set(ids).size !== ids.length) throw new Error("Две активные роли указывают на один Agent URL.");
    if (active.filter((r) => r.fn === "Coordinator").length > 1)
      throw new Error("Активных Coordinator больше одного.");
    return active;
  }

  /**
   * Активная миссия — это «Активна» ИЛИ «Возвращена».
   *
   * «Возвращена» ставит Мастер, когда миссия закрыта, а работа не принята:
   * замечания лежат в полях карточки миссии. Если не учитывать это состояние,
   * возврат выглядит как «нет активной миссии», и цикл просто стоит.
   */
  async function activeMission() {
    const rows = await query(
      C.missions,
      {
        or: [
          { property: "Состояние", select: { equals: "Активна" } },
          { property: "Состояние", select: { equals: "Возвращена" } },
        ],
      },
      [{ property: "Создана", direction: "descending" }],
    );
    if (rows.length > 1) {
      throw new Error(`Найдено несколько активных или возвращённых миссий (${rows.map((row) => row.id).join(", ")}). ` +
        "Оставьте ровно одну активную миссию; автоматически выбирать по дате нельзя.");
    }
    return rows[0] || null;
  }

  const missionKind = (p) => sel(p.properties["Состояние"]);
  const isReturned = (p) => missionKind(p) === "Возвращена";
  const missionRemarks = (p) => rt(p.properties["Замечания"]).trim();

  /**
   * Первая строка длинного текста: список замечаний в строку журнала не влезет.
   *
   * 24.10 Мастер записал три замечания одним абзацем без переводов строки, и
   * `firstLine` вернула все три целиком — строка журнала на тысячу символов.
   * Теперь длинная строка режется по границе слова: в журнале и пуше видно
   * суть первого замечания, а полный текст остаётся в Notion и в плане.
   */
  const firstLine = (text, max = 220) => {
    const line =
      String(text || "")
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)[0] || "";
    if (line.length <= max) return line;
    const cut = line.slice(0, max);
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
  };

  /**
   * Замечания — по пунктам. Мастер пишет их и списком с переводом строки, и
   * одним абзацем «1) … 2) … 3) …». Координатору нужны отдельные пункты:
   * правило возврата — на каждое замечание своя карточка.
   */
  const remarkItems = (text) =>
    String(text || "")
      // Граница пункта — пробел или точка перед «2) », а не только перевод
      // строки: Notion хранит замечания несколькими rich_text-элементами, и
      // `rt` склеивает их без разделителя («…не менялся.2) docs…»).
      .replace(/([.\s])(\d{1,2}[).]\s)/g, "$1\n$2")
      .split("\n")
      .map((line) => line.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean);

  /** Последняя закрытая миссия: по ней видно, что цикл остановился не «просто так». */
  async function lastClosedMission() {
    const rows = await query(
      C.missions,
      {
        or: [
          { property: "Состояние", select: { equals: "Завершена" } },
          { property: "Состояние", select: { equals: "Провалена" } },
        ],
      },
      [{ property: "Завершена", direction: "descending" }],
    );
    return rows[0] || null;
  }

  /**
   * Конец миссии — событие, а не тишина.
   *
   * 24.10 в 15:49 Координатор закрыл NAR-1, а ScriptCat сказал только «Нет
   * активной миссии — ждём»: ни зелёной строки, ни пуша, ни выключенного
   * автоцикла. Мастер узнал о конце миссии из чата. Теперь событие
   * объявляется один раз на миссию: зелёная строка, громкий пуш, автоцикл
   * выключен, ожидание снято.
   */
  async function missionDoneNotice(expect) {
    let closed = null;
    try {
      closed = await lastClosedMission();
    } catch {
      return false; // Notion не ответил — не выдумываем событие
    }
    if (!closed) return false;
    if (expect?.kind === "dispatch" || expect?.kind === "answer" || expect?.kind === "review" || expect?.kind === "arbiter" || (expect?.kind === "reminder" && expect.runId)) {
      // Закрытие извне не доказывает, что ответ карточки или вопроса записан.
      // Не теряем его идентификаторы и не принимаем остальные ходы «за компанию».
      autoSet(false);
      pause("Миссия уже закрыта, но есть незавершённое ожидание карточки или вопроса. " +
        "Ответ и ID сохраняю; проверьте чат, карточку и журнал, прежде чем снимать ожидание.", {
        kind: "closed-with-running", ref: expect.ref || "", runId: expect.runId || "", turnId: expect.turnId || "",
      });
      return true;
    }
    const at = closed.properties?.["Завершена"]?.date?.start || "";
    // «Ждали ход» — любое незавершённое ожидание, а не только план или
    // напоминание. 28.10 NAR-4 закрыли своим ходом, в памяти осталось
    // ожидание вида «marker» — конец миссии прошёл молча.
    const waited = Boolean(expect && expect.kind);
    // «Завершена» — дата без времени, `Date.parse` даёт полночь. Прежние
    // десять минут означали: закрытие, увиденное через полчаса, уже «старое»,
    // и о нём не сообщали. Сутки покрывают любую дату закрытия этого дня.
    const age = at ? Date.now() - Date.parse(at) : Infinity;
    const recent = Number.isFinite(age) && age < 24 * 60 * 60 * 1000;
    // Включённый автоцикл сам по себе довод: он крутится, работы нет —
    // значит, миссия кончилась, и он обязан встать и сказать об этом.
    const running = autoOn();
    // Обычное «миссии пока нет» остаётся тишиной: закрытая миссия недельной
    // давности не повод пушить при каждом открытии страницы. Но автоцикл
    // гасим и здесь — закрытая миссия означает конец работы.
    if (!waited && !recent && !running) {
      autoSet(false);
      setStatus();
      return false;
    }

    // Отсчёт закрытия, а не только id: миссию возвращают и закрывают снова,
    // и второе закрытие — такое же событие, как первое. 28.10 NAR-4 закрыли
    // повторно после возврата, флаг по одному id остался с 27.10 — Мастер
    // не получил ни пуша, ни выключенного автоцикла. Поэтому в ключ входит
    // дата возврата: у каждой пары «возврат → закрытие» свой отсчёт.
    const returnedAt = closed.properties?.["Возвращена"]?.date?.start || "";
    const key = `cfn-mission-done:${closed.id}:${at}:${returnedAt}`;
    const announced = Boolean(GM_getValue(key, false));
    // Закрытие в обход приёмки. Миссию закрывает вердикт Reviewer, и только он:
    // если «Завершена» появилась без отметки `cfn-review:<id>`, значит её
    // поставил агент (или человек руками). Это не конец работы, а конец
    // проверки — про такое Мастер должен узнать сразу, а не через неделю.
    const verdict = String(GM_getValue(`cfn-review:${closed.id}`, "") || "");
    const ackKey = `cfn-review-ack:${closed.id}:${at}`;
    // Пауза — только когда закрытие кого-то застало: шёл ход или крутился
    // автоцикл. Миссию, закрытую Мастером на тихом стенде, будить незачем.
    if (!announced && !verdict && recent && (waited || running) && !GM_getValue(ackKey, false)) {
      GM_setValue(ackKey, true);
      if (waited) GM_setValue(K.expect, null);
      const name = rt(closed.properties["Миссия"]) || "миссия";
      pause(
        `Миссию «${name}» закрыли, но приёмка вердикта не давала: «Завершена» стоит в обход приёмки. ` +
          "Если работу действительно приняли — нажмите «Продолжить», цикл закроет миссию как обычно. " +
          "Если нет — верните её в «Возвращена», напишите «Замечания» и нажмите «Продолжить»: " +
          "Координатор разберёт их карточками.",
        {
          kind: "closed-unreviewed",
          ref: closed.id,
          quiet: true,
          notifyTitle: "Relay: миссия закрыта без приёмки",
        },
      );
      return true;
    }
    if (waited) GM_setValue(K.expect, null);
    // Автоцикл гасим и при повторном проходе: закрытая миссия означает конец
    // работы, даже если строку с пушем уже печатали (перезагрузка страницы,
    // второй «Шаг» по той же очереди).
    if (announced) {
      autoSet(false);
      setStatus();
      return waited;
    }

    GM_setValue(key, true);
    autoSet(false);
    const name = rt(closed.properties["Миссия"]) || "миссия";
    const failed = missionKind(closed) === "Провалена";
    log(
      failed
        ? `Миссия «${name}» закрыта как «Провалена». Автоцикл остановлен: дальше решает Мастер.`
        : `Миссия «${name}» завершена${at ? ` (${String(at).slice(0, 10)})` : ""}: очередь пуста, цикл остановлен. ` +
            "Следующая работа — новым ТЗ и новой миссией, а не хвостом этой.",
      false,
      {
        tone: failed ? "warn" : "ok",
        // Принятую миссию объявляет сама приёмка (`closeMission`) — громко и
        // один раз. Провал звонит, только если остановил работающий цикл или
        // незавершённый ход; на уже выключенном стенде достаточно тихо.
        ntfy: failed && (running || waited) ? "loud" : "quiet",
        cycleStopped: true,
        title: failed ? "Relay: миссия провалена" : "Relay: миссия завершена",
      },
    );
    return true;
  }

  /** Активная миссия и сменилась ли она относительно той, что помнит транспорт. */
  async function missionProbe() {
    const mission = await activeMission();
    const known = String(GM_getValue(K.mission, "") || "");
    return { mission, known, changed: Boolean(mission && known) && known !== mission.id };
  }

  /**
   * Паузы, которые миссией не ограничены.
   *
   * Капча, сломанная страница и ошибка на экране ждут человека, а не хода
   * внутри миссии: снимать их сменой миссии нельзя. Всё остальное — остановки
   * конкретного хода, и к новой миссии они отношения не имеют.
   */
  const PAUSE_BEYOND_MISSION = new Set(["captcha", "ui-error", "arena-error", "mission-change-running", "mission-change-answer", "marker-mismatch", "update-recovery"]);

  /** Пауза прошлого хода к новой миссии не относится. */
  function dropPauseOfMission(cleared = []) {
    if (!GM_getValue(K.paused, "")) return false;
    const ctx = GM_getValue(K.pause, null);
    if (ctx && PAUSE_BEYOND_MISSION.has(ctx.kind)) return false;
    GM_setValue(K.paused, "");
    GM_setValue(K.pause, null);
    cleared.push(`пауза прошлой миссии (${ctx?.kind || "без контекста"})`);
    return true;
  }

  /**
   * Смена миссии обнуляет прошлый ход.
   *
   * 24.10 миссия NAR-1 закрылась, а следующая начинается новой карточкой в
   * «Миссиях». Ожидание ответа и очередь отправки от прошлой миссии к новой не
   * относятся — но именно они решают, куда пойдёт «Шаг»: транспорт повёл бы
   * Мастера на страницу исполнителя, который уже ничего не делает, и новая
   * миссия не началась бы вовсе. Поэтому при смене миссии остатки снимаются,
   * а запись в журнале говорит, что именно.
   */
  async function syncMissionState() {
    const probe = await missionProbe();
    const live = GM_getValue(K.expect, null);
    const liveDispatch = live?.kind === "dispatch" || (live?.kind === "reminder" && !!live.runId);
    const liveAnswer = live?.kind === "answer" || live?.kind === "review" || live?.kind === "arbiter";
    if (!probe.mission) {
      const missionId = (liveDispatch || liveAnswer) && (live.missionId || probe.known);
      if (missionId) {
        const previous = await notion("GET", `pages/${missionId}`);
        const state = previous?.properties?.["Состояние"]?.select?.name || "";
        if (["Завершена", "Провалена"].includes(state)) {
          autoSet(false);
          pause("Миссия уже закрыта, но есть незавершённое ожидание карточки или вопроса. " +
            "Ответ и ID сохраняю; проверьте чат и журнал, прежде чем снимать ожидание.", {
            kind: "closed-with-running", ref: live.ref || "", runId: live.runId || "", turnId: live.turnId || "",
          });
          return true;
        }
      }
      return;
    }
    const changed = probe.changed || (live?.missionId && norm(live.missionId) !== norm(probe.mission.id));
    if (changed && (liveDispatch || liveAnswer)) {
      // Новая миссия не доказывает, что старая карточка или вопрос обработаны.
      pause("Появилась новая миссия, пока ждём ответ по карточке или вопросу прошлой. " +
        "Ожидание и ID сохранены: сначала сверьте чат, старую карточку и журнал.", {
        kind: liveAnswer ? "mission-change-answer" : "mission-change-running",
        ref: live.ref || "", runId: live.runId || "", turnId: live.turnId || "",
      });
      return true;
    }
    GM_setValue(K.mission, probe.mission.id);
    if (!probe.changed) return;

    const cleared = [];
    if (GM_getValue(K.expect, null)) {
      GM_setValue(K.expect, null);
      cleared.push("ожидание ответа");
    }
    if (GM_getValue(K.pending, null)) {
      GM_setValue(K.pending, null);
      cleared.push("очередь отправки");
    }
    // Вопросы прошлой миссии к новой не относятся: ответ на них теперь
    // бессмысленен, а очередь ответов иначе держала бы цикл (1.4.80).
    const pendingAnswers = GM_getValue(K.answers || "cfn-answer-queue", null);
    if (Array.isArray(pendingAnswers) && pendingAnswers.length) {
      GM_setValue(K.answers || "cfn-answer-queue", []);
      cleared.push("очередь ответов на вопросы");
    }
    GM_setValue("cfn-blocked-norole", 0);
    GM_setValue("cfn-plan-at", 0);
    GM_setValue("cfn-plan-miss", 0);
    dropPauseOfMission(cleared);

    const name = rt(probe.mission.properties["Миссия"]) || "без названия";
    log(
      `Новая миссия «${name}»: ${cleared.length ? `снял прошлый ход — ${cleared.join(", ")}` : "прошлый ход был чистым"}. ` +
        "Ход начинается с Координатора.",
      false,
      { tone: "ok" },
    );
  }

  /**
   * Пауза прошлой миссии не имеет права держать новую.
   *
   * Проверка стоит до общего стража паузы: иначе тик молча выходил бы, а
   * «Шаг» на любой странице отвечал бы «цикл на паузе» — и новая миссия не
   * начиналась бы, пока Мастер не нажмёт «Продолжить» без причины.
   */
  async function clearStaleMissionPause() {
    try {
      const probe = await missionProbe();
      if (!probe.changed) return false;
      const live = GM_getValue(K.expect, null);
      if (live?.kind === "dispatch" || live?.kind === "answer" || live?.kind === "review" || live?.kind === "arbiter" || (live?.kind === "reminder" && live.runId)) {
        // И эта ранняя ветка не должна закрепить новую миссию до сверки
        // старой выдачи, иначе syncMissionState уже не увидит смену.
        const context = GM_getValue(K.pause, null);
        if (!PAUSE_BEYOND_MISSION.has(context?.kind)) {
          pause("Появилась новая миссия, пока ждём ответ по карточке прошлой. " +
            "Ожидание и Run ID сохранены: сначала сверьте старую карточку и журнал, затем продолжайте.", {
            kind: "mission-change-running", ref: live.ref || "", runId: live.runId || "",
          });
        }
        return false;
      }
      const cleared = [];
      dropPauseOfMission(cleared);
      if (!cleared.length) return false;
      GM_setValue(K.mission, probe.mission.id);
      const name = rt(probe.mission.properties["Миссия"]) || "без названия";
      log(`Пауза относилась к прошлой миссии — снимаю: новая «${name}» начинается с чистого хода.`, false, { tone: "ok" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Блок замечаний Мастера в плане Координатора. Без него «Возвращена» —
   * просто слово в Notion: агент не знает, что именно не принято.
   */
  function returnBlock(mission) {
    if (!isReturned(mission)) return "";
    const remarks = missionRemarks(mission);
    if (!remarks) return "";
    const at = mission.properties["Возвращена"]?.date?.start || "";
    const items = remarkItems(remarks).map((line) => `- ${line}`);
    return [
      `МИССИЯ ВОЗВРАЩЕНА МАСТЕРОМ${at ? ` ${String(at).slice(0, 10)}` : ""} НА ДОРАБОТКУ. Замечания:`,
      ...items,
      "Правила возврата: на каждое замечание — отдельная карточка с оракулом, который именно это замечание проверяет; переделывать фазу целиком нельзя. " +
        "Миссию можно закрыть только когда все замечания закрыты карточками, а в «Итоге» есть раздел «Возврат» с ответом на каждое.",
    ].join("\n");
  }

  /**
   * Отпечаток возврата: дата, круг и замечания.
   *
   * Повторный возврат той же миссии (новый круг или новые замечания) — это
   * новое событие, а не продолжение прошлого: у него свой отсчёт.
   */
  const returnFingerprint = (mission) =>
    [
      mission.properties?.["Возвращена"]?.date?.start || "",
      String(mission.properties?.["Круг"]?.number ?? ""),
      missionRemarks(mission),
    ].join("|");

  /**
   * Момент, с которого возврат миссии известен скрипту.
   *
   * 24.10 в 15:47 Координатор ответил `done`, миссия закрылась, а ожидание
   * плана осталось висеть: 1.4.41 на «нет активной миссии» его не снимала.
   * В 16:07 Мастер вернул миссию, и в 16:12 шаг принял тот старый `done` за
   * ответ на замечания — пауза «в «Итоге» нет раздела «Возврат»», хотя нового
   * хода Координатора не было вовсе.
   *
   * Поэтому у каждого возврата свой отсчёт: всё, что запрошено раньше, —
   * прошлый ход. Оно снимается, а Координатор получает новый план с
   * замечаниями. Как только план запрошен после отсчёта, он уже не старый:
   * перезагрузка страницы и повторный шаг его не трогают.
   */
  function returnEpoch(mission) {
    const key = `cfn-mission-return-at:${mission.id}`;
    const fp = returnFingerprint(mission);
    const saved = GM_getValue(key, null);
    if (saved && saved.fp === fp && Number(saved.at)) return saved;
    // Время возврата — последняя правка карточки миссии: именно тогда Мастер
    // поставил «Возвращена» и написал замечания. Оно точнее, чем «первый шаг
    // после обновления»: план, запрошенный уже после возврата (например, ещё
    // на 1.4.42), не снимается как прошлый. Нет правки — считаем по часам.
    const edited = Date.parse(mission.last_edited_time || "");
    const fresh = { at: Number.isFinite(edited) && edited <= Date.now() ? edited : Date.now(), fp };
    GM_setValue(key, fresh);
    // 1.4.42 объявляла возврат меткой без отпечатка. Если она есть, этот
    // возврат уже был в журнале — переносим метку, чтобы обновление не дало
    // вторую такую же строку. Дальше метка живёт с отпечатком, и новый
    // возврат (другой круг или замечания) объявляется заново.
    const legacy = `cfn-mission-return:${mission.id}`;
    if (!saved && GM_getValue(legacy, false)) {
      GM_setValue(`cfn-mission-return:${mission.id}:${textHash(fp)}`, true);
    }
    return fresh;
  }

  /**
   * Ответ на замечания уже есть: в «Итоге» раздел «Возврат».
   *
   * Того же раздела требует returnBlock, поэтому «есть раздел» и «этот ход
   * получил замечания» — одно и то же утверждение, а не догадка по времени.
   */
  const returnAnswered = (mission) =>
    isReturned(mission) && Boolean(missionRemarks(mission)) &&
    /возврат/i.test(`${rt(mission?.properties?.["Итог"])} ${mission?.bodyText || ""}`);

  /**
   * Текст страницы миссии — блоками, а не только свойством «Итог».
   *
   * 06.11, 20:22. Координатор дописал «Итог хода … закрытие круга 1» блоками на
   * странице, а свойство «Итог» оставил прежним. Скрипт видел только свойство и
   * встал на паузу «в «Итоге» нет раздела «Возврат»», хотя раздел был — абзацем
   * ниже. Ошибиться может каждый: в карточке миссии два места с одинаковым
   * названием, и агент не обязан помнить, какое из них читает транспорт.
   *
   * Читаем только текстовые блоки, не заходя в дочерние страницы: карточки
   * Запросов живут отдельными страницами и к «Итогу» отношения не имеют.
   * Ошибка чтения не блокирует цикл: тогда решает свойство, как раньше.
   */
  async function missionBodyText(mission) {
    if (!mission?.id) return "";
    const rows = [];
    let cursor = "";
    for (let page = 0; page < 3; page += 1) {
      const list = await notion(
        "GET",
        `blocks/${mission.id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const results = Array.isArray(list?.results) ? list.results : [];
      for (const block of results) {
        const rich = block?.[block?.type]?.rich_text;
        if (Array.isArray(rich)) rows.push(rich.map((part) => part?.plain_text || part?.text?.content || "").join(""));
      }
      if (!list?.has_more || !list?.next_cursor) break;
      cursor = String(list.next_cursor);
    }
    return rows.join("\n").slice(0, 20000);
  }

  /**
   * Ожидание Координатора началось до возврата — это прошлый ход, а не ответ
   * на замечания. Снимаем его и разрешаем новый план немедленно: иначе
   * `done` из прошлого хода выглядит как отказ работать, и цикл встаёт на
   * паузу, которой не за что стоять.
   *
   * Признаков «этот ход уже с замечаниями» три, и первый сильнее остальных:
   * снимок `planBeforeReturn` (делается до отправки плана), раздел «Возврат» в
   * «Итоге» (его требует returnBlock того же возврата) и отметка `markedAt` —
   * когда возврат объявили строкой в журнале. Все они не зависят от того, когда
   * в последний раз правили карточку миссии.
   */
  function dropStalePlan(mission, expect, epoch) {
    if (!isReturned(mission) || !expect) return false;
    const at = Number(expect.at) || Number(expect.sentAt) || 0;
    const since = Number(epoch && epoch.at) || returnEpoch(mission).at;
    const marked = Number(epoch && epoch.markedAt) || 0;
    // 06.11, SYN-1. Возврат в 17:07:32, план с замечаниями в 17:07:57.
    // Координатор к 17:18 создал K-38…K-41 и дописал раздел «Возврат» в
    // «Итог» — «последняя правка» карточки уехала на 17:18, и отсчёт вместе с
    // ней. Ожидание 17:07:57 стало «начатым до возврата»: шаг в 17:19:30 снял
    // живой ход, в 17:19:54 ушёл второй план подряд — ещё 11 минут работы
    // агента и лишний расход лимитов.
    //
    // Время правки карточки для этого вопроса вообще не годится: Координатор
    // пишет в «Итог» в том же ходе. Поэтому сначала снимок плана, затем
    // карточка — раздел «Возврат» означает, что замечания уже разобраны этим
    // ходом. И только если ни того, ни другого нет, решает время.
    const stale = expect.planBeforeReturn === true
      ? true
      : expect.planBeforeReturn === false
        ? false
        : !returnAnswered(mission) && !(marked && at && at >= marked) && !(at && at >= since);
    if (!stale) return false;
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    return true;
  }

  const taskTitle = (p) => rt(p.properties["Запрос"]);
  const taskState = (p) => sel(p.properties["Dispatch State"]);
  const taskRole = (p) => sel(p.properties["Кому"]);

  /**
   * Слова названия миссии — без знаков и связок.
   *
   * 25.10 (фаза 2) Координатор создал NAR-2.14 и NAR-2.15 с «Миссией»
   * «NAR-2 · Шов движок и пак», а миссия называется «NAR-2 · Шов «движок /
   * пак»». Сравнение строк в лоб (`includes`) не совпало, обе карточки
   * выпали из очереди, и транспорт дважды просил план с «0 Ready, 0 Draft»,
   * хотя карточки лежали в базе, — а потом встал на паузу «в Ready нет
   * карточки». Поэтому имена сравниваются по словам: кавычки, «·», «/» и
   * связки «и» на смысл не влияют.
   */
  const MISSION_STOPWORDS = new Set(["и", "миссия", "миссии", "фаза", "этап"]);
  const missionWords = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter((w) => w && !MISSION_STOPWORDS.has(w));

  /**
   * Одна ли это миссия. Точное совпадение слов — да; перестановка слов и
   * лишнее слово — тоже да, если короткое название содержит не меньше трёх
   * слов, чтобы короткое название не цепляло соседние миссии. Это сравнение
   * используется для обратной связи; привязка карточек проверяется по Mission ID.
   */
  function missionSame(a, b) {
    const left = missionWords(a);
    const right = missionWords(b);
    if (!left.length || !right.length) return false;
    const key = (list) => [...list].sort().join(" ");
    if (key(left) === key(right)) return true;
    const [small, big] = left.length <= right.length ? [left, right] : [right, left];
    return small.length >= 3 && small.every((w) => big.includes(w));
  }

  /** Поле названия показывается человеку; граница очереди — только UUID миссии. */
  const cardMissionId = (row) => rt(row?.properties?.["Mission ID"]).trim();
  const cardInMission = (row, mission) => Boolean(mission?.id && isUuid(mission.id) &&
    isUuid(cardMissionId(row)) && norm(cardMissionId(row)) === norm(mission.id));

  function cardBindingIssue(row, missions) {
    const id = cardMissionId(row);
    const label = rt(row?.properties?.["Миссия"]).trim();
    const named = label ? missions.filter((item) => rt(item.properties?.["Миссия"]).trim() === label ||
      (isUuid(label) && norm(item.id) === norm(label))) : [];
    if (!isUuid(id) || !missions.some((item) => norm(item.id) === norm(id))) return "Mission ID пуст, ошибочен или не найден";
    if (named.length === 1 && norm(named[0].id) !== norm(id)) return "название и Mission ID указывают на разные миссии";
    return "";
  }

  /** Состояния, которые очередь умеет считать; прочие — «неизвестное состояние». */
  const CARD_STATES = new Set(["Draft", "Ready", "Running", "Submitted", "Accepted", "Rework", "Blocked"]);

  /** Пауза по привязке: её причина — карточка, а не «запись в Notion». */
  function bindingError(message, ref) {
    const error = new Error(message);
    error.relay = "binding";
    if (ref) error.ref = ref;
    return error;
  }

  /**
   * Карточка называет эту миссию — по «Миссии» (имя или UUID), а не по полю
   * Mission ID. Нужно, чтобы отличить «карточка точно наша, но без привязки»
   * от «карточка неизвестно чья».
   */
  function cardNamesMission(row, mission) {
    const label = rt(row?.properties?.["Миссия"]).trim();
    const wanted = rt(mission?.properties?.["Миссия"]).trim();
    if (!label || !mission?.id) return false;
    if (isUuid(label) && norm(label) === norm(mission.id)) return true;
    return Boolean(wanted) && missionSame(label, wanted);
  }

  /**
   * Карточки, которые мешают очереди именно этой миссии: они называют её по
   * названию, но привязки нет (или она битая), либо состояние неизвестно.
   *
   * 22:57–06:12. Координатор создал S-13…S-16 без Mission ID и без «Миссии»,
   * а `assertMissionBindings` валил любой шаг — включая приём уже полученного
   * ответа Warden: миссия вернулась в круг 1, запись сделана, а план Координатору
   * не ушёл, и цикл встал на паузе «Шаг прервался на записи в Notion». Карточки,
   * которые эту миссию не называют, к её очереди доказательно не относятся:
   * выдавать их всё равно нельзя (выдача требует Mission ID), поэтому поводом
   * для паузы они не служат — о них пишется одна строка в журнал.
   */
  function bindingBlockers(rows, missions, mission) {
    return rows.filter((row) => {
      if (!cardNamesMission(row, mission)) return false;
      return Boolean(cardBindingIssue(row, missions)) || !CARD_STATES.has(taskState(row));
    });
  }

  /**
   * Карточки, мешающие именно этой миссии: по названию они её называют, но
   * привязки нет, или состояние неизвестно. Читаются отдельным запросом там,
   * где от этого зависит решение (закрытие миссии, выбор очереди), — а не
   * стражем на каждом шаге.
   */
  async function missionBindingBlockers(mission) {
    if (!mission || !isUuid(mission.id)) return [];
    const [missions, cards] = await Promise.all([query(C.missions), query(C.requests)]);
    return bindingBlockers(cards, missions, mission);
  }

  /** Не прячем записи с пустым состоянием или неизвестной привязкой. */
  async function assertMissionBindings(mission) {
    if (!mission || !isUuid(mission.id)) throw new Error("Нет однозначного UUID миссии.");
    const cards = await query(C.requests);
    const problems = bindingBlockers(cards, await query(C.missions), mission);
    if (problems.length) {
      const examples = problems.slice(0, 8).map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
      throw bindingError(`В «Запросах» ${problems.length} карточек с пустым/неизвестным Mission ID или состоянием, ` +
        `и по названию они относятся к этой миссии: ${examples}. ` +
        "Исправьте их по плану миграции; ни одну не скрываю и не изменяю.", mission.id);
    }
    return cards;
  }

  /** Сказать про карточки другой миссии один раз на набор, а не на каждый план. */
  const missionSkipSeen = new Set();

  /**
   * `allowUnbound` — мягкое чтение: карточка этой миссии без привязки не валит
   * шаг, а складывается в переданный `unbound` (свой на каждый вызов: очередь
   * читается параллельно). Пауза из-за неё не встаёт — ход приёма уже
   * полученного ответа важнее, — но и молчать о ней нельзя.
   */
  async function tasks(state, mission, { allowUnbound = false, unbound = null } = {}) {
    if (!mission || !isUuid(mission.id)) throw new Error("Очередь нельзя прочитать без однозначного UUID миссии.");
    const rows = await query(
      C.requests,
      { property: "Dispatch State", select: { equals: state } },
      [{ property: "Sequence", direction: "ascending" }],
    );
    // Непривязанные записи нельзя молча исключить: среди них может быть и
    // карточка текущей миссии, в том числе Accepted для приёмки. Поэтому
    // карточка, которая называет эту миссию, по-прежнему останавливает шаг:
    // без UUID её нельзя ни выдать, ни принять. А карточка, которая эту
    // миссию не называет, к очереди доказательно не относится — она не в
    // очереди, но и паузы не требует (одна строка в журнал).
    const unresolved = rows.filter((row) => !isUuid(cardMissionId(row)));
    const mine = unresolved.filter((row) => cardNamesMission(row, mission));
    if (mine.length && !allowUnbound) {
      const examples = mine.slice(0, 8).map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
      throw bindingError(`В «${state}» ${mine.length} карточек без корректного Mission ID, ` +
        `и по названию они относятся к этой миссии: ${examples}. ` +
        "Проверьте и перенесите привязки; историю и состояния карточек не меняю.", mission.id);
    }
    if (allowUnbound && unbound) for (const row of mine) unbound.push(row);
    const wanted = rt(mission.properties["Миссия"]).trim();
    const skipped = rows.filter((row) => !cardInMission(row, mission));
    const kept = rows.filter((row) => cardInMission(row, mission));
    if (unresolved.length) {
      const key = `${state}|unbound|${unresolved.map((row) => row.id).join(",")}`;
      if (!missionSkipSeen.has(key)) {
        missionSkipSeen.add(key);
        const list = unresolved.map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
        log(`В «${state}» ${unresolved.length} карточек без Mission ID — они не в очереди миссии ` +
          `«${firstLine(wanted, 60)}», и я их не трогаю: ${list}. ` +
          "Привяжите их через «Управление проектами → Проверить Mission ID карточек».", false,
          { tone: "warn", ntfy: "quiet", title: "Relay: карточка без привязки" });
      }
    }
    if (skipped.length) {
      const key = `${state}|${skipped.map((row) => row.id).join(",")}`;
      if (!missionSkipSeen.has(key)) {
        missionSkipSeen.add(key);
        const list = skipped.map((row) => `«${firstLine(taskTitle(row), 40)}» — ${cardMissionId(row)}`).join("; ");
        log(`В «${state}» есть карточки другой миссии, они не в очереди: ${list}. ` +
          `Очередь миссии «${firstLine(wanted, 60)}».`, false,
          { tone: "warn", ntfy: "quiet", title: "Relay: карточка вне миссии" });
      }
    }
    return kept;
  }


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
   */
  const placeholderShape = (value) => {
    const text = String(value || "").trim();
    if (!text) return false;
    // Всё значение в скобках — точно пример: «<путь>», «<решение>».
    if (/^<[^<>\n]{1,200}>$/.test(text)) return true;
    // Скобки внутри текста: шаблон узнаём по описанию внутри («<роль|done>»,
    // «<чего именно не хватает: роль, доступ>»), а `<div>`/`<b>` в коде — нет.
    const token = /<([^<>\n]{1,200})>/.exec(text);
    return Boolean(token && /[\s|:…]|[А-Яа-яЁё]/.test(token[1]));
  };

  function isPlaceholderMarker(obj) {
    return Object.values(obj || {}).some((v) => typeof v === "string" && placeholderShape(v));
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
  const shortLabel = (el) =>
    `${el?.getAttribute?.("aria-label") || el?.getAttribute?.("title") || el?.textContent || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

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
      const label = shortLabel(el);
      if (!label || label.length > 80) continue; // длинный текст — транскрипт, а не индикатор
      if (!/thinking|reasoning|typing|дума|размышл|анализ/i.test(label)) continue;
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

  // ───────────────────────── ответ без маркера ─────────────────────────
  /**
   * Агент может ответить по делу и забыть маркер. Раньше это тонуло в журнале
   * («ждём следующего хода»), и цикл стоял до 45-минутного таймаута. Теперь
   * лестница: подождать, напомнить (до markerReminders раз), остановиться.
   * Число попыток живёт в ожидании, а не в счётчике страницы: перезагрузка
   * его не сбрасывает.
   *
   * tries — сколько напоминаний уже отправлено; лимит считается по ним.
   */
  function markerStep(tries, max = C.markerReminders) {
    return Number(tries) >= Number(max) ? "pause" : "remind";
  }

  /**
   * Напоминание о формате. Несколько формулировок — чтобы подряд идущие
   * напоминания не выглядели механической копией, и чтобы в чате не было слова
   * ScriptCat.
   *
   * why = "thin" — маркер есть, а отчёта нет (NAR-1.8, 23.10.2026: агент понял
   * «ответь одной последней строкой» буквально, а в журнал попал только маркер).
   * why = "ids" — маркер есть, но без dispatch_id/run_id этой выдачи (D-040,
   * 05.11.2026: Executor прислал маркер с «task» вместо ID). Работа сделана —
   * просим повторить только маркер с ID из напоминания, не переделывать ход.
   * why = "pr-claim" — маркер заявляет «pr:null» и «merged:true» сразу (D-046,
   * 06.11.2026: проверочные K-27 и K-34 уходили в Blocked). Просим поправить
   * одну строку: merged:false без изменений либо номер слитого PR.
   */
  function markerReminder(role, expect, attempt, markerName, why = "") {
    // D-067: вид дефекта решает текст. Если вызвавший не назвал причину
    // (обычное «маркера нет»), берём её у разбора: «JSON без имени» просит
    // дописать имя, а не переписать ответ.
    const defect = String(why || "").trim() || (typeof markerRejectReason === "function" ? markerRejectReason(markerName) : "");
    const ctx = {
      kind: "reminder",
      role: promptRole(role),
      turnId: expect.turnId || "",
      reminder: { markerName, attempt, max: C.markerReminders, why: defect },
      delivery: { tier: "full", attempt },
    };
    if (expect.kind === "dispatch") ctx.task = { id: expect.ref, runId: expect.runId, title: expect.title };
    if (expect.kind === "plan" || expect.kind === "review") ctx.mission = { id: expect.missionId || expect.ref };
    if (expect.kind === "answer") ctx.question = { id: expect.ref, turnId: expect.turnId };
    // D-053: арбитраж — тот же ход, напоминание несёт карточку и turn_id.
    if (expect.kind === "arbiter") ctx.arbiter = { cardId: expect.ref, ...(expect.arbiter || {}) };
    return compileOrPause(ctx, `reminder ${expect.kind}`);
  }

  /**
   * Признаки того, что агент ещё работает: кнопка Stop и «думающая» плашка.
   * Пока они видны, любой текст в чате — черновик, а не ответ.
   */
  function stillWorking() {
    return Boolean(busyReason());
  }

  /** Хвост текста для журнала: по нему видно, ответ это или «думаю…». */
  const tail = (text, n = 120) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : `…${flat.slice(-n)}`;
  };

  /**
   * Заявка «почти по формату»: id выдачи есть, номер PR есть, признак мержа
   * есть, а литерала маркера нет. Пример, на котором это понадобилось:
   * «NAR-1.7 RESULT — dispatch 4016f0cf-…; run 8abe7712-…; PR #31 MERGED.»
   */
  function looseResult(raw, role, expect) {
    if (role.fn === "Auditor") return null;
    const text = String(raw || "");
    const ref = String((expect && expect.ref) || "");
    const runId = String((expect && expect.runId) || "");
    if (!text || !ref || !runId) return null;
    const pr = Number((text.match(/\bPR\s*#?\s*(\d+)/i) || text.match(/\/pull\/(\d+)/) || [])[1]) || null;
    if (!pr) return null;
    const merged = /\bmerged\b|слит|слито|слита|слиты|\bв main\b/i.test(text);
    // ID должны стоять именно после своих подписей, а не просто встречаться в
    // произвольной цитате. Противоречивые повторные поля тоже недопустимы.
    const dispatches = [...text.matchAll(/\bdispatch(?:[_\s-]*id)?[`"'\s:=]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]);
    const runs = [...text.matchAll(/\brun(?:[_\s-]*id)?[`"'\s:=]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi)].map((m) => m[1]);
    if (!dispatches.length || !runs.length || dispatches.some((id) => norm(id) !== norm(ref)) ||
        runs.some((id) => norm(id) !== norm(runId))) return null;
    return { dispatch_id: dispatches[0], run_id: runs[0], status: "submitted", pr, merged };
  }

  /**
   * Текст ответа для журнала: все сообщения агента за ход, а не только последнее.
   *
   * Инцидент NAR-1.8 (23.10.2026). Kernel отчитался без маркера, получил
   * напоминание и прислал одну строку маркера. В журнал попал только маркер:
   * Координатор прочитал его, не увидел работы и поставил Rework при слитом PR.
   * Теперь журнал собирается из всего хода, а одинаковые части не дублируются.
   */
  function runAnswer(expect, hit) {
    const seen = new Set();
    const parts = [];
    const push = (m) => {
      const text = String((m && m.text) || "").trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      parts.push(text);
    };
    messagesAfter(expect.watermark).forEach(push);
    push(hit);
    const text = parts
      .map((part, i) => (parts.length > 1 ? `### Часть ${i + 1} из ${parts.length}\n\n${part}` : part))
      .join("\n\n");
    return { text, parts: parts.length, body: answerBody(text) };
  }

  /** Длина текста без служебных строк маркера: по ней видно, есть ли отчёт. */
  const answerBody = (text) =>
    String(text || "")
      .split("\n")
      .filter((line) => !/^\s*CF_(AGENT|COORDINATOR|REVIEW|ANSWER)_RESULT\b/.test(line) && !/^### Часть \d+ из \d+/.test(line))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim().length;

  /**
   * Минимальное сообщение вместо отклонённого задания.
   *
   * 25.10 задание Architect (NAR-2.16) не принималось трижды: «Something went
   * wrong. Please try again.» — и на полном тексте (7 586 символов), и на
   * сокращённом техблоке (7 610 после переотправки). Дело не в длине и не в
   * разметке: Arena отклоняет сам текст задания. Поэтому повтор — это не
   * пересказ, а просьба прочитать задание самому: ссылка на карточку, номера
   * выдачи и формат маркера. Всё остальное агент берёт из карточки.
   */
  function minimalPrompt(expect) {
    if (expect.kind === "plan") {
      return compileOrPause({
        kind: "plan", role: { fn: "Coordinator", name: expect.roleName || "Coordinator" },
        mission: { id: expect.missionId || expect.ref }, turnId: expect.turnId || "",
        queue: { summary: expect.planContext || "Прочитай очередь миссии и продолжи планирование." },
        delivery: { tier: "recovery", attempt: (Number(expect.arenaResend) || 0) + 1 },
      }, `recovery ${expect.ref}`);
    }
    return compileOrPause({
      kind: "retry", profileId: "delivery.compact",
      role: { fn: expect.roleFn || "Executor", name: expect.roleName || "" },
      task: { id: expect.ref, runId: expect.runId, title: expect.title, url: expect.url },
      delivery: { tier: "compact", attempt: (Number(expect.arenaResend) || 0) + 1 },
    }, `retry ${expect.ref}`);
  }

  /**
   * Задание, которое Arena съела ошибкой, возвращается в очередь минимальным
   * сообщением. Повтор один: второй отказ подряд — пауза, а не цикл.
   *
   * «Задание отправлено» в этом случае врёт: сообщение в транскрипте есть, ход у
   * агента не начался. Отметка доставки снимается, id «мёртвого» сообщения
   * запоминается (иначе `lastUserSays` примет старую копию за новую отправку).
   */
  function retryRejectedHandoff(expect, alert, why) {
    if (!expect || !expect.roleId) return false;
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" ||
        String(expect.roleName || "").toLowerCase() === "warden")) return false;
    if (!expect.sentAt) return false;
    if (Date.now() - Number(expect.sentAt || 0) > C.arenaRetryMs) return false;
    const done = Number(expect.arenaResend) || 0;
    if (done >= C.arenaResendMax) return false;
    const envelope = minimalPrompt(expect);
    if (!envelope) return false; // компиляция не прошла — пауза уже поставлена
    const text = envelope.text;
    GM_setValue(K.deadSend, (alert && alert.messageId) || "");
    GM_setValue(K.pending, {
      roleId: expect.roleId,
      roleName: expect.roleName,
      roleUrl: expect.roleUrl,
      text,
      at: Date.now(),
      sendTries: 0,
    });
    forgetDeliveryReceipt(expect);
    GM_setValue(K.expect, {
      ...expect,
      text,
      prompt: envelope,
      sentAt: null,
      verified: false,
      undelivered: true,
      cardRolled: false,
      arenaResend: done + 1,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
    });
    log(
      `${why}: задание до «${expect.roleName || "агента"}» не принялось — повторяю минимальным сообщением ` +
        `«прочитай карточку сам» (${text.length} символов вместо ${String(expect.text || "").length}). ` +
        "Второй отказ подряд — пауза. Новый ход Координатора не нужен.",
      true,
      { ntfy: "quiet", title: "Relay: повторяю задание" },
    );
    return true;
  }

  /**
   * Отказ из-за уже слитой ветки.
   *
   * 27.10 Архитектор получил новый прогон на ветке со статусом `pr_merged`
   * (PR #97 той же карточки) и ответил честно: «не могу выполнить прогон на
   * слитой ветке; нажмите Continue рядом со статусом PR». Это не ответ на
   * задание и не «агент молчит»: работа не начиналась, маркера не будет,
   * напоминания бесполезны — они уйдут в ту же мёртвую ветку.
   *
   * Признак требует сразу четырёх вещей: отказ, слово о ветке, слово о мерже
   * и подсказку про Continue. Обычный отчёт («PR #97 слит, ветка …») без
   * отказа под него не попадает — и он всё равно приходит с маркером.
   */
  function staleBranchRefusal(raw) {
    const text = String(raw || "");
    if (!text) return false;
    const refusal = /не могу|не получается|невозможно|cannot|can'?t|unable/i;
    // Границы слова `\b` в JavaScript считаются по ASCII, поэтому на кириллице
    // они не срабатывают: «ветка» — это не слово для регулярки. Берём основу.
    const branch = /pr_merged|\bbranch\b|ветк[а-яё]/iu;
    const merged = /слит|merged|pr_merged/i;
    const hint = /continue|продолж/i;
    return refusal.test(text) && branch.test(text) && merged.test(text) && hint.test(text);
  }

  /**
   * Повторить выдачу в чистую ветку, если агент отказался из-за `pr_merged`.
   *
   * Карточка остаётся Running с тем же Run ID: работа по ней не начиналась,
   * новый ход Координатора не нужен, откат в Ready только запутал бы очередь.
   * Повтор один: второй такой отказ — пауза с точной причиной, а не цикл.
   */
  function retryStaleBranchHandoff(expect) {
    if (!expect || !expect.roleId || !expect.sentAt) return false;
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" ||
        String(expect.roleName || "").toLowerCase() === "warden")) return false;
    const done = Number(expect.branchResend) || 0;
    if (done >= 1) return false;
    // Наша реплика с заданием — последняя в чате. Без этой отметки `deliver`
    // увидит её и решит, что сообщение уже отправлено, — повтор молча не уйдёт.
    const mine = messages().filter(isUserNode).at(-1);
    GM_setValue(K.deadSend, mine ? nodeId(mine) : "");
    GM_setValue(K.pending, {
      roleId: expect.roleId,
      roleName: expect.roleName,
      roleUrl: expect.roleUrl,
      text: expect.text,
      at: Date.now(),
      sendTries: 0,
    });
    forgetDeliveryReceipt(expect);
    GM_setValue(K.expect, {
      ...expect,
      sentAt: null,
      verified: false,
      branchResend: done + 1,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
    });
    log(
      `${expect.roleName || "Агент"} отказался начинать ход: его ветка уже слита (pr_merged). ` +
        "Это не ответ на задание — работы не было. Нажимаю Continue и отправляю задание заново, " +
        "в чистую ветку.",
      true,
      { ntfy: "quiet", title: "Relay: ветка слита, повторяю выдачу" },
    );
    return true;
  }

  /**
   * Ждём ответ без маркера. Возвращает true, если ход уже обработан
   * (напоминание ушло или цикл поставлен на паузу).
   *
   * why = "thin" — маркер пришёл, а отчёта в нём нет.
   */
  async function markerMissing(role, expect, markerName, manual = false, why = "") {
    // Пока агент печатает или «думает», ответа ещё нет: молчим, но по нажатию
    // «Шаг» объясняем, что именно ждём.
    if (stillWorking()) {
      if (manual) log(`${role.name} ещё отвечает (${busyLabel(busyReason())}) — подождите, потом нажмите «Шаг».`);
      return false;
    }
    // Страница ещё не отрисована — «маркера нет» говорить нельзя: его просто
    // не видно. То же правило, что в сторожe тишины, распространено на ручной
    // «Шаг»: пустая страница — не пустой чат.
    const page = pageReady(expect);
    if (!page.ok) {
      if (manual) {
        log(
          `Страница «${role.name}» ещё не отрисовалась (${page.why}) — подождите: ` +
            "читаю ответ из чата, а не из пустой страницы.",
        );
      }
      return false;
    }

    const replies = messagesAfter(expect.watermark || "");
    const last = replies.at(-1);
    if (!last) {
      // Ошибка Arena поверх нашего задания: сообщение в чате есть, а ход не
      // начался. От «агент думает» это отличается только самой ошибкой, поэтому
      // проверка стоит здесь. Первая переотправка — автоматическая (Мастер уже
      // нажал «Продолжить»); вторая подряд — пауза с честной причиной.
      const eaten = latestUserMessageAlert();
      if (eaten && expect.sentAt) {
        journalDelivery(expect, "arena_generic_error", classifyArenaFailure(eaten.text));
        if (retryRejectedHandoff(expect, eaten, `Arena ответила «${eaten.text}»`)) {
          // Отправляем прямо здесь, а не «следующим тиком»: шаг уже выполняется,
          // и отложенный тик был бы молча проглочен сторожем блокировки.
          const again = await consumePending(true);
          if (!again) {
            log("Переотправка на этой странице не началась — задание осталось в очереди и уйдёт на следующем шаге.", true, {
              ntfy: "quiet",
            });
          }
          return true;
        }
        const isReloadable = /something went wrong|please try again/i.test(eaten.text || "");
        if (isReloadable) {
          const reloadKey = `${C.reloadCountPrefix}${expect.dispatchId || expect.ref || "unknown"}`;
          const count = Number(await GM_getValue(reloadKey, 0)) || 0;
          if (count < C.maxReloadAttempts) {
            await GM_setValue(reloadKey, count + 1);
            log(
              `Ошибка Arena «${eaten.text}»: перезагрузка страницы (попытка ${count + 1} из ${C.maxReloadAttempts}) и повтор отправки.`,
              true,
              { ntfy: "quiet" },
            );
            // D-045: счётчик перезагрузок обязан пережить перезагрузку, иначе
            // предел в три попытки никогда не наступает.
            await flushBeforeNavigate([reloadKey, K.expect, K.pending, K.log]);
            location.reload();
            return true;
          }
          await pause(
            `Ошибка Arena «${eaten.text}» повторился ${C.maxReloadAttempts} раз. Страница не восстанавливается автоматически; требуется Мастер.`,
            { kind: "arena-error", ref: eaten.messageId },
          );
          return true;
        }
        pause(
          `Arena снова не приняла задание: «${eaten.text}» (коротких повторов подряд: ${C.arenaResendMax}). ` +
            "Задание осталось в очереди — нажмите «Продолжить», оно уйдёт этой же карточке, " +
            "без нового хода Координатора.",
          { kind: "arena-error", ref: eaten.messageId },
        );
        return true;
      }
      // Нормальное ожидание, но нажатый «Шаг» должен получить ответ, а не тишину.
      if (manual) {
        const sentMin = expect.sentAt ? Math.max(1, Math.round((Date.now() - expect.sentAt) / 60000)) : 0;
        const delivered = expect.verified === true ? "доставка подтверждена" : "доставка не подтверждена";
        // Молчаливое «новых сообщений нет» уже один раз скрыло готовый ответ,
        // поэтому в журнал идёт разбор чата: сколько наших реплик, сколько
        // ответов и какой из них последний.
        const chat = messages();
        const mine = chat.filter(isUserNode).length;
        const answers = chat.filter((n) => !isUserNode(n));
        const lastAnswer = answers.at(-1);
        log(
          `Жду ответ ${role.name}: сообщений агента после нашего задания нет` +
            `${sentMin ? ` (отправлено ${sentMin} мин назад, ${delivered})` : " (ещё не отправлено)"}` +
            `, в чате ${chat.length} (наших ${mine}, ответов агента ${answers.length}` +
            `${lastAnswer ? `, последний ${nodeId(lastAnswer)}` : ""}). Маркера этой выдачи в чате нет.`,
        );
        dbg("ожидание ответа", { role: role.name, watermark: expect.watermark, sentAt: expect.sentAt, verified: expect.verified });
      }
      return false;
    }

    // Подпись считается по сырому тексту: текст, который «дописывается»,
    // каждый раз даёт другую подпись и откладывает решение.
    const signature = `${last.id}:${last.raw.length}`;
    // Ответ, который Arena уже закрыла, читается сразу: ждать «стабильности»
    // незачем, иначе нажатый «Шаг» дважды отвечает «дописывает».
    if (!last.ended && expect.lastReplySig !== signature) {
      GM_setValue(K.expect, { ...expect, lastReplySig: signature, lastReplyAt: Date.now() });
      if (manual) log(`${role.name} дописывает ответ — дочитаю, когда закончит.`);
      return false;
    }
    if (!last.ended && Date.now() - (expect.lastReplyAt || Date.now()) < C.markerIdleMs) {
      if (manual) log(`Ответ ${role.name} ещё может дописаться — подождите.`);
      return false;
    }

    dbg("ответ без маркера", { id: last.id, length: last.raw.length, tail: tail(last.raw, 300), why });
    const sent = Number(expect.tries) || 0;
    // Маркер мог быть и отвергнутым: «нет маркера» и «есть, но разбор его
    // выбросил» — разные поломки, и журнал обязан их различать.
    const reject = markerRejectHint(markerName);
    // D-067: причину отказа разбора называем точно — «нет имени» лечится иначе,
    // чем «нет отчёта» и «нет ID». Без этого напоминание просит строку, которую
    // агент и так видит в своём ответе, и он повторяет тот же JSON.
    const defect = String(why || "").trim() || (typeof markerRejectReason === "function" ? markerRejectReason(markerName) : "");
    if (markerStep(sent) === "remind") {
      log(
        why === "thin"
          ? `${role.name} прислал только маркер ${markerName}, без отчёта — напоминание ${sent + 1} из ${C.markerReminders}.`
          : why === "ids"
          ? `${role.name} прислал маркер ${markerName} без dispatch_id/run_id этой выдачи — напоминание ${sent + 1} из ${C.markerReminders}. Работа не повторяется.`
          : why === "pr-claim"
          ? `${role.name} прислал маркер ${markerName} с «pr:null» и «merged:true» одновременно — напоминание ${sent + 1} из ${C.markerReminders}. Работа не повторяется.`
          : defect === "no-name"
          ? `${role.name} прислал JSON решения без имени ${markerName} — напоминание ${sent + 1} из ${C.markerReminders}. ` +
              "Имя проставлено в образце ниже; ответ переписывать не нужно."
          : `${role.name} ответил без маркера ${markerName} — напоминание ${sent + 1} из ${C.markerReminders}. ` +
              `Прочитан хвост: «${tail(last.text, 110)}»${reject}`,
        true,
        { ntfy: "quiet", title: defect === "thin" ? "Relay: маркер без отчёта" : defect === "ids" ? "Relay: маркер без ID" : defect === "pr-claim" ? "Relay: маркер противоречит себе" : defect === "no-name" ? "Relay: маркер без имени" : "Relay: нет маркера" },
      );
      // Причина уходит в напоминание всегда: `why` от вызвавшего, иначе — от
      // разбора (D-067). Раньше здесь стоял `why`, и «JSON без имени» получал
      // общий текст про «последнюю строку».
      await sendToRole(role, markerReminder(role, expect, sent + 1, markerName, defect), expect.kind, expect.ref, {
        missionId: expect.missionId,
        turnId: expect.turnId,
        runId: expect.runId,
        logId: expect.logId,
        title: expect.title,
        url: expect.url,
        tries: sent + 1,
        // Не считать время с напоминания временем работы по карточке.
        // Старые ожидания без отметки используют Started At из карточки.
        ...(expect.kind === "dispatch" ? {
          dispatchSentAt: Number(expect.dispatchSentAt) || 0,
          isDispatchReminder: true,
        } : {}),
      });
      return true;
    }

    const retained = retainRejectedResult(expect, "missing-marker", replies);
    const preservation = retained ? "Копия ответа сохранена локально; ожидание не снято." :
      "Ожидание не снято; локальную копию записать не удалось, сохраните ответ из чата вручную.";
    pause(
      (why === "thin"
        ? `${role.name} присылает только маркер ${markerName}, без отчёта, после ${C.markerReminders} напоминаний. ` +
            "Нужен Мастер: проверьте страницу агента. "
        : why === "ids"
        ? `${role.name} присылает маркер ${markerName} без dispatch_id/run_id этой выдачи после ${C.markerReminders} напоминаний. ` +
            "Нужен Мастер: попросите агента повторить маркер с ID этой выдачи. "
        : why === "pr-claim"
        ? `${role.name} присылает маркер ${markerName} с «pr:null» и «merged:true» одновременно после ${C.markerReminders} напоминаний. ` +
            "Нужен Мастер: если изменений не было — нужен merged:false, если PR слит — его номер. "
        : defect === "no-name"
        ? `${role.name} присылает JSON решения без имени ${markerName} после ${C.markerReminders} напоминаний. ` +
            "Нужен Мастер: строка решения есть, не хватает только имени маркера — его можно дописать в конец ответа. "
        : `${role.name} ответил без маркера ${markerName} после ${C.markerReminders} напоминаний. ` +
            `Нужен Мастер: проверьте страницу агента.${reject} `) + preservation,
      { kind: "marker", ref: expect.ref, runId: expect.runId, turnId: expect.turnId, tries: sent },
    );
    return true;
  }

  // ───────────────────────── ошибка на экране ─────────────────────────
  /**
   * Tool-call limit — отдельное состояние Arena: ход уже начался, часть работы
   * могла быть сделана. Это не отказ доставки, не captcha/auth/rate и не забытый
   * маркер. Правильное действие — короткое сообщение-продолжение в тот же чат
   * (см. 30-tool-limit.js), а не повтор задания и не общая пауза по UI-ошибке.
   */
  const TOOL_LIMIT_RE = /the agent reached the tool-call limit for this turn|send a message to continue where it left off|tool[- ]call limit for this turn|лимит вызовов инструментов|достиг лимита инструментов/i;
  const TOOL_LIMIT_EXCLUDE = "pre, code, textarea, .shiki, .hljs, .prism, .monaco-editor, [data-language], [data-diff], [class*='diff'], [class*='code-block'], [contenteditable='true'], [contenteditable='']";

  /**
   * Видимый статус tool-call limit в транскрипте (role=status/alert, amber —
   * лишь дополнительный признак). Ищем в сообщениях чата, не в pre/code/diff/
   * редакторе; привязываем к ближайшему chat-message. Без id — хеш текста+позиция.
   */
  function detectToolCallLimit() {
    const nodes = messages();
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      for (const el of node.querySelectorAll('[role="status"], [role="alert"]')) {
        if (!visible(el) || el.closest(TOOL_LIMIT_EXCLUDE)) continue;
        const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || !TOOL_LIMIT_RE.test(text)) continue;
        const messageId = nodeId(node) || `h${textHash(text)}:${i}`;
        return { messageId, text: text.slice(0, 300), index: i };
      }
    }
    return null;
  }

  /**
   * Arena показывает сбой двумя способами: алертом внутри последнего
   * пользовательского сообщения и красной карточкой в интерфейсе. Оба —
   * повод остановиться, а не «подождать и попробовать ещё раз»: повтор поверх
   * неизвестной ошибки отправляет агенту второй промпт и путает учёт хода.
   */
  function latestUserMessageAlert() {
    const list = messages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const node = list[i];
      if (!node.querySelector('[data-user-message-layout="true"]')) continue;
      const alert = [...node.querySelectorAll('[role="alert"]')].find(visible);
      if (!alert) return null;
      return {
        messageId: nodeId(node),
        text: String(alert.innerText || alert.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      };
    }
    return null;
  }

  function detectVisibleErrorCard() {
    const selectors = [
      'div[class*="border-red"][class*="bg-red"][class*="rounded"]',
      'div[class*="border-red-500"][class*="bg-red-500"]',
      'div[class*="border-destructive"][class*="bg-destructive"]',
    ];
    const keywords = /something went wrong|please try again|failed|error occurred|an error|rate limit|timed out|timeout|unauthorized|ошибка|попробуйте снова|что-то пошло не так|не удалось|сбой|превышен лимит/i;
    for (const selector of selectors) {
      for (const card of document.querySelectorAll(selector)) {
        if (!visible(card) || card.dataset.cfnSeen === "1") continue;
        if (card.closest("pre, code, textarea, .shiki, .hljs, .prism, .monaco-editor, [data-language], [data-diff], [class*='diff'], [class*='code-block']")) continue;
        const text = String(card.innerText || card.textContent || "").trim();
        if (!text) continue;
        // Tool-call limit — не UI-ошибка: его обрабатывает продолжение хода.
        if (TOOL_LIMIT_RE.test(text)) continue;
        if (text.length < 400 || keywords.test(text)) {
          card.dataset.cfnSeen = "1";
          return text.replace(/\s+/g, " ").slice(0, 300);
        }
      }
    }
    return null;
  }

  /**
   * Одну и ту же ошибку не показываем дважды: после «Продолжить» Мастер уже
   * видел её, и повторная пауза на том же месте сделала бы цикл неоживучим.
   */
  function alreadyReported(key) {
    return GM_getValue(K.errSeen, "") === key;
  }

  function markReported(key) {
    GM_setValue(K.errSeen, key);
  }

  function monitorVisibleErrors() {
    // Tool-call limit обрабатывается продолжением хода (handleToolCallLimit в
    // тике стоит раньше). Здесь не превращаем его в общую паузу по UI-ошибке.
    if (detectToolCallLimit()) return false;
    const alert = latestUserMessageAlert();
    if (alert) {
      const key = `alert:${alert.messageId}`;
      if (alreadyReported(key)) return false;
      markReported(key);
      // Ошибка поверх нашего же задания — это не «агент сломался», а «сообщение
      // не приняли». Ход не снимаем и Мастера не зовём: в очередь кладётся
      // короткая версия, её отправит ближайший тик. Пауза — только когда
      // короткие повторы уже исчерпаны.
      const expect = GM_getValue(K.expect, null);
      if (retryRejectedHandoff(expect, alert, `Arena ответила «${alert.text || "ошибка без текста"}»`)) {
        return true;
      }
      const tried = Number(expect?.arenaResend) || 0;
      if (tried > 0) {
        // Минимальное сообщение тоже не прошло: второй отказ подряд — стоп.
        pause(
          `Arena второй раз не приняла задание «${expect?.title || expect?.ref || "агента"}»: ` +
            `«${alert.text || "ошибка без текста"}». Минимальное сообщение тоже отклонено — ` +
            "цикл остановлен. Задание в очереди, карточка Running: посмотрите страницу агента.",
          { kind: "arena-error", ref: alert.messageId, runId: expect?.runId || "" },
        );
        return true;
      }
      pause(`Видимая ошибка Arena в последнем сообщении: ${alert.text || "текст ошибки пуст"}.`, {
        kind: "arena-error",
        ref: alert.messageId,
      });
      return true;
    }
    const card = detectVisibleErrorCard();
    if (card) {
      const key = `ui:${card.slice(0, 80)}`;
      if (alreadyReported(key)) return false;
      markReported(key);
      pause(`Необработанная ошибка интерфейса: ${card || "текст ошибки пуст"}.`, { kind: "ui-error" });
      return true;
    }
    return false;
  }

  // ───────────────────────────── отправка ─────────────────────────────
  /**
   * Редактор агента. Селекторы — из рабочего `dispatch.user.js`, но шире:
   * `[contenteditable='true']` не совпадает с `plaintext-only`, а ProseMirror
   * вешает `role=textbox` без contenteditable. Первый найденный элемент может
   * быть скрытой копией, поэтому кандидаты перебираются с проверкой видимости.
   */
  /** Свой пульт ScriptCat — не поле ввода и не кнопка отправки. */
  const inOwnPanel = (el) => Boolean(el?.closest?.(`#${ui.panel}`));

  /**
   * Боковая панель: аккаунт, навигация, поиск.
   *
   * В разметке Arena это `div.group/sidebar-wrapper`, у кнопки аккаунта —
   * `div.fixed.z-10 … > … > ul > button`. Кнопки оттуда не нажимаются никогда:
   * 23.10 в 22:02 три «клика Send» ушли ровно в аккаунт Мастера.
   */
  const SIDEBAR_SELECTOR = `nav, aside, [role="navigation"], [data-sidebar], [class*="sidebar"]`;

  /**
   * Боковая панель — это та ветка дерева, в которой нет `main`.
   *
   * Тонкость, на которой 23.10 сломался 1.4.25: **вся страница** обёрнута в
   * `div.group/sidebar-wrapper …` — в её классе тоже есть «sidebar». Если
   * исключать всё внутри такого предка, из поиска выпадает и `main`, и поле
   * ввода с кнопкой отправки: скрипт пишет «не нашёл поле ввода», хотя оно на
   * экране. Настоящий сайдбар — сосед `main`, он `main` внутри себя не
   * содержит; обёртка страницы — содержит.
   */
  function sidebarRoot(el) {
    let node = el?.closest?.(SIDEBAR_SELECTOR) || null;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      if (!node.querySelector?.("main")) return node;
      node = node.parentElement?.closest?.(SIDEBAR_SELECTOR) || null;
    }
    return null;
  }

  const inSidebar = (el) => Boolean(sidebarRoot(el));

  /** Служебные поля вроде капчи: под селектор поля ввода они тоже подходят. */
  const isServiceField = (el) =>
    Boolean(el?.closest?.('[class*="captcha"], [name="g-recaptcha-response"]')) ||
    Boolean(el?.classList?.contains?.("g-recaptcha-response"));

  /**
   * Панель ввода: ближайший предок поля, внутри которого есть кнопки.
   *
   * В текущей разметке Arena это
   * `div.bg-surface-secondary…rounded-b-none`, а внутри — и редактор
   * (`.editor-content`), и ряд `.flex.justify-between.gap-4` с кнопкой
   * отправки. Именно эта панель, и только она, задаёт область поиска кнопки
   * Send: «Merge PR» и информация о ветке лежат выше и сюда не попадают, а
   * сайдбар — совсем в другой ветке дерева.
   *
   * До `main` и `body` не поднимаемся: там кнопок сколько угодно, и любая из
   * них — не наша.
   */
  function composerBox(editor) {
    let node = editor?.parentElement || null;
    for (let depth = 0; depth < 8 && node; depth += 1) {
      const tag = String(node.tagName || "").toUpperCase();
      if (tag === "BODY" || tag === "HTML" || tag === "MAIN") return null;
      const buttons = [...(node.querySelectorAll?.('button, [role="button"]') || [])].filter(
        (b) => visible(b) && !inSidebar(b) && !inOwnPanel(b),
      );
      if (buttons.length) return node;
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Узел действительно в документе.
   *
   * После перерисовки чата Arena заменяет поле ввода новым элементом, а у нас
   * остаётся ссылка на старый. `isConnected` у него уже false, и `addRange`
   * падает: «The given range isn't in document». Именно это случилось 23.10 в
   * 22:02 — текст «вставился» в отвязанный узел, настоящее поле осталось
   * пустым, Send — серым.
   */
  function composerAlive(el) {
    if (!el || el.isConnected === false) return false;
    try {
      return typeof document.contains === "function" ? document.contains(el) : true;
    } catch {
      return true;
    }
  }

  /**
   * Редактор сообщения.
   *
   * В живой разметке поле — это `.editor-content > div.tiptap.ProseMirror > p`,
   * и параграфов внутри может быть несколько: они разделяют строки. Редактор
   * поэтому ищется по `contenteditable`, а не по `.editor-content`: обёртка
   * сама не редактируемая.
   *
   * Сайдбар и служебные поля (капча) исключены: под те же селекторы подходят
   * чужие `[role="textbox"]` и `textarea`, а вставка в них — это не отправка
   * задания, а мусор в чужом поле.
   */
  function composer() {
    const good = (el) => el.tagName !== "INPUT" && !inOwnPanel(el) && !inSidebar(el) && !isServiceField(el);
    const candidates = [
      ...document.querySelectorAll(
        ".editor-content [contenteditable]:not([contenteditable='false']), " +
          ".editor-content .ProseMirror, .editor-content[contenteditable], " +
          "[contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
      ),
    ].filter(good);
    const shown = candidates.filter(visible);

    // 1. Редактор в панели `.editor-content` — единственный, который Arena
    //    считает полем сообщения.
    const editorContent = shown.find((el) => el.closest?.(".editor-content"));
    if (editorContent) return editorContent;

    // 2. Любой видимый, у которого есть панель с кнопками: значит, это
    //    панель ввода, а не посторонний `[role=textbox]`.
    const withBox = shown.find((el) => composerBox(el));
    if (withBox) return withBox;

    // 3. Запас: на странице агента поле ввода одно. Если под жёсткие правила
    //    оно не подошло (например, поменяли классы), лучше взять единственное
    //    видимое, чем встать: вставка и отправка всё равно проверяются дальше.
    if (shown.length === 1) {
      dbg("composer: единственное видимое поле взято запасным правилом", {
        cls: String(shown[0].className || "").slice(0, 60),
      });
      return shown[0];
    }

    const prompt = document.querySelector(".editor-content p, [data-placeholder] p");
    const nearPrompt = prompt?.closest("[contenteditable]") || null;
    if (nearPrompt && visible(nearPrompt) && good(nearPrompt)) return nearPrompt;
    return (
      [...document.querySelectorAll("textarea:not([readonly])")].find(
        (el) => good(el) && visible(el) && !el.closest?.('[class*="captcha"]'),
      ) || null
    );
  }

  /**
   * Редактор может быть на месте, но накрыт плашкой: тогда и вставка, и Send
   * уходят в оверлей. Проверяем верхний элемент в центре редактора.
   */
  function elementCovered(editor) {
    try {
      const rect = editor.getBoundingClientRect();
      if (!rect.width || !rect.height) return true;
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1);
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      return !(top === editor || editor.contains(top) || top.contains(editor));
    } catch {
      return false;
    }
  }

  const labelText = (el) =>
    [
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("data-testid"),
      el?.getAttribute?.("data-test-id"),
      el?.textContent,
    ]
      .map((v) => String(v || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean);

  // Только начало подписи: «Send», «Send message», «send-button» проходят,
  // подпись аккаунта в сайдбаре — нет. Прежнее правило искало слово «send»
  // где угодно в тексте кнопки и было слишком щедрым.
  const SEND_LABEL = /^(send|submit|отправ\w*)(\b|$)/;

  // Кнопка остановки стоит на месте Send, пока агент работает. Нажимать её
  // вместо отправки нельзя: это обрывает ответ.
  const STOP_LABEL = /stop|останов|cancel|отмен/i;

  /**
   * Снимок разметки для разбора отказов.
   *
   * Когда что-то не находится, спорить о причинах бессмысленно: нужны
   * координаты и подписи того, что реально видит скрипт. Снимок пишется в
   * хранилище при отказе отправки и печатается в консоль через
   * `__relay.dom()`.
   */
  function domReport() {
    const box = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      } catch {
        return null;
      }
    };
    const about = (el) => ({
      tag: String(el.tagName || "").toLowerCase(),
      role: el.getAttribute?.("role") || "",
      ce: el.getAttribute?.("contenteditable") || "",
      label: String(labelText(el)[0] || "").slice(0, 40),
      cls: String(el.className || el.getAttribute?.("class") || "").slice(0, 70),
      box: box(el),
      alive: el.isConnected !== false,
      own: inOwnPanel(el),
      sidebar: Boolean(el.closest?.("nav, aside, [role='navigation'], [data-sidebar], [data-slot='sidebar']")),
    });
    const editors = [
      ...document.querySelectorAll(
        ".editor-content[contenteditable], .editor-content [contenteditable], " +
          "[contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
      ),
    ]
      .filter((el) => el.tagName !== "INPUT")
      .slice(0, 12)
      .map(about);
    const buttons = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
      .slice(0, 60)
      .map(about)
      .filter((b) => b.box && b.box[2] > 0 && b.box[3] > 0);
    const pick = composer();
    const dialog = openDialog();
    return {
      at: Date.now(),
      path: location.pathname,
      hidden: typeof tabHidden === "function" ? tabHidden() : null,
      pick: pick ? about(pick) : null,
      box: pick ? about(composerBox(pick) || {}) : null,
      dialog: dialog ? about(dialog) : null,
      editors,
      buttons,
    };
  }

  /**
   * Открытый диалог Arena поверх чата.
   *
   * Пока он висит, `focus()` не отдаёт каретку полю ввода, и `execCommand`
   * вставляет текст туда, где сейчас фокус. Вставка это заметит (текст не
   * появится в поле), но причину надо называть прямо, иначе Мастер видит
   * только «не удалось вставить задание».
   */
  function openDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
    return dialogs.find((el) => visible(el) && !inOwnPanel(el)) || null;
  }

  /**
   * Капча («Security Verification» с reCAPTCHA) поверх чата.
   *
   * Появляется не по расписанию, а в момент отправки — и тогда клик по Send
   * ничего не отправляет: Arena показывает окно проверки, а сообщение до
   * агента не доходит. Хуже того, поле на миг пустеет, а в транскрипте
   * появляется наша реплика, поэтому `waitSent` честно докладывал «отправлено».
   * 11:56:47 так и вышло: «Задание отправлено», а Координатор ничего не
   * получил (вопрос Мастера 53).
   *
   * Поэтому капча проверяется до клика, после клика и в ожидании доставки: пока
   * окно висит, отправки нет — что бы ни показывал счётчик сообщений.
   */
  const CAPTCHA_SELECTORS = [
    ".recaptcha-v2-container",
    'iframe[title="reCAPTCHA"]',
    'iframe[src*="recaptcha"]',
    "#g-recaptcha-response",
  ];

  function captchaDialog() {
    for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      if (!visible(el)) continue;
      if (CAPTCHA_SELECTORS.some((sel) => el.querySelector(sel))) return el;
      // Разметку Arena можно переверстать: окно всё равно узнаётся по заголовку.
      if (/(security verification|recaptcha|подтвердите, что вы человек)/i.test(String(el.textContent || ""))) return el;
    }
    for (const el of document.querySelectorAll(".recaptcha-v2-container")) {
      if (visible(el)) return el.closest?.('[role="dialog"]') || el;
    }
    return null;
  }

  /**
   * Доставка без человека невозможна: пауза с громким пушем.
   *
   * Очередь не снимается: после решения капчи «Продолжить» отправит то же
   * задание, а не начнёт ход заново. Карточка остаётся Running — ход жив, он
   * ждёт человека; вернуть её в Ready значило бы потом отказаться записывать
   * ответ («Задача уже не Running»).
   */
  function captchaPause(extra = "") {
    pause(
      `Появилась капча (Security Verification): без человека сообщение не уйдёт. ` +
        `Решите её и нажмите «Продолжить» — задание осталось в очереди.${extra}`,
      { kind: "captcha", notifyTitle: "Relay: капча — нужен человек" },
    );
  }

  /**
   * Кнопка рядом с полем ввода.
   *
   * Геометрия — единственный признак, который отличает Send от кнопки аккаунта
   * в сайдбаре: подписи у них разные, а вот «первая доступная кнопка в общем
   * контейнере» может оказаться любой. Допуски щедрые: панель ввода бывает
   * и под полем, и справа от него.
   */
  function isNearComposer(el, editor) {
    try {
      const a = editor.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      if (!a.width || !a.height || !b.width || !b.height) return false;
      // Границы считаются из top/left/width/height: `bottom` и `right` есть у
      // настоящего DOMRect, но полагаться только на них незачем.
      const aBottom = a.top + a.height;
      const aRight = a.left + a.width;
      const bBottom = b.top + b.height;
      const bRight = b.left + b.width;
      return (
        bBottom >= a.top - 160 &&
        b.top <= aBottom + 200 &&
        bRight >= a.left - 80 &&
        b.left <= aRight + 220
      );
    } catch {
      return false;
    }
  }

  /**
   * Кнопка отправки. Подпись важнее формы: в Arena кнопка часто лежит вне
   * `<form>` редактора, поэтому одного `type=submit` мало. Перебираем по
   * приоритету: явная подпись Send → submit внутри формы → submit рядом.
   */
  /** Расстояние от кнопки до редактора: кнопка Send всегда рядом с полем. */
  function distanceTo(editor, el) {
    try {
      const a = editor.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return Math.abs(b.top - a.bottom) + Math.abs(b.left - a.left) / 4;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  }

  function sendButton(editor) {
    if (!composerAlive(editor)) return null;

    // Область поиска — панель ввода. Не документ: 23.10 в 22:02 «первая
    // доступная кнопка в родителе редактора» оказалась кнопкой аккаунта в
    // сайдбаре, и три клика ушли туда. Кнопки вне панели ввода не
    // рассматриваются вообще — ни как запасной путь, ни при нестандартной
    // вёрстке. Лучше пауза, чем клик в неизвестное место.
    const box = composerBox(editor);
    const scope = box || (editor.closest?.("form") || null);
    if (!scope) return null;

    const panels = completionPanels();
    const inPanel = (b) => panels.some((p) => p.contains?.(b));
    const usable = (b) =>
      b &&
      b.isConnected !== false &&
      !b.disabled &&
      b.getAttribute?.("aria-disabled") !== "true" &&
      b.getAttribute?.("data-disabled") !== "true" &&
      visible(b) &&
      !inPanel(b) &&
      !inOwnPanel(b) &&
      !inSidebar(b) &&
      !STOP_LABEL.test(String(labelText(b)[0] || ""));
    const controls = [...scope.querySelectorAll('button, [role="button"], input[type="submit"]')].filter(usable);
    if (!controls.length) return null;

    // 1. Явная подпись отправки. Из нескольких — последняя в панели: ряд
    //    `.flex.justify-between` держит подпись справа.
    const labelled = controls.filter((b) => labelText(b).some((l) => SEND_LABEL.test(l)));
    if (labelled.length) return labelled.at(-1);

    // 2. `type=submit` внутри панели.
    const submit = controls.filter((b) => String(b.getAttribute?.("type") || b.type || "") === "submit");
    if (submit.length) return submit.at(-1);

    // 3. Подписи нет (одна иконка). Узнать её можно только по месту: кнопка
    //    отправки стоит одна в своей группе, эта группа — последняя в ряду
    //    `.flex.justify-between`, а сама кнопка — в правой половине панели.
    //    Всё, что не подходит под это описание, отправкой не считается:
    //    скрепка и выбор модели стоят слева и в первой группе.
    const nearField = controls.filter((b) => {
      const holder = b.parentElement;
      if (!holder) return false;
      const siblings = [...holder.querySelectorAll('button, [role="button"]')].filter(usable);
      if (siblings.length !== 1) return false;
      if (holder !== holder.parentElement?.lastElementChild) return false;
      if (!isNearComposer(b, editor)) return false;
      const a = editor.getBoundingClientRect();
      const r = b.getBoundingClientRect();
      return r.left >= a.left + a.width / 2 - 40;
    });
    return nearField.at(-1) || null;
  }

  /**
   * Вставка текста в редактор.
   *
   * `execCommand("insertText")` — единственный путь, который редактор Arena
   * (ProseMirror) считает настоящим вводом: он обновляет состояние, и кнопка
   * Send становится активной. Запасной путь «присвоить textContent» нужен
   * только если execCommand недоступен — после него текст в DOM есть, а
   * состояние пустое, и Send остаётся серым.
   */
  function writePrompt(editor, text, attempt = 1) {
    // Поле могло исчезнуть из документа между поиском и вставкой — тогда
    // ищем заново, а не пишем в копию.
    let live = composerAlive(editor) ? editor : composer();
    if (!live) return false;
    if (live !== editor) dbg("writePrompt: поле ввода перечитано", { attempt });

    live.focus();
    if (live.tagName === "TEXTAREA" || live.tagName === "INPUT") {
      const proto = live.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(live, text);
      else live.value = text;
      live.dispatchEvent(new Event("input", { bubbles: true }));
      live.dispatchEvent(new Event("change", { bubbles: true }));
      if (live.value.trim().length) return true;
      return attempt < 2 ? writePrompt(composer(), text, attempt + 1) : false;
    }

    let inserted = false;
    try {
      const range = document.createRange();
      range.selectNodeContents(live);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      inserted = document.execCommand("insertText", false, text);
    } catch (e) {
      // «The given range isn't in document» — узел успел отвалиться.
      dbg("writePrompt: выделение не поставилось", {
        error: String(e?.message || e),
        alive: composerAlive(live),
      });
    }
    // Запасной путь — только в живой узел: у отвязанного текст «есть», но
    // редактор о нём не знает, и Send остаётся серым.
    if (!inserted && composerAlive(live)) {
      live.textContent = text;
      live.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
    if (composerAlive(live)) live.dispatchEvent(new Event("change", { bubbles: true }));

    const written = composerAlive(live) ? composerText(live).length : 0;
    dbg("writePrompt", () => ({
      via: inserted ? "execCommand" : "textContent",
      written,
      expected: text.length,
      alive: composerAlive(live),
    }));
    if (written > 0) return true;

    // Поле перерисовали: одна повторная попытка в новом узле.
    if (attempt < 2) return writePrompt(composer(), text, attempt + 1);
    return false;
  }

  const composerText = (editor) => (editor?.innerText || editor?.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Очистить поле ввода.
   *
   * 25.10 Arena вернула отклонённый текст задания обратно в поле: сообщение «не
   * ушло», а черновик остался. Если этого не заметить, следующая вставка
   * склеится со старым текстом, и вместо минимального сообщения уйдёт тот же
   * отклонённый промпт — ошибка повторится.
   */
  function clearComposer(editor) {
    const live = composerAlive(editor) ? editor : composer();
    if (!live) return false;
    if (!composerText(live)) return true;
    live.focus();
    try {
      if (live.tagName === "TEXTAREA" || live.tagName === "INPUT") {
        const proto = live.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(live, "");
        else live.value = "";
        live.dispatchEvent(new Event("input", { bubbles: true }));
        return !composerText(live);
      }
      const range = document.createRange();
      range.selectNodeContents(live);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete");
    } catch (e) {
      dbg("composer: очистка не удалась", String(e?.message || e));
    }
    // Запасной путь — как у вставки: иначе ProseMirror оставит свой старый узел.
    if (composerText(live) && composerAlive(live)) {
      live.textContent = "";
      live.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
    }
    return !composerText(live);
  }

  /**
   * Плашка «задание выполнено». Два вида, оба перекрывают чат:
   *  1) панель с классом из `dispatch.user.js` и кнопкой закрытия;
   *  2) карточка в транскрипте с кнопкой `Skip` (опрос, аудио, предложение).
   * Возвращает "closed" | "blocked" | "none".
   */
  /**
   * Панель завершения. В `dispatch.user.js` селектор требовал `shadow-sm`, а в
   * текущей разметке Arena у неё `shadow-none` — совпадение по всему списку
   * классов перестало находить карточку. Держим стабильную часть и проверяем
   * кандидатов по кнопке закрытия, а не по полному имени класса.
   */
  const PANEL_SELECTORS = [
    "div.border-border-medium.bg-surface-secondary.w-full.rounded-md.border",
    "div[class*='border-border-medium'][class*='bg-surface-secondary'][class*='rounded-md']",
  ];

  function skipCardButton() {
    for (const message of document.querySelectorAll('[data-agent-transcript-message="true"]')) {
      for (const button of message.querySelectorAll("button")) {
        if (!/^skip$/i.test(`${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`.trim())) continue;
        if (!visible(button)) continue;
        // Skip внутри группы вариантов — это вопрос агента, а не плашка.
        // Один клик закрыл бы сразу весь опросник, и остальные вопросы исчезли
        // бы, не попав ни в журнал, ни в журнал попытки (24.10, NAR-1.12).
        if (button.closest?.('[role="radiogroup"]')) continue;
        return button;
      }
    }
    return null;
  }

  /**
   * Плашка «Эта задача была выполнена успешно?» — опрос внизу чата.
   *
   * Мастер: пока она на экране, задача не выполняется — Arena не показывает
   * этот опрос во время работы. И она перекрывает поле ввода, поэтому её
   * закрывает скрипт, а не человек.
   */
  const COMPLETION_TEXT = /эта задача была выполнена успешно|was this task completed successfully|did this task complete successfully/i;

  function completionPlaque() {
    for (const panel of completionPanels()) {
      if (!COMPLETION_TEXT.test(panel.textContent || "")) continue;
      // Контейнер с целым чатом под этот селектор тоже попадает: плашкой он не
      // становится, и «закрывать» его кнопкой шапки нельзя.
      if (panel.querySelector('[data-agent-transcript-message="true"]')) continue;
      return panel;
    }
    return null;
  }

  /** Кандидаты в панель завершения: объединение обоих селекторов, без скрытых. */
  function completionPanels() {
    const found = new Set();
    for (const selector of PANEL_SELECTORS) {
      for (const panel of document.querySelectorAll(selector)) if (visible(panel)) found.add(panel);
    }
    return [...found];
  }

  /**
   * Кнопка закрытия панели. Приоритет — явная подпись (`Close review panel`,
   * `Close`, `Закрыть`), затем последняя кнопка шапки, затем единственная.
   */
  function closeButtonIn(panel) {
    // Раскрывашки (`aria-expanded`) — не закрытие: клик по ним сворачивает
    // панель, а не убирает её, и снаружи это выглядит как «плашка вернулась».
    const buttons = [...panel.querySelectorAll("button")].filter(
      (b) => b.getAttribute("aria-expanded") === null,
    );
    const labelled = buttons.find((b) =>
      /close|dismiss|закрыть|скрыть/i.test(
        `${b.getAttribute("aria-label") || ""} ${b.getAttribute("title") || ""} ${b.textContent || ""}`,
      ),
    );
    const header = panel.querySelector(".flex.items-center.justify-between");
    const inHeader = [...(header?.querySelectorAll("button") || [])];
    return labelled || inHeader.at(-1) || (buttons.length === 1 ? buttons[0] : null);
  }

  /** Панель завершения: та же кнопка, что в dispatch.user.js (шапка, затем подпись). */
  function closeCompletionPanel() {
    const captcha = captchaDialog();
    const panels = completionPanels();
    for (const panel of panels) {
      // Окно проверки не плашка: его кнопки нажимает человек, а не скрипт.
      if (captcha && (panel === captcha || panel.contains(captcha))) continue;
      const close = closeButtonIn(panel);
      if (close && visible(close)) {
        close.click();
        return "closed";
      }
    }
    return panels.length ? "blocked" : "none";
  }

  /**
   * Убрать все панели завершения, а не одну.
   *
   * 24.10 в 20:15 шаг встал на «поле ввода пропало»: плашка «Эта задача была
   * выполнена успешно?» закрылась и тут же появилась снова. Клик был не при
   * чём — на странице две панели (одна в переписке, вторая липкая снизу), и
   * закрытие верхней просто показывало нижнюю. Поэтому закрываем все видимые
   * подряд, пока они не кончатся, и только потом ищем поле ввода.
   */
  async function closeCompletionPanels(max = 4) {
    let closed = 0;
    for (let pass = 0; pass < max; pass += 1) {
      const captcha = captchaDialog();
      const panels = completionPanels().filter(
        (panel) =>
          // Контейнер с целым чатом панелью не считается, окно проверки не наше.
          !panel.querySelector('[data-agent-transcript-message="true"]') &&
          !(captcha && (panel === captcha || panel.contains(captcha))),
      );
      if (!panels.length) break;
      let clicked = 0;
      for (const panel of panels) {
        const close = closeButtonIn(panel);
        if (close && visible(close)) {
          close.click();
          clicked += 1;
        }
      }
      if (!clicked) break;
      closed += clicked;
      // Пауза между проходами: вторая панель появляется после перерисовки.
      await sleep(350);
    }
    return closed;
  }

  /** Плашка любым способом: панель завершения, иначе карточка с Skip. */
  function closeCompletionPlaque() {
    const panel = closeCompletionPanel();
    if (panel !== "none") return panel;
    const skip = skipCardButton();
    if (skip) {
      skip.click();
      return "closed";
    }
    return "none";
  }

  // ───────────────────────────── опрос агента ─────────────────────────────

  /**
   * Опрос вместо ответа.
   *
   * 24.10 Kernel на середине NAR-1.12 остановился и выставил карточку с
   * вопросом «May I expand the write zone for this task?»: кнопки с вариантами,
   * свободное поле и `Skip`. Для цикла это конец хода без маркера — работа не
   * сдана, карточка висит в Running, ждать нечего.
   *
   * Отвечать за человека скрипт не берётся, но и молчать нельзя: он
   * перечисляет вопросы и варианты в журнал попытки и отправляет один и тот же
   * универсальный ответ. Он повторяет то, что и так написано в промпте: решай
   * сам в рамках Scope и запиши допущение. Такой ответ годится на любой вопрос
   * агента — про зону, про формат, про выбор из вариантов. `Skip` не годится:
   * он закрывает весь опросник разом, и остальные вопросы пропали бы бесследно.
   */
  const POLL_REPLY = "Реши сам в рамках Scope карточки и продолжай; допущение запиши в отчёт.";

  const buttonLabel = (b) =>
    `${(b && b.getAttribute && b.getAttribute("aria-label")) || ""} ${(b && b.textContent) || ""}`.trim();

  /** Текст вопроса: подпись группы, иначе заголовок карточки. */
  function pollQuestionText(group) {
    const label = String(group.getAttribute("aria-label") || "").trim();
    if (label) return label;
    const head = group.querySelector(".body-base, .body-sm");
    const text = String((head && (head.innerText || head.textContent)) || group.innerText || "");
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Вопросы в последнем ответе агента.
   *
   * Смотрим только последнее сообщение: отвеченные карточки прошлых ходов
   * остаются в транскрипте, и трогать их нельзя. В одном опросе может быть
   * несколько вопросов — у каждого своя группа `radiogroup`, свои варианты и
   * своё поле свободного ответа.
   */
  function pollQuestions(root = document) {
    const last = [...root.querySelectorAll('[data-agent-transcript-message="true"]')]
      .filter((n) => !n.querySelector('[data-user-message-layout="true"]'))
      .at(-1);
    if (!last) return [];
    const id = nodeId(last);
    const out = [];
    for (const group of last.querySelectorAll('[role="radiogroup"]')) {
      if (!visible(group)) continue;
      const buttons = [...group.querySelectorAll("button")];
      out.push({
        id,
        el: group,
        question: pollQuestionText(group),
        options: [...group.querySelectorAll('[role="radio"]')].map((b) =>
          String(b.innerText || b.textContent || "").replace(/\s+/g, " ").trim(),
        ),
        input: group.querySelector('input[type="text"], input:not([type])') || null,
        submit: buttons.find((b) => /submit custom response|отправить/i.test(buttonLabel(b))) || null,
        skip: buttons.find((b) => /^skip$/i.test(buttonLabel(b))) || null,
      });
    }
    return out;
  }

  /**
   * Записать текст в поле так, чтобы это увидел React.
   *
   * `input.value = …` меняет свойство экземпляра, а React читает сеттер
   * прототипа: без него кнопка Submit остаётся disabled и ответ не уходит.
   */
  function fillInput(input, value) {
    const doc = input.ownerDocument || document;
    const view = doc.defaultView || window;
    const set = (text) => {
      const proto = Object.getPrototypeOf(input);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      for (const name of ["input", "change"]) {
        input.dispatchEvent(new view.Event(name, { bubbles: true }));
      }
    };
    // Пустая строка перед текстом: если прошлая попытка уже оставила здесь
    // этот же текст, React не увидит изменения и не включит Submit.
    if (String(input.value || "")) set("");
    set(value);
  }

  /**
   * Ждём, пока условие станет истинным.
   *
   * После вставки текста карточка перерисовывается, и кнопка Submit оживает не
   * в тот же кадр: клик «одновременно с текстом» уходит в ещё выключенную
   * кнопку, а текст остаётся висеть в поле (24.10, 18:50).
   */
  async function pollWait(check, timeoutMs = 4000, stepMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = check();
      if (found) return found;
      await sleep(stepMs);
    }
    return check() || null;
  }

  // Снимок опроса сохраняется до Submit/Skip: после клика карточка может
  // исчезнуть, а сеть или сама вкладка — оборваться. Очередь живёт отдельно от
  // очереди ответов Notion и не зависит от текущей миссии или режима цикла.
  const POLL_JOURNAL_QUEUE = "cfn-poll-journal-queue";
  const POLL_JOURNAL_CAPTURE_MS = 300000; // после аварии незавершённый снимок тоже можно дописать

  /** Маркер совместим с обоими шлюзами: append разрешён только для CF_DISPATCH. */
  function pollLogEntry(role, questions, reply, expect = null, outcomes = [], at = nowIso(), attempt = 1) {
    const safePart = (value) => String(value || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 120);
    const hash = textHash(JSON.stringify(questions.map((q) => [q.id, q.question, q.options])));
    const marker = `<!-- CF_DISPATCH ${safePart(expect?.ref)}:${safePart(expect?.runId || expect?.turnId)}:poll:${hash}:${attempt} -->`;
    return [
      marker,
      `## Вопрос агента вместо работы (${(role && role.name) || "агент"})`,
      "",
      `- когда: ${at}`,
      `- универсальный вариант ответа: «${reply}»`,
      "- ответ человека не запрашивался; результат каждой попытки указан ниже",
      "",
      ...questions.flatMap((q, i) => [
        `### Вопрос ${i + 1}`,
        q.question || "(без текста)",
        "",
        ...(q.options.length ? q.options.map((o) => `- ${o}`) : ["- вариантов не было"]),
        `- результат при обработке: ${outcomes[i] || "не подтверждён"}`,
        "",
      ]),
    ].join("\n");
  }

  const pollJournalQueue = () => {
    const saved = GM_getValue(POLL_JOURNAL_QUEUE, []);
    return Array.isArray(saved) ? saved : [];
  };
  const samePollRecord = (a, b) => a && b && a.fileId === b.fileId && a.marker === b.marker;

  /** Сохраняем снимок до клика; старый не перезаписываем при новом проходе. */
  function queuePollJournal(record) {
    const list = pollJournalQueue();
    if (list.some((item) => samePollRecord(item, record))) return false;
    GM_setValue(POLL_JOURNAL_QUEUE, [...list, record]);
    return true;
  }

  /** После обработки можно записать фактический исход, не выдумывая успех. */
  function finishPollJournal(record, entry) {
    const list = pollJournalQueue();
    const index = list.findIndex((item) => samePollRecord(item, record));
    if (index < 0) return;
    list[index] = { ...list[index], entry: `\n\n${entry}\n`, readyAt: 0 };
    GM_setValue(POLL_JOURNAL_QUEUE, list);
  }

  let pollJournalBusy = false;
  /**
   * Отдельный повтор записи, никогда не повторяет Submit. Даже если шлюз уже
   * записал файл, но ответ потерялся, его маркер превращает повтор в duplicate.
   * Читаем очередь заново после каждого await, чтобы не затереть новые записи.
   */
  async function flushPollJournal() {
    if (pollJournalBusy) return;
    pollJournalBusy = true;
    try {
      const due = pollJournalQueue().filter((item) =>
        item && item.fileId && item.marker && item.entry &&
        Date.now() >= Number(item.readyAt || 0) && Date.now() >= Number(item.nextAt || 0),
      ).slice(0, 10);
      for (const item of due) {
        try {
          const result = await gateway("append", item.fileId, { marker: item.marker, entry: item.entry });
          if (!result || result.ok !== true) throw new Error("шлюз не подтвердил запись");
          GM_setValue(POLL_JOURNAL_QUEUE, pollJournalQueue().filter((row) => !samePollRecord(row, item)));
          const duplicate = result.duplicate || result.result === "duplicate";
          log(
            `${item.roleName}: вопрос и варианты ${duplicate ? "уже были" : "записаны"} в журнале попытки.`,
            false,
            { ntfy: false },
          );
        } catch (e) {
          const list = pollJournalQueue();
          const index = list.findIndex((row) => samePollRecord(row, item));
          if (index < 0) continue;
          const attempts = (Number(list[index].attempts) || 0) + 1;
          const wait = Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
          list[index] = { ...list[index], attempts, nextAt: Date.now() + wait };
          GM_setValue(POLL_JOURNAL_QUEUE, list);
          if (attempts === 1) {
            log(
              `Вопрос агента не записался в журнал попытки: ${(e && e.message) || e}. ` +
                "Снимок сохранён в ScriptCat, запись повторится без повторного ответа агенту.",
              true,
              { ntfy: "quiet", title: "Relay: запись опроса отложена" },
            );
          }
        }
      }
    } finally {
      pollJournalBusy = false;
    }
  }

  let pollBusy = false;

  /**
   * Разобрать опрос: перечислить вопросы, ответить «Решай сам», записать в
   * журнал попытки.
   *
   * Возвращает `"answered"` (только что ответили), `"waiting"` (опрос уже
   * отвечен, агент ещё не продолжил) или `null` (опроса нет).
   */
  async function answerPolls(role, expect = null) {
    if (pollBusy) return "waiting";
    const found = pollQuestions();
    if (!found.length) return null;
    // Последняя реплика агента может быть старой, даже если ниже уже стоит
    // наше новое задание. Не отвечаем ей заново и не пишем в чужую попытку.
    const messageId = found[0].id;
    if (expect && messageId &&
        (messageId === expect.watermark || (Array.isArray(expect.seen) && expect.seen.includes(messageId)))) return null;
    const who = (role && role.name) || (expect && expect.roleName) || "агент";
    // Ключ — ход агента: повторный тик не отвечает на тот же вопрос дважды.
    // Метки 1.4.45 сюда не читаются: они ставились без проверки, что Submit
    // сработал, и на живом опросе Kernel заблокировали бы повтор.
    const key = `cfn-poll2:${(expect && (expect.runId || expect.turnId || expect.ref)) || location.pathname}`;
    const handled = new Set(GM_getValue(key, []));
    const pending = found.filter((q) => !handled.has(`${q.id}:${q.question}`));
    if (!pending.length) return "waiting";

    pollBusy = true;
    const all = pending.map(({ id, question, options }) => ({ id, question, options }));
    const outcomes = all.map(() => "не подтверждён");
    const at = nowIso();
    let journal = null;
    let journalAttempt = 1;
    try {
      const logId = expect && expect.logId;
      if (logId) {
        // Новая попытка ответить на тот же вопрос — отдельное событие с новым
        // исходом. Сетевые повторы этого события используют сохранённый маркер.
        const attemptKey = `${key}:journal-attempt`;
        journalAttempt = (Number(GM_getValue(attemptKey, 0)) || 0) + 1;
        GM_setValue(attemptKey, journalAttempt);
        const entry = pollLogEntry({ name: who }, all, POLL_REPLY, expect, outcomes, at, journalAttempt);
        journal = {
          fileId: logId,
          marker: entry.split("\n")[0],
          entry: `\n\n${entry}\n`,
          roleName: who,
          readyAt: Date.now() + POLL_JOURNAL_CAPTURE_MS,
          attempts: 0,
          nextAt: 0,
        };
        queuePollJournal(journal);
      } else {
        // Без привязки к достоверному ходу нельзя угадывать чужой Drive-файл.
        // Сохраняем то, что удалось прочитать, в панели для ручного переноса.
        log("Вопрос агента не записан в журнал попытки: нет ID журнала для этого хода. Вопрос и варианты ниже — для ручного переноса.", true, { ntfy: "quiet" });
        for (const q of all) {
          log(`Для ручного переноса: ${q.question || "(без текста)"} — варианты: ${q.options.join("; ") || "нет"}.`, false, { ntfy: false });
        }
      }
      // Вопросы перечисляются ДО ответа: после Submit карточка
      // перерисовывается, и остальные могли бы исчезнуть вместе с ней.
      for (const q of pending) {
        log(
          `${who} спросил вместо работы: «${firstLine(q.question, 200)}»` +
            `${q.options.length ? ` — вариантов ${q.options.length}` : ""}.`,
          false,
          { tone: "warn", ntfy: "quiet", title: "Relay: агент спросил" },
        );
      }
      let answered = 0;
      const failed = [];
      for (const [index, first] of pending.entries()) {
        // После Submit карточка перерисовывается: узлы вопроса уже отвязаны.
        // Поэтому перед каждым ответом берём живые узлы заново.
        const live = () => pollQuestions().find((x) => x.question === first.question) || null;
        const q = live();
        // Вопрос пропал — его уже закрыли, это не наша забота. Вопрос есть, а
        // свободного поля нет — ответить некуда, и это уже потеря.
        if (!q) {
          outcomes[index] = "карточка исчезла до подтверждения ответа";
          continue;
        }
        if (!q.input) {
          outcomes[index] = "нет поля для ответа";
          failed.push({ first, index });
          continue;
        }
        fillInput(q.input, POLL_REPLY);
        // Ответ считается ушедшим, только если поле перестало держать наш
        // текст или вопрос пропал из карточки. Иначе текст висит в поле, а
        // Submit остаётся выключенным — это и случилось 24.10 в 18:50.
        const sent = () => {
          const now = live();
          return !now || !now.input || String(now.input.value || "") !== POLL_REPLY;
        };
        let done = false;
        for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
          const button = await pollWait(() => {
            const now = live();
            return now && now.submit && now.submit.disabled === false && now.submit.isConnected !== false
              ? now.submit
              : null;
          }, attempt === 1 ? 4000 : 2000);
          if (button) button.click();
          if (await pollWait(() => (sent() ? true : null), 2000)) done = true;
          else if (attempt === 2 && q.input) {
            const view = (q.input.ownerDocument || document).defaultView || window;
            q.input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
            if (await pollWait(() => (sent() ? true : null), 1500)) done = true;
          }
        }
        if (done) {
          handled.add(`${first.id}:${first.question}`);
          // После Submit Arena может сразу перезагрузить вкладку: не ждём конца
          // остальных вопросов, чтобы не ответить на этот второй раз.
          GM_setValue(key, [...handled].slice(-25));
          answered += 1;
          outcomes[index] = "универсальный ответ отправлен";
        } else {
          outcomes[index] = "отправка ответа не подтверждена";
          failed.push({ first, index });
        }
        await sleep(300);
      }
      if (!answered && failed.length) {
        // Ни один ответ не ушёл. Опрос нельзя оставить висеть: он держит ход.
        // Skip закрывает сразу весь опросник, поэтому идём на него только
        // здесь — вопросы уже перечислены в журнале — и говорим, что теряем.
        const remaining = () => pollQuestions().filter((q) =>
          failed.some(({ first }) => first.id === q.id && first.question === q.question),
        );
        const skip = remaining().find((q) => q.skip && q.skip.disabled !== true && q.skip.isConnected !== false)?.skip;
        if (skip) {
          skip.click();
          const closed = await pollWait(() => (remaining().length ? null : true), 2500);
          for (const { first, index } of failed) {
            if (closed) handled.add(`${first.id}:${first.question}`);
            outcomes[index] = closed ? "нажат Skip, ответ не отправлен" : "Skip нажат, закрытие не подтверждено";
          }
          log(
            closed
              ? `${who}: ответ на вопрос не отправился — Skip закрыл опрос.`
              : `${who}: Skip нажат, но опрос не исчез. Закрытие не подтверждено; проверьте чат.`,
            true,
            { tone: "warn", ntfy: closed ? "quiet" : "loud", title: closed ? "Relay: опрос закрыт кнопкой Skip" : "Relay: опрос держит ход" },
          );
        } else {
          log(
            `${who}: ответ на вопрос не отправился, и Skip не нашёлся — опрос держит ход. ` +
              "Нажмите кнопку ответа в чате вручную.",
            true,
            { tone: "warn", ntfy: "loud", title: "Relay: опрос держит ход" },
          );
        }
      }
      GM_setValue(key, [...handled].slice(-25));
      if (answered) {
        log(
          `Ответил ${who} на опрос: «${firstLine(POLL_REPLY, 90)}» (вопросов ${answered}).`,
          false,
          { tone: "warn" },
        );
      }
      if (answered && expect && expect.runId) {
        const strikes = (Number(GM_getValue(`cfn-poll-count:${key}`, 0)) || 0) + 1;
        GM_setValue(`cfn-poll-count:${key}`, strikes);
        if (strikes >= C.pollPauseCount) {
          pause(
            `${who} спрашивает вместо работы ${strikes} раз за ход. Это не случайность: ` +
              "противоречие в карточке или в промпте. Проверьте Scope и зону записи, " +
              "затем нажмите «Продолжить».",
            { kind: "poll-loop", ref: (expect && expect.ref) || "", runId: (expect && expect.runId) || "" },
          );
        }
      }
      return answered ? "answered" : "waiting";
    } finally {
      try {
        if (journal) {
          finishPollJournal(journal, pollLogEntry({ name: who }, all, POLL_REPLY, expect, outcomes, at, journalAttempt));
        }
      } finally {
        pollBusy = false;
      }
      if (journal) await flushPollJournal();
    }
  }

  /**
   * Ждём появления редактора.
   *
   * Карточку закрываем только если редактора нет вовсе: она рисуется сверху,
   * но программный ввод и клик её не боятся. Прошлый цикл «закрыть → проверить
   * → закрыть заново» и давал мигание, которое видно глазом.
   */
  async function ensureComposer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let closed = 0;
    let polled = 0;
    while (Date.now() < deadline) {
      const editor = composer();
      if (editor) return { editor, closed, polled, overlay: false };

      // Панелей завершения может быть больше одной: закрытая верхняя
      // открывает нижнюю — снаружи это выглядит как «плашка вернулась».
      if (closed < 6 && completionPanels().length) {
        const n = await closeCompletionPanels();
        if (n) {
          closed += n;
          dbg("editor: поля ввода нет — убрал панели и жду", { closed });
          await sleep(600);
          continue;
        }
      }
      // Поле не находится, а в чате висит вопрос агента: отвечаем на него, а не
      // жмём Skip. K.expect здесь относится к ещё не отправленному заданию;
      // привязать старый опрос к его журналу было бы записью в чужую попытку.
      // Без достоверного ID answerPolls прямо предупредит и выведет снимок.
      if ((await answerPolls(null)) === "answered") {
        polled += 1;
        dbg("editor: ответил на вопрос агента");
        await sleep(700);
        continue;
      }
      await sleep(400);
    }
    return { editor: null, closed, polled, overlay: completionPanels().length > 0 };
  }

  /** Короткая диагностика, почему поле не нашлось: без неё остаётся гадать. */
  function composerDiagnostics() {
    const count = (selector) => document.querySelectorAll(selector).length;
    // Сколько кандидатов отброшено и по какой причине: без этого «не нашёл
    // поле ввода» не отличить от «нашёл, но исключил своим же фильтром».
    let droppedSidebar = 0;
    let droppedHidden = 0;
    let droppedOwn = 0;
    let droppedService = 0;
    // `textarea` в перечне не было, а зря: 25.10 в 14:57 диагностика
    // показывала «contenteditable 0, textarea 1», и по ней нельзя было
    // понять, чьё это поле — сайдбара, капчи или нашей же панели.
    for (const el of document.querySelectorAll(
      "textarea:not([readonly]), [contenteditable]:not([contenteditable='false']), .ProseMirror, [role='textbox']",
    )) {
      if (el.tagName === "INPUT") continue;
      if (isServiceField(el)) droppedService += 1;
      else if (inOwnPanel(el)) droppedOwn += 1;
      else if (inSidebar(el)) droppedSidebar += 1;
      else if (!visible(el)) droppedHidden += 1;
    }
    const parts = [
      `contenteditable ${count("[contenteditable]")}`,
      `textarea ${count("textarea")}`,
      `textbox ${count("[role='textbox']")}`,
      droppedSidebar ? `в сайдбаре ${droppedSidebar}` : "",
      droppedHidden ? `скрытых ${droppedHidden}` : "",
      droppedOwn ? `в своей панели ${droppedOwn}` : "",
      droppedService ? `служебных ${droppedService}` : "",
      `панель ${completionPanels().length}`,
      `skip ${count('[data-agent-transcript-message="true"] button') && skipCardButton() ? "да" : "нет"}`,
      `путь ${location?.pathname || "/"}`
    ].filter(Boolean);
    return parts.join(", ");
  }

  /** Ждём активную кнопку Send (ниже — единственная реализация). */
  /** Почему Send не нажимается: список кандидатов вокруг редактора. */
  function sendDiagnostics(editor) {
    const scope = editor?.closest?.("form") || document;
    return [...scope.querySelectorAll('button, [role="button"]')]
      .slice(0, 8)
      .map((b) => ({
        el: describe(b),
        labels: labelText(b).slice(0, 3),
        visible: visible(b),
        disabled: Boolean(b.disabled),
        ariaDisabled: b.getAttribute?.("aria-disabled") || "",
        covered: elementCovered(b),
      }));
  }

  /**
   * Нажатие Send с проверкой результата. Плашка возвращается на место после
   * закрытия (решает backend), поэтому кнопка может оказаться под оверлеем —
   * такой клик не доходит, и раньше мы всё равно писали «Задание отправлено».
   */
  /**
   * Ждём активную кнопку Send.
   *
   * Программный `button.click()` не проходит через оверлей — карточка клик не
   * ловит. Мешает другое: пока редактор не зарегистрировал ввод, кнопка
   * `disabled`, и клик по ней ничего не делает. Поэтому ждём именно активности.
   */
  async function waitForSendReady(editor, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    while (Date.now() < deadline) {
      const btn = sendButton(editor);
      if (btn) return btn;
      attempts += 1;
      if (attempts === 4 || attempts === 12) {
        // Половина времени ожидания прошла без активной кнопки: повторяем ввод.
        dbg("Send: кнопка неактивна, повторяю вставку текста", () => debugSendButton(editor));
        return null;
      }
      await sleep(250);
    }
    return null;
  }

  /**
   * Поле и кнопка отправки готовы принять клик.
   *
   * `sendButton()` уже отбрасывает `disabled`, поэтому «кнопки нет» и «кнопка
   * есть, но заблокирована» здесь — одно состояние: страница ещё не готова.
   */
  function sendReady(editor) {
    const live = editor && composerAlive(editor) ? editor : composer();
    if (!live) return { ok: false, why: "поле ввода не найдено" };
    const state = String(document.readyState || "");
    if (state && state !== "complete" && state !== "interactive") {
      return { ok: false, why: `страница грузится (${state})`, editor: live };
    }
    const btn = sendButton(live);
    if (!btn) return { ok: false, why: "кнопка Send ещё неактивна", editor: live };
    return { ok: true, btn, editor: live };
  }

  /**
   * Ждём активную кнопку Send, не снимая задание.
   *
   * 17:30:24 (25.10): два фиксированных ожидания по 1,5 и 3 с закончились
   * раньше, чем страница дорисовала транскрипт, и отказ ушёл в паузу с
   * откатом карточки. Ждать надо столько, сколько рисуется страница, а текст
   * в поле — возвращать, если его стёрла перерисовка.
   */
  async function waitSendReady(editor, text, timeoutMs = C.sendReadyMs) {
    const started = Date.now();
    // Пустая настройка не должна превращать ожидание в NaN: без числа
    // deadline был бы NaN, и кнопка считалась бы недоступной мгновенно.
    const deadline = started + (Number(timeoutMs) || 20000);
    let lastPrompt = 0;
    let told = false;
    while (Date.now() < deadline) {
      const probe = sendReady(editor);
      if (probe.ok) return probe.btn;
      if (probe.editor && Date.now() - lastPrompt > 1500) {
        lastPrompt = Date.now();
        writePrompt(probe.editor, text);
      }
      if (!told && Date.now() - started > 3000) {
        told = true;
        log("Страница дорисовывается: кнопка Send ещё неактивна — жду. Задание остаётся в очереди.");
      }
      await sleep(300);
    }
    return null;
  }

  /**
   * Отличительная строка задания: по ней видно, что в чат ушло именно это
   * сообщение, а не предыдущее. Первые строки промпта у всех заданий
   * одинаковые (технический блок), поэтому ключ берётся из строки с
   * `dispatch <id>` и `run <id>`.
   *
   * Ключ обязан быть своим у каждой ВЫДАЧИ, а не у карточки. 28.10 карточку
   * NAR-5.3 выдали второй раз («проверка ответа не прошла, выдаю заново»);
   * строка задания у обеих выдач начинается одинаково, а прежний ключ —
   * первые 90 знаков этой строки — обрезался раньше номера выдачи. Прошлое
   * сообщение с тем же ключом лежало в чате, проверка «моё сообщение уже в
   * чате» подтвердила отправку, которой не было (19:38:49: текст остался в
   * поле ввода). Поэтому в ключ идут оба номера: `dispatch` — карточка,
   * `run` — выдача; выдача у повторной отправки новая.
   */
  function sendKey(text) {
    const src = String(text || "");
    const lines = src.split("\n");
    const task = lines.find((l) => /Задача .*\(dispatch /.test(l));
    if (task) {
      const ids = task.match(/\(dispatch\s+([^,)]+)(?:,\s*run\s*([^)]*))?\)/i);
      if (ids) {
        const dispatch = String(ids[1] || "").trim();
        const run = String(ids[2] || "").trim();
        if (dispatch) return flat(`dispatch ${dispatch}${run ? `, run ${run}` : ""}`);
      }
      return flat(task).slice(0, 90);
    }
    // Напоминание отличается от задания первой строкой «1 из 2», «2 из 2».
    const reminder = lines.find((l) => /НАПОМИНАНИЕ/.test(l));
    if (reminder) return flat(reminder).slice(0, 90);
    // D-045: боевой промпт начинается строкой «Карточка «…» · dispatch … ·
    // run …», а не «Задача … (dispatch …)». Без этой ветки ключа не было, и
    // доставкой заведовали первые 60 знаков — они обрезаются внутри dispatch id
    // и не доходят до номера выдачи: повторная выдача той же карточки получала
    // тот же ключ, ровно как в случае 28.10 19:38.
    const ids = promptDispatchIds(src);
    if (ids) return flat(ids.raw);
    // Ход Координатора опознаётся по номеру хода: он свой у каждого запроса.
    const turn = src.match(/"turn_id"\s*:\s*"([^"]+)"/);
    if (turn) return flat(turn[1]);
    // Короткое сообщение (напоминание, реплика) опознаётся целиком; длинный
    // промпт без опознавательных строк — нет, иначе ключом стал бы общий
    // технический блок.
    const plain = flat(src);
    return plain.length <= 120 ? plain : "";
  }

  /**
   * Dispatch/run из текста задания — во всех формах, которые реально уходят.
   *
   * D-045: компилятор печатает «Карточка «…» · dispatch … · run …»
   * (`identity.task`), минимальный повтор и продолжение — «IDs прежние:
   * dispatch_id=…, run_id=…» (`identity.continue`), строка плана и пример
   * маркера несут свои формы. Прежний разбор знал только скобочную
   * «Задача … (dispatch …, run …)», которой в промпте выдачи нет вовсе:
   * поиск своей реплики в чате не находил ничего, и восстановление по
   * реплике (D-044) молча не работало на боевом формате.
   *
   * `raw` — дословный совпавший кусок: он годится ключом доставки, потому что
   * действительно встречается в тексте сообщения.
   */
  function promptDispatchIds(text) {
    const src = String(text || "");
    const id = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    const shapes = [
      // «… · dispatch <id> · run <id>» и «… (dispatch <id>, run <id>)».
      new RegExp(`\\bdispatch\\s+${id}\\s*[·,]\\s*run\\s+${id}`, "i"),
      // «IDs прежние: dispatch_id=<id>, run_id=<id>.»
      new RegExp(`\\bdispatch_id\\s*=\\s*${id}\\s*,\\s*run_id\\s*=\\s*${id}`, "i"),
      // Пример маркера внутри промпта: {"dispatch_id":"<id>","run_id":"<id>"…}
      new RegExp(`"dispatch_id"\\s*:\\s*"${id}"\\s*,\\s*"run_id"\\s*:\\s*"${id}"`, "i"),
    ];
    for (const shape of shapes) {
      const hit = src.match(shape);
      if (hit) return { dispatch: hit[1], run: hit[2], raw: hit[0] };
    }
    return null;
  }

  /**
   * Ход приёмки, ответа на вопрос или арбитража — законная адресация роли с
   * функцией Reviewer, а не рабочая карточка.
   *
   * Вид хода ставит `sendToRole` в ожидание (`kind`), и пока ожидание живо,
   * верить надо ему: роль могли перевести из Executor в Reviewer уже после
   * постановки в очередь, а `roleFn` в записи остался прежним. 07.11 в 22:05
   * именно так ход приёмки, у которого не было только `sentAt`, попал в
   * проверку «адресат — Reviewer» и цикл встал до Мастера.
   */
  const REVIEW_TURN_KINDS = ["review", "answer", "arbiter"];
  const isReviewTurnKind = (kind) => REVIEW_TURN_KINDS.includes(String(kind || ""));

  /** Своё сообщение в транскрипте — независимо от того, как оно обёрнуто. */
  function userMessages() {
    const found = new Set();
    for (const el of document.querySelectorAll('[data-user-message-layout="true"]')) {
      found.add(el.closest('[data-agent-transcript-message="true"]') || el);
    }
    return [...found];
  }

  /** В чате уже есть наше сообщение с этой строкой? Это и есть доставка. */
  function lastUserSays(key) {
    if (!key) return false;
    const list = userMessages();
    const last = list.at(-1);
    if (!last) return false;
    // Сообщение, которое Arena съела ошибкой, осталось в транскрипте — но
    // агенту оно не ушло. Принять его за новую отправку значило бы снова
    // поверить в доставку, которой нет (25.10, 21:24).
    const dead = GM_getValue(K.deadSend, "");
    if (dead && nodeId(last) === dead) return false;
    return flat(last.textContent || "").includes(key);
  }

  /** id «своих» реплик в транскрипте — снимок до отправки. */
  function userNodeIds() {
    return userMessages()
      .map((node) => String(node.id || "").replace("chat-message-", ""))
      .filter(Boolean);
  }

  /**
   * Своё сообщение, которого до попытки отправки не было.
   *
   * `lastUserSays` отвечает на вопрос «в чате есть реплика с этой строкой», и
   * для доставки этого мало: ключ повторной выдачи совпадает с прошлой, а
   * прошлая реплика из транскрипта никуда не девается. 28.10 в 19:38 именно
   * так и вышло — проверка нашла СТАРОЕ сообщение, вернула «отправлено» через
   * секунду после вставки, текст остался в поле ввода, и цикл ждал ответа на
   * задание, которого агент не получал.
   *
   * Поэтому доставкой считается только реплика с id, которого нет в снимке
   * `known` (снимок снимается перед кликом). Две страховки:
   *  • сообщение, которое Arena съела ошибкой (`K.deadSend`), не в счёт;
   *  • реплика с явно старым id-временем не в счёт — так выглядит старый
   *    транскрипт, который доехал уже после снимка.
   */
  function userSaysSince(key, known, since = 0) {
    if (!key) return null;
    const seen = known instanceof Set ? known : new Set(known || []);
    const dead = GM_getValue(K.deadSend, "");
    const list = userMessages();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const node = list[i];
      const id = String(node.id || "").replace("chat-message-", "");
      if (!id || seen.has(id)) continue;
      if (dead && id === dead) continue;
      if (!flat(node.textContent || "").includes(key)) continue;
      // `idTime` — подсказка, а не истина: если генератор id не UUIDv7,
      // проверка просто не срабатывает. Допуск две минуты — время от вставки
      // текста до отрисовки сообщения бывает и таким.
      const at = idTime(id);
      if (since && at && at < since - 120000) continue;
      return { id, at };
    }
    return null;
  }

  /**
   * Ждём подтверждение доставки: новое своё сообщение в чате, а не «поле
   * опустело».
   *
   * Подтверждением не считаются ни выросший счётчик сообщений, ни пустое поле
   * при работающем агенте (1.4.82: 28.10, 19:08), ни реплика, лежавшая в чате
   * до попытки (1.4.84: 19:38 — повторная выдача той же карточки дала тот же
   * ключ, и старая реплика сошла за новую).
   *
   * Возвращает `{ id }` — id сообщения, которым подтверждена отправка: по нему
   * видно в журнале, что именно ушло. Пустая строка — доставка не доказана.
   */
  async function waitSent(key, known, timeoutMs, text = "", since = 0) {
    // Ожидание не должно стать бесконечным из-за пустой настройки: без числа
    // deadline был бы NaN, и опрос шёл бы вечно.
    const deadline = Date.now() + (Number(timeoutMs) || 6000);
    for (;;) {
      // Капча важнее любого признака: Arena успевает показать нашу реплику до
      // проверки, а до агента она не доходит. Признак «отправлено» в это
      // время — ложь, из-за которой 11:56:47 задание считалось ушедшим.
      if (captchaDialog()) return "";
      // Текст в поле ввода — veto: пока он там, отправки не было, какую бы
      // реплику ни нашлось в транскрипте.
      if (!composerHolds(key, text)) {
        const sent = userSaysSince(key, known, since);
        if (sent) return sent;
      }
      if (Date.now() >= deadline) return "";
      await sleep(300);
    }
  }

  /**
   * Текст задания всё ещё в поле ввода?
   *
   * Это второй признак доставки, и он нужен именно вместе с первым. 28.10 в
   * 19:08 скрипт написал «Задание отправлено (7829 символов)», а текст остался
   * в поле: клик по Send ушёл в перерисованное поле, сообщение не появилось, а
   * ожидание подтвердилось счётчиком сообщений (страница в этот момент
   * догружала транскрипт). Пока наш текст лежит в поле, отправки не было —
   * каким бы ни был счётчик.
   */
  function composerHolds(key, text) {
    const live = composer();
    if (!live) return false;
    const body = flat(composerText(live));
    if (!body) return false;
    const probe = flat(key || "").trim() || flat(text || "").slice(0, 60);
    if (!probe) return false;
    return body.includes(probe);
  }

  /**
   * Капча после «отправлено».
   *
   * 24.10 задание ушло в 13:47:03, а окно Security Verification всплыло в
   * 13:47:15 — через двенадцать секунд. К этому времени очередь уже была
   * снята, отметка доставки поставлена, и «Продолжить» после решения капчи
   * стало ждать ответа на сообщение, которого агент не получал.
   *
   * Поэтому успешная отправка подтверждается не сразу: короткий карантин, в
   * котором появление капчи отменяет её так же, как капча до клика.
   */
  async function captchaGuard() {
    const deadline = Date.now() + (Number(C.captchaGuardMs) || 8000);
    while (Date.now() < deadline) {
      if (captchaDialog()) return true;
      await sleep(400);
    }
    return Boolean(captchaDialog());
  }

  /** Enter в поле ввода: второй канал отправки, если клик не дошёл. */
  function pressEnter(editor) {
    if (!editor) return false;
    try {
      editor.focus();
      const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      for (const type of ["keydown", "keypress", "keyup"]) editor.dispatchEvent(new KeyboardEvent(type, opts));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Нажатие Send с проверкой появления своего сообщения.
   *
   * До 1.4.20 доставка подтверждалась косвенными признаками: счётчик сообщений
   * вырос, поле опустело или агент уже печатает. Каждый обманывает: счётчик
   * обновляется только после отрисовки, поле «пусто» у отвязанного узла от
   * прошлого рендера, а кнопка Stop бывает от прошлой генерации. 23.10 из-за
   * этого три клика прошли впустую: шаг встал на паузу «Send нажат, но
   * сообщение не появилось», хотя сказать, что именно не сработало, было
   * нельзя.
   *
   * Теперь подтверждение — само сообщение с отличительной строкой задания.
   * Поле и кнопка перечитываются из живого DOM перед каждой попыткой, а
   * ожидание длится `sendVerifyMs`: в фоновой вкладке браузер режет таймеры,
   * и одной секунды на отрисовку мало.
   */
  async function deliver(editor, text) {
    const before = messages().length;
    // Ключ доставки — отличительная строка задания. Если её нет (короткий
    // промпт без маркера), берём начало текста: без ключа подтвердить отправку
    // нечем, и «сообщение ушло» пришлось бы брать на веру.
    const key = sendKey(text) || flat(text).slice(0, 60);
    // Снимок «своих» реплик и время начала попытки. Доставка — это сообщение,
    // которого в снимке нет: старая реплика с тем же текстом (повторная выдача
    // той же карточки) доставкой не считается.
    const known = userNodeIds();
    const since = Date.now();
    let live = composerAlive(editor) ? editor : composer();
    dbg("Send: начало", () => ({
      messages: before,
      own: known.length,
      button: debugSendButton(live),
      textLength: composerText(live).length,
    }));

    const why = [];
    let clicked = 0;
    /**
     * Доставка доказана новым сообщением. Если поле при этом ещё держит текст,
     * второй раз не кликаем: Arena не всегда очищает поле сразу, а повторный
     * клик отправил бы то же задание дважды. Пишем об этом в журнал — пусть
     * Мастер видит, что поле осталось неубранным.
     */
    const accepted = (found) => {
      const holds = composerHolds(key, text);
      if (holds) {
        dbg("Send: новое сообщение есть, а текст ещё в поле", { id: found.id });
        log(
          `В чате появилось новое сообщение (${found.id}), но текст остался в поле ввода — повторно не отправляю, ` +
            "поле можно очистить вручную.",
          false,
          { ntfy: false, tone: "warn" },
        );
      }
      return { ok: true, via: "message", msgId: found.id, draftLeft: holds };
    };
    const blocked = () => ({
      ok: false,
      captcha: true,
      reason: "Появилась капча (Security Verification) — сообщение не ушло",
      detail: clicked ? `клик ${clicked}: вместо отправки окно проверки` : "окно проверки до клика",
    });
    if (captchaDialog()) return blocked();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Сообщение могло уйти с прошлой попытки — проверяем до нового клика.
      // Только новое сообщение: старая реплика с тем же ключом подтверждала
      // отправку, которой не было (28.10, 19:38).
      if (captchaDialog()) return blocked();
      const already = userSaysSince(key, known, since);
      if (already) {
        dbg("Send: сообщение уже в чате до клика", { id: already.id, attempt });
        return accepted(already);
      }

      // Узел редактора мог смениться при перерисовке чата: тогда и вставка,
      // и клик уходят в копию, которой уже нет в документе.
      if (!composerAlive(live)) {
        live = composer();
        if (!live) {
          // Плашка «задача выполнена» закрывает поле ввода и могла всплыть
          // между вставкой и кликом (24.10, 20:15). Убираем панели — но ждём
          // поле ВСЕГДА, даже если панелей не нашлось.
          //
          // 25.10 в 14:57 было иначе: панель на месте, кнопки закрытия в ней
          // нет, `closeCompletionPanels()` вернул 0 — и ожидание пропускалось.
          // Скрипт сдался через три секунды после вставки, хотя страница ещё
          // дорисовывала транскрипт (сообщений 0 → 15, contenteditable 0),
          // вернул карточку в Ready и встал на паузу. Работы по карточке не
          // было — виновата не отправка, а нетерпение.
          const panels = await closeCompletionPanels();
          if (panels) {
            log(`Поле ввода пропало посреди отправки: убрал панелей ${panels}.`);
            why.push(`поле ввода пропало — убрал панелей ${panels}`);
          }
          live = await waitFor(composer, C.composerGraceMs, 300);
          if (live) {
            dbg("Send: поле вернулось после перерисовки", { attempt, panels });
            writePrompt(live, text);
          }
        }
        dbg("Send: редактор перечитан", { found: Boolean(live), attempt });
        if (!live) {
          why.push("поле ввода пропало");
          break;
        }
      }

      // Ждём столько, сколько рисуется страница: кнопка Send появляется
      // активной только после того, как редактор зарегистрировал ввод.
      // Два коротких ожидания (1,5 и 3 с) кончались раньше, чем Arena
      // успевала смонтировать транскрипт.
      let btn = await waitSendReady(live, text);
      if (!btn) {
        why.push(
          `активной кнопки Send нет за ${Math.round((Number(C.sendReadyMs) || 20000) / 1000)} с (${composerDiagnostics()})`,
        );
        break;
      }

      // Текст мог пропасть вместе с перерисованным полем: тогда клик по Send
      // ничего не отправит. Проверяем перед каждым кликом.
      const probe = key || flat(text).slice(0, 40);
      if (probe && !flat(composerText(live)).includes(probe)) {
        dbg("Send: текст в поле пропал — вставляю заново", { attempt });
        if (!writePrompt(live, text)) {
          why.push("текст не удержался в поле ввода");
          break;
        }
        await sleep(300);
        const again = sendButton(live);
        if (!again) {
          why.push("после повторной вставки кнопки Send нет");
          break;
        }
        btn = again;
      }

      // Человек не отправляет через миллисекунду после ввода: даём паузу.
      await sleep(500 + Math.floor(Math.random() * 1200));
      const meanwhile = userSaysSince(key, known, since);
      if (meanwhile) {
        dbg("Send: сообщение появилось до клика", { id: meanwhile.id, attempt });
        return accepted(meanwhile);
      }
      if (!composerAlive(live)) {
        why.push(`клик ${attempt}: поле перерисовано`);
        continue;
      }
      // Кнопка пересчитывается в последний момент: за паузу DOM мог смениться.
      const latest = sendButton(live);
      if (!latest) {
        why.push(`клик ${attempt}: кнопка Send пропала`);
        break;
      }
      btn = latest;
      if (captchaDialog()) return blocked();
      dbg(`Send: клик ${attempt}`, () => debugSendButton(live));
      btn.click();
      clicked += 1;

      let via = await waitSent(key, known, C.sendVerifyMs, text, since);
      if (!via && attempt === 3) {
        // Последняя попытка: если клик не дошёл, отправляем с клавиатуры.
        dbg("Send: клик не дал сообщения — пробую Enter");
        pressEnter(live);
        via = await waitSent(key, known, C.sendVerifyMs, text, since);
      }
      if (via) {
        // Клик прошёл, но поверх чата висит проверка: сообщение могло не
        // дойти, даже если отрисовалось. Считаем отправку неудачной — ход
        // повторится после того, как человек решит капчу.
        if (captchaDialog()) return blocked();
        // Проверка не разовая: окно проверки всплывает через несколько секунд.
        if (await captchaGuard()) return blocked();
        // Последняя проверка перед словом «отправлено»: текст задания не
        // должен остаться в поле ввода. 19:08 он там остался, а журнал сказал,
        // что задание ушло (7829 символов) — и цикл ждал ответа впустую.
        //
        // Но новое сообщение — сильнее поля: если в чате появилась реплика,
        // которой до попытки не было, отправка состоялась, а текст в поле —
        // черновик, который Arena не убрала. Повторный клик отправил бы то же
        // задание второй раз, поэтому здесь мысль не «нажмём ещё», а «скажем
        // об этом в журнале».
        if (composerHolds(key, text)) {
          const fresh = userSaysSince(key, known, since);
          if (fresh && fresh.id === via.id) return accepted(fresh);
          why.push(`клик ${attempt}: текст остался в поле ввода`);
          dbg("Send: текст в поле после клика — отправки не было", { attempt });
          await sleep(500);
          continue;
        }
        dbg("Send: сообщение в чате", { via, attempt });
        return { ok: true, via: "message", msgId: via.id || "" };
      }
      if (captchaDialog()) return blocked();

      // Не дошло. Карточка могла появиться между вставкой и кликом — убираем
      // её один раз и повторяем; гоняться за ней циклом смысла нет.
      const plaque = closeCompletionPlaque();
      dbg("Send: сообщение не появилось", { plaque, attempt });
      why.push(plaque === "none" ? `клик ${attempt} без следа` : `клик ${attempt}: закрыл плашку`);
      await sleep(500);
    }

    // Капча могла появиться уже после кликов — в ожидании доставки. Тогда
    // причина отказа именно она, а не «кнопка не нашлась»: от неё зависит,
    // снимать ли очередь (её не снимаем — ждём человека).
    if (captchaDialog()) return blocked();

    const now = composer();
    const button = now ? sendButton(now) : null;
    const dialog = openDialog();
    dbg("Send: кандидаты у поля", () => ({ dialog: Boolean(dialog), candidates: sendDiagnostics(now) }));
    const detail = [
      `поле ${now ? (composerAlive(now) ? "в документе" : "отвязано") : "не найдено"}`,
      `в поле ${now ? composerText(now).length : "—"} симв.`,
      `кнопка ${button ? `«${String(labelText(button)[0] || "").slice(0, 28)}»` : "не найдена"}`,
      `сообщений ${before} → ${messages().length}`,
      `своих ${userMessages().length}`,
      `панелей ${completionPanels().length}`,
      ...(dialog ? ["поверх чата открыт диалог Arena"] : []),
      ...why,
    ].join(", ");
    const report = domReport();
    GM_setValue("cfn-send-debug", { at: Date.now(), detail, key, text: String(text).slice(0, 300), report });
    console.warn("[Relay] снимок разметки при отказе отправки:", report);
    return {
      ok: false,
      // Ни одного клика и поля ввода нет — это не отказ доставки, а
      // недорисованная страница. Задание осталось в очереди, ход не начат:
      // откат карточки и пауза тут дороже, чем ещё один тик ожидания.
      // Клика не было вовсе — сообщение никуда не ушло, и виновата не
      // доставка, а недорисованная страница: поле есть, кнопка ещё `disabled`,
      // транскрипт монтируется. Задание остаётся в очереди до `sendRetries`.
      retry: clicked === 0,
      // Без единого клика причина другая: кнопка не нашлась, а не «нажали
      // и ничего не вышло». Смешивать их нельзя — по причине чинят.
      reason: clicked
        ? "Send нажат, но своё сообщение в чате не появилось"
        : "Кнопка Send неактивна или не найдена — редактор не принял текст",
      detail,
    };
  }

  /** Короткий хеш текста: нужен, чтобы не отправить одно и то же дважды. */
  function textHash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h);
  }

  async function sendToRole(role, input, kind, ref, extra = {}) {
    // Адаптеры передают envelope компилятора; null означает, что компиляция
    // не прошла и пауза уже поставлена — в Arena ничего не уходит.
    if (input == null) return false;
    const envelope = typeof input === "object" && input && typeof input.text === "string" ? input : null;
    const text = envelope ? envelope.text : String(input);
    if (!text.trim()) return false;
    if (typeof projectRoleAllowed === "function" && !projectRoleAllowed(role)) return false;
    // Ранее выданную Reviewer карточку можно завершить и напомнить о маркере,
    // но новой рабочей выдачи через общий транспорт быть не должно.
    if (kind === "dispatch" && (role.fn === "Reviewer" || norm(role.name) === norm("Warden"))) {
      const previous = GM_getValue(K.expect, null);
      const reminder = extra.isDispatchReminder === true && previous?.kind === "dispatch" &&
        Number(previous.sentAt) > 0 && previous.verified === true && norm(previous.roleId) === norm(role.id) &&
        norm(previous.ref) === norm(ref) && previous.runId && norm(previous.runId) === norm(extra.runId);
      if (!reminder) {
        log(`«${role.name}» — Reviewer: обычные карточки ему не выдаются; приёмка и вопросы идут отдельно.`, true, { ntfy: "quiet" });
        return false;
      }
    }
    const force = extra.force === true;
    const payload = { ...extra };
    delete payload.force;

    // Двойная обработка одного ответа (нажали «Шаг» дважды, сработал
    // автоцикл) отправляла агенту второй такой же текст. Агент отвечал на
    // него ещё раз, и чат превращался в переписку с самим собой.
    const last = GM_getValue(K.lastSend, null);
    if (!force && last && norm(last.roleId) === norm(role.id) && last.hash === textHash(text)) {
      const ageSec = Math.round((Date.now() - Number(last.at || 0)) / 1000);
      if (ageSec < 300) {
        log(
          `Такое же сообщение уже уходило «${role.name}» ${ageSec} с назад — не дублирую, жду ответа.`,
          true,
        );
        return false;
      }
    }
    GM_setValue(K.lastSend, { roleId: role.id, hash: textHash(text), at: Date.now() });

    // Снимок цели выдачи: репозиторий сессии роли, целевой репозиторий работы
    // или проверки и его базовая ветка. По умолчанию цель — репозиторий сессии
    // роли (Executor работает в своём, аудитор может проверять чужой через
    // extra.targetRepo/extra.targetBranch; полный URL PR тоже называет репозиторий).
    const sessionRepo = profileSessionRepo(role.id);
    const targetRepo = (payload && payload.targetRepo) || sessionRepo || C.repo;
    const targetBranch = (payload && payload.targetBranch) || profileRepoBranch(targetRepo);

    // D-045: ожидание пишется ДО очереди. Записи GM уходят в хранилище
    // асинхронно, и навигация обрезает хвост пачки. При прежнем порядке
    // выживала очередь без ожидания — она отправляла задание и оставляла
    // цикл без хозяина хода. Теперь усечение теряет очередь, а ожидание
    // остаётся: такой ход разбирается штатной уборкой фантомов.
    // Снимок «план уже с замечаниями» переживает напоминание: иначе повтор
    // промпта по тому же плану теряет признак, и следующий шаг снова смотрит
    // на время правки карточки — ровно то, из-за чего 06.11 ушёл второй план.
    // D-053: дело арбитража переживает напоминание и продолжение — арбитр
    // должен видеть те же факты, что и в первом промпте, а не пустую карточку.
    const arbiterCarry = kind === "arbiter" && extra.arbiter ? { arbiter: extra.arbiter } : {};
    const previousPlan = GM_getValue(K.expect, null);
    const planCarry = kind === "plan" && previousPlan && previousPlan.kind === "plan" &&
      norm(previousPlan.ref) === norm(ref) && "planBeforeReturn" in previousPlan
      ? { planBeforeReturn: previousPlan.planBeforeReturn }
      : {};
    GM_setValue(K.expect, {
      roleId: role.id,
      roleName: role.name,
      roleUrl: role.url,
      roleFn: role.fn || "",
      kind,
      ref,
      watermark: lastMessageId(),
      // Снимок id на момент выдачи: водяной знак может исчезнуть из разметки
      // при перерисовке транскрипта, а «после отправки» должно остаться верным.
      seen: messages().map(nodeId).slice(-40),
      at: Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      // Текст нужен, чтобы повторить отправку, если клик по Send не дошёл.
      text,
      prompt: envelope || null,
      ...arbiterCarry,
      ...planCarry,
      ...payload,
      sessionRepo,
      targetRepo,
      targetBranch,
    });
    if (envelope) {
      recordPromptAttempt(envelope, { kind, ref, role: role.name, attempt: payload.attempt || 1, outcome: "queued" });
    }
    // Очередь несёт опознавательные данные хода: если запись ожидания всё же
    // потеряется, оно восстанавливается по ним со сверкой Notion, а не
    // угадывается по тексту письма.
    GM_setValue(K.pending, {
      roleId: role.id,
      roleName: role.name,
      roleUrl: role.url,
      roleFn: role.fn || "",
      kind,
      ref,
      runId: payload.runId || "",
      missionId: payload.missionId || "",
      turnId: payload.turnId || "",
      questionId: payload.questionId || "",
      logId: payload.logId || "",
      title: payload.title || "",
      url: payload.url || "",
      sessionRepo,
      targetRepo,
      targetBranch,
      text,
      at: Date.now(),
    });
    dbg("sendToRole: задание в очереди", { role: role.name, kind, ref, длина: text.length });
    GM_setValue("cfn-me", role.name);
    setStatus();

    // Если адресат — текущая страница, перезагружать её незачем: чат уже
    // открыт, и задание уйдёт со следующего тика (человек видит, что кнопка
    // сработала, без мигания страницы).
    let same = false;
    try {
      same = new URL(role.url, location.href).pathname === location.pathname;
    } catch {
      same = false;
    }
    if (same) {
      log(`«${role.name}» уже открыт — отправляю задание здесь.`);
      setTimeout(() => tick(false), 400);
    } else {
      log(`Перехожу к «${role.name}», чтобы отправить задание.`);
      // Уход со страницы — только после подтверждения записи (D-045).
      await flushBeforeNavigate(handoffKeys());
      location.assign(role.url);
    }
    return true;
  }

  /** Перейти на страницу роли без задания: используется для возврата хода. */
  async function goTo(role) {
    GM_setValue(K.pending, null);
    GM_setValue("cfn-me", role.name);
    setStatus();
    await navigateTo(role, "туда возвращается ход");
  }

  // Одно и то же ожидание не должно заливать журнал каждые пару секунд.
  let pendingNoticeAt = 0;
  // Отказы вставки считаются подряд: плашка или поздняя отрисовка проходят
  // следующим тиком через 15 секунд, и будить Мастера из-за них незачем.
  let insertFail = { at: 0, count: 0 };
  const pendingSay = (pending, text, error = false) => {
    if (pendingNoticeAt === pending.at) return;
    pendingNoticeAt = pending.at;
    log(text, error);
  };

  /**
   * D-044: квитанция подтверждённой доставки живёт отдельно от `expect`.
   *
   * K-30 (05.11, 23:28–23:35): журнал зафиксировал «Задание отправлено»
   * с id сообщения, агент закончил ход и прислал маркер этой выдачи, но
   * позднее `expect.sentAt` оказался пуст — и уборка фантомов вернула
   * карточку в Ready со словами «работы не было». Отсутствие локальной
   * отметки не доказывает отсутствие доставки: запись ожидания могла быть
   * перезаписана/потеряна после подтверждения. Поэтому факт «сообщение
   * найдено в чате» сохраняется отдельной квитанцией до снятия очереди.
   */
  const DELIVERY_RECEIPT_KEY = "cfn-delivery-receipts-v1";
  function handoffReceiptKey(expect) {
    return [
      expect?.kind || "", norm(expect?.ref), norm(expect?.runId),
      norm(expect?.turnId), norm(expect?.questionId), norm(expect?.roleId),
    ].join("|");
  }
  function recordDeliveryReceipt(expect, delivery) {
    if (!expect || !delivery?.messageId) return;
    const key = handoffReceiptKey(expect);
    const prior = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    const list = Array.isArray(prior) ? prior.filter((item) => item && item.key !== key) : [];
    list.push({
      key,
      kind: expect.kind || "", ref: expect.ref || "", runId: expect.runId || "",
      turnId: expect.turnId || "", questionId: expect.questionId || "",
      roleId: expect.roleId || "", messageId: delivery.messageId,
      sentAt: Number(delivery.sentAt) || Date.now(),
      watermark: delivery.watermark || delivery.messageId,
      seen: Array.isArray(delivery.seen) ? delivery.seen.slice(-40) : [],
    });
    GM_setValue(DELIVERY_RECEIPT_KEY, list.slice(-100));
  }
  function deliveryReceipt(expect) {
    if (!expect) return null;
    const key = handoffReceiptKey(expect);
    const list = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    const hit = (Array.isArray(list) ? list : []).find((item) =>
      item && item.key === key && item.messageId && Number(item.sentAt) > 0 &&
      (!expect.roleId || norm(item.roleId) === norm(expect.roleId)));
    return hit || null;
  }
  /** Намеренный отказ доставки (капча/ошибка Arena/повтор) гасит квитанцию. */
  function forgetDeliveryReceipt(expect) {
    if (!expect) return;
    const key = handoffReceiptKey(expect);
    const prior = GM_getValue(DELIVERY_RECEIPT_KEY, []);
    if (!Array.isArray(prior) || !prior.some((item) => item && item.key === key)) return;
    GM_setValue(DELIVERY_RECEIPT_KEY, prior.filter((item) => item && item.key !== key));
  }

  /** Своя реплика именно этой выдачи в открытом чате адресата. */
  function dispatchPromptInChat(expect) {
    if (!expect || expect.kind !== "dispatch" || !isUuid(expect.ref) || !isUuid(expect.runId) ||
        !expect.roleId || norm(roleFromPath()) !== norm(expect.roleId)) return null;
    // Капча/ошибка Arena могли оставить реплику в транскрипте, но ход не принять.
    // Такая реплика не доказывает доставку; квитанция к этому моменту погашена.
    if (expect.captcha === true || GM_getValue(K.pending, null)?.captcha === true) return null;
    const dead = GM_getValue(K.deadSend, "");
    const nodes = userMessages();
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const raw = messageRaw(nodes[i]);
      // D-045: разбор общий с ключом доставки. Скобочная форма «Задача …
      // (dispatch …, run …)» в промпте выдачи не встречается вовсе — прежний
      // regexp не находил ни одной боевой реплики, и восстановление по чату
      // было мертво именно там, где оно нужнее всего.
      const ids = promptDispatchIds(raw);
      if (!ids || norm(ids.dispatch) !== norm(expect.ref) || norm(ids.run) !== norm(expect.runId)) continue;
      const id = nodeId(nodes[i]);
      if (!id || (dead && id === dead)) continue;
      return { id, at: idTime(id) };
    }
    return null;
  }

  /**
   * Своя реплика хода приёмки в чате адресата.
   *
   * Приёмка миссии, ответ на вопрос и арбитраж не несут `dispatch_id`/`run_id` —
   * у них свой номер хода (`turn_id`), и именно он напечатан в тексте задания.
   * Без этой проверки `restoreMissingSendMark` умел доказывать доставку только
   * рабочей карточки: у хода приёмки доказательство не находилось никогда, и
   * `dropGhostHandoff` снимал живой ход как фантом. 07.11 в 22:05 цикл из-за
   * этого открыл страницу Warden и встал на «Очередь адресована Reviewer».
   */
  function reviewTurnInChat(expect) {
    const turnId = String(expect?.turnId || "");
    if (!isReviewTurnKind(expect?.kind) || !isUuid(turnId)) return null;
    if (!expect.roleId || norm(roleFromPath()) !== norm(expect.roleId)) return null;
    if (expect.captcha === true || GM_getValue(K.pending, null)?.captcha === true) return null;
    const dead = GM_getValue(K.deadSend, "");
    const nodes = userMessages();
    // Номер хода печатается двояко: строкой задания `turn_id: <id>` и внутри
    // примера маркера `"turn_id":"<id>"`. Оба вида — одна и та же выдача.
    const shape = new RegExp(`turn_id"?\\s*[:=]\\s*"?${turnId}\\b`, "i");
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (!shape.test(messageRaw(nodes[i]))) continue;
      const id = nodeId(nodes[i]);
      if (!id || (dead && id === dead)) continue;
      return { id, at: idTime(id) };
    }
    return null;
  }

  /**
   * Восстановить отметку отправки по квитанции или по самой реплике в чате.
   * Возвращает восстановленное ожидание либо null, если доказательств нет.
   */
  function restoreMissingSendMark(expect) {
    if (!expect || Number(expect.sentAt)) return expect || null;
    const receipt = deliveryReceipt(expect);
    const proof = receipt
      ? { messageId: receipt.messageId, sentAt: Number(receipt.sentAt), watermark: receipt.watermark, seen: receipt.seen, source: "квитанция доставки" }
      : (() => {
          const node = dispatchPromptInChat(expect) || reviewTurnInChat(expect);
          if (!node) return null;
          return {
            messageId: node.id, sentAt: node.at || Number(expect.at) || Date.now(),
            watermark: node.id, seen: expect.seen || [], source: "реплика задания в чате",
          };
        })();
    if (!proof) return null;
    const restored = {
      ...expect,
      sentAt: proof.sentAt,
      verified: true,
      watermark: proof.watermark || proof.messageId,
      seen: Array.isArray(proof.seen) ? proof.seen : (expect.seen || []),
      ...(expect.kind === "dispatch" && !expect.isDispatchReminder && !(Number(expect.tries) > 0)
        ? { dispatchSentAt: Number(expect.dispatchSentAt) || proof.sentAt }
        : {}),
    };
    GM_setValue(K.expect, restored);
    log(
      `Отметка отправки «${expect.title || expect.ref || expect.kind}» восстановлена: ${proof.source} ` +
        `(сообщение ${proof.messageId}). Карточку в Ready не возвращаю; читаю ответ этой выдачи.`,
      false,
      { ntfy: "quiet", title: "Relay: доставка восстановлена" },
    );
    return restored;
  }

  /**
   * Ожидание без отметки отправки — след прошлой попытки, а не ход.
   *
   * 24.10 в 16:35 карточка NAR-1.12 ушла в Running, а страница Arena упала до
   * отправки: сообщение в чат Kernel не попало. Через 34 минуты очередь
   * снялась, но карточку скрипт не тронул — он стоял не на странице адресата,
   * а откат статуса был привязан к ней. В Running карточка ждала ещё 11 минут
   * до `releaseStalled`, и всё это время Координатор видел «1 Running» и
   * выдавать её не мог.
   *
   * D-044: прежде чем объявить ход фантомом, ищем квитанцию доставки и саму
   * реплику этой выдачи в чате. Если доказательство есть — восстанавливаем
   * ожидание и не трогаем карточку. Настоящий фантом (нет ни квитанции, ни
   * реплики) по-прежнему возвращается в Ready.
   *
   * `ignoreQueue` — очередь уже признана просроченной и снимается этим же
   * шагом: тогда она не повод оставить карточку в Running.
   *
   * Возвращает `{ expect, rolled }`, если след был снят, иначе `null`.
   */
  async function dropGhostHandoff(why, { ignoreQueue = false } = {}) {
    const expect = GM_getValue(K.expect, null);
    if (!expect || Number(expect.sentAt)) return null;
    if (!ignoreQueue && GM_getValue(K.pending, null)) return null;
    if (restoreMissingSendMark(expect)) return null;
    const rolled = await releaseUndelivered(expect, why);
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    return { expect, rolled };
  }

  /** Уведомление и время относятся только к той очереди, что совпала с ходом. */
  function isDispatchAssignment(expect, pending, me) {
    return Boolean(expect && pending && expect.kind === "dispatch" && expect.ref && expect.runId &&
      !expect.isDispatchReminder && !(Number(expect.tries) > 0) && norm(expect.roleId) === norm(me) &&
      typeof expect.text === "string" && expect.text === pending.text);
  }

  /** Тихая веха только для подтверждённой доставки текущего хода карточки. */
  function dispatchDeliveryNtfy(expect, pending, me) {
    if (!isDispatchAssignment(expect, pending, me)) return { ntfy: false };
    return {
      ntfy: "quiet",
      title: "Relay: задание отправлено",
      ntfyText: `«${expect.title || expect.ref}» — задание отправлено в чат «${expect.roleName || "исполнителя"}».`,
      ntfyKey: `dispatch-sent:${expect.ref}:${expect.runId}`,
    };
  }

  /**
   * Очередь без ожидания — потерянный ход, а не новое задание.
   *
   * D-045 (06.11.2026): на K-27 запись `K.expect` не дожила до перехода на
   * страницу Executor Core, а `K.pending` дожил. Очередь отправила задание,
   * подтвердила его в чате — и обнаружила, что хозяина хода нет: пауза
   * `delivery-state-lost` при уже готовом ответе агента. Отправлять в таком
   * состоянии вслепую нельзя: это второй экземпляр той же работы.
   *
   * Порядок разбора: опознавательные данные очереди → карточка в Notion →
   * квитанция доставки или сама реплика в чате. Карточка совпала и сообщение
   * уже в чате — снимаем очередь и читаем ответ, ничего не отправляя. Карточка
   * совпала, а сообщения нет — восстанавливаем ожидание и отправляем ровно один
   * раз обычным путём. Не совпала или Notion недоступен — пауза без отправки.
   *
   * Разбираем только рабочие выдачи: план, приёмка и вопросы идут своим
   * порядком и в сверке по карточке не нуждаются.
   *
   * Возвращает true, если ход разобран здесь; false — можно продолжать.
   */
  /**
   * Очередь хода приёмки без ожидания — восстанавливается по номеру хода.
   *
   * D-045 научил сверять с карточкой рабочую выдачу, но приёмка миссии, ответ
   * на вопрос и арбитраж карточки не имеют: их опознавательный знак — `turn_id`,
   * который напечатан в самом задании. Без этой ветки потерянное ожидание
   * такого хода уходило в общую паузу «очередь без ожидания» с советом сверять
   * Run ID, которого не существует (07.11, 22:05).
   *
   * Порядок тот же, что у карточки: опознавательные данные очереди → страница
   * адресата → доказательство доставки по `turn_id` в чате. Доказано — очередь
   * снимаем и читаем ответ, ничего не отправляя. Не доказано — восстанавливаем
   * ожидание и отправляем ровно один раз обычным путём. Номер не читается —
   * пауза: угадывать здесь значит отправить ход второй раз.
   *
   * Возвращает true, если ход разобран здесь; false — можно продолжать.
   */
  /**
   * Адрес адресата очереди — для перехода на его страницу.
   *
   * Сверить чат можно только в чате: и подтверждение доставки, и сам ответ
   * живут на странице агента. Раньше переход брали из `roles()`, но она
   * отдаёт лишь активные роли, а очередь живёт дольше смены статуса; поэтому
   * берём строку базы по id, а кеш ролей — запасной путь. Пусто — адреса нет,
   * и тогда нужна пауза, а не тик, который повторяет «сейчас открою».
   */
  async function roleAddress(pending) {
    const id = String(pending?.roleId || "");
    if (!id) return null;
    const fromRow = (row) => (row && row.url
      ? { id: row.id, name: row.name || pending.roleName || "", url: row.url, fn: row.fn || pending.roleFn || "", status: row.status || "Активна" }
      : null);
    try {
      const rows = await roleRows().catch(() => []);
      const found = fromRow(rows.find((row) => row.id && norm(row.id) === norm(id)));
      if (found) return found;
    } catch {
      /* ниже пробуем кеш */
    }
    try {
      const active = await roles().catch(() => []);
      const found = fromRow(active.find((row) => row.id && norm(row.id) === norm(id)));
      if (found) return found;
    } catch {
      /* адреса нет */
    }
    const stored = pending.roleUrl
      ? { id, name: pending.roleName || "", url: pending.roleUrl, fn: pending.roleFn || "", status: "Активна" }
      : null;
    return stored;
  }

  async function adoptOrphanReview(pending, me) {
    if (GM_getValue(K.expect, null)) return false;
    const kind = String(pending.kind || "");
    if (!isReviewTurnKind(kind)) return false;
    const turnId = String(pending.turnId || "");
    const ref = String(pending.ref || "");
    if (!isUuid(turnId) || !isUuid(ref) || !pending.roleId) {
      pause(
        "В очереди остался ход приёмки без ожидания, и номер хода из него не читается. " +
          "Не отправляю и ничего не меняю: сверьте чат адресата и номер хода, затем продолжите вручную.",
        { kind: "orphan-review", ref, runId: "" },
      );
      return true;
    }
    // Сверять чат можно только на странице адресата — и открыть её обязан этот
    // же проход.
    //
    // 08.11, 17:45. Вопрос Координатора ушёл приёмке, ожидание хода не
    // записалось, в очереди остался `kind: answer`. Ветка говорила «открываю
    // страницу адресата» и возвращала true — а открывать было некому: строка
    // только писалась в журнал, цикл оставался на странице Координатора и на
    // каждом тике повторял тот же текст. Перехода не было ни разу, работа
    // встала на пять часов.
    if (!me || norm(me) !== norm(pending.roleId)) {
      const who = await roleAddress(pending);
      if (who) {
        pendingSay(pending, `Ход приёмки остался без ожидания: открываю «${who.name}», чтобы сверить чат по номеру хода.`);
        return navigateTo(who, "там ждёт ход приёмки без ожидания");
      }
      pause(
        `В очереди остался ход приёмки без ожидания, но адрес адресата «${pending.roleName || pending.roleId || "?"}» ` +
          "не читается из базы «Роли». Открыть чат для сверки не по чему: задание не отправляю и ничего не меняю. " +
          "Проверьте «Agent URL» этой роли и нажмите «Продолжить».",
        { kind: "orphan-review", ref, runId: "" },
      );
      return true;
    }
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Ход приёмки остался без ожидания; страница ещё грузится (${shell.why}) — сверю чат, когда она откроется.`);
      return true;
    }
    const restored = {
      roleId: pending.roleId,
      roleName: pending.roleName || "",
      roleUrl: pending.roleUrl || "",
      roleFn: pending.roleFn || "",
      kind,
      ref,
      runId: "",
      missionId: String(pending.missionId || ""),
      turnId,
      questionId: String(pending.questionId || ""),
      logId: String(pending.logId || ""),
      title: pending.title || "",
      url: pending.url || "",
      watermark: "",
      seen: [],
      at: Number(pending.at) || Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      text: pending.text,
      prompt: null,
      adoptedFromQueue: true,
    };
    if (restoreMissingSendMark(restored)) {
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      log(
        `Ход приёмки «${restored.title || ref}» восстановлен из очереди: доставка доказана номером хода. ` +
          "Отправку не повторяю — читаю ответ.",
        true,
        { ntfy: "quiet", title: "Relay: ход восстановлен" },
      );
      return true;
    }
    GM_setValue(K.expect, restored);
    log(
      `Ход приёмки «${restored.title || ref}» остался без ожидания, а сообщения в чате нет: ` +
        "ожидание восстановлено по очереди, отправляю его один раз обычным путём.",
      true,
      { ntfy: "quiet", title: "Relay: ход восстановлен" },
    );
    return false;
  }

  async function adoptOrphanDispatch(pending, me) {
    if (GM_getValue(K.expect, null)) return false;
    const text = String(pending.text || "");
    const isWork = pending.kind === "dispatch" || (/CF_AGENT_RESULT/.test(text) && /dispatch_id/.test(text));
    if (!isWork) return false;
    const ids = promptDispatchIds(text);
    const ref = String(pending.ref || ids?.dispatch || "");
    const runId = String(pending.runId || ids?.run || "");
    // Текст и поля очереди обязаны называть одну и ту же выдачу: расхождение
    // означает, что очередь собрана из разных попыток, и верить ей нельзя.
    if (!isUuid(ref) || !isUuid(runId) ||
        (ids && (norm(ids.dispatch) !== norm(ref) || norm(ids.run) !== norm(runId)))) {
      pause(
        "В очереди осталось задание без ожидания, и номер выдачи из него не читается. " +
          "Не отправляю и ничего не меняю: сверьте чат адресата, карточку и Run ID, затем продолжите вручную.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    let page;
    try {
      page = await notion("GET", `pages/${ref}`);
    } catch (e) {
      pause(
        `Не удалось прочитать карточку потерянного хода (${e.message}). Задание осталось в очереди, ` +
          "отправку не повторяю: без сверки это был бы дубль.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    const cardRun = rt(page.properties?.["Run ID"]);
    const owner = rt(page.properties?.["Recipient Agent ID"]);
    const cardMission = rt(page.properties?.["Mission ID"]).trim();
    const missionId = String(pending.missionId || cardMission).trim();
    const mismatch =
      taskState(page) !== "Running" ? `карточка в состоянии «${taskState(page) || "без состояния"}», а не Running`
        : !cardRun || norm(cardRun) !== norm(runId) ? "Run ID карточки не совпадает с очередью"
          : owner && norm(owner) !== norm(pending.roleId) ? "карточка выдана другому агенту"
            : !isUuid(cardMission) || !isUuid(missionId) ? "у хода нет корректного Mission ID"
              : norm(cardMission) !== norm(missionId) ? "Mission ID карточки не совпадает с очередью"
                : "";
    if (mismatch) {
      pause(
        `Задание без ожидания не сходится с карточкой: ${mismatch}. Очередь и карточку сохраняю, ` +
          "отправку не повторяю — нужна проверка Мастером.",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    const restored = {
      roleId: pending.roleId,
      roleName: pending.roleName || "",
      roleUrl: pending.roleUrl || "",
      roleFn: pending.roleFn || "",
      kind: "dispatch",
      ref,
      runId,
      missionId,
      logId: String(pending.logId || rt(page.properties?.["Output Drive File ID"])),
      title: pending.title || taskTitle(page),
      url: pending.url || page.url || "",
      sessionRepo: pending.sessionRepo || "",
      targetRepo: pending.targetRepo || "",
      targetBranch: pending.targetBranch || "",
      watermark: "",
      seen: [],
      at: Number(pending.at) || Date.now(),
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      text: pending.text,
      prompt: null,
      // Отметка нужна журналу: ход собран из очереди, а не выдан заново.
      adoptedFromQueue: true,
    };
    // Квитанция доставки проверяется с любой страницы; реплика в чате — только
    // на странице адресата. Порядок важен: доказанную выдачу нельзя потерять
    // из-за того, что вкладка стоит не там.
    if (restoreMissingSendMark(restored)) {
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      log(
        `Ход «${restored.title || ref}» восстановлен из очереди: доставка этой выдачи доказана. ` +
          "Отправку не повторяю — читаю ответ.",
        true,
        { ntfy: "quiet", title: "Relay: ход восстановлен" },
      );
      return true;
    }
    // Без доказательства судить по чату можно только со страницы адресата.
    // Очередь сохраняем, а страницу открываем здесь же: обещание «цикл сам
    // откроет» без самого перехода — это тик, который навсегда повторяет одну
    // и ту же строку (08.11, ход приёмки: пять часов на одном месте).
    if (!me || norm(me) !== norm(pending.roleId)) {
      const who = await roleAddress(pending);
      if (who) {
        pendingSay(pending, `Ход «${restored.title || ref}» потерял ожидание: открываю «${who.name}», чтобы сверить чат. Задание пока не отправляю.`);
        return navigateTo(who, "там ждёт ход без ожидания");
      }
      pause(
        `Ход «${restored.title || ref}» потерял ожидание, но адрес адресата ` +
          `«${pending.roleName || pending.roleId || "?"}» не читается из базы «Роли». ` +
          "Сверить чат не по чему: задание не отправляю, очередь и карточку сохраняю. " +
          "Проверьте «Agent URL» этой роли и нажмите «Продолжить».",
        { kind: "orphan-dispatch", ref, runId },
      );
      return true;
    }
    // Пустой транскрипт недорисованной страницы не доказывает, что реплики нет:
    // вывод «отправляю» делается только на отрисованной странице.
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Ход «${restored.title || ref}» потерял ожидание; страница ещё грузится (${shell.why}) — сверю чат, когда она откроется.`);
      return true;
    }
    GM_setValue(K.expect, restored);
    // Карточка только что сверена: это новая попытка отправки того же хода,
    // а не залежавшийся остаток. Иначе разбор просрочки снял бы очередь сразу.
    GM_setValue(K.pending, { ...pending, at: Date.now() });
    log(
      `Ожидание хода «${restored.title || ref}» было потеряно, но карточка Running и сообщения в чате нет. ` +
        "Восстановил ожидание по карточке; отправляю задание один раз, без нового хода Координатора.",
      true,
      { ntfy: "quiet", title: "Relay: ход восстановлен" },
    );
    return false;
  }

  /**
   * Досылает задание, сохранённое перед переходом на страницу адресата.
   *
   * Возвращает true, если ход этим и занят: отправлено, ждём редактор или ждём
   * конца ответа агента. Молчаливых выходов нет — каждый пишет в журнал,
   * иначе нажатый «Шаг» выглядит как неработающая кнопка.
   */
  async function consumePending(manual = false) {
    let pending = GM_getValue(K.pending, null);
    if (!pending) return false;
    const me = roleFromPath();
    const waitingForPolicy = GM_getValue(K.expect, null);
    // Очередь могла остаться от старого скрипта. Нельзя угадывать, не дошла ли
    // она до чата: не отправляем и не откатываем карточку/Run ID вслепую.
    // Напоминание к уже доставленной карточке — не новая выдача.
    const oldReminder = waitingForPolicy?.kind === "dispatch" && (
      waitingForPolicy.isDispatchReminder || (Number(waitingForPolicy.tries) > 0 &&
        Number(waitingForPolicy.dispatchSentAt) > 0 && waitingForPolicy.text === pending.text));
    const workPending = waitingForPolicy?.kind === "dispatch" && !oldReminder;
    const orphanPending = !waitingForPolicy;
    const orphanWork = orphanPending && /CF_AGENT_RESULT/.test(String(pending.text || "")) &&
      /dispatch_id/.test(String(pending.text || ""));
    // Рабочая карточка адресована роли с функцией Reviewer — отправку не
    // повторяем и карточку не трогаем. Это ровно про карточку: приёмка,
    // ответ на вопрос и арбитраж приходят тому же адресату по закону, и
    // путать их с рабочей выдачей нельзя (07.11, 22:05).
    // Вид хода известен из живого ожидания; если ожидание уже снято, остаётся
    // маркер, который ход просит вернуть. Нераспознанная очередь сохраняет
    // прежнее осторожное поведение — её не отправляем.
    const queueText = String(pending.text || "");
    const reviewQueue = isReviewTurnKind(waitingForPolicy?.kind) ||
      (!waitingForPolicy && /\bCF_(REVIEW|ANSWER|ARBITER)_RESULT\b/.test(queueText));
    if (workPending && (waitingForPolicy.roleFn === "Reviewer" ||
        norm(waitingForPolicy.roleName) === norm("Warden"))) {
      pause("В очереди осталась рабочая карточка Reviewer от прежней версии. Не отправляю её и не меняю карточку, очередь или ожидание: проверьте чат и Run ID.",
        { kind: "reviewer-task-pending", ref: waitingForPolicy.ref || "", runId: waitingForPolicy.runId || "" });
      return true;
    }
    if (workPending || orphanPending) {
      // Старые очереди без roleFn, псевдонимы с тем же URL и роли, изменившиеся
      // после постановки в очередь. На границе отправки нельзя верить кешу.
      if (workPending && norm(waitingForPolicy.roleId) !== norm(pending.roleId)) {
        pause("Ожидание и очередь адресованы разным агентам. Оба сохранены; проверьте чат и Run ID.",
          { kind: "reviewer-task-check", ref: waitingForPolicy.ref || "" });
        return true;
      }
      let owners;
      try {
        owners = (await roleRows({ fresh: true, requireFresh: true })).filter((r) => r.id && norm(r.id) === norm(pending.roleId));
      } catch (e) {
        pause(`Не удалось определить функцию адресата старой карточки (${e.message}). Отправка, очередь и карточка сохранены.`,
          { kind: "reviewer-task-check", ref: pending.roleId || "" });
        return true;
      }
      // Здесь стояло безусловное «Очередь адресована Reviewer» — и ход
      // приёмки, у которого потерялось ожидание, стоял до Мастера с советом
      // «проверьте чат», хотя ни карточки, ни Run ID у такого хода нет.
      if (!reviewQueue && owners.some((r) => r.fn === "Reviewer" || norm(r.name) === norm("Warden"))) {
        pause("Очередь адресована Reviewer. Проверьте чат и карточку: отправку не повторяю, очередь сохранена.",
          { kind: "reviewer-task-pending", ref: waitingForPolicy?.ref || "", runId: waitingForPolicy?.runId || "" });
        return true;
      }
      const valid = owners.some((r) => r.status === "Активна" && ["Executor", "Auditor"].includes(r.fn) &&
        (!waitingForPolicy?.roleFn || waitingForPolicy.roleFn === r.fn));
      // Ход приёмки не отправляем молча и не откатываем: карточки работы он
      // не несёт, а повтор выдал бы её второй раз. Дальше по шагу такой ход
      // разбирается своим порядком — сверка по карточке и чату, напоминание,
      // затем срок очереди; пауза Мастера здесь ничего не добавляет.
      if (!reviewQueue && (!owners.length || ((workPending || orphanWork) && !valid))) {
        pause("Адресат рабочей очереди не найден среди активных Executor/Auditor или его функция изменилась. Очередь сохранена.",
          { kind: "reviewer-task-check", ref: waitingForPolicy?.ref || "" });
        return true;
      }
    }

    // Ход приёмки без ожидания сверяется по номеру хода, а не по карточке:
    // карточки у него нет (D-055).
    if (await adoptOrphanReview(pending, me)) return true;

    // D-045: очередь без ожидания сперва сверяется с карточкой и чатом — и
    // ДО разбора просрочки. Потерянный ход K-27 пролежал бы в очереди часы:
    // прежний порядок снял бы его как «остаток прошлой попытки», хотя сообщение
    // было в чате и агент уже ответил. Отправка вслепую здесь означала бы
    // второй экземпляр той же работы.
    if (await adoptOrphanDispatch(pending, me)) return true;
    // Сверка могла обновить очередь (тот же ход, новая попытка отправки).
    pending = GM_getValue(K.pending, null) || pending;

    // Просроченная отправка — остаток прошлой попытки (в том числе от старой
    // версии скрипта). Задание до адресата не дошло, значит и ожидание маркера
    // бессмысленно: снимаем оба и продолжаем шаг, а не глотаем нажатие.
    const age = Date.now() - Number(pending.at || 0);
    // Неотправленное задание ждёт Мастера дольше: он узнаёт о паузе не сразу,
    // а очередь — это тот же ход, который не надо начинать заново.
    if (age > (pending.undelivered ? C.undeliveredTtlMs : C.pendingTtlMs)) {
      GM_setValue(K.pending, null);
      // Карточку возвращаем с любой страницы: отметки отправки нет, работы не
      // было, и ждать 45 минут `releaseStalled` ей незачем.
      const ghost = await dropGhostHandoff("очередь отправки просрочена", { ignoreQueue: true });
      // В ручном режиме шаг делает только нажатие: на загрузке страницы
      // ограничиваемся уборкой, а не отправкой плана за спиной Мастера.
      const act = manual || autoOn();
      const next = GM_getValue(K.expect, null)
        ? "Сообщение в чате есть — ожидание ответа оставлено."
        : ghost && ghost.rolled
          ? "Карточка возвращена в Ready — Координатор выдаст её заново."
          : act
            ? "Продолжаю шаг с чистого листа."
            : "Нажмите «Шаг», чтобы начать заново.";
      log(
        `Снял просроченную отправку из очереди (${Math.round(age / 60000)} мин): задание до адресата не дошло, ` +
          `это остаток прошлой попытки. ${next}`,
        true,
      );
      return !act;
    }

    // Страница ещё не отрисована: вставлять текст некуда, а «не нашёл поле»
    // на недогруженной странице — не повод откатывать карточку. Ждём тик.
    const shell = appReady();
    if (!shell.ok) {
      pendingSay(pending, `Страница ещё грузится (${shell.why}) — задание подождёт.`);
      return true;
    }

    if (!me || norm(me) !== norm(pending.roleId)) return false;

    // Задание, которое не ушло в прошлый раз. Карточку тогда вернули в Ready,
    // чтобы она не ждала 45 минут впустую, но текст остался в очереди:
    // «Продолжить» отправляет его этой же карточке и с тем же Run ID — новый
    // ход Координатора для этого не нужен (24.10, NAR-1.15).
    if (pending.undelivered) {
      const waiting = GM_getValue(K.expect, null);
      if (waiting && waiting.ref && waiting.runId) {
        let fresh = null;
        try {
          fresh = await notion("GET", `pages/${waiting.ref}`);
        } catch (e) {
          log(`Карточку «${waiting.ref}» не прочитать — отправку не начинаю: ${e.message}`, true);
          return true;
        }
        const state = taskState(fresh);
        if (state !== "Ready" && state !== "Running") {
          GM_setValue(K.pending, null);
          GM_setValue(K.expect, null);
          pause(
            `Задание не ушло, а карточка уже «${state || "без состояния"}» — повторную отправку отменяю.`,
            { kind: "send", ref: waiting.ref },
          );
          return true;
        }
        if (state === "Ready") {
          try {
            await patch(waiting.ref, {
              "Dispatch State": { select: { name: "Running" } },
              "Run ID": { rich_text: [{ type: "text", text: { content: waiting.runId } }] },
              "Recipient Agent ID": { rich_text: [{ type: "text", text: { content: pending.roleId } }] },
              "Started At": { date: { start: nowIso() } },
            });
            log("Карточка снова Running: отправляю задание из очереди, новый ход Координатора не нужен.");
          } catch (e) {
            log(`Карточка не вернулась в Running (${e.message}) — задание осталось в очереди.`, true);
            return true;
          }
        }
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, undelivered: false, cardRolled: false, sentAt: null, verified: false });
        GM_setValue(K.pending, { ...pending, undelivered: false, at: Date.now() });
      }
    }

    // Сообщение могло уйти, пока человек решал капчу. Тогда повторная
    // отправка была бы дублем: в чате уже есть эта реплика.
    // Ключ и снимок — те же, что при обычной отправке: доставкой считается
    // реплика, которой до выдачи не было, и только если текст не остался в
    // поле. Прошлая реплика с тем же ключом (повторная выдача карточки) —
    // по-прежнему не доказательство (28.10, 19:38).
    const captchaKey = sendKey(pending.text) || flat(pending.text).slice(0, 60);
    const captchaHandoff = GM_getValue(K.expect, null);
    const captchaKnown = Array.isArray(captchaHandoff?.seen) ? captchaHandoff.seen : null;
    const captchaSent =
      captchaKnown && !composerHolds(captchaKey, pending.text)
        ? userSaysSince(captchaKey, captchaKnown)
        : !composerHolds(captchaKey, pending.text) && lastUserSays(captchaKey)
          ? { id: "message" }
          : null;
    if (pending.captcha && !captchaDialog() && captchaSent) {
      const waiting = GM_getValue(K.expect, null);
      // Водяной знак не переписываем: он снят до отправки. Если за время
      // капчи агент успел ответить, последним сообщением окажется уже ответ —
      // и граница «после отправки» съела бы его целиком.
      if (waiting) {
        const sentAt = Date.now();
        GM_setValue(K.expect, {
          ...waiting, sentAt, verified: true, captcha: false,
          ...(isDispatchAssignment(waiting, pending, me) ? { dispatchSentAt: captchaKnown ? sentAt : 0 } : {}),
        });
      }
      GM_setValue(K.pending, null);
      pendingNoticeAt = 0;
      // Старое ожидание без снимка распознаётся по последней реплике только
      // ради совместимости. Для пуша о доставке нужно более сильное
      // подтверждение: новая реплика относительно снимка до отправки.
      log(
        "После капчи сообщение уже в чате — отправку не повторяю, жду ответа.",
        false,
        captchaKnown ? dispatchDeliveryNtfy(waiting, pending, me) : { ntfy: false },
      );
      return true;
    }

    // Один кадр ничего не доказывает: сразу после перехода Arena показывает
    // Stop на время загрузки транскрипта. Признак подтверждается вторым
    // чтением через секунду — так же, как это уже сделано для «Шага».
    const busy = await busySettled();
    if (busy) {
      pendingSay(
        pending,
        `Агент ещё отвечает: задание из очереди подождёт и уйдёт, как только он закончит (${busyLabel(busy)}).`,
      );
      return true;
    }

    // Капча висит поверх чата: ни вставлять, ни кликать некуда. Ждём человека.
    if (captchaDialog()) {
      captchaPause();
      return true;
    }

    // Ветка прошлого хода слита — сначала Continue, потом текст.
    //
    // 27.10 в 21:15 Архитектор слил PR #97 и записал ответ; Continue после
    // этого не нажалась (память о мерже была на карточку, а не на выдачу).
    // В 21:18 Координатор вернул ту же карточку в работу, задание ушло в чат со
    // старой веткой `arena/73b6f5a4-relay` — статус `pr_merged`. Агент
    // отказался работать («нажмите Continue»), маркера не прислал, и цикл встал
    // на маркер-паузу. Проверяем страницу сами: пока Continue видна, задание
    // отправлять некуда.
    await ensureFreshBranch("Задание в очереди");

    // Плашка «Эта задача была выполнена успешно?» закрывает поле ввода. Мастер
    // просит убирать её скриптом: человек не должен щёлкать по опросу, чтобы
    // цикл поехал дальше.
    //
    // Закрываем её ОДИН раз и только тогда, когда поле ввода правда не
    // находится. Прежняя попытка «закрыть заранее» не срабатывала (backend
    // возвращал плашку при перерисовке) и давала вторую такую же строку в
    // журнале — со счётчиком закрытий, который Мастер читал как сбой.
    const { editor, closed, overlay } = await ensureComposer();
    if (closed) log("Убрал плашку «задача выполнена» — она закрывала поле ввода.");
    if (!editor) {
      journalDelivery(GM_getValue(K.expect, null), "editor_not_found", "editor_not_found");
      pendingSay(
        pending,
        `Не нашёл поле ввода на странице адресата (${composerDiagnostics()}): задание осталось в очереди и не потеряется.` +
          (overlay ? " Поле перекрыто, а кнопки закрытия не видно — закройте плашку вручную." : ""),
        true,
      );
      setTimeout(() => tick(false), 5000);
      return true;
    }

    // Что было в поле, не важно: задание в очереди — это текущий ход. Но сначала
    // поле очищается: Arena возвращает туда отклонённый текст, и вставка поверх
    // склеила бы минимальное сообщение со старым промптом.
    if (composerText(editor)) {
      const cleared = clearComposer(editor);
      log(
        cleared
          ? "В поле ввода был текст (Arena возвращает туда отклонённое) — очистил перед вставкой задания."
          : "Поле ввода не очистилось — вставляю задание поверх: вставка заменяет текст целиком.",
        !cleared,
      );
    }

    // Не вставляем мгновенно после загрузки страницы: ровный машинный ритм
    // выглядит как бот и мешает живому диалогу.
    await sleep(450 + Math.floor(Math.random() * 900));
    if (!writePrompt(editor, pending.text)) {
      const dialog = openDialog();
      const report = domReport();
      GM_setValue("cfn-send-debug", { at: Date.now(), detail: "вставка не удалась", text: String(pending.text).slice(0, 300), report });
      console.warn("[Relay] снимок разметки при отказе вставки:", report);
      if (insertFail.at !== pending.at) insertFail = { at: pending.at, count: 0 };
      insertFail.count += 1;
      const attempt = insertFail.count;
      const hint = dialog ? " Поверх чата открыт диалог Arena — закройте его." : "";
      if (attempt === 1 || attempt >= C.insertRetries) {
        pendingNoticeAt = pending.at; // чтобы pendingSay не сказал то же второй раз
        log(
          attempt < C.insertRetries
            ? `Не удалось вставить задание в редактор — повторю через 15 секунд, задание в очереди.${hint}`
            : `Вставка не проходит ${attempt}-й раз: задание в очереди и само не уйдёт.${hint} Нажмите «Шаг».`,
          attempt >= C.insertRetries,
          attempt >= C.insertRetries ? {} : { ntfy: false },
        );
      }
      return true;
    }
    insertFail = { at: 0, count: 0 };
    await sleep(600);

    // Водяной знак — id последнего сообщения ДО отправки. На странице
    // отправителя он был бы чужим, и «ответ без маркера» нельзя было бы
    // отличить от старой переписки.
    const watermark = lastMessageId();
    const seen = messages().map(nodeId).slice(-40);
    const delivery = await deliver(editor, pending.text);
    // Капча — не обычный отказ: очередь не снимается, карточка не
    // откатывается, ждём человека. Отметки отправки при этом не появляется:
    // «откат отправки» и значит, что `sentAt` не ставится.
    if (delivery.captcha) {
      const waiting = GM_getValue(K.expect, null);
      journalDelivery(waiting, "captcha", "captcha");
      if (waiting) {
        forgetDeliveryReceipt(waiting);
        GM_setValue(K.expect, { ...waiting, captcha: true, sentAt: null, verified: false });
      }
      // Очередь остаётся, но с отметкой: после решения капчи сначала надо
      // посмотреть, не дошло ли сообщение всё-таки. Отсчёт TTL начинается
      // заново — человек решает капчу не за десять секунд.
      GM_setValue(K.pending, { ...pending, captcha: true, at: Date.now() });
      captchaPause();
      return true;
    }
    // Поле ввода не нашлось ни на одной попытке — страница ещё дорисовывается
    // (25.10, 14:57: шестнадцать секунд после перехода, транскрипт 0 → 15
    // сообщений, `contenteditable` в документе ноль). Клика не было, значит
    // работы по карточке нет: держим очередь, карточку не трогаем и повторяем
    // отправку следующим тиком. Пауза и откат в Ready — только когда ожидание
    // исчерпано, иначе Мастеру достаётся остановка из-за чужой перерисовки.
    if (delivery.retry) {
      const tries = Number(pending.sendTries || 0) + 1;
      if (tries <= C.sendRetries) {
        GM_setValue(K.pending, { ...pending, sendTries: tries, at: Date.now() });
        log(
          `Страница адресата ещё дорисовывается — повторю отправку через ${Math.round(C.tickMs / 1000)} с ` +
            `(попытка ${tries} из ${C.sendRetries}). Задание в очереди, карточка не тронута.`,
          false,
          { ntfy: false },
        );
        setTimeout(() => tick(false), C.tickMs);
        return true;
      }
      log(`Поле ввода не вернулось за ${C.sendRetries} попыток — останавливаюсь и жду Мастера.`, true);
    }

    if (!delivery.ok) {
      // Сообщение в чат не попало — работы по карточке нет, и в Running ей
      // делать нечего. Очередь снимается вместе со статусом: иначе ответ по
      // этой же карточке пришёл бы, когда она уже не Running, и
      // `submitExecutor` честно отказался бы его записывать.
      const failed = GM_getValue(K.expect, null);
      journalDelivery(failed, "failed", classifyArenaFailure(`${delivery.reason} ${delivery.detail || ""}`));
      const rolled = await releaseUndelivered(
        failed,
        `сообщение не ушло (${String(delivery.reason).toLowerCase()})`,
      );
      if (rolled) {
        // Ход НЕ снимаем: текст задания остаётся в очереди, и «Продолжить»
        // отправит его этой же карточке. Карточка возвращена в Ready только
        // затем, чтобы не висеть в Running 45 минут; перед отправкой она
        // снова станет Running с тем же Run ID.
        GM_setValue(K.pending, { ...pending, undelivered: true, sendTries: 0, at: Date.now() });
        if (failed) {
          forgetDeliveryReceipt(failed);
          GM_setValue(K.expect, {
            ...failed,
            undelivered: true,
            cardRolled: true,
            sentAt: null,
            verified: false,
          });
        }
        pendingNoticeAt = 0;
      }
      pause(
        `${delivery.reason}${delivery.detail ? ` (${delivery.detail})` : ""}. ` +
          (rolled
            ? "Задание осталось в очереди: нажмите «Продолжить» — оно уйдёт этой же карточке, " +
              "без нового хода Координатора."
            : "Задание осталось в поле ввода и в очереди: поправьте и нажмите «Продолжить»."),
        { kind: "send" },
      );
      return true;
    }
    const expect = GM_getValue(K.expect, null);
    // D-045: квитанция пишется и тогда, когда ожидание потеряно. Доставка
    // состоялась и подтверждена id сообщения — этот факт не должен зависеть
    // от того, дожила ли запись `K.expect` до перехода. Без квитанции пауза
    // `delivery-state-lost` оставляла Мастеру вручную искать доказательство,
    // которое скрипт только что держал в руках (K-27, 06.11).
    if (delivery.msgId && (!expect || norm(expect.roleId) !== norm(me))) {
      recordDeliveryReceipt(
        expect && norm(expect.roleId) === norm(me) ? expect : {
          kind: pending.kind || "dispatch",
          ref: pending.ref || expect?.ref || "",
          runId: pending.runId || expect?.runId || "",
          turnId: pending.turnId || "",
          questionId: pending.questionId || "",
          roleId: pending.roleId,
        },
        { messageId: delivery.msgId, sentAt: Date.now(), watermark: delivery.msgId || watermark, seen },
      );
    }
    // D-044: сообщение в чате есть, а ожидание потеряно/подменено — это не
    // «отправлено и можно забыть». Не снимаем очередь молча и не пишем успех:
    // нужна сверка, иначе следующий шаг потеряет ход или продублирует его.
    if (!expect || norm(expect.roleId) !== norm(me)) {
      pause(
        `Сообщение подтверждено в чате (${delivery.msgId || "id не получен"}), но ожидание выдачи ` +
          "потеряно или относится другому агенту. Очередь сохранена; автоматически не повторяю. " +
          "«Продолжить» сначала сверит чат и карточку и не отправит задание вторично; " +
          "кнопка ↺ снимает ход.",
        { kind: "delivery-state-lost", ref: expect?.ref || "", runId: expect?.runId || "" },
      );
      return true;
    }
    // Граница «после отправки» — id подтвердившего сообщения, а не последнего
    // перед отправкой: ответ агента читается строго после нашей реплики, и
    // старое сообщение с тем же текстом границу не сдвигает (1.4.84).
    // Если id не пришёл (старая ветка), остаётся прежний водяной знак.
    const mark = delivery.msgId || watermark;
    const sentAt = Date.now();
    // Квитанция пишется ДО снятия очереди: даже если запись `expect` позднее
    // потеряет `sentAt`, факт доставки этой выдачи останется проверяемым.
    if (delivery.msgId) recordDeliveryReceipt(expect, { messageId: delivery.msgId, sentAt, watermark: mark, seen });
    GM_setValue(K.expect, {
      ...expect, watermark: mark, sentAt, verified: true, seen,
      // sentAt обновляется также для напоминаний; отдельная отметка нужна
      // только для продолжительности работы и не управляет состоянием хода.
      ...(isDispatchAssignment(expect, pending, me) ? { dispatchSentAt: sentAt } : {}),
    });
    dbg("Send: доставка подтверждена, отметка внутри чата", { watermark: mark, via: delivery.via || "message" });
    journalDelivery(expect, "delivered");
    GM_setValue(K.pending, null);
    GM_setValue(K.deadSend, "");
    pendingNoticeAt = 0;
    // Длина — в журнал: по ней видно, какое сообщение Arena не приняла, и
    // сравнить его с коротким повтором (25.10: дважды на задании 2.16).
    // id сообщения — по той же причине: «отправлено» должно быть проверяемо,
    // иначе Мастеру остаётся верить журналу на слово (28.10, 19:38).
    log(
      `Задание отправлено (${String(pending.text || "").length} символов` +
        `${delivery.msgId ? `, сообщение ${delivery.msgId}` : ""}).`,
      false,
      dispatchDeliveryNtfy(expect, pending, me),
    );
    return true;
  }

  // ───────────────────── следы прошлых попыток (очистка) ─────────────────────
  /**
   * Хранилище ScriptCat не обнуляется при обновлении скрипта.
   *
   * Поэтому очередь и ожидание, записанные прошлой версией, «всплывали» уже
   * в новом запуске: шаг ссылался на отправку, которой не было, а журнал
   * выглядел так, будто скрипт помнит что-то постороннее. Начиная с 1.4.9
   * состояние помечается версией и после обновления снимается один раз.
   */
  function transientState() {
    return {
      pending: GM_getValue(K.pending, null),
      expect: GM_getValue(K.expect, null),
      last: GM_getValue(K.lastSend, null),
    };
  }

  /** Понятное описание того, что накопилось: без чтения кода. */
  function describeTransient(state) {
    const parts = [];
    if (state.pending) {
      parts.push(
        `очередь: «${state.pending.roleId}», ${String(state.pending.text || "").length} симв.`,
      );
    }
    if (state.expect) {
      parts.push(
        `ожидание: «${state.expect.roleName || state.expect.roleId}», ${state.expect.kind || "?"}` +
          (state.expect.sentAt ? "" : ", без отметки отправки"),
      );
    }
    if (state.last) parts.push("защита от повторов");
    return parts.join("; ");
  }

  /** Снять очередь, ожидание и защиту от повторов. Журнал и настройки не трогаем. */
  function resetState() {
    const state = transientState();
    GM_setValue(K.pending, null);
    GM_setValue(K.expect, null);
    GM_setValue(K.lastSend, null);
    GM_setValue("cfn-plan-at", 0);
    GM_setValue(K.step, false);
    GM_setValue(K.stateV, SCRIPT_VERSION);
    return { ...state, text: describeTransient(state) };
  }

  /** После обновления ни очередь, ни ожидание не считаются доказанным фантомом. */
  function migrateState() {
    const seen = String(GM_getValue(K.stateV, "") || "");
    if (seen === SCRIPT_VERSION) return "";
    GM_setValue(K.stateV, SCRIPT_VERSION);
    const expect = GM_getValue(K.expect, null);
    const pending = GM_getValue(K.pending, null);
    if (!expect && !pending) return "";
    const who = expect ? `«${expect.roleName || expect.roleId || "?"}», ${expect.kind || "?"}` : "очередь отправки";
    const message = `Обновление ${seen || "неизвестной версии"} → ${SCRIPT_VERSION}: сохранены ${who} и очередь. ` +
      "Проверьте доставку в чате, карточку и журнал до ручного продолжения; отсутствие sentAt не доказывает, что отправки не было.";
    GM_setValue(K.paused, message);
    GM_setValue(K.pause, { kind: "update-recovery", ref: expect?.ref || "", runId: expect?.runId || "", turnId: expect?.turnId || "" });
    log(message, false, { skip: true });
    return who;
  }

  /**
   * Кнопка ↺: снять ход, а не только память транспорта.
   *
   * 28.10 Мастер нажал ↺, когда задание не ушло. Очередь и ожидание в
   * хранилище снялись — а карточка NAR-5.3 осталась в Notion в Running.
   * Координатор увидел «1 Running», решил, что работа идёт, и выдал следующую
   * карточку; прежняя так и висела. Сброс, после которого карточка выглядит
   * выданной, — это не сброс, а потерянная работа.
   *
   * Поэтому теперь ↺ делает три вещи по порядку:
   *  1) возвращает в Ready карточку текущего хода (`releaseUndelivered`);
   *  2) чистит очередь, ожидание и защиту от повторов (`resetState`);
   *  3) возвращает в Ready все карточки, висящие в Running без хода, — в том
   *     числе оставшиеся от прошлых сбросов и обновлений (`sweepOrphans`).
   *
   * Отмена в диалоге не трогает ничего.
   */
  async function resetStateDialog() {
    const state = transientState();
    const what = describeTransient(state);
    const handoff = state.expect && state.expect.kind === "dispatch" && state.expect.ref ? state.expect : null;
    const cardLine = handoff
      ? `Карточка «${handoff.title || handoff.ref}» вернётся в Ready: сниму «Run ID» и «Started At», ` +
        "чтобы она не висела в Running без хода. Если агент ещё работает, его ответ придёт в чат уже без карточки."
      : what
        ? "Карточку текущего хода верну в Ready, если она висит в Running."
        : "";
    const plan = [
      what ? `Снять с транспорта: ${what}.` : "На транспорте пусто: очереди и ожидания нет.",
      cardLine,
      "Карточки миссии, которые висят в Running без хода, тоже вернутся в Ready.",
      "Журнал и настройки останутся.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const head = what ? "Снять ход?" : "Проверить карточки в Running?";
    if (!confirm(`${head}\n\n${plan}`)) return;

    // 1. Карточка текущего хода — до очистки: после неё `expect` уже не найти.
    let rolled = false;
    if (handoff) {
      rolled = await releaseUndelivered(handoff, "ход снят Мастером кнопкой ↺", { cause: "manual-reset" });
    }
    // 2. Память транспорта.
    resetState();
    if (what) log(`Снял ход вручную (${what}).`);

    // 3. Остальные Running без хода — на любой странице и в любой момент.
    let swept = [];
    try {
      const mission = await activeMission();
      if (mission) swept = await sweepOrphans(mission);
    } catch (e) {
      dbg("сброс: карточки в Running не проверены", e.message);
    }

    if (!what && !swept.length) {
      log("Снимать нечего: очередь пуста, ожидания нет, в Running без хода тоже ничего не висит.");
      return;
    }
    log(
      `Готово: ${what ? "очередь и ожидание сняты" : "транспорт был пуст"}` +
        `${rolled ? ", карточка хода возвращена в Ready" : ""}` +
        `${swept.length ? `, без хода висели ${swept.length} — тоже в Ready` : ""}. ` +
        "Нажмите «Шаг», чтобы начать с чистого листа.",
    );
    setStatus();
  }

  // ───────────────────────────── PR ─────────────────────────────
  /**
   * Проверка видимости — общая (`visible` в утилитах). Поймано пробой на
   * разметке Arena: скрытый бейдж «Merged» остаётся в DOM рядом с видимым
   * «Closed», а поиск по одному querySelector находил именно скрытый и считал
   * закрытый PR слитым.
   */
  /**
   * Бейдж ищем только среди видимых. В DOM Arena остаются скрытые элементы
   * прошлых состояний: без этой проверки «Merged» находился на странице, где
   * показан только «Closed».
   */
  const badgeVisible = (label) =>
    [...document.querySelectorAll(`[aria-label="${label}"]`)].some(visible);

  // Кнопка PR считается доступной, только когда её можно нажать: пока
  // страница дорисовывается, Arena держит их `disabled`, и клик по такой
  // кнопке — это не «нажал», а «ничего не произошло» с записью в журнал.
  const pressable = (b) =>
    Boolean(b) &&
    b.isConnected !== false &&
    !b.disabled &&
    b.getAttribute?.("aria-disabled") !== "true" &&
    visible(b);

  const createPr = () =>
    [...document.querySelectorAll('button[aria-label="Create pull request"]')].find(pressable) || null;

  const mergePr = () =>
    [...document.querySelectorAll('button[aria-label="Merge pull request"]')].find(pressable) || null;

  const mergedFlag = () => badgeVisible("Pull request merged");

  /**
   * «Closed» — не синоним ошибки. Так выглядит и PR, слитый через GitHub, и PR,
   * закрытый без мержа. Что именно произошло, решает маркер исполнителя
   * (`merged: true`), а не бейдж. С 1.4.48 заявка проверяется по GitHub API.
   */
  const closedFlag = () => badgeVisible("Pull request closed");

  /**
   * Кнопка «Continue» — та, что после мержа выдаёт агенту новую ветку.
   *
   * Подпись ищем и в тексте, и в `aria-label`: в разметке Arena рядом с текстом
   * лежит иконка, а её `<title>` тоже попадает в `textContent` («ContinueContinue»).
   * Точное сравнение с "Continue" из-за этого не срабатывало, и клика не было.
   */
  const isContinueLabel = (raw) =>
    /^((continue|продолжить)\s*){1,2}$/i.test(String(raw || "").replace(/\s+/g, " ").trim());

  function continueButton() {
    return [...document.querySelectorAll('button, [role="button"]')].find((b) => {
      if (!visible(b) || b.disabled || b.getAttribute("aria-hidden") === "true") return false;
      const text = (b.textContent || "").replace(/\s+/g, " ").trim();
      const aria = (b.getAttribute("aria-label") || "").trim();
      return isContinueLabel(text) || isContinueLabel(aria);
    }) || null;
  }

  /**
   * Свежая ветка перед выдачей хода.
   *
   * Continue на странице агента означает ровно одно: прошлый ход закончился
   * слитым (или закрытым) PR, и сессия стоит на ветке, работать в которой уже
   * нельзя. Агент это видит как `pr_merged` и отказывается: «нажмите Continue
   * рядом со статусом PR». Пока Continue не нажата, любое задание в этот чат
   * уходит в мёртвую ветку — работа не начинается, маркера нет, цикл встаёт
   * (27.10, NAR-4.9, ветка `arena/73b6f5a4-relay` после PR #97).
   *
   * Клик по Continue — это не реплика агенту и не команда в репозиторий: Arena
   * просто выдаёт новую ветку от последней базовой версии. Поэтому проверка
   * стоит перед КАЖДОЙ отправкой из очереди, а не только в конце хода: пропуск
   * в одном месте (память о мерже, потерянный клик, ручная правка карточки)
   * больше не превращается в паузу.
   */
  async function ensureFreshBranch(why = "перед выдачей") {
    let cont = continueButton();
    if (!cont && mergedFlag()) {
      // Бейдж «Pull request merged» уже есть, а кнопка ещё не дорисовалась.
      // Ждать дешевле, чем отправить задание в слитую ветку.
      cont = await waitFor(() => continueButton(), patience(4000), 400);
    }
    if (!cont) return "none";
    cont.click();
    log(
      `${why}: на странице видна Continue — ветка прошлого хода слита, работать в ней агент не может. ` +
        "Нажал Continue: Arena выдаст чистую ветку.",
      false,
      { tone: "ok" },
    );
    const gone = await waitFor(() => !continueButton(), patience(8000), 500);
    if (!gone) {
      const again = continueButton();
      if (again) {
        again.click();
        log("Continue осталась на месте — нажал ещё раз.", true);
        await waitFor(() => !continueButton(), patience(6000), 500);
      }
    }
    // После Continue страница перерисовывается: поле ввода и водяной знак
    // читаются уже в новой сессии, поэтому ждём дорисовку до вставки.
    await sleep(1200);
    return continueButton() ? "stuck" : "pressed";
  }

  /** Что из PR-интерфейса видно прямо сейчас. */
  const prSurface = () => ({
    merged: mergedFlag(),
    closed: closedFlag(),
    cont: continueButton(),
    create: createPr(),
    merge: mergePr(),
  });

  const hasPrUi = () => {
    // Кнопка «Create pull request» из плашки «задача выполнена» — это действие
    // чата, а не PR-интерфейс: нажатие отправляет агенту реплику «Please open a
    // pull request…». 24.10 (14:48) именно так в чат Build/Release улетело
    // лишнее сообщение, и агент бросил работу отвечать на него.
    if (completionPlaque()) return false;
    const s = prSurface();
    return Boolean(s.merged || s.closed || s.cont || s.create || s.merge);
  };

  /**
   * Фоновая вкладка.
   *
   * Фокус скрипту не нужен: он ищет элементы и кликает из кода, поэтому цикл
   * идёт и в скрытой вкладке. Но браузер режет там таймеры — сначала до
   * секунды, а через пять минут до одного пробуждения в минуту. Из-за этого
   * короткие ожидания («Continue» за 20 с, карточка PR за 8 с) успевают
   * истечь раньше, чем скрипт проснётся. В фоне растягиваем их: лучше
   * подождать минуту, чем решить, что кнопки нет.
   */
  const tabHidden = () => {
    try {
      return document.visibilityState === "hidden";
    } catch {
      return false;
    }
  };
  const patience = (ms) => (tabHidden() ? Math.max(ms * 3, 60_000) : ms);

  /** Ждём, пока условие станет истинным. Возвращает значение или null. */
  async function waitFor(check, timeoutMs, stepMs = 700) {
    const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const value = check();
      if (value) return value;
      stepAlive();
      if (Date.now() >= until) return null;
      await sleep(stepMs);
    }
  }

  /**
   * Имя текущей ветки. В разметке Arena `span.min-w-0.truncate` встречается
   * несколько раз (заголовок чата, ветка), поэтому берём то, что похоже на
   * ветку, и предпочитаем `arena/…`.
   */
  function branchName() {
    const candidates = [...document.querySelectorAll("span.min-w-0.truncate")]
      .map((el) => (el.textContent || "").trim())
      .filter((text) => /^[\w./-]{3,120}$/.test(text));
    const branchy = candidates.filter((text) => /^(arena|nar|cf)\//.test(text));
    return (branchy.at(-1) || candidates.at(-1) || "");
  }

  /**
   * Ждём, что PR слит. Агент делает это сам (`gh pr merge`). Кнопки — запасной
   * путь: если агент не запушил, Create PR активна, и мы нажимаем её; ответ
   * агента при этом не считается результатом задания (водяной знак).
   *
   * Бейджи PR живут на странице PR, а ответ агента читается на его странице:
   * ни Merge, ни Continue там нет. Поэтому, если никакого PR-интерфейса на
   * экране нет, ждать пять минут бессмысленно — решает маркер (`pr` +
   * `merged: true`). Для legacy Relay при недоступном GitHub остаётся
   * прежняя заявка без подтверждения; новый проект требует проверяемый PR и
   * базовую ветку, а DOM-состояние повторно сверяется с GitHub.
   */
  async function ensureMerged(task, result) {
    const target = dispatchTarget();
    const foreign = typeof projectPrBoundary === "function" ? projectPrBoundary(result, target ? target.repo : null) : "";
    if (foreign) { lastMergeCheck = { status: "boundary", why: foreign }; return "boundary"; }
    const scopedProject = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy;
    let projectCheck = null;
    if (scopedProject) {
      // И до запасных кнопок нужен конкретный PR, его репозиторий и base.
      // Бейдж Arena сам по себе не доказывает, что PR относится к проекту.
      // Проверяем именно цель выдачи (репозиторий + базовая ветка из снимка),
      // а не всегда глобальный C.repo.
      projectCheck = await verifyMergeClaim(result, ghToken(), target || undefined);
      if (projectCheck.status === "boundary" || projectCheck.status === "unknown") {
        lastMergeCheck = projectCheck;
        return "boundary";
      }
    }
    // Память о мерже — на выдачу, а не на карточку.
    //
    // 27.10 NAR-4.9 ответили дважды: PR #95 в 16:41 и PR #97 в 21:15. Ключ был
    // один на карточку, поэтому после второго мержа `ensureMerged` сразу
    // отвечал «already»: ни бейджа, ни Continue скрипт не искал, Continue не
    // нажималась, и сессия Архитектора осталась на ветке
    // `arena/73b6f5a4-relay` со статусом `pr_merged`. Следующая выдача ушла
    // в мёртвую ветку, агент отказался работать, маркера не было, и цикл встал.
    // Повторная работа по той же карточке — это новая выдача, у неё свой run.
    const runId = String(result.run_id || rt(task.properties?.["Run ID"]) || "").trim();
    // Для новых проектов память привязана ещё и к PR: другая ссылка в том же
    // Run не может воспользоваться подтверждением предыдущего PR. Legacy-ключ
    // остаётся прежним. Даже сохранённый успех сверяется с текущим GitHub.
    const projectRef = scopedProject ? prRef(result, target?.repo || C.repo) : null;
    if (scopedProject && !projectRef) {
      lastMergeCheck = { status: "boundary", why: "Не удалось определить PR для этого проекта." };
      return "boundary";
    }
    const key = `${K.merged}${task.id}:${runId || "run"}${projectRef ? `:repo-${encodeURIComponent(projectRef.repo)}:pr-${projectRef.number}:base-${encodeURIComponent(target?.branch || C.branch || "main")}` : ""}`;
    if (GM_getValue(key, false)) {
      if (scopedProject && projectCheck.status !== "merged") {
        lastMergeCheck = projectCheck;
        return "boundary";
      }
      return "already";
    }

    // Карточка PR может отрисоваться на пару секунд позже ответа. Без неё мы не
    // нажмём Continue, и агент останется на уже слитой ветке — поэтому ждём.
    const prUi = hasPrUi() ? true : Boolean(await waitFor(hasPrUi, patience(C.prCardWaitMs), 500));
    if (!prUi) {
      if (!hasMergedClaim(result)) {
        log(`PR на странице нет и в ответе нет заявки о мерже — считаю, что работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала.`, true);
        return "unconfirmed";
      }
      return claimMerge(task, result, key, " (PR-интерфейс живёт на странице PR, а не в чате)");
    }

    const started = Date.now();
    const grace = Date.now() + C.mergeGraceMs;
    let clickedCreate = false;
    let clickedMerge = false;

    while (Date.now() - started < C.prWaitMs) {
      if (mergedFlag()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "merged") { lastMergeCheck = check; return "boundary"; }
        }
        return finishMerge(task, key);
      }
      if (closedFlag()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "closed") { lastMergeCheck = check; return "boundary"; }
        }
        return finishClosed(task, key);
      }
      if (continueButton()) {
        if (scopedProject) {
          const check = await verifyMergeClaim(result, ghToken(), target || undefined);
          if (check.status !== "merged") { lastMergeCheck = check; return "boundary"; }
        }
        return finishMerge(task, key);
      }

      // Агент уже заявил о мерже — кнопки PR не трогаем вовсе, даже если
      // «Create pull request» видна. 24.10 (14:48) именно этот клик отправил в
      // чат Build/Release реплику «Please open a pull request…», и агент вместо
      // работы начал отвечать на неё. Заявка — тот же сигнал, что и в ветке
      // «PR-интерфейса нет вовсе»: заявка о мерже проверяется по GitHub API.
      if (hasMergedClaim(result)) {
        return claimMerge(
          task,
          result,
          key,
          " (кнопки Create/Merge не нажимаю — они отправят агенту лишнюю реплику)",
        );
      }

      if (Date.now() > grace) {
        const create = createPr();
        if (create && !clickedCreate) {
          clickedCreate = true;
          create.click();
          log("Агент не открыл PR сам — нажата «Create pull request» (запасной путь).");
          await sleep(6000);
          continue;
        }
        const merge = mergePr();
        if (merge && !clickedMerge) {
          clickedMerge = true;
          merge.click();
          log("PR не слит — нажата «Merge pull request» (запасной путь).");
          await sleep(6000);
          continue;
        }
      }
      await sleep(2500);
    }
    return "timeout";
  }

  async function finishMerge(task, key) {
    // Continue появляется не мгновенно после бейджа Merged. Раньше кнопку
    // искали один раз: если её ещё не было, клика не происходило вовсе, и
    // агент не получал новую ветку — молча, без единой строки в журнале.
    const cont = await waitFor(continueButton, patience(C.continueWaitMs), 700);
    if (cont) {
      cont.click();
      log("PR слит: нажата Continue — агент получит новую ветку.");
      const gone = await waitFor(() => !continueButton(), 8000, 500);
      if (!gone) {
        const again = continueButton();
        if (again) {
          again.click();
          log("Continue осталась на месте — нажал ещё раз.", true);
          await waitFor(() => !continueButton(), 6000, 500);
        }
      }
      await sleep(3000);
      if (continueButton()) {
        log("Continue всё ещё видна: клик не дошёл. Ветка может остаться прежней — проверьте страницу агента.", true);
      } else {
        log("Continue принята: страница обновилась.");
      }
    } else {
      log(
        `Бейдж Merged есть, а Continue не появилась за ${Math.round(C.continueWaitMs / 1000)} с: ` +
          "продолжаю без неё. Новая ветка появится, когда агент получит следующий ход.",
      );
    }
    const branch = branchName();
    if (branch) {
      GM_setValue(K.branch, branch);
      try {
        await patch(task.id, { Branch: { rich_text: [{ type: "text", text: { content: branch } }] } });
        log(`Рабочая ветка: ${branch}`);
      } catch (e) {
        throw new Error(`PR слит, но ветка ${branch} не записана в Notion: ${e.message}`);
      }
    } else {
      log("Имя ветки на странице не нашлось — в Notion не записываю, карточка останется без «Branch».");
    }
    GM_setValue(key, true);
    return "merged";
  }

  /**
   * Мерж заявлен маркером, PR-интерфейса на странице ещё нет.
   *
   * Кнопки Create/Merge не трогаем: они отправляют агенту лишнюю реплику
   * (24.10 в 14:48 именно так в чат ушло «Please open a pull request…»). Но
   * Continue — это не реплика, а выдача новой ветки, и Arena дорисовывает её
   * уже после того, как узнала о мерже. До 1.4.42 здесь был немедленный
   * выход, поэтому Continue оставалась ненажатой: NAR-1.11, PR #35 — Мастер
   * жал её руками. Ждём бейдж или Continue до mergeGraceMs.
   */
  async function claimMerge(task, result, key, note = "") {
    // Маркеру верим не на слово: «merged: true» — это заявка, а не факт.
    // 24.10 на экране Build/Release висела активная «Create PR» (Arena не
    // знает о PR, слитом через `gh`), и отличить сделанную работу от
    // выдуманной было нечем. Теперь состояние спрашиваем у GitHub.
    const target = dispatchTarget();
    const check = await verifyMergeClaim(result, ghToken(), target || undefined);
    lastMergeCheck = check;
    if (check.status === "boundary" || (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && check.status === "unknown"))
      return "boundary";
    // Проверка не дошла до GitHub (нет токена, отказ прав, сеть). Заявку это не
    // отменяет: без проверки действует прежнее правило, но мастер должен знать,
    // что «слит» принято на слово, и что делать.
    if (check.status === "unknown" && check.needsToken) {
      log(
        `GitHub не проверил ${prLabelOf(result)}: ${check.why}. Заявка принимается по маркеру; ` +
          "чтобы проверять по GitHub, откройте «⚙ Подключения» и сохраните токен.",
        false,
        { tone: "warn", ntfy: "quiet", title: "Relay: GitHub без токена" },
      );
    }
    if (check.notFound) {
      // Самая дорогая ошибка суток: слитый PR #37 объявили отсутствующим, и
      // готовая работа уехала в Rework. 404 не доказывает, что PR нет.
      log(
        `GitHub не читает ${prLabelOf(result)}: ${check.why}. ` +
          "Заявка принимается по маркеру, карточку в Rework за 404 не отправляю.",
        true,
        { tone: "warn", ntfy: "quiet", title: "Relay: PR не виден по API" },
      );
    }
    if (check.status === "open" || check.status === "closed") {
      log(
        `Заявка «${prLabelOf(result)} слит» не подтвердилась: ${check.why}. ` +
          `Карточка вернётся в Rework — работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала.`,
        true,
        // Итоговый тихий пуш с названием карточки отправляется после Rework.
        { tone: "warn", ntfy: false },
      );
      return "claim-rejected";
    }
    const seen = await waitFor(() => mergedFlag() || continueButton(), patience(C.mergeGraceMs), 1000);
    if (seen) return finishMerge(task, key);
    GM_setValue(key, true);
    const proof =
      check.status === "merged"
        ? `, GitHub подтвердил (${check.why})`
        : `; проверить по GitHub не удалось — ${check.why}`;
    log(
      `${prLabelOf(result)} слит: принято по маркеру агента${note}${proof}. ` +
        `Бейджа Merged и Continue на странице нет и через ${Math.round(patience(C.mergeGraceMs) / 1000)} с: ` +
        "если Continue появится позже, нажмите её сами — на запись результата это уже не влияет.",
    );
    return "claimed";
  }

  /**
   * PR закрыт. Дальше на странице остаётся только Continue — жмём её, чтобы
   * цикл не встал, и читаем новую рабочую ветку. Решение «слито или провалено»
   * принимает вызывающий код по маркеру исполнителя.
   */
  async function finishClosed(task, key) {
    const cont = await waitFor(continueButton, patience(Math.min(C.continueWaitMs, 10000)), 700);
    if (cont) {
      cont.click();
      log("PR закрыт: нажата Continue, состояние передано дальше.");
      await waitFor(() => !continueButton(), 8000, 500);
      await sleep(3000);
    } else {
      log("PR закрыт, но Continue на странице нет: перехожу дальше без неё.");
    }
    const branch = branchName();
    if (branch) {
      GM_setValue(K.branch, branch);
      try {
        await patch(task.id, { Branch: { rich_text: [{ type: "text", text: { content: branch } }] } });
        log(`Рабочая ветка: ${branch}`);
      } catch (e) {
        throw new Error(`PR закрыт, но ветка ${branch} не записана в Notion: ${e.message}`);
      }
    }
    GM_setValue(key, "closed");
    return "closed";
  }

  /**
   * Токен GitHub.
   *
   * 24.10 репозиторий `example/relay-fixture` оказался приватным: анонимный
   * запрос к API отвечает на него «404 Not Found» — так же, как на PR, которого
   * нет. 1.4.48 приняла этот ответ за правду и отправила готовую работу
   * (PR #37) в Rework. Токен читает состояние PR; хранится в ScriptCat и в
   * журнал не попадает.
   */
  const ghToken = () => String(GM_getValue(K.ghToken, "") || "").trim();

  /** Ссылка на PR: принимаем и номер, и готовый URL. `repo` — репозиторий цели выдачи. */
  function prUrl(pr, repo = C.repo) {
    const value = String(pr ?? "").trim().replace(/^#/, "");
    if (!value) return "";
    if (/^https?:\/\//.test(value)) return value;
    return /^\d+$/.test(value) ? `https://github.com/${repo}/pull/${value}` : "";
  }

  /** Подпись PR для журнала: номер или ссылка из маркера. */
  const prLabelOf = (result) => {
    const pr = String((result && result.pr) ?? "").trim();
    return !pr ? "PR" : /^https?:/i.test(pr) ? pr : `PR #${pr.replace(/^#/, "")}`;
  };

  /**
   * Номер и репозиторий PR из маркера.
   *
   * Принимаем и число, и «#37», и полный адрес: агент может сослаться на PR
   * словами. Адрес важнее номера — он называет репозиторий. Номер без
   * репозитория проверяется в репозитории цели выдачи (`targetRepo`), а не
   * всегда в `C.repo`.
   */
  function prRef(result, targetRepo = C.repo) {
    const raw = String((result && result.pr) ?? "").trim();
    if (!raw) return null;
    const url = raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
    if (url) return { repo: `${url[1]}/${url[2]}`, number: Number(url[3]) };
    const num = raw.replace(/^#/, "").match(/^(\d+)$/);
    return num ? { repo: String(targetRepo || C.repo || ""), number: Number(num[1]) } : null;
  }

  /** Снимок цели выдачи из текущего ожидания: репозиторий и базовая ветка. */
  function dispatchTarget() {
    try {
      const expect = GM_getValue(K.expect, null);
      if (expect && (expect.targetRepo || expect.targetBranch)) {
        return {
          repo: canonicalTargetRepository(expect.targetRepo || C.repo || "", C.repo),
          branch: String(expect.targetBranch || C.branch || "main"),
        };
      }
    } catch { /* ожидание недоступно — работаем с глобальным конфигом */ }
    return null;
  }

  /**
   * Разрешить короткий slug из старых Notion-полей в owner/repo профиля.
   * Role rows давно допускали значение `synapse`, хотя GitHub API требует
   * `Creative36711/synapse`; приоритет — точное уникальное совпадение профиля.
   */
  function canonicalTargetRepository(value, fallback = C.repo) {
    const raw = String(value || fallback || C.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "");
    if (!raw || raw.includes("/")) return raw;
    const repos = typeof ACTIVE_PROFILE !== "undefined" && Array.isArray(ACTIVE_PROFILE.repos)
      ? ACTIVE_PROFILE.repos : [];
    const matches = repos.filter((entry) => entry && String(entry.repo || "").split("/").at(-1).toLowerCase() === raw.toLowerCase());
    return matches.length === 1 ? String(matches[0].repo) : raw;
  }

  /** Целевой repo карточки; старые карточки наследуют repo активной роли. */
  function taskTargetRepository(card, fallback = C.repo) {
    const props = card && card.properties || {};
    const value = rt(props.Repository).trim() || rt(props["Репозиторий"]).trim();
    return canonicalTargetRepository(value || fallback);
  }

  /** Явная чужая или некорректная ссылка не доказывает мерж нашего проекта. */
  function projectPrBoundary(result, targetRepo = null) {
    const repo = String(targetRepo || C.repo || "");
    const raw = String((result && result.pr) ?? "").trim();
    if (!raw || /^(none|null|no|нет|—|-)$/i.test(raw)) {
      return typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && hasMergedClaim(result)
        ? "В маркере нет номера PR для проверки репозитория и базовой ветки." : "";
    }
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
        !/^https?:/i.test(raw) && !/^#?\d+$/.test(raw)) return "Укажите номер PR или полную HTTPS-ссылку GitHub.";
    if (/^https?:/i.test(raw)) {
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password ||
            !/^\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/.test(url.pathname))
          return "Ссылка PR не является адресом GitHub pull request.";
      } catch { return "Некорректная ссылка PR."; }
    }
    const ref = prRef(result, repo);
    if (ref && ref.repo.toLowerCase() !== repo.toLowerCase()) {
      // Full URL explicitly names the task repo. Accept it only when that repo
      // is registered in this profile; this check runs before GitHub merge
      // verification too, so it must use the same multi-repo resolution there.
      const configured = typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
        (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).some(
          (entry) => entry && String(entry.repo || "").toLowerCase() === ref.repo.toLowerCase(),
        );
      if (!configured) return `PR относится к ${ref.repo}, а цель выдачи работает с ${repo}.`;
    }
    return "";
  }

  /** Заголовки GitHub API. Без токена запрос остаётся анонимным (60 в час). */
  function githubHeaders(token) {
    const headers = {
      Accept: "application/vnd.github+json",
      "User-Agent": "relay-scriptcat",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Состояние PR по GitHub API.
   *
   * Проверка идёт один раз за ход. Приватному репозиторию нужен токен:
   * без него GitHub отвечает 404 независимо от того, есть PR или нет.
   */
  async function githubPr(repo, number, token = "") {
    return request(
      "GET",
      `https://api.github.com/repos/${repo}/pulls/${number}`,
      githubHeaders(token),
      undefined,
      { anonymous: !token },
    );
  }

  async function githubRepo(repo, token = "") {
    return request(
      "GET",
      `https://api.github.com/repos/${repo}`,
      githubHeaders(token),
      undefined,
      { anonymous: !token },
    );
  }

  /**
   * Проверка «PR слит» из маркера.
   *
   * `status`: merged — GitHub подтвердил; open / closed — заявка ложная,
   * принимать её нельзя; unknown — проверить не удалось (сеть, лимит, нет
   * номера, нет токена, PR не читается), и тогда остаётся прежнее правило
   * «верим маркеру, но говорим об этом в журнале». Статуса «PR нет» больше
   * нет: 404 означает только «не видно».
   *
   * `needsToken` — проверка упёрлась в доступ, а не в состояние PR: приватный
   * репозиторий без токена отвечает 404, и это нельзя читать как «PR нет».
   */
  async function verifyMergeClaim(result, token = "", target = null) {
    let repo = canonicalTargetRepository((target && target.repo) || C.repo || "", C.repo);
    let branch = String((target && target.branch) || C.branch || "main");
    const ref = prRef(result, repo);
    // A full PR URL is authoritative when it points to another repository
    // explicitly configured in this project profile. This supports roles
    // whose session repo differs from the task repo without accepting arbitrary
    // external links. The PR base and branch are still verified below.
    if (ref && ref.repo.toLowerCase() !== repo.toLowerCase() &&
        typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
      const entry = (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).find(
        (item) => item && String(item.repo || "").toLowerCase() === ref.repo.toLowerCase(),
      );
      if (entry) {
        repo = ref.repo;
        branch = String(entry.branch || "main");
      }
    }
    const foreign = typeof projectPrBoundary === "function" ? projectPrBoundary(result, repo) : "";
    if (foreign) return { status: "boundary", why: foreign };
    if (!ref) return { status: "unknown", why: "в маркере нет номера PR" };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ref.repo))
      return { status: "boundary", why: `Целевой репозиторий «${ref.repo}» задан не как owner/repo; GitHub-запрос не отправлял.` };
    try {
      const pr = await githubPr(ref.repo, ref.number, token);
      if (!pr || typeof pr !== "object") return { status: "unknown", why: "GitHub ответил пустым ответом" };
      if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy &&
          String(pr.base?.repo?.full_name || "").toLowerCase() !== repo.toLowerCase())
        return { status: "boundary", why: `GitHub не подтвердил репозиторий базовой ветки PR цели выдачи (${repo}).` };
      if (pr.base?.ref && branch && pr.base.ref !== branch)
        return { status: "boundary", why: `PR направлен в ${pr.base.ref}, а базовая ветка цели выдачи — ${branch}.` };
      if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && !pr.base?.ref)
        return { status: "boundary", why: "GitHub не подтвердил базовую ветку PR цели выдачи." };
      const merged = pr.merged === true || Boolean(pr.merged_at);
      if (merged) return { status: "merged", why: `PR #${ref.number} слит ${pr.merged_at || ""}`.trim(), pr };
      if (String(pr.state || "").toLowerCase() === "closed")
        return { status: "closed", why: `PR #${ref.number} закрыт без мержа`, pr };
      return { status: "open", why: `PR #${ref.number} ещё открыт`, pr };
    } catch (e) {
      const raw = String((e && e.message) || e);
      const code = Number((e && e.status) || (raw.match(/HTTP (\d{3})/) || [])[1] || 0);
      // GitHub иногда отвечает на PR-эндпоинт 401/403/404 из-за сохранённого
      // fine-grained token, даже когда PR публичен. Повторяем запрос без
      // Authorization: публичный PR остаётся проверяемым, а приватный по-прежнему
      // возвращает unknown и не принимается за отсутствующий.
      if (token && [401, 403, 404].includes(code)) {
        const anonymous = await verifyMergeClaim(result, "", target);
        if (anonymous.status !== "unknown") return anonymous;
        return {
          ...anonymous,
          needsToken: Boolean(anonymous.needsToken),
          notFound: code === 404 || anonymous.notFound,
          why: `GitHub ответил HTTP ${code} с токеном; анонимная проверка не подтвердила PR: ${anonymous.why}`,
        };
      }
      // Не называем PR-404 проблемой токена, пока не проверили сам repo тем
      // же строго анонимным транспортом. Для публичного repo 200 + PR 404
      // означает расхождение URL/номера/эндпоинта, а не нехватку прав.
      if (code === 404) {
        try {
          const repository = await githubRepo(ref.repo, "");
          if (repository && String(repository.full_name || "").toLowerCase() === ref.repo.toLowerCase()) {
            return {
              status: "unknown",
              notFound: true,
              why: `Репозиторий ${ref.repo} читается анонимно, но GitHub вернул 404 на PR #${ref.number}; проверьте точную ссылку/номер PR`,
            };
          }
          return { status: "unknown", why: `GitHub вернул неожиданный ответ репозитория ${ref.repo} при анонимной проверке PR #${ref.number}` };
        } catch (repoError) {
          const repoRaw = String((repoError && repoError.message) || repoError);
          const repoCode = Number((repoError && repoError.status) || (repoRaw.match(/HTTP (\d{3})/) || [])[1] || 0);
          if (repoCode === 404) {
            return {
              status: "unknown",
              needsToken: true,
              why: `Анонимный GitHub API вернул 404 и на PR #${ref.number}, и на репозиторий ${ref.repo}; доступ/ответ API не подтверждён (проверьте видимость и запрос)`,
            };
          }
          return {
            status: "unknown",
            why: `Анонимный запрос PR #${ref.number} вернул HTTP 404, а запрос repo — ${repoCode ? `HTTP ${repoCode}` : repoRaw}`,
            code: repoCode,
          };
        }
      }
      if (code === 401 || code === 403)
        return {
          status: "unknown",
          why: `GitHub отклонил анонимный запрос (HTTP ${code}); состояние PR не подтверждено`,
          code,
        };
      if (!code) return { status: "unknown", why: `GitHub не ответил: ${raw}` };
      return { status: "unknown", why: `GitHub ответил HTTP ${code}`, code };
    }
  }

  /**
   * Вернуть карточку, которую проверка ошибочно отправила в Rework.
   *
   * 24.10 NAR-1.13 лежала в Rework при слитом PR #37: работа в main, а
   * Координатор уже готовил повторную выдачу. Кнопка «Подключения» → «Вернуть карточку»
   * спрашивает GitHub ещё раз и, если мерж подтверждён, ставит ровно то, что
   * поставила бы удачная проверка: Submitted, Submitted At, PR и отметку в
   * «Ответ». Ready не трогаем: если карточку уже выдали заново, решает Мастер.
   */
  async function recoverLastClaim(adopt = true) {
    const last = GM_getValue(K.lastResult, null);
    if (!last || !last.dispatch_id) return { ok: false, text: "Нет запомненной выдачи: возвращать нечего." };
    const target = last && (last.targetRepo || last.targetBranch)
      ? { repo: last.targetRepo, branch: last.targetBranch } : null;
    const check = await verifyMergeClaim(last.result || last, ghToken(), target);
    if (check.status !== "merged")
      return { ok: false, text: `GitHub мерж не подтверждает: ${check.why}. Карточка не тронута.` };
    const page = await notion("GET", `pages/${last.dispatch_id}`);
    const state = taskState(page);
    const name = last.task || last.dispatch_id;
    if (state === "Ready")
      return {
        ok: false,
        text: `«${name}» уже вернулась в Ready: её могли выдать заново. Правку не делаю — решение за Мастером.`,
      };
    const link = prUrl((check.pr && check.pr.html_url) || last.pr);
    const note =
      `Восстановлено после ложного отказа проверки: GitHub подтвердил мерж ${link || `PR #${last.pr}`}` +
      ` (${check.why}). Повторная работа по карточке не нужна.`;

    // Журнал важнее карточки: Координатор принимает по нему. 24.10 в 19:57
    // случилось ровно это — карточка уже была возвращена в Submitted, а в
    // журнале остался блок «Заявка о мерже не подтвердилась», и Координатор
    // снова поставил Rework, хотя PR #37 лежал в main. Опровержение пишется
    // отдельным маркером, поэтому повторный клик его не дублирует.
    let logFix = "";
    if (last.logId) {
      const marker = `<!-- CF_DISPATCH ${last.dispatch_id}:${last.run_id}:recovered -->`;
      try {
        const wrote = await gateway("append", last.logId, {
          marker,
          entry: `\n\n${marker}\n## Проверка мержа исправлена\n\n${note}\n`,
        });
        logFix = wrote && wrote.duplicate ? " Опровержение уже было в журнале." : " Опровержение записано в журнал.";
      } catch (e) {
        logFix = ` Опровержение в журнал записать не удалось: ${e.message}.`;
      }
    }

    if (state === "Submitted" || state === "Accepted") {
      log(`«${name}» уже ${state}: журнал проверен${logFix ? "," : ""}${logFix}`, false, { tone: "ok" });
      return { ok: true, text: `«${name}» уже ${state}.${logFix}` };
    }

    // Rework — это отказ, при котором ответ агента так и не был прочитан
    // (24.10: работа в main, а карточка ушла в Rework). Такую карточку
    // возвращаем не в Submitted, а в Running: иначе ответ останется в чате
    // невычитанным, и следующая выдача станет дублем («Подключения» → «Взять ответ из чата»).
    if (state === "Rework" || state === "Running") {
      if (state === "Rework") {
        const props = {
          "Dispatch State": { select: { name: "Running" } },
          "Ответ": { rich_text: richText(note) },
        };
        if (link) props["PR"] = { url: link };
        await patch(last.dispatch_id, props);
      }
      GM_setValue(`cfn-done:${last.dispatch_id}:${last.run_id}`, false);
      GM_setValue(K.lastResult, { ...last, recoveredAt: Date.now(), verdict: "Running" });
      let taken = "";
      try {
        const here = adopt && typeof roleFromPath === "function" ? roleFromPath() : "";
        if (here && norm(here) === norm(last.roleId)) {
          const got = await adoptPageAnswer();
          taken =
            got && got.ok
              ? " Ответ прочитан и оформлен обычным путём."
              : ` Ответ сразу не прочитан: ${(got && got.text) || "неизвестно"}.`;
        } else {
          taken =
            ` Откройте страницу «${last.roleName || "исполнителя"}» и нажмите «Взять ответ»:` +
            " карточка снова Running, ответ ждёт.";
        }
      } catch (e) {
        taken = ` Ответ сразу не прочитан: ${e.message}. Кнопка «Взять ответ» на странице роли.`;
      }
      log(`«${name}» возвращена в Running: GitHub подтвердил мерж ${link || ""}`.trim() + logFix, false, {
        tone: "ok",
        ntfy: "quiet",
        title: "Relay: карточка возвращена в работу",
      });
      return { ok: true, text: `Готово: «${name}» снова Running, ${link || `PR #${last.pr}`}.${logFix}${taken}` };
    }

    const props = {
      "Dispatch State": { select: { name: "Submitted" } },
      "Ответ": { rich_text: richText(note) },
      "Submitted At": { date: { start: nowIso() } },
    };
    if (link) props["PR"] = { url: link };
    await patch(last.dispatch_id, props);
    GM_setValue(`cfn-done:${last.dispatch_id}:${last.run_id}`, true);
    GM_setValue(K.lastResult, { ...last, recoveredAt: Date.now(), verdict: "Submitted" });
    log(`«${name}» возвращена в Submitted: GitHub подтвердил мерж ${link || ""}`.trim() + logFix, false, {
      tone: "ok",
      ntfy: "quiet",
      title: "Relay: карточка восстановлена",
    });
    return { ok: true, text: `Готово: «${name}» снова Submitted, ${link || `PR #${last.pr}`}.${logFix}` };
  }

  /**
   * Ложный отказ чинится сам, не дожидаясь Мастера.
   *
   * 24.10 транспорт дважды возвращал слитую работу в Rework: человек узнавал
   * об этом от Координатора, а не от скрипта. Если последняя проверка сказала
   * «заявка не подтвердилась», а GitHub теперь говорит «слит», это уже
   * известный дефект — карточка и журнал исправляются без кликов. Ответ при
   * этом не берётся: его читают кнопкой на странице роли, иначе ход пойдёт
   * мимо очереди.
   */
  let healedThisPage = false;
  async function selfHealClaim() {
    if (healedThisPage) return;
    const last = GM_getValue(K.lastResult, null);
    if (!last || last.verdict !== "claim-rejected" || last.recoveredAt) return;
    healedThisPage = true;
    const target = last && (last.targetRepo || last.targetBranch)
      ? { repo: last.targetRepo, branch: last.targetBranch } : null;
    const check = await verifyMergeClaim(last.result || last, ghToken(), target);
    if (check.status !== "merged") return;
    log(
      `Проверка ошиблась: GitHub подтвердил мерж ${prLabelOf(last.result || last)} — ` +
        "возвращаю карточку и исправляю журнал.",
      false,
      { tone: "ok", ntfy: "quiet", title: "Relay: ложный отказ исправлен" },
    );
    await recoverLastClaim(false);
  }

  /**
   * Ответ уже в чате, а ожидания нет.
   *
   * Скрипт перезапускался, страницу перезагружали, прошлая попытка снимала
   * ожидание — а агент ответил, и карточка осталась в Running. Тогда
   * Координатор ждёт ход, которого никто не начнёт, и через 45 минут карточка
   * уедет в Ready как «брошенная» — то есть работа пойдёт по второму кругу.
   * Кнопка «Взять ответ» читает последний маркер этой страницы и отдаёт его
   * обычному пути submitExecutor. Ничего не додумывает: нужен маркер, карточка
   * в Running, тот же адресат и отсутствие отметки «уже обработано».
   */
  async function adoptPageAnswer() {
    if (GM_getValue(K.expect, null) || GM_getValue(K.pending, null)) {
      return { ok: false, text: "Уже есть ожидание или очередь отправки: сначала завершите текущий ход; для него нажмите «Шаг»." };
    }
    const roleId = roleFromPath();
    if (!roleId) return { ok: false, text: "Откройте страницу агента: брать ответ не с кого." };
    const list = await roles();
    const role = list.find((r) => norm(r.id) === norm(roleId));
    if (!role) return { ok: false, text: "Страница не привязана к активной роли — проверьте «Agent URL»." };
    if (role.fn === "Coordinator")
      return { ok: false, text: "Это страница Координатора: его ход читается кнопкой «Шаг», а не отсюда." };
    const all = messages();
    const last = [...all].reverse().find((n) => !isUserNode(n));
    if (!last) return { ok: false, text: "В чате нет ответов агента." };
    const result = parseMarker(messageRaw(last), "CF_AGENT_RESULT") || parseMarker(messageRaw(last), "CF_COORDINATOR_RESULT") || parseMarker(messageRaw(last), "CF_REVIEW_RESULT");
    if (!result) return { ok: false, text: "В последнем ответе нет маркера выдачи — читать нечего." };
    const ref = String(result.dispatch_id || result.dispatch || result.dispatchId || "").trim();
    if (!isUuid(ref)) return { ok: false, text: `В маркере нет корректного dispatch_id («${ref || "нет"}») — карточку не угадываю.` };
    const run = String(result.run_id || result.run || result.runId || "").trim();
    if (!isUuid(run)) return { ok: false, text: "В маркере нет корректного run_id — чужую выдачу не угадываю." };
    if (GM_getValue(`cfn-done:${ref}:${run}`, false))
      return { ok: false, text: "Эта выдача уже обработана — второй раз не читаю." };
    const page = await notion("GET", `pages/${ref}`);
    const state = taskState(page);
    if (state !== "Running")
      return { ok: false, text: `Карточка уже «${state || "без состояния"}» — читать нечего.` };
    const owner = norm(rt(page.properties["Recipient Agent ID"]));
    if (owner && owner !== norm(role.id))
      return { ok: false, text: "Ответ принадлежит другому агенту — не беру." };
    const mission = await activeMission();
    if (!mission || !cardInMission(page, mission))
      return { ok: false, text: "Mission ID карточки не совпадает с единственной активной миссией — ответ не беру." };
    // Граница — сообщение перед ответом: в журнал попадёт только он.
    const at = all.indexOf(last);
    const watermark = at > 0 ? nodeId(all[at - 1]) : "";
    const expect = {
      ref,
      runId: run,
      missionId: mission.id,
      roleId: role.id,
      roleName: role.name,
      kind: "dispatch",
      sentAt: Date.now(),
      verified: true,
      watermark,
      tries: 0,
      lastReplySig: "",
      lastReplyAt: 0,
      adopted: true,
    };
    if (GM_getValue(K.expect, null) || GM_getValue(K.pending, null)) {
      return { ok: false, text: "Пока читалась карточка, начался другой ход: его ожидание не перезаписываю." };
    }
    GM_setValue(K.expect, expect);
    await submitExecutor(role, expect, true);
    const updated = await notion("GET", `pages/${ref}`);
    const finished = norm(rt(updated.properties?.["Run ID"])) === norm(run) &&
      ["Submitted", "Accepted", "Rework"].includes(taskState(updated));
    return finished
      ? { ok: true, text: `Ответ ${role.name} обработан: состояние карточки «${taskState(updated)}».` }
      : { ok: false, text: "Карточка ещё не оформлена: проверьте сообщение в панели, ожидание сохранено." };
  }

  /** Последняя проверка заявки — причина для карточки Rework. */
  let lastMergeCheck = null;

  /** Исполнитель утверждает, что слил PR сам. Единственный доступный сигнал. */
  const hasMergedClaim = (result) =>
    !!result && (result.merged === true || String(result.status || "").toLowerCase() === "merged");

  /**
   * Значение `pr` говорит «PR не будет» — само по себе, без заявки о мерже.
   *
   * Выделено из `prDeclined`, чтобы D-046 мог отличить явный отказ от PR
   * (`"pr": null`) от забывчивости (поля нет вовсе), не снимая проверку мержа.
   */
  const prNoneValue = (pr) =>
    pr === null || pr === undefined || /^(none|null|no|нет|—|-)$/i.test(String(pr).trim());

  /**
   * «У этой работы нет PR» — сказано в маркере явно.
   *
   * Отчёт, аудит, запись решения в Notion: кода нет, мержить нечего. Пропуск
   * `pr` значит «забыл» и по-прежнему ведёт в Rework, а вот `"pr": null`,
   * `"none"`, `"-"` или `"нет"` — это заявка «PR не будет», и ждать мерж по ней
   * нельзя: исполнитель честно ничего не пушил (Arena, 24.10: Build/Release на
   * карточке-отчёте получил «Please open a pull request…» на пустом месте).
   *
   * Аудитору PR не нужен никогда: он не меняет репозиторий. Это правило живёт
   * в `submitExecutor` по `role.fn`, а не здесь.
   */
  const prDeclined = (result) => {
    // Новый проект не может одновременно заявлять «PR нет» и «слит»: такую
    // заявку должен остановить projectPrBoundary, не обходить проверку PR.
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy && hasMergedClaim(result)) return false;
    if (!result || !("pr" in result)) return false;
    return prNoneValue(result.pr);
  };

  /**
   * D-046: маркер заявляет «PR нет» и «слит» одновременно.
   *
   * Боевой K-34 (06.11.2026, 13:50:39): проверочная карточка без изменений
   * ответила `"pr":null,"merged":true` — ровно как учил шаблон промпта, где
   * рядом с `"pr":"<URL|null>"` стоял литерал `"merged":true`. `prDeclined`
   * из-за заявки о мерже отвечал false, `projectPrBoundary` требовал номер PR,
   * карточка уходила в Blocked и цикл вставал. Второй раз за день (13:05:39 —
   * K-27), первый Мастер правил вручную.
   *
   * Противоречие не принимается и не угадывается: `merged` без PR проверить
   * нечем, а верить слову «слит» нельзя — так можно провести в main код без
   * сверки репозитория и базовой ветки. Но это дефект формата, а не отказ
   * среды: работа сделана, поэтому просим поправить одну строку маркера
   * через обычную лестницу напоминаний (`markerReminders`), а не останавливаем
   * миссию. Инвариант `projectPrBoundary` при этом не ослаблен: если такой
   * маркер всё же дойдёт до проверки мержа, он по-прежнему её не пройдёт.
   *
   * Аудитор и Reviewer сюда не попадают: у них PR нет по роли, и `merged`
   * в их маркере не спрашивается.
   */
  const prMergeConflict = (result) =>
    Boolean(result) && ("pr" in result) && prNoneValue(result.pr) && hasMergedClaim(result);

  // ───────────────────────── реестр маркеров ─────────────────────────
  // Единый источник имён маркеров и их обязательных ID. Используется
  // компилятором промптов, разбором ответов и генерацией документации,
  // чтобы «какой маркер какой роли» не расходилось между кодом и docs.
  const PROMPT_MARKER_REGISTRY = (() => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const defs = {
      CF_COORDINATOR_RESULT: { kind: "plan", ids: ["mission_id", "turn_id"], role: "Coordinator" },
      CF_AGENT_RESULT: { kind: "dispatch", ids: ["dispatch_id", "run_id"], role: "Executor|Auditor" },
      CF_REVIEW_RESULT: { kind: "review", ids: ["mission_id", "turn_id"], role: "Reviewer" },
      CF_ANSWER_RESULT: { kind: "answer", ids: ["question_id", "turn_id"], role: "Reviewer" },
      // D-053: разбор повторяющейся петли. Карточка и ход названы явно: вердикт
      // арбитра обязан относиться именно к этой выдаче, а не к похожей.
      CF_ARBITER_RESULT: { kind: "arbiter", ids: ["dispatch_id", "turn_id"], role: "Reviewer" },
      CF_AGENT_PROVISION_RESULT: { kind: "provision", ids: ["request_id"], role: "Coordinator|Reviewer" },
    };
    const forKind = (kind, roleFn) => {
      if (kind === "plan") return "CF_COORDINATOR_RESULT";
      if (kind === "review") return "CF_REVIEW_RESULT";
      if (kind === "answer") return "CF_ANSWER_RESULT";
      if (kind === "arbiter") return "CF_ARBITER_RESULT";
      if (kind === "dispatch") return "CF_AGENT_RESULT";
      if (kind === "provision") return "CF_AGENT_PROVISION_RESULT";
      if (kind === "reminder") return null; // reminder наследует маркер исходного хода
      return null;
    };
    const idFields = (name) => (defs[name] ? defs[name].ids.slice() : []);
    const isUuid = (v) => UUID.test(String(v || "").trim());
    return { defs, forKind, idFields, isUuid, names: Object.keys(defs) };
  })();

  // ───────────────────────── блоки промптов ─────────────────────────
  // Каждый блок — чистая функция ctx => текст. Блоки не читают DOM, Notion,
  // GitHub, GM_* и часы: все факты приходят в ctx. Одинаковый ctx даёт
  // одинаковый текст и хеш. ruleIds связывают блок с обязательными правилами
  // регламента (contracts/agent-protocol.json); verbatim-поля не входят в overhead.
  const PROMPT_BLOCKS = (() => {
    const B = {};
    const def = (id, spec) => { B[id] = { id, version: 1, audience: ["Executor", "Auditor", "Coordinator", "Reviewer"], ruleIds: [], verbatim: false, ...spec }; };
    const line = (label, value) => (String(value || "").trim() ? `${label}: ${String(value).trim()}` : "");

    def("identity.task", { ruleIds: [], render: (c) => [
      `Карточка «${c.task?.title || c.task?.id}» · dispatch ${c.task?.id} · run ${c.task?.runId}` + (c.mission?.id ? ` · миссия ${c.mission.id}` : ""),
      `Адресат: ${c.role?.name} (${c.role?.fn}).`,
    ].join("\n") });

    def("identity.mission", { render: (c) => [
      `Миссия: ${c.mission?.name || c.mission?.id}.`,
      `mission_id: ${c.mission?.id}`,
      c.turnId ? `turn_id: ${c.turnId}` : "",
      c.mission?.tzUrl ? `ТЗ: ${c.mission.tzUrl}` : "",
      Number.isFinite(c.mission?.round) ? `Круг: ${c.mission.round} (предел доработок ${c.mission.reworkLimit ?? 3}).` : "",
    ].filter(Boolean).join("\n") });

    def("repo.target", { version: 2, render: (c) => {
      const base = c.target?.baseBranch || "main";
      return [
        `Цель ${c.target?.repo}@${base}` + (c.target?.startSha ? `, SHA ${c.target.startSha}` : "") + `. Снимок бывает shallow: пустой merge-base не доказательство (проверь --is-shallow-repository); PR без общей истории удалит чужие файлы.`,
      ].join("\n");
    } });

    def("repo.boundary", { ruleIds: ["R-REPO-BOUNDARY"], render: () =>
      "D-022: пиши только в целевой repo. synapse (MIT) — роли ядра; cortex закрыт и ролям ядра не виден; ссылка на cortex в synapse — дефект." });

    // D-038: зона роли — это факт (как task.scope), а не шаблон. Вынесена в
    // verbatim-блок role.zone и не входит в overhead; authority.core несёт только
    // правило о зонах. Боевая длинная зона Executor Core (~158 зн.) пробивала
    // executor.card (2859 > 2800); вынос факта даёт запас без подъёма бюджета.
    def("role.zone", { verbatim: true, render: (c) => line("Зона роли", c.role?.zone) });

    def("authority.core", { version: 2, ruleIds: ["R-ZONES", "R-SECRETS"], render: () =>
      "Зона роли — рамка, Scope расширяет на ход; чужие зоны читай. Оракул не ослаблять. Неоднозначность — сам, обратимо, «Допущение:» в отчёт. Секреты не в чат/логи/Git. Файлы для показа не открывай." });

    def("authority.executor", { version: 2, ruleIds: ["R-ROLES"], audience: ["Executor"], render: () =>
      "Исполнитель: правишь зону+Scope, PR мержишь сам. Чужая правка — карточкой владельцу." });

    def("authority.auditor", { ruleIds: ["R-ROLES", "R-VERIFY-GITHUB"], audience: ["Auditor"], render: () =>
      "Аудитор: только чтение и проверка; ни ветки/коммита/пуша/PR. Находки — в отчёт, чинит исполнитель. Новые проверки можно, ослаблять нельзя." });

    def("authority.coordinator", { ruleIds: ["R-ROLES", "R-QUEUE", "R-NO-REVIEWER-DISPATCH", "R-MASTER-ONLY", "R-D028"], audience: ["Coordinator"], render: () =>
      "Координатор: решения в Notion; код/ветки/PR не твоя зона, git не нужен. Очередь твоя: нарезка, Кому, Sequence, Ready, Draft→Ready, Submitted, Accepted/Rework. Оракул миссии не менять — нужен ADR и решение приёмки/Мастера. «Роли» читаешь; Статус/Agent URL ставит Мастер." });

    def("authority.reviewer", { ruleIds: ["R-ROLES", "R-VERIFY-GITHUB", "R-MASTER-ONLY", "R-D028"], audience: ["Reviewer"], render: (c) =>
      c.kind === "arbiter"
        ? "Ты приёмка (Reviewer) и сейчас арбитр: ничего не правь — ни код, ни карточки, ни документы, ни постановку. Твой выход — решение по карточке или остановка цикла. Проверяй по GitHub, Notion и фактам, а не по словам агента; Мастера зовёшь только там, где без него физически нельзя."
        : "Ты приёмка (Reviewer): ничего не правь — ни код, ни карточки, ни документы. Твой выход — вердикт (accept/rework/master) или ответ на вопрос. Проверяй по GitHub и фактам, а не по словам агента. Вопрос агента закрываешь вместо Мастера; зовёшь Мастера только где без него физически нельзя." });

    def("git.executor", { version: 2, ruleIds: ["R-GIT"], audience: ["Executor"], render: (c) => {
      const base = c.target?.baseBranch || "main";
      return `GIT: fetch origin; merge-base HEAD origin/${base}; status --short (чужое не трогай/не сбрасывай). Закреплённую ветку не меняй; новую — только если разрешено. Коммит своих путей; пуш в разрешённую ветку; gh pr create --fill --base ${base}; gh pr merge <N> --squash. Direct push в ${base} запрещён. Нет изменений — "pr":null.`;
    } });

    def("git.auditor", { version: 2, ruleIds: ["R-GIT", "R-VERIFY-GITHUB"], audience: ["Auditor"], render: (c) => {
      const base = c.target?.baseBranch || "main";
      return `GIT read-only: истина — origin/${base}. fetch origin; log --oneline -5 origin/${base}; show origin/${base}:<путь>. PR: gh pr view <N> --json state,mergeCommit; gh pr diff <N>. Свою ветку эталоном не считай.`;
    } });

    def("evidence.rule", { ruleIds: ["R-EVIDENCE"], render: () =>
      "Доказательство: not run/тайм-аут/зелёный CI/мок ≠ pass; нужны команда, код возврата, артефакт, SHA. Визуал — сам открыл PNG и описал." });

    def("task.intent", { verbatim: true, render: (c) => line("Намерение", c.task?.intent || c.task?.title) });
    def("task.invariants", { verbatim: true, render: (c) => line("Инварианты", c.task?.invariants || "не заданы — держи поведение неизменным") });
    def("task.acceptance", { verbatim: true, ruleIds: ["R-EVIDENCE"], render: (c) => line("Оракул (как принимают)", c.task?.acceptance || "не задан") });
    def("task.scope", { verbatim: true, render: (c) => line("Scope", c.task?.scope || "не задан") });
    def("task.freedom", { verbatim: true, render: (c) => line("Свободно", c.task?.freedom || "как решишь, если проходят инварианты") });
    def("task.assignment", { version: 2, verbatim: (c) => Boolean(String(c.task?.payload || "").trim()) || Boolean(c.task?.payloadPointer && c.task?.payloadRef?.fileId), render: (c) => {
      // D-034: большое задание живёт в Drive payloads; в промпте — короткий
      // указатель (verbatim), а не сам текст. Оракул/Scope остаются inline.
      const ref = c.task?.payloadRef;
      if (c.task?.payloadPointer && ref && ref.fileId) {
        const url = ref.url || `https://drive.google.com/file/d/${ref.fileId}/view`;
        return `ЗАДАНИЕ — в файле Drive, прочитай его до работы: ${url}\nФайл: ${ref.fileId}. Оракул и Scope выше обязательны; файл их не заменяет и не ослабляет.`;
      }
      const body = String(c.task?.payload || "").trim();
      if (body) return `ЗАДАНИЕ\n${body}`;
      return "ЗАДАНИЕ: карточка и есть задание (поля выше).";
    } });

    def("questions.protocol", { ruleIds: ["R-QUESTIONS"], render: () =>
      'Вопрос — полем question в маркере {"text","options","default","hours"}; default обязателен (работа идёт по нему), ответ придёт строкой; ≤1 за ход. Опрос «можно?» в чате — остановка, не делай.' });

    def("adr.protocol", { ruleIds: ["R-QUESTIONS"], render: () =>
      "Контракт/оракул — только через question «ADR:» (3 варианта, default «оставить как есть»); до решения приёмки не меняется. proposed-файл: вопрос со ссылкой; статус accepted/rejected после ответа." });

    def("phases.bans", { ruleIds: ["R-PHASES"], render: () =>
      "Фазы 0–4: без платежей/каталога/загрузки/аккаунтов до их фаз; без запуска кода пользователей; без доли/валюты/комиссии; без платной инфра без лимита; ядро не open source без OSI; без пустых сервисов." });

    def("i18n.rule", { ruleIds: ["R-I18N"], audience: ["Executor"], render: () =>
      "i18n: 8 локалей (en,ru,zh-Hans,ja,pt-BR,de,fr,ko); текст только в каталогах; диагностика код+параметры; локаль не меняет правил." });

    def("card.fields", { ruleIds: ["R-CARD-FIELDS"], audience: ["Executor", "Auditor"], render: () =>
      "Поля карточки (Dispatch State, Run ID, Output Drive File ID, Recipient Agent ID, Started At, Submitted At, PR, Check) ставит скрипт; отчёт — поле report маркера." });

    def("answers.delta", { verbatim: true, render: (c) => [c.queue?.answersLine, c.queue?.openLine, c.queue?.answerLine].filter(Boolean).join("\n") });
    def("queue.snapshot", { verbatim: true, render: (c) => [
      c.queue?.summary ? `Очередь: ${c.queue.summary}` : "",
      c.queue?.ready, c.queue?.rework, c.queue?.draft,
    ].filter(Boolean).join("\n") });
    def("queue.drafts", { verbatim: true, render: (c) => c.queue?.draft || "" });

    def("queue.coordinator", { ruleIds: ["R-QUEUE", "R-NO-REVIEWER-DISPATCH"], audience: ["Coordinator"], render: () =>
      "Очередь: Running ставит транспорт и сам вернёт в Ready без хода — не перевыдавай. Running/Submitted — движок; Accepted/Rework/Ready — ты. Черновики правь под оракул, выдавай сам. Дубль номера правь, не создавай. Dependency — UUID той же миссии, Accepted, без Check=fail. Rework — для той же карточки: Rework + та же карточка в Ready (тот же Sequence), новую не создавай. Новая карточка — только если находка шире старой (новый оракул, другой Scope). Check=fail НЕ ставь Rework+Ready одним ответом (жди снимка и разбора Warden). Ready с меньшим Sequence не обходи молча. Scope покрывает артефакты оракула. Reviewer карточку не выдавай. Ход: Submitted→Accepted/Rework + выдай Ready/Draft; пусто после хода — незаконченный ход. Выполнено — «Итог» + next:\"done\" (передача приёмке). Running в очереди — это работа, которая идёт прямо сейчас. Движок ставит Running и Submitted; Accepted, Rework и Ready ставишь ты." });

    def("review.evidence", { verbatim: true, render: (c) => [
      c.queue?.acceptedCount != null ? `Принятых карточек: ${c.queue.acceptedCount}.` : "",
      c.queue?.accepted,
      c.mission?.result ? `ИТОГ МИССИИ:\n${c.mission.result}` : "ИТОГ МИССИИ: поле «Итог» пусто — повод не принимать.",
    ].filter(Boolean).join("\n") });
    def("review.protocol", { ruleIds: ["R-EVIDENCE", "R-VERIFY-GITHUB"], audience: ["Reviewer"], render: () =>
      "Смотри, выполнено ли то, о чём миссия, а не только «всё ли выдано». Каждый пункт оракула закрывай командой или артефактом; нельзя запустить команду — это замечание. Accepted — состояние карточки, не доказательство pass; Check=fail и остатки не скрывай. Заявленное в «Итоге» сверь с реально сделанным карточками." });

    def("answer.question", { verbatim: true, render: (c) => [
      c.question?.role ? `Вопрос задал: ${c.question.role}` + (c.question.card ? ` · карточка «${c.question.card}»` : "") : "",
      "ВОПРОС",
      c.question?.fullText || c.question?.text,
      c.question?.options?.length ? `Варианты: ${c.question.options.join(" · ")}` : "",
      c.question?.fallback ? `Вариант по умолчанию (работа идёт по нему сейчас): ${c.question.fallback}` : "",
      c.question?.sourceUrl && !String(c.question?.fullText || "").includes(c.question.sourceUrl) ? `Материал: ${c.question.sourceUrl}` : "",
    ].filter(Boolean).join("\n") });
    def("answer.protocol", { ruleIds: ["R-QUESTIONS"], audience: ["Reviewer"], render: () =>
      "Отвечай по существу: что делать, где граница, по какому признаку считать сделанным. Ответ самодостаточен — агент увидит его без твоего чата. По ADR решай в пределах делегированных полномочий, сам оракул/файлы не меняй. Мастера зови только когда без него физически нельзя (новый агент, доступ, решение по ТЗ)." });
    def("answer.resume", { audience: ["Reviewer"], render: () =>
      "Продолжение того же вопроса после эскалации Мастеру: question_id и turn_id прежние, новый ход не создаётся. Если Мастер уже внёс ответ в Notion и поставил «Решено» — ответ принят, строку не перезаписывай." });

    // ── D-053: арбитраж повторяющейся петли ────────────────────────────────
    // Пауза «карточку перевыдали N раз» перестала быть первой реакцией: сначала
    // разбор у Warden (Reviewer), и только его решение master останавливает цикл.
    def("arbiter.case", { verbatim: true, render: (c) => {
      const a = c.arbiter || {};
      return [
        `Карточка «${a.cardTitle || a.cardId}» · dispatch ${a.cardId} · mission_id ${a.missionId}`,
        a.role ? `Адресат: ${a.role}.` : "",
        `Перевыдач за ${a.windowHours ?? 6} ч: ${a.redispatchCount ?? 0} (порог ${a.redispatchLimit ?? 3}).`,
        a.reason ? `Почему снова в работе: ${a.reason}.` : "",
        a.state ? `Сейчас: «${a.state}»` + (a.check ? ` · Check=${a.check}` : "") + "." : "",
        a.answer ? `ОТВЕТ ИСПОЛНИТЕЛЯ (поле «Ответ», последнее):\n${a.answer}` : "ОТВЕТА ИСПОЛНИТЕЛЯ НЕТ: по карточке не записано ни одного результата.",
        a.pr ? `PR: ${a.pr}${a.prState ? ` (${a.prState})` : ""}` : "PR: нет.",
        a.attempts ? `ЖУРНАЛ ПОПЫТОК (свежие сверху):\n${a.attempts}` : "",
        a.queue ? `Очередь миссии: ${a.queue}` : "",
        "Факты выше — из Notion и GitHub. Отчёт агента в чате доказательством не считается.",
      ].filter(Boolean).join("\n");
    } });
    def("arbiter.protocol", { ruleIds: ["R-D028", "R-VERIFY-GITHUB", "R-MASTER-ONLY"], audience: ["Reviewer"], render: () =>
      "Ты арбитр петли, а не исполнитель: ничего не правь — ни код, ни карточки, ни документы. Ответь, почему одна и та же карточка возвращается в работу, и назови решение по карточке: verdict:resolve — поле action: ready (та же карточка заново, только с исправленной постановкой), rework (вернуть автору с причиной), accepted (работа на самом деле выполнена) или blocked (нужен человек); поле reason — проверяемая причина, по которой петля шла; поле fix — что именно исправить в постановке (или пусто). verdict:master — только когда без Мастера физически нельзя; это останавливает цикл. Повторять карточку без причины нельзя." });

    const markerJson = (c, name) => {
      if (name === "CF_COORDINATOR_RESULT") return `CF_COORDINATOR_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","status":"completed","next":"<роль|done>"}`;
      if (name === "CF_REVIEW_RESULT") return `CF_REVIEW_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","verdict":"accept","summary":"<на что опирался>"}`;
      if (name === "CF_ANSWER_RESULT") return `CF_ANSWER_RESULT {"question_id":"${c.question?.id}","turn_id":"${c.turnId || c.question?.turnId}","verdict":"answer","answer":"<решение>"}`;
      const auditor = c.role?.fn === "Auditor";
      // D-046: литерал `"merged":true` рядом с `"pr":"<URL|null>"` учил агента
      // противоречию «PR нет, но слит» — проверочные K-27 и K-34 уходили в
      // Blocked. Безопасное значение здесь — false: он не противоречит `pr:null`, а
      // для настоящего PR ведёт к проверке по GitHub, а не вместо неё. Когда
      // ставить true, говорит правило ниже. Шаблон обязан оставаться валидным
      // JSON: `validateMarkerIds` разбирает его целиком.
      return `CF_AGENT_RESULT {"dispatch_id":"${c.task?.id}","run_id":"${c.task?.runId}","status":"submitted","check":0,"report":"<путь>"` + (auditor ? "}" : `,"pr":"<URL|null>","merged":false}`);
    };
    def("marker.agent", { version: 3, ruleIds: ["R-MARKER"], audience: ["Executor", "Auditor", "Reviewer"], render: (c) => {
      if (c.delivery?.tier === "tool_limit") return [
        "Когда ход действительно завершён, сдай полный отчёт и последней строкой CF_AGENT_RESULT с этими IDs.",
        "Если продолжить нельзя — назови блокер, не выдумывай результат.",
        `CF_AGENT_RESULT {"dispatch_id":"${c.task?.id}","run_id":"${c.task?.runId}","status":"submitted"}`,
      ].join("\n");
      // D-036: в маркере аудитора нет pr/merged — не учим его полям, которых
      // у него нет, и экономим overhead под длинную зону роли (K-20).
      const fields = c.role?.fn === "Auditor"
        ? "check:0=pass."
        : "check:0=pass; без PR pr:null,merged:false; merged:true только после мержа.";
      // D-054: 07.11 агент трижды подряд прислал run_id с одной заменой знака —
      // он собирал UUID по памяти, а не копировал строку ниже. Просьба «ID из
      // промпта» такого не запрещает, и одна буква стоила паузы всему циклу.
      // Текст самый короткий из работающих: повтор ограничен 900 знаками
      // (relay-arena-swallow-smoke), а бюджет reminder.marker — 700.
      return [
        `ОТВЕТ: полный отчёт, затем последней строкой один маркер текстом (не HTML-комментарий, не вместо отчёта). ${fields} ID целиком из строки ниже:`,
        markerJson(c, "CF_AGENT_RESULT"),
      ].join("\n");
    } });
    // D-035: маркер стоит только в конце длинного plan-промпта, и Координатор
    // после десятка tool-вызовов его «не видел» и честно отказывался выдать
    // (правило «не восстанавливай по памяти»). Короткое напоминание в начале
    // праймит маркер; авторитетный формат с IDs остаётся в конце.
    def("coordinator.prime", { version: 2, ruleIds: ["R-MARKER"], audience: ["Coordinator"], render: () =>
      "Заверши ход маркером последней строкой; формат и IDs — в конце промпта." });
    def("marker.coordinator", { ruleIds: ["R-MARKER"], audience: ["Coordinator"], render: (c) => {
      if (c.delivery?.tier === "tool_limit") return [
        "Когда ход завершён, сдай полный отчёт и последней строкой CF_COORDINATOR_RESULT с этими IDs.",
        "Если без Мастера нельзя — используй blocked/need по правилам хода.",
        `CF_COORDINATOR_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","status":"completed","next":"<роль|done>"}`,
      ].join("\n");
      return [
        "Последней строкой ответа — ровно один маркер. mission_id и turn_id копируй из этого промпта. next — имя роли выдаваемой карточки или done. Остановка только next:\"blocked\" + need:\"<роль>\". Вопрос — поле question в том же JSON:",
        markerJson(c, "CF_COORDINATOR_RESULT"),
      ].join("\n");
    } });
    def("marker.review", { ruleIds: ["R-MARKER"], audience: ["Reviewer"], render: (c) => {
      if (c.delivery?.tier === "tool_limit") return [
        "Когда проверка завершена, последней строкой дай CF_REVIEW_RESULT: accept, rework или master.",
        "Если доказательств не хватает — не принимай миссию.",
        `CF_REVIEW_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","verdict":"accept"}`,
      ].join("\n");
      return [
      `ОТВЕТ — одной строкой в конце, ровно один маркер. verdict: accept (миссия закрыта), rework (замечания по пунктам, проверяемо), master (только когда без Мастера физически нельзя). Предел доработок ${c.mission?.reworkLimit ?? 3}:`,
      c.kind === "reminder" ? "" : `для возврата: CF_REVIEW_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","verdict":"rework","remarks":"<пункты замечаний>"}`,
      markerJson(c, "CF_REVIEW_RESULT"),
      ].filter(Boolean).join("\n");
    } });
    def("marker.arbiter", { ruleIds: ["R-MARKER"], audience: ["Reviewer"], render: (c) => {
      const ids = `{"dispatch_id":"${c.arbiter?.cardId}","turn_id":"${c.turnId}"`;
      const resolve = `CF_ARBITER_RESULT ${ids},"verdict":"resolve","action":"ready","reason":"<почему петля>","fix":"<что исправить>"}`;
      if (c.delivery?.tier === "tool_limit") return [
        "Когда разбор завершён, последней строкой дай CF_ARBITER_RESULT с этими IDs.",
        "Решение по карточке обязательно: resolve с action или master.",
        resolve,
      ].join("\n");
      // Последняя строка — шаблон resolve, а не master: скопированная без правки
      // строка продолжает работу по решению арбитра, но не останавливает цикл
      // молча. Остановка — осознанный выбор, а не значение по умолчанию.
      return [
        "ОТВЕТ — разбор текстом, затем последней строкой ровно один маркер, ID копируй из этого промпта. verdict: resolve — решение по карточке (action: ready — та же карточка заново с исправленной постановкой, rework — вернуть автору, accepted — работа выполнена, blocked — нужен человек; fix — правка постановки). verdict: master — только когда без Мастера физически нельзя; маркер с master останавливает цикл.",
        `остановить цикл: CF_ARBITER_RESULT ${ids},"verdict":"master","reason":"<чего не хватает>"}`,
        resolve,
      ].join("\n");
    } });
    def("marker.answer", { ruleIds: ["R-MARKER"], audience: ["Reviewer"], render: (c) => {
      if (c.delivery?.tier === "tool_limit") return [
        "Когда решение готово, последней строкой дай CF_ANSWER_RESULT: answer или master.",
        "Если вопрос уже решён вручную в Notion, не перезаписывай ответ.",
        `CF_ANSWER_RESULT {"question_id":"${c.question?.id}","turn_id":"${c.turnId || c.question?.turnId}","verdict":"answer"}`,
      ].join("\n");
      return [
        "ОТВЕТ — последней строкой один маркер: answer (самодостаточное решение) или master (чего не хватает). Агент и Координатор увидят ответ без твоего чата:",
        c.kind === "reminder" ? "" : `для вызова Мастера: CF_ANSWER_RESULT {"question_id":"${c.question?.id}","turn_id":"${c.turnId || c.question?.turnId}","verdict":"master","reason":"<чего не хватает>"}`,
        markerJson(c, "CF_ANSWER_RESULT"),
      ].filter(Boolean).join("\n");
    } });

    def("reminder.marker", { ruleIds: ["R-MARKER"], render: (c) => {
      const thin = c.reminder?.why === "thin";
      // D-067: «маркера нет» и «маркер есть, но без имени» — разные дефекты, и
      // лечатся они по-разному. Живой случай 07.11: Координатор прислал
      // {"next":…,"question":…} без имени маркера, а напоминание просило
      // «последнюю строку с CF_COORDINATOR_RESULT» — он смотрел на свой ответ,
      // видел там JSON и повторял его же до паузы. Напоминание обязано назвать
      // то, чего не хватает: имя перед JSON.
      const noName = c.reminder?.why === "no-name";
      const ids = c.reminder?.why === "ids";
      const prClaim = c.reminder?.why === "pr-claim";
      // Бюджет напоминания жёсткий (C.promptBudgets: reminder.marker + marker.agent
      // ≤ 700, из них 426 — сам шаблон маркера). Поэтому ветка «pr-claim» говорит
      // за себя и заменяет общую концовку: она уже просит поправить только маркер.
      return [
        `Техническое напоминание (${c.reminder?.attempt ?? 1} из ${c.reminder?.max ?? 2}; это не задание и не новый ход).`,
        // Ветка короткая намеренно: бюджет reminder.marker — 700, поднимать
        // нельзя, а пояснение про «переписывать не нужно» живёт в сообщении
        // транспорта (markerMissing), где бюджета нет.
        noName ? `В ответе есть JSON решения, но нет имени ${c.reminder?.markerName}. Поставь имя в начало этой же строки; JSON верный.`
          : ids ? `В маркере ${c.reminder?.markerName} нет dispatch_id/run_id этой выдачи либо они иные. Скопируй ID из строки ниже; работу не повторяй.`
          : prClaim ? `В маркере ${c.reminder?.markerName} "pr":null и "merged":true разом — так нельзя. Изменений не было — "pr":null,"merged":false. Слил свой PR — номер PR и "merged":true. Поправь только маркер.`
          : thin ? `В ответе пришёл только маркер ${c.reminder?.markerName}, без отчёта. Маркер без фактов не считается ответом.`
          : `В ответе не хватило последней строки с ${c.reminder?.markerName}.`,
        prClaim ? "" : noName ? "" : "Не повторяй сделанное: пришли ответ целиком; маркер — последней строкой, без кода и текста после.",
      ].filter(Boolean).join("\n");
    } });

    def("pilot.brief", { audience: ["pilot"], verbatim: true, render: (c) => c.pilot?.brief || "" });
    def("pilot.stop", { audience: ["pilot"], render: () =>
      "Финал — отчёт текстом: что сделано, как запущено, артефакты, журнал затруднений и допущения. Командные маркеры не используй." });
    def("pilot.repo", { audience: ["pilot"], render: (c) =>
      `Репо: ${c.pilot?.repo || "Creative36711/synapse"}@${c.pilot?.startSha || "main"}, read-only; запись только в локальный sandbox.` });

    def("delivery.recovery", { render: () =>
      "Это продолжение того же хода после сбоя доставки, не новая задача и не новая выдача. Сохрани все ID. Разбери снимок очереди и продолжи по правилам своей роли." });
    def("mission.returned", { verbatim: true, audience: ["Coordinator"], render: (c) => c.mission?.returned || "" });
    // D-042: обратная связь Координатору (отказ выдачи, подсказка по очереди).
    // Раньше note передавался в coordinatorPrompt, но не попадал в контекст —
    // Координатор не видел причину отказа и повторял запрещённый ход до паузы.
    def("plan.note", { verbatim: true, audience: ["Coordinator"], render: (c) => {
      const n = String(c.note || "").trim();
      return n ? `Обратная связь транспорта: ${n}` : "";
    } });
    def("drive.layout", { version: 2, ruleIds: ["R-REPO-BOUNDARY"], audience: ["Coordinator"], render: () =>
      "Drive: Arena/<project>/{logs,payloads,artifacts}; раскладка — docs/agents/drive.md. Payload Drive File ID — большое задание из Arena/<project>/payloads: транспорт шлёт указатель, оракул остаётся в промпте; для малых карточек обычно не нужен. Журнал попытки — logs; свободные результаты — artifacts." });
    // D-035: исполнитель/аудитор раньше не получали адрес папки артефактов
    // (drive.layout — только Координатору) и клали отчёты в корень Диска.
    // Блок короткий, чтобы влезть в бюджет auditor.card без его подъёма.
    def("drive.artifacts", { version: 2, ruleIds: ["R-EVIDENCE"], audience: ["Executor", "Auditor", "Reviewer"], render: (c) =>
      `Артефакты в Arena/${c.drive?.project || "<project>"}/artifacts, не корень Диска.` });
    def("delivery.retry", { render: (c) => {
      const id = String(c.task?.id || "");
      const url = c.task?.url || (id ? `https://app.notion.com/p/${id.replace(/-/g, "")}` : "");
      const fn = c.role?.fn || "Executor";
      // Compact-retry не должен нарушать роль: Auditor — только чтение,
      // Reviewer рабочую выдачу не получает (guard), Executor мержит сам.
      const boundary = fn === "Auditor"
        ? "Только чтение и проверка: без коммитов, push и PR merge. Оракул не ослабляй."
        : fn === "Reviewer"
          ? "Ничего не правь: только проверка и вердикт по правилам приёмки."
          : "Работай в своей зоне, PR мержи сам (gh pr merge --squash), оракул не ослабляй.";
      return `Arena не приняла полный текст ошибкой. Прочитай задание сам в карточке ${url || `(Notion ${id})`}: поля Намерение/Инварианты/Оракул/Scope и есть задание. Не жди повтора полного текста. ${boundary}`;
    } });

    // ── continuation после tool-call limit: тот же ход, новые IDs не создаём ──
    def("delivery.tool_limit", { render: (c) => {
      if (c.kind === "plan") return "Продолжи текущий ход Координатора после лимита инструментов. Это не новый ход и не новая миссия.\nНе трогай git. Разбери очередь с текущего места и продолжи план.";
      if (c.kind === "review") return "Продолжи приёмку миссии после лимита инструментов. Это не новая приёмка и не новый ход.\nНе правь код и карточки. Дочитай доказательства и вынеси вердикт.";
      if (c.kind === "answer") return "Продолжи ответ на вопрос после лимита инструментов. Это не новый вопрос и не новый ход.";
      if (c.kind === "arbiter") return "Продолжи разбор петли после лимита инструментов. Это не новая карточка и не новая выдача.\nНе правь код и карточки. Дочитай факты и вынеси решение по этой же карточке.";
      return "Продолжи текущий ход после лимита инструментов. Это не новая задача и не повторная выдача.\nНе начинай сначала и не дублируй уже сделанное. Восстанови контекст по своим последним действиям и продолжай только недостающее.";
    } });
    def("identity.continue", { render: (c) => {
      if (c.kind === "plan" || c.kind === "review") return `IDs прежние: mission_id=${c.mission?.id}, turn_id=${c.turnId}.`;
      if (c.kind === "answer") return `IDs прежние: question_id=${c.question?.id}, turn_id=${c.turnId || c.question?.turnId}.`;
      if (c.kind === "arbiter") return `IDs прежние: dispatch_id=${c.arbiter?.cardId}, turn_id=${c.turnId}.`;
      return `IDs прежние: dispatch_id=${c.task?.id}, run_id=${c.task?.runId}.`;
    } });
    def("role.boundary.continue", { ruleIds: ["R-ZONES", "R-GIT"], audience: ["Executor", "Auditor"], render: (c) =>
      c.role?.fn === "Auditor"
        ? "Только чтение и проверка: без коммитов, push и PR."
        : "Работай только в своём Scope и по правилам задания." });
    def("pilot.continue", { audience: ["pilot"], render: () =>
      "Продолжи пилотный ход с того места, где он остановился. Не начинай сначала.\nНе используй внутренние знания, командные маркеры и закрытые документы.\nЗаверши публичный отчёт по брифу: что сделано, как запущено, артефакты и затруднения." });

    // ── provisioning Arena-агентов: одобряет только активная админ-роль ──
    def("identity.provision", { audience: ["Coordinator", "Reviewer"], render: (c) =>
      `Provisioning-запрос Arena-агентов. Это не миссия и не рабочая карточка. request_id: ${c.provision?.requestId}.` });
    def("authority.provision", { audience: ["Coordinator", "Reviewer"], ruleIds: ["R-MASTER-ONLY"], render: () =>
      "Одобряй только создание/замену неадмин-ролей из списка. Нельзя одобрять админ-роли, удаление строк, ручную активацию и изменение прав. Сомнительного кандидата не включай. Архивация старого агента — внутреннее следствие replace, отдельной команды нет." });
    def("provision.candidates", { audience: ["Coordinator", "Reviewer"], verbatim: true, render: (c) =>
      `Кандидаты:\n${JSON.stringify((c.provision?.candidates || []).map((x) => ({
        role_page_id: x.rolePageId, role_name: x.roleName, fn: x.fn, repo: x.repo, action: x.action,
      })))}` });
    def("provision.policy", { audience: ["Coordinator", "Reviewer"], render: (c) =>
      `Верни только одобренные jobs (не больше ${c.provision?.maxJobs ?? 3}). Пустой jobs допустим. role_page_id бери из списка, role_name и repo — точно из свежей строки. action только create или replace. Ответ заверши одним маркером CF_AGENT_PROVISION_RESULT.` });
    def("marker.provision", { audience: ["Coordinator", "Reviewer"], ruleIds: ["R-MARKER"], render: (c) => [
      "Маркер — последней строкой. Команды archive/delete/activate/admin как отдельные команды запрещены.",
      `CF_AGENT_PROVISION_RESULT {"request_id":"${c.provision?.requestId}","jobs":[],"reason":"краткое обоснование"}`,
    ].join("\n") });

    return B;
  })();

  // ───────────────────────── профили промптов ─────────────────────────
  // Профиль — декларативный список блоков, обязательные факты, запрещённые
  // блоки/аудитории, бюджет overhead и тип маркера. Добавление роли или типа
  // выдачи — новый профиль, а не if внутри общей строки.
  const PROMPT_PROFILES = (() => {
    const team = ["Executor", "Auditor", "Coordinator", "Reviewer"];
    const P = {};
    const def = (id, spec) => { P[id] = { id, audience: team, requiredFacts: [], forbidden: [], marker: null, budget: { overhead: 0 }, ...spec }; };

    def("executor.card", {
      audience: ["Executor"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "repo.boundary", "role.zone", "authority.core", "authority.executor", "git.executor", "evidence.rule", "card.fields", "drive.artifacts", "task.intent", "task.invariants", "task.acceptance", "task.scope", "task.freedom", "task.assignment", "questions.protocol", "adr.protocol", "phases.bans", "i18n.rule", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["queue.coordinator", "review.protocol", "pilot.brief", "pilot.stop"],
      budget: { overhead: 2800 },
    });
    def("auditor.card", {
      audience: ["Auditor"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "repo.boundary", "role.zone", "authority.core", "authority.auditor", "git.auditor", "evidence.rule", "card.fields", "drive.artifacts", "task.acceptance", "task.scope", "task.assignment", "questions.protocol", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["git.executor", "queue.coordinator", "pilot.brief"],
      budget: { overhead: 2200 },
    });
    def("coordinator.plan", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["coordinator.prime", "identity.mission", "mission.returned", "plan.note", "repo.boundary", "role.zone", "authority.core", "authority.coordinator", "queue.snapshot", "answers.delta", "queue.coordinator", "drive.layout", "questions.protocol", "adr.protocol", "phases.bans", "marker.coordinator"],
      requiredFacts: ["role.name", "mission.id", "turnId"],
      forbidden: ["git.executor", "git.auditor", "marker.agent", "pilot.brief"],
      budget: { overhead: 3200 },
    });
    def("coordinator.recovery", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["coordinator.prime", "identity.mission", "plan.note", "authority.coordinator", "delivery.recovery", "queue.snapshot", "answers.delta", "marker.coordinator"],
      requiredFacts: ["mission.id", "turnId"],
      forbidden: ["git.executor", "marker.agent", "task.assignment"],
      budget: { overhead: 1500 },
    });
    def("reviewer.mission", {
      audience: ["Reviewer"], marker: "CF_REVIEW_RESULT",
      blocks: ["identity.mission", "queue.snapshot", "repo.boundary", "role.zone", "authority.core", "authority.reviewer", "evidence.rule", "review.evidence", "review.protocol", "questions.protocol", "marker.review"],
      requiredFacts: ["mission.id", "turnId"],
      forbidden: ["git.executor", "marker.agent", "task.assignment"],
      budget: { overhead: 2400 },
    });
    def("reviewer.answer", {
      audience: ["Reviewer"], marker: "CF_ANSWER_RESULT",
      blocks: ["identity.mission", "authority.reviewer", "answer.question", "answer.protocol", "answer.resume", "marker.answer"],
      requiredFacts: ["question.id", "turnId"],
      forbidden: ["git.executor", "marker.agent", "task.assignment"],
      budget: { overhead: 1800 },
      conditions: { "answer.resume": (c) => Boolean(c.question?.masterEscalated) },
    });
    // D-053: разбор повторяющейся петли. Это не приёмка миссии: оракула
    // миссии здесь нет, зато есть факты одной карточки и её журнал попыток.
    // Полного задания и git-записи у арбитра нет — он ничего не делает руками.
    def("reviewer.arbiter", {
      audience: ["Reviewer"], marker: "CF_ARBITER_RESULT",
      blocks: ["identity.mission", "arbiter.case", "authority.reviewer", "arbiter.protocol", "marker.arbiter"],
      requiredFacts: ["arbiter.cardId", "turnId"],
      forbidden: ["git.executor", "git.auditor", "marker.agent", "marker.review", "marker.answer",
        "task.assignment", "task.acceptance", "task.scope", "task.intent", "task.invariants", "task.freedom",
        "queue.coordinator", "review.evidence", "review.protocol", "answer.question", "answer.protocol",
        "questions.protocol", "adr.protocol", "marker.coordinator", "marker.provision"],
      budget: { overhead: 2400 },
    });
    def("reviewer.card", {
      audience: ["Reviewer"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "authority.reviewer", "evidence.rule", "drive.artifacts", "task.acceptance", "task.scope", "task.assignment", "marker.agent"],
      requiredFacts: ["task.id", "task.runId"],
      forbidden: ["git.executor"],
      budget: { overhead: 2000 },
    });
    def("reminder.marker", {
      audience: team, marker: null,
      blocks: ["identity.task", "reminder.marker", "marker.agent"],
      requiredFacts: [],
      forbidden: ["task.assignment", "queue.coordinator", "review.protocol"],
      budget: { overhead: 700 },
    });
    def("delivery.compact", {
      audience: ["Executor", "Auditor", "Reviewer"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "delivery.retry", "marker.agent"],
      requiredFacts: ["task.id", "task.runId"],
      forbidden: ["queue.coordinator", "review.protocol"],
      budget: { overhead: 1500 },
    });
    def("pilot.synapse", {
      audience: ["pilot"], marker: null,
      blocks: ["pilot.repo", "pilot.brief", "pilot.stop"],
      requiredFacts: ["pilot.brief", "pilot.startSha"],
      forbidden: team.flatMap(() => []).concat(["authority.core", "role.zone", "authority.executor", "authority.auditor", "authority.coordinator", "authority.reviewer", "marker.agent", "marker.coordinator", "marker.review", "marker.answer", "questions.protocol", "adr.protocol", "repo.boundary", "phases.bans"]),
      budget: { overhead: 250 },
    });

    // ── continuation после tool-call limit: тот же ход, без новых IDs ──
    // Аудитория строго по типу хода; маркер исходного хода; запрещены блоки
    // полного задания, очереди, регламента и pilot-блоки. Overhead ≤ 700.
    const contForbidden = ["identity.task", "identity.mission", "repo.target", "repo.boundary",
      "authority.core", "role.zone", "authority.executor", "authority.auditor", "authority.coordinator", "authority.reviewer",
      "git.executor", "git.auditor", "evidence.rule", "card.fields", "task.intent", "task.invariants",
      "task.acceptance", "task.scope", "task.freedom", "task.assignment", "queue.snapshot", "queue.coordinator",
      "answers.delta", "review.evidence", "review.protocol", "answer.question", "answer.protocol", "answer.resume",
      "questions.protocol", "adr.protocol", "phases.bans", "i18n.rule", "drive.layout", "mission.returned",
      "delivery.retry", "delivery.recovery", "reminder.marker", "pilot.brief", "pilot.stop", "pilot.repo"];
    def("continuation.dispatch", {
      audience: ["Executor", "Auditor"], marker: "CF_AGENT_RESULT",
      blocks: ["delivery.tool_limit", "role.boundary.continue", "identity.continue", "marker.agent"],
      requiredFacts: ["task.id", "task.runId"], forbidden: contForbidden,
      budget: { overhead: 700 },
    });
    def("continuation.plan", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["delivery.tool_limit", "identity.continue", "marker.coordinator"],
      requiredFacts: ["mission.id", "turnId"], forbidden: contForbidden,
      budget: { overhead: 700 },
    });
    def("continuation.review", {
      audience: ["Reviewer"], marker: "CF_REVIEW_RESULT",
      blocks: ["delivery.tool_limit", "identity.continue", "marker.review"],
      requiredFacts: ["mission.id", "turnId"], forbidden: contForbidden,
      budget: { overhead: 700 },
    });
    def("continuation.answer", {
      audience: ["Reviewer"], marker: "CF_ANSWER_RESULT",
      blocks: ["delivery.tool_limit", "identity.continue", "marker.answer"],
      requiredFacts: ["question.id", "turnId"], forbidden: contForbidden,
      budget: { overhead: 700 },
    });
    def("continuation.arbiter", {
      audience: ["Reviewer"], marker: "CF_ARBITER_RESULT",
      blocks: ["delivery.tool_limit", "identity.continue", "marker.arbiter"],
      requiredFacts: ["arbiter.cardId", "turnId"], forbidden: contForbidden,
      budget: { overhead: 700 },
    });
    def("continuation.pilot", {
      audience: ["pilot"], marker: null,
      blocks: ["pilot.continue"], requiredFacts: [],
      forbidden: contForbidden.concat(["marker.agent", "marker.coordinator", "marker.review", "marker.answer"]),
      budget: { overhead: 250 },
    });

    // Provisioning: отдельный административный запрос, не миссия и не карточка.
    def("admin.provision", {
      audience: ["Coordinator", "Reviewer"], marker: "CF_AGENT_PROVISION_RESULT",
      blocks: ["identity.provision", "authority.provision", "provision.candidates", "provision.policy", "marker.provision"],
      requiredFacts: ["provision.requestId", "provision.candidates"],
      forbidden: ["identity.task", "identity.mission", "mission.returned", "queue.snapshot", "queue.coordinator",
        "answers.delta", "git.executor", "git.auditor", "task.intent", "task.invariants", "task.acceptance",
        "task.scope", "task.freedom", "task.assignment", "review.evidence", "review.protocol", "answer.question",
        "answer.protocol", "answer.resume", "drive.layout", "delivery.retry", "delivery.recovery", "delivery.tool_limit",
        "reminder.marker", "pilot.brief", "pilot.stop", "pilot.repo", "pilot.continue",
        "marker.agent", "marker.coordinator", "marker.review", "marker.answer"],
      budget: { overhead: 1800 },
    });

    // Выбор профиля по kind + role.fn + tier.
    const select = (kind, fn, tier) => {
      if (kind === "provision") return "admin.provision";
      // tool-call limit — продолжение того же хода, не compact/retry/reminder.
      if (tier === "tool_limit") {
        if (kind === "pilot") return "continuation.pilot";
        if (kind === "plan") return "continuation.plan";
        if (kind === "review") return "continuation.review";
        if (kind === "answer") return "continuation.answer";
        if (kind === "arbiter") return "continuation.arbiter";
        return "continuation.dispatch";
      }
      if (kind === "pilot") return "pilot.synapse";
      if (kind === "reminder") return "reminder.marker";
      if (kind === "plan") return tier === "recovery" || tier === "compact" ? "coordinator.recovery" : "coordinator.plan";
      if (kind === "review") return "reviewer.mission";
      if (kind === "answer") return "reviewer.answer";
      if (kind === "arbiter") return "reviewer.arbiter";
      if (kind === "dispatch" || kind === "retry") {
        if (fn === "Auditor") return "auditor.card";
        if (fn === "Reviewer") return "reviewer.card";
        if (fn === "Coordinator") return "coordinator.plan";
        return "executor.card"; // неизвестная командная роль → Executor
      }
      return null;
    };
    return { profiles: P, select };
  })();

  // ───────────────────────── компилятор промптов ─────────────────────────
  // compilePrompt(request) выбирает профиль, проверяет факты/аудиторию/маркер/
  // бюджет и возвращает envelope либо типизированную ошибку. Ошибки компиляции
  // не отправляются в Arena: вызывающий ставит локальную паузу с причиной.
  const PromptCompiler = (() => {
    const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    const utf8Bytes = (s) => (enc ? enc.encode(s).length : Buffer.byteLength(s, "utf8"));
    const hash = (s) => { // FNV-1a 32-bit, детерминированный
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return ("00000000" + h.toString(16)).slice(-8);
    };
    const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const err = (code, message, detail) => ({ ok: false, error: { code, message, detail } });

    const reminderMarkerBlock = (name) => ({
      CF_AGENT_RESULT: "marker.agent", CF_COORDINATOR_RESULT: "marker.coordinator",
      CF_REVIEW_RESULT: "marker.review", CF_ANSWER_RESULT: "marker.answer",
      CF_ARBITER_RESULT: "marker.arbiter",
    }[name] || null);

    function metrics(text, parts) {
      const verbatimChars = parts.filter((p) => p.verbatim).reduce((a, p) => a + p.text.length, 0);
      return {
        chars: text.length,
        utf8Bytes: utf8Bytes(text),
        lines: text.split("\n").length,
        overheadChars: Math.max(0, text.length - verbatimChars),
      };
    }

    function compile(request) {
      const c = request || {};
      const kind = c.kind;
      const fn = c.role?.fn || "";
      const tier = c.delivery?.tier || "full";
      if (kind === "pilot" && fn !== "pilot") {
        return err("unknown_profile", `pilot требует роль pilot, получено «${fn || "неизвестно"}»`);
      }
      const profileId = c.profileId || PROMPT_PROFILES.select(kind, fn, tier);
      const profile = PROMPT_PROFILES.profiles[profileId];
      if (!profile) return err("unknown_profile", `нет профиля для kind=${kind} fn=${fn} tier=${tier}`);
      if (kind === "pilot" && !["pilot.synapse", "continuation.pilot"].includes(profileId)) return err("unknown_profile", "pilot обязан использовать pilot.synapse или continuation.pilot");

      for (const fact of profile.requiredFacts) {
        const v = get(c, fact);
        if (v === undefined || v === null || String(v).trim() === "") return err("missing_fact", `не хватает обязательного факта ${fact} для ${profileId}`);
      }

      // Разрешаем маркер для reminder и собираем список блоков.
      let blockIds = profile.blocks.slice();
      let markerName = profile.marker;
      if (kind === "reminder") {
        markerName = c.reminder?.markerName || null;
        const mb = reminderMarkerBlock(markerName);
        if (!mb) return err("marker_mismatch", `reminder не знает маркер ${markerName}`);
        blockIds = blockIds.filter((id) => !id.startsWith("marker."));
        blockIds = ["reminder.marker", mb];
      }

      const parts = [];
      for (const id of blockIds) {
        const block = PROMPT_BLOCKS[id];
        if (!block) return err("unknown_profile", `неизвестный блок ${id}`);
        if (profile.forbidden.includes(id)) return err("forbidden_block", `блок ${id} запрещён профилем ${profileId}`);
        const cond = profile.conditions?.[id];
        if (cond && !cond(c)) continue;
        // Аудитория: pilot-профиль не принимает командные блоки и наоборот.
        const aud = block.audience || [];
        const isPilotProfile = profileId === "pilot.synapse" || profileId === "continuation.pilot";
        const isPilotBlock = aud.includes("pilot");
        if (isPilotProfile !== isPilotBlock) {
          return err("forbidden_block", isPilotProfile ? `командный блок ${id} попал в pilot-профиль` : `pilot-блок ${id} попал в командный профиль`);
        }
        if (!isPilotProfile && fn && !aud.includes(fn)) {
          return err("forbidden_block", `блок ${id} не предназначен роли ${fn}`);
        }
        const text = String(block.render(c) || "").trim();
        if (!text) continue;
        const verbatim = typeof block.verbatim === "function" ? block.verbatim(c) : Boolean(block.verbatim);
        parts.push({ id, version: block.version, text, verbatim, ruleIds: block.ruleIds || [], hash: hash(text) });
      }

      // Маркер ровно один и последний смысловой блок.
      if (markerName) {
        const markerParts = parts.filter((p) => p.id.startsWith("marker."));
        if (markerParts.length !== 1) return err("marker_mismatch", `ожидался ровно один маркер ${markerName}, найдено ${markerParts.length}`);
        if (parts[parts.length - 1].id !== markerParts[0].id) return err("marker_mismatch", "маркер должен быть последним смысловым блоком");
        const mtext = markerParts[0].text;
        if (!mtext.includes(markerName)) return err("marker_mismatch", `маркер ${markerName} отсутствует в последнем блоке`);
        const idCheck = validateMarkerIds(markerName, mtext, c);
        if (idCheck) return err("marker_mismatch", idCheck);
      } else if (parts.some((p) => p.id.startsWith("marker."))) {
        return err("forbidden_block", "профиль без маркера не должен содержать marker-блок");
      }

      const text = parts.map((p) => p.text).join("\n\n");
      const m = metrics(text, parts);
      const ruleIds = [...new Set(parts.flatMap((p) => p.ruleIds))];
      // D-034: разбивка overhead по блокам — пауза должна говорить, какой блок
      // съел бюджет, а не только «overhead N > лимита».
      const breakdown = parts.map((p) => ({ id: p.id, chars: p.text.length, overhead: p.verbatim ? 0 : p.text.length, verbatim: p.verbatim }));

      if (profile.budget.overhead && m.overheadChars > profile.budget.overhead) {
        return err("budget_exceeded", `overhead ${m.overheadChars} > бюджета ${profile.budget.overhead} для ${profileId}`, { overhead: m.overheadChars, limit: profile.budget.overhead, blocks: breakdown });
      }
      const hard = c.delivery?.hardLimit || 0;
      if (hard && m.chars > hard) return err("budget_exceeded", `total ${m.chars} > жёсткого лимита ${hard}`, { total: m.chars, limit: hard, blocks: breakdown });

      return {
        ok: true, text, profileId, tier, marker: markerName,
        blocks: parts.map((p) => ({ id: p.id, version: p.version, hash: p.hash, verbatim: p.verbatim, chars: p.text.length, overhead: p.verbatim ? 0 : p.text.length })),
        ruleIds, metrics: m, hash: hash(text),
      };
    }

    const firstJsonObject = (text, from) => {
      const start = text.indexOf("{", from);
      if (start === -1) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth += 1;
        else if (ch === "}") { depth -= 1; if (depth === 0) return text.slice(start, i + 1); }
      }
      return null;
    };

    function validateMarkerIds(name, mtext, c) {
      const at = mtext.indexOf(name);
      const raw = firstJsonObject(mtext, at);
      if (!raw) return "маркер без JSON";
      let obj;
      try { obj = JSON.parse(raw); } catch { return "маркерный JSON не разбирается"; }
      const eq = (a, b) => String(a || "").replace(/-/g, "").toLowerCase() === String(b || "").replace(/-/g, "").toLowerCase();
      if (name === "CF_AGENT_RESULT") {
        if (c.task?.id && !eq(obj.dispatch_id, c.task.id)) return "dispatch_id маркера не совпадает с ctx";
        if (c.task?.runId && !eq(obj.run_id, c.task.runId)) return "run_id маркера не совпадает с ctx";
      } else if (name === "CF_COORDINATOR_RESULT" || name === "CF_REVIEW_RESULT") {
        if (c.mission?.id && !eq(obj.mission_id, c.mission.id)) return "mission_id маркера не совпадает с ctx";
        if (c.turnId && !eq(obj.turn_id, c.turnId)) return "turn_id маркера не совпадает с ctx";
      } else if (name === "CF_ANSWER_RESULT") {
        const qid = c.question?.id; const turn = c.turnId || c.question?.turnId;
        if (qid && !eq(obj.question_id, qid)) return "question_id маркера не совпадает с ctx";
        if (turn && !eq(obj.turn_id, turn)) return "turn_id маркера не совпадает с ctx";
      } else if (name === "CF_ARBITER_RESULT") {
        // D-053: вердикт арбитра относится к конкретной карточке и ходу.
        if (c.arbiter?.cardId && !eq(obj.dispatch_id, c.arbiter.cardId)) return "dispatch_id маркера не совпадает с карточкой арбитража";
        if (c.turnId && !eq(obj.turn_id, c.turnId)) return "turn_id маркера не совпадает с ctx";
      } else if (name === "CF_AGENT_PROVISION_RESULT") {
        if (c.provision?.requestId && !eq(obj.request_id, c.provision.requestId)) return "request_id маркера не совпадает с ctx";
      }
      return null;
    }

    // Стратегия доставки: full → payload-указатель → compact → пауза. Не режет
    // оракул молча. D-034: большое задание уходит указателем в Drive payloads
    // (оракул/Scope остаются inline), а не инлайном, разрывающим total-лимит.
    function forDelivery(request, { softLimit = 6000, hardLimit = 9000, payloadChannel = false } = {}) {
      const full = compile({ ...request, delivery: { ...request.delivery, tier: "full", hardLimit } });
      if (full.ok && full.metrics.chars <= softLimit) return { strategy: "full", envelope: full };
      if (payloadChannel && request.task?.payloadRef?.fileId) {
        const pointer = compile({
          ...request,
          task: { ...request.task, payload: "", payloadPointer: true, payloadRef: request.task.payloadRef },
          delivery: { ...request.delivery, tier: "full", hardLimit },
        });
        if (pointer.ok && pointer.metrics.chars <= hardLimit) return { strategy: "payload", envelope: pointer };
      }
      const compact = compile({ ...request, delivery: { ...request.delivery, tier: "compact", hardLimit } });
      if (compact.ok && compact.metrics.chars <= hardLimit) return { strategy: "compact", envelope: compact };
      const why = full.ok ? compact : full;
      return { strategy: "pause", error: why.error || { code: "budget_exceeded", message: "не удалось собрать сообщение в лимит" } };
    }

    return { compile, forDelivery, metrics, hash, reminderMarkerBlock };
  })();

  // ───────────────────────── факты и компиляция ─────────────────────────
  // Источник фактов для компилятора промптов. Ручного склеивания промпта здесь
  // больше нет: состав, порядок, маркер и бюджет проверяет PromptCompiler.
  // Блоки и профили живут в prompt-blocks.js / prompt-profiles.js.

  const promptRole = (role) => ({
    id: role?.id || "", name: role?.name || "", fn: role?.fn || "",
    repo: role?.repo || "", zone: role?.zone || "", gate: role?.gate || "",
  });

  const promptTarget = (ctx = {}) => ({
    repo: ctx.repo || C.repo || "",
    baseBranch: ctx.branch || ctx.baseBranch || C.branch || "main",
    startSha: ctx.startSha || "",
  });

  /** Журнал попыток доставки: профиль, объём, исход. Без секретов. */
  function recordPromptAttempt(envelope, meta = {}) {
    if (!envelope || !envelope.metrics) return;
    try {
      const key = "cfn-prompt-journal-v1";
      const prior = GM_getValue(key, []);
      const list = Array.isArray(prior) ? prior : [];
      list.push({
        at: nowIso(),
        profileId: envelope.profileId, tier: envelope.tier, hash: envelope.hash,
        blocks: envelope.blocks, ruleIds: envelope.ruleIds,
        chars: envelope.metrics.chars, utf8Bytes: envelope.metrics.utf8Bytes,
        lines: envelope.metrics.lines, overhead: envelope.metrics.overheadChars,
        kind: meta.kind || "", ref: meta.ref || "", role: meta.role || "",
        attempt: meta.attempt || 1, outcome: meta.outcome || "queued",
        errorClass: meta.errorClass || "",
        messageId: meta.messageId || "",
      });
      GM_setValue(key, list.slice(-200));
    } catch (e) { dbg("prompt-journal", String(e?.message || e)); }
  }

  /** Классификация отказа доставки/страницы для журнала попытки. */
  function classifyArenaFailure(text) {
    const t = String(text || "").toLowerCase();
    if (/captcha|recaptcha|security verification|подтвердите, что вы человек/.test(t)) return "captcha";
    if (/sign in|log in|unauthorized|\b401\b|authentication|войдите|авторизац/.test(t)) return "auth";
    if (/agent[^\n]{0,24}(unavailable|not found)|агент[^\n]{0,24}недоступ/.test(t)) return "agent_unavailable";
    // tool-call limit — ход уже начался; это не budget/rate/generic. Проверяем
    // раньше budget|лимит|превышен, иначе слово «limit» уводит в budget_exceeded.
    if (/the agent reached the tool-call limit for this turn|send a message to continue where it left off|tool[- ]call limit for this turn|лимит вызовов инструментов|достиг лимита инструментов/.test(t)) return "tool_call_limit";
    if (/rate limit|too many requests|\b429\b|слишком много запросов/.test(t)) return "rate_limit";
    if (/something went wrong|please try again|попробуйте ещё|что-то пошло не так/.test(t)) return "arena_generic_error";
    if (/send[^\n]{0,24}(disabled|недоступ)|кнопка[^\n]{0,24}неактив/.test(t)) return "send_disabled";
    if (/не нашёл поле|поле ввода|editor|contenteditable/.test(t)) return "editor_not_found";
    if (/network|failed to fetch|timeout|timed out|сеть|тайм-аут|не удалось загрузить/.test(t)) return "network";
    if (/budget|лимит|превышен/.test(t)) return "budget_exceeded";
    return "unknown";
  }

  /** Записать исход доставки в журнал попытки (профиль уже сохранён в expect). */
  function journalDelivery(expect, outcome, errorClass = "") {
    if (!expect || !expect.prompt) return;
    recordPromptAttempt(expect.prompt, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName,
      attempt: (Number(expect.tries) || 0) + 1, outcome, errorClass,
    });
  }

  /**
   * Скомпилировать запрос или поставить локальную паузу с причиной.
   * Ошибка компиляции не отправляется в Arena. Возвращает envelope или null.
   */
  function compileOrPause(request, label) {
    const result = PromptCompiler.compile(request);
    if (result.ok) return result;
    pause(
      `Промпт не собран (${label}): ${result.error.code} — ${result.error.message}. ` +
        `${budgetBreakdownLine(result.error)}` +
        "Отправка не выполнялась; исправьте факты/профиль и нажмите «Продолжить».",
      { kind: "prompt-compile", ref: request?.task?.id || request?.mission?.id || request?.question?.id || "" },
    );
    return null;
  }

  /** D-034/D-043: какие блоки съели бюджет — топ-4 по связанному лимиту.
   * При total показываем полный размер fact-блоков, а не их нулевой overhead:
   * K-29 упёрлась в оракул/Scope, но прежняя диагностика называла marker/git. */
  function budgetBreakdownLine(error) {
    const blocks = error?.detail?.blocks;
    if (!Array.isArray(blocks) || !blocks.length) return "";
    const total = Number(error?.detail?.total) > 0;
    const key = total ? "chars" : "overhead";
    const top = blocks.filter((b) => b[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 4)
      .map((b) => `${b.id} ${b[key]}`).join(", ");
    if (!top) return "";
    return total ? `Размер блоков (знаки): ${top}. ` : `Overhead по блокам: ${top}. `;
  }

  // ───────────────────────────── промпты ─────────────────────────────
  // Тонкие адаптеры к PromptCompiler. Вызывающие места передают факты, а не
  // собранный текст; состав/порядок/маркер/бюджет проверяет компилятор.

  /** Текст задания для журнала попытки: файл важнее карточки. */
  function assignmentBody(task, payload) {
    const body = String(payload || "").trim();
    if (body) return body;
    return [
      "Отдельного файла с текстом задания нет: карточка и есть задание.",
      "Сделай ровно то, что описано в «ЦЕЛЬ И ГРАНИЦЫ»: Намерение, Инварианты, Оракул, Scope.",
      "Если чего-то не хватает — реши обратимо и запиши (неясно/решил/откат) в docs/decisions/<миссия>.md, если Scope разрешает; иначе в отчёт.",
    ].join("\n");
  }

  /** Журнал попытки — файл в Arena/logs с заданием и маркером записи. */
  function taskLogEntry(task, role, payload, runId) {
    const marker = `<!-- CF_DISPATCH ${task.id}:${runId}:task -->`;
    return [
      marker,
      `## Задание ${taskTitle(task)}`,
      "",
      `- dispatch: \`${task.id}\``,
      `- run: \`${runId}\``,
      `- кому: ${role.name}`,
      `- repository: ${rt(task.properties?.Repository) || rt(task.properties?.["Репозиторий"]) || role.repo || "наследуется из repo роли"}`,
      `- выдано: ${nowIso()}`,
      "",
      "### Намерение",
      rt(task.properties["Намерение"]) || taskTitle(task),
      "",
      "### Инварианты",
      rt(task.properties["Инварианты"]) || "не заданы — держи поведение неизменным",
      "",
      "### Оракул",
      rt(task.properties["Acceptance"]) || "не задан",
      "",
      "### Scope",
      rt(task.properties["Scope"]) || "не задан",
      "",
      "### Задание",
      assignmentBody(task, payload),
      "",
    ].join("\n");
  }

  const taskFacts = (task, runId, payload, payloadRef = null, payloadPointer = false) => ({
    id: task.id, runId,
    title: taskTitle(task),
    intent: rt(task.properties["Намерение"]) || taskTitle(task),
    invariants: rt(task.properties["Инварианты"]),
    acceptance: rt(task.properties["Acceptance"]),
    scope: rt(task.properties["Scope"]),
    freedom: rt(task.properties["Свободно"]),
    payload: String(payload || "").trim(),
    payloadRef: payloadRef && payloadRef.fileId ? payloadRef : null,
    payloadPointer: Boolean(payloadPointer && payloadRef && payloadRef.fileId),
  });

  // D-034: total-лимиты выдачи по ролям (docs/agents/protocol.md). Раньше они
  // жили только в оракулах; теперь их соблюдает и боевой путь доставки.
  // D-039: Executor поднят 6500 → 7500 (явное бюджетное решение). После диеты
  // D-036 и verbatim-зоны D-038 overhead стал lean (~2678, не зависит от зоны);
  // боевая K-21 (total 6642) упёрлась в total-лимит из-за подлинного контента
  // задачи (оракул/инварианты), который не режется молча (D-034).
  //
  // D-048: 7500 → 8000 решением Мастера. 06.11 боевая K-43 встала на 7802 при
  // одном лишь комментарии к примеру: оракул 2541, намерение 944, Scope 747,
  // инварианты 642 — выдать было нечего, кроме как разбить карточку, которая и
  // так делает правку в один абзац. Оракул по-прежнему verbatim: лимит поднят
  // не ради сокращения проверок, а чтобы обычная карточка не рождала вторую.
  const DISPATCH_TOTAL = { Executor: 8000, Auditor: 5500, Reviewer: 7000 };

  /** Выдача рабочей карточки (Executor/Auditor/историческая Reviewer). */
  function executorPrompt(task, role, payload, logId, runId, missionId = "", ctx = {}) {
    const request = {
      kind: "dispatch",
      role: promptRole(role),
      target: promptTarget(ctx),
      task: taskFacts(task, runId, payload, ctx.payloadRef || null, Boolean(ctx.payloadPointer)),
      mission: missionId ? { id: missionId } : undefined,
      // D-035: адрес папки артефактов — иначе исполнитель/аудитор кладёт в корень.
      drive: { project: C.driveFolder || C.projectName || "" },
      delivery: { tier: "full", attempt: 1 },
    };
    const delivery = PromptCompiler.forDelivery(request, {
      softLimit: 6000,
      hardLimit: DISPATCH_TOTAL[role?.fn] || 9000,
      payloadChannel: Boolean(ctx.payloadRef?.fileId),
    });
    if (delivery.strategy === "pause") {
      // D-043: выдача проверяет промпт до Running и получает отказ как причину
      // для нового плана. Общая пауза остаётся запасным путём и третьим промахом.
      const advice = typeof ctx.onCompileError === "function"
        ? delivery.error.code === "budget_exceeded"
          ? "Карточка осталась Ready, агенту ничего не отправлено. Перепланируй постановку: убери повторы и справочные детали, сохрани обязательные проверки; при необходимости разбей работу на последовательные карточки с полными условиями и Dependency. Не ослабляй и не обрезай оракул. Payload Drive File ID вмещает большой текст задания, но не заменяет inline-оракул/Scope. Затем повтори next с исправленной карточкой."
          : "Карточка осталась Ready, агенту ничего не отправлено. Исправь названные факты/профиль карточки и повтори next."
        : "Отправка не выполнялась; исправьте факты/профиль и нажмите «Продолжить».";
      const reason = `Промпт не собран (dispatch ${task.id}): ${delivery.error.code} — ${delivery.error.message}. ` +
        `${budgetBreakdownLine(delivery.error)}${advice}`;
      if (typeof ctx.onCompileError === "function") {
        ctx.onCompileError(reason);
        return null;
      }
      pause(reason, { kind: "prompt-compile", ref: task.id });
      return null;
    }
    return delivery.envelope;
  }

  /** Ссылка на журнал последнего ответа — только для Координатора. */
  function answerLogLine(cards) {
    const at = (card) => card?.properties?.["Submitted At"]?.date?.start || "";
    const rows = (cards || [])
      .filter((card) => rt(card.properties["Output Drive File ID"]))
      .sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));
    const card = rows.at(-1);
    if (!card) return "";
    const id = taskTitle(card).split("·")[0].trim() || taskTitle(card);
    const who = taskRole(card) || "исполнителя";
    const link = `https://drive.google.com/file/d/${rt(card.properties["Output Drive File ID"])}/view`;
    return `Журнал ответа ${who} (${id}): ${link} — прочитай, если нужны детали ответа.`;
  }

  function coordinatorPrompt(
    mission, role, queueSummary, turnId, note = "", answerLine = "", drafts = "",
    ready = "", rework = "", openQuestions = "", answers = "", ctx = {},
  ) {
    const envelope = compileOrPause({
      kind: "plan",
      role: promptRole(role),
      target: promptTarget(ctx),
      mission: {
        id: mission.id, name: rt(mission.properties["Миссия"]),
        tzUrl: mission.properties["ТЗ URL"]?.url || "", round: missionRound(mission),
        reworkLimit: C.reworkLimit, returned: returnBlock(mission),
      },
      turnId,
      note,
      queue: { summary: queueSummary, ready, rework, draft: drafts, answerLine, openLine: openQuestions, answersLine: answers },
      delivery: { tier: "full", attempt: 1 },
    }, `plan ${mission.id}`);
    return envelope;
  }

  // ───────────────────────────── ход исполнителя ─────────────────────────────
  /**
   * Запись ответа в журнал хода — с возвратом ссылки, если поле в карточке
   * переписали.
   *
   * `Output Drive File ID` — единственная ссылка на журнал попытки, и её может
   * переписать любой, у кого есть доступ к карточке. На NAR-2.13 (25.10,
   * 15:59Z) Runtime Auditor создал `Arena/reports`, положил туда отчёт и вписал
   * его id в это поле вместо журнала. Шлюз отказал по делу — «Запись разрешена
   * только в текстовые файлы Arena/logs», — а скрипт назвал это «шлюз Drive не
   * ответил» и встал на паузу: Мастер пошёл проверять развёртывание, хотя шлюз
   * был жив и прав.
   *
   * Порядок: обычная запись → отказ про папку → журнал этой выдачи
   * (`createLog` идемпотентен по паре Dispatch/Run) → запись в него → ссылка
   * возвращается в карточку. Отчёт агента не трогается: он не журнал.
   */
  async function appendToJournal(dispatchId, runId, declaredLogId, marker, entry) {
    const refusedBecauseOfFolder = (e) =>
      Boolean(e && e.refused) &&
      /текстовые файлы/i.test(String(e.reason || (e && e.message) || e));
    try {
      const wrote = await gateway("append", declaredLogId, { marker, entry });
      return { wrote, logId: declaredLogId };
    } catch (e) {
      if (!refusedBecauseOfFolder(e)) throw e;
      log(
        `Поле «Output Drive File ID» указывает не на журнал (${declaredLogId}): ` +
          `шлюз пишет только в ${(typeof C !== "undefined" && C.driveFolder) ? `Arena/${C.driveFolder}/logs` : "Arena/logs"}. Беру журнал этой выдачи и возвращаю ссылку в карточку.`,
        true,
        { ntfy: false },
      );
      let journalId = "";
      try {
        const created = await gateway("createLog", "", { dispatchId, runId });
        journalId = String(
          (created && (created.fileId || (created.result && created.result.fileId))) || "",
        );
      } catch (createdError) {
        log(`Журнал этой выдачи не открылся: ${createdError.message}`, true, { ntfy: false });
        throw e;
      }
      if (!journalId) throw e;
      if (journalId !== declaredLogId) {
        try {
          const fresh = await notion("GET", `pages/${dispatchId}`);
          if (taskState(fresh) !== "Running" || !runId || norm(rt(fresh.properties?.["Run ID"])) !== norm(runId)) {
            throw new Error("карточка уже не принадлежит этой выдаче");
          }
          await patch(dispatchId, {
            "Output Drive File ID": { rich_text: [{ type: "text", text: { content: journalId } }] },
          });
          log(`Ссылка на журнал возвращена в карточку: ${journalId}.`);
        } catch (patchError) {
          log(`Ссылка на журнал не вернулась в карточку: ${patchError.message}`, true, { ntfy: false });
        }
      }
      const wrote = await gateway("append", journalId, { marker, entry });
      return { wrote, logId: journalId };
    }
  }

  /** Reviewer сдаёт именно свою выдачу; чужой вердикт нельзя «починить» подстановкой ID. */
  function reviewerDispatchEvidence(messages, hit, expect) {
    const matchField = (obj, expected, names) => {
      const values = names.map((name) => obj?.[name]).filter((v) => v !== undefined && v !== null && String(v).trim());
      return isUuid(expected) && values.length > 0 && values.every((value) => isUuid(value) && norm(value) === norm(expected));
    };
    const match = (obj) => matchField(obj, expect.ref, ["dispatch_id", "dispatch", "dispatchId"]) &&
      matchField(obj, expect.runId, ["run_id", "run", "runId"]);
    if (!match(hit.result)) return { error: "маркер сдачи относится к другой карточке или Run ID" };
    const agent = parseMarker(hit.raw, "CF_AGENT_RESULT");
    if (agent && String(agent.status || "").trim().toLowerCase() !== "submitted") {
      return { error: "в CF_AGENT_RESULT нет status submitted" };
    }
    const decision = messages.map((m) => parseMarker(m.raw, "CF_REVIEW_RESULT")).filter(Boolean).at(-1) || null;
    if (!decision) return { decision: null, verdict: "" };
    if (!match(decision)) return { error: "вердикт относится к другой карточке или Run ID" };
    if (decision.mission_id && expect.missionId && norm(decision.mission_id) !== norm(expect.missionId)) {
      return { error: "вердикт относится к другой миссии" };
    }
    const verdict = String(decision.verdict || "").trim().toLowerCase();
    if (!["accept", "rework", "master"].includes(verdict)) return { error: "в вердикте нет accept, rework или master" };
    if (verdict === "rework" && !String(decision.remarks || "").trim()) return { error: "rework без замечаний" };
    return { decision, verdict };
  }

  /** Ожидание могло смениться в другой вкладке во время сетевого запроса. */
  function currentDispatch(expect) {
    const live = GM_getValue(K.expect, null);
    return Boolean(live && live.kind === "dispatch" && expect?.runId &&
      norm(live.ref) === norm(expect.ref) && norm(live.runId) === norm(expect.runId) &&
      (!expect.roleId || norm(live.roleId) === norm(expect.roleId)));
  }

  /** Сверка карточки перед записью; Notion не предоставляет атомарный compare-and-set. */
  function dispatchGuard(page, expect, role) {
    if (taskState(page) !== "Running") return "карточка уже не Running";
    const run = rt(page.properties?.["Run ID"]);
    if (!expect.runId || !run || norm(run) !== norm(expect.runId)) return "Run ID карточки изменился или отсутствует";
    const missionId = rt(page.properties?.["Mission ID"]).trim();
    if (!expect.missionId || !isUuid(expect.missionId) || !isUuid(missionId) || norm(missionId) !== norm(expect.missionId))
      return "Mission ID карточки изменился, отсутствует или не совпадает с выдачей";
    const owner = rt(page.properties?.["Recipient Agent ID"]);
    if (expect.roleId && norm(expect.roleId) !== norm(role.id)) return "ожидание адресовано другому агенту";
    if (role.fn === "Reviewer" && !owner) return "в карточке не указан адресат выдачи";
    if (owner && norm(owner) !== norm(role.id)) return "карточка выдана другому агенту";
    return "";
  }

  /** Время до чтения ответа, без проверки PR и без подмены началом напоминания. */
  function executorDuration(expect, page, finishedAt = Date.now()) {
    let start = Number(expect?.dispatchSentAt) || 0;
    if (!start) start = Date.parse(page?.properties?.["Started At"]?.date?.start || "");
    // sentAt мог относиться к напоминанию или ручному поиску ответа, поэтому
    // без исходной отметки и Started At время не угадываем.
    if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(finishedAt) || start > finishedAt) return "";
    const seconds = Math.floor((finishedAt - start) / 1000);
    if (!seconds) return "менее 1 с";
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours) return `${hours} ч ${minutes} мин`;
    if (minutes) return `${minutes} мин ${seconds % 60} с`;
    return `${seconds} с`;
  }

  function executorNtfyText(page, role, expect, finishedAt, outcome) {
    const duration = executorDuration(expect, page, finishedAt);
    return `«${taskTitle(page)}» — ${role.name}: ${outcome}.` +
      (duration ? ` До обработки ответа: ${duration}.` : "");
  }

  // D-040: различаем «ID выдачи в маркере нет» (формат-дефект: агент сделал
  // работу, но не скопировал dispatch_id/run_id) и «ID чужие/битые» (возможно,
  // ответ прошлой выдачи). Первое — напоминаем с точными ID через ту же
  // лестницу, что и при отсутствии маркера; второе — сразу пауза, чужой ответ
  // не принимаем. Значения ID не подменяются ни в одном случае (adoptIds).
  function dispatchIdState(result, expect) {
    const values = (names) => names
      .map((name) => result?.[name])
      .filter((value) => value !== undefined && value !== null && String(value).trim());
    const gap = (vals, expected) => {
      if (!vals.length) return "missing";
      if (!isUuid(expected) || vals.some((value) => !isUuid(value) || norm(value) !== norm(expected))) return "conflict";
      return "ok";
    };
    const d = gap(values(["dispatch_id", "dispatch", "dispatchId"]), expect.ref);
    const r = gap(values(["run_id", "run", "runId"]), expect.runId);
    if (d === "conflict" || r === "conflict") return "conflict";
    if (d === "missing" || r === "missing") return "missing";
    return "match";
  }

  /**
   * D-054: Run ID, отличающийся от выдачи ОДНИМ знаком, — опечатка копирования.
   *
   * 07.11 (17:04) Executor Platform сдал карточку S-4 маркером, где run_id
   * отличался от выдачи ровно одним символом: a437578a-e5d6-… против
   * a437578a-e5db-…. Работа была сделана (тот же dispatch в первой строке
   * карточки, тот же отчёт, PR #26 в тексте, верный dispatch_id), но транспорт
   * отнёс ответ к «чужим ID» и встал на паузу marker-mismatch. Мастеру пришлось
   * разбираться из-за одного знака.
   *
   * `uid()` — это crypto.randomUUID(), случайный v4: узнавать «ту же машину» по
   * общему началу нельзя. Строгость даёт не похожесть строк, а число отличий:
   * у двух независимых выдач UUID совпадёт во всех знаках, кроме одного, с
   * вероятностью 2^-123. Поэтому правило узкое — ровно одна замена. Формат
   * (длина, дефисы, hex) уже проверяет isUuid, он же отсекает сдвиги строки.
   *
   * Само по себе это ещё не приёмка: рядом обязательна карточка Notion с
   * ОЖИДАЕМЫМ run (его ставил сам скрипт) и верный dispatch_id. Иначе — пауза.
   */
  function looksLikeTypo(value, expected) {
    const a = String(value || "").trim().toLowerCase();
    const b = String(expected || "").trim().toLowerCase();
    if (!isUuid(a) || !isUuid(b) || a === b) return false;
    let diff = 0;
    for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) diff += 1;
    return diff === 1;
  }

  /**
   * Значения run в маркере: короткие синонимы равноправны длинному, поэтому
   * опечатку ищем во всех, а не только в `run_id`.
   */
  const runValues = (result) => ["run_id", "run", "runId"]
    .map((name) => result?.[name])
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim());

  /**
   * Карточка подтверждает, что опечатка — именно про эту выдачу.
   * `checked: false` означает «спросить не удалось», и тогда решение остаётся
   * прежним: чужой ответ не принимаем.
   */
  async function typoTiedToCard(role, expect, result) {
    try {
      const page = await notion("GET", `pages/${expect.ref}`);
      const run = rt(page?.properties?.["Run ID"]).trim();
      const owner = rt(page?.properties?.["Recipient Agent ID"]).trim();
      if (!run || norm(run) !== norm(expect.runId)) return { checked: true, ok: false };
      if (role?.id && owner && norm(owner) !== norm(role.id)) return { checked: true, ok: false };
      const values = runValues(result);
      if (!values.length || !values.every((value) => looksLikeTypo(value, expect.runId))) {
        return { checked: true, ok: false };
      }
      return { checked: true, ok: true };
    } catch {
      return { checked: false, ok: false };
    }
  }

  /** Все синонимы run приводятся к выдаче: иначе они противоречат друг другу. */
  const alignRunValues = (result, expect) => {
    const fixed = { ...result, run_id: expect.runId };
    for (const name of ["run", "runId"]) if (fixed[name] !== undefined) fixed[name] = expect.runId;
    return fixed;
  };

  async function submitExecutor(role, expect, manual = false) {
    const receivedAt = Date.now();
    if (!expect || expect.kind !== "dispatch") {
      pause("Это не ход по карточке: ответ не записываю.", { kind: "handoff-kind", ref: expect?.ref || "" });
      return true;
    }
    const replies = messagesAfter(expect.watermark);
    const candidates = replies
      .map((m) => ({ ...m, result: parseMarker(m.raw, "CF_AGENT_RESULT") || parseMarker(m.raw, "CF_REVIEW_RESULT") }))
      .filter((m) => m.result);
    // Синонимы допустимы, но ни один из них не может противоречить выдаче.
    // Совпадение только карточки недостаточно: она могла быть перевыдана.
    const matchesId = (result, names, expected) => {
      const values = names.map((name) => result?.[name]).filter((value) => value !== undefined && value !== null && String(value).trim());
      return Boolean(isUuid(expected) && values.length && values.every((value) => isUuid(value) && norm(value) === norm(expected)));
    };
    const matchesDispatch = (result) => matchesId(result, ["dispatch_id", "dispatch", "dispatchId"], expect.ref) &&
      matchesId(result, ["run_id", "run", "runId"], expect.runId);
    // Последний результат не заменяем более ранним подходящим: если новый
    // прислан с чужими ID, нужно сохранить его и остановиться для разбора.
    let hit = candidates.at(-1);
    if (!hit) {
      // Напоминания исчерпаны — дальше пауза не помогает: работа сделана, а
      // страдает только формат. Читаем ответ по тексту, но обязательно с id
      // этой выдачи и номером PR: иначе за результат сойдёт любая реплика.
      const last = messagesAfter(expect.watermark).at(-1);
      const loose =
        role.fn !== "Reviewer" && last && Number(expect.tries) >= C.markerReminders
          ? looseResult(last.raw, role, expect)
          : null;
      if (loose) {
        log(
          `${role.name} написал ответ без строки-маркера — разобрал по тексту: PR #${loose.pr}` +
            `${loose.merged ? ", слит" : ""}. Повторять работу не нужно.`,
          true,
          { ntfy: "quiet", title: "Relay: ответ без маркера" },
        );
        hit = { ...last, result: loose };
      }
    }
    if (!hit) {
      // Отказ среды, а не молчание агента: ветка прошлого хода слита, и новый
      // прогон в ней невозможен. Напоминания и пауза «нет маркера» здесь
      // бессмысленны — сначала Continue и одна повторная выдача (27.10, NAR-4.9).
      const lastReply = messagesAfter(expect.watermark || "").at(-1);
      if (
        lastReply &&
        !stillWorking() &&
        staleBranchRefusal(lastReply.raw) &&
        retryStaleBranchHandoff(expect)
      ) {
        // Отправляем прямо здесь: шаг уже выполняется, отложенный тик съел бы
        // сторож блокировки (та же причина, что у переотправки после ошибки).
        const again = await consumePending(true);
        if (!again) {
          log(
            "Повторная выдача не началась на этой странице — задание в очереди и уйдёт следующим шагом.",
            true,
            { ntfy: "quiet" },
          );
        }
        return true;
      }
      return markerMissing(role, expect, "CF_AGENT_RESULT", manual);
    }

    let retained = false;
    if (!matchesDispatch(hit.result)) {
      retained = retainRejectedResult(expect, "dispatch-identity", replies);
      // D-040: маркер есть, но ID выдачи не указаны — это формат-дефект, а не
      // чужой ответ. Напоминаем с точными ID (лестница markerReminders), работу
      // не повторяем. Чужие/битые ID — по-прежнему сразу пауза для разбора.
      if (dispatchIdState(hit.result, expect) === "missing") {
        return markerMissing(role, expect, "CF_AGENT_RESULT", manual, "ids");
      }
      // D-054: единственная опечатка в Run ID при верном dispatch_id и карточке,
      // которая всё ещё несёт ожидаемый run, — формат-дефект, а не чужой ответ.
      // Работа сделана; повторять её из-за одного знака нельзя. ID не подменяем:
      // запись идёт по выдаче, а в журнал попадает и то, что прислал агент.
      if (dispatchIdState(hit.result, expect) === "conflict") {
        const tied = await typoTiedToCard(role, expect, hit.result);
        if (tied.ok) {
          log(
            `${role.name} прислал Run ID с опечаткой (${runValues(hit.result)[0]} вместо ${expect.runId}) — ` +
              "карточка и dispatch_id этой выдачи совпали, принимаю ответ без повтора работы.",
            true,
            { ntfy: "quiet", title: "Relay: опечатка в Run ID" },
          );
          // Копия присланного сохраняется: в журнал попадёт и опечатка, и то,
          // что приняли. ID выдачи не подменяется — запись идёт по ожиданию.
          retainRejectedResult(expect, "dispatch-typo", replies);
          hit = { ...hit, result: { ...alignRunValues(hit.result, expect), run_id_typo: runValues(hit.result)[0] } };
        } else if (tied.checked) {
          log(
            `${role.name} прислал Run ID не этой выдачи (${runValues(hit.result)[0]} вместо ${expect.runId}) — ` +
              "это не опечатка: карточка несёт другие данные. Ответ не принимаю.",
            true,
            { ntfy: "quiet" },
          );
        }
      }
    }
    if (!matchesDispatch(hit.result)) {
      pause("Ответ не подтверждён для текущей карточки и попытки (dispatch_id / run_id). " +
        (retained ? "Карточка, ожидание и копия ответа сохранены локально; " : "Карточка и ожидание сохранены, локальная копия не записалась — сохраните ответ из чата вручную; ") +
        "попросите агента повторить маркер с ID этой выдачи.", {
        kind: "marker-mismatch", ref: expect.ref || "", runId: expect.runId || "",
      });
      return true;
    }
    const review = role.fn === "Reviewer" ? reviewerDispatchEvidence(replies, hit, expect) : null;
    if (review?.error) {
      const retained = retainRejectedResult(expect, "review-identity", replies);
      pause(`Ответ Reviewer не привязан к текущей выдаче: ${review.error}. Карточку и миссию не меняю. ` +
        (retained ? "Копия ответа сохранена локально." : "Локальная копия не записалась — сохраните ответ из чата вручную."), {
        kind: "marker-mismatch", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }
    const { result, stray } = adoptIds(hit.result, expect);
    if (stray.length) {
      const retained = retainRejectedResult(expect, "dispatch-identity", replies);
      pause(`ID результата не прошли проверку (${stray.join(", ")}); ничего не подменяю. ` +
        (retained ? "Ожидание и копия ответа сохранены." : "Ожидание сохранено; сохраните ответ из чата вручную."), {
        kind: "marker-mismatch", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }
    if (GM_getValue(`cfn-done:${result.dispatch_id}:${result.run_id}`, false)) {
      const waiting = GM_getValue(K.expect, null);
      if (waiting && norm(waiting.ref) === norm(expect.ref) && norm(waiting.runId) === norm(expect.runId)) {
        GM_setValue(K.expect, null);
      }
      return false;
    }
    if (!currentDispatch(expect)) {
      pause("Ожидание выдачи изменилось: чужой ход не перезаписываю.", {
        kind: "dispatch-changed", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }

    // D-046: «pr:null» вместе с «merged:true» — противоречие в формате, а не
    // отказ среды. Проверить мерж без PR нечем, верить слову «слит» нельзя, но
    // и останавливать миссию из-за одной строки не за что: работа сделана.
    // Просим поправить маркер обычной лестницей напоминаний; карточку и журнал
    // не трогаем, ожидание остаётся живым. Аудитору и Reviewer PR не нужен по
    // роли — их маркер про мерж не спрашивает.
    if (role.fn !== "Auditor" && role.fn !== "Reviewer" && prMergeConflict(result)) {
      return markerMissing(role, expect, "CF_AGENT_RESULT", manual, "pr-claim");
    }

    const page = await notion("GET", `pages/${result.dispatch_id}`);
    const guard = dispatchGuard(page, expect, role);
    if (guard) {
      const onCard = rt(page.properties?.["Run ID"]);
      const waiting = GM_getValue(K.expect, null);
      if (taskState(page) !== "Running" && onCard && norm(onCard) === norm(expect.runId) &&
          waiting && norm(waiting.ref) === norm(expect.ref) && norm(waiting.runId) === norm(expect.runId)) {
        GM_setValue(K.expect, null);
        log("Эта выдача уже не Running — повторная запись не нужна, ожидание снято.");
        return false;
      }
      pause(`Ответ не записан: ${guard}. Новую выдачу не перезаписываю.`, {
        kind: "dispatch-changed", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }
    // Сверяем единственную активную миссию не по названию, а по ID выдачи и
    // карточки. Старые ожидания без missionId требуют ручного восстановления.
    const mission = await activeMission();
    if (!mission || norm(mission.id) !== norm(expect.missionId) || !cardInMission(page, mission)) {
      pause("Mission ID карточки не совпадает с единственной активной миссией или выдачей. " +
        "Ожидание и ответ сохранены; проверьте привязку и Run ID.", {
        kind: "dispatch-mission", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }
    let reviewMission = null;
    if (role.fn === "Reviewer") {
      if (review?.decision?.mission_id && norm(review.decision.mission_id) !== norm(mission.id)) {
        pause("Вердикт карточки Reviewer относится к другой миссии. Ожидание и ответ сохранены.", {
          kind: "dispatch-mission", ref: expect.ref, runId: expect.runId || "",
        });
        return true;
      }
      reviewMission = mission;
      if (/\bCF_REVIEW_RESULT\b/i.test(rt(page.properties?.["Acceptance"])) && !review?.decision) {
        return markerMissing(role, expect, "CF_REVIEW_RESULT", manual);
      }
    }
    // `"question":null` — это «вопроса нет», а не «вопрос без варианта».
    const asked = questionInMarker(result.question, "Работа идёт по решению исполнителя");
    if (asked.kind === "asked") {
      await askQuestion(asked.question, {
        roleName: role.name,
        card: taskTitle(page),
        mission: rt(page.properties["Миссия"]),
        key: `${result.dispatch_id}:${result.run_id}`,
      });
    } else if (asked.kind === "text") {
      // Вопрос написан, а варианта по умолчанию нет. Раньше он выбрасывался:
      // Мастер видел громкую ошибку и не видел вопроса. Записываем с честным
      // вариантом — работа и так идёт по решению исполнителя.
      log(
        `Вопрос исполнителя пришёл без варианта по умолчанию — записан с вариантом «${asked.question.fallback}»: ответ Мастера дойдёт следующим ходом.`,
        false,
        { ntfy: "quiet", title: "Relay: вопрос без варианта по умолчанию" },
      );
      await askQuestion(asked.question, {
        roleName: role.name,
        card: taskTitle(page),
        mission: rt(page.properties["Миссия"]),
        key: `${result.dispatch_id}:${result.run_id}`,
      });
    }
    // Журнал собирается из всего хода: ответ мог прийти частями — отчёт первым
    // сообщением, маркер отдельным после напоминания. Маркер без отчёта в журнал
    // не пишем вовсе: именно такая запись и обманула Координатора на NAR-1.8.
    const answer = runAnswer(expect, hit);
    if (answer.body < C.minAnswerChars) {
      log(`В ответе ${role.name} только маркер, отчёта нет — в журнал не пишу.`, true);
      return markerMissing(role, expect, "CF_AGENT_RESULT", manual, "thin");
    }
    const declaredLog = rt(page.properties["Output Drive File ID"]);
    if (!declaredLog) throw new Error("В карточке нет Output Drive File ID.");
    const marker = `<!-- CF_DISPATCH ${result.dispatch_id}:${result.run_id} -->`;
    const partsNote = answer.parts > 1 ? `_Ответ собран из ${answer.parts} сообщений хода._\n\n` : "";
    // Ссылку на журнал мог переписать агент: пишем в журнал выдачи, а не в то,
    // что окажется в поле (NAR-2.13, D-071).
    const { wrote, logId } = await appendToJournal(
      result.dispatch_id,
      result.run_id,
      declaredLog,
      marker,
      `\n\n${marker}\n## Ответ ${role.name}\n\n${partsNote}${answer.text}\n`,
    );
    if (wrote && wrote.duplicate) {
      log("Ответ уже был в журнале Drive (маркер этой же выдачи) — второй раз не пишу, оформляю карточку.");
    }

    // Аудитор и Reviewer не открывают PR: по карточке приёмки тоже нечего
    // мержить. Исполнитель может явно сказать то же самое через `pr: null`.
    const noPr = role.fn === "Auditor" || role.fn === "Reviewer" || prDeclined(result);
    const merged = noPr ? "none" : await ensureMerged(page, result);
    // После записи в Drive или долгой проверки PR карточку могли перевыдать.
    // Ещё раз читаем состояние, run, владельца и миссию перед любой её правкой.
    const current = await notion("GET", `pages/${result.dispatch_id}`);
    const changed = dispatchGuard(current, expect, role);
    const latestMission = await activeMission();
    const changedMission = !latestMission || norm(latestMission.id) !== norm(expect.missionId) ||
      !cardInMission(current, latestMission);
    if (changed || changedMission || !currentDispatch(expect)) {
      pause(`Ответ записан в журнал, но карточка, миссия или ожидание успели измениться (${changed || (changedMission ? "миссия" : "ожидание")}). ` +
        "Статус не перезаписываю; сверить выдачу нужно вручную.", {
        kind: "dispatch-changed", ref: expect.ref, runId: expect.runId || "",
      });
      return true;
    }
    // Что решила проверка — запоминаем до записи в Notion. Если она ошиблась,
    // «Подключения» → «Вернуть карточку» перепроверит GitHub и вернёт Submitted, не гоняя
    // исполнителя по второму кругу.
    const expectSnapshot = GM_getValue(K.expect, null);
    const prRefResult = result && result.pr ? prRef(result, expectSnapshot && expectSnapshot.targetRepo ? expectSnapshot.targetRepo : C.repo) : null;
    GM_setValue(K.lastResult, {
      at: Date.now(),
      dispatch_id: result.dispatch_id,
      run_id: result.run_id,
      pr: result.pr ?? null,
      merged: result.merged === true,
      task: taskTitle(page),
      logId,
      roleId: role.id,
      roleName: role.name,
      verdict: merged,
      why: (lastMergeCheck && lastMergeCheck.why) || "",
      // Снимок цели выдачи: репозиторий сессии роли, целевой репозиторий и
      // его базовая ветка. Восстановление и повторная проверка опираются на
      // него, а не на текущий глобальный конфиг профиля.
      sessionRepo: expectSnapshot && expectSnapshot.sessionRepo ? String(expectSnapshot.sessionRepo) : (C.repo || ""),
      targetRepo: expectSnapshot && expectSnapshot.targetRepo ? String(expectSnapshot.targetRepo) : (C.repo || ""),
      targetBranch: expectSnapshot && expectSnapshot.targetBranch ? String(expectSnapshot.targetBranch) : (C.branch || "main"),
      prRepo: prRefResult ? prRefResult.repo : null,
      prNumber: prRefResult ? prRefResult.number : null,
      result: {
        pr: result.pr ?? null,
        merged: result.merged === true,
        status: result.status ?? null,
        report: result.report ?? null,
      },
    });
    if (!noPr && lastMergeCheck && lastMergeCheck.needsToken) GM_setValue(K.ghAsk, Date.now());
    if (prDeclined(result) && role.fn !== "Auditor" && role.fn !== "Reviewer") {
      log(
        `PR не ждём: ${role.name} заявил работу без PR (pr: null) — принято по отчёту, ` +
          "кнопки Create/Merge не трогал.",
      );
    }

    if (merged === "boundary") {
      const why = (lastMergeCheck && lastMergeCheck.why) || "сверьте репозиторий";
      const targetRepo = expect.targetRepo || C.repo;
      const blocked = {
        "Dispatch State": { select: { name: "Blocked" } },
        "Check": { select: typeof result.check === "number" ? { name: result.check === 0 ? "pass" : "fail" } : null },
        "Ответ": { rich_text: richText(`Ответ сохранён в журнал ${logId}; GitHub PR не подтверждён: ${why}. Повторную выдачу не выполнять без решения Warden.`) },
      };
      const link = prUrl(result.pr, targetRepo);
      if (link) blocked.PR = { url: link };
      if (result.report) blocked["Report SHA"] = { rich_text: [{ type: "text", text: { content: String(result.report).slice(0, 200) } }] };
      await patch(result.dispatch_id, blocked);
      GM_setValue(`cfn-done:${result.dispatch_id}:${result.run_id}`, true);
      if (currentDispatch(expect)) GM_setValue(K.expect, null);
      pause(`PR этой выдачи не подтверждён: ${why}. Карточка → Blocked; ответ, Run ID и ссылка сохранены; не перевыдаю.`,
        { kind: "project-pr-boundary", ref: result.dispatch_id, runId: result.run_id });
      return true;
    }

    // Заявка о мерже не подтвердилась по GitHub: агент написал «слит», а PR
    // открыт, закрыт без мержа или его нет вовсе. Это не «PR закрыт» — это
    // работа, которой в main нет, поэтому карточка идёт в Rework с причиной.
    if (merged === "claim-rejected") {
      const why = (lastMergeCheck && lastMergeCheck.why) || "состояние PR не подтвердилось";
      const reason =
        `Исполнитель заявил, что PR слит, но GitHub говорит другое: ${why}. ` +
        `Работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала — нужна повторная выдача.`;
      try {
        await gateway("append", logId, {
          marker: `<!-- CF_DISPATCH ${result.dispatch_id}:${result.run_id}:claim-rejected -->`,
          entry: `\n\n<!-- CF_DISPATCH ${result.dispatch_id}:${result.run_id}:claim-rejected -->\n## Заявка о мерже не подтвердилась\n\n${reason}\n`,
        });
      } catch (e) {
        log(`Причина не записана в лог: ${e.message}`, true);
      }
      await patch(result.dispatch_id, {
        "Dispatch State": { select: { name: "Rework" } },
        "Ответ": { rich_text: richText(`${reason} Ответ ${hit.id} в логе ${logId}.`) },
      });
      GM_setValue(`cfn-done:${result.dispatch_id}:${result.run_id}`, true);
      log(`«${taskTitle(page)}» → Rework: заявка о мерже не подтвердилась (${why}).`, true, {
        tone: "warn",
        ntfy: "quiet",
        title: "Relay: карточка возвращена",
        ntfyText: executorNtfyText(page, role, expect, receivedAt, `мёрж не подтвердился, карточка в Rework (${why})`),
        ntfyKey: `dispatch-result:${result.dispatch_id}:${result.run_id}`,
      });
      const coord = (await roles()).find((r) => r.fn === "Coordinator");
      if (!coord) throw new Error("Нет активного Coordinator.");
      if (currentDispatch(expect)) GM_setValue(K.expect, null);
      await goTo(coord);
      return true;
    }

    // PR закрыт. Так выглядит и ручной мерж через GitHub, и отказ от работы:
    // различаем по маркеру. Без заявки о мерже работа в main не попала —
    // возвращаем карточку в Rework с причиной, решение остаётся за Координатором.
    if ((merged === "closed" || merged === "unconfirmed") && !hasMergedClaim(result)) {
      const targetBranch = expect && expect.targetBranch ? expect.targetBranch : (C.branch || "main");
      const reason =
        merged === "closed"
          ? `PR закрыт без мержа (Closed). Работа в ${targetBranch} не попала — нужна повторная выдача.`
          : `Исполнитель не заявил о мерже (нет merged: true) и PR не открыт. Работа в ${targetBranch} не попала — нужна повторная выдача.`;
      try {
        await gateway("append", logId, {
          marker: `<!-- CF_DISPATCH ${result.dispatch_id}:${result.run_id}:closed -->`,
          entry: `\n\n<!-- CF_DISPATCH ${result.dispatch_id}:${result.run_id}:closed -->\n## PR закрыт без мержа\n\n${reason}\n`,
        });
      } catch (e) {
        log(`Причина не записана в лог: ${e.message}`, true);
      }
      await patch(result.dispatch_id, {
        "Dispatch State": { select: { name: "Rework" } },
        "Ответ": { rich_text: richText(`${reason} Ответ ${hit.id} в логе ${logId}.`) },
      });
      GM_setValue(`cfn-done:${result.dispatch_id}:${result.run_id}`, true);
      log(`«${taskTitle(page)}» → Rework: PR закрыт без мержа.`, false, {
        ntfy: "quiet",
        title: "Relay: карточка возвращена",
        ntfyText: executorNtfyText(page, role, expect, receivedAt, "PR не слит, карточка в Rework"),
        ntfyKey: `dispatch-result:${result.dispatch_id}:${result.run_id}`,
      });
      const coord = (await roles()).find((r) => r.fn === "Coordinator");
      if (!coord) throw new Error("Нет активного Coordinator.");
      if (currentDispatch(expect)) GM_setValue(K.expect, null);
      await goTo(coord);
      return true;
    }

    if (merged === "timeout")
      throw new Error(`PR по «${taskTitle(page)}» не слит за отведённое время. Проверьте страницу Arena.`);

    const props = {
      "Dispatch State": { select: { name: "Submitted" } },
      "Ответ": { rich_text: richText(`${review?.verdict ? `Вердикт Reviewer по карточке: ${review.verdict}. ` : ""}Ответ ${hit.id} записан в лог ${logId}.`) },
      "Submitted At": { date: { start: nowIso() } },
    };
    props["Check"] = {
      select: typeof result.check === "number" ? { name: result.check === 0 ? "pass" : "fail" } : null,
    };
    if (result.report) props["Report SHA"] = { rich_text: [{ type: "text", text: { content: String(result.report).slice(0, 200) } }] };
    const targetRepo = expect && expect.targetRepo ? expect.targetRepo : C.repo;
    const link = prUrl(result.pr, targetRepo);
    if (link) props["PR"] = { url: link };
    // Время записи ответа глазами Notion: по нему потом видно, трогал ли
    // карточку кто-то ещё (Rework → Ready). Часы браузера и Notion разные,
    // поэтому запоминаем именно ответ сервера.
    rememberAnswerStamp(result.dispatch_id, await patch(result.dispatch_id, props));
    GM_setValue(`cfn-done:${result.dispatch_id}:${result.run_id}`, true);
    log(
      noPr
        ? `Ответ ${role.name} записан${review?.verdict ? ` (вердикт: ${review.verdict})` : ""}, PR не нужен, задача → Submitted.`
        : `Ответ ${role.name} записан, PR ${merged === "claimed" ? "слит (по маркеру)" : "слит"}, задача → Submitted.` +
            (link ? ` PR: ${link}` : " (номер PR не указан в маркере)"),
      false,
      {
        ntfy: "quiet",
        title: "Relay: ответ записан",
        ntfyText: executorNtfyText(page, role, expect, receivedAt, "ответ записан, карточка Submitted"),
        ntfyKey: `dispatch-result:${result.dispatch_id}:${result.run_id}`,
      },
    );

    if (!currentDispatch(expect)) {
      log("Карточка оформлена, но ожидание уже сменилось — новый ход не трогаю.", true, { ntfy: "quiet" });
      return true;
    }
    GM_setValue(K.expect, null);
    if (review?.verdict === "master") {
      pause(`Reviewer просит Мастера: ${firstLine(review.decision.reason || review.decision.remarks || "причина не указана")}. ` +
        "Ответ записан в журнал, карточка Submitted; миссия не закрыта.", {
        kind: "review-needs-master", ref: expect.ref, runId: expect.runId,
      });
      return true;
    }
    const co = (await roles()).find((r) => r.fn === "Coordinator");
    if (!co) throw new Error("Нет активного Coordinator.");
    await goTo(co);
    return true;
  }

  // ───────────────────────────── ход Координатора ─────────────────────────────
  /**
   * Возврат «зависших» карточек в Ready.
   *
   * Это не лимит на работу агента. 45 минут — срок, после которого карточка в
   * Running считается брошенной: задание до исполнителя не дошло, ответ
   * потерялся, вкладку закрыли. Пока у скрипта есть живой ход (неотправленное
   * задание или ожидание ответа), карточка не трогается никогда: агент может
   * работать и два, и три часа, и это нормально.
   */
  /**
   * Карточки в Running, по которым у транспорта нет хода.
   *
   * В Running карточку ставит только транспорт (`dispatchTask`) — тем самым он
   * берёт её в работу. Значит Running без живого ожидания означает, что работу
   * никто не ведёт: скрипт про неё забыл (сброс кнопкой ↺, обновление, чужой
   * браузер), а в очереди она выглядит как ход. Координатор видит «1 Running»,
   * считает, что работа идёт, и выдаёт вместо неё следующую карточку — а эта
   * висит до 45 минут и потом всё равно возвращается.
   *
   * 28.10 так и вышло: ↺ снял ожидание, NAR-5.3 осталась Running, и новый ход
   * ушёл Architect'у. Теперь такие карточки возвращаются в Ready сразу — до
   * того, как Координатор увидит очередь.
   *
   * Не трогаем три вещи:
   *  • карточку текущего хода — по ней скрипт правда ждёт ответа;
   *  • всё, пока идёт отправка (`K.pending`) или транспорт занят другим ходом
   *    (ответ приёмки, вопрос, план): тогда «без хода» — наша невнимательность,
   *    а не факт;
   *  • карточку, выданную только что (`orphanGraceMs`) — ход мог уйти из
   *    другой вкладки, и `K.expect` ещё не перечитан.
   *
   * Возвращает список возвращённых карточек (для журнала и проб).
   */
  async function sweepOrphans(mission, cards = null) {
    if (!mission || GM_getValue(K.pending, null)) return [];
    const expect = GM_getValue(K.expect, null);
    if (expect && Number(expect.sentAt) && expect.kind !== "dispatch") return [];
    const live = expect && expect.kind === "dispatch" && expect.ref ? norm(expect.ref) : "";
    const running = cards || (await tasks("Running", mission));
    const swept = [];
    for (const card of running) {
      if (live && norm(card.id) === live) continue;
      const started = card.properties?.["Started At"]?.date?.start;
      const age = started ? Date.now() - Date.parse(started) : Number.POSITIVE_INFINITY;
      if (age < C.orphanGraceMs) continue;
      // `rollbackProps` сам откажется, если карточка уже отвечена («Submitted
      // At», «PR») или её Run ID сменился: чужой ход не снимаем.
      const props = rollbackProps(card, rt(card.properties?.["Run ID"]));
      if (!props) continue;
      try {
        await patch(card.id, props);
      } catch (e) {
        log(`«${taskTitle(card)}» висит в Running без хода, но статус не снялся: ${e.message}.`, true);
        continue;
      }
      GM_setValue(answerStampKey(card.id), "");
      swept.push(card);
      const how = Number.isFinite(age) ? `${Math.round(age / 60000)} мин` : "неизвестно сколько";
      log(
        `«${taskTitle(card)}» висит в Running ${how} без хода скрипта — вернул в Ready: ` +
          "ожидания по ней нет, работа по ней не идёт.",
        false,
        { tone: "warn", ntfy: "quiet", title: "Relay: карточка возвращена в Ready" },
      );
    }
    return swept;
  }

  async function releaseStalled(mission) {
    // Идёт отправка — не наше дело, что там на часах.
    if (GM_getValue(K.pending, null)) return;
    const running = await tasks("Running", mission);
    // Сироты — до всех отсчётов: карточка без хода не работает ни секунды, и
    // ждать 45 минут ей незачем. Список передаём тот же, второй раз Notion не
    // читаем.
    const swept = new Set((await sweepOrphans(mission, running) || []).map((card) => norm(card.id)));
    const expect = GM_getValue(K.expect, null);
    for (const card of running) {
      // Карточку уже вернул `sweepOrphans`: второй раз её не читаем.
      if (swept.has(norm(card.id))) continue;
      // По этой карточке скрипт как раз ждёт ответа: ход живой.
      if (expect && Number(expect.sentAt) && norm(expect.ref) === norm(card.id)) continue;
      const started = card.properties["Started At"]?.date?.start;
      if (!started) continue;
      if (Date.now() - Date.parse(started) < C.stalledMs) continue;
      // Ready — это «хода на карточке нет»: снимаем и след выдачи, иначе
      // карточка выглядит выданной, хотя её уже никто не ведёт.
      await patch(card.id, {
        "Dispatch State": { select: { name: "Ready" } },
        "Started At": { date: null },
        "Run ID": { rich_text: [] },
      });
      log(
        `«${taskTitle(card)}» висит в Running ${Math.round((Date.now() - Date.parse(started)) / 60000)} мин без хода скрипта — возвращена в Ready.`,
        false,
        { ntfy: "quiet" },
      );
    }
  }

  /**
   * Что делать по решению Координатора — без сети, чтобы это можно было
   * проверить пробой.
   *
   * `next` — имя роли из маркера. Четыре исхода:
   *   • роль есть и её карточка лежит в Ready → отправляем задание;
   *   • `next` — сам Координатор: он вернул ход себе (например, принял
   *     Submitted и не успел выдать следующую карточку). Это не ошибка и не
   *     повод для паузы — просим ещё один ход с подсказкой, что очередь пуста;
   *   • роли нет или карточки нет → тоже просим ход, но говорим, чего не
   *     хватает: имени роли или самой карточки;
   *   • второй промах подряд → пауза: дальше это уже не «не понял», а поломка.
   */
  function decisionRoute(next, { roles: list = [], directory = [], readyRoles = [], misses = 0 } = {}) {
    const name = String(next || "").trim();
    if (!name) return { kind: "ask", note: "В маркере не указано, кому передаётся ход: назови роль или done." };
    if (norm(name) === norm("done")) return { kind: "done" };
    const target = list.find((r) => norm(r.name) === norm(name)) || null;
    const rows = [...list, ...(directory || [])];
    const reviewer = rows.some((r) => r.fn === "Reviewer" &&
      (norm(r.name) === norm(name) || (target?.id && r.id && norm(r.id) === norm(target.id))));
    if (reviewer || norm(name) === norm("Warden")) {
      const why = `«${name}» — приёмка (Reviewer): обычную рабочую карточку ей не выдают. ` +
        "Переназначь её подходящему Auditor или Executor; вопросы и предложения по-прежнему направляются приёмке, " +
        "а завершённая очередь передаётся ей через next: done.";
      // D-042: отказ должен быть исполнимым. Координатор упорно называл Warden,
      // потому что не понимал, КАК исправить: карточка стояла в Ready с «Кому» =
      // Warden. Называем поле, доступные рабочие роли и что ратификация/правка
      // файлов — работа исполнителя, а приёмщик лишь отвечает на вопросы.
      const workers = list.filter((r) => ["Executor", "Auditor"].includes(r.fn)).map((r) => r.name);
      const how = ` Исправь адресацию: в карточке смени поле «Кому» с «${name}» на рабочую роль` +
        (workers.length ? ` (${workers.join(", ")})` : " (Executor или Auditor)") +
        `, оставь карточку в Ready и повтори next с этой ролью. Не ставь «Кому» = «${name}» снова: ` +
        "ратификация решений, статус ADR и любая правка файлов — работа исполнителя по карточке; приёмщик только отвечает на вопросы и принимает миссию.";
      if (misses >= 2) return { kind: "pause", reason: `${why}${how} Координатор повторил запретную выдачу три раза; очередь сохранена.` };
      return { kind: "ask", note: `${why}${how}` };
    }
    if (!target) {
      // Карточка этой роли может уже лежать в Ready — тогда дело не в
      // опечатке, а в статусе роли. Молчать об этом значит гонять
      // Координатора по кругу «роли нет среди активных».
      if (readyRoles.some((r) => norm(r) === norm(name))) {
        const row = (directory || []).find((r) => norm(r.name) === norm(name));
        const state = row
          ? [`Статус «${row.status || "пуст"}»`, row.url ? "Agent URL заполнен" : "Agent URL пуст"].join(", ")
          : directory.length
            ? "такой роли нет в базе «Роли»"
            : "роль не активна";
        const why =
          `«${name}»: карточка в Ready есть, но выдать её некому — ${state}. ` +
          `Активные роли: ${list.map((r) => r.name).join(", ") || "нет"}. ` +
          "Статус роли и Agent URL ставит Мастер: агента в Arena создаёт он.";
        if (misses >= 1) {
          return {
            kind: "pause",
            reason: `${why} Нажмите «Продолжить» — Координатор получит подсказку и назначит активную роль.`,
          };
        }
        return {
          kind: "ask",
          note:
            `${why} Назначь в «Кому» активную роль (правка черновика — твоё право) и повтори next, ` +
            "либо оставь карточку в Draft и напиши, кого она ждёт.",
        };
      }
      // Третий подряд промах — уже не «модель не поняла», а поломка: без
      // человека это превращается в бесконечную переписку с Координатором.
      if (misses >= 2) {
        return {
          kind: "pause",
          reason:
            `Координатор третий раз подряд называет роль «${name}», которой нет среди активных. ` +
            "Проверьте базу «Роли»: имя в next должно совпадать с ролью.",
        };
      }
      return { kind: "ask", note: `Роли «${name}» нет среди активных. Назови роль из базы «Роли» или done.` };
    }
    if (target.fn === "Coordinator") {
      if (misses >= 2) {
        return {
          kind: "pause",
          reason:
            "Координатор третий раз подряд возвращает ход себе и не выдаёт карточку. " +
            "Похоже, он не видит очередь или не может создать карточку — посмотрите его ответ.",
        };
      }
      return {
        kind: "ask",
        note:
          "Ход вернулся Координатору. Очередь пуста — в этом ходе выдай работу сам: создай карточку " +
          "Ready или переведи в Ready подходящий Draft и назови в next исполнителя (или done, если миссия закончена).",
      };
    }
    if (!["Executor", "Auditor"].includes(target.fn)) {
      const why = `«${target.name}»: функция «${target.fn || "не указана"}» не разрешает рабочую карточку. ` +
        "Назначь активного Executor или Auditor; функцию роли устанавливает Мастер.";
      if (misses >= 2) return { kind: "pause", reason: `${why} Координатор повторил выбор три раза.` };
      return { kind: "ask", note: why };
    }
    if (readyRoles.some((r) => norm(r) === norm(target.name))) return { kind: "dispatch", roleName: target.name };
    if (misses >= 1) {
      return {
        kind: "pause",
        reason:
          `Координатор второй раз направил ход в «${target.name}», но карточки в Ready нет. ` +
          "Нажмите «Продолжить»: он получит подсказку и сможет создать карточку или выдать черновик. " +
          "Если и это не поможет — проверьте, видит ли Координатор базу «Запросы».",
      };
    }
    return {
      kind: "ask",
      note:
        `Ты направил ход в «${target.name}», но в Ready нет карточки для этой роли. ` +
        "Создай её или переведи в Ready подходящий Draft — и в этом же ответе повтори next.",
    };
  }

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
  function questionFallback(value) {
    const text = String(optionLabel(value) || "").replace(/\s+/g, " ").trim();
    if (text.length > C.questionDefaultMax) {
      const error = new Error(`Вариант по умолчанию длиннее ${C.questionDefaultMax} знаков: он не может быть применён без полного текста. Разберите ход вручную.`);
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
  function parseQuestion(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const text = questionTitle(raw.text, C.questionTextMax);
    const fallback = questionFallback(raw.default);
    if (!text || !fallback) return null;
    const allOptions = questionOptions(raw.options);
    const fullText = questionWithOptions(raw.text, allOptions);
    const options = allOptions.slice(0, 4);
    const hours = Number(raw.hours);
    return {
      text,
      fullText,
      fallback,
      options,
      url: questionMaterial(raw.url, raw.text),
      blocks: oneLine(raw.blocks, 200),
      hours: Number.isFinite(hours) && hours >= 1 ? Math.min(hours, 168) : C.questionHours,
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
    const hours = Number(obj.hours);
    return {
      kind: "text",
      question: {
        text,
        fullText: questionWithOptions(rawText, allOptions),
        options,
        url: questionMaterial(obj.url, rawText),
        blocks: oneLine(obj.blocks, 200),
        hours: Number.isFinite(hours) && hours >= 1 ? Math.min(hours, 168) : C.questionHours,
        fallback: questionFallback(fallback) || "Работа идёт по решению агента",
      },
    };
  }

  /** Срок: когда молчание Мастера превращается в вариант по умолчанию. */
  const questionDeadline = (hours, now = Date.now()) => new Date(now + hours * 3_600_000).toISOString();

  /** Открытые вопросы, у которых срок уже вышел. */
  function expiredQuestions(rows, now = Date.now()) {
    return (rows || []).filter((row) => {
      if (sel(row.properties?.["Статус"]) !== Q.wait) return false;
      const due = row.properties?.["Срок"]?.date?.start || "";
      return Boolean(due) && Date.parse(due) < now;
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
    return (
      `Обратная связь без ответа (вопросы и предложения): ${shown.join("; ")}${more}. ` +
      "Ответ придёт на следующем ходе — не задавай их снова и не останавливайся."
    );
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
    return `Ответы на обратную связь от Мастера и приёмки — учти их в этом ходе: ${shown.join("; ")}${more}.`;
  }

  /** Свойства строки базы «Вопросы». */
  function questionProps(q, ctx = {}) {
    const text = (value) => ({ rich_text: richText(value) });
    const props = {
      "Вопрос": { title: [{ type: "text", text: { content: q.text } }] },
      "Статус": { select: { name: Q.wait } },
      "По умолчанию": text(q.fallback),
      "Срок": { date: { start: questionDeadline(q.hours) } },
      "Роль": text(ctx.roleName || ""),
      "Карточка": text(ctx.card || "—"),
      "Миссия": text(ctx.mission || ""),
    };
    if (q.blocks) props["Что блокирует"] = text(q.blocks);
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
            const handled = handWaitingRow(same.row, complete, item.ctx || {});
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
          queueAnswer(row, item.q, item.ctx || {});
          log(`Отложенный вопрос записался: «${item.q.text}» — отвечает приёмка.`, false, {
            ntfy: "quiet",
            title: "Relay: вопрос приёмке",
          });
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
    return { text, fullText: full, fallback, options, url, hours: 168 };
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
    if (sel(row.properties?.["Статус"]) !== Q.wait) return false;
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
        if (askedBefore && !q.autoAdr) return null;
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
        // Вопрос сразу ставится в очередь приёмки: она отвечает вместо Мастера
        // (1.4.80). Громкого пуша нет — вопрос больше не требует человека.
        queueAnswer(row, q, ctx);
        forgetQuestionIntent(q, ctx);
        log(`Вопрос записан: «${q.text}». По умолчанию: ${q.fallback} — отвечает приёмка.`, false, {
          ntfy: "quiet",
          title: "Relay: вопрос приёмке",
        });
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

  /** Отметить ответы доставленными — только после того, как промпт ушёл. */
  async function markDelivered(rows, now = Date.now()) {
    for (const row of rows || []) {
      try {
        await patch(row.id, { "Доставлено": { date: { start: new Date(now).toISOString() } } });
      } catch (e) {
        log(`Отметка о доставке ответа не записалась: ${e.message}`, true);
      }
    }
  }

  /** Срок вышел — закрываем обычный вопрос вариантом по умолчанию, но не молча. */
  async function closeExpired(rows, closedIds = null) {
    let closed = 0;
    for (const row of rows || []) {
      const title = rt(row.properties["Вопрос"]);
      if ((typeof questionBodyPending === "function" && questionBodyPending(row.id)) ||
          (typeof questionQueuedForRow === "function" && questionQueuedForRow(row))) continue;
      // ADR никогда не закрывается по сроку, даже если ссылка только в URL.
      if (!rt(row.properties["По умолчанию"]) ||
          /\bADR\b|docs\/decisions\//i.test(`${title} ${row.properties?.["Материал"]?.url || ""}`)) continue;
      try {
        const result = await withQuestionWriteLock(async () => {
          // Снимок списка может устареть: Мастер уже ответил или срок изменён.
          // Перечитываем прямо перед PATCH и не перезаписываем чужое решение.
          const latest = await notion("GET", `pages/${row.id}`);
          const state = sel(latest?.properties?.["Статус"]);
          if (!state) throw new Error("статус строки не прочитан");
          if (state !== Q.wait) {
            recordQuestionChange(row.id, null);
            if (closedIds) closedIds.add(row.id);
            return null;
          }
          const props = latest.properties;
          const freshTitle = rt(props["Вопрос"]);
          const fallback = rt(props["По умолчанию"]);
          const due = props["Срок"]?.date?.start || "";
          if (rt(props["Ответ"]).trim() || !fallback || !due || !(Date.parse(due) < Date.now()) ||
              (typeof questionBodyPending === "function" && questionBodyPending(row.id)) ||
              (typeof questionQueuedForRow === "function" && questionQueuedForRow(latest)) ||
              /\bADR\b|docs\/decisions\//i.test(`${freshTitle} ${props["Материал"]?.url || ""}`)) return null;
          await patch(row.id, {
            "Статус": { select: { name: Q.byDefault } },
            "Ответ": { rich_text: richText(fallback) },
          });
          recordQuestionChange(row.id, null);
          if (closedIds) closedIds.add(row.id);
          return { freshTitle, fallback };
        });
        if (!result) continue;
        closed += 1;
        log(
          `Вопрос «${result.freshTitle}» ждал дольше срока — принят вариант по умолчанию: ${result.fallback}.`,
          false,
          { ntfy: "quiet", title: "Relay: вопрос закрыт по умолчанию" },
        );
      } catch (e) {
        log(`Вопрос «${title}» не закрылся по сроку: ${e.message}`, true);
      }
    }
    return closed;
  }

  /** Строки базы «Вопросы» с нужным статусом, в пределах миссии. */
  async function questionRows(statuses, mission) {
    const rows = await query(C.questions, {
      or: statuses.map((name) => ({ property: "Статус", select: { equals: name } })),
    });
    const wanted = mission ? rt(mission.properties["Миссия"]).trim() : "";
    if (!wanted) return rows;
    return rows.filter((row) => {
      const value = rt(row.properties["Миссия"]).trim();
      return !value || missionSame(value, wanted);
    });
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
      return { fresh, openLine: openQuestionsLine(open), answersLine: answersLine(fresh) };
    } catch (e) {
      log(`База «Обратная связь» не читается: ${e.message}`, true);
      return { fresh: [], openLine: "", answersLine: "" };
    }
  }

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
      hours: 168,
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
    const seen = new Map();
    for (const item of known || []) {
      if (typeof item === "string") seen.set(norm(item), { status: "Активна", url: "есть" });
      else if (item && item.name) seen.set(norm(item.name), { status: item.status || "", url: item.url || "" });
    }
    const why = (role) => {
      const row = seen.get(norm(role));
      if (!row) return `${role} — нет в «Ролях»`;
      if (row.status !== "Активна") return `${role} — Статус «${row.status || "пуст"}»`;
      if (!row.url) return `${role} — нет Agent URL`;
      return role;
    };
    const who = (card) => {
      const role = taskRole(card);
      if (!role) return "роль не задана";
      return seen.size ? why(role) : role;
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

  function readyLine(cards) {
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
      return `${taskTitle(card)} (${taskRole(card) || "роль не задана"}, Sequence ${seq ?? "—"})${warn ? ` — ${warn}.` : ""}`;
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

  function reworkLine(cards) {
    const rows = [...(cards || [])].sort((a, b) => {
      const sa = Number(a.properties?.["Sequence"]?.number ?? 0);
      const sb = Number(b.properties?.["Sequence"]?.number ?? 0);
      return sa - sb;
    });
    if (!rows.length) return "";
    const shown = rows.slice(0, C.readyLineMax).map(
      (card) => `${taskTitle(card)} (${taskRole(card) || "роль не задана"}) — причина: ${reworkCause(card)}`,
    );
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
      // Вопрос не останавливает цикл: он живёт строкой в базе «Вопросы», а
      // работа идёт по варианту, который агент назвал сам.
      let askedRow = null;
      if (norm(decision.next) !== "blocked") {
        // Та же история, что у исполнителя: `"question":null` — не вопрос, а
        // вопрос без варианта по умолчанию записывается с честным вариантом
        // «работа идёт по решению Координатора» — по next он и так идёт.
        const asked = questionInMarker(decision.question, "Работа идёт по решению Координатора");
        if (asked.kind === "text") {
          log(
            `Вопрос Координатора пришёл без варианта по умолчанию — записан с вариантом «${asked.question.fallback}»: дальше идём по next.`,
            false,
            { ntfy: "quiet", title: "Relay: вопрос без варианта по умолчанию" },
          );
        }
        if (asked.kind !== "none") {
          askedRow = await askQuestion(asked.question, {
            roleName: role.name,
            card: "",
            mission: rt(mission.properties["Миссия"]),
            key: `${mission.id}:${decision.turn_id || expect.turnId}`,
          });
        }
      }
      // Вопрос не «висит» до конца хода: ход сразу переходит приёмке, а next из
      // этого маркера не применяется — он посчитан без ответа. Ответ придёт
      // Координатору следующим планом, строкой «Ответы на вопросы».
      if (askedRow) {
        const item = answerQueue().find((row) => row.id === askedRow.id);
        if (item && (await startAnswer(mission, item))) return true;
      }
      if (norm(decision.next) === "blocked") {
        // Право Координатора остановить цикл. Повод ровно один: нужной роли
        // нет, и заменить её некем — агента в Arena создаёт Мастер. Всё
        // остальное (пустая очередь, спорный Scope, неясное ТЗ) Координатор
        // решает сам, иначе «остановлю, когда мне неудобно» съедает цикл.
        //
        // 25.10 в 19:43 он вернул next:"blocked" без need, и пауза сказала
        // «нужна роль, которой нет в «Ролях»» — при том что Tools в базе была,
        // просто «Ждёт». Поэтому текст собирается по фактам (blockedReason), а
        // не по шаблону: Мастер должен видеть, что дозаполнить, а что создать.
        const need = String(decision.need || "").trim();
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
        let askRow = null;
        if (askText) {
          const ask = typeof rawAsk === "object" && rawAsk ? rawAsk : {};
          const asked = parseQuestion({
            ...ask,
            text: typeof rawAsk === "object" && rawAsk ? rawAsk.text : rawAsk,
            default: questionFallback(ask.default) || "Ответ Мастера: цикл уже остановлен и ждёт его",
            hours: Number(ask.hours) || 168,
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
        const open = fresh.submitted.length + fresh.running.length + fresh.ready.length + fresh.rework.length + (fresh.blocked || []).length;
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
      queue: { summary, ready: readyLine(queue.ready), rework: reworkLine(queue.rework), draft: drafts, answerLine, openLine: briefing.openLine, answersLine: briefing.answersLine },
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
        readyLine(queue.ready),
        reworkLine(queue.rework),
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

  // ───────────────────────────── приёмка миссии ─────────────────────────────
  /**
   * Конец миссии решает приёмка, а не Координатор.
   *
   * До 1.4.79 цикл останавливался по `next: "done"`: Координатор объявлял
   * миссию выполненной, скрипт ставил «Завершена» и гасил автоцикл. Проверка
   * была формальной — «в очереди ноль карточек», — и отвечала на вопрос «всё ли
   * выдано», а не «получилось ли то, о чём миссия». Настоящую ошибку видел
   * только человек, и только если открывал «Итог».
   *
   * Теперь `done` — это передача на приёмку. Роль с функцией `Reviewer`
   * получает промпт с оракулом, очередью и «Итогом» и отвечает маркером
   * `CF_REVIEW_RESULT`:
   *   accept → миссия «Завершена», автоцикл выключен, громкий пуш;
   *   rework → «Возвращена», круг +1, замечания в карточку миссии, ход
   *            Координатору — он разбирает их карточками.
   *
   * Доработок больше `reworkLimit` не бывает: следующий возврат не запускает
   * работу, а останавливает цикл и зовёт Мастера. Приёмка, которая возвращает
   * бесконечно, — не контроль, а вечный цикл.
   */
  const reviewerRole = async () => (await roles()).find((r) => r.fn === "Reviewer") || null;

  const missionRound = (mission) => {
    const n = mission?.properties?.["Круг"]?.number;
    return Number.isFinite(Number(n)) ? Number(n) : 0;
  };

  /** Принятые карточки списком: что именно принято, с ответом и PR. */
  function reviewCards(cards) {
    const rows = Array.isArray(cards) ? cards : [];
    if (!rows.length) return "Принятых карточек нет — миссия закрывается без работы?";
    return rows
      .map((card) => {
        const id = taskTitle(card).split("·")[0].trim() || taskTitle(card);
        const who = taskRole(card) || "—";
        const pr = card.properties?.["PR"]?.url || "";
        const check = card.properties?.["Check"]?.select?.name || "";
        const answer = rt(card.properties["Ответ"]).replace(/\s+/g, " ").slice(0, 160);
        return `- ${id} · ${who}${pr ? ` · ${pr}` : ""}${answer ? ` · ответ: ${answer}` : ""}` +
          `${check ? ` · Check=${check}` : ""}${card.url ? ` · ${card.url}` : card.id ? ` · id: ${card.id}` : ""}`;
      })
      .join("\n");
  }

  function reviewPrompt(mission, role, turnId, round, queue, accepted) {
    return compileOrPause({
      kind: "review",
      role: promptRole(role),
      mission: {
        id: mission.id, name: rt(mission.properties["Миссия"]) || "миссия",
        tzUrl: mission.properties["ТЗ URL"]?.url || "", round,
        reworkLimit: C.reworkLimit, result: rt(mission.properties["Итог"]).trim(),
      },
      turnId,
      queue: { summary: queue.summary, accepted: reviewCards(accepted), acceptedCount: accepted.length },
      delivery: { tier: "full", attempt: 1 },
    }, `review ${mission.id}`);
  }

  /** Передать миссию на приёмку. Возвращает true: ход уже не у Координатора. */
  async function startReview(mission, queue) {
    const reviewer = await reviewerRole().catch(() => null);
    if (!reviewer) {
      // Приёмки нет — закрывать «за компанию» нельзя: миссия без вердикта
      // ничем не отличается от миссии, которую никто не проверял. Цикл стоит,
      // Мастер заводит роль (или закрывает миссию сам, зная, что принял её).
      pause(
        "Миссия готова к приёмке, но в базе «Роли» нет активной роли с функцией Reviewer: " +
          "принимать некому. Заведите роль (например, Warden с Agent URL) или закройте миссию сами — " +
          "без вердикта она не закроется.",
        { kind: "no-reviewer", ref: mission.id, notifyTitle: "Relay: приёмка не настроена" },
      );
      return true;
    }
    const round = missionRound(mission);
    let accepted;
    try {
      accepted = await tasks("Accepted", mission);
    } catch (e) {
      pause(`Не удалось полностью прочитать принятые карточки (${e.message}): приёмку не передаю с неполной очередью. Повторите после восстановления Notion.`,
        { kind: "review-cards-read", ref: mission.id });
      return true;
    }
    const turnId = uid();
    log(`Миссия готова к приёмке: круг ${round}, принято карточек ${accepted.length}. Передаю «${reviewer.name}».`);
    await sendToRole(reviewer, reviewPrompt(mission, reviewer, turnId, round, queue, accepted), "review", mission.id, {
      missionId: mission.id,
      turnId,
      round,
      title: "приёмка миссии",
    });
    return true;
  }

  /** Закрыть миссию. Право на это есть только у приёмки и у Мастера. */
  async function closeMission(mission, reviewer) {
    const at = nowIso();
    const returnedAt = mission.properties?.["Возвращена"]?.date?.start || "";
    await patch(mission.id, {
      "Состояние": { select: { name: "Завершена" } },
      "Завершена": { date: { start: at } },
    });
    // Событие объявляем сами и один раз: иначе `missionDoneNotice` следующим
    // тиком повторит тот же пуш про ту же дату.
    GM_setValue(`cfn-mission-done:${mission.id}:${at}:${returnedAt}`, true);
    // Отметка «закрыто приёмкой»: по ней `missionDoneNotice` отличает наше
    // закрытие от того, что агент поставил «Завершена» своей рукой.
    GM_setValue(`cfn-review:${mission.id}`, "accept");
    autoSet(false);
    const name = rt(mission.properties["Миссия"]) || "миссия";
    log(
      `Миссия «${name}» принята «${reviewer.name}»: закрыта, автоцикл остановлен. ` +
        "Следующая работа — новым ТЗ и новой миссией, а не хвостом этой.",
      false,
      { tone: "ok", ntfy: "loud", cycleStopped: true, title: "Relay: миссия принята" },
    );
    return true;
  }

  /** Вернуть миссию Координатору с замечаниями — или остановиться на пределе. */
  async function returnMission(mission, verdict, reviewer) {
    const round = missionRound(mission);
    const next = round + 1;
    const remarks = String(verdict.remarks || "").trim();
    if (!remarks) {
      pause(
        `«${reviewer.name}» вернул миссию без замечаний: исправлять нечего. Приёмка без причины — не приёмка: ` +
          "допишите замечания в карточку миссии и снимите паузу.",
        { kind: "review-empty", ref: mission.id },
      );
      return true;
    }
    if (next > C.reworkLimit) {
      // Предел доработок — не «ещё круг», а вызов Мастера: если три раза не
      // сошлось, четвёртый не сойдётся тоже. Расходится постановка, а не работа.
      pause(
        `Миссия прошла ${round} кругов доработки, и приёмка снова не приняла работу. Дальше решаете вы: ` +
          "сократить объём миссии, разделить её на две или принять как есть. Последние замечания:\n" +
          remarks,
        { kind: "rework-limit", ref: mission.id, notifyTitle: "Relay: миссия застряла в доработке" },
      );
      return true;
    }
    await patch(mission.id, {
      "Состояние": { select: { name: "Возвращена" } },
      "Возвращена": { date: { start: nowIso() } },
      "Круг": { number: next },
      "Замечания": { rich_text: richText(remarks) },
    });
    GM_setValue("cfn-plan-at", 0);
    GM_setValue(`cfn-review:${mission.id}`, "rework");
    log(
      `«${reviewer.name}» не принял миссию (круг ${next} из ${C.reworkLimit}): ${firstLine(remarks)}. ` +
        "Замечания в карточке миссии, ход — Координатору.",
      false,
      { tone: "warn", ntfy: "quiet", title: "Relay: миссия возвращена" },
    );
    const fresh = await notion("GET", `pages/${mission.id}`).catch(() => mission);
    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Миссия возвращена с приёмки, но активного Coordinator нет: ход возвращать некому.", {
        kind: "review-nocoord",
        ref: mission.id,
      });
      return true;
    }
    await requestPlan(fresh, coord, await queueOf(fresh), "Миссия возвращена с приёмки: разбери замечания карточками.", {
      force: true,
    });
    return true;
  }

  /** Ход отдельной приёмки миссии; вердикт по карточке сюда не относится. */
  async function reviewStep(role, expect, manual = false) {
    if (!expect || expect.kind !== "review") {
      pause("Это не отдельный ход приёмки миссии: вердикт не применяю.", {
        kind: "handoff-kind", ref: expect?.ref || "",
      });
      return true;
    }
    const currentReview = () => {
      const live = GM_getValue(K.expect, null);
      return Boolean(live && live.kind === "review" && norm(live.ref) === norm(expect.ref) &&
        norm(live.turnId) === norm(expect.turnId));
    };
    if (!currentReview()) {
      pause("Ожидание приёмки изменилось: чужой ход не перезаписываю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const mission = await activeMission();
    if (!mission) {
      pause("Приёмка ждёт ответа, а активной миссии нет: закрывать нечего.", {
        kind: "review-no-mission", ref: expect.ref || "",
      });
      return true;
    }
    if (norm(expect.ref) !== norm(mission.id) || (expect.missionId && norm(expect.missionId) !== norm(mission.id))) {
      pause("Ожидание приёмки относится к другой миссии: ничего не меняю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const replies = messagesAfter(expect.watermark);
    const decision = replies.map((m) => parseMarker(m.raw, "CF_REVIEW_RESULT"))
      .filter(Boolean)
      .at(-1);
    if (!decision) return markerMissing(role, expect, "CF_REVIEW_RESULT", manual);
    if (!isUuid(mission.id) || !isUuid(expect.turnId) || !isUuid(decision.mission_id) || !isUuid(decision.turn_id) ||
        norm(decision.mission_id) !== norm(mission.id) || norm(decision.turn_id) !== norm(expect.turnId) ||
        decision.dispatch_id || decision.run_id) {
      const retained = retainRejectedResult(expect, "mission-review-identity", replies);
      pause("Маркер не относится к этому ходу приёмки миссии (mission_id / turn_id / карточка): ничего не меняю. " +
        (retained ? "Копия ответа сохранена локально." : "Локальная копия не записалась — сохраните ответ из чата вручную."), {
        kind: "marker-mismatch", ref: mission.id, turnId: expect.turnId || "",
      });
      return true;
    }
    const verdict = String(decision.verdict || "").trim().toLowerCase();
    if (verdict === "accept") {
      // Очередь могла измениться, пока Reviewer проверял миссию. Старый
      // вердикт не распространяется на новые или незакрытые карточки.
      //
      // Привязки читаются здесь, а не общим стражем на каждом шаге: вердикт уже
      // получен и относится к прошлому состоянию очереди, поэтому пауза нужна
      // не «по факту непривязанной карточки», а только когда без привязки
      // нельзя решить, закрыта ли миссия.
      const fresh = await queueOf(mission);
      const unbound = [...(fresh.unbound || []), ...(await missionBindingBlockers(mission).catch(() => []))];
      if (unbound.length) {
        const list = [...new Map(unbound.map((row) => [row.id, row])).values()]
          .slice(0, 8).map((row) => `${taskTitle(row) || "без названия"} (${row.id})`).join("; ");
        pause(
          `Приёмка не приняла решение по привязке: в карточках этой миссии нет Mission ID — ${list}. ` +
            "Пока непонятно, входят ли они в миссию, закрывать её нельзя: привяжите карточки " +
            "«Управление проектами → Проверить Mission ID карточек» и нажмите «Продолжить». " +
            "Ни одну карточку не скрываю и не меняю; ответ Reviewer не потерян.",
          { kind: "review-unbound", ref: mission.id },
        );
        return true;
      }
      const open = fresh.submitted.length + fresh.running.length + fresh.ready.length + fresh.rework.length + (fresh.blocked || []).length;
      if (open) {
        if (currentReview()) GM_setValue(K.expect, null); // старое принятие нельзя повторить после обработки новой работы
        pause(`Пока шла приёмка, очередь изменилась: ${fresh.summary}. Миссия не закрыта; ` +
          "разберите карточки и запустите приёмку заново.", {
          kind: "review-with-open", ref: mission.id,
        });
        return true;
      }
      const stillActive = await activeMission();
      if (!stillActive || norm(stillActive.id) !== norm(mission.id) || !currentReview()) {
        pause("Пока шла приёмка, активная миссия или ожидание изменились: ничего не закрываю.", {
          kind: "marker-mismatch", ref: mission.id,
        });
        return true;
      }
      if (decision.summary) log(`Приёмка: ${oneLine(decision.summary, 300)}`);
      const closed = await closeMission(stillActive, role);
      if (currentReview()) GM_setValue(K.expect, null); // только после подтверждённой записи миссии
      return closed;
    }
    if (verdict === "rework") {
      if (!currentReview()) {
        pause("Ожидание приёмки изменилось: возврат не применяю.", { kind: "marker-mismatch", ref: mission.id });
        return true;
      }
      GM_setValue(K.expect, null);
      try {
        return await returnMission(mission, decision, role);
      } catch (e) {
        if (!GM_getValue(K.expect, null)) GM_setValue(K.expect, expect);
        throw e;
      }
    }
    if (verdict === "master") {
      pause(`Приёмка просит Мастера: ${firstLine(decision.reason || decision.remarks || "причина не указана")}. Миссия не закрыта.`, {
        kind: "review-needs-master", ref: mission.id,
      });
      return true;
    }
    pause(
      `В маркере приёмки нет verdict accept, rework или master (пришло «${verdict || "пусто"}»): миссию не трогаю. ` +
        "Поправьте маркер в ответе приёмки и нажмите «Продолжить».",
      { kind: "review-marker", ref: mission.id },
    );
    return true;
  }

  // ───────────────────────── арбитраж повторяющейся петли ─────────────────────────
  /**
   * D-053: карточку перевыдали N раз за окно — это ещё не повод будить Мастера.
   *
   * Раньше третья перевыдача одной карточки сразу ставила паузу: цикл замирал,
   * звонил телефон, и человек шёл разбираться, почему Координатор и исполнитель
   * гоняют одну работу. 07.11 на SYN-2 · S-4 так вышло трижды: исполнитель
   * честно отдал draft-PR с описанием блокера по Scope, транспорт увидел «нет
   * заявки о мерже» и вернул карточку в Rework — правила сработали, а разбирать
   * петлю было некому, кроме Мастера.
   *
   * Теперь цикл останавливается не сразу: та же карточка уходит арбитру —
   * роли с функцией Reviewer (в проекте это Warden). Арбитр видит факты (поле
   * «Ответ», состояние карточки, PR по GitHub, журнал попыток, очередь) и
   * выносит решение по карточке. Остановить цикл он тоже может — но это его
   * решение (`verdict:master`), а не первая реакция транспорта.
   *
   * Инварианты сохранены:
   *   • пауза снимается только человеком — арбитраж ничего не «продолжает» сам;
   *   • маркер арбитра несёт dispatch_id этой карточки и turn_id этого разбора;
   *   • нет активного Warden — прежняя пауза Мастера, без выдуманных решений;
   *   • Мастер остаётся последней инстанцией: и через арбитра, и через границу
   *     числа арбитражей (`arbiterLimit`);
   *   • арбитр ничего не правит руками: его выход — решение или остановка.
   */

  /** Сколько раз эту карточку отдавали арбитру в окне (ключ — сама карточка). */
  const arbiterKey = (id) => `cfn-arbiter:${id}`;
  const ARBITER_WINDOW = 3600 * 1000 * Number(C.arbiterWindowHours || 6);

  function noteArbitration(id) {
    const now = Date.now();
    const kept = (GM_getValue(arbiterKey(id), []) || []).map(Number).filter((at) => now - at < ARBITER_WINDOW);
    kept.push(now);
    GM_setValue(arbiterKey(id), kept);
    return kept.length;
  }

  function arbitrationCount(id) {
    const now = Date.now();
    return (GM_getValue(arbiterKey(id), []) || []).map(Number).filter((at) => now - at < ARBITER_WINDOW).length;
  }

  /**
   * Роль-арбитр: функция Reviewer (в проекте — Warden) с заполненным Agent URL.
   *
   * Отдельной «роли арбитра» в Notion нет намеренно: арбитраж — это работа
   * приёмки, и заводить вторую строку ради неё значило бы дать одной и той же
   * функции два разных права.
   */
  async function arbiterRole() {
    const list = await roles().catch(() => []);
    return list.find((r) => r.fn === "Reviewer" && r.url && r.status === "Активна") ||
      list.find((r) => r.fn === "Reviewer" && r.url) || null;
  }

  /** Короткая строка ответа для промпта: без разметки и лишних переводов. */
  const arbiterLine = (text, n = 400) => {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
  };

  /**
   * Журнал попыток этой карточки: что транспорт уже видел.
   *
   * Источник — журнал профилей промптов (`recordPromptAttempt`): время, профиль,
   * исход, класс ошибки. Без секретов и без полных текстов задания — арбитру
   * нужен ход событий, а не переписка.
   */
  function arbiterAttempts(cardId, limit = Number(C.arbiterAttempts || 6)) {
    const list = GM_getValue("cfn-prompt-journal-v1", []);
    if (!Array.isArray(list)) return "";
    return list
      .filter((row) => row && norm(row.ref) === norm(cardId))
      .slice(-limit)
      .reverse()
      .map((row) => {
        const at = String(row.at || "").replace("T", " ").slice(0, 16);
        return [`${at} · ${row.kind || "?"}`, row.profileId, `overhead ${row.overhead ?? "?"}`,
          row.outcome, row.errorClass].filter(Boolean).join(" · ");
      })
      .join("\n");
  }

  /** Состояние PR по GitHub — без догадок из чата. Ошибка не отменяет разбор. */
  async function arbiterPrState(prUrl) {
    const raw = String(prUrl || "").trim();
    const ref = raw.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
    if (!ref) return { pr: raw, prState: "" };
    try {
      const pr = await githubPr(`${ref[1]}/${ref[2]}`, Number(ref[3]), ghToken());
      const prState = pr?.merged || pr?.merged_at
        ? "слит"
        : String(pr?.state || "").toLowerCase() === "closed"
          ? "закрыт без мержа"
          : pr?.draft ? "draft, открыт" : "открыт";
      return { pr: raw, prState };
    } catch (e) {
      return { pr: raw, prState: `состояние не прочитано (${firstLine(e?.message || String(e), 80)})` };
    }
  }

  /**
   * Собрать дело для арбитра. Все факты читаются заново: карточка могла
   * измениться между выдачей и этим шагом. Ошибка Notion не превращается в
   * «петли нет» — просто фактов меньше, и это видно в промпте.
   */
  async function arbiterCase(card, why = "") {
    const fresh = await notion("GET", `pages/${card.id}`);
    const mission = await activeMission().catch(() => null);
    const pr = await arbiterPrState(fresh.properties?.["PR"]?.url || "");
    let queue = "";
    if (mission) {
      try { queue = (await queueOf(mission)).summary; } catch { queue = ""; }
    }
    const now = Date.now();
    const redispatch = (GM_getValue(redispatchKey(card.id), []) || []).map(Number)
      .filter((at) => now - at < REDISPATCH_WINDOW);
    return {
      cardId: card.id,
      cardTitle: taskTitle(fresh) || card.title || card.id,
      missionId: rt(fresh.properties?.["Mission ID"]).trim() || mission?.id || "",
      role: taskRole(fresh),
      redispatchCount: redispatch.length,
      redispatchLimit: REDISPATCH_LIMIT,
      windowHours: Math.round(REDISPATCH_WINDOW / 3600000),
      reason: why || redispatchWhy(fresh),
      state: taskState(fresh),
      check: fresh.properties?.["Check"]?.select?.name || "",
      answer: arbiterLine(rt(fresh.properties?.["Ответ"])),
      pr: pr.pr,
      prState: pr.prState,
      attempts: arbiterAttempts(card.id),
      queue,
      missionName: mission ? rt(mission.properties?.["Миссия"]) || mission.id : "",
    };
  }

  /** Промпт арбитра. Пустой envelope — пауза уже поставлена компилятором. */
  function arbiterPrompt(role, kase, turnId, attempt = 1) {
    return compileOrPause({
      kind: "arbiter",
      role: promptRole(role),
      mission: { id: kase.missionId, name: kase.missionName },
      turnId,
      arbiter: kase,
      delivery: { tier: "full", attempt },
    }, `arbiter ${kase.cardId}`);
  }

  /**
   * Отдать карточку арбитру вместо паузы.
   *
   * true  — ход ушёл арбитру либо цикл остановлен по лимиту арбитражей:
   *         продолжать прежний шаг нельзя;
   * false — арбитра нет (или дело не прочитать); вызывающий ставит прежнюю
   *         паузу Мастера. Порог `arbiterLimit` не даёт звать арбитра по кругу:
   *         арбитр — не бесконечный цикл, а последняя попытка разобраться.
   */
  async function escalateToWarden(card, why = "") {
    const role = await arbiterRole();
    if (!role) return false;
    const times = noteArbitration(card.id);
    if (times > Number(C.arbiterLimit || 2)) {
      pause(
        `«${taskTitle(card) || card.id}» уже ${times} раз уходила арбитру, и петля не разобрана. ` +
          "Дальше решает Мастер: посмотрите «Ответ», журнал попыток и постановку карточки. " +
          "Цикл остановлен, карточка и очередь на месте.",
        { kind: "arbiter-limit", ref: card.id, notifyTitle: "Relay: петля не разобрана" },
      );
      return true;
    }
    let kase;
    try {
      kase = await arbiterCase(card, why);
    } catch (e) {
      // Дело арбитра не прочитать — выдумывать его нельзя. Прежняя пауза
      // честнее: она называет причину, а не показывает арбитру пустоту.
      log(`Карточку «${card.id}» не прочитать для арбитража: ${e.message}`, true);
      return false;
    }
    const turnId = uid();
    log(
      `«${kase.cardTitle}» перевыдали ${kase.redispatchCount} раз за ${kase.windowHours} ч — ` +
        `передаю арбитру «${role.name}» (разбор ${times} из ${C.arbiterLimit}).`,
      true,
      { ntfy: "quiet", title: "Relay: петля у арбитра" },
    );
    await sendToRole(role, arbiterPrompt(role, kase, turnId), "arbiter", kase.cardId, {
      missionId: kase.missionId || "",
      turnId,
      title: `арбитраж «${kase.cardTitle}»`,
      arbiter: kase,
    });
    return true;
  }

  /** Ожидание арбитража всё ещё наше: карточка и ход те же. */
  function currentArbitration(expect) {
    const live = GM_getValue(K.expect, null);
    return Boolean(live && live.kind === "arbiter" && norm(live.ref) === norm(expect.ref) &&
      norm(live.turnId) === norm(expect.turnId));
  }

  /** Записать разбор в карточку: человек должен видеть причину без журнала. */
  async function recordArbitration(cardId, decision) {
    const line = [
      `Арбитраж Warden (${nowIso().slice(0, 16).replace("T", " ")}): ${decision.action}.`,
      `Причина: ${arbiterLine(decision.reason, 600)}.`,
      decision.fix ? `Правка постановки: ${arbiterLine(decision.fix, 600)}.` : "",
    ].filter(Boolean).join(" ");
    try {
      await patch(cardId, { "Ответ": { rich_text: richText(line) } });
      return true;
    } catch (e) {
      // Решение всё равно применяется: потерять разбор петли хуже, чем строку
      // в поле, но Мастер об этом узнаёт из журнала.
      log(`Разбор арбитра не записался в карточку «${cardId}»: ${e.message}`, true);
      return false;
    }
  }

  /**
   * Ход арбитра: решение по карточке или остановка цикла.
   *
   * Решения (`verdict:resolve`):
   *   ready    — та же карточка уходит в Ready заново; причина и правка
   *              постановки остаются в поле «Ответ», чтобы их увидели
   *              исполнитель и Координатор;
   *   rework   — карточка возвращается автору постановки;
   *   accepted — работа на самом деле выполнена;
   *   blocked  — карточка в Blocked, цикл идёт дальше без неё;
   * `verdict:master` — остановка цикла; дальше только человек.
   *
   * В любом решении ход возвращается Координатору: работу по-прежнему выбирает
   * он, а арбитр лишь снимает петлю и называет причину.
   */
  async function arbiterStep(role, expect, manual = false) {
    if (!expect || expect.kind !== "arbiter") {
      pause("Это не ход арбитража: решение не применяю.", { kind: "handoff-kind", ref: expect?.ref || "" });
      return true;
    }
    if (!currentArbitration(expect)) {
      pause("Ожидание арбитража изменилось: чужой ход не перезаписываю.", {
        kind: "marker-mismatch", ref: expect.ref || "",
      });
      return true;
    }
    const cardId = String(expect.ref || "").trim();
    if (!isUuid(cardId)) {
      pause("Арбитраж ссылается на несуществующую карточку: решение не применяю.", {
        kind: "marker-mismatch", ref: cardId,
      });
      return true;
    }
    const replies = messagesAfter(expect.watermark);
    const decision = replies.map((m) => parseMarker(m.raw, "CF_ARBITER_RESULT")).filter(Boolean).at(-1);
    if (!decision) return markerMissing(role, expect, "CF_ARBITER_RESULT", manual);

    const turn = String(decision.turn_id || "").trim();
    const dispatch = String(decision.dispatch_id || "").trim();
    const matches = isUuid(expect.turnId) && isUuid(turn) && isUuid(dispatch) &&
      norm(turn) === norm(expect.turnId) && norm(dispatch) === norm(cardId) &&
      (!expect.roleId || (role?.id && norm(role.id) === norm(expect.roleId)));
    if (!matches) {
      const retained = retainRejectedResult(expect, "arbiter-identity", replies);
      pause("Маркер арбитража не относится к этой карточке и этому разбору (dispatch_id / turn_id / адресат). " +
        (retained ? "Копия ответа сохранена локально; " : "Локальная копия не записалась — сохраните ответ из чата вручную; ") +
        "попросите арбитра повторить маркер с ID из этого промпта.", {
        kind: "marker-mismatch", ref: cardId, turnId: expect.turnId || "",
      });
      return true;
    }

    const verdict = String(decision.verdict || "").trim().toLowerCase();
    if (verdict === "master") {
      // Остановка цикла — право арбитра, но снимает её по-прежнему человек.
      GM_setValue(K.expect, null);
      GM_setValue(arbiterKey(cardId), []);
      pause(
        `Арбитр «${role.name}» не смог разобрать петлю по «${expect.title || cardId}»: ` +
          `${firstLine(decision.reason || decision.fix || "причина не указана")}. ` +
          "Цикл остановлен решением арбитра; карточка, очередь и «Ответ» на месте — " +
          "посмотрите их и нажмите «Продолжить».",
        { kind: "arbiter-master", ref: cardId, turnId: expect.turnId || "", notifyTitle: "Relay: арбитр остановил цикл" },
      );
      return true;
    }
    if (verdict !== "resolve") {
      pause(
        `В маркере арбитража нет verdict resolve или master (пришло «${verdict || "пусто"}»): карточку не трогаю. ` +
          "Поправьте маркер в ответе арбитра и нажмите «Продолжить».",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }

    const action = String(decision.action || "").trim().toLowerCase();
    if (!["ready", "rework", "accepted", "blocked"].includes(action)) {
      pause(
        `Арбитр вынес решение без понятного действия по карточке (action «${action || "пусто"}»). ` +
          "Нужно ready / rework / accepted / blocked: карточку не трогаю, чтобы не запустить петлю заново.",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }
    // Решение без причины — это не разбор петли, а её продолжение.
    const reason = String(decision.reason || "").trim();
    if (!reason) {
      pause(
        "Арбитр не назвал причину петли: решение без причины повторяет ту же работу и возвращает ту же беду. " +
          "Допишите reason и нажмите «Продолжить».",
        { kind: "arbiter-marker", ref: cardId, turnId: expect.turnId || "" },
      );
      return true;
    }

    // Дальше карточка читается заново: между разбором и решением её могли
    // тронуть. Чужое решение вслепую не применяется.
    const card = await notion("GET", `pages/${cardId}`);
    const mission = await activeMission().catch(() => null);
    const cardMission = rt(card.properties?.["Mission ID"]).trim();
    if (mission && cardMission && norm(cardMission) !== norm(mission.id)) {
      pause("Карточка арбитража относится к другой миссии: решение не применяю.", {
        kind: "marker-mismatch", ref: cardId,
      });
      return true;
    }

    await recordArbitration(cardId, { ...decision, action, reason });
    // Решение применяется одной записью состояния. Следы прошлого ответа
    // (Submitted At, PR, Run ID, Check) снимает выдача: арбитр их не трогает,
    // иначе «Ответ» исчезнет раньше, чем его прочитают.
    if (action === "accepted") {
      await patch(cardId, { "Dispatch State": { select: { name: "Accepted" } } });
    } else if (action === "rework") {
      await patch(cardId, { "Dispatch State": { select: { name: "Rework" } } });
    } else if (action === "blocked") {
      await patch(cardId, { "Dispatch State": { select: { name: "Blocked" } } });
    } else {
      // ready: карточка возвращается в работу. Check описывает прошлый ответ,
      // который арбитр как раз и не признал, поэтому он снимается вместе с
      // решением, а не остаётся молчаливым запретом на выдачу.
      await patch(cardId, {
        "Dispatch State": { select: { name: "Ready" } },
        Check: { select: null },
      });
    }
    GM_setValue(K.expect, null);
    // Порог перевыдач обнуляется: петля разобрана и названа. Если та же карточка
    // закрутится снова, счёт начнётся заново, а не с порога.
    GM_setValue(redispatchKey(cardId), []);
    log(
      `Арбитраж по «${taskTitle(card) || cardId}»: action=${action}, причина — ${firstLine(reason)}` +
        (decision.fix ? `; правка постановки: ${firstLine(decision.fix, 160)}` : "") +
        ". Ход возвращается Координатору.",
      false,
      { tone: "ok" },
    );

    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Петля разобрана, но активного Coordinator нет: ход возвращать некому.", {
        kind: "arbiter-nocoord", ref: cardId,
      });
      return true;
    }
    if (!mission) {
      pause("Петля разобрана, но активной миссии нет: ход возвращать некому.", {
        kind: "arbiter-nomission", ref: cardId,
      });
      return true;
    }
    const fresh = await notion("GET", `pages/${mission.id}`).catch(() => mission);
    await requestPlan(
      fresh,
      coord,
      await queueOf(fresh),
      `Warden разобрал петлю по «${taskTitle(card) || cardId}»: ${action} — ${firstLine(reason, 200)}. ` +
        (decision.fix ? `Правка постановки: ${firstLine(decision.fix, 200)}. ` : "") +
        "Учти это в следующем ходе и не выдавай карточку тем же порядком.",
      { force: true },
    );
    return true;
  }

  // ─────────────────────── вопросы: отвечает приёмка ───────────────────────
  /**
   * Вопрос агента больше не ждёт Мастера.
   *
   * Раньше вопрос ложился строкой в «Вопросы» со сроком, цикл шёл по варианту
   * по умолчанию, а ответ Мастера мог прийти через сутки или не прийти вовсе.
   * 28.10 Мастер сказал прямо: на вопросы отвечает приёмка, и отвечает сразу —
   * ход переключается на неё, как только вопрос записан.
   *
   * Теперь у вопроса две судьбы:
   *   answer — приёмка решила по существу: «Ответ» записан, «Статус» =
   *            «Решено», и ответ уезжает агентам обычным путём на следующем
   *            ходе («Ответы на вопросы» в промпте);
   *   master — без Мастера физически нельзя (нужен новый агент, доступ, смена
   *            ТЗ или оракула): только тогда цикл встаёт и зовёт его.
   *
   * Предел срока (`Срок`, «Принят дефолт») остаётся страховкой обычных
   * вопросов. Для ADR default не заменяет фактического решения приёмки.
   */
  const answerQueue = () => {
    const stored = GM_getValue(K.answers, []);
    return Array.isArray(stored) ? stored : [];
  };

  /** Поставить вопрос в очередь приёмки. Повтор с тем же id не дублируется. */
  function queueAnswer(row, q, ctx = {}) {
    if (!row || !row.id) return null;
    const item = {
      id: row.id,
      pageUrl: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(row.id))
        ? `https://www.notion.so/${String(row.id).replace(/-/g, "")}` : "",
      text: q.text,
      fullText: q.fullText || q.text,
      fallback: q.fallback,
      options: Array.isArray(q.options) ? q.options : [],
      url: questionMaterial(q.url, `${q.text || ""} ${q.fullText || ""}`),
      role: ctx.roleName || "",
      card: ctx.card || "",
      mission: ctx.mission || "",
      at: Date.now(),
    };
    const list = answerQueue().filter((row0) => row0.id !== item.id);
    list.push(item);
    GM_setValue(K.answers, list);
    return item;
  }

  const dropAnswer = (id) => GM_setValue(K.answers, answerQueue().filter((item) => item.id !== id));

  const answerPending = () => answerQueue()[0] || null;

  /** Промпт приёмке: ответить на вопрос агента по существу или позвать Мастера. */
  function answerPrompt(mission, role, item, turnId) {
    return compileOrPause({
      kind: "answer",
      role: promptRole(role),
      mission: { id: mission.id, name: rt(mission.properties["Миссия"]) || "миссия", tzUrl: mission.properties["ТЗ URL"]?.url || "" },
      turnId, // тот же turn_id; после masterEscalated новый не создаётся
      question: {
        id: item.id, turnId,
        text: item.text, fullText: item.fullText || item.text,
        options: Array.isArray(item.options) ? item.options : [],
        fallback: item.fallback, sourceUrl: item.pageUrl || item.url || "",
        role: item.role || "", card: item.card || "",
        masterEscalated: Boolean(item.masterEscalated),
      },
      delivery: { tier: "full", attempt: 1 },
    }, `answer ${item.id}`);
  }

  /** Проверяем настоящий Git blob текста, а не один формальный маркер SHA. */
  async function verifiedAdrMaterial(item) {
    const shas = [...String(item?.fullText || "").matchAll(/\bCF_ADR_CONTENT\s+([0-9a-f]{40})\b/gi)].map((m) => m[1].toLowerCase());
    if (!shas.length || !Array.isArray(item.adrBlocks) || !globalThis.crypto?.subtle) return false;
    const candidates = [];
    for (const raw of item.adrBlocks) {
      candidates.push(String(raw)); // отдельно сохранённый исходный файл
      const full = String(raw).match(/ПОЛНЫЙ НЕИЗМЕНЁННЫЙ ТЕКСТ ФАЙЛА:\n([\s\S]*?)\nКОНЕЦ ТЕКСТА CF_ADR_CONTENT_END [0-9a-f]{40}/i);
      if (full) candidates.push(full[1]); // текст внутри дополнения watcher
    }
    for (const text of candidates) {
      const body = new TextEncoder().encode(text);
      const prefix = new TextEncoder().encode(`blob ${body.byteLength}\0`);
      const data = new Uint8Array(prefix.length + body.length);
      data.set(prefix); data.set(body, prefix.length);
      const digest = await globalThis.crypto.subtle.digest("SHA-1", data);
      const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      if (shas.includes(hash)) return true;
    }
    return false;
  }

  /**
   * Передать вопрос приёмке. `true` — ход ушёл ей; `false` — отвечать некому
   * (вопрос остаётся «Ждёт»; обычный может закрыться сроком, ADR ждёт ответа).
   */
  async function startAnswer(mission, item) {
    if (typeof questionBodyPending === "function" && questionBodyPending(item.id)) return false;
    if (typeof questionQueuedForAnswer === "function" && questionQueuedForAnswer(item)) return false;
    if (/github\.com\/[^\s]+\/docs\/decisions\//i.test(String(item.url || ""))) {
      try {
        const page = await notion("GET", `pages/${item.id}`);
        if (sel(page.properties?.["Статус"]) !== Q.wait) return false;
        const complete = await questionFromRowComplete(page);
        if (!(await verifiedAdrMaterial(complete))) {
          const hasMarker = /\bCF_ADR_CONTENT\s+[0-9a-f]{40}\b/i.test(String(complete.fullText || ""));
          throw new Error(hasMarker
            ? "полный текст не совпадает с Git blob SHA"
            : "сторож ещё не дописал полный текст файла с Git blob SHA");
        }
        item = { ...item, fullText: complete.fullText, url: complete.url || item.url };
      } catch (e) {
        logThrottled(`adr-body:${item.id}`, `Предложение не передано приёмке: ${e.message}. Вопрос и ожидание сохранены; проверьте полный текст и SHA.`, true);
        return false;
      }
    }
    const role = await reviewerRole();
    if (!role) {
      log(
        "Вопрос записан, но активной роли с функцией Reviewer нет: отвечать некому — вопрос ждёт Мастера.",
        false,
        { ntfy: "quiet", title: "Relay: отвечать на вопрос некому" },
      );
      dropAnswer(item.id);
      return false;
    }
    const turnId = uid();
    // D-068: «передан» пишем только тогда, когда ход действительно поставлен в
    // очередь. Раньше строка печаталась до отправки и оставалась правдой даже
    // при защитном отказе `sendToRole` (дубль, запрещённый адресат, окно
    // настроек): в журнале ход «ушёл», а в очереди его нет — и цикл молча
    // остаётся на странице Координатора.
    const queued = await sendToRole(role, answerPrompt(mission, role, item, turnId), "answer", item.id, {
      questionId: item.id,
      missionId: mission.id,
      turnId,
      title: "ответ на вопрос агента",
    });
    if (!queued) {
      log(
        `Вопрос «${oneLine(item.text, 90)}» не передан приёмке: транспорт не поставил ход в очередь ` +
          "(защитный отказ или окно настроек). Вопрос остаётся «Ждёт» и повторится на следующем шаге.",
        true,
        { ntfy: "quiet", title: "Relay: вопрос не передан" },
      );
      return false;
    }
    log(`Вопрос «${oneLine(item.text, 90)}» передан приёмке «${role.name}».`, false, { ntfy: "quiet" });
    return true;
  }

  /** Ход приёмки по вопросу: записать ответ или позвать Мастера. */
  async function answerStep(role, expect, manual = false) {
    const replies = messagesAfter(expect.watermark);
    let decision = replies.map((m) => parseMarker(m.raw, "CF_ANSWER_RESULT"))
      .filter(Boolean)
      .at(-1);
    // A `master` verdict pauses the cycle, but the Master may then answer in
    // the same Warden conversation. Also accept an answer they entered directly
    // in Notion before pressing Continue. Both paths remain bound to this exact
    // question/turn and never overwrite a completed row.
    if (!decision && expect.masterEscalated) {
      try {
        const row = await notion("GET", `pages/${expect.ref}`);
        const state = row?.properties?.["Статус"]?.select?.name || "";
        const savedAnswer = rt(row?.properties?.["Ответ"] || "").trim();
        if (state === Q.done && savedAnswer) {
          decision = { question_id: expect.ref, turn_id: expect.turnId, verdict: "answer", answer: savedAnswer };
        }
      } catch (e) {
        logThrottled(`master-answer-read:${expect.ref}`, `Не удалось проверить ручной ответ Мастера: ${e.message}. Ожидание сохранено.`, true);
      }
    }
    if (!decision) return markerMissing(role, expect, "CF_ANSWER_RESULT", manual);
    // Одного нового сообщения в чате недостаточно: оно может относиться к
    // предыдущему вопросу или повторной попытке того же вопроса. Не очищаем
    // ожидание и не записываем решение, пока обе границы не подтверждены.
    const qid = String(decision.question_id || "").trim();
    const turn = String(decision.turn_id || "").trim();
    const live = GM_getValue(K.expect, null);
    const matches = Boolean(isUuid(expect.ref) && isUuid(expect.turnId) && isUuid(qid) && isUuid(turn) && live && live.kind === "answer" &&
      norm(qid) === norm(expect.ref) && norm(turn) === norm(expect.turnId) &&
      norm(live.ref) === norm(expect.ref) && norm(live.turnId) === norm(expect.turnId) &&
      (!expect.roleId || (role?.id && norm(role.id) === norm(expect.roleId))) &&
      (!live.roleId || (expect.roleId && norm(live.roleId) === norm(expect.roleId))));
    if (!matches) {
      const retained = retainRejectedResult(expect, "answer-identity", replies);
      pause("Ответ не подтверждён для текущего вопроса и хода (question_id / turn_id / адресат). " +
        (retained ? "Ожидание и копия ответа сохранены локально; " : "Ожидание сохранено, локальная копия не записалась — сохраните ответ из чата вручную; ") +
        "попросите приёмку повторить маркер с ID этой выдачи.", {
        kind: "marker-mismatch", ref: expect.ref || "", turnId: expect.turnId || "",
      });
      return true;
    }
    const verdict = String(decision.verdict || "").trim().toLowerCase();
    const answer = String(decision.answer || "").trim();
    if (verdict === "master") {
      const reason = firstLine(String(decision.reason || answer || "").trim()) || "приёмка не назвала причину";
      // Keep the exact answer expectation alive across the Master pause. A later
      // Warden answer marker (or a manual Notion resolution) can then be safely
      // matched to this question and turn instead of letting the cycle jump to
      // Coordinator and strand the response.
      GM_setValue(K.expect, {
        ...expect,
        watermark: replies.at(-1)?.id || expect.watermark,
        masterEscalated: true,
        tries: 0,
        lastReplySig: "",
        lastReplyAt: 0,
      });
      pause(
        `Приёмка не может ответить на вопрос без Мастера: ${reason}. Вопрос остался в базе «Обратная связь» со статусом ` +
          "«Ждёт». После ответа Мастера продолжите здесь: приму маркер Warden только для этого question_id/turn_id; " +
          "если ответ внесён вручную в Notion, поставьте «Решено» и нажмите «Продолжить».",
        { kind: "answer-needs-master", ref: expect.ref, notifyTitle: "Relay: вопрос ждёт Мастера" },
      );
      return true;
    }
    if (verdict !== "answer") {
      pause(
        `В маркере ответа нет verdict answer или master (пришло «${verdict || "пусто"}»): вопрос не закрываю. ` +
          "Поправьте маркер в ответе приёмки и нажмите «Продолжить».",
        { kind: "answer-marker", ref: expect.ref },
      );
      return true;
    }
    if (!answer) {
      pause("Приёмка ответила без текста решения: пустой ответ ничего не меняет, вопрос остаётся открытым.", {
        kind: "answer-empty",
        ref: expect.ref,
      });
      return true;
    }
    // Вопрос могли закрыть руками, пока приёмка думала: тогда её ответ уже
    // никому не нужен, и перезаписывать чужое решение нельзя.
    let stage = "read";
    let result;
    try {
      // Та же блокировка, что у закрытия по сроку: два действия одной вкладки
      // не могут перезаписать решение друг друга между чтением и записью.
      result = await withQuestionWriteLock(async () => {
        const row = await notion("GET", `pages/${expect.ref}`);
        const state = row?.properties?.["Статус"]?.select?.name || "";
        if (!state) throw new Error("статус строки не прочитан");
        if (state !== Q.wait) return { state, answerRecorded: false };
        const current = GM_getValue(K.expect, null);
        if (!current || current.kind !== "answer" || norm(current.ref) !== norm(expect.ref) ||
            norm(current.turnId) !== norm(expect.turnId) ||
            (expect.roleId && norm(current.roleId) !== norm(expect.roleId))) {
          return { state, answerRecorded: false, changed: true };
        }
        stage = "write";
        await patch(expect.ref, {
          "Статус": { select: { name: Q.done } },
          "Ответ": { rich_text: richText(answer) },
        });
        return { state, answerRecorded: true };
      });
    } catch (e) {
      // Не восстанавливаем снимок поверх нового хода, возникшего во время сети.
      const current = GM_getValue(K.expect, null);
      const same = current?.kind === "answer" && norm(current.ref) === norm(expect.ref) &&
        norm(current.turnId) === norm(expect.turnId);
      logThrottled(`answer-${stage}:${expect.ref}`, `Не удалось ${stage === "read" ? "проверить строку" : "записать ответ"} обратной связи (${e.message}): ` +
        (same ? "ожидание сохранено, повторю проверку." : "текущее ожидание изменилось; не перезаписываю, проверьте оба хода."), true);
      return true;
    }
    const { state, answerRecorded } = result;
    // Не снимаем ожидание другого хода, если оно изменилось во время сети.
    const afterWrite = GM_getValue(K.expect, null);
    if (afterWrite && afterWrite.kind === "answer" && norm(afterWrite.ref) === norm(expect.ref) &&
        norm(afterWrite.turnId) === norm(expect.turnId)) GM_setValue(K.expect, null);
    else {
      pause("Вопрос обработан, но ожидание изменилось во время записи. Проверьте обе попытки; новое ожидание сохранено.", {
        kind: "answer-changed", ref: expect.ref, turnId: expect.turnId,
      });
      return true;
    }
    dropAnswer(expect.ref);
    if (!answerRecorded) {
      log(
        `Вопрос закрыт раньше приёмки («${state}») — ответ не перезаписываю, ход возвращается Координатору.`,
        false,
        { tone: "warn", ntfy: "quiet" },
      );
    }
    // Панель знает про ответ сразу: вопрос больше не «Ждёт».
    try {
      recordQuestionChange(expect.ref, null);
      const cache = openQuestions();
      GM_setValue("cfn-q-open", { at: cache.at, rows: cache.rows.filter((row) => row.id !== expect.ref) });
      paintQuestions(openQuestions().rows);
    } catch (e) {
      dbg("вопросы: панель не обновилась", e.message);
    }
    if (answerRecorded)
      log(`Вопрос закрыт приёмкой «${role.name}»: ${oneLine(answer, 160)}`, false, { tone: "ok", ntfy: "quiet" });
    // Ход возвращается Координатору: ответ придёт ему строкой в промпте
    // («Ответы на вопросы»), а next из хода, где вопрос был задан, не
    // применялся — он посчитан без ответа.
    const mission = await activeMission().catch(() => null);
    if (!mission) {
      log("Вопрос закрыт, но активной миссии нет: продолжать не с чего.");
      return true;
    }
    const coord = (await roles().catch(() => [])).find((r) => r.fn === "Coordinator");
    if (!coord) {
      pause("Вопрос закрыт, но активного Coordinator нет: ход возвращать некому.", {
        kind: "answer-nocoord",
        ref: mission.id,
      });
      return true;
    }
    const queue = await queueOf(mission).catch(() => ({ summary: "очередь не прочитана" }));
    const note = answerRecorded ? "Ответ на вопрос записан — учти его и продолжи план." :
      "Вопрос уже закрыт в Notion — учти сохранённое состояние и продолжи план.";
    await requestPlan(mission, coord, queue, note, { force: true });
    return true;
  }

  /** Проверка постановки и подтверждённых зависимостей, до изменения карточки. */
  async function taskPreflight(card, mission) {
    const active = await activeMission(); // откажет и при нескольких активных миссиях
    if (!mission || !active || norm(active.id) !== norm(mission.id) || !cardInMission(card, active))
      return "Mission ID карточки отсутствует или не совпадает с единственной активной миссией";
    const bindingIssue = cardBindingIssue(card, await query(C.missions));
    if (bindingIssue) return bindingIssue;
    const props = card?.properties || {};
    const empty = ["Намерение", "Инварианты", "Acceptance", "Scope"].filter((name) => !rt(props[name]).trim());
    if (!taskTitle(card).trim()) empty.unshift("Запрос");
    if (typeof props["Sequence"]?.number !== "number" || !Number.isFinite(props["Sequence"].number)) empty.push("Sequence");
    if (empty.length) return `не заполнены обязательные поля: ${empty.join(", ")}`;
    if (!props["Dependency"] || props["Dependency"].type && props["Dependency"].type !== "rich_text")
      return "в схеме нет текстового поля Dependency";
    const value = rt(props["Dependency"]).trim();
    if (!value || /^(нет|none|n\/a|—|-)$/i.test(value)) return "";
    const ids = value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!ids.length || ids.some((id) => !isUuid(id)) || new Set(ids.map(norm)).size !== ids.length)
      return "Dependency: перечисли UUID карточек через запятую или оставь поле пустым; названия и неоднозначные ссылки не проверяются";
    for (const id of ids) {
      if (norm(id) === norm(card.id)) return "Dependency ссылается на саму карточку";
      const dependency = await notion("GET", `pages/${id}`);
      if (!cardInMission(dependency, active)) return `Dependency ${id}: карточка другой миссии или без Mission ID`;
      if (taskState(dependency) !== "Accepted") return `Dependency ${id}: карточка ещё не Accepted`;
      if (dependency.properties?.["Check"]?.select?.name === "fail") return `Dependency ${id}: Check = fail, разберись с остатком`;
    }
    return "";
  }

  async function dispatchTask(card, roleName, mission = null) {
    const role = (await roles()).find((r) => r.name === roleName);
    if (!role) throw new Error(`Роль «${roleName}» не найдена среди активных.`);
    // Защита перед любыми чтениями/записями карточки и журнала: повторная
    // выдача не должна даже очистить следы прежнего ответа Reviewer.
    if (role.fn === "Reviewer" || String(role.name || "").toLowerCase() === "warden")
      return "Reviewer принимает миссии и отвечает на вопросы; рабочую карточку переназначь Auditor или Executor";
    if (!["Executor", "Auditor"].includes(role.fn))
      return `функция роли «${role.fn || "не указана"}» не разрешает выдачу; выбери Executor или Auditor`;
    // На границе выдачи кеш недостаточен: функция или Agent URL могли только
    // что измениться. Ошибка чтения не разрешает выдачу по устаревшим данным.
    const directory = await roleRows({ fresh: true, requireFresh: true });
    if (role.id && directory.some((r) => r.fn === "Reviewer" && r.id && norm(r.id) === norm(role.id)))
      return "этот Agent URL принадлежит Reviewer; рабочую карточку переназначь другому агенту";
    const confirmed = directory.filter((r) => norm(r.name) === norm(role.name) && r.id && role.id &&
      norm(r.id) === norm(role.id) && r.url && r.status === "Активна");
    if (confirmed.length !== 1 || confirmed[0].fn !== role.fn || !["Executor", "Auditor"].includes(confirmed[0].fn))
      return "роль или её функция изменились перед выдачей; перечитай базу «Роли» и выбери активного исполнителя или аудитора";

    // Цель выдачи — репозиторий сессии роли (карта route репозиториев профиля)
    // и его базовая ветка. Техблок, команды gh и проверка PR берутся из этого
    // контекста, а не из глобального C.repo/C.branch, чтобы один профиль
    // обслуживал несколько репозиториев без смены UUID.
    // The freshly re-read Notion role row is the live assignment source. The
    // profile map is a compatibility fallback for older role rows without a
    // repository field; it must not route Executor Core into the profile's
    // default cortex repo when Notion explicitly assigns it to synapse.
    const sessionRepo = canonicalTargetRepository(confirmed[0].repo || profileSessionRepo(role.id) || "", C.repo);

    // Карточка перечитывается прямо перед выдачей: между выбором из списка и
    // отправкой её мог тронуть Координатор, прошлый тик или человек. 23.10
    // NAR-1.7 выдали второй раз с новым run — она была в списке Ready уже
    // отвеченной, и агент честно повторил ту же работу.
    const fresh = await notion("GET", `pages/${card.id}`);
    const preflight = await taskPreflight(fresh, mission);
    if (preflight) return `предварительная проверка: ${preflight}; карточку и историю не меняю`;
    const recipient = taskRole(fresh);
    if (!recipient || norm(recipient) !== norm(role.name))
      return `адресат карточки изменился на «${recipient || "не указан"}»; перечитай её и назови верную роль`;
    const state = taskState(fresh);
    const targetRepo = taskTargetRepository(fresh, sessionRepo);
    if (!targetRepo) return "у карточки и назначенной роли не задан целевой репозиторий";
    if (typeof ACTIVE_PROFILE !== "undefined" && !ACTIVE_PROFILE.legacy) {
      const entry = (Array.isArray(ACTIVE_PROFILE.repos) ? ACTIVE_PROFILE.repos : []).find(
        (item) => item && String(item.repo || "").toLowerCase() === targetRepo.toLowerCase(),
      );
      if (!entry) return `репозиторий карточки ${targetRepo} не разрешён в профиле; карточку и очередь не меняю`;
    } else if (String(C.repo || "").toLowerCase() !== targetRepo.toLowerCase()) {
      return `репозиторий карточки ${targetRepo} не совпадает с legacy-профилем ${C.repo}; выдачу не начинаю`;
    }
    const targetBranch = profileRepoBranch(targetRepo);
    if (fresh.properties?.Check?.select?.name === "fail" && !reworkSeen(fresh.id)) {
      // Не ставим общую паузу на первой попытке: coordinatorStep вернёт
      // Coordinator точную техническую причину и переспросит план. Это не
      // разрешает выдачу — карточка и следы остаются нетронуты. Три одинаковых
      // отказа подряд уже ограничены cfn-dispatch-miss и приведут к паузе.
      return `«${taskTitle(fresh)}» имеет Check=fail, но ScriptCat не зафиксировал состояние Rework. ` +
        "Не выдавал карточку и не менял её поля: Submitted At, PR и Run ID сохранены. " +
        "Сначала оставь карточку в Rework, чтобы транспорт успел увидеть явный возврат; " +
        "после разбора результата и решения Warden можно отдельным следующим шагом вернуть её в Ready. " +
        "Не ставь Rework и Ready одним ответом: Check=fail не означает pass и не подтверждает, что предыдущий результат разобран.";
    }
    let prLink = fresh.properties["PR"]?.url || "";
    let submittedAt = fresh.properties["Submitted At"]?.date?.start || "";
    // Карточку, которую Координатор снова направил в работу, транспорт чистит
    // сам: следы прошлого ответа («Submitted At», «PR», «Run ID») ставит выдача,
    // и только она имеет право их снять. Координатор их не трогает — коннектор
    // отвечает validation_error, а ждать, пока Rework попадёт в опрос, нельзя:
    // 27.10 на NAR-4.9 он длился меньше одного тика и выдача отказала.
    const clearing = redispatchClearProps(fresh);
    if (clearing) {
      const why = redispatchWhy(fresh);
      try {
        await patch(fresh.id, clearing);
        // Ответа на карточке больше нет — и отметка о нём тоже: следующий
        // ответ поставит новую.
        GM_setValue(answerStampKey(fresh.id), "");
      } catch (e) {
        log(
          `«${taskTitle(fresh)}» вернулась в работу (${why}), но следы прошлого ответа не снялись (${e.message}) — выдача отменена.`,
          true,
        );
        return `следы прошлого ответа не снялись: ${e.message}`;
      }
      GM_setValue(reworkKey(fresh.id), 0);
      submittedAt = "";
      prLink = "";
      log(`«${taskTitle(fresh)}» снова в работе — ${why}: снял «Submitted At», «PR» и «Run ID», выдаю заново.`, false, {
        tone: "ok",
      });
      const times = noteRedispatch(fresh.id);
      if (times >= REDISPATCH_LIMIT) {
        // D-053: повторяющаяся петля — сначала арбитраж, а не пауза. Warden
        // видит «Ответ», состояние карточки, PR и журнал попыток и решает, что
        // делать с карточкой; остановить цикл он тоже может — своим решением.
        // Пауза остаётся запасным путём: нет активного Warden, дело не читается
        // или исчерпан предел арбитражей — тогда, как и раньше, нужен Мастер.
        if (await escalateToWarden(fresh, why)) return true;
        GM_setValue(redispatchKey(fresh.id), []);
        pause(
          `«${taskTitle(fresh)}» перевыдали ${times} раз за шесть часов — похоже, Координатор и исполнитель ` +
            "гоняют одну и ту же карточку и не замечают этого. Разобрать петлю арбитру некому " +
            "(нет активной роли с функцией Reviewer), поэтому решает Мастер: посмотрите «Ответ» и журнал, " +
            "поправьте постановку и нажмите «Продолжить».",
          { kind: "redispatch", ref: fresh.id },
        );
        return true;
      }
    }
    if (state !== "Ready" || submittedAt || prLink) {
      const why =
        state !== "Ready"
          ? `уже ${state || "не в Ready"}`
          : `уже отвечена${prLink ? ` (${prLink})` : ""}`;
      log(`«${taskTitle(fresh)}» ${why} — повторно не выдаю.`, true, {
        ntfy: "quiet",
        title: "Relay: повторная выдача отменена",
      });
      // Карточка не в Ready — значит Координатор назвал работой ту, которую сам
      // же не вернул в очередь. Это его ход, а не сбой сети: пауза ставится
      // только на третьем повторе (см. ветку `dispatch` в `coordinatorStep`),
      // а до тех пор ход возвращается Координатору с точной причиной.
      return state !== "Ready"
        ? `сейчас она в «${state || "неизвестном состоянии"}», а не в Ready`
        : "на ней остались следы прошлого ответа";
    }
    // Карточку выдали заново — прошлое неотправленное задание к ней больше не
    // относится: иначе оно ушло бы вторым сообщением уже после новой выдачи.
    const stale = GM_getValue(K.pending, null);
    const staleExpect = GM_getValue(K.expect, null);
    if (stale && stale.undelivered && staleExpect && norm(staleExpect.ref) === norm(card.id)) {
      GM_setValue(K.pending, null);
      GM_setValue(K.expect, null);
      log("Карточку выдали заново — прошлая неотправленная очередь снята.");
    }

    const runId = uid();
    // 08.11, 18:34: поле «Payload Drive File ID» у B1 перечисляло два файла
    // через запятую — и скрипт отправил шлюзу всю строку как один id, получив
    // «Некорректный Drive file ID». Сеть и карточка были в порядке: отказ
    // разбирался как сбой записи в Notion и ход вставал до утра. Теперь id
    // разбираются по одному и читаются по очереди.
    const payloadIds = driveFileIds(rt(fresh.properties["Payload Drive File ID"]));
    const payloadId = payloadIds[0] || "";
    const payloadParts = [];
    for (const id of payloadIds) {
      try {
        payloadParts.push({ id, text: (await gateway("read", id)).content || "" });
      } catch (e) {
        // Называет файл, а не только «Payload не прочитан»: в карточке их может
        // быть несколько, и Мастеру важно знать, какой именно не открылся.
        throw new Error(`Payload не прочитан (файл ${id}): ${e.message}`);
      }
    }
    const payload = joinPayloadFiles(payloadParts);
    const previousLogId = rt(fresh.properties["Output Drive File ID"]);
    // D-034: снимок большого payload фиксируется до сборки сообщения. D-043:
    // сам промпт проверяется ДО журнала и Running. Иначе oversized-карточка
    // создавала журнал/ожидание, затем откатывалась, а null назывался дублем.
    let payloadRefId = payloadId;
    let payloadPointer = false;
    if (payloadId && payload.trim().length > (C.payloadInlineMax || 1500)) {
      const saved = await gateway("savePayload", "", { name: `${card.id}_${runId}__assignment.md`, content: payload });
      payloadRefId = String(saved?.fileId || "").trim();
      if (!payloadRefId) throw new Error("Шлюз не вернул ID снимка задания (payload).");
      payloadPointer = true;
    }
    const dispatchCtx = { repo: targetRepo, branch: targetBranch };
    if (payloadRefId) {
      dispatchCtx.payloadRef = { fileId: payloadRefId, url: `https://drive.google.com/file/d/${payloadRefId}/view` };
      dispatchCtx.payloadPointer = payloadPointer;
    }
    let compileProblem = "";
    // logId в промпт не входит; журнал создаётся только после успешной сборки.
    const prompt = executorPrompt(fresh, role, payload, "", runId, mission?.id || "", {
      ...dispatchCtx,
      onCompileError: (reason) => { compileProblem = reason; },
    });
    if (!prompt) {
      // Это отказ сборки, а не дубль и не сетевой сбой. Счётчик промахов ещё
      // не сброшен: Координатор получает причину через plan.note (D-042), а
      // третий одинаковый отказ останавливает цикл штатной защитой.
      return `${compileProblem || `Промпт не собран (dispatch ${card.id}); карточка осталась Ready, агенту ничего не отправлено.`} ` +
        "Журнал выдачи не создавался; статус карточки не менял.";
    }
    // Каждому новому Run — свой журнал. Поле карточки может указывать на
    // прошлую попытку или даже чужую миссию; его нельзя использовать повторно.
    const created = await gateway("createLog", "", { dispatchId: card.id, runId });
    const logId = String(created?.fileId || "").trim();
    if (!logId) throw new Error("Шлюз не вернул ID журнала новой выдачи.");
    const beforeWrite = await notion("GET", `pages/${card.id}`);
    const recheck = await taskPreflight(beforeWrite, mission);
    if (recheck || taskState(beforeWrite) !== "Ready" || norm(taskRole(beforeWrite)) !== norm(role.name) ||
        beforeWrite.properties?.["Submitted At"]?.date?.start || beforeWrite.properties?.["PR"]?.url) {
      return `карточка изменилась перед выдачей (${recheck || "состояние, адресат или следы ответа"}); ` +
        `статус не меняю, созданный пустой журнал ${logId} оставлен для проверки`;
    }
    GM_setValue("cfn-dispatch-miss", 0);
    await patch(card.id, {
      "Dispatch State": { select: { name: "Running" } },
      "Run ID": { rich_text: [{ type: "text", text: { content: runId } }] },
      "Recipient Agent ID": { rich_text: [{ type: "text", text: { content: role.id } }] },
      "Output Drive File ID": { rich_text: [{ type: "text", text: { content: logId } }] },
      "Started At": { date: { start: nowIso() } },
      ...(Object.prototype.hasOwnProperty.call(fresh.properties || {}, "Repository")
        ? { Repository: { rich_text: richText(targetRepo) } }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(fresh.properties || {}, "Репозиторий")
        ? { "Репозиторий": { rich_text: richText(targetRepo) } }
        : {}),
      Check: { select: null },
    });
    // Файл журнала создаётся пустым, поэтому задание пишем в него сразу:
    // иначе агент получает ссылку на пустой файл и не понимает, зачем она.
    try {
      await gateway("append", logId, {
        marker: `<!-- CF_DISPATCH ${card.id}:${runId}:task -->`,
        entry: taskLogEntry(fresh, role, payload, runId) +
          (previousLogId && previousLogId !== logId
            ? `\nРанее указанная ссылка на журнал (принадлежность не проверена): https://drive.google.com/file/d/${encodeURIComponent(previousLogId)}/view\n`
            : ""),
      });
    } catch (e) {
      log(`Задание не записалось в журнал попытки: ${e.message}`, true);
    }
    log(
      `Выдан ход ${roleName}: «${taskTitle(fresh)}»` +
        (payload.trim() ? "." : " (отдельного файла с заданием нет — текст собран из карточки)."),
    );
    // Отправляем уже проверенный текст. Null сюда больше не приходит из-за
    // бюджета; отказ очереди по-прежнему разбирает сторож неотправленной выдачи.
    const queued = await sendToRole(role, prompt, "dispatch", card.id, {
      runId,
      missionId: mission?.id || "",
      logId,
      targetRepo,
      targetBranch: targetBranch,
      title: taskTitle(fresh),
      // Ссылка нужна минимальному повтору: «прочитай карточку сам».
      url: fresh.url || "",
    });
    if (!queued) {
      // Очередь не создалась: возможен повтор, запрещённый адресат или другой
      // защитный отказ sendToRole. Хода нет, а карточка уже Running; возвращаем
      // Ready, не выдавая неподтверждённую причину за доказанный дубль (D-043).
      const left = GM_getValue(K.expect, null);
      if (!left || norm(left.ref) !== norm(card.id)) {
        await releaseUndelivered(
          { kind: "dispatch", ref: card.id, runId, title: taskTitle(card) },
          "задание не поставлено в очередь",
        );
        return "задание не поставлено в очередь (отправка не подтверждена; возможен защитный отказ от дубля или адресата)";
      }
    }
    return true;
  }

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
    // D-045: очередь пилота и его статус доводим до хранилища до ухода со
    // страницы. Синхронный контракт сохраняем: вызывающий получает id сразу,
    // а переход выполняется по подтверждении записи.
    flushBeforeNavigate([K.pilotWait + id, K.pilots, K.log]).then(() => location.assign(pilot.url));
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

  // ───────────────────────── tool-call limit: продолжение хода ─────────────────────────
  // Arena: "The agent reached the tool-call limit for this turn. Send a message
  // to continue where it left off." Ход уже начался, часть работы могла быть
  // сделана. Отправляем КОРОТКОЕ сообщение-продолжение в тот же чат: не повторяем
  // задание, не шлём compact-retry и не напоминаем о маркере, не создаём новые
  // Run/turn/question IDs и не трогаем карточку Notion/PR/терминальные поля.
  //
  // Состояние живёт в ожидании (K.expect) отдельными полями и НЕ смешивается с
  // arenaResend (повтор недоставленного), tries (напоминания) и branchResend
  // (повтор из-за слитой ветки): toolLimitContinuations, lastToolLimitMessageId,
  // lastToolLimitAt, toolLimitNoProgress, continuationWatermark.
  //
  // Отправка идёт напрямую (ensureComposer → writePrompt → deliver), а не через
  // K.pending/consumePending: провал продолжения НЕ должен откатывать карточку в
  // Ready — работа по ней уже началась. Исходный watermark не сдвигается, поэтому
  // финальный журнал (runAnswer) собирает весь ход: части до лимита + отчёт после.

  const markerForExpect = (e) =>
    e.kind === "plan" ? "CF_COORDINATOR_RESULT"
      : e.kind === "review" ? "CF_REVIEW_RESULT"
        : e.kind === "answer" ? "CF_ANSWER_RESULT"
        : e.kind === "arbiter" ? "CF_ARBITER_RESULT"
          : "CF_AGENT_RESULT";

  const toolLimitRoleFn = (e) =>
    e.kind === "plan" ? "Coordinator"
      : (e.kind === "review" || e.kind === "answer" || e.kind === "arbiter") ? "Reviewer"
        : (e.roleFn || "Executor");

  /** Запись исхода tool-limit в журнал попытки. Без секретов и полных текстов. */
  function journalToolLimit(expect, status, outcome, envelope) {
    const env = envelope || expect.prompt;
    if (!env || !env.metrics) return;
    recordPromptAttempt(env, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName,
      attempt: (Number(expect.toolLimitContinuations) || 0) + 1,
      outcome, errorClass: "tool_call_limit", messageId: status.messageId,
    });
  }

  /** Активный пилотный ход на текущей странице (собственный namespace). */
  function activePilotOnPage() {
    const waits = listPilots()
      .map((p) => GM_getValue(K.pilotWait + p.id, null))
      .filter((w) => w && w.status === "running" && Number(w.sentAt));
    return waits.find(pilotOnPage) || null;
  }

  /**
   * Оркестратор: вызывается в тике ДО monitorVisibleErrors. Возвращает true,
   * если ход занят продолжением/паузой по tool-limit. Пилот — в своём namespace.
   */
  async function handleToolCallLimit() {
    const status = detectToolCallLimit();
    if (!status) return false;
    const pilotWait = activePilotOnPage();
    if (pilotWait) return continuePilotToolLimit(pilotWait, status);
    const expect = GM_getValue(K.expect, null);
    if (!expect || GM_getValue(K.pending, null)) return false;
    return continueToolLimitTurn(expect, status);
  }

  async function continueToolLimitTurn(expect, status) {
    // Страница должна быть того агента, которого ждём.
    const me = roleFromPath();
    if (!me || norm(me) !== norm(expect.roleId)) return false;
    if (!["dispatch", "plan", "review", "answer", "arbiter"].includes(expect.kind)) return false;
    // Одно и то же статусное сообщение не порождает два продолжения.
    if (expect.lastToolLimitMessageId === status.messageId) return false;
    // Агент ещё генерирует / виден Stop — ждём, не вмешиваемся.
    if (stillWorking()) return false;
    // Доставка исходного хода не подтверждена и ход не начинался — не продолжаем.
    if (!expect.sentAt) return false;
    const replies = messagesAfter(expect.watermark || "", expect.seen);
    const started = expect.verified === true || replies.length > 0;
    if (!started) return false;
    // Ход уже завершён маркером, а статус лимита остался в DOM — не продолжаем.
    const markerName = markerForExpect(expect);
    if (replies.some((m) => String(m.raw || "").includes(markerName))) return false;

    // Рабочая карточка Reviewer: продолжение не шаблонизировано, guard запрещает
    // рабочую выдачу — честно зовём Мастера, карточку не меняем.
    if (expect.kind === "dispatch" && (expect.roleFn === "Reviewer" || norm(expect.roleName) === norm("Warden"))) {
      journalToolLimit(expect, status, "tool_limit_paused");
      pause(
        `Лимит инструментов на рабочей карточке Reviewer «${expect.ref}»: продолжение не шаблонизировано, карточку и IDs не меняю. Нужен Мастер.`,
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
      );
      return true;
    }

    const done = Number(expect.toolLimitContinuations) || 0;
    if (done >= C.toolLimitContinueMax) {
      journalToolLimit(expect, status, "tool_limit_paused");
      pause(
        `Лимит инструментов достигнут снова после ${done} продолжений (предел ${C.toolLimitContinueMax}). ` +
          "Ход не завершён; карточку, PR и IDs не меняю. Нужен Мастер: проверьте страницу агента.",
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "", turnId: expect.turnId || "" },
      );
      return true;
    }
    // После продолжения нет новых содержательных сообщений — только повторный
    // лимит. Продолжать бессмысленно: пауза раньше лимита.
    if (done > 0) {
      const since = messagesAfter(expect.continuationWatermark || expect.watermark || "", expect.seen);
      const substantive = since.filter((m) => String(m.text || "").trim() && !TOOL_LIMIT_RE.test(String(m.text || "")));
      if (!substantive.length) {
        journalToolLimit(expect, status, "tool_limit_no_progress");
        pause(
          "После продолжения агент не дал новых содержательных сообщений — только повторный лимит инструментов. " +
            "Продолжать бессмысленно; карточку и IDs не меняю. Нужен Мастер.",
          { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
        );
        return true;
      }
    }

    const fn = toolLimitRoleFn(expect);
    const ctx = {
      kind: expect.kind, role: { fn, name: expect.roleName || fn },
      turnId: expect.turnId || "", delivery: { tier: "tool_limit", attempt: done + 1 },
    };
    if (expect.kind === "dispatch") ctx.task = { id: expect.ref, runId: expect.runId };
    else if (expect.kind === "answer") ctx.question = { id: expect.ref, turnId: expect.turnId, masterEscalated: expect.masterEscalated === true };
    else if (expect.kind === "arbiter") ctx.arbiter = { cardId: expect.ref, ...(expect.arbiter || {}) };
    else ctx.mission = { id: expect.missionId || expect.ref };
    const envelope = compileOrPause(ctx, `tool-limit continuation ${expect.kind}`);
    if (!envelope) { journalToolLimit(expect, status, "tool_limit_paused"); return true; } // пауза уже поставлена

    const busy = await busySettled();
    if (busy) return false;
    const { editor } = await ensureComposer();
    const failSend = (why) => {
      journalToolLimit(expect, status, "tool_limit_paused", envelope);
      pause(
        `Не удалось отправить продолжение после лимита инструментов (${why}). Карточку, PR и IDs не меняю; нужен Мастер.`,
        { kind: "tool-limit", ref: expect.ref, runId: expect.runId || "" },
      );
      return true;
    };
    if (!editor) return failSend("поле ввода недоступно");
    if (composerText(editor)) clearComposer(editor);
    if (!writePrompt(editor, envelope.text)) return failSend("текст не встал в редактор");
    const contMark = lastMessageId();
    const delivery = await deliver(editor, envelope.text);
    if (delivery.captcha) { captchaPause(); return true; }
    if (!delivery.ok) return failSend(String(delivery.reason || "отправка не прошла").toLowerCase());

    // IDs, карточка, PR и терминальные поля прежние. Исходный watermark НЕ
    // сдвигаем: финальный журнал соберёт части до лимита и отчёт после.
    GM_setValue(K.expect, {
      ...expect,
      prompt: envelope,
      toolLimitContinuations: done + 1,
      lastToolLimitMessageId: status.messageId,
      lastToolLimitAt: Date.now(),
      toolLimitNoProgress: false,
      continuationWatermark: delivery.msgId || contMark,
      sentAt: Date.now(), verified: true,
      tries: 0, lastReplySig: "", lastReplyAt: 0,
    });
    recordPromptAttempt(envelope, {
      kind: expect.kind, ref: expect.ref, role: expect.roleName, attempt: done + 1,
      outcome: "tool_limit_continued", errorClass: "tool_call_limit", messageId: status.messageId,
    });
    log(
      `Лимит инструментов: отправлено продолжение ${done + 1}/${C.toolLimitContinueMax} тому же ходу ` +
        `(${envelope.metrics.chars} символов). IDs прежние, карточка и терминальные поля не тронуты.`,
      true, { ntfy: "quiet", title: "Relay: tool-call limit" },
    );
    return true;
  }

  /** Продолжение пилотного хода: без CF_* и внутренних ссылок, свой namespace. */
  async function continuePilotToolLimit(wait, status) {
    if (wait.lastToolLimitMessageId === status.messageId) return false;
    if (stillWorking()) return false;
    const pilot = getPilot(wait.id);
    const done = Number(wait.toolLimitContinuations) || 0;
    const stop = (outcome, why) => {
      GM_setValue(K.pilotWait + wait.id, { ...wait, status: "tool-limit-paused", lastToolLimitMessageId: status.messageId, lastToolLimitAt: Date.now() });
      if (wait.prompt?.metrics) recordPromptAttempt(wait.prompt, { kind: "pilot", ref: wait.id, role: "pilot", attempt: done + 1, outcome, errorClass: "tool_call_limit", messageId: status.messageId });
      pause(`Пилот ${pilot?.variant || ""}: ${why} Сырой транскрипт сохранён; нужен Мастер.`, { kind: "pilot-tool-limit", ref: wait.id });
      return true;
    };
    if (done >= C.toolLimitContinueMax) return stop("tool_limit_paused", `лимит инструментов после ${done} продолжений (предел ${C.toolLimitContinueMax}).`);
    if (done > 0) {
      const since = messagesAfter(wait.continuationWatermark || wait.watermark || "");
      if (!since.filter((m) => String(m.text || "").trim() && !TOOL_LIMIT_RE.test(String(m.text || ""))).length) {
        return stop("tool_limit_no_progress", "после продолжения нет новых содержательных сообщений, только повторный лимит.");
      }
    }
    const envelope = PromptCompiler.compile({
      kind: "pilot", role: { fn: "pilot", name: `pilot-${pilot?.variant || ""}` },
      delivery: { tier: "tool_limit", attempt: done + 1 },
    });
    if (!envelope.ok) return stop("tool_limit_paused", `продолжение не собрано (${envelope.error.message}).`);
    const busy = await busySettled();
    if (busy) return false;
    const { editor } = await ensureComposer();
    if (!editor) return true;
    if (composerText(editor)) clearComposer(editor);
    if (!writePrompt(editor, envelope.text)) return true;
    const contMark = lastMessageId();
    const delivery = await deliver(editor, envelope.text);
    if (delivery.captcha) { captchaPause(); return true; }
    if (!delivery.ok) { log(`Пилот: продолжение не отправилось (${delivery.reason}).`, true); return true; }
    GM_setValue(K.pilotWait + wait.id, {
      ...wait, toolLimitContinuations: done + 1, lastToolLimitMessageId: status.messageId,
      lastToolLimitAt: Date.now(), continuationWatermark: delivery.msgId || contMark, prompt: envelope,
    });
    recordPromptAttempt(envelope, { kind: "pilot", ref: wait.id, role: "pilot", attempt: done + 1, outcome: "tool_limit_continued", errorClass: "tool_call_limit", messageId: status.messageId });
    log(`Пилот ${pilot?.variant || ""}: продолжение ${done + 1}/${C.toolLimitContinueMax} после лимита инструментов (без командных маркеров).`, true, { ntfy: "quiet" });
    return true;
  }

  // ───────────────────────── provisioning: ядро состояния и правил ─────────────────────────
  // Отдельный административный контур. Не использует K.pending/K.expect и не
  // создаёт рабочие карточки. Право одобрения проверяется по свежей строке
  // Notion (Agent Admin), а не по имени роли. Проектные имена не зашиты.

  const PROVISION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PROVISION_FUNCTIONS = ["Coordinator", "Executor", "Auditor", "Auditory", "Reviewer"];
  const PROVISION_STATES = ["validated", "creating", "repo_selected", "bootstrap_sent", "url_captured",
    "renaming", "renamed", "notion_updated", "activating", "activated", "archiving_old", "done", "paused", "error"];
  const PROVISION_EVENTS = ["provision_request_sent", "provision_approved", "provision_rejected",
    "provision_job_started", "provision_repo_selected", "provision_bootstrap_sent", "provision_url_captured",
    "provision_renamed", "provision_notion_updated", "provision_activated", "provision_activation_blocked",
    "provision_old_archived", "provision_old_archive_unverified", "provision_job_done", "provision_paused",
    "provision_conflict", "provision_noop"];
  const PROVISION_BOOTSTRAP_FORBIDDEN = [
    /CF_[A-Z_]+/i, /notion/i, /cortex/i, /REGULATION/, /WARDEN/i, /DECISIONS/,
    /ntn_[A-Za-z0-9]/, /secret_[A-Za-z0-9]/, /ghp_[A-Za-z0-9]/, /github_pat_[A-Za-z0-9]/,
    /Bearer\s+[A-Za-z0-9]/i, /sk-[A-Za-z0-9]{12}/, /app\.notion|notion\.so|notion\.site/i,
  ];

  const provisionConfig = () => normalizeProvisionConfig(C);
  const provisionBootstrapClean = (text) => {
    const s = String(text || "").trim();
    return s.length > 0 && !PROVISION_BOOTSTRAP_FORBIDDEN.some((re) => re.test(s));
  };

  /** Точный owner/repo: строка или https://github.com/owner/repo(.git). */
  function normalizeProvisionRepo(value) {
    let s = String(value || "").trim();
    if (!s) return "";
    s = s.replace(/^https?:\/\/(?:www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s) || s.includes("..")) return "";
    return s.toLowerCase();
  }

  function provisionState() {
    const raw = GM_getValue(K.provision, null);
    if (raw && typeof raw === "object") {
      return {
        jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
        journal: Array.isArray(raw.journal) ? raw.journal : [],
        daily: raw.daily && typeof raw.daily === "object" ? raw.daily : { date: "", count: 0 },
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    }
    return { jobs: [], journal: [], daily: { date: "", count: 0 }, history: [] };
  }
  const saveProvisionState = (state) => GM_setValue(K.provision, { ...state, updatedAt: nowIso() });
  const provisionRequestState = () => GM_getValue(K.provisionRequest, null);
  const saveProvisionRequest = (request) => GM_setValue(K.provisionRequest, request);
  const provisionLockState = () => GM_getValue(K.provisionLock, null);

  function provisionTabId() {
    try {
      let id = sessionStorage.getItem("cfn-provision-tab-v1");
      if (!id) { id = uid(); sessionStorage.setItem("cfn-provision-tab-v1", id); }
      return id;
    } catch { return "tab"; }
  }
  function provisionAcquireLock(requestId, resumeAuto) {
    GM_setValue(K.provisionLock, { requestId, tabId: provisionTabId(), at: Date.now(), resumeAuto: Boolean(resumeAuto) });
  }
  const provisionReleaseLock = () => GM_setValue(K.provisionLock, null);
  function provisionLockHeldByOther() {
    const lock = provisionLockState();
    return Boolean(lock && lock.tabId && lock.tabId !== provisionTabId());
  }

  /** Событие журнала: без секретов и полных prompt. */
  function provisionEvent(event, fields = {}) {
    const state = provisionState();
    const entry = {
      at: nowIso(), event,
      requestId: String(fields.requestId || ""), jobId: String(fields.jobId || ""),
      rolePageId: String(fields.rolePageId || ""), repo: String(fields.repo || ""),
      step: String(fields.step || ""), reason: String(fields.reason || "").slice(0, 300),
    };
    state.journal = [...state.journal, entry].slice(-200);
    saveProvisionState(state);
    dbg("provision", entry);
    return entry;
  }

  const provisionDay = () => new Date().toISOString().slice(0, 10);
  function provisionDailyAllow(cfg = provisionConfig()) {
    const { daily } = provisionState();
    const day = provisionDay();
    const count = daily.date === day ? Number(daily.count) || 0 : 0;
    return count < cfg.agentProvisionDailyMax;
  }
  function provisionDailyConsume() {
    const state = provisionState();
    const day = provisionDay();
    const count = state.daily.date === day ? Number(state.daily.count) || 0 : 0;
    state.daily = { date: day, count: count + 1 };
    saveProvisionState(state);
  }

  /** Кандидат из свежей строки. Возвращает причину отказа, а не молча пропускает. */
  function provisionCandidateFromRow(row, cfg, busy = {}) {
    if (!row || !row.pageId) return { ok: false, reason: "нет строки роли" };
    if (row.agentAdmin === true) return { ok: false, reason: "админ-роль не provisioning-кандидат" };
    if ((row.agentState || "не требуется") !== "запрошен") return { ok: false, reason: "Agent State не запрошен" };
    const name = String(row.name || "").trim();
    if (!name || name.length > 100) return { ok: false, reason: "имя роли пустое или длиннее 100" };
    if (!PROVISION_FUNCTIONS.includes(row.fn)) return { ok: false, reason: "недопустимая функция" };
    const repo = normalizeProvisionRepo(row.repo);
    if (!repo) return { ok: false, reason: "репозиторий не нормализуется в owner/repo" };
    const allow = (cfg.agentProvisionRepoAllowlist || []).map(normalizeProvisionRepo);
    if (!allow.includes(repo)) return { ok: false, reason: "репозиторий вне allowlist" };
    const busyNames = busy.names || new Set();
    const busyIds = busy.ids || new Set();
    if (busyNames.has(norm(name)) || busyIds.has(norm(row.id)) || busyIds.has(norm(row.pageId))) {
      return { ok: false, reason: "по роли есть активная работа" };
    }
    const url = String(row.url || "").trim();
    const action = url ? "replace" : "create";
    return {
      ok: true,
      candidate: {
        rolePageId: row.pageId, roleName: name, fn: row.fn, repo, action,
        oldAgentUrl: action === "replace" ? url : "",
        roleAgentId: row.id || "",
      },
    };
  }

  function provisionCandidates(rows, cfg, busy = {}) {
    const candidates = [];
    const rejected = [];
    for (const row of rows || []) {
      const result = provisionCandidateFromRow(row, cfg, busy);
      if (result.ok) candidates.push(result.candidate);
      else if ((row?.agentState || "не требуется") === "запрошен" || row?.agentAdmin === true) {
        rejected.push({ rolePageId: row?.pageId || "", reason: result.reason });
      }
    }
    return { candidates: candidates.slice(0, cfg.agentProvisionMaxJobs), rejected };
  }

  /** Активная админ-роль: предпочтительно Coordinator, иначе Reviewer. */
  function provisionAdminRole(rows) {
    const admins = (rows || []).filter((r) => r.agentAdmin === true && r.status === "Активна" &&
      r.url && r.pageId && PROVISION_UUID.test(String(r.pageId)) &&
      (r.fn === "Coordinator" || r.fn === "Reviewer"));
    admins.sort((a, b) => (a.fn === b.fn ? String(a.name).localeCompare(String(b.name)) : a.fn === "Coordinator" ? -1 : 1));
    return admins[0] || null;
  }

  /** Проверка маркера одобрения по свежему Notion и выданным кандидатам. */
  function validateProvisionMarker(obj, request, freshRows, cfg = provisionConfig()) {
    if (!obj || typeof obj !== "object") return { ok: false, reason: "маркер не разобран" };
    for (const banned of ["archive", "delete", "activate", "admin", "command"]) {
      if (banned in obj) return { ok: false, reason: `запрещённая команда маркера: ${banned}` };
    }
    const requestId = String(obj.request_id || "");
    if (!PROVISION_UUID.test(requestId)) return { ok: false, reason: "request_id не UUID" };
    if (norm(requestId) !== norm(request?.requestId || "")) return { ok: false, reason: "чужой request_id" };
    if (!Array.isArray(obj.jobs)) return { ok: false, reason: "jobs не массив" };
    if (obj.jobs.length > cfg.agentProvisionMaxJobs) return { ok: false, reason: "jobs больше agentProvisionMaxJobs" };
    const sent = new Map((request?.candidates || []).map((c) => [norm(c.rolePageId), c]));
    const fresh = new Map((freshRows || []).map((r) => [norm(r.pageId), r]));
    const jobs = [];
    for (const job of obj.jobs) {
      if (!job || typeof job !== "object") return { ok: false, reason: "job не объект" };
      for (const banned of ["archive", "delete", "activate", "admin", "command"]) {
        if (banned in job) return { ok: false, reason: `запрещённая команда в job: ${banned}` };
      }
      const pageId = String(job.role_page_id || "");
      if (!PROVISION_UUID.test(pageId)) return { ok: false, reason: "role_page_id не UUID" };
      const candidate = sent.get(norm(pageId));
      if (!candidate) return { ok: false, reason: "job вне кандидатов, отправленных в prompt" };
      if (!["create", "replace"].includes(job.action)) return { ok: false, reason: "action только create или replace" };
      const row = fresh.get(norm(pageId));
      if (!row) return { ok: false, reason: "строка роли исчезла" };
      if (row.agentAdmin === true) return { ok: false, reason: "попытка одобрить админ-роль" };
      if (String(row.name || "").trim() !== String(job.role_name || "").trim()) return { ok: false, reason: "role_name не совпадает со свежей строкой" };
      const repo = normalizeProvisionRepo(row.repo);
      if (!repo || repo !== normalizeProvisionRepo(job.repo)) return { ok: false, reason: "repo не совпадает со свежей строкой" };
      const allow = (cfg.agentProvisionRepoAllowlist || []).map(normalizeProvisionRepo);
      if (!allow.includes(repo)) return { ok: false, reason: "repo вне allowlist" };
      const freshAction = String(row.url || "").trim() ? "replace" : "create";
      if (job.action !== freshAction || job.action !== candidate.action) return { ok: false, reason: "action не совпадает с текущим Agent URL" };
      jobs.push({
        rolePageId: row.pageId, roleName: String(row.name).trim(), fn: row.fn, repo,
        action: job.action, oldAgentUrl: freshAction === "replace" ? String(row.url).trim() : "",
        roleAgentId: row.id || "",
      });
    }
    return { ok: true, jobs, reason: String(obj.reason || "").slice(0, 300) };
  }

  function provisionNewJob(candidate, requestId) {
    const at = nowIso();
    return {
      id: uid(), requestId, rolePageId: candidate.rolePageId, roleName: candidate.roleName,
      fn: candidate.fn, repo: candidate.repo, action: candidate.action,
      oldAgentUrl: candidate.oldAgentUrl || "", state: "validated", agentUrl: "",
      bootstrapMsgId: "", attempts: 0, createdAt: at, updatedAt: at, error: "",
    };
  }
  const provisionJobIndex = (state, job) => state.jobs.findIndex((j) => norm(j.id) === norm(job.id));
  function provisionSaveJob(job) {
    const state = provisionState();
    const next = { ...job, updatedAt: nowIso() };
    const at = provisionJobIndex(state, next);
    if (at === -1) state.jobs.push(next);
    else state.jobs[at] = next;
    state.jobs = state.jobs.slice(-100);
    saveProvisionState(state);
    return next;
  }
  function provisionActiveJob() {
    const request = provisionRequestState();
    if (!request || !Array.isArray(request.jobIds)) return null;
    const state = provisionState();
    for (const id of request.jobIds) {
      const job = state.jobs.find((j) => norm(j.id) === norm(id));
      if (job && !["done", "error"].includes(job.state)) return job;
    }
    return null;
  }

  // ───────────────────────── provisioning: DOM Arena ─────────────────────────
  // Селекторы не используют radix-* id и nth-child. Неоднозначность — ошибка,
  // а не выбор «первого подходящего». Add repositories и Archive нового агента
  // не нажимаются. Rename/Archive работают только через видимые пункты меню.

  const PROVISION_SEL = Object.freeze({
    repoTrigger: 'main button[aria-haspopup="dialog"][aria-controls]',
    picker: '[data-radix-popper-content-wrapper] [role="dialog"][data-state="open"] [cmdk-root]',
    pickerInput: '[cmdk-input][role="combobox"]',
    pickerList: '[cmdk-list][role="listbox"]',
    pickerItem: '[cmdk-item][role="option"]',
    sidebarRoot: '[data-sidebar="sidebar"], [data-slot="sidebar"]',
    sidebarItem: 'a[data-sidebar="menu-button"][href]',
    menuAction: 'button[data-sidebar="menu-action"][aria-haspopup="menu"]',
    openMenu: '[role="menu"][data-state="open"]',
    menuItem: '[role="menuitem"]',
    dialog: '[role="dialog"][data-state="open"]',
    renameInput: 'input[maxlength="100"]',
  });
  const PROVISION_EXCLUDE = '#cfn-panel, [id^="cfn-"], [data-sidebar="sidebar"], [data-slot="sidebar"], aside, nav';

  class ProvisionDomError extends Error {
    constructor(code, message) { super(message || code); this.code = code; }
  }
  const provisionDomFail = (code, message) => { throw new ProvisionDomError(code, message); };
  const provisionAll = (root, selector) => [...(root || document).querySelectorAll(selector)];
  const provisionVisible = (root, selector) => provisionAll(root, selector).filter((el) => visible(el));
  function provisionOne(root, selector, code) {
    const found = provisionVisible(root, selector);
    if (found.length !== 1) provisionDomFail(code, `${selector}: найдено ${found.length}, ожидался 1`);
    return found[0];
  }
  const provisionText = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

  function provisionAgentUuid(value) {
    try {
      const url = new URL(String(value || ""), location.origin);
      if (url.origin !== location.origin) return "";
      const m = url.pathname.match(/^\/agent\/([0-9a-f-]{36})\/?$/i);
      return m && PROVISION_UUID.test(m[1]) ? m[1].toLowerCase() : "";
    } catch { return ""; }
  }
  const provisionCurrentAgentUuid = () => provisionAgentUuid(location.pathname + location.search + location.hash);

  async function provisionWait(check, timeoutMs, stepMs = 300) {
    const until = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() >= until) return null;
      await sleep(stepMs);
    }
  }
  function provisionSetInput(el, value) {
    const proto = typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function provisionRepoTriggers() {
    const main = document.querySelector("main") || document;
    return provisionVisible(main, PROVISION_SEL.repoTrigger).filter((el) => {
      if (el.closest(PROVISION_EXCLUDE)) return false;
      const spans = provisionAll(el, "span").map((s) => normalizeProvisionRepo(provisionText(s))).filter(Boolean);
      return spans.length > 0 || /select a repository/i.test(provisionText(el));
    });
  }
  function provisionTriggerRepo(trigger) {
    for (const span of provisionAll(trigger, "span")) {
      const repo = normalizeProvisionRepo(provisionText(span));
      if (repo) return repo;
    }
    return "";
  }
  function provisionPicker() {
    const found = provisionVisible(document, PROVISION_SEL.picker);
    if (found.length > 1) provisionDomFail("provision_picker_ambiguous", "открыто несколько repo picker");
    return found[0] || null;
  }
  function provisionRepoOption(picker, repo) {
    const list = provisionOne(picker, PROVISION_SEL.pickerList, "provision_picker_list_missing");
    const items = provisionVisible(list, PROVISION_SEL.pickerItem).filter((item) => {
      const dv = normalizeProvisionRepo(item.getAttribute("data-value"));
      if (dv && dv !== repo) return false;
      return provisionAll(item, "span").some((s) => normalizeProvisionRepo(provisionText(s)) === repo);
    });
    if (items.length !== 1) provisionDomFail("provision_repo_option_missing", `repo ${repo}: options ${items.length}`);
    return items[0];
  }
  function provisionComposerReady() {
    const editor = typeof composer === "function" ? composer() : null;
    if (!editor) return false;
    return typeof sendButton === "function" ? Boolean(sendButton(editor)) : true;
  }

  /** Выбирает repo в composer. Уже выбранный repo не кликается повторно. */
  async function provisionSelectRepository(repo, cfg = provisionConfig()) {
    const target = normalizeProvisionRepo(repo);
    if (!target) provisionDomFail("provision_repo_invalid", "repo не нормализуется");
    const triggers = provisionRepoTriggers();
    if (triggers.length !== 1) provisionDomFail("provision_repo_trigger_ambiguous", `repo triggers: ${triggers.length}`);
    const trigger = triggers[0];
    if (provisionTriggerRepo(trigger) === target) return { alreadySelected: true, attempts: 0 };
    let attempts = 0;
    while (attempts < 2) {
      attempts += 1;
      trigger.click();
      const picker = await provisionWait(() => provisionPicker(), 5000);
      if (!picker) continue;
      const input = provisionOne(picker, PROVISION_SEL.pickerInput, "provision_picker_input_missing");
      provisionSetInput(input, target);
      const option = await provisionWait(() => {
        try { return provisionRepoOption(picker, target); } catch { return null; }
      }, 5000);
      if (!option) continue;
      option.click();
      const closed = await provisionWait(() => !provisionPicker(), 5000);
      const updated = await provisionWait(() => provisionTriggerRepo(trigger) === target, 5000);
      const ready = await provisionWait(provisionComposerReady, 8000);
      if (closed && updated && ready) return { alreadySelected: false, attempts };
    }
    provisionDomFail("provision_repo_select_failed", `repo ${target} не выбран за ${attempts} попытки`);
  }

  function provisionSidebarRoot() {
    const roots = provisionVisible(document, PROVISION_SEL.sidebarRoot);
    if (roots.length !== 1) provisionDomFail("provision_sidebar_ambiguous", `sidebar roots: ${roots.length}`);
    return roots[0];
  }
  function provisionSidebarItems(root = provisionSidebarRoot()) {
    return provisionAll(root, PROVISION_SEL.sidebarItem).map((item) => ({
      item, uuid: provisionAgentUuid(item.getAttribute("href")),
    })).filter((x) => x.uuid);
  }
  function provisionFindSidebarItem(agentUuid) {
    const id = String(agentUuid || "").toLowerCase();
    return provisionSidebarItems().find((x) => x.uuid === id)?.item || null;
  }
  async function provisionWaitSidebarItem(agentUuid, timeoutMs = 8000) {
    return provisionWait(() => provisionFindSidebarItem(agentUuid), timeoutMs);
  }
  function provisionMenuItemContainer(item) {
    return item.closest('[data-sidebar="menu-item"]') || item.parentElement || item;
  }
  async function provisionOpenItemMenu(item) {
    const holder = provisionMenuItemContainer(item);
    const action = provisionOne(holder, PROVISION_SEL.menuAction, "provision_menu_action_missing");
    action.click();
    const menu = await provisionWait(() => {
      const found = provisionVisible(document, PROVISION_SEL.openMenu);
      return found.length === 1 ? found[0] : null;
    }, 5000);
    if (!menu) provisionDomFail("provision_menu_missing", "More options меню не открылось");
    return menu;
  }
  function provisionMenuButton(menu, label) {
    const wanted = String(label).toLowerCase();
    const found = provisionVisible(menu, PROVISION_SEL.menuItem).filter((el) => provisionText(el).toLowerCase() === wanted);
    if (found.length !== 1) provisionDomFail("provision_menu_item_missing", `${label}: найдено ${found.length}`);
    return found[0];
  }
  function provisionRenameDialog() {
    const dialogs = provisionVisible(document, PROVISION_SEL.dialog).filter((d) =>
      /rename chat/i.test(provisionText(d)) && provisionAll(d, PROVISION_SEL.renameInput).length === 1);
    if (dialogs.length !== 1) provisionDomFail("provision_rename_dialog_missing", `Rename chat dialogs: ${dialogs.length}`);
    return dialogs[0];
  }
  function provisionRenameSubmit(dialog) {
    const found = provisionVisible(dialog, 'button[type="submit"]').filter((b) => /^rename$/i.test(provisionText(b)));
    if (found.length !== 1) provisionDomFail("provision_rename_submit_missing", `Rename submit: ${found.length}`);
    return found[0];
  }
  const provisionEnabled = (el) => Boolean(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && el.getAttribute("data-disabled") !== "true";

  /** Rename сессии в имя роли. Тост не является условием успеха. */
  async function provisionRenameAgent(agentUuid, roleName, cfg = provisionConfig()) {
    const name = String(roleName || "").trim();
    if (!name || name.length > 100) provisionDomFail("provision_rename_name_invalid", "имя роли пустое или >100");
    let attempts = 0;
    while (attempts < cfg.agentRenameAttempts) {
      attempts += 1;
      const item = provisionFindSidebarItem(agentUuid);
      if (!item) provisionDomFail("provision_sidebar_item_missing", "sidebar item для rename не найден");
      const menu = await provisionOpenItemMenu(item);
      provisionMenuButton(menu, "Rename").click();
      const dialog = await provisionWait(() => {
        try { return provisionRenameDialog(); } catch { return null; }
      }, 5000);
      if (!dialog) continue;
      const input = provisionOne(dialog, PROVISION_SEL.renameInput, "provision_rename_input_missing");
      provisionSetInput(input, name);
      const submit = await provisionWait(() => {
        const button = provisionRenameSubmit(dialog);
        return provisionEnabled(button) ? button : null;
      }, 5000);
      if (!submit) continue;
      submit.click();
      const closed = await provisionWait(() => {
        try { provisionRenameDialog(); return false; } catch { return true; }
      }, 5000);
      const renamed = await provisionWait(() => {
        const live = provisionFindSidebarItem(agentUuid);
        return live && provisionText(live) === name ? live : null;
      }, 8000);
      if (closed && renamed) return { attempts };
    }
    provisionDomFail("provision_rename_failed", `rename не подтверждён за ${attempts} попытки`);
  }

  /**
   * Архив старого агента. Возвращает unverified, если пункт не найден или
   * исчезновение не подтвердилось; это не откатывает успешную замену.
   */
  async function provisionArchiveAgent(agentUuid, timeoutMs = 8000) {
    const item = provisionFindSidebarItem(agentUuid);
    if (!item) return { archived: false, unverified: true, reason: "sidebar item не найден" };
    let menu;
    try { menu = await provisionOpenItemMenu(item); }
    catch (error) { return { archived: false, unverified: true, reason: error.message }; }
    let archive;
    try { archive = provisionMenuButton(menu, "Archive"); }
    catch (error) { return { archived: false, unverified: true, reason: error.message }; }
    archive.click();
    const gone = await provisionWait(() => !provisionFindSidebarItem(agentUuid), timeoutMs);
    if (gone) return { archived: true, unverified: false };
    return { archived: false, unverified: true, reason: "признак архивации не подтверждён" };
  }

  // ───────────────────────── provisioning: запрос → одобрение → job ─────────────────────────
  // Контур не пишет K.pending/K.expect и не создаёт страницы Notion. Запрос
  // уходит админ-роли напрямую; создание начинается только после маркера
  // CF_AGENT_PROVISION_RESULT с выданным request_id.

  let provisionRunning = false;

  function provisionLog(text, error = false, options = {}) {
    log(text, error, { ntfy: "quiet", title: "Relay: provisioning", ...options });
  }
  function provisionPause(reason, request, job, extra = {}) {
    const fields = {
      requestId: request?.requestId || "", jobId: job?.id || "",
      rolePageId: job?.rolePageId || "", repo: job?.repo || "",
      step: job?.state || request?.state || "", reason,
    };
    provisionEvent(extra.event || "provision_paused", fields);
    if (job) {
      job.state = extra.jobState || "paused";
      job.error = reason;
      provisionSaveJob(job);
    }
    if (request) {
      request.state = "paused";
      request.error = reason;
      saveProvisionRequest(request);
    }
    autoSet(false);
    pause(reason, { kind: "provision", ref: job?.rolePageId || request?.requestId || "", ...extra.pause });
    return true;
  }

  async function provisionFreshRole(pageId) {
    try {
      const page = await notion("GET", `pages/${pageId}`);
      return page && !page.archived ? mapRoleRow(page) : null;
    } catch (error) {
      if (/404|object_not_found|не найден/i.test(String(error?.message || error))) return null;
      throw error;
    }
  }

  async function provisionBusyContext() {
    const names = new Set();
    const ids = new Set();
    const cards = await query(C.requests, {
      or: [
        { property: "Dispatch State", select: { equals: "Running" } },
        { property: "Dispatch State", select: { equals: "Submitted" } },
      ],
    });
    for (const card of cards) {
      const name = taskRole(card);
      if (name) names.add(norm(name));
      const recipient = rt(card.properties?.["Recipient Agent ID"]);
      if (recipient) ids.add(norm(recipient));
    }
    const pending = GM_getValue(K.pending, null);
    const expect = GM_getValue(K.expect, null);
    for (const turn of [pending, expect]) {
      if (!turn) continue;
      if (turn.roleName) names.add(norm(turn.roleName));
      if (turn.roleId) ids.add(norm(turn.roleId));
      if (turn.ref) ids.add(norm(turn.ref));
    }
    return { names, ids, cards };
  }

  function provisionIdleReason(cfg = provisionConfig()) {
    if (!cfg.agentProvisionEnabled) return "provisioning выключен";
    if (!C.notion) return "нет Notion-токена профиля";
    if (GM_getValue(K.paused, "")) return "цикл на паузе";
    if (GM_getValue(K.pending, null) || GM_getValue(K.expect, null)) return "активный командный ход";
    if (GM_getValue(K.pilotWait, null)) return "идёт пилот";
    if (provisionRequestState()) return "provisioning-запрос уже выдан";
    if (provisionLockHeldByOther()) return "provisioning занят другой вкладкой";
    if (!provisionBootstrapClean(cfg.agentBootstrapPrompt)) return "bootstrap-пробник пуст или запрещён";
    if (!provisionDailyAllow(cfg)) return "суточный лимит provisioning";
    return "";
  }

  async function provisionGather(cfg = provisionConfig()) {
    const rows = await rolesFresh();
    const busy = await provisionBusyContext();
    const { candidates, rejected } = provisionCandidates(rows, cfg, busy);
    const admin = provisionAdminRole(rows);
    return { rows, busy, candidates, rejected, admin };
  }

  /** Выдать запрос админ-роли. Вызывается кнопкой или холостым автоциклом. */
  async function provisionStartRequest({ auto = false } = {}) {
    const cfg = provisionConfig();
    const why = provisionIdleReason(cfg);
    if (why) { provisionLog(`Запрос не выдан: ${why}.`); return false; }
    const { candidates, rejected, admin } = await provisionGather(cfg);
    for (const item of rejected) provisionEvent("provision_noop", { rolePageId: item.rolePageId, reason: item.reason });
    if (!admin) {
      pause("Provisioning: нет активной админ-роли (Agent Admin=true, Coordinator/Reviewer). Создайте или включите админ-роль вручную.", { kind: "provision-no-admin" });
      provisionEvent("provision_paused", { reason: "provision-no-admin" });
      return false;
    }
    if (!candidates.length) { provisionEvent("provision_noop", { reason: "нет кандидатов" }); return false; }
    const requestId = uid();
    const request = {
      requestId, state: "prepared", auto, resumeAuto: autoOn(),
      adminPageId: admin.pageId, adminAgentId: admin.id, adminRoleName: admin.name,
      adminFn: admin.fn, adminUrl: admin.url, candidates,
      jobIds: [], createdAt: nowIso(), updatedAt: nowIso(), watermark: "", seen: [],
    };
    saveProvisionRequest(request);
    provisionAcquireLock(requestId, request.resumeAuto);
    autoSet(false);
    provisionLog(`Provisioning: запрос ${requestId} подготовлен для админ-роли «${admin.name}», кандидатов ${candidates.length}.`);
    if (provisionCurrentAgentUuid() !== String(admin.id).toLowerCase()) {
      location.assign(admin.url);
      return true;
    }
    return provisionSendRequest(request);
  }

  async function provisionSendRequest(request) {
    const cfg = provisionConfig();
    const admin = await provisionFreshRole(request.adminPageId);
    if (!admin || admin.agentAdmin !== true || admin.status !== "Активна") {
      return provisionPause("Provisioning: адресат запроса больше не активная админ-роль.", request, null);
    }
    if (provisionCurrentAgentUuid() !== String(admin.id).toLowerCase()) { location.assign(admin.url); return true; }
    const compiled = PromptCompiler.compile({
      kind: "provision", role: { fn: request.adminFn, name: request.adminRoleName },
      provision: { requestId: request.requestId, candidates: request.candidates, maxJobs: cfg.agentProvisionMaxJobs },
      delivery: { tier: "full" },
    });
    if (!compiled.ok) return provisionPause(`Provisioning prompt не собран: ${compiled.error?.message || compiled.error?.code}`, request, null);
    const ready = await ensureComposer(C.pageWaitMs);
    if (!ready?.editor) return provisionPause("Provisioning: поле ввода админ-роли не появилось.", request, null);
    if (!writePrompt(ready.editor, compiled.text)) return provisionPause("Provisioning: не удалось вставить запрос админ-роли.", request, null);
    request.watermark = lastMessageId();
    request.seen = messages().map(nodeId);
    request.state = "sending";
    saveProvisionRequest(request);
    const sent = await deliver(ready.editor, compiled.text);
    if (!sent?.ok) return provisionPause("Provisioning: запрос админ-роли не доставлен.", request, null);
    request.state = "awaiting";
    request.sentAt = nowIso();
    saveProvisionRequest(request);
    provisionEvent("provision_request_sent", { requestId: request.requestId, rolePageId: request.adminPageId, step: "awaiting" });
    provisionLog(`Provisioning: запрос ${request.requestId} отправлен админ-роли «${request.adminRoleName}». Жду маркер одобрения.`);
    return true;
  }

  async function provisionConsumeApproval(request) {
    const cfg = provisionConfig();
    if (provisionCurrentAgentUuid() !== String(request.adminAgentId).toLowerCase()) { location.assign(request.adminUrl); return true; }
    if (captchaDialog()) return provisionPause("Provisioning: капча на странице админ-роли.", request, null);
    if (detectToolCallLimit()) return provisionPause("Provisioning: tool-call limit у админ-роли; продолжение запроса не поддерживается.", request, null);
    const visibleError = detectVisibleErrorCard();
    if (visibleError) return provisionPause(`Provisioning: ошибка Arena у админ-роли: ${visibleError.text || visibleError}`, request, null);
    const admin = await provisionFreshRole(request.adminPageId);
    if (!admin || admin.agentAdmin !== true || admin.status !== "Активна") {
      return provisionPause("Provisioning: право одобрения потеряно (Agent Admin/Статус изменились).", request, null);
    }
    const replies = messagesAfter(request.watermark, request.seen);
    const hit = replies.map((m) => ({ m, obj: parseMarker(m.raw, "CF_AGENT_PROVISION_RESULT") })).filter((x) => x.obj).at(-1);
    if (!hit) return true; // ждём ответ админ-роли, автоцикл выключен
    const fresh = await rolesFresh();
    const verdict = validateProvisionMarker(hit.obj, request, fresh, cfg);
    if (!verdict.ok) {
      provisionEvent("provision_rejected", { requestId: request.requestId, reason: verdict.reason });
      return provisionPause(`Provisioning: маркер одобрения отклонён — ${verdict.reason}.`, request, null);
    }
    request.state = "approved";
    request.approvedAt = nowIso();
    request.approvalReason = verdict.reason;
    request.approvedJobs = verdict.jobs;
    saveProvisionRequest(request);
    provisionEvent("provision_approved", { requestId: request.requestId, rolePageId: request.adminPageId, reason: verdict.reason || `jobs ${verdict.jobs.length}` });
    provisionLog(`Provisioning: одобрено jobs ${verdict.jobs.length}.`);
    if (!verdict.jobs.length) return provisionFinishRequest(request, "одобрено 0 jobs");
    return true;
  }

  async function provisionEnsureRecipientOption(roleName) {
    const ds = await notion("GET", `data_sources/${C.requests}`);
    const prop = ds?.properties?.["Кому"];
    if (!prop || prop.type !== "select") throw new Error("в «Запросах» нет select-поля «Кому»");
    const options = Array.isArray(prop.select?.options) ? prop.select.options : [];
    if (options.some((o) => norm(o.name) === norm(roleName))) return true;
    const next = [...options.map((o) => ({ id: o.id, name: o.name, color: o.color })), { name: roleName }];
    await notion("PATCH", `data_sources/${C.requests}`, { properties: { "Кому": { select: { options: next } } } });
    return true;
  }

  async function provisionActivationBlockReason(job, cfg) {
    const rows = await rolesFresh();
    const row = rows.find((r) => norm(r.pageId) === norm(job.rolePageId));
    if (!row) return "строка роли исчезла";
    if (row.agentAdmin === true) return "админ-роль не активируется provisioning";
    if (norm(row.url) !== norm(job.agentUrl)) return "Agent URL в Notion не равен новому";
    if (normalizeProvisionRepo(row.repo) !== job.repo) return "repo роли изменился";
    const item = provisionFindSidebarItem(provisionAgentUuid(job.agentUrl));
    if (!item || provisionText(item) !== job.roleName) return "имя sidebar не равно роли";
    const busy = await provisionBusyContext();
    if (busy.names.has(norm(job.roleName)) || busy.ids.has(norm(job.roleAgentId)) || busy.ids.has(norm(job.rolePageId))) {
      return "по роли есть активная работа";
    }
    const active = rows.filter((r) => r.status === "Активна" && r.url);
    if (job.fn === "Coordinator" && active.some((r) => r.fn === "Coordinator" && norm(r.pageId) !== norm(job.rolePageId))) {
      return "уже есть активный Coordinator";
    }
    const reviewers = active.filter((r) => r.fn === "Reviewer" && norm(r.pageId) !== norm(job.rolePageId));
    if (!reviewers.length && job.fn !== "Reviewer") return "не остаётся активного Reviewer";
    if (["Executor", "Auditor", "Auditory"].includes(job.fn)) {
      try { await provisionEnsureRecipientOption(job.roleName); }
      catch (error) { return `не удалось добавить «Кому»: ${error.message}`; }
    }
    return "";
  }

  async function provisionPatchNotion(job, request) {
    const row = await provisionFreshRole(job.rolePageId);
    if (!row) return provisionPause("Provisioning: строка роли исчезла до записи Notion.", request, job, { event: "provision_conflict" });
    if (row.agentAdmin === true) return provisionPause("Provisioning: попытка записать админ-роль.", request, job, { event: "provision_conflict" });
    const currentUrl = String(row.url || "").trim();
    const newUrl = job.agentUrl;
    if (currentUrl && norm(currentUrl) !== norm(newUrl) && norm(currentUrl) !== norm(job.oldAgentUrl)) {
      return provisionPause("Provisioning: Agent URL уже изменён другим процессом (conflict).", request, job, { event: "provision_conflict" });
    }
    if (row.status === "Активна" && currentUrl && norm(currentUrl) !== norm(newUrl)) {
      return provisionPause("Provisioning: роль уже активна с другим Agent URL.", request, job, { event: "provision_conflict" });
    }
    if (row.agentState === "не требуется") {
      return provisionPause("Provisioning: Agent State больше не запрошен.", request, job, { event: "provision_conflict" });
    }
    const alreadyUrl = norm(currentUrl) === norm(newUrl);
    const props = {
      "Agent State": { select: { name: "создан" } },
      "Agent Job ID": { rich_text: richText(job.id) },
      "Agent Created At": { date: { start: nowIso() } },
    };
    if (!alreadyUrl) props["Agent URL"] = { url: newUrl };
    if (job.action === "replace" && job.oldAgentUrl) props["Previous Agent URL"] = { url: job.oldAgentUrl };
    if (!(row.status === "Активна" && alreadyUrl)) await patch(job.rolePageId, props);
    provisionEvent("provision_notion_updated", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "notion_updated" });
    job.state = "notion_updated";
    provisionSaveJob(job);
    return false;
  }

  async function provisionArchiveOld(job, request) {
    const cfg = provisionConfig();
    if (job.action !== "replace" || !cfg.agentProvisionArchiveOld || !job.oldAgentUrl) {
      job.state = "done"; provisionSaveJob(job);
      provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
      return false;
    }
    const oldUuid = provisionAgentUuid(job.oldAgentUrl);
    const newUuid = provisionAgentUuid(job.agentUrl);
    if (!oldUuid || oldUuid === newUuid) {
      return provisionPause("Provisioning: старый Agent URL не отличим от нового; архив не выполняется.", request, job, { event: "provision_conflict" });
    }
    if (provisionCurrentAgentUuid() !== oldUuid) {
      job.state = "archiving_old"; provisionSaveJob(job);
      location.assign(job.oldAgentUrl);
      return true;
    }
    job.state = "archiving_old"; provisionSaveJob(job);
    const result = await provisionArchiveAgent(oldUuid);
    if (result.archived) {
      provisionEvent("provision_old_archived", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "archiving_old" });
    } else {
      provisionEvent("provision_old_archive_unverified", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "archiving_old", reason: result.reason });
      provisionLog(`Provisioning: архив старого агента не подтверждён (${result.reason}). Замена не откатывается; проверьте старый чат вручную.`, true, { ntfy: "normal" });
    }
    job.state = "done"; provisionSaveJob(job);
    provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
    return false;
  }

  async function provisionAdvanceJob(job, request) {
    const cfg = provisionConfig();
    const uuid = provisionAgentUuid(job.agentUrl);
    if (captchaDialog()) return provisionPause("Provisioning: капча Arena.", request, job);
    if (detectToolCallLimit()) return provisionPause("Provisioning: tool-call limit на bootstrap; продолжение не поддерживается.", request, job);
    const visibleError = detectVisibleErrorCard();
    if (visibleError) return provisionPause(`Provisioning: ошибка Arena: ${visibleError.text || visibleError}`, request, job);

    if (["validated", "creating"].includes(job.state)) {
      if (GM_getValue(K.pending, null) || GM_getValue(K.expect, null)) {
        return provisionPause("Provisioning: появился активный командный ход; создание не начинаю.", request, job);
      }
      if (!provisionDailyAllow(cfg)) return provisionPause("Provisioning: суточный лимит создания агентов.", request, job);
      if (!provisionBootstrapClean(cfg.agentBootstrapPrompt)) return provisionPause("Provisioning: bootstrap-пробник пуст или запрещён.", request, job);
      const row = await provisionFreshRole(job.rolePageId);
      if (!row || row.agentAdmin === true || !["запрошен", "создаётся"].includes(row.agentState)) {
        return provisionPause("Provisioning: строка роли изменилась до создания.", request, job, { event: "provision_conflict" });
      }
      if (provisionCurrentAgentUuid()) {
        // Новая сессия создаётся только с /agent. Если вкладка уже в чужом
        // чате, не переиспользуем его и не архивируем.
        job.state = "creating"; provisionSaveJob(job);
        location.assign(location.origin + "/agent");
        return true;
      }
      job.state = "creating"; provisionSaveJob(job);
      const selected = await provisionSelectRepository(job.repo, cfg);
      provisionEvent("provision_repo_selected", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "repo_selected", reason: selected.alreadySelected ? "already" : `attempts ${selected.attempts}` });
      job.state = "repo_selected"; provisionSaveJob(job);
    }

    if (job.state === "repo_selected") {
      const ready = await ensureComposer(C.pageWaitMs);
      if (!ready?.editor) return provisionPause("Provisioning: composer новой сессии не появился.", request, job);
      if (!writePrompt(ready.editor, cfg.agentBootstrapPrompt)) return provisionPause("Provisioning: bootstrap-пробник не вставлен.", request, job);
      job.bootstrapMsgId = lastMessageId();
      job.bootstrapSeen = messages().map(nodeId);
      job.bootstrapStartedAt = Date.now();
      job.urlWaitStartedAt = Date.now();
      job.state = "bootstrap_sent";
      provisionSaveJob(job); // до deliver: перезагрузка не должна создать вторую сессию
      const sent = await deliver(ready.editor, cfg.agentBootstrapPrompt);
      if (!sent?.ok) return provisionPause("Provisioning: bootstrap-пробник не доставлен.", request, job);
      provisionEvent("provision_bootstrap_sent", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "bootstrap_sent" });
    }

    if (job.state === "bootstrap_sent") {
      if (!job.agentUrl) {
        const current = provisionCurrentAgentUuid();
        if (current) {
          job.agentUrl = `${location.origin}/agent/${current}`;
          job.state = "url_captured";
          job.urlCapturedAt = Date.now();
          provisionSaveJob(job); // URL сохраняется до rename/Notion
          provisionEvent("provision_url_captured", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "url_captured" });
        } else {
          if (Date.now() - Number(job.urlWaitStartedAt || Date.now()) > cfg.agentUrlWaitMs) {
            return provisionPause("Provisioning: URL новой сессии не появился за agentUrlWaitMs.", request, job);
          }
          return true;
        }
      } else {
        // Восстановление после перезагрузки: URL уже захвачен, вторую сессию
        // не создаём и bootstrap повторно не отправляем.
        job.state = "url_captured";
        provisionSaveJob(job);
      }
    }

    if (job.state === "url_captured") {
      if (provisionCurrentAgentUuid() !== provisionAgentUuid(job.agentUrl)) { location.assign(job.agentUrl); return true; }
      const waited = Date.now() - Number(job.bootstrapStartedAt || Date.now());
      if (waited > cfg.agentBootstrapWaitMs) return provisionPause("Provisioning: bootstrap не завершился за agentBootstrapWaitMs.", request, job);
      if (stillWorking()) return true;
      const replies = messagesAfter(job.bootstrapMsgId, job.bootstrapSeen || []);
      if (!replies.length) return true; // смысл ответа не проверяем, нужен факт нового assistant
      job.state = "renaming"; provisionSaveJob(job);
    }

    if (job.state === "renaming") {
      try {
        await provisionRenameAgent(provisionAgentUuid(job.agentUrl), job.roleName, cfg);
      } catch (error) {
        return provisionPause(`Provisioning: rename не удался (${error.message}). URL сохранён, новая сессия не создаётся.`, request, job, { jobState: "paused" });
      }
      provisionEvent("provision_renamed", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "renamed" });
      job.state = "renamed"; provisionSaveJob(job);
    }

    if (job.state === "renamed") {
      const paused = await provisionPatchNotion(job, request);
      if (paused) return true;
    }

    if (job.state === "notion_updated") {
      if (!cfg.agentProvisionAutoActivate) {
        provisionEvent("provision_activation_blocked", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activating", reason: "autoActivate выключен" });
        job.state = "done"; provisionSaveJob(job);
        provisionEvent("provision_job_done", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "done" });
        return false;
      }
      job.state = "activating"; provisionSaveJob(job);
      const block = await provisionActivationBlockReason(job, cfg);
      if (block) {
        provisionEvent("provision_activation_blocked", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activating", reason: block });
        return provisionPause(`Provisioning: автоактивация заблокирована — ${block}. URL записан, Статус остаётся прежним.`, request, job, { jobState: "paused" });
      }
      const freshRow = await provisionFreshRole(job.rolePageId);
      if (!freshRow || freshRow.status !== "Активна") {
        await patch(job.rolePageId, { "Статус": { select: { name: "Активна" } } });
      }
      provisionEvent("provision_activated", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "activated" });
      job.state = "activated"; provisionSaveJob(job);
    }

    if (job.state === "activated") {
      return provisionArchiveOld(job, request);
    }
    if (job.state === "archiving_old") {
      return provisionArchiveOld(job, request);
    }
    if (job.state === "done") return false;
    return true;
  }

  async function provisionRunNextJob(request) {
    const state = provisionState();
    const active = provisionActiveJob();
    if (active) return provisionAdvanceJob(active, request);
    const nextCandidate = (request.approvedJobs || []).find((c) =>
      !state.jobs.some((j) => norm(j.requestId) === norm(request.requestId) && norm(j.rolePageId) === norm(c.rolePageId) && j.state === "done"));
    if (!nextCandidate) return provisionFinishRequest(request, "все jobs завершены");
    const existing = state.jobs.find((j) => norm(j.requestId) === norm(request.requestId) && norm(j.rolePageId) === norm(nextCandidate.rolePageId));
    let job = existing;
    if (!job) {
      if (!provisionDailyAllow()) return provisionPause("Provisioning: суточный лимит создания агентов.", request, null);
      job = provisionNewJob(nextCandidate, request.requestId);
      provisionSaveJob(job);
      request.jobIds = [...(request.jobIds || []), job.id];
      saveProvisionRequest(request);
      provisionDailyConsume();
      provisionEvent("provision_job_started", { requestId: request.requestId, jobId: job.id, rolePageId: job.rolePageId, repo: job.repo, step: "validated" });
      provisionLog(`Provisioning: job ${job.id} — ${job.action} «${job.roleName}» (${job.repo}).`);
    }
    return provisionAdvanceJob(job, request);
  }

  async function provisionFinishRequest(request, reason) {
    provisionEvent("provision_job_done", { requestId: request.requestId, step: "request", reason });
    const state = provisionState();
    state.history = [...state.history, { requestId: request.requestId, at: nowIso(), reason, jobs: request.jobIds || [] }].slice(-50);
    saveProvisionState(state);
    const resume = request.resumeAuto === true && !GM_getValue(K.paused, "");
    saveProvisionRequest(null);
    provisionReleaseLock();
    if (resume) autoSet(true);
    provisionLog(`Provisioning: запрос ${request.requestId} завершён (${reason}). Автоцикл ${resume ? "восстановлен" : "остаётся выключенным"}.`);
    return false;
  }

  /** Ранний вход tick. Не трогает K.pending/K.expect. */
  async function consumeProvision() {
    if (provisionRunning) return true;
    const cfg = provisionConfig();
    if (!cfg.agentProvisionEnabled) return false;
    if (provisionLockHeldByOther()) return Boolean(provisionRequestState());
    const request = provisionRequestState();
    provisionRunning = true;
    try {
      if (!request) {
        if (cfg.agentProvisionMode !== "auto" || !autoOn()) return false;
        const why = provisionIdleReason(cfg);
        if (why) return false;
        return await provisionStartRequest({ auto: true });
      }
      if (request.state === "prepared") return await provisionSendRequest(request);
      if (request.state === "sending") {
        return provisionPause("Provisioning: отправка запроса прервана; повторять запрос без проверки Мастера нельзя.", request, null);
      }
      if (request.state === "awaiting") return await provisionConsumeApproval(request);
      if (request.state === "approved") return await provisionRunNextJob(request);
      if (request.state === "paused") return true;
      if (request.state === "done") return await provisionFinishRequest(request, "done");
      return false;
    } catch (error) {
      return provisionPause(`Provisioning: ${error.message || error}`, request, provisionActiveJob());
    } finally {
      provisionRunning = false;
    }
  }

  /** Отмена ещё не одобренного запроса (кнопка UI). Активные jobs не отменяет. */
  function provisionCancelRequest() {
    const request = provisionRequestState();
    if (!request || !["prepared", "sending", "awaiting"].includes(request.state)) return false;
    provisionEvent("provision_rejected", { requestId: request.requestId, reason: "отменено Мастером" });
    const resume = request.resumeAuto === true && !GM_getValue(K.paused, "");
    saveProvisionRequest(null);
    provisionReleaseLock();
    if (resume) autoSet(true);
    return true;
  }

  // ───────────────────────── provisioning: диалог Мастера ─────────────────────────

  async function provisionOpenDialog() {
    if (typeof projectApproved === "function" && !projectApproved()) {
      log("Provisioning: проект ещё не разрешён к работе.", true); return;
    }
    document.getElementById("cfn-provision-dialog")?.remove();
    const cfg = provisionConfig();
    const box = document.createElement("div");
    box.id = "cfn-provision-dialog";
    box.style.cssText = "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center";
    const card = document.createElement("div");
    card.style.cssText = "width:min(720px,94vw);max-height:88vh;overflow:auto;background:#15171c;color:#e7eaee;border:1px solid #2b2f38;border-radius:10px;padding:16px;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace";
    card.innerHTML = `<h3 style="margin:0 0 8px">🤖 Provisioning Arena-агентов</h3><div id="cfn-provision-body">Читаю свежие роли…</div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <button id="cfn-provision-request" style="padding:6px 10px">Запросить создание/замену</button>
        <button id="cfn-provision-cancel" style="padding:6px 10px">Отменить запрос</button>
        <button id="cfn-provision-close" style="padding:6px 10px">Закрыть</button>
      </div>`;
    box.appendChild(card);
    document.body.appendChild(box);
    const body = card.querySelector("#cfn-provision-body");
    const requestBtn = card.querySelector("#cfn-provision-request");
    const cancelBtn = card.querySelector("#cfn-provision-cancel");
    card.querySelector("#cfn-provision-close").onclick = () => box.remove();
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    requestBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const request = provisionRequestState();
      const state = provisionState();
      const active = provisionActiveJob();
      let html = `<div style="color:#aab4c3">enabled=${cfg.agentProvisionEnabled} mode=${cfg.agentProvisionMode} allowlist=${cfg.agentProvisionRepoAllowlist.length} maxJobs=${cfg.agentProvisionMaxJobs} dailyMax=${cfg.agentProvisionDailyMax} bootstrap=${provisionBootstrapClean(cfg.agentBootstrapPrompt) ? "ok" : "пуст/запрещён"}</div>`;
      if (request) {
        html += `<div style="margin-top:8px">Запрос ${escapeHtml(request.requestId)}: ${escapeHtml(request.state)}; админ «${escapeHtml(request.adminRoleName || "")}»; jobs ${(request.jobIds || []).length}.</div>`;
        cancelBtn.disabled = !["prepared", "sending", "awaiting"].includes(request.state);
      }
      if (active) html += `<div style="margin-top:6px">Активный job ${escapeHtml(active.id)}: ${escapeHtml(active.state)} «${escapeHtml(active.roleName)}» ${escapeHtml(active.repo)}${active.agentUrl ? ` URL ${escapeHtml(active.agentUrl)}` : ""}.</div>`;
      if (!cfg.agentProvisionEnabled) {
        html += `<p>Provisioning выключен в профиле. Включите его в управлении проектами и задайте allowlist/bootstrap.</p>`;
        body.innerHTML = html;
        return;
      }
      const { candidates, rejected, admin } = await provisionGather(cfg);
      html += `<div style="margin-top:8px">Админ-роль: ${admin ? `«${escapeHtml(admin.name)}» (${escapeHtml(admin.fn)})` : "<b>нет активной админ-роли</b>"}.</div>`;
      if (candidates.length) {
        html += `<table style="width:100%;border-collapse:collapse;margin-top:8px"><tr><th align="left">Роль</th><th align="left">Функция</th><th align="left">Repo</th><th align="left">Action</th></tr>`;
        for (const c of candidates) html += `<tr><td>${escapeHtml(c.roleName)}</td><td>${escapeHtml(c.fn)}</td><td>${escapeHtml(c.repo)}</td><td>${escapeHtml(c.action)}</td></tr>`;
        html += `</table>`;
      } else html += `<p>Кандидатов нет. Нужны строки с Agent State=запрошен, не админ, repo в allowlist, без активной работы.</p>`;
      if (rejected.length) html += `<div style="margin-top:8px;color:#ffd479">Отклонено: ${rejected.map((r) => `${escapeHtml(r.rolePageId)} — ${escapeHtml(r.reason)}`).join("; ")}</div>`;
      const idle = provisionIdleReason(cfg);
      if (idle) html += `<div style="margin-top:8px;color:#ffd479">Запрос сейчас не будет выдан: ${escapeHtml(idle)}.</div>`;
      const journal = state.journal.slice(-8).map((e) => `${escapeHtml(e.at)} ${escapeHtml(e.event)} ${escapeHtml(e.reason || e.step || "")}`).join("<br>");
      if (journal) html += `<div style="margin-top:10px;color:#aab4c3;font-size:12px">${journal}</div>`;
      body.innerHTML = html;
      requestBtn.disabled = Boolean(idle) || !candidates.length || !admin || Boolean(request);
      requestBtn.onclick = async () => {
        if (!confirm(`Выдать запрос админ-роли «${admin.name}» на ${candidates.length} кандидат(ов)? Создание начнётся только после маркера одобрения.`)) return;
        requestBtn.disabled = true;
        box.remove();
        await provisionStartRequest({ auto: false });
      };
      cancelBtn.onclick = () => {
        if (provisionCancelRequest()) { log("Provisioning: запрос отменён Мастером."); box.remove(); }
      };
    } catch (error) {
      body.textContent = `Не удалось прочитать кандидатов: ${error.message || error}`;
    }
  }

  // ───────────────────────────── цикл ─────────────────────────────
  let busy = false;
  /** Сколько раз подряд шаг снимали с блокировки по тишине. */
  let stepRestarts = 0;

  /**
   * «Шаг жив». Сторож снимает блокировку через две минуты, а ожидание мержа
   * длится до пяти — без этой отметки долгий, но честный шаг выглядел
   * зависанием, и второй тик запускал его заново поверх первого (24.10, 14:48).
   */
  function stepAlive() {
    busyAt = Date.now();
  }

  /**
   * Перейти на страницу роли. Один и тот же переход из одного и того же места
   * дважды за 30 секунд — это не «ещё раз», а зацикливание: значит страница не
   * открылась или адрес в «Ролях» указывает не туда. Тогда пауза и понятная
   * причина, а не бесконечные прыжки.
   */
  async function navigateTo(role, why) {
    if (typeof projectRoleAllowed === "function" && !projectRoleAllowed(role)) return false;
    const from = location.pathname || "/";
    const last = GM_getValue("cfn-nav", null);
    const recent =
      last &&
      norm(last.roleId) === norm(role.id) &&
      last.from === from &&
      Date.now() - Number(last.at || 0) < 30_000;
    if (recent) {
      pause(
        `Не удалось открыть страницу «${role.name}»: остаюсь на ${from}. ` +
          "Страница не открылась за два перехода подряд — возможно, медленная загрузка или адрес в «Ролях» неверен. Проверьте адрес и нажмите «Продолжить».",
        { kind: "nav", ref: role.id },
      );
      return true;
    }
    GM_setValue("cfn-nav", { roleId: role.id, from, at: Date.now() });
    log(`Сейчас ${from} — открываю страницу «${role.name}»: ${why}.`);
    // D-045: отметку перехода и журнал надо довести до хранилища до ухода со
    // страницы, иначе защита от петли прочитает прежнюю отметку и цикл прыгнет
    // снова — уже без памяти о первом переходе.
    await flushBeforeNavigate(handoffKeys());
    location.assign(role.url);
    return true;
  }

  // Ожидание, снятое как фантом, — чтобы тик мог вернуть его карточку в Ready.
  let droppedHandoff = null;
  // Ожидание, снятое обновлением скрипта: карточку вернёт первый же шаг.
  let ghostAfterUpdate = null;

  /**
   * Отправка без подтверждения — не отправка.
   *
   * До 1.4.7 `sentAt` ставился сразу после клика, не глядя, дошёл ли он:
   * карточка «review panel» возвращалась и накрывала кнопку Send, сообщение
   * не появлялось, а скрипт потом честно ждал ответа на несуществующий
   * вопрос. Такое ожидание возвращаем в очередь и отправляем заново.
   */
  function reviveUnverifiedHandoff() {
    const waiting = GM_getValue(K.expect, null);
    if (!waiting || !Number(waiting.sentAt) || waiting.verified === true) return "";

    // Водяной знак относится к чату адресата. На чужой странице чужой ответ
    // нельзя принять за подтверждение доставки старой карточки Reviewer.
    if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
        norm(waiting.roleName) === norm("Warden")) && !waiting.isDispatchReminder &&
        (!waiting.roleId || norm(roleFromPath()) !== norm(waiting.roleId))) {
      pause("Доставка старой карточки Reviewer не подтверждена, а открыт другой чат. Ожидание сохранено: проверьте чат адресата и Run ID.",
        { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
      return "reviewer-held";
    }

    // Если после водяного знака в чате уже что-то появилось, отправка всё-таки
    // дошла (или агент успел ответить): повторять нельзя, иначе будет дубль.
    if (messagesAfter(waiting.watermark || "", waiting.seen).length) {
      GM_setValue(K.expect, { ...waiting, verified: true });
      dbg("revive: после водяного знака есть сообщения — считаю отправку доставленной");
      return "";
    }

    // Это может быть старый уже отправленный ход Reviewer с потерянным
    // подтверждением. Не переотправляем рабочую карточку и не стираем ход.
    if (waiting.kind === "dispatch" && (waiting.roleFn === "Reviewer" || !waiting.roleFn ||
        norm(waiting.roleName) === norm("Warden")) && !waiting.isDispatchReminder) {
      pause("Отправка старой или нераспознанной карточки Reviewer не подтверждена. Не повторяю её и сохраняю ожидание и карточку: проверьте чат и Run ID.",
        { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
      return "reviewer-held";
    }
    const text = String(waiting.text || "");
    GM_setValue(K.expect, null);
    GM_setValue("cfn-plan-at", 0);
    if (!text) {
      droppedHandoff = waiting;
      log(
        "Снял ожидание без подтверждённой отправки: в чат ничего не ушло, текста задания не сохранилось. " +
          "Нажмите «Шаг», чтобы начать ход заново.",
        true,
      );
      return "dropped";
    }
    GM_setValue(K.pending, {
      roleId: waiting.roleId,
      roleName: waiting.roleName,
      roleUrl: waiting.roleUrl,
      text,
      at: Date.now(),
    });
    log(
      `Прошлая отправка «${waiting.title || waiting.kind}» не подтверждена (сообщение в чате не появилось) — ` +
        "ставлю задание обратно в очередь и отправляю заново.",
      true,
    );
    return "revived";
  }

  /** Не снимаем потенциально живую старую выдачу Reviewer без очереди. */
  async function holdLegacyUnsentDispatch() {
    const waiting = GM_getValue(K.expect, null);
    if (!waiting || waiting.kind !== "dispatch" || Number(waiting.sentAt) || GM_getValue(K.pending, null)) return false;
    let hold = waiting.roleFn === "Reviewer" || norm(waiting.roleName) === norm("Warden");
    if (!hold) {
      try {
        const owners = (await roleRows({ fresh: true, requireFresh: true }))
          .filter((r) => r.id && norm(r.id) === norm(waiting.roleId));
        hold = !owners.length || owners.some((r) => r.fn === "Reviewer" || norm(r.name) === norm("Warden")) ||
          !owners.some((r) => r.status === "Активна" && ["Executor", "Auditor"].includes(r.fn));
      } catch {
        hold = true;
      }
    }
    if (!hold) return false;
    pause("Старая выдача Reviewer или её адресат не подтверждены. Карточку не откатываю, ожидание сохранено: проверьте чат и Run ID.",
      { kind: "reviewer-task-pending", ref: waiting.ref || "", runId: waiting.runId || "" });
    return true;
  }

  /**
   * Один отложенный повтор нажатого «Шага». Он ничего не отправляет: первый
   * проход остановился до любой отправки, значит дубля не будет. Нужен потому,
   * что кнопка Stop может быть мгновенной заставкой загрузки страницы.
   */
  let stepRetry = 0;
  function scheduleStepRetry(delayMs = 4000) {
    if (stepRetry >= 2) return;
    stepRetry += 1;
    log(`Проверю ещё раз через ${Math.round(delayMs / 1000)} с: если это была заставка загрузки, шаг пойдёт сам.`);
    setTimeout(() => {
      if (busyReason()?.kind === "stop") {
        log("Кнопка Stop всё ещё на месте — шаг остаётся на паузе до вашего нажатия.");
        stepRetry = 0;
        return;
      }
      stepRetry = 0;
      tick(true);
    }, delayMs);
  }

  async function tick(fromToggle = false) {
    if (typeof projectApproved === "function" && !projectApproved()) {
      if (fromToggle) log("Проект ещё не разрешён к работе: проверьте его в управлении проектами.", true);
      return;
    }
    if (typeof projectHeld === "function" && projectHeld()) {
      // fromToggle используется и отложенными автоматическими шагами: право
      // снять удержание есть только у явных кнопок «Шаг»/«Включить».
      if (fromToggle) log("Проект ждёт ручного запуска после переключения.");
      return;
    }
    if (typeof document !== "undefined" && document.getElementById?.("cfn-projects")) return;
    // Асинхронное окно не блокирует event loop как прежние prompt. Пока оно
    // открыто, не начинаем новые шаги со старыми подключениями; уже запущенные
    // операции и независимые сторожа этим не отменяются.
    if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) {
      if (fromToggle) log("Шаг отложен: завершите настройку или закройте окно подключений.");
      return;
    }
    // Фоновая вкладка в журнале не отмечается: Мастер работает в другой
    // вкладке постоянно, и строка «браузер режет таймеры» превращалась в шум.
    // Растянутые ожидания (`patience`) от этого никуда не делись.
    if (busy) {
      // Шаг мог повиснуть на сетевом запросе без таймаута. Тогда «Шаг» и
      // автоцикл молчат навсегда — снимаем блокировку и говорим об этом.
      //
      // Тишина здесь настоящая: `sleep` и `waitFor` отмечаются в `busyAt`
      // каждые несколько секунд, поэтому живого шага этот сторож не касается.
      // Старый проход остаётся стоять на await, который уже не завершится, —
      // значит перезапуск не дубль, а выход из тупика. Но третий раз подряд —
      // это не сбой одного запроса, а поломка: дальше решает Мастер.
      const silentMs = Date.now() - busyAt;
      if (silentMs < 120000) {
        if (fromToggle) log("Шаг уже выполняется: дождитесь его конца, повторный не нужен.");
        return;
      }
      stepRestarts += 1;
      log(
        `Предыдущий шаг молчал ${Math.round(silentMs / 1000)} с (ни одной отметки жизни) — ` +
          `снимаю блокировку и запускаю заново: ${stepRestarts} из 2.`,
        true,
      );
      busy = false;
      if (stepRestarts > 2) {
        pause(
          "Шаг трижды подряд переставал отвечать на одном и том же месте. Параллельных запусков нет: " +
            "снятый проход не продолжается. Проверьте страницу агента и нажмите «Продолжить».",
          { kind: "step" },
        );
        return;
      }
    }
    // Повтор записи снимка не запускает ход и работает также в ручном режиме
    // и на паузе. Его не ждём: сетевой шлюз не должен блокировать «Шаг».
    flushPollJournal().catch((e) => log(`Очередь записи опросов не обработана: ${e.message}`, true));
    // Ложный отказ проверки мержа чинится сам: иначе карточка ждёт Мастера,
    // а работа уже лежит в main (24.10 так было дважды).
    try {
      await selfHealClaim();
    } catch (e) {
      log(`Самопроверка последнего отказа не удалась: ${e.message}`, true);
    }
    // Окно могли открыть во время асинхронной самопроверки выше.
    if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) return;
    // Provisioning Arena-агентов — отдельный административный контур. Он читает
    // свой request/job/lock до auto/pending-логики и не трогает K.pending/K.expect.
    // Пока запрос или job активен, обычный командный цикл не начинается.
    if (typeof consumeProvision === "function" && await consumeProvision()) return;
    // Незавершённая отправка живёт в очереди и не зависит от автоцикла:
    // иначе после перехода на страницу адресата задание никто не досылал.
    const auto = autoOn();
    const pending = GM_getValue(K.pending, null);
    const waiting = GM_getValue(K.expect, null);
    if (!auto && !fromToggle && !pending && !waiting) return;
    // Пауза снимается только человеком: тик не имеет права её обойти.
    if (isPaused()) {
      // Единственное исключение — пауза, поставленная прошлой миссией: к
      // текущей она не относится и молча держала бы новый цикл.
      if (!(await clearStaleMissionPause())) {
        if (fromToggle) log(`Шаг не выполнен: цикл на паузе (${GM_getValue(K.paused, "")}).`, true);
        return;
      }
    }
    // Вопросы к Мастеру живут отдельным сторожем (`watchQuestions`): они видны
    // и на паузе, а тик до паузы не доходит.
    busy = true;
    busyAt = Date.now();
    try {
      // Капча важнее любого шага: она останавливает и отправку, и ответ.
      if (captchaDialog()) {
        // «Отправлено» перед капчей ничего не доказывает: Arena рисует реплику
        // раньше, чем проверка её пропустит. В журнале должно быть «доставка не
        // подтверждена» — иначе непонятно, зачем переотправлять задание.
        const seen = GM_getValue(K.expect, null);
        if (seen?.sentAt && seen.verified !== false) {
          GM_setValue(K.expect, { ...seen, captcha: true, verified: false });
        }
        captchaPause();
        return;
      }
      // Tool-call limit — продолжение того же хода, раньше общей паузы по ошибке.
      if (await handleToolCallLimit()) return;
      // Ошибка на экране важнее любого шага: сначала остановиться.
      if (monitorVisibleErrors()) return;
      await setup(false);
      // Если параметр setup открыл окно из тика, выйти через finally и снять
      // busy: ожидание закрытия здесь заблокировало бы само сохранение.
      if (typeof document !== "undefined" && document.getElementById?.("cfn-connections")) return;
      // Новая миссия — новый ход: остатки прошлой снимаются до любых решений.
      try {
        if (await syncMissionState()) return;
      } catch (e) {
        dbg("миссия: сверка не удалась", e.message);
        const held = GM_getValue(K.expect, null);
        if (held?.kind === "dispatch" || (held?.kind === "reminder" && held.runId)) {
          logThrottled("dispatch-mission-check", "Не удалось сверить миссию выдачи с Notion: ожидание сохранено, повторю проверку на следующем шаге.", true);
          return;
        }
      }
      dbg("tick: состояние", {
        fromToggle,
        path: location.pathname,
        pending: Boolean(GM_getValue(K.pending, null)),
        expect: GM_getValue(K.expect, null) && {
          kind: GM_getValue(K.expect, null).kind,
          sentAt: GM_getValue(K.expect, null).sentAt,
          verified: GM_getValue(K.expect, null).verified,
        },
      });
      const revived = reviveUnverifiedHandoff();
      if (revived === "reviewer-held") return;
      if (droppedHandoff) {
        const gone = droppedHandoff;
        droppedHandoff = null;
        await releaseUndelivered(gone, "отправка не подтвердилась, текста задания не сохранилось");
      }
      if (ghostAfterUpdate) {
        const gone = ghostAfterUpdate;
        ghostAfterUpdate = null;
        await releaseUndelivered(gone, "обновление скрипта: задание не уходило");
      }
      // Эфемерные пилоты SYN-P1 читаются до командного транспорта и живут в
      // отдельном namespace; на странице команды consumePilot возвращает false.
      if (await consumePilot()) return;
      if (await consumePending(fromToggle)) return;
      // Фантом старой версии снят, повторять нечего: без нажатия не начинаем ход.
      if (revived === "dropped" && !auto && !fromToggle) return;
      // Ожидание без отметки отправки и без очереди — след упавшей попытки:
      // сообщения в чате нет, карточке в Running делать нечего. Убираем это
      // на любой странице, иначе Координатор видит живой ход там, где работы
      // не начиналось (24.10, NAR-1.12).
      if (await holdLegacyUnsentDispatch()) return;
      const ghost = await dropGhostHandoff("задание не дошло: отметки отправки нет");
      if (ghost) {
        log(
          `${ghost.expect.roleName || ghost.expect.roleId}: ожидание без отметки отправки — это прошлый ход, ` +
            "а не работа. " +
            (ghost.rolled
              ? "Карточка возвращена в Ready — ход начнётся заново."
              : "Ожидание снято, ход начнётся заново."),
          false,
          { tone: "warn" },
        );
      }
      // Ручной режим: нажатие «Шаг» делает ровно один шаг. Фон (таймер)
      // досылает очередь после перехода, но не читает ответы и не выдаёт
      // новые задания: иначе один ход превращался в цепочку из трёх отправок.
      if (!auto && !fromToggle) return;
      if (fromToggle) dbg("шаг: начало", () => debugSnapshot());

      // Неотправленное задание важнее всего остального: пока оно в очереди,
      // ни план, ни новый ход не начинаются. В автоцикле страницу адресата
      // открываем сами — иначе после перезагрузки вкладки очередь стояла бы
      // вечно, а браузер ждал бы человека.
      const pendingNow = GM_getValue(K.pending, null);
      if (pendingNow && (fromToggle || autoOn())) {
        const here = roleFromPath();
        if (norm(here) !== norm(pendingNow.roleId)) {
          const all = await roles();
          const target = all.find((r) => norm(r.id) === norm(pendingNow.roleId)) || null;
          if (target) return navigateTo(target, "там ждёт отправки задание");
        }
      }

      const meId = roleFromPath();
      if (!meId) {
        // Мастер не обязан помнить, на какой странице стоит цикл, но и угадывать
        // ему не нужно: «Шаг» открывает ту страницу, где действительно есть
        // работа. Сначала — адресат неотправленного задания, потом — тот, чей
        // ответ ждём, и только потом Координатор (там начинается новый ход).
        // В автоцикле Мастер не жмёт «Шаг»: цикл сам открывает ту страницу,
        // где есть работа. Иначе «Включить» на главной ничего не делал.
        if (!fromToggle && !autoOn()) return;
        const list = await roles();
        const pendingNow = GM_getValue(K.pending, null);
        const waitingNow = GM_getValue(K.expect, null);
        const byId = (id) => (id ? list.find((r) => norm(r.id) === norm(id)) || null : null);
        const pendingRole = pendingNow ? byId(pendingNow.roleId) : null;
        const waitingRole = waitingNow ? byId(waitingNow.roleId) : null;
        const coord = list.find((r) => r.fn === "Coordinator");
        const target = pendingRole || waitingRole || coord;
        if (!target) {
          log(
            list.length
              ? "Шаг не выполнен: нет активного Coordinator с заполненным «Agent URL»."
              : "Шаг не выполнен: нет ни одной активной роли с заполненным «Agent URL» — заполните поле в базе «Роли».",
            true,
          );
          return;
        }
        // В ручном режиме отложенный шаг выполняет уже открытая страница.
        // В автоцикле он не нужен: следующий тик продолжит сам.
        if (!pendingNow && fromToggle) GM_setValue(K.step, true);
        const why = target === pendingRole
          ? "там ждёт отправки задание"
          : target === waitingRole
            ? `ждём ответа «${target.name}»`
            : "там начинается ход";
        return navigateTo(target, why);
      }
      const list = await roles();
      let me = list.find((r) => norm(r.id) === norm(meId));
      // Список мог устареть в кеше: Мастер только что вписал этот Agent URL.
      // Один перечит мимо кеша дешевле, чем «страница не привязана к роли».
      if (!me) me = (await rolesFresh().catch(() => [])).find((r) => norm(r.id) === norm(meId));
      if (!me) {
        if (fromToggle)
          log(
            list.length
              ? `Шаг не выполнен: страница ${meId} не привязана к активной роли. Проверьте её «Agent URL».`
              : "Шаг не выполнен: нет ни одной активной роли с заполненным «Agent URL» — заполните поле в базе «Роли».",
            true,
          );
        return;
      }
      GM_setValue("cfn-me", me.name);
      setStatus();

      // Страница не догружена — шаг ничего не делает. Ни вставки, ни кликов,
      // ни закрытия панелей: на недорисованной странице любое действие либо
      // уходит в пустоту, либо бьёт по чужому элементу.
      const shell = appReady();
      if (!shell.ok) {
        logThrottled(
          "app-ready",
          `Страница ещё грузится (${shell.why}) — ничего не делаю, жду.`,
          false,
          C.tickMs * 4,
        );
        return;
      }

      const working = fromToggle ? await busySettled() : busyReason();
      if (working) {
        if (fromToggle) {
          log(`Шаг не выполнен: агент ещё отвечает (${busyLabel(working)}).`);
          // Ложный Stop исчезает сам: не заставляем Мастера жать второй раз.
          if (working.kind === "stop") scheduleStepRetry();
        }
        return;
      }

      let expect = GM_getValue(K.expect, null);
      if (expect && norm(expect.roleId) !== norm(me.id)) {
        const owner = list.find((r) => norm(r.id) === norm(expect.roleId)) || null;
        const ownerName = expect.roleName || owner?.name || "другой роли";
        if ((fromToggle || autoOn()) && owner) {
          let samePage = false;
          try {
            samePage = new URL(owner.url, location.href).pathname === location.pathname;
          } catch {
            samePage = false;
          }
          // Стоим не там, где идёт работа: открываем нужную страницу, а не
          // просим Мастера перейти вручную.
          if (!samePage) {
            if (fromToggle) GM_setValue(K.step, true);
            return navigateTo(owner, `ждём ответа «${owner.name}», а не «${me.name}»`);
          }
        }
        if (fromToggle) log(`Шаг не выполнен: ход ждёт ответа «${ownerName}», а не «${me.name}».`);
        return;
      }

      // Старая версия помечала напоминание отдельным видом ожидания, и после
      // него Координатор «не узнавал» свой ход и запрашивал новый план —
      // отсюда вторая и третья отправки подряд. Приводим к исходному виду.
      if (expect && expect.kind === "reminder") {
        expect = {
          ...expect,
          kind: expect.runId
            ? "dispatch"
            : expect.questionId
              ? "answer"
              : me.fn === "Coordinator" ? "plan" : me.fn === "Reviewer" ? "review" : "dispatch",
        };
        GM_setValue(K.expect, expect);
      }

      // Ожидание без отметки отправки — не ожидание, но только если доставка
      // не доказана. D-044: dropGhostHandoff сначала ищет квитанцию/реплику
      // этой выдачи и восстанавливает `sentAt`; локальный снимок `expect`
      // мог устареть за время сетевых шагов, поэтому решение принимается по
      // живому состоянию, а не по старому объекту.
      if (expect && !Number(expect.sentAt)) {
        const ghost2 = await dropGhostHandoff("задание не дошло: отметки отправки нет");
        const live = GM_getValue(K.expect, null);
        if (!ghost2 && live && Number(live.sentAt)) {
          expect = live;
        } else {
          GM_setValue(K.expect, null);
          GM_setValue("cfn-plan-at", 0);
          log(
            `${me.name}: в чате нет отметки прошлой отправки — это след прошлой попытки, снимаю ожидание и начинаю ход заново.` +
              (ghost2 && ghost2.rolled ? " Карточка возвращена в Ready." : ""),
            true,
          );
          expect = null;
        }
      }

      // Опрос вместо ответа — не ответ. Разбираем его раньше любых
      // напоминаний: иначе «маркера нет» превращается в напоминание агенту,
      // который просто ждёт ответа на свой вопрос (24.10, NAR-1.12).
      const poll = await answerPolls(me, expect);
      if (poll === "answered") {
        log(`Жду, что ${me.name} напишет после ответа на вопрос.`);
        return;
      }
      if (poll === "waiting") {
        // Опрос уже отвечен, продолжения ещё нет. Ждём, но не бесконечно:
        // вопрос в чате — не «свежее сообщение», и общий сторож тишины на нём
        // не сработал бы, оставив карточку в Running навсегда.
        const since = Number((expect && (expect.sentAt || expect.at)) || 0);
        const waitedPoll = since ? Date.now() - since : 0;
        if (expect && waitedPoll > C.replyWaitMs) {
          const stuck = expect;
          dropHandoff(
            `${me.name}: опрос отвечен, но продолжения нет ${Math.round(waitedPoll / 60000)} мин — ` +
              "похоже, ход встал. Очередь и ожидание сняты; нажмите «Продолжить» и пройдите шаг заново.",
          );
          await releaseUndelivered(stuck, "агент не продолжил после ответа на вопрос");
        }
        return;
      }

      // Ждать ответа бесконечно нельзя: если агент не прислал ни строки за
      // replyWaitMs, задание до него, скорее всего, не дошло (например,
      // осталось от старой версии). Молчание тут — ошибка, а не терпение.
      //
      // Но молчание и работа — разные вещи. Задача может идти часами: пока
      // виден Stop или плашка «думает», ход живой, и снимать передачу нельзя —
      // иначе агент останется без ответа, а карточка вернётся в Ready.
      //
      // И третья разница, из-за которой этот блок переписан 25.10: отсутствие
      // ответа на ещё не отрисованной странице — не молчание, а загрузка.
      if (expect) {
        const since = Number(expect.sentAt || expect.at) || 0;
        const waited = Date.now() - since;

        // Отсчёт наблюдения — с того момента, когда страница адресата открылась
        // в этой попытке, а не с отправки: после обрыва связи и «Продолжить»
        // скрипт заходит на страницу, которой ещё секунду назад не видел.
        const path = location.pathname || "/";
        if (expect.seenPath !== path || !Number(expect.seenAt)) {
          expect = { ...expect, seenPath: path, seenAt: Date.now(), readyAt: 0, pageReloaded: false };
          GM_setValue(K.expect, expect);
        }
        const watched = Date.now() - Number(expect.seenAt || Date.now());

        // Пока транскрипт не отрисован, о молчании агента не судим: пустая
        // страница — это загрузка или сеть, а не «задание не дошло».
        const page = pageReady(expect);
        if (page.ok && !Number(expect.readyAt)) {
          // Дальше короткая выдержка: сразу после отрисовки ответ может ещё
          // доезжать, и «пусто» в этот момент ничего не доказывает.
          expect = { ...expect, readyAt: Date.now() };
          GM_setValue(K.expect, expect);
        }
        if (!page.ok) {
          if (watched > C.pageWaitMs) {
            // Ожидание НЕ снимаем и карточку НЕ трогаем: работа могла быть
            // сделана, а ответ — лежать в чате. Это пауза про связь, а не про
            // исполнителя, поэтому после «Продолжить» всё перечитывается.
            expect = { ...expect, seenAt: 0, readyAt: 0, pageReloaded: false };
            GM_setValue(K.expect, expect);
            pause(
              `Страница «${me.name}» не открылась за ${Math.round(watched / 1000)} с (${page.why}). ` +
                "Это не молчание агента: ожидание, очередь и карточка на месте. " +
                "Проверьте связь и нажмите «Продолжить» — скрипт перечитает страницу и заберёт ответ.",
              { kind: "offline", ref: me.id, runId: expect.runId || "" },
            );
            return;
          }
          if (watched > C.pageReloadMs && !expect.pageReloaded) {
            expect = { ...expect, pageReloaded: true };
            GM_setValue(K.expect, expect);
            log(
              `Страница «${me.name}» не отрисовалась за ${Math.round(watched / 1000)} с (${page.why}) — ` +
                "перечитываю её. Ожидание не снимаю: ответ агента остаётся в чате.",
            );
            // D-045: отметка `pageReloaded` должна пережить перезагрузку,
            // иначе страница перечитывается бесконечно.
            await flushBeforeNavigate([K.expect, K.log]);
            location.reload();
            return;
          }
          logThrottled(
            `page-render:${me.id}`,
            `Страница «${me.name}» ещё не отрисовалась (${page.why}) — жду, ответ не снимаю.`,
            false,
            C.tickMs,
          );
          return;
        }

        const observed = Number(expect.readyAt) ? Date.now() - Number(expect.readyAt) : 0;
        const fresh = messagesAfter(expect.watermark || "").length;
        const working = stillWorking();
        if (waited > C.replyWaitMs && observed > C.observeGraceMs && !fresh && !working) {
          const stuck = expect;
          dropHandoff(
            `${me.name} не ответил ни одним сообщением за ${Math.round(waited / 60000)} мин и ничего не делает: ` +
              `страница открыта и видна, ответа в ней нет — похоже, задание до него не дошло. ` +
              `Очередь и ожидание сняты — нажмите «Продолжить» и пройдите шаг заново.`,
          );
          await releaseUndelivered(stuck, "агент не ответил и ничего не делает");
          return;
        }
        if (waited > C.longWaitNoticeMs) {
          logThrottled(
            `long-wait:${expect.ref || expect.roleId || ""}`,
            `Жду ответа «${expect.roleName || expect.roleId}» ${Math.round(waited / 60000)} мин` +
              `${fresh ? " — агент уже отвечает" : working ? " — агент работает" : ""}. ` +
              "Длинная задача может идти часами: ждём, передачу не снимаю.",
            false,
            C.longWaitNoticeMs,
          );
        }
      }

      // Вопрос, который ещё не отвечен, важнее нового хода: как только вопрос
      // записан, ход переходит приёмке (1.4.80). Проверка стоит до выбора
      // роли, поэтому работает и на странице исполнителя, и на странице
      // Координатора — с любой из них транспорт уходит к приёмке сам.
      if (!expect && me.fn !== "Reviewer") {
        const item = answerPending();
        if (item && (fromToggle || autoOn())) {
          const mission = await activeMission().catch(() => null);
          if (mission && (await startAnswer(mission, item))) return;
        }
      }

      if (expect?.kind === "dispatch") {
        // У Reviewer тоже бывают карточки. Их вердикт — ответ по карточке,
        // а не назначенная отдельно приёмка миссии.
        await submitExecutor(me, expect, fromToggle);
      } else if (me.fn === "Coordinator") {
        await coordinatorStep(me, expect, fromToggle);
      } else if (me.fn === "Reviewer" && expect) {
        if (expect.kind === "answer") await answerStep(me, expect, fromToggle);
        else if (expect.kind === "review") await reviewStep(me, expect, fromToggle);
        // D-053: арбитраж петли — отдельный ход приёмки со своим маркером.
        else if (expect.kind === "arbiter") await arbiterStep(me, expect, fromToggle);
        else pause(`Неизвестный вид хода приёмки «${expect.kind || "пусто"}»: ничего не меняю.`, {
          kind: "handoff-kind", ref: expect.ref || "",
        });
      } else if (!expect) {
        // Без ожидания `messagesAfter(expect.watermark)` упал бы в catch,
        // и «Шаг» на странице исполнителя ставил бы паузу вместо ответа.
        const coord = list.find((r) => r.fn === "Coordinator");
        if (fromToggle && coord) {
          // «Шаг» не должен упираться в тупик: работа начинается у
          // Координатора, туда и ведём. Раньше здесь была только строка в
          // журнале, и на опустевшей странице исполнителя жать было некуда —
          // например, после того как задание сняли как просроченное.
          log(`У «${me.name}» нет задания в очереди — открываю Координатора: там начинается ход.`);
          GM_setValue(K.step, true);
          return navigateTo(coord, "там начинается ход");
        }
        if (fromToggle) {
          log(`Шаг не выполнен: у «${me.name}» нет задания в очереди. Ход начинается с Координатора.`, true);
        } else if (autoOn() && coord) {
          // В автоцикле незанятая страница исполнителя — не повод стоять:
          // новый ход начинается у Координатора, туда и переходим.
          return navigateTo(coord, "там начинается ход");
        }
      } else {
        pause(`Неизвестный вид хода «${expect.kind || "пусто"}»: карточку и миссию не меняю.`, {
          kind: "handoff-kind", ref: expect.ref || "",
        });
      }
    } catch (e) {
      // «HTTP 400: path failed validation» Мастеру ничего не говорит. Сначала
      // что случилось и что делать, потом техническая строка — она нужна,
      // если придётся разбираться.
      const raw = String((e && e.message) || e);
      // Причина называется по источнику: «Notion» и «шлюз Drive» — разные
      // поломки и разные действия Мастера.
      const plain = e && e.relay === "question-too-long"
        ? "Вопрос или вариант по умолчанию слишком длинный: ничего не усекал и приёмке не передал. " +
          "Сохраните полный материал в Notion и разберите текущий ход вручную."
        : e && e.relay === "binding"
          ? "Мешает привязка карточек: в «Запросах» есть карточки без Mission ID " +
            "или с неизвестным состоянием. Пока неясно, чьи они, очередь этой миссии не собрать: " +
            "выдавать и принимать такие карточки нельзя. Привяжите их через " +
            "«Управление проектами → Проверить Mission ID карточек» и нажмите «Продолжить» — " +
            "полученный ответ и сами карточки не потеряны, я их не скрываю и не меняю."
          : /битый id|valid uuid|path failed validation/i.test(raw)
        ? "Notion не принял адрес записи: в нём оказался битый id — обычно это " +
          "опечатка в строке-маркере ответа."
        // D-069: файл задания в Drive — не запись в Notion. Раньше этот отказ
        // попадал в последнюю ветку и звучал как «Шаг прервался на записи в
        // Notion», хотя ни одной записи ещё не было.
        : /^Payload не прочитан/.test(raw)
          ? "Файл задания не прочитан из Drive: отправка не начиналась, карточка не тронута. " +
            "Проверьте поле «Payload Drive File ID» (один или несколько id файлов из Arena/payloads) " +
            "и нажмите «Продолжить»."
        : e && e.relay === "gateway"
          ? e.refused
            ? `Шлюз Drive ответил отказом: ${e.reason} Запись не сделана, в Диске ничего не менялось. ` +
              "Если отказ про папку — в карточке указан не журнал: «Output Drive File ID» должен " +
              `указывать на файл из ${C.driveFolder ? `Arena/${C.driveFolder}/logs` : "Arena/logs"}; скрипт вернёт его сам после обновления.`
            : "Шлюз Drive не ответил, ответ агента в журнал не записан. Проверьте, что " +
              "развёртывание Apps Script открыто «любому, у кого есть ссылка», и что ссылка в ⚙ та же."
          : /HTTP (?:429|5\d\d)/i.test(raw)
            ? "Notion ответил сбоем на своей стороне — это не ошибка карточки и не потерянный ход. " +
              "Скрипт повторил запрос и подождал; Notion не восстановился за это время. Обычно проходит за минуту-другую."
            : /HTTP 4\d\d/i.test(raw)
              ? "Notion отклонил запись: он ответил, и сеть тут ни при чём — данные не прошли его проверку. " +
                (/length should be/i.test(raw)
                  ? "Не поместился текст: одно поле принимает не больше 2000 знаков на объект — " +
                    "это дефект скрипта, а не ошибка карточки или ответа. "
                  : "") +
                "Запись не сделана, ход не потерян."
              : e && e.relay === "notion" && e.link
                ? "Связь с Notion пропала: запрос не дошёл, и два зонда (через 5 и 15 с) её не вернули. " +
                  "Обычно это сон машины или вкладка в фоне — проверьте интернет и нажмите «Продолжить». " +
                  "Запись не сделана, ход не потерян."
                : e && e.relay === "notion" || networkish(raw)
                  ? "Notion не ответил: сеть или блокировка запроса. Запись не сделана."
              : "Шаг прервался на записи в Notion.";
      pause(
        `Цикл остановлен. ${plain} Ход не потерян: очередь и карточка на месте, ` +
          `после «Продолжить» скрипт перечитает ответ.\nТехнически: ${raw}`,
        { kind: "error" },
      );
    } finally {
      busy = false;
      stepRestarts = 0;
      setStatus();
    }
  }

  // ───────────────────────────── старт ─────────────────────────────
  // Счётчик охватывает также проход, который сторож busy уже освободил,
  // и фоновые асинхронные операции. Переключение ждёт их завершения.
  const originalProjectTick = tick;
  tick = (...args) => trackProjectTask(originalProjectTick(...args));
  const originalProjectQuestions = refreshQuestions;
  refreshQuestions = (...args) => (!projectApproved() || projectHeld())
    ? Promise.resolve(openQuestions().rows) : trackProjectTask(originalProjectQuestions(...args));
  const originalProjectDecisions = refreshDecisions;
  refreshDecisions = (...args) => (!projectApproved() || projectHeld())
    ? Promise.resolve(openDecisions().rows) : trackProjectTask(originalProjectDecisions(...args));
  const originalProjectPollFlush = flushPollJournal;
  flushPollJournal = (...args) => trackProjectTask(originalProjectPollFlush(...args));

  entries = (GM_getValue(K.log, []) || []).slice(-C.maxLog);
  const boot = () => {
    migrateState();
    // Автоцикл не наследуется от прошлого запуска браузера: сначала — руками.
    autoForgetPersisted();
    mount();
    if (ACTIVE_PROFILE.invalid) log("Проект вкладки недоступен. Проверьте sessionStorage и список профилей; Relay автоматически не подставлен.", true);
    if (debugOn()) {
      installDebugApi();
      console.info(
        `[Relay ${SCRIPT_VERSION}] отладка включена на ${location.pathname}. ` +
          "Снимок: __relay.state(); шаг: __relay.step(); выключить: __relay.debug(false) или кнопка 🐞.",
      );
      dbg("boot", () => debugSnapshot());
    }
    if (new URL(location.href).searchParams.has("cf-auto")) {
      const clean = new URL(location.href);
      clean.searchParams.delete("cf-auto");
      history.replaceState(null, "", clean.toString());
      if (projectApproved() && !projectHeld() && !GM_getValue(K.paused, "")) {
        autoSet(true);
        log("Автоцикл включён через ссылку — только для этой вкладки.");
      } else log("Автозапуск по ссылке пропущен: проверьте допуск, удержание и сохранённую паузу.", true);
    }
    setStatus();
    setup(false);
    setInterval(() => tick(false), C.tickMs);
    // Вернулись во вкладку — не ждём очередного тика: в фоне таймеры режутся,
    // и без этого следующая проверка могла бы случиться через минуту.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick(false);
    });
    if (GM_getValue(K.step, false) && !projectHeld()) {
      GM_setValue(K.step, false);
      log("Открыл страницу роли — выполняю отложенный шаг.");
      tick(true);
      return;
    }
    tick(false);
  };
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot, { once: true });
})(GM_getValue, GM_setValue);
