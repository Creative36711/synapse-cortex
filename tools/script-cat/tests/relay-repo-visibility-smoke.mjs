// Проба 1.14.16 (D-086, 2-я редакция): два репозитория — два разных правила.
//
// Мастер (09.11): «у нас два репозитория, кто к какому подключён, тот может тот и
// править, кто к чему подключён — смотри в Notion в базе «Роли», там есть
// «Репозиторий». `synapse` публичный, `synapse-cortex` приватный».
//
// Что из этого следует механически, и что проверяется здесь:
//   • документы процесса лежат в cortex, а роль может работать в synapse —
//     сверка редакции ТЗ должна читать репозиторий документов, а не сессии;
//   • карточка с полем «Репозиторий» больше не перебивает подключение роли:
//     роль, подключённая к synapse, не получает выдачу в cortex, и наоборот;
//   • телеметрия не уезжает в публичный репозиторий: при сомнении — Drive.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

// ── 1. Репозиторий документов — отдельно от репозитория сессии ───────────────
const cfg = readFileSync(new URL('../src/01-config.js', import.meta.url), 'utf8');
assert.match(cfg, /docsRepo: ""/, 'репозиторий документов задан отдельной настройкой');
assert.match(cfg, /queueDoc: "docs\/handoff\/syn-3-card-queue\.md"/, 'файл редакции задан настройкой');

const adr = readFileSync(new URL('../src/25-legacy-adr.js', import.meta.url), 'utf8');
assert.match(adr, /function docsRepository\(\)/, 'репозиторий документов вычисляется, а не берётся из C.repo');
assert.match(adr, /C\.docsRepo/, 'явная настройка имеет приоритет');
assert.match(adr, /cfn-roles-cache|K\.rolesCache/, 'иначе берётся репозиторий роли-приёмки из «Ролей»');
assert.match(adr, /fn === "Reviewer"[\s\S]{0,80}Warden/, 'владелец документов — роль приёмки');
assert.match(adr, /canonicalTargetRepository\(docsRepository\(\)\)/, 'короткий slug доезжает до owner/repo');
assert.match(adr, /cache\.repo === repo/, 'кеш редакции учитывает репозиторий, а не только файл');

// ── 2. Подключение роли — граница выдачи ────────────────────────────────────
const prs = readFileSync(new URL('../src/19-pull-requests.js', import.meta.url), 'utf8');
assert.match(prs, /function roleRepoVerdict\(targetRepo, role = null\)/, 'правило названо функцией');
assert.match(prs, /не тот, к которому подключена роль/, 'отказ объясняет расхождение словами');
assert.match(prs, /в «Ролях» у /, 'отказ называет объявленный репозиторий роли');
assert.match(prs, /if \(!declared\) return "";/, 'роль без поля «Репозиторий» работает как раньше');
assert.match(prs, /canonicalTargetRepository\(declared, C\.repo\)/, 'сравнение по полному owner/repo, а не по строке');

const answers = readFileSync(new URL('../src/27-review-answers.js', import.meta.url), 'utf8');
assert.match(answers, /roleRepoVerdict\(targetRepo, role\)/, 'гейт стоит перед выдачей карточки');
const at = answers.indexOf('roleRepoVerdict(targetRepo, role)');
assert.ok(at > 0 && at < answers.indexOf('await gateway("createLog"'), 'проверка до создания журнала выдачи');

// ── 3. Телеметрия: публичный репозиторий — не получатель ────────────────────
const heal = readFileSync(new URL('../src/41-heal.js', import.meta.url), 'utf8');
assert.match(heal, /function telemetryRepoPrivate\(repo\)/, 'видимость получателя проверяется');
assert.match(heal, /meta\.private === true/, 'приватность берётся из API, а не из имени');
assert.match(heal, /telemetryPrivacy\.set\(key, false\); \/\/ по умолчанию — не пишем/, 'по умолчанию — не писать');
assert.match(heal, /телеметрия не пишется в публичный репозиторий/, 'отказ назван словами');
assert.match(cfg, /telemetryRepo: ""/, 'получатель не задан по умолчанию — только Drive');

// ── 4. Ни один из путей не пишет в репозиторий проекта ──────────────────────
const upload = heal.slice(heal.indexOf('async function healUpload('), heal.indexOf('async function healPublish('));
assert.ok(!/contents\/\$\{repo\}/.test(upload), 'в репозиторий проекта телеметрия не пишется');
assert.match(upload, /contents\/\$\{encodeURI\(path\)\}/, 'путь пишется по вычисленному адресу получателя');

// ── 5. Две шапки не расходятся ──────────────────────────────────────────────
// D-086/1.14.17: номер ТЗ живёт в двух файлах — в шапке миссии и в шапке очереди.
// Ровно это расхождение и было 09.11: очередь объявляла «ТЗ 1.6», а миссия
// продолжала говорить «Версия ТЗ 1.5». Гейт сверки такой документ считал бы
// опубликованным, потому что читает одну шапку из двух.
{
  const mission = readFileSync(new URL('../../../docs/missions/SYN-3.md', import.meta.url), 'utf8');
  const queue = readFileSync(new URL('../../../docs/handoff/syn-3-card-queue.md', import.meta.url), 'utf8');
  const inMission = mission.match(/Версия ТЗ \*\*(\d+\.\d+)\*\*/);
  // В шапке очередь пишет «ТЗ» между двумя звёздочными парами:
  // «(**редакция 1.8**, **ТЗ 1.6**)» — ищем номер без привязки к выделению.
  const inQueue = queue.slice(0, 1200).match(/ТЗ\s*\**\s*(\d+\.\d+)/);
  assert.ok(inMission, 'в шапке миссии назван номер ТЗ');
  assert.ok(inQueue, 'в шапке очереди назван номер ТЗ');
  assert.equal(inMission[1], inQueue[1], 'номер ТЗ в миссии и в очереди совпадает');
  const declared = queue.slice(0, 1200).match(/редакция\s*\**\s*(\d+\.\d+)/);
  assert.ok(declared, 'в шапке очереди назван номер редакции');
  assert.ok(Number(declared[1]) >= 1.8, 'редакция не откатилась ниже опубликованной');
}

// ── 6. Версия и решения ─────────────────────────────────────────────────────
assert.match(src, /@version\s+1\.14\.1[6-9]/, 'сборка не старее 1.14.16');
const decisions = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');
assert.match(decisions, /## D-086/, 'решение D-086 в журнале');
assert.match(decisions, /synapse-cortex[\s\S]{0,200}приватн|приватн[\s\S]{0,200}synapse-cortex/,
  'различие видимости репозиториев записано, а не подразумевается');

console.log('ok 1 - tests/relay-repo-visibility-smoke.mjs');
