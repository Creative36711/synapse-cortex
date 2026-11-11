  // ───────────────────────── реестр маркеров ─────────────────────────
  // Единый источник имён маркеров и их обязательных ID. Используется
  // компилятором промптов, разбором ответов и генерацией документации,
  // чтобы «какой маркер какой роли» не расходилось между кодом и docs.
  const PROMPT_MARKER_REGISTRY = (() => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const defs = {
      CF_COORDINATOR_RESULT: { kind: "plan", ids: ["mission_id", "turn_id"], role: "Coordinator" },
      CF_AGENT_RESULT: { kind: "dispatch", ids: ["dispatch_id", "run_id"], role: "Executor|Auditor|Reviewer", optional: ["check", "report", "pr", "merged", "question", "artifacts"] },
      CF_REVIEW_RESULT: { kind: "review", ids: ["mission_id", "turn_id"], role: "Reviewer", optional: ["summary", "remarks", "reason", "dispatch_id", "run_id", "question"] },
      CF_ANSWER_RESULT: { kind: "answer", ids: ["question_id", "turn_id"], role: "Executor|Auditor|Coordinator|Reviewer|Maintainer", optional: ["answer", "reason", "question"] },
      // D-053: разбор повторяющейся петли. Карточка и ход названы явно: вердикт
      // арбитра обязан относиться именно к этой выдаче, а не к похожей.
      CF_ARBITER_RESULT: { kind: "arbiter", ids: ["dispatch_id", "turn_id"], role: "Reviewer", optional: ["action", "reason", "fix", "summary", "question"] },
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
