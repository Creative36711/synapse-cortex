// Проба J-2 (D-098): граница зоны роли проверяется транспортом по факту PR,
// а не верой в то, что агент сам не выйдет за зону.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inZone, outsideZone, parseZone, reviewPullRequest } from "./helpers/pr-zone-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..", "..");

test("зона: разбор объявлений из «Ролей»", () => {
  assert.deepEqual(parseZone("tools/script-cat/**"), ["tools/script-cat/"]);
  assert.deepEqual(parseZone("locales/**"), ["locales/"]);
  assert.deepEqual(parseZone("tools/script-cat/**, docs/**"), ["tools/script-cat/", "docs/"]);
  assert.deepEqual(parseZone(""), [], "пустая зона — не зона");
  // Проза без путей машинно не проверяется: префиксов нет.
  assert.deepEqual(parseZone("только чтение и предложение правки"), []);
});

test("зона: путь внутри и снаружи", () => {
  const zone = "tools/script-cat/**";
  assert.ok(inZone("tools/script-cat/preflight.mjs", zone));
  assert.ok(!inZone("docs/DECISIONS.md", zone));
  assert.ok(!inZone("tools/script-cat-evil/x.js", zone), "префикс не должен склеиваться с соседом");
  assert.ok(inZone("docs/anything.md", ""), "зона не задана — не ограничиваем");
  assert.deepEqual(outsideZone(["a/b.js"], ""), [], "пустая зона ничего не запрещает");
});

test("PR в зоне — принимается", () => {
  const r = reviewPullRequest({
    files: ["tools/script-cat/src/19-pull-requests.js", "tools/script-cat/tests/x.mjs"],
    zone: "tools/script-cat/**",
  });
  assert.equal(r.status, "ok");
  assert.match(r.why, /все 2 файлов PR в зоне/);
});

test("PR вышел за зону — не принимается, и видно чем", () => {
  const r = reviewPullRequest({
    files: [
      "tools/script-cat/src/19-pull-requests.js",
      "docs/DECISIONS.md",
      "docs/agents/pr-rules.md",
    ],
    zone: "tools/script-cat/**",
  });
  assert.equal(r.status, "outside");
  assert.deepEqual(r.outside, ["docs/DECISIONS.md", "docs/agents/pr-rules.md"]);
  assert.match(r.why, /вне зоны роли/, "журнал называет причину");
  assert.match(r.why, /docs\/DECISIONS\.md/, "и сами пути");
});

test("длинный список обрезается в журнале, но не в решении", () => {
  const files = Array.from({ length: 9 }, (_, i) => `docs/vne-${i}.md`);
  const r = reviewPullRequest({ files, zone: "tools/script-cat/**" });
  assert.equal(r.outside.length, 9, "решение видит все");
  assert.match(r.why, /и ещё 4/, "журнал — первые пять и счётчик");
});

test("пустой PR при заявке «слит» — это не проверенная работа", () => {
  const r = reviewPullRequest({ files: [], pr: { changed_files: 0 }, zone: "tools/**" });
  assert.equal(r.status, "outside");
  assert.match(r.why, /PR пуст/);
});

test("нет списка файлов — не запрещаем и честно говорим, что не проверили", () => {
  const r = reviewPullRequest({ files: null, pr: {}, zone: "tools/**" });
  assert.equal(r.status, "unknown");
  assert.match(r.why, /не проверил/);
});

test("транспорт зовёт проверку до влития и умеет отличить отказ границы", () => {
  const pr = readFileSync(join(root, "tools/script-cat/src/19-pull-requests.js"), "utf8");
  const claim = pr.slice(pr.indexOf("async function claimMerge"));
  assert.match(claim, /await zoneCheck\(/, "проверка вызывается в claimMerge");
  const zoneAt = claim.indexOf("await zoneCheck(");
  const waitAt = claim.indexOf("mergedFlag() || continueButton()");
  assert.ok(zoneAt > 0 && waitAt > zoneAt, "проверка стоит до ожидания бейджа и Continue");
  assert.match(claim.slice(zoneAt, zoneAt + 900), /return "boundary"/, "чужой файл — граница, а не тихий мерж");
  assert.match(claim.slice(zoneAt, zoneAt + 900), /Relay: PR вышел за зону роли/, "Мастер видит событие");
  const fn = pr.slice(pr.indexOf("async function zoneCheck"), pr.indexOf("async function githubRepo"));
  assert.match(fn, /githubPrFiles/, "список файлов спрашивается у GitHub");
  assert.match(fn, /status: "unknown"/, "сеть не превращается в запрет");
});

test("зона едет вместе с выдачей, а не берётся из текущего профиля", () => {
  const polls = readFileSync(join(root, "tools/script-cat/src/17-arena-polls.js"), "utf8");
  assert.match(polls, /targetZone: String\(role\.zone \|\| ""\)/, "зона записана в ожидание и очередь");
  const pr = readFileSync(join(root, "tools/script-cat/src/19-pull-requests.js"), "utf8");
  assert.match(pr, /zone: String\(expect\.targetZone \|\| ""\)/, "dispatchTarget отдаёт зону выдачи");
});
