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
      blocks: ["identity.task", "repo.target", "repo.boundary", "role.zone", "authority.core", "authority.executor", "git.executor", "evidence.rule", "card.fields", "drive.artifacts", "task.intent", "task.invariants", "task.acceptance", "task.scope", "task.freedom", "task.assignment", "answers.mine", "questions.protocol", "adr.protocol", "phases.bans", "i18n.rule", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["queue.coordinator", "review.protocol", "pilot.brief", "pilot.stop"],
      budget: { overhead: 2800 },
    });
    def("auditor.card", {
      audience: ["Auditor"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "repo.boundary", "role.zone", "authority.core", "authority.auditor", "git.auditor", "evidence.rule", "card.fields", "drive.artifacts", "task.acceptance", "task.scope", "task.assignment", "answers.mine", "questions.protocol", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["git.executor", "queue.coordinator", "pilot.brief"],
      budget: { overhead: 2200 },
    });
    def("coordinator.plan", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["coordinator.prime", "identity.mission", "mission.returned", "plan.note", "repo.boundary", "role.zone", "authority.core", "authority.coordinator", "queue.snapshot", "answers.delta", "queue.coordinator", "drive.layout", "questions.protocol", "adr.protocol", "phases.bans", "marker.coordinator"],
      requiredFacts: ["role.name", "mission.id", "turnId"],
      forbidden: ["git.executor", "git.auditor", "marker.agent", "pilot.brief"],
      // D-092: 3200 → 3400. Прибавка — права Координатора на процессные поля
      // «Ролей» (Зона записи, Гейт, Репозиторий, Функция) по решению приёмки.
      // Это инструкция, а не данные: сжимать её нельзя (D-078), поэтому бюджет
      // поднят явно и записан в контракте, а не выведен из сжатия соседей.
      budget: { overhead: 3400 },
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
      // D-087: `git.docs` — потому что объявленная редакция ТЗ и очереди публикуется
      // веткой и PR, а раньше у приёмки не было ни права, ни порядка это делать.
      blocks: ["identity.mission", "queue.snapshot", "repo.boundary", "role.zone", "authority.core", "authority.reviewer", "git.docs", "evidence.rule", "review.evidence", "review.protocol", "questions.protocol", "marker.review"],
      requiredFacts: ["mission.id", "turnId"],
      forbidden: ["git.executor", "marker.agent", "task.assignment"],
      budget: { overhead: 2400 },
    });
    def("reviewer.answer", {
      audience: ["Reviewer"], marker: "CF_ANSWER_RESULT",
      blocks: ["identity.mission", "authority.reviewer", "git.docs", "answer.question", "answer.protocol", "answer.resume", "marker.answer"],
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

    // D-073: разбор поломки транспорта. Маркера нет осознанно: это не ход
    // роли команды, а передача закулисному Maintainer'у со своим правилом
    // ответа (первая строка — FIXED/NOTFIXED). Рабочие ходы по-прежнему
    // требуют маркер: «приём без маркера» здесь не появляется.
    def("heal.report", {
      audience: ["Maintainer"], marker: null,
      blocks: ["heal.brief", "heal.protocol"],
      requiredFacts: ["role.name", "heal.kind"],
      forbidden: ["identity.task", "identity.mission", "repo.target", "repo.boundary", "role.zone",
        "authority.core", "authority.executor", "authority.auditor", "authority.coordinator", "authority.reviewer",
        "git.executor", "git.auditor", "evidence.rule", "card.fields", "task.intent", "task.invariants",
        "task.acceptance", "task.scope", "task.freedom", "task.assignment", "queue.snapshot", "queue.coordinator",
        "answers.delta", "review.evidence", "review.protocol", "answer.question", "answer.protocol", "answer.resume",
        "questions.protocol", "adr.protocol", "phases.bans", "i18n.rule", "drive.layout", "drive.artifacts",
        "mission.returned", "plan.note", "coordinator.prime", "delivery.retry", "delivery.recovery",
        "delivery.tool_limit", "reminder.marker", "arbiter.case", "arbiter.protocol", "pilot.brief", "pilot.stop",
        "pilot.repo", "pilot.continue", "marker.agent", "marker.coordinator", "marker.review", "marker.answer",
        "marker.arbiter", "marker.provision"],
      budget: { overhead: 900 },
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
      // D-073: разбор транспорта — свой профиль без маркера, не dispatch и не review.
      if (kind === "heal") return "heal.report";
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
