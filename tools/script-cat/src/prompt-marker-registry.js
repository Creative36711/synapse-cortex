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
      CF_AGENT_PROVISION_RESULT: { kind: "provision", ids: ["request_id"], role: "Coordinator|Reviewer" },
    };
    const forKind = (kind, roleFn) => {
      if (kind === "plan") return "CF_COORDINATOR_RESULT";
      if (kind === "review") return "CF_REVIEW_RESULT";
      if (kind === "answer") return "CF_ANSWER_RESULT";
      if (kind === "dispatch") return "CF_AGENT_RESULT";
      if (kind === "provision") return "CF_AGENT_PROVISION_RESULT";
      if (kind === "reminder") return null; // reminder наследует маркер исходного хода
      return null;
    };
    const idFields = (name) => (defs[name] ? defs[name].ids.slice() : []);
    const isUuid = (v) => UUID.test(String(v || "").trim());
    return { defs, forKind, idFields, isUuid, names: Object.keys(defs) };
  })();
