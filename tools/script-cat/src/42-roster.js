  // ───────────────────────── состав ролей миссии: правила ─────────────────────────
  // D-075 п. 4–6 на языке кода. До первой выдачи карточки транспорт сверяет не
  // только адресата выбранной карточки, но и состав всей миссии: если роль, на
  // которую карточка ссылается, не может взять работу, выдача не начинается —
  // иначе некомплект всплывает в самом дорогом месте, на первой отправке.
  //
  // Здесь только чистые функции: ни DOM, ни GM, ни сети. Их исполняет
  // tests/mission-roster-smoke.mjs, поэтому «гейт» проверяется как решение, а не
  // как текст в журнале.
  //
  // Разделение, ради которого файл существует отдельно от 40-heal-core.js:
  //  • состав — это данные (роль, статус, URL, функция, вариант «Кому»);
  //  • некомплект — это решение Мастера (класс master), а не поломка транспорта;
  //  • поломка доставки остаётся транспорту, и это разные причины.
  const ROSTER_SOURCE = 1;

  /** Пункт проверки: что именно не так с ролью. Возвращает пустой список — роль годна. */
  function rosterRoleGaps(role, { directory = [], recipientOptions = [] } = {}) {
    const gaps = [];
    const name = String(role?.name || "").trim();
    if (!role) return ["роль не названа"];
    if (!name) gaps.push("имя роли пустое");
    // Ищем по всей базе, а не только среди активных: иначе «строка есть, но
    // Статус Ждёт» неотличимо от «строки нет», и Мастер получил бы совет
    // создавать второго агента там, где нужно дозаполнить одного.
    const row = directory.find((r) => norm(r.name) === norm(name)) ||
      (role.status || role.url || role.fn ? role : null);
    if (!row) return [`роли «${name}» нет в «Ролях»`];
    if ((row.status || "") !== "Активна") gaps.push(`Статус «${row.status || "пуст"}»`);
    if (!String(row.url || "").trim()) gaps.push("Agent URL пуст");
    else if (!/^https:\/\/[^\s/]+\/agent\/[\w-]+\/?$/i.test(String(row.url).trim()) &&
      !/^\/agent\/[\w-]+\/?$/.test(String(row.url).trim())) gaps.push("Agent URL не похож на страницу агента");
    if (!row.fn) gaps.push("Функция не задана");
    // «Кому» — только для рабочих ролей: карточку берут Executor и Auditor.
    if (["Executor", "Auditor"].includes(row.fn) && recipientOptions.length &&
      !recipientOptions.some((option) => norm(option) === norm(name))) {
      gaps.push("имени нет в вариантах «Кому»");
    }
    return gaps;
  }

  /**
   * Состав миссии по её карточкам.
   *
   * `cards` — карточки в Draft и Ready (те, что ещё не выданы). Возвращает
   * список ролей, по каждой — годна она или что именно не так, и общий вердикт.
   * Пустая миссия — не некомплект: нарезать очередь вправе Координатор.
   */
  function missionRoster(cards = [], { directory = [], recipientOptions = [] } = {}) {
    const names = [];
    const seen = new Set();
    for (const card of cards || []) {
      const name = String(taskRole(card) || "").trim();
      if (!name || seen.has(norm(name))) continue;
      seen.add(norm(name));
      names.push(name);
    }
    const roles = names.map((name) => {
      const row = (directory || []).find((r) => norm(r.name) === norm(name)) || null;
      const gaps = rosterRoleGaps({ name, ...(row || {}) }, { directory, recipientOptions });
      return { name, fn: row?.fn || "", status: row?.status || "", url: row?.url || "", gaps, ok: gaps.length === 0 };
    });
    const broken = roles.filter((role) => !role.ok);
    return {
      source: ROSTER_SOURCE,
      roles,
      broken,
      ok: broken.length === 0,
      // Ключ некомплекта: только имена и характер дефекта. Ни чисел, ни id —
      // иначе повторная пауза по тому же некомплекту считалась бы новой.
      key: broken.map((role) => `${role.name}:${role.gaps.join(",")}`).sort().join("|"),
    };
  }

  /**
   * Текст паузы — по образцу `blockedReason`: три разных случая тремя разными
   * словами, чтобы Мастер не создавал агента там, где нужно дозаполнить строку.
   */
  function rosterReason(roster, { source = "" } = {}) {
    const broken = roster?.broken || [];
    if (!broken.length) return "";
    const lines = broken.map((role) => {
      const where = source ? ` (${source}, «Кому» = «${role.name}»)` : "";
      if (!role.fn && role.status === "" && !role.url) {
        return `Роли «${role.name}» в базе «Роли» нет${where} — создайте агента в Arena, заполните «Agent URL» и поставьте «Статус» = «Активна».`;
      }
      if (role.status === "Активна" && role.url) {
        return `Роль «${role.name}» активна и «Agent URL» заполнен${where} — проверьте «Функцию» и «Зону записи»: ${role.gaps.join(", ")}.`;
      }
      return `Роль «${role.name}» в «Ролях» есть${where}, но ${role.gaps.join(", ")} — агента создавать не нужно: ` +
        "дозаполните существующую строку (Статус и Agent URL ставит Мастер).";
    });
    return `${lines.join(" ")} Пока состав не укомплектован, ни одна карточка миссии не выдаётся: ` +
      "это нехватка роли, а не поломка транспорта (D-075).";
  }

  /**
   * Гейт выдачи и связь с контуром создания агентов (D-075 п. 3, 5).
   *
   * `provision` — результат `provisionRosterRequest` (см. 31-provision-core.js):
   * контур выключен, кандидат уже запрошен или запрос только что поставлен.
   * Гейт ничего не создаёт: он только не даёт выдать карточку и говорит, чего
   * именно ждём.
   */
  function rosterGate(cards, { directory = [], recipientOptions = [], provision = null } = {}) {
    const roster = missionRoster(cards, { directory, recipientOptions });
    if (roster.ok) return { ok: true, roster, pause: null };
    const text = rosterReason(roster);
    const requested = provision && provision.requested;
    return {
      ok: false,
      roster,
      provision,
      kind: "mission-roster",
      cls: "master",
      reason: requested
        ? `${text} Запрошено создание роли ${provision.requestedNames.join(", ")} — ждём одобрения админ-роли; карточки не выдаются до ответа.`
        : text,
    };
  }
