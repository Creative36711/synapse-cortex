// D-092 (1.14.21): автономность как правило, человек — только по закрытому списку.
//
// Проба проверяет три вещи, которых до этой сборки не было:
//   1) закрытый список MASTER_ONLY — четыре пункта, и каждый вид паузы,
//      адресованный человеку, обязан иметь пункт списка либо быть действием
//      в браузере (капча, вход);
//   2) инверсию по умолчанию: неизвестный и нераспознанный вид паузы уходит
//      разбору, а не человеку;
//   3) метрику автономности: остановки на сто ходов с разбивкой по адресатам.
// Плюс зона как данные: проза не считается пустой зоной, префикс не съедает
// первый шаблон, путь без владельца называется вслух.
//
// Проба намеренно читает и ядро, и код панели: правило «человека зовут только
// громко» живёт в двух местах (`pause` и `healAfterPause`), и расходиться им
// нельзя.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { healApi } from './helpers/prompt-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const src = (name) => readFileSync(join(srcDir, name), 'utf8');

const { MASTER_ONLY, HEAL_MASTER_ONLY, HEAL_PAUSE_CLASS, classifyPause, decideHeal, healResolveWith, healHoldsCycle } = healApi;

// ── 1. Закрытый список: четыре пункта, и он закрыт ─────────────────────────
assert.deepEqual(MASTER_ONLY, ['install', 'agent', 'money', 'product'],
  'закрытый список ровно из четырёх пунктов; код в него не входит');

// Каждый вид паузы, адресованный человеку, обязан объяснить, почему.
{
  const forHuman = Object.keys(HEAL_PAUSE_CLASS)
    .map((kind) => [kind, classifyPause(kind, 'причина')])
    .filter(([, verdict]) => verdict.with === 'master');
  assert.ok(forHuman.length > 0, 'виды, решаемые человеком, существуют');
  for (const [kind, verdict] of forHuman) {
    if (verdict.cls === 'arena') continue; // действие в браузере, а не решение
    assert.ok(HEAL_MASTER_ONLY[kind], `«${kind}» уходит человеку без пункта закрытого списка`);
    assert.ok(MASTER_ONLY.includes(HEAL_MASTER_ONLY[kind]),
      `«${kind}» ссылается на пункт вне списка: ${HEAL_MASTER_ONLY[kind]}`);
  }
}

// Всякий вид, у которого есть пункт списка, действительно уходит человеку —
// кроме установки сборки: это действие Мастера, но не решение (D-104), поэтому
// адресат у неё свой — «install».
for (const kind of Object.keys(HEAL_MASTER_ONLY)) {
  assert.ok(HEAL_PAUSE_CLASS[kind], `пункт списка для «${kind}» указывает на несуществующий вид паузы`);
  const who = classifyPause(kind, 'причина').with;
  assert.ok(['master', 'install'].includes(who), `«${kind}»: пункт списка сильнее класса, а не «${who}»`);
  if (HEAL_MASTER_ONLY[kind] === 'install') {
    assert.equal(who, 'install', `«${kind}»: установку ждёт Мастер, но решает не он`);
  } else {
    assert.equal(who, 'master', `«${kind}»: пункт списка сильнее класса`);
  }
}

// ── 1-бис. Стоит ли цикл: разбор — не пауза (D-104) ────────────────────────
{
  // 04.11 журнал трижды показал «ПАУЗА (решает повтор)» там, где цикл шёл сам,
  // и один раз «ПАУЗА (решает транспорт)» перед передачей Maintainer'у.
  assert.equal(healHoldsCycle('error', 'временный сбой сети'), false, 'временный сбой продолжается сам');
  assert.equal(healHoldsCycle('send', 'сообщение не ушло'), false, 'поломку отправки разбирает транспорт');
  assert.equal(healHoldsCycle('prompt-compile', 'нет task.runId'), false, 'сборка промпта — работа транспорта');
  assert.equal(healHoldsCycle('heal-await-update', 'работает прежняя сборка'), true,
    'ждём установку — стоим: без новой сборки продолжения нет');
  assert.equal(healHoldsCycle('rework-limit', 'предел доработок'), true, 'предел решает человек — стоим');
  assert.equal(healHoldsCycle('provision', 'нужна строка роли'), true, 'нет доступа — без человека нельзя');
  assert.equal(healHoldsCycle('never-seen-kind-92', 'причина не названа'), false,
    'нераспознанный вид разбирает транспорт — цикл ждать нажатия не обязан');
  // Разбор без остановки виден отдельной строкой и отдельным журналом.
  const panel = src('06-pause-panel.js');
  assert.match(panel, /Разбор без остановки/, 'журнал называет разбор разбором');
  assert.match(panel, /const holds = typeof healHoldsCycle === "function"/, 'решение «стоим или нет» — из таблицы видов');
}

// ── 2. Инверсия по умолчанию ───────────────────────────────────────────────
{
  const unknown = classifyPause('never-seen-kind-92', 'причина не названа');
  assert.equal(unknown.unknown, true, 'нераспознанное помечено');
  assert.equal(unknown.with, 'transport', 'нераспознанное решает разбор, а не человек');
  assert.equal(decideHeal(unknown, {}, {}).action, 'maintainer', 'и немедленно уходит Maintainer-у');
  // Предел разбора остаётся пределом: после него — единственный законный стоп.
  assert.equal(decideHeal(unknown, { escalations: 2 }, { healMaintainerMax: 2 }).action, 'master',
    'исчерпанный разбор останавливает цикл, а не крутит его');
}
// Класс `master` сам по себе — ещё не человек: адрес решает вид.
{
  assert.equal(classifyPause('tool-limit', 'предел инструментов').with, 'transport');
  assert.equal(classifyPause('done-with-open', 'миссия закрыта с открытыми пунктами').with, 'warden');
  assert.equal(classifyPause('provision', 'нужна строка роли').with, 'master');
}
// Список пунктов можно сузить снаружи — тогда адрес меняется, а не теряется.
{
  assert.equal(healResolveWith('provision', 'master', { masterOnly: ['install'] }).with, 'transport',
    'суженный список отправляет остальное разбору, а не в пустоту');
}

// ── 3. Вопрос приёмке вместо остановки ─────────────────────────────────────
{
  const warden = decideHeal(classifyPause('done-with-open', 'миссия закрыта'), {}, { masterTicketMax: 1 });
  assert.equal(warden.action, 'warden', 'постановка уходит строкой в «Обратную связь»');
  const repeated = decideHeal(classifyPause('done-with-open', 'миссия закрыта'), { tickets: 1 }, { masterTicketMax: 1 });
  assert.equal(repeated.action, 'master', 'второй раз та же остановка останавливает цикл: молчание не решение');
  const heal = src('41-heal.js');
  assert.match(heal, /if \(decision\.action === "warden"\) \{/, 'передача приёмке исполняется в разборе');
  assert.match(heal, /gate: false,/, 'строка приёмке не держит ход: очередь идёт дальше');
  assert.match(heal, /forceAnswer: true,/, 'но ответ приёмки обязателен: ход к ней ставится сразу');
  assert.match(heal, /healBump\(key, "tickets"\);/, 'передача считается отдельным счётчиком');
}

// ── 4. Метрика автономности ────────────────────────────────────────────────
{
  const heal = src('41-heal.js');
  assert.match(heal, /function healAutonomyMetric\(\)/, 'метрика автономности существует');
  assert.match(heal, /per100/, 'метрика измеряется на сто ходов, а не «на глаз»');
  assert.match(heal, /function healCountTurn\(\)/, 'знаменатель метрики считается в шаге');
  assert.match(heal, /function healCountStop\(/, 'числитель метрики считается на остановке');
  assert.match(heal, /tickets: Math\.max\(0, Number\(found\.tickets\) \|\| 0\)/, 'счётчик тикетов переживает перезагрузку');
  assert.match(heal, /autonomy: healAutonomyMetric\(\),/, 'метрика попадает в телеметрию');
  const cycle = src('28-cycle.js');
  assert.match(cycle, /healCountTurn\(\)/, 'шаг цикла увеличивает знаменатель');
}

// ── 5. Установка сборки больше не повод для человека ───────────────────────
{
  const recovery = src('18-state-recovery.js');
  const pendingBranch = recovery.indexOf('if (pending) {');
  const pauseLine = recovery.indexOf('kind: "update-recovery"');
  assert.ok(pendingBranch > 0 && pauseLine > pendingBranch,
    'ветка очереди стоит до паузы: задание в очереди отправляет транспорт, а не человек');
  assert.match(recovery, /отправкой владеет транспорт, продолжаю без паузы/,
    'причина названа словами, а не оставлена на догадку');
}

// ── 6. Громкий сигнал только человеку ──────────────────────────────────────
{
  const panel = src('06-pause-panel.js');
  assert.match(panel, /const forHuman = holds && \(!info\.with \|\| info\.with === "master"\);/,
    'громко только тому, что правда стоит и правда ждёт человека');
  assert.match(panel, /info\.with === "install" \? "установка сборки"/, 'панель называет ожидание установки');
  assert.match(panel, /if \(context\.quiet \|\| !forHuman \|\| info\.with === "install"\) \{/,
    'тихий пуш — для остановок, которые решает не человек, и для ожидания установки');
  assert.match(panel, /info\.with = verdict \? String\(verdict\.with \|\| ""\) : "";/,
    'адресат попадает в состояние паузы');
  assert.match(panel, /with: "",/, 'поле объявлено в самой паузе: старое состояние читается как «решает человек»');
}

// ── 6-бис. Панель называет адресата ────────────────────────────────────────
{
  const panel = src('06-pause-panel.js');
  assert.match(panel, /master: "ждёт Мастера", warden: "решает приёмка"/,
    'панель называет, кто решает, а не только «пауза»');
  assert.match(panel, /who && who !== "master" \? "#e8d08a" : "#ff9a9a"/,
    'красный цвет — только тому, что правда ждёт человека');
}

// ── 7. Зона как данные ─────────────────────────────────────────────────────
{
  const answers = src('27-review-answers.js');
  assert.match(answers, /const roleZoneGlobs = \(roleZone\) => \{/, 'зона разбирается в пути');
  assert.match(answers, /const roleZoneIsProse = \(roleZone\) => \{/, 'проза отличается от пустой зоны');
  assert.match(answers, /rawLine\.replace\(\/\^\\s\*\[\^:\\s\]/, 'префикс репозитория не съедает первый шаблон');
  assert.match(answers, /const globby = tokens\.every/, 'пути принимаются по строке целиком, а проза — нет');
  assert.match(answers, /function unownedPaths\(cardZone, roleRowsList\) \{/, 'путь без владельца проверяется');
  assert.match(answers, /пути Scope не входят в зону ни одной активной роли/, 'дефект постановки назван вслух');
}

// ── 8. Права Координатора: процессные поля, а не права ─────────────────────
{
  const blocks = src('prompt-blocks.js');
  const coordinator = blocks.slice(blocks.indexOf('def("authority.coordinator"'), blocks.indexOf('def("authority.reviewer"'));
  assert.match(coordinator, /Зона записи\/Гейт\/Репозиторий\/Функция — твои по решению приёмки/,
    'процессные поля отданы Координатору решением приёмки');
  assert.match(coordinator, /Статус, Agent URL, Agent Admin и удаление — Мастер/,
    'права остались за Мастером');
  const provision = blocks.slice(blocks.indexOf('def("authority.provision"'));
  assert.match(provision, /Процессные поля неадминской строки/, 'приёмка одобряет процессные поля сама');
}

console.log('OK: relay-autonomy — D-092: закрытый список, инверсия по умолчанию, вопрос вместо остановки, метрика и зона как данные');
