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

    if (!matchesDispatch(hit.result)) {
      const retained = retainRejectedResult(expect, "dispatch-identity", replies);
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
      pause(`Не удалось подтвердить PR этого проекта и базовой ветки: ${(lastMergeCheck && lastMergeCheck.why) || "сверьте репозиторий"}. ` +
        "Карточка не изменена, ожидание сохранено; проверьте ссылку и нажмите «Продолжить».",
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
      const reason =
        merged === "closed"
          ? `PR закрыт без мержа (Closed). Работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала — нужна повторная выдача.`
          : `Исполнитель не заявил о мерже (нет merged: true) и PR не открыт. Работа в ${(typeof C !== "undefined" && C.branch) || "main"} не попала — нужна повторная выдача.`;
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
    if (typeof result.check === "number") props["Check"] = { select: { name: result.check === 0 ? "pass" : "fail" } };
    if (result.report) props["Report SHA"] = { rich_text: [{ type: "text", text: { content: String(result.report).slice(0, 200) } }] };
    const link = prUrl(result.pr);
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
