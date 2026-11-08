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

    /**
     * Total-лимит по роли — единственный источник истины.
     *
     * До 1.14.2 предел действовал только на пути выдачи (`DISPATCH_TOTAL` в
     * 21-prompts.js), а план Координатора, приёмка, ответ и напоминание
     * собирались вообще без общего предела: в телеметрии 08.11 боевой план
     * пришёл 7271 знак, и ничто, кроме overhead, его не ограничивало. Значения
     * уже были записаны в `docs/agents/protocol.md:44` («Executor ≤8000,
     * Auditor ≤5500, Coordinator ≤7500, Review ≤7000, Answer ≤6000»), просто
     * код их не применял. Теперь применяет компилятор — на всех путях сразу, а
     * `forDelivery` задаёт свой предел только там, где нужен особый (payload).
     *
     * Лимит не режет данные молча (D-034): при превышении — отказ с причиной,
     * а решение (разбить карточку, убрать повторы) остаётся за ролью.
     */
    const PROMPT_TOTAL = {
      Executor: 8000, Auditor: 5500, Coordinator: 7500, Reviewer: 7000,
      Maintainer: 3600, pilot: 4000,
    };
    // Профиль, у которого предел строже общего по роли: ответ на вопрос
    // содержит сам вопрос целиком (до 12000 знаков, D-072), и «Answer ≤6000» —
    // про инструкции, иначе вопрос не доедет.
    const PROFILE_TOTAL = { "reviewer.answer": 14000, "reviewer.reminder": 1600, "coordinator.recovery": 5000 };

    /** Предел текста для запроса: профиль важнее роли, роль важнее общего. */
    function totalLimit(request, profileId) {
      const c = request || {};
      if (c.delivery?.hardLimit) return c.delivery.hardLimit;
      if (PROFILE_TOTAL[profileId]) return PROFILE_TOTAL[profileId];
      if (/reminder$/.test(profileId || "")) return 1600;
      const fn = c.role?.fn || "";
      if (PROMPT_TOTAL[fn]) return PROMPT_TOTAL[fn];
      // Резервная строка не должна быть больше самого щедрого предела: иначе
      // «неизвестная роль» получила бы больше прав, чем обычный исполнитель.
      return 9000;
    }

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
      // Предел берётся из одного места: компилятор не должен зависеть от того,
      // помнит ли вызывающий передать `delivery.hardLimit`.
      const hard = totalLimit(c, profileId);
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

    return { compile, forDelivery, metrics, hash, reminderMarkerBlock, totalLimit, PROMPT_TOTAL, PROFILE_TOTAL };
  })();
