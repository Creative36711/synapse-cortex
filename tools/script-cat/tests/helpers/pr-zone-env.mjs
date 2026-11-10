// Загрузка чистых функций разбора зоны из src/43-pr-zone.js без сборки бандла:
// файл не трогает DOM, GM_* и сеть, поэтому его достаточно импортировать как есть.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = join(resolve(here, "..", ".."), "src", "43-pr-zone.js");

const dir = mkdtempSync(join(tmpdir(), "pr-zone-"));
const copy = join(dir, "43-pr-zone.mjs");
// В бандле этот файл — часть closure и никаких export не содержит (иначе
// userscript был бы невалидным JS). Для пробы дописываем экспорт сами.
const body = readFileSync(source, "utf8");
writeFileSync(copy, `${body}\nexport { parseZone, inZone, outsideZone, reviewPullRequest };\n`);
const mod = await import(pathToFileURL(copy).href);

export const { parseZone, inZone, outsideZone, reviewPullRequest } = mod;
