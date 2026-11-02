/**
 * Структурная проба relay.user.js 1.4.19: журнал, пауза, маркеры, ntfy.
 *
 * Проверяет инварианты, которые легко потерять при правке транспорта:
 *  - журнал ограничен и очищается кнопкой;
 *  - ответ без маркера даёт напоминание, а после лимита — паузу;
 *  - любая видимая ошибка Arena останавливает цикл и ждёт Мастера;
 *  - тихие и громкие пуши разделены, рутина в ntfy не уходит.
 *
 *   node _tools/ScriptCat/tests/relay-error-pause-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// 1. Версия и новый адрес ntfy.
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const version = versionMatch[1];
assert.match(src, /@connect\s+ntfy\.sh/, 'ntfy.sh разрешён в @connect');

// 2. Журнал: ограничен, очищается, счётчик виден.
assert.match(src, /maxLog:\s*200/, 'журнал ограничен 200 записями');
assert.match(src, /entries\s*=\s*entries\.slice\(-C\.maxLog\)/, 'старые записи отбрасываются при записи');
assert.match(src, /GM_getValue\(K\.log, \[\]\) \|\| \[\]\)\.slice\(-C\.maxLog\)/, 'хвост обрезается при загрузке');
assert.match(src, /function clearLog\(\)/, 'есть очистка журнала');
assert.match(src, /GM_setValue\(K\.log, \[\]\)/, 'очистка стирает сохранённый хвост');
assert.match(src, /title="Очистить журнал/, 'кнопка очистки есть в панели');
assert.match(src, /title="Снять ход: очередь, ожидание и карточки в Running/, 'кнопка снятия хода есть в панели');
assert.match(src, /id="\$\{ui\.count\}"/, 'в панели виден размер журнала');

// 3. Пауза — единственная точка остановки.
const pauseFn = src.slice(src.indexOf('function pause('), src.indexOf('function resume('));
assert.match(pauseFn, /GM_setValue\(K\.paused, info\.reason\)/, 'причина паузы видна в статусе');
assert.match(pauseFn, /GM_setValue\(K\.pause, info\)/, 'контекст паузы переживает перезагрузку');
assert.match(pauseFn, /priority: "5"/, 'пауза всегда громкая');
assert.match(pauseFn, /playAlert\(\)/, 'пауза дублируется звуком в браузере');
assert.match(src, /wasAuto: autoOn\(\)/, 'пауза помнит режим, чтобы не включать автоцикл молча');

// 4. Тик: сначала ошибка на экране, потом шаг; пауза не обходится.
const tickStart = src.indexOf('async function tick(');
const tickEnd = src.indexOf('// ───────────────────────────── старт', tickStart);
const tick = src.slice(tickStart, tickEnd);
assert.match(tick, /if \(isPaused\(\)\) \{/, 'пауза блокирует тик');
assert.match(tick, /if \(monitorVisibleErrors\(\)\) return;/, 'ошибка проверяется до любого шага');
assert.ok(tick.indexOf('monitorVisibleErrors') < tick.indexOf('await setup(false)'), 'проверка ошибки идёт первой');
assert.match(tick, /pause\(\s*`Цикл остановлен\. /, 'любое исключение превращается в паузу, а не в тихую запись');
assert.match(tick, /Технически: \$\{raw\}/, 'техническая строка сохраняется для разбора');
assert.doesNotMatch(tick, /Ошибка цикла: \$\{e\.message\}/, 'нечитаемой строки «Ошибка цикла: HTTP 400» больше нет');

// 5. Ошибки на экране: оба источника и защита от повторной паузы.
const monitor = src.slice(src.indexOf('function monitorVisibleErrors()'), src.indexOf('// ───────────────────────────── отправка'));
assert.ok(monitor.length > 0, 'монитор ошибок на месте');
assert.match(monitor, /latestUserMessageAlert\(\)/, 'алерт в последнем сообщении ловится');
assert.match(monitor, /detectVisibleErrorCard\(\)/, 'красная карточка интерфейса ловится');
assert.match(monitor, /alreadyReported\(key\)/, 'одна и та же ошибка не ставит паузу дважды');
assert.equal((monitor.match(/pause\(/g) || []).length, 3, 'алерт (повтор исчерпан и обычный) и красная карточка останавливают цикл');
assert.match(monitor, /Arena второй раз не приняла задание/, 'второй отказ подряд назван причиной паузы');
assert.ok(!monitor.includes('.click('), 'монитор ошибок ничего не нажимает');

// 6. Лестница маркера: напоминание, затем пауза.
const stepSrc = src.slice(src.indexOf('function markerStep('), src.indexOf('function markerReminder('));
const markerStep = new Function(`${stepSrc}\nreturn markerStep;`)();
assert.equal(markerStep(0, 2), 'remind', 'первый ответ без маркера — напоминание');
assert.equal(markerStep(1, 2), 'remind', 'второй ответ — ещё напоминание');
assert.equal(markerStep(2, 2), 'pause', 'после лимита — пауза');
assert.equal(markerStep(3, 2), 'pause', 'лимит не превышается молча');

assert.match(src, /markerIdleMs:\s*20000/, 'напоминание ждёт, пока ответ перестанет расти');
assert.match(src, /markerReminders:\s*2/, 'лимит напоминаний — два');
// 1.4.78: перед лестницей маркера проверяется отказ из-за слитой ветки —
// напоминания в мёртвую ветку ушли бы в никуда.
assert.match(
  src,
  /if \(!hit\) \{[\s\S]{0,1200}?return markerMissing\(role, expect, "CF_AGENT_RESULT", manual\);/,
  'исполнитель без маркера доходит до лестницы после проверки отказа pr_merged',
);
assert.match(src, /staleBranchRefusal\(lastReply\.raw\)/, 'отказ «ветка слита» распознаётся по тексту');
assert.match(src, /retryStaleBranchHandoff\(expect\)/, 'после отказа — одна повторная выдача в чистую ветку');
assert.match(src, /if \(!decision\) return markerMissing\(role, expect, "CF_COORDINATOR_RESULT", manual\)/, 'Координатор без маркера идёт в ту же лестницу');
assert.ok(!src.includes('Координатор ответил без маркера — ждём следующего хода'), 'старая тихая реакция удалена');
const missingFn = src.slice(src.indexOf('async function markerMissing('), src.indexOf('// ───────────────────────── ошибка на экране'));
assert.match(missingFn, /sendToRole\(role, markerReminder/, 'напоминание содержит шаблон маркера');
assert.match(missingFn, /pause\(/, 'после лимита — пауза для Мастера');
assert.match(missingFn, /tries/, 'счётчик попыток хранится в ожидании');
// Действительная отправка напоминания переносит время исходной выдачи, не
// подменяя его временем нового служебного сообщения.
{
  const calls = [];
  const missing = new Function(
    'stillWorking', 'pageReady', 'messagesAfter', 'dbg', 'tail', 'markerRejectHint', 'markerStep',
    'log', 'sendToRole', 'markerReminder', 'C', 'retainRejectedResult', 'pause',
    `${missingFn}\nreturn markerMissing;`,
  )(
    () => false, () => ({ ok: true }), () => [{ id: 'm1', raw: 'отчёт', text: 'отчёт', ended: true }],
    () => {}, (text) => text, () => '', (sent) => sent < 2 ? 'remind' : 'pause',
    () => {}, async (...args) => calls.push(args), () => 'напоминание', { markerReminders: 2 },
    (expect, kind, replies) => { calls.push({expect,kind,replies}); return true; },
    (message, context) => calls.push({message,context}),
  );
  const role = { name: 'Tools' };
  const base = { kind: 'dispatch', ref: 'card', runId: 'run', sentAt: 10_000, tries: 0 };
  await missing(role, { ...base, dispatchSentAt: 10_000 }, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-1)[4].dispatchSentAt, 10_000);
  assert.equal(calls.at(-1)[4].tries, 1);
  assert.equal(calls.at(-1)[4].isDispatchReminder, true, 'служебная выдача не называется заданием после снятия паузы');
  await missing(role, { ...base, dispatchSentAt: 10_000, sentAt: 70_000, tries: 1 }, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-1)[4].dispatchSentAt, 10_000, 'второе напоминание сохраняет начало');
  await missing(role, base, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-1)[4].dispatchSentAt, 0, 'у старого ожидания sentAt может быть от напоминания — не угадываем');
  await missing(role, { ...base, dispatchSentAt: 0 }, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-1)[4].dispatchSentAt, 0, 'неизвестная дата не заменяется вымышленной');
  await missing(role, { ...base, adopted: true }, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-1)[4].dispatchSentAt, 0, 'время ручного поиска ответа не считается отправкой');
  await missing(role, { ...base, tries: 2 }, 'CF_AGENT_RESULT');
  assert.equal(calls.at(-2).kind, 'missing-marker', 'после лимита полный ответ сохраняется');
  assert.equal(calls.at(-2).replies[0].raw, 'отчёт');
  assert.match(calls.at(-1).message, /Копия ответа сохранена локально/);
}
assert.match(src, /const watermark = lastMessageId\(\);/, 'водяной знак снимается на странице адресата до отправки');
assert.match(src, /const mark = delivery\.msgId \|\| watermark;\s*const sentAt = Date\.now\(\);\s*GM_setValue\(K\.expect, \{\s*\.\.\.expect, watermark: mark, sentAt, verified: true/, 'отметка ставится после успешной доставки');

// 7. Классификатор ntfy: тихо / громко / молча.
const ntfyStart = src.indexOf('const QUIET_NTFY = [');
const ntfyEnd = src.indexOf('function notifyNtfy(', ntfyStart);
const classifyNtfy = new Function(`${src.slice(ntfyStart, ntfyEnd)}\nreturn classifyNtfy;`)();
assert.equal(classifyNtfy('Проверяю роль и очередь…', false), null, 'рутина не уходит в ntfy');
assert.equal(classifyNtfy('Выдан ход Kernel: «NAR-1.3».', false), null, 'до подтверждённой отправки отдельного пуша нет');
assert.equal(classifyNtfy('Ответ Kernel записан, PR слит, задача → Submitted.', false)?.priority, '2', 'Submitted — тихий пуш');
assert.equal(classifyNtfy('Пауза снята Мастером (кнопка «Продолжить»). Продолжаю.', false)?.priority, '2', 'снятие паузы — тихий пуш');
assert.equal(classifyNtfy('Ошибка цикла: HTTP 502', true), null, 'сама ошибка без остановки не будит Мастера');
assert.equal(classifyNtfy('ПАУЗА: агент молчит', true), null, 'строка журнала сама по себе не подтверждает остановку');
assert.equal(classifyNtfy('Цикл остановлен', true, { ntfy: 'loud', cycleStopped: true })?.priority, '5', 'явное событие остановки — громкое');
assert.equal(classifyNtfy('PR не слит, работа продолжается', true, { ntfy: 'loud' })?.priority, '2', 'нельзя сделать громким событие продолжающегося цикла');
assert.equal(classifyNtfy('Ответ без маркера', true, { ntfy: 'quiet' })?.priority, '2', 'напоминание о маркере не будит ночью');

// 8. Панель: общие подключения ведут к ntfy, без автоперезагрузки страницы.
assert.match(src, /id="cfn-connection-ntfy"/, 'есть настройка ntfy в общем окне');
assert.match(src, /find\("ntfy"\)\.onclick[\s\S]*?ntfyDialog\(\)/, 'кнопка открывает прежний диалог ntfy');
assert.match(src, /function ntfyDialog\(\)/, 'диалог ntfy с тестами');
assert.match(src, /Тихий тест/, 'тихий тест доступен из панели');
assert.match(src, /Громкий тест/, 'громкий тест доступен из панели');
// Перезагрузки ограничены двумя конкретными recovery-путями: временный
// отказ Arena «Something went wrong» и неотрисовавшаяся страница адресата.
const reloadSites = src.split('\n').filter((line) => line.includes('location.reload()'));
assert.equal(reloadSites.length, 4, 'два recovery-пути, переключение и исправление ещё не допущенного профиля');
assert.match(src, /if \(checking \|\| autoOn\(\) \|\| busy \|\| projectAsyncWork > 0\)[\s\S]*?location\.reload\(\)/, 'переключение требует остановки и завершения запросов');
const markerMissingStart = src.indexOf('async function markerMissing(');
const reloadableStart = src.indexOf('const isReloadable = /something went wrong|please try again/i.test(eaten.text || "");', markerMissingStart);
const reloadableEnd = src.indexOf('        pause(\n          `Arena снова не приняла задание:', reloadableStart);
const reloadable = src.slice(reloadableStart, reloadableEnd);
assert.ok(reloadable.length > 0, 'отказ Arena разбирается отдельно от обычной ошибки');
assert.match(reloadable, /count < C\.maxReloadAttempts/, 'временный отказ имеет жёсткий предел перезагрузок');
assert.ok(reloadable.indexOf('GM_setValue(reloadKey, count + 1)') < reloadable.indexOf('location.reload()'), 'счётчик фиксируется до перезагрузки');
assert.match(reloadable, /await pause\([\s\S]*?C\.maxReloadAttempts[\s\S]*?требуется Мастер/, 'после исчерпания попыток нужен Мастер');
const blankGuard = src.slice(
  src.indexOf('        if (!page.ok) {'),
  src.indexOf('        const observed = Number(expect.readyAt)'),
);
assert.ok(
  blankGuard.includes('location.reload()') && /pageReloaded/.test(blankGuard),
  'неотрисованная страница адресата перечитывается один раз без снятия ожидания',
);
assert.ok(!monitor.includes('location.reload()'), 'видимая ошибка не запускает перезагрузку из монитора');

// 9. 1.4.86: отказ Notion и молчание Notion — разные причины паузы.
// 28.10 HTTP 400 «content.length should be ≤ 2000» показывался как «сеть или
// блокировка», и Мастер чинил сеть, которой ничего не было.
const stepCatch = src.slice(
  src.indexOf('      const plain = e && e.relay === "question-too-long"'),
  src.indexOf('      pause(\n        `Цикл остановлен.'),
);
assert.ok(stepCatch.length > 0, 'разбор причины паузы на месте');
const refusal = stepCatch.indexOf('/HTTP 4\\d\\d/i.test(raw)');
const silence = stepCatch.indexOf('Notion не ответил: сеть или блокировка запроса');
assert.ok(refusal > -1, 'есть отдельная ветка для HTTP 4xx');
assert.ok(silence > -1, 'ветка «сеть или блокировка» осталась');
assert.ok(refusal < silence, 'отказ Notion проверяется раньше сети');
assert.match(stepCatch, /Notion отклонил запись/, 'отказ назван отказом');
assert.match(stepCatch, /одно поле принимает не больше 2000 знаков/, 'предел длины назван прямо');
assert.match(stepCatch, /дефект скрипта, а не ошибка карточки или ответа/, 'виноват скрипт, а не данные');
// Ветка 5xx идёт до 4xx: 502 — не отказ по данным.
const server = stepCatch.indexOf('/HTTP (?:429|5\\d\\d)/i.test(raw)');
assert.ok(server > -1 && server < refusal, 'сбой на стороне Notion проверяется первым');

// Обёртка вызова Notion: 4xx — «отказал», остальное — «не ответил».
const wrapperFrom = src.indexOf('    last.relay = "notion";');
const wrapper = src.slice(wrapperFrom, src.indexOf('    throw last;', wrapperFrom));
assert.match(wrapper, /Notion отказал на \$\{method\} \$\{path\}/, '4xx назван отказом и с адресом');
assert.match(wrapper, /он получил запрос и не принял данные/, 'сказано, что Notion ответил');
assert.match(wrapper, /Notion не ответил на \$\{method\} \$\{path\}/, 'молчание осталось молчанием');
assert.match(wrapper, /HTTP 429/, '429 не считается отказом по данным');

console.log(`OK: relay ${version} — журнал чистится, маркер напоминается, ошибка ставит паузу и ждёт Мастера`);
