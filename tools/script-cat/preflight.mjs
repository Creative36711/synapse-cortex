// Проверка перед push — одна для всех ролей.
//
//   node tools/script-cat/preflight.mjs
//   node tools/script-cat/preflight.mjs --zone "tools/script-cat/**"
//   node tools/script-cat/preflight.mjs --json          (для машинного разбора)
//
// Возвращает 0, если можно пушить, и 1, если есть хотя бы один блокер.
// Правила, которые здесь проверяются, описаны в docs/agents/pr-rules.md.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const zoneIndex = argv.indexOf("--zone");
const zone = zoneIndex >= 0 ? argv[zoneIndex + 1] : null;

const checks = [];
const add = (id, title, ok, detail) => checks.push({ id, title, ok, detail });

const git = (args, { optional = false } = {}) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
};

const hasCommit = (ref) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { optional: true }) !== null;

// Изменённые файлы: закоммиченные относительно origin/main плюс ещё не закоммиченные
// и новые — preflight гоняют и до коммита, поэтому смотреть только на HEAD мало.
const changedFiles = () => {
  const set = new Set();
  if (hasCommit("origin/main")) {
    for (const f of git(["diff", "--name-only", "origin/main"]).split("\n")) if (f) set.add(f);
  }
  for (const line of git(["status", "--porcelain"]).split("\n")) {
    const f = line.slice(3).trim();
    if (f) set.add(f.includes(" -> ") ? f.split(" -> ")[1] : f);
  }
  return [...set];
};

// 1. Клон не усечён. В усечённом клоне `rev-list HEAD..origin/main` показывает 0
//    даже когда main давно ушёл вперёд: история обрывается на своём же коммите.
//    Это и был источник «несвязанных историй» и add/add-конфликтов.
const shallow = git(["rev-parse", "--is-shallow-repository"], { optional: true }) === "true";
const shallowFile = join(root, ".git", "shallow");
let shallowCount = 0;
if (existsSync(shallowFile)) {
  shallowCount = readFileSync(shallowFile, "utf8").split("\n").filter(Boolean).length;
}
add(
  "shallow",
  "клон не усечён",
  !shallow,
  shallow
    ? `клон shallow (${shallowCount} граничных коммитов) — git видит только свою историю. Починить: git fetch --unshallow origin`
    : "история полная",
);

// 2. Ветка не отстала от origin/main.
if (!hasCommit("origin/main")) {
  add("behind", "ветка не отстала от origin/main", false, "нет ref origin/main — выполните git fetch origin main");
} else {
  const behind = Number(git(["rev-list", "--count", "HEAD..origin/main"], { optional: true }) || "0");
  add(
    "behind",
    "ветка не отстала от origin/main",
    behind === 0,
    behind === 0 ? "main влит или совпадает" : `в origin/main ${behind} коммитов, которых нет в ветке — git merge origin/main`,
  );
}

// 3. Бандл собран из текущих исходников.
let buildOk = true;
let buildDetail = "";
try {
  buildDetail = execFileSync(process.execPath, [join(here, "build.mjs"), "--check"], { cwd: root, encoding: "utf8" }).trim();
} catch (error) {
  buildOk = false;
  buildDetail = `${(error.stdout || "") + (error.stderr || "")}`.trim() || "build --check упал";
}
add("bundle", "relay.user.js собран из src/**", buildOk, buildDetail.split("\n")[0] || "ok");

// 4. Ровно одно новое решение и его ключ есть в контракте.
const decisionsPath = join(root, "docs", "DECISIONS.md");
const contractPath = join(here, "contracts", "agent-protocol.json");
let decidedOk = true;
let decidedDetail = "";
try {
  const base = hasCommit("origin/main") ? git(["show", "origin/main:docs/DECISIONS.md"], { optional: true }) : null;
  const now = existsSync(decisionsPath) ? readFileSync(decisionsPath, "utf8") : "";
  const nums = (text) => new Set([...(text || "").matchAll(/^##\s+(D-\d+)/gm)].map((m) => m[1]));
  const before = base ? nums(base) : new Set();
  const current = nums(now);
  const added = [...current].filter((n) => !before.has(n));
  const removed = [...before].filter((n) => !current.has(n));
  const contract = existsSync(contractPath) ? JSON.parse(readFileSync(contractPath, "utf8")) : {};
  const keys = Object.keys(contract).filter((k) => /^d\d{3}$/.test(k));
  const missing = added.filter((n) => !keys.includes(`d${n.slice(2)}`.toLowerCase()));
  if (removed.length) {
    decidedOk = false;
    decidedDetail = `решения пропали из DECISIONS.md: ${removed.join(", ")} — проверьте merge (нужен union)`;
  } else if (added.length > 1) {
    decidedOk = false;
    decidedDetail = `в одном PR ${added.length} решений: ${added.join(", ")} — один PR = одно решение`;
  } else if (missing.length) {
    decidedOk = false;
    decidedDetail = `решение ${missing.join(", ")} не заведено в contracts/agent-protocol.json`;
  } else {
    decidedDetail = added.length ? `новое решение ${added[0]}` : "новых решений нет";
  }
} catch (error) {
  decidedOk = false;
  decidedDetail = `не удалось сверить решения: ${error.message}`;
}
add("decisions", "ровно одно решение, ключ в контракте", decidedOk, decidedDetail);

// 5. Версия поднята только вместе с правкой src/**.
let versionOk = true;
let versionDetail = "версия не менялась";
try {
  if (hasCommit("origin/main")) {
    const changed = changedFiles();
    const srcTouched = changed.some((f) => f.startsWith("tools/script-cat/src/"));
    const headerPath = join(here, "src", "00-header.js");
    const header = existsSync(headerPath) ? readFileSync(headerPath, "utf8") : "";
    const nowVersion = (header.match(/@version\s+([\d.]+)/) || [])[1] || "?";
    let baseVersion = "";
    try {
      const baseHeader = git(["show", "origin/main:tools/script-cat/src/00-header.js"], { optional: true }) || "";
      baseVersion = (baseHeader.match(/@version\s+([\d.]+)/) || [])[1] || "";
    } catch {
      baseVersion = "";
    }
    if (baseVersion && nowVersion !== baseVersion && !srcTouched) {
      versionOk = false;
      versionDetail = `версия ${baseVersion} → ${nowVersion} поднята без правки src/** — версию поднимает только выпуск транспорта`;
    } else if (srcTouched && baseVersion && nowVersion === baseVersion) {
      versionOk = false;
      versionDetail = `правка src/** без подъёма версии (${nowVersion})`;
    } else {
      versionDetail = srcTouched ? `версия ${baseVersion || "?"} → ${nowVersion}` : `версия ${nowVersion}, src/** не менялся`;
    }
  }
} catch (error) {
  versionOk = false;
  versionDetail = `не удалось сверить версию: ${error.message}`;
}
add("version", "версия поднята только с правкой src/**", versionOk, versionDetail);

// 6. Файлы вне зоны роли.
if (zone) {
  const globToRegExp = (glob) =>
    new RegExp(
      "^" +
        glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\u0000")
          .replace(/\*/g, "[^/]*")
          .replace(/\u0000/g, ".*") +
        "$",
    );
  const re = globToRegExp(zone);
  const changed = changedFiles();
  const outside = changed.filter((f) => !re.test(f));
  add("zone", `только своя зона (${zone})`, outside.length === 0, outside.length ? `вне зоны: ${outside.join(", ")}` : `${changed.length} файлов, все в зоне`);
}

// 7. Маркеров конфликта нет ни в одном отслеживаемом файле.
let conflictOk = true;
let conflictDetail = "маркеров нет";
try {
  const files = git(["ls-files"]).split("\n").filter(Boolean);
  const hits = [];
  for (const f of files) {
    if (f === "tools/script-cat/relay.user.js") continue;
    const full = join(root, f);
    if (!existsSync(full)) continue;
    // Маркер git стоит в начале строки; строка вида "<<<<<<< HEAD" внутри кода — не конфликт.
    if (/^<{7} /m.test(readFileSync(full, "utf8"))) hits.push(f);
    if (hits.length >= 5) break;
  }
  if (hits.length) {
    conflictOk = false;
    conflictDetail = `маркеры конфликта в: ${hits.join(", ")}`;
  }
} catch (error) {
  conflictOk = false;
  conflictDetail = `не удалось проверить маркеры: ${error.message}`;
}
add("conflicts", "нет маркеров конфликта", conflictOk, conflictDetail);

const failed = checks.filter((c) => !c.ok);
if (asJson) {
  console.log(JSON.stringify({ root, zone, ok: failed.length === 0, checks }, null, 2));
} else {
  console.log(`preflight: ${relative(process.cwd(), root) || "."}${zone ? `  зона: ${zone}` : ""}`);
  for (const c of checks) {
    const mark = c.ok ? "ok  " : "FAIL";
    console.log(`  ${mark}  ${c.title} — ${c.detail}`);
  }
  console.log(failed.length === 0 ? "\nможно пушить" : `\nблокеров: ${failed.length} — push не делать`);
}
process.exit(failed.length === 0 ? 0 : 1);
