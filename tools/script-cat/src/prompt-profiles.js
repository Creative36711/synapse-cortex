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
      blocks: ["identity.task", "repo.target", "repo.boundary", "authority.core", "authority.executor", "git.executor", "evidence.rule", "card.fields", "task.intent", "task.invariants", "task.acceptance", "task.scope", "task.freedom", "task.assignment", "questions.protocol", "adr.protocol", "phases.bans", "i18n.rule", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["queue.coordinator", "review.protocol", "pilot.brief", "pilot.stop"],
      budget: { overhead: 2800 },
    });
    def("auditor.card", {
      audience: ["Auditor"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "repo.boundary", "authority.core", "authority.auditor", "git.auditor", "evidence.rule", "card.fields", "task.acceptance", "task.scope", "task.assignment", "questions.protocol", "marker.agent"],
      requiredFacts: ["role.name", "role.fn", "target.repo", "target.baseBranch", "task.id", "task.runId"],
      forbidden: ["git.executor", "queue.coordinator", "pilot.brief"],
      budget: { overhead: 2200 },
    });
    def("coordinator.plan", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["identity.mission", "mission.returned", "repo.boundary", "authority.core", "authority.coordinator", "queue.snapshot", "answers.delta", "queue.coordinator", "drive.layout", "questions.protocol", "adr.protocol", "phases.bans", "marker.coordinator"],
      requiredFacts: ["role.name", "mission.id", "turnId"],
      forbidden: ["git.executor", "git.auditor", "marker.agent", "pilot.brief"],
      budget: { overhead: 3200 },
    });
    def("coordinator.recovery", {
      audience: ["Coordinator"], marker: "CF_COORDINATOR_RESULT",
      blocks: ["identity.mission", "authority.coordinator", "delivery.recovery", "queue.snapshot", "answers.delta", "marker.coordinator"],
      requiredFacts: ["mission.id", "turnId"],
      forbidden: ["git.executor", "marker.agent", "task.assignment"],
      budget: { overhead: 1500 },
    });
    def("reviewer.mission", {
      audience: ["Reviewer"], marker: "CF_REVIEW_RESULT",
      blocks: ["identity.mission", "queue.snapshot", "repo.boundary", "authority.core", "authority.reviewer", "evidence.rule", "review.evidence", "review.protocol", "questions.protocol", "marker.review"],
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
    def("reviewer.card", {
      audience: ["Reviewer"], marker: "CF_AGENT_RESULT",
      blocks: ["identity.task", "repo.target", "authority.reviewer", "evidence.rule", "task.acceptance", "task.scope", "task.assignment", "marker.agent"],
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
      forbidden: team.flatMap(() => []).concat(["authority.core", "authority.executor", "authority.auditor", "authority.coordinator", "authority.reviewer", "marker.agent", "marker.coordinator", "marker.review", "marker.answer", "questions.protocol", "adr.protocol", "repo.boundary", "phases.bans"]),
      budget: { overhead: 250 },
    });

    // Выбор профиля по kind + role.fn + tier.
    const select = (kind, fn, tier) => {
      if (kind === "pilot") return "pilot.synapse";
      if (kind === "reminder") return "reminder.marker";
      if (kind === "plan") return tier === "recovery" || tier === "compact" ? "coordinator.recovery" : "coordinator.plan";
      if (kind === "review") return "reviewer.mission";
      if (kind === "answer") return "reviewer.answer";
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
