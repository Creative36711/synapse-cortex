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

    // Имя миссии, её id, ссылка на ТЗ и номер круга — данные Мастера, а не
    // инструкции. 08.11 в 00:24 боевой SYN-3 встал ровно здесь: один URL ТЗ
    // (?pvs=4, 256 знаков) плюс длинное имя миссии дали 292 из 3200, и промпт не
    // собрался, хотя правила Координатора были целы. Бюджет overhead по D-034
    // защищает от раздувания инструкций, а не от длины данных; тот же приём уже
    // применён к зоне роли (D-036/D-038: «зона — verbatim-факт»). Общий предел
    // при этом не отменён: `delivery.hardLimit` считает весь текст целиком,
    // поэтому переезд фактов в verbatim ничего не ослабляет.
    def("identity.mission", { verbatim: true, render: (c) => [
      `Миссия: ${c.mission?.name || c.mission?.id}.`,
      `mission_id: ${c.mission?.id}`,
      c.turnId ? `turn_id: ${c.turnId}` : "",
      c.mission?.tzUrl ? `ТЗ: ${c.mission.tzUrl}` : "",
      Number.isFinite(c.mission?.round) ? `Круг: ${c.mission.round} (предел доработок ${c.mission.reworkLimit ?? 3}).` : "",
    ].filter(Boolean).join("\n") });

    def("repo.target", { version: 3, ruleIds: ["R-PR"], render: (c) => {
      const base = c.target?.baseBranch || "main";
      return [
        `Цель ${c.target?.repo}@${base}` + (c.target?.startSha ? `, SHA ${c.target.startSha}` : "") + ". Клон бывает shallow: пустой merge-base не доказательство; проверь --is-shallow-repository; PR без общей истории удалит чужие файлы.",
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
      "Зона роли — рамка, Scope расширяет на ход; чужие зоны читай. Оракул не ослаблять. Неоднозначность — сам, обратимо, «Допущение:» в отчёт. Секреты не в чат/логи/Git. Показ файлов не открывай." });

    def("authority.executor", { version: 2, ruleIds: ["R-ROLES"], audience: ["Executor"], render: () =>
      "Исполнитель: правишь зону+Scope, PR мержишь сам. Чужая правка — карточкой владельцу." });

    def("authority.auditor", { ruleIds: ["R-ROLES", "R-VERIFY-GITHUB"], audience: ["Auditor"], render: () =>
      "Аудитор: только чтение и проверка; ни ветки/коммита/пуша/PR. Находки — в отчёт, чинит исполнитель. Новые проверки можно, ослаблять нельзя." });

    // D-082: «Обратную связь» заполняет транспорт, а не Координатор.
    //
    // 09.11 он дважды создал предложение прямо в базе и считал, что спросил
    // Warden. Строка лежала без «Статуса» и с UUID в «Миссии» — транспорт её не
    // узнавал, приёмка не получала ничего. Дело было не в формате маркера, а в
    // том, что зона Координатора описана как «решения в Notion» без границы.
    def("authority.coordinator", { version: 2, ruleIds: ["R-ROLES", "R-QUEUE", "R-NO-REVIEWER-DISPATCH", "R-MASTER-ONLY", "R-D028"], audience: ["Coordinator"], render: () =>
      "Координатор: решения в Notion; код/ветки/PR не твоя зона, git не нужен. Очередь твоя: нарезка, Кому, Sequence, Ready, Draft→Ready, Submitted, Accepted/Rework. «Обратную связь» руками не пиши — только вопрос полем маркера, запись делает транспорт. Оракул миссии не менять — нужен ADR и решение приёмки/Мастера. «Роли»: у неадминских строк Зона записи/Гейт/Репозиторий/Функция — твои по решению приёмки; Статус, Agent URL, Agent Admin и удаление — Мастер." });

    // D-087: «ни документы» — причина, по которой ТЗ 1.6/1.7 и очередь 1.8/1.9 не
    // появились. 09.11 Warden объявил две редакции в ответе, но публиковать их не
    // стал; формулировка ниже запрещала правку документов безусловно, а `role.zone`
    // (его же поле «Зона записи» в «Ролях») разрешал их писать. Два правила об одном
    // предмете: запрет — во властном блоке, разрешение — в описательном. Побеждает
    // запрет, потому что он рядом с перечнем того, что нельзя трогать вообще.
    //
    // Теперь граница проведена по предмету, а не по типу файла: чужая работа
    // (код, карточки, постановка) — не трогать; документы процесса в репозитории
    // своей роли — единственный выход, кроме вердикта. Без этого запрета ревьюер
    // не может выполнить собственную зону, и его отчёт противоречит его правилам.
    def("authority.reviewer", { version: 2, ruleIds: ["R-ROLES", "R-VERIFY-GITHUB", "R-MASTER-ONLY", "R-D028", "R-DOCS"], audience: ["Reviewer"], render: (c) =>
      c.kind === "arbiter"
        ? "Ты приёмка (Reviewer) и сейчас арбитр: не правь чужую работу — ни код, ни карточки, ни постановку, ни документы процесса. Твой выход — решение по карточке или остановка цикла. Проверяй по GitHub, Notion и фактам, а не по словам агента; Мастера зовёшь только там, где без него физически нельзя."
        : "Ты приёмка (Reviewer): не правь чужую работу — ни код, ни карточки, ни постановку. Документы процесса в репозитории своей роли (`docs/missions/**`, `docs/handoff/**`, `docs/DECISIONS.md`) — твоя зона: объявил редакцию — опубликуй её отдельным PR до выдачи карточек. Выход: вердикт (accept/rework/master), ответ или эта публикация. Проверяй по GitHub и фактам. Вопрос агента закрываешь вместо Мастера; Мастер — только где без него нельзя." });

    def("git.executor", { version: 2, ruleIds: ["R-GIT"], audience: ["Executor"], render: (c) => {
      const base = c.target?.baseBranch || "main";
      return `GIT: fetch origin; merge-base HEAD origin/${base}; status --short (чужое не трогай/не сбрасывай). Закреплённую ветку не меняй; новую — только если разрешено. Коммит своих путей; пуш в разрешённую ветку; gh pr create --fill --base ${base}; gh pr merge <N> --squash. Direct push в ${base} запрещён. Нет изменений — "pr":null.`;
    } });

    // D-087: у приёмки был запрет на правку документов и не было ни одного блока,
    // который говорит, как их публиковать. Публикация редакции — это ветка и PR,
    // то есть ровно тот git-порядок, который исполнитель получает, а приёмка нет.
    def("git.docs", { version: 2, ruleIds: ["R-GIT", "R-DOCS"], audience: ["Reviewer"], render: (c) => {
      const base = c.target?.baseBranch || "main";
      const repo = c.target?.repo || "репозиторий документов";
      return `ПУБЛИКАЦИЯ РЕДАКЦИИ в ${repo}: ветка от origin/${base}; правь только ` +
        "docs/missions/**, docs/handoff/**; подними номер в шапке файла (ТЗ N.M, редакция N.M) — ключ сверки; " +
        `коммит, пуш, gh pr create --fill --base ${base}, gh pr merge <N> --merge. Direct push в ${base} запрещён. ` +
        "Карточки по неопубликованной редакции не выдаются.";
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

    // D-080: у вопроса два режима, и разница между ними названа прямо.
    //
    // До 1.14.8 любой вопрос останавливал ход: промпт обещал «работа идёт по
    // default», а транспорт переключал цикл на приёмку. Плюс поле `hours` со
    // сроком, которое ничего не решало (приёмка отвечает за один ход) и создавало
    // третью модель «молчание = решение». Теперь:
    //   • обычный вопрос — ход ИДЁТ ДАЛЬШЕ по default, ответ придёт следующим
    //     промптом (у исполнителя — в его же карточке, блок answers.mine);
    //   • `gate: true` — ход стоит, пока не ответят; для случая «без этого
    //     мнения следующий шаг невозможен». Ставить только тогда: это остановка.
    // Сроков нет: открытый вопрос остаётся открытым, пока на него не ответят.
    // D-082: «вопрос» здесь — это поле маркера, а не строка в базе.
    //
    // 09.11 Координатор дважды понял иначе: создал предложения прямо в
    // «Обратной связи» руками и решил, что спросил Warden. Не дошло ни одно —
    // и не могло: транспорт видит только маркер хода, а строку, написанную
    // руками, он находит лишь затем, чтобы подписать и передать приёмке.
    // Поэтому первая фраза теперь называет канал явно, а «не пиши руками» —
    // отдельным запретом, а не следствием из формата.
    def("questions.protocol", { version: 4, ruleIds: ["R-QUESTIONS"], render: (c) => [
      'Обратная связь — question в маркере {"text","options","default","gate","need"}; default обязателен, пиши его целиком (длина не ограничена); ≤1/ход; ответ строкой. Вопрос ход НЕ держит; gate+need — ход ждёт этой роли, ответ вернётся. Опрос в чате — остановка, не делай.',
      // D-082: клауза только Координатору.
      //
      // Правило общее, но нарушил его он один: 09.11 создал два предложения
      // прямо в «Обратной связи» и считал, что спросил Warden. Держать запрет в
      // общем блоке не вышло — карточка исполнителя упирается в свой бюджет
      // (2800) на каждом знаке, а платили бы все роли за промах одной. У
      // Координатора запас есть, и запрет стоит там, где его и нарушают.
      c.role?.fn === "Coordinator" ? " Обратную связь в Notion руками не пиши — только этим полем, запись делает транспорт. Срочно нужен ответ роли — question с need:\"<роль>\", не next:\"blocked\"." : "",
    ].filter(Boolean).join("") });

    def("adr.protocol", { ruleIds: ["R-QUESTIONS"], render: () =>
      "Контракт/оракул — только через question «ADR:» (3 варианта, default «оставить как есть»); до решения приёмки не меняется. proposed-файл: вопрос со ссылкой; статус accepted/rejected после ответа." });

    def("phases.bans", { ruleIds: ["R-PHASES"], render: () =>
      "Фазы 0–4: без платежей/каталога/загрузки/аккаунтов до их фаз; без запуска кода пользователей; без доли/валюты/комиссии; без платной инфра без лимита; ядро не open source без OSI; без пустых сервисов." });

    def("i18n.rule", { ruleIds: ["R-I18N"], audience: ["Executor"], render: () =>
      "i18n: 8 локалей (en,ru,zh-Hans,ja,pt-BR,de,fr,ko); текст только в каталогах; диагностика код+параметры; локаль не меняет правил." });

    def("card.fields", { ruleIds: ["R-CARD-FIELDS"], audience: ["Executor", "Auditor"], render: () =>
      "Поля карточки (Dispatch State, Run ID, Output Drive File ID, Recipient Agent ID, Started At, Submitted At, PR, Check) ставит скрипт; отчёт — поле report маркера." });

    def("answers.delta", { verbatim: true, render: (c) => [c.queue?.answersLine, c.queue?.openLine, c.queue?.answerLine].filter(Boolean).join("\n") });

    // D-080: ответ на СВОЙ вопрос приходит тому, кто его задал.
    //
    // До 1.14.8 ответы уходили только Координатору («Ответы на вопросы» в плане),
    // а исполнитель и аудитор, задав вопрос, ответа не видели вообще — при том
    // что промпт обещал «ответ придёт строкой». Это и была вторая половина
    // противоречия: спрашивать было можно, а узнать ответ — только через
    // Координатора. Блок verbatim: это данные из базы, а не инструкции.
    def("answers.mine", { verbatim: true, audience: ["Executor", "Auditor"], render: (c) => {
      const mine = c.queue?.answersMine;
      if (!mine) return "";
      // Заголовок — не украшение, а бюджет: он стоит в каждой карточке, а
      // `answersMineLine` уже начинает строку словами «Ответы на твои вопросы».
      // Второй заголовок был бы платой за красоту из overhead профиля.
      return mine;
    } });
    def("queue.snapshot", { verbatim: true, render: (c) => [
      c.queue?.summary ? `Очередь: ${c.queue.summary}` : "",
      c.queue?.ready, c.queue?.rework, c.queue?.draft,
    ].filter(Boolean).join("\n") });
    def("queue.drafts", { verbatim: true, render: (c) => c.queue?.draft || "" });

    def("queue.coordinator", { ruleIds: ["R-QUEUE", "R-NO-REVIEWER-DISPATCH"], audience: ["Coordinator"], render: () =>
      "Running ставит транспорт и вернёт в Ready сам — не перевыдавай. Running/Submitted — движок; Accepted/Rework/Ready — ты. Черновики правь под оракул, выдавай сам. Дубль номера правь, не создавай. Dependency — UUID этой миссии, Accepted, без Check=fail. Rework — для той же карточки: Rework + та же карточка в Ready (тот же Sequence), новую не создавай. Новая карточка — только если находка шире старой (новый оракул, другой Scope). Check=fail НЕ ставь Rework+Ready одним ответом (жди снимка и разбора Warden). Ready с меньшим Sequence не обходи. Scope покрывает артефакты оракула. Reviewer карточку не выдавай. Ход: Submitted→Accepted/Rework + выдай Ready/Draft; пусто — не ход. Выполнено — «Итог» + next:\"done\". Состав ролей сверяй до выдачи: причина в скобках («нет в «Ролях»», «Ждёт», «нет Agent URL») — не выдадут. Строку правишь ты, Статус/Agent URL — Мастер, агента создаёт Agent State = запрошен." });

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
      // D-082: одна запись за ход — это предел хода, а не незнание. Строка ниже
      // говорит приёмке, что за этой записью стоят ещё, и называет, где список:
      // иначе «пришло одно» читается как «больше ничего не было».
      Number(c.question?.pending) > 1
        ? `В очереди приёмки ещё ${c.question.pending - 1} — придут следующими ходами, по одной. Полный список — база «Обратная связь», Статус «Ждёт».`
        : "",
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
      // D-093: короткий вариант нужен не только продолжению после лимита
      // инструментов, но и повтору после ошибки Arena (`compact`). У вопроса,
      // приёмки и арбитража повтора раньше не было вовсе — они падали на фактах
      // карточки; теперь он есть, а профиль continuation.* держит overhead 700,
      // в который полный текст маркера не влезает (815).
      if (c.delivery?.tier === "tool_limit" || c.delivery?.tier === "compact" || c.delivery?.tier === "retry") return [
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
      if (c.delivery?.tier === "tool_limit" || c.delivery?.tier === "compact" || c.delivery?.tier === "retry") return [
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
      if (c.delivery?.tier === "tool_limit" || c.delivery?.tier === "compact" || c.delivery?.tier === "retry") return [
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
      "Одобряй только создание/замену неадмин-ролей из списка. Нельзя одобрять админ-роли, удаление строк, ручную активацию и изменение прав. Сомнительного кандидата не включай. Архивация старого агента — внутреннее следствие replace, отдельной команды нет. Процессные поля неадминской строки — Зона записи, Гейт, Репозиторий, Функция — одобряй сам: это постановка, а не права (D-092)." });
    def("provision.candidates", { audience: ["Coordinator", "Reviewer"], verbatim: true, render: (c) =>
      `Кандидаты:\n${JSON.stringify((c.provision?.candidates || []).map((x) => ({
        role_page_id: x.rolePageId, role_name: x.roleName, fn: x.fn, repo: x.repo, action: x.action,
      })))}` });
    def("provision.policy", { audience: ["Coordinator", "Reviewer"], render: (c) =>
      `Верни только одобренные jobs (не больше ${c.provision?.maxJobs ?? 3}). Пустой jobs допустим. role_page_id бери из списка, role_name и repo — точно из свежей строки. action только create или replace. Ответ заверши одним маркером CF_AGENT_PROVISION_RESULT.` });
    // D-073: передача хода Maintainer'у. Это не карточка и не миссия: факты —
    // инцидент, класс причины и сборка. Переписки в блоке нет: контекст
    // собирает транспорт, а не чат.
    def("heal.brief", { verbatim: true, audience: ["Maintainer"], render: (c) => {
      const h = c.heal || {};
      return [
        `Инцидент транспорта: ${h.cls || h.kind || "остановка"} · ${h.why || ""}`,
        `Вид паузы: ${h.kind || "пусто"}; карточка ${h.ref || "—"}; run ${h.runId || "—"}; ход ${h.turnId || "—"}.`,
        `Сборка: ${h.version || "?"} @ ${h.fingerprint || "без отпечатка"}.`,
        h.reason ? `Причина остановки: ${h.reason}` : "",
        h.telemetry ? `Телеметрия: ${h.telemetry}` : "",
      ].filter(Boolean).join("\n");
    } });
    def("heal.protocol", { ruleIds: ["R-EVIDENCE"], audience: ["Maintainer"], render: () => [
      "Ты разбираешь поломку транспорта, а не работу по миссии. Ничего не коммить, не устанавливай и не меняй карточки: по D-027 результат — предложенный дифф, проба «до/после» и версия.",
      "Первой строкой ответа — вердикт: FIXED <что именно исправлено и в какой сборке> либо NOTFIXED <почему не берёшься>. Без вердикта ход не продолжается.",
      "Если чинить нечего (капча, вход в Arena, сбой сайта) — NOTFIXED и причина: это не поломка транспорта.",
    ].join("\n") });

    def("marker.provision", { audience: ["Coordinator", "Reviewer"], ruleIds: ["R-MARKER"], render: (c) => [
      "Маркер — последней строкой. Команды archive/delete/activate/admin как отдельные команды запрещены.",
      `CF_AGENT_PROVISION_RESULT {"request_id":"${c.provision?.requestId}","jobs":[],"reason":"краткое обоснование"}`,
    ].join("\n") });

    return B;
  })();
