// D-046 — регрессия: «pr:null + merged:true» больше не встаёт в Blocked.
//
// Боевой случай: дважды за день (13:05:39 — K-27, 13:50:39 — K-34) цикл
// останавливался с «PR этой выдачи не подтверждён: В маркере нет номера PR…».
// Оба раза агент присылал `"pr":null,"merged":true` — дословно то, что
// предлагал шаблон маркера в промпте. Карточка уходила в Blocked, ожидание
// снималось, Мастер правил статус руками.
//
// Проверяем не только детектор, но и путь: маркер-противоречие попадает в
// лестницу напоминаний `markerMissing(..., "pr-claim")`, карточка и журнал не
// трогаются, а сама проверка PR (repo/base) остаётся нетронутой.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { PromptCompiler, dispatchRequest, reminderRequest } from './helpers/prompt-env.mjs';
import { assertUserscriptVersionContract } from '../version-oracle.mjs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
assertUserscriptVersionContract(src);

// ── 1. Боевой маркер K-34 ────────────────────────────────────────────────────
const K34_MARKER =
  'CF_AGENT_RESULT {"dispatch_id":"4106f0cf-5705-8130-8e38-ed7aec06c27a",' +
  '"run_id":"2fca06ef-6485-4c76-a103-545e135e245e","status":"submitted","check":0,' +
  '"report":"https://drive.google.com/file/d/11pRVwex5gZ2QQx_0mo2lEpLWzGqT1A9B/view",' +
  '"pr":null,"merged":true}';
const k34 = JSON.parse(K34_MARKER.slice(K34_MARKER.indexOf('{')));

// Срез — один непрерывный кусок от hasMergedClaim до конца prMergeConflict.
// Границы берём по объявлениям, а не по первому «};»: наивный срез вырезал
// prDeclined без его новых зависимостей, и неlegacy-путь не проверялся вовсе.
const from = src.indexOf('  const hasMergedClaim = (result) =>');
const endMark = 'prNoneValue(result.pr) && hasMergedClaim(result);';
const to = src.indexOf(endMark, from);
assert.ok(from > -1 && to > from, 'блок разбора pr/merged найден в сборке');
const block = src.slice(from, to + endMark.length);

const load = (legacy) => new Function(
  `let ACTIVE_PROFILE = { legacy: ${legacy}, repos: [{ repo: "Creative36711/synapse" }] };\n` +
    `${block}\nreturn { prMergeConflict, prDeclined, hasMergedClaim };`,
)();

for (const legacy of [false, true]) {
  const env = load(legacy);
  const label = legacy ? 'legacy' : 'неlegacy';
  assert.equal(env.hasMergedClaim(k34), true, `${label}: merged:true прочитан`);
  assert.equal(env.prMergeConflict(k34), true, `${label}: противоречие распознано`);
  // Гвард «не обходить проверку PR» есть только у неlegacy-профиля: в legacy
  // pr:null остаётся заявкой об отказе, но ветка pr-claim ловит маркер раньше —
  // поэтому Blocked не наступает ни в одном профиле.
  assert.equal(env.prDeclined(k34), legacy, `${label}: поведение prDeclined не изменилось D-046`);
  // Причина, по которой это опасно: без лечения такой маркер идёт в проверку PR.
  assert.match(
    src,
    /!ACTIVE_PROFILE\.legacy && hasMergedClaim\(result\)\s*\n\s*\? "В маркере нет номера PR для проверки репозитория и базовой ветки\."/,
    `${label}: projectPrBoundary по-прежнему требует номер PR`,
  );
}

// ── 2. Границы детектора: законные маркеры не задеты ─────────────────────────
const env = load(false);
const cases = [
  ['проверочная без изменений (боевой K-34)', k34, true],
  ['"none" + merged:true', { ...k34, pr: 'none' }, true],
  ['"нет" + merged:true', { ...k34, pr: 'Нет' }, true],
  // Пустая строка — это «поле не заполнено», то есть забывчивость: её держит
  // projectPrBoundary, а не детектор противоречия.
  ['пустой pr + merged:true', { ...k34, pr: '' }, false],
  ['исправленный маркер: pr:null + merged:false', { ...k34, merged: false }, false],
  ['реальный PR + merged:true', { ...k34, pr: 'https://github.com/Creative36711/synapse/pull/17' }, false],
  ['забывчивость: поля pr нет, merged:true', { status: 'submitted', merged: true }, false],
  ['без заявки о мерже', { pr: null }, false],
  ['null', null, false],
];
for (const [name, result, want] of cases) {
  assert.equal(env.prMergeConflict(result), want, `prMergeConflict: ${name}`);
}
// Пропущенный pr остаётся забывчивостью и не оправдывается этим лечением.
assert.equal(env.prDeclined({}), false, 'пропущенный pr — забывчивость');
assert.equal(env.prMergeConflict({}), false, 'детектор не подменяет проверку забывчивости');

// ── 3. Путь: напоминание вместо Blocked, карточка и журнал не трогаются ──────
const branchAt = src.indexOf('prMergeConflict(result))');
assert.ok(branchAt > -1, 'ветка pr-claim в submitExecutor найдена');
const callMark = 'markerMissing(role, expect, "CF_AGENT_RESULT", manual, "pr-claim");';
const callAt = src.indexOf(callMark, branchAt);
assert.ok(callAt > branchAt, 'уходит в напоминание pr-claim');
// Смотрим ровно тело ветки: от условия до закрывающей скобки блока, чтобы
// «дальше по коду» не выдавало себя за саму ветку.
const branch = src.slice(branchAt, callAt + callMark.length);
assert.ok(!/pause\(/.test(branch), 'ветка сама не ставит паузу');
assert.ok(!/notion\(/.test(branch), 'ветка не ходит в Notion: карточка не меняется');
assert.ok(!/appendToJournal/.test(branch), 'ветка не пишет журнал');
assert.ok(!/patch\(/.test(branch), 'ветка не меняет свойства карточки');

const cardReadAt = src.indexOf('const page = await notion("GET"', branchAt);
const blockedAt = src.indexOf('PR этой выдачи не подтверждён', branchAt);
assert.ok(branchAt < cardReadAt, 'проверка стоит до чтения карточки');
assert.ok(branchAt < blockedAt, 'Blocked достижим только после лестницы напоминаний');
assert.ok(
  src.includes('if (role.fn !== "Auditor" && role.fn !== "Reviewer" && prMergeConflict(result)) {'),
  'Auditor/Reviewer не попадают в ветку: у них PR нет по роли',
);

// ── 4. Лестница напоминаний: после исчерпания — обычная пауза marker ─────────
assert.ok(src.includes('why === "pr-claim"'), 'маркер pr-claim обслуживается лестницей напоминаний');
assert.ok(
  src.includes('Relay: маркер противоречит себе'),
  'журнал называет противоречие своим заголовком',
);
assert.ok(
  src.includes('«pr:null» и «merged:true» одновременно после ${C.markerReminders} напоминаний'),
  'после исчерпания напоминаний пауза объясняет, что именно не так',
);
assert.ok(
  /pause\(\s*\n?\(why === "thin"/.test(src) || src.includes('Нужен Мастер: если изменений не было — нужен merged:false, если PR слит — его номер.'),
  'пауза даёт Мастеру обе исполнительные подсказки',
);
assert.ok(src.includes('kind: "marker"'), 'после исчерпания — обычная пауза kind:"marker"');

// ── 5. Промпт: противоречие больше не рождается шаблоном ────────────────────
const exec = PromptCompiler.compile(dispatchRequest('Executor')).text;
assert.match(exec, /"pr":"<URL\|null>","merged":false/, 'шаблон не подсказывает merged:true');
assert.ok(!/"merged":true/.test(exec.slice(exec.indexOf('CF_AGENT_RESULT'))), 'в примере маркера нет литерала merged:true');
assert.match(exec, /без PR pr:null,merged:false/, 'правило связывает pr и merged');
// Формулировка обязана остаться короткой: напоминание целиком влезает в бюджет
// overhead 700 (reminder.marker + marker.agent), и здесь это проверяется явно.
assert.ok(
  exec.length < 3600,
  `правило не раздувает промпт выдачи (сейчас ${exec.length} знаков)`,
);
assert.match(exec, /merged:true только после мержа/, 'merged:true разрешён только после мержа');
// Аудитор не меняет репозиторий — у него в маркере ни pr, ни merged.
const audit = PromptCompiler.compile(dispatchRequest('Auditor')).text;
assert.ok(!/"merged":/.test(audit), 'Auditor: в маркере нет merged');
assert.ok(!audit.includes('"pr"'), 'Auditor: в маркере нет pr');

// ── 6. Напоминание исполнено дословно, влезает в бюджет и не просит переделки ─
const reminder = PromptCompiler.compile(
  reminderRequest('Executor', 'CF_AGENT_RESULT', {
    reminder: { attempt: 1, max: 2, why: 'pr-claim', markerName: 'CF_AGENT_RESULT' },
  }),
);
assert.equal(reminder.ok, true, `напоминание собрано: ${reminder.error?.message || ''}`);
assert.match(reminder.text, /Техническое напоминание \(1 из 2/, 'это напоминание, а не новый ход');
assert.match(reminder.text, /"pr":null и "merged":true разом — так нельзя/, 'противоречие названо');
assert.match(reminder.text, /Изменений не было — "pr":null,"merged":false/, 'дан законный вариант');
assert.match(reminder.text, /Слил свой PR — номер PR и "merged":true/, 'дан второй законный вариант');
assert.match(reminder.text, /Поправь только маркер/, 'работу не заставляют повторять');
assert.ok(!/пришли ответ целиком/.test(reminder.text), 'в этой ветке не требуют весь отчёт заново');

// ── 7. Документация и версия ────────────────────────────────────────────────
const decisions = readFileSync(new URL('../../../docs/DECISIONS.md', import.meta.url), 'utf8');
assert.match(decisions, /## D-046 ·/, 'D-046 записан в решениях');
const protocol = JSON.parse(
  readFileSync(new URL('../contracts/agent-protocol.json', import.meta.url), 'utf8'),
);
assert.ok(protocol.sections?.d046 || protocol.d046, 'в протоколе есть секция d046');

console.log('OK: D-046 — pr:null+merged:true лечится напоминанием, проверка PR и оракул не ослаблены');
