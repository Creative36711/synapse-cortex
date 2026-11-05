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

    def("authority.reviewer", { ruleIds: ["R-ROLES", "R-VERIFY-GITHUB", "R-MASTER-ONLY", "R-D028"], audience: ["Reviewer"], render: () =>
      "Ты приёмка (Reviewer): ничего не правь — ни код, ни карточки, ни документы. Твой выход — вердикт (accept/rework/master) или ответ на вопрос. Проверяй по GitHub и фактам, а не по словам агента. Вопрос агента закрываешь вместо Мастера; зовёшь Мастера только где без него физически нельзя." });

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
      "Очередь: Running ставит транспорт и сам вернёт в Ready без хода — не перевыдавай. Running/Submitted — движок; Accepted/Rework/Ready — ты. Черновики правь под оракул, выдавай сам. Дубль номера правь, не создавай. Dependency — UUID той же миссии, Accepted, без Check=fail. Rework: переделка — в Ready отдельным шагом; Check=fail НЕ ставь Rework+Ready одним ответом (жди снимка и разбора Warden). Ready с меньшим Sequence не обходи молча. Scope покрывает артефакты оракула. Reviewer карточку не выдавай. Ход: Submitted→Accepted/Rework + выдай Ready/Draft; пусто после хода — незаконченный ход. Выполнено — «Итог» + next:\"done\" (передача приёмке). Running в очереди — это работа, которая идёт прямо сейчас. Движок ставит Running и Submitted; Accepted, Rework и Ready ставишь ты." });

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

    const markerJson = (c, name) => {
      if (name === "CF_COORDINATOR_RESULT") return `CF_COORDINATOR_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","status":"completed","next":"<роль|done>"}`;
      if (name === "CF_REVIEW_RESULT") return `CF_REVIEW_RESULT {"mission_id":"${c.mission?.id}","turn_id":"${c.turnId}","verdict":"accept","summary":"<на что опирался>"}`;
      if (name === "CF_ANSWER_RESULT") return `CF_ANSWER_RESULT {"question_id":"${c.question?.id}","turn_id":"${c.turnId || c.question?.turnId}","verdict":"answer","answer":"<решение>"}`;
      const auditor = c.role?.fn === "Auditor";
      return `CF_AGENT_RESULT {"dispatch_id":"${c.task?.id}","run_id":"${c.task?.runId}","status":"submitted","check":0,"report":"<путь>"` + (auditor ? "}" : `,"pr":"<URL|null>","merged":true}`);
    };
    def("marker.agent", { version: 2, ruleIds: ["R-MARKER"], audience: ["Executor", "Auditor", "Reviewer"], render: (c) => {
      if (c.delivery?.tier === "tool_limit") return [
        "Когда ход действительно завершён, сдай полный отчёт и последней строкой CF_AGENT_RESULT с этими IDs.",
        "Если продолжить нельзя — назови блокер, не выдумывай результат.",
        `CF_AGENT_RESULT {"dispatch_id":"${c.task?.id}","run_id":"${c.task?.runId}","status":"submitted"}`,
      ].join("\n");
      // D-036: в маркере аудитора нет pr/merged — не учим его полям, которых
      // у него нет, и экономим overhead под длинную зону роли (K-20).
      const fields = c.role?.fn === "Auditor"
        ? "check:0=pass."
        : "check:0=pass; pr:null если не нужен; merged:true только после мержа.";
      return [
        `ОТВЕТ: полный отчёт, затем последней строкой один маркер текстом (не HTML-комментарий, не вместо отчёта). ${fields} ID из промпта:`,
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
      const ids = c.reminder?.why === "ids";
      return [
        `Техническое напоминание (${c.reminder?.attempt ?? 1} из ${c.reminder?.max ?? 2}; это не задание и не новый ход).`,
        ids ? `Маркер ${c.reminder?.markerName} есть, но в нём нет dispatch_id/run_id этой выдачи. Повтори маркер с ID из этого напоминания; работу не повторяй.`
          : thin ? `В ответе пришёл только маркер ${c.reminder?.markerName}, без отчёта. Маркер без фактов не считается ответом.`
          : `В ответе не хватило последней строки с ${c.reminder?.markerName}.`,
        "Не повторяй сделанное: пришли ответ целиком; маркер — последней строкой, без кода и текста после.",
      ].join("\n");
    } });

    def("pilot.brief", { audience: ["pilot"], verbatim: true, render: (c) => c.pilot?.brief || "" });
    def("pilot.stop", { audience: ["pilot"], render: () =>
      "Финал — отчёт текстом: что сделано, как запущено, артефакты, журнал затруднений и допущения. Командные маркеры не используй." });
    def("pilot.repo", { audience: ["pilot"], render: (c) =>
      `Репо: ${c.pilot?.repo || "Creative36711/synapse"}@${c.pilot?.startSha || "main"}, read-only; запись только в локальный sandbox.` });

    def("delivery.recovery", { render: () =>
      "Это продолжение того же хода после сбоя доставки, не новая задача и не новая выдача. Сохрани все ID. Разбери снимок очереди и продолжи по правилам своей роли." });
    def("mission.returned", { verbatim: true, audience: ["Coordinator"], render: (c) => c.mission?.returned || "" });
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
      return "Продолжи текущий ход после лимита инструментов. Это не новая задача и не повторная выдача.\nНе начинай сначала и не дублируй уже сделанное. Восстанови контекст по своим последним действиям и продолжай только недостающее.";
    } });
    def("identity.continue", { render: (c) => {
      if (c.kind === "plan" || c.kind === "review") return `IDs прежние: mission_id=${c.mission?.id}, turn_id=${c.turnId}.`;
      if (c.kind === "answer") return `IDs прежние: question_id=${c.question?.id}, turn_id=${c.turnId || c.question?.turnId}.`;
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
