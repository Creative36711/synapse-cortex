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
  const DISPATCH_TOTAL = { Executor: 6500, Auditor: 5500, Reviewer: 7000 };

  /** Выдача рабочей карточки (Executor/Auditor/историческая Reviewer). */
  function executorPrompt(task, role, payload, logId, runId, missionId = "", ctx = {}) {
    const request = {
      kind: "dispatch",
      role: promptRole(role),
      target: promptTarget(ctx),
      task: taskFacts(task, runId, payload, ctx.payloadRef || null, Boolean(ctx.payloadPointer)),
      mission: missionId ? { id: missionId } : undefined,
      delivery: { tier: "full", attempt: 1 },
    };
    const delivery = PromptCompiler.forDelivery(request, {
      softLimit: 6000,
      hardLimit: DISPATCH_TOTAL[role?.fn] || 9000,
      payloadChannel: Boolean(ctx.payloadRef?.fileId),
    });
    if (delivery.strategy === "pause") {
      pause(
        `Промпт не собран (dispatch ${task.id}): ${delivery.error.code} — ${delivery.error.message}. ` +
          `${budgetBreakdownLine(delivery.error)}` +
          "Отправка не выполнялась; исправьте факты/профиль и нажмите «Продолжить».",
        { kind: "prompt-compile", ref: task.id },
      );
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
      queue: { summary: queueSummary, ready, rework, draft: drafts, answerLine, openLine: openQuestions, answersLine: answers },
      delivery: { tier: "full", attempt: 1 },
    }, `plan ${mission.id}`);
    return envelope;
  }
