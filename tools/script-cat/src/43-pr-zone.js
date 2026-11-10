// D-098: зона роли проверяется транспортом по факту PR, а не верой в дисциплину.
//
// Правила PR (D-097) исполняются агентом; Мастер видит только результат и не
// может следить за исполнением. Значит границу зоны должен проверять транспорт:
// у него есть номер PR, зона роли из «Ролей» и GitHub. Разбор — до влития, пока
// чужая правка ещё не вошла в базовую ветку.
//
// Почему не `pulls/{n}/files`: файлы читаются отдельным запросом, а здесь важно
// решить до дорогого пути. Поэтому проверка идёт по тому, что уже под рукой:
// `changed_files` (сколько всего тронуто), `additions`/`deletions` и `title`.
// Точный список путей даёт GitHub-сравнение, и оно подключается, если доступно.

/** Зона вида `tools/script-cat/**` или список через запятую → список префиксов. */
function parseZone(zone) {
  const text = String(zone || "").trim();
  if (!text) return [];
  return text
    .split(/[,;\n]+/)
    .map((part) => part.trim().replace(/^`|`$/g, ""))
    // Прозаическая зона («только чтение и предложение правки») путём не является:
    // судить по ней машинно нельзя, и делать вид, что можно, — хуже, чем не
    // проверять (тот же принцип, что в roleZoneGlobs, D-092).
    .filter((part) => part && /^[\w.@*/-]+$/.test(part) && part.includes("/"))
    .map((part) => part.replace(/^\.\//, ""))
    .map((part) => (part.endsWith("/**") ? part.slice(0, -3) + "/" : part))
    .map((part) => (part.endsWith("*") ? part.slice(0, -1) : part));
}

/** Путь входит в зону? Пустая зона = зона не задана (проверять нечего). */
function inZone(path, zone) {
  const prefixes = parseZone(zone);
  if (!prefixes.length) return true;
  const clean = String(path || "").replace(/^\.\//, "");
  return prefixes.some((prefix) => clean === prefix.replace(/\/$/, "") || clean.startsWith(prefix));
}

/** Файлы вне зоны, в порядке появления. */
function outsideZone(paths, zone) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  return list.filter((path) => !inZone(path, zone));
}

/**
 * Разбор заявки «PR готов» до влития.
 *
 * Возвращает `{ status, why, outside }`:
 * - `ok`      — проверять нечего или всё в зоне;
 * - `outside` — в PR есть файлы вне зоны роли: принимать нельзя, нужна карточка;
 * - `unknown` — данных не хватило (нет файлов), молча пропускаем: врать в
 *   сторону запрета хуже, чем не проверить.
 *
 * `files` — список путей, если он есть (GitHub `pulls/{n}/files` или сравнение).
 * `pr` — объект PR из GitHub: `changed_files` помогает, когда списка нет.
 */
function reviewPullRequest({ files, pr, zone } = {}) {
  const prefixes = parseZone(zone);
  if (!prefixes.length) return { status: "ok", why: "зона роли не задана — границу проверить нечем", outside: [] };
  const known = Array.isArray(files) ? files.map((f) => (typeof f === "string" ? f : f?.filename)).filter(Boolean) : [];
  if (known.length) {
    const outside = outsideZone(known, zone);
    if (outside.length) {
      const shown = outside.slice(0, 5).join(", ");
      const more = outside.length > 5 ? ` и ещё ${outside.length - 5}` : "";
      return {
        status: "outside",
        why: `PR трогает файлы вне зоны роли (${zone}): ${shown}${more}`,
        outside,
      };
    }
    return { status: "ok", why: `все ${known.length} файлов PR в зоне ${zone}`, outside: [] };
  }
  // Списка нет: остаётся счётчик. Ноль изменённых файлов при заявке «слито» —
  // это пустой PR, а не проверенная работа.
  const changed = Number(pr?.changed_files);
  if (Number.isFinite(changed) && changed === 0) {
    return { status: "outside", why: "PR пуст: GitHub не насчитал ни одного изменённого файла", outside: [] };
  }
  return { status: "unknown", why: "список файлов PR недоступен — границу зоны не проверил", outside: [] };
}
