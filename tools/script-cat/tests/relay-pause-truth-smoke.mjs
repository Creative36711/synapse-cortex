// Проба D-104 (1.14.31): «ПАУЗА» в журнале означает паузу.
//
// 04.11 журнал показал подряд:
//   16:50:40 ПАУЗА (решает повтор): Шлюз Drive ответил отказом …
//   16:50:51 временный сбой транспорта или сети: продолжаю сам (1 из 2)
//   16:54:23 ПАУЗА (решает повтор): … тот же отказ
//   16:54:35 Перехожу к «Transport Maintainer» …
// Цикл не стоял ни секунды: разбор шёл, передача Maintainer'у шла. Пауза была
// записью в журнале, а не состоянием. Из-за этого Мастер нажимал «Продолжить»
// там, где продолжение и так шло, и не видел единственной настоящей остановки —
// «правка есть, установи сборку».
//
// Здесь проверяется поведение `pause()` на модели хранилища:
//   1) разбор (временный сбой, поломка транспорта) паузу НЕ ставит и пишет
//      «Разбор без остановки»;
//   2) один инцидент — один разбор: повтор в окне не запускает второй;
//   3) установка сборки — пауза, тихая, с адресатом «install»;
//   4) решение человека — пауза громкая;
//   5) слово «ПАУЗА» в журнале появляется ровно там, где состояние стоит.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const read = (name) => readFileSync(join(srcDir, name), 'utf8');
const core = read('40-heal-core.js');
const panel = read('06-pause-panel.js');

const healCore = new Function('C', `${core}\nreturn { classifyPause, healIncidentKey, healHoldsCycle, HEAL_HOLDING };`)({
  healRetryMax: 2, healMaintainerMax: 2, healBackoffMs: [30000, 120000], masterTicketMax: 1,
});

function pauseHarness(start = {}) {
  const store = new Map(Object.entries(start));
  const logs = [];
  const notices = [];
  const calls = { heals: 0, reasons: [] };
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'SCRIPT_VERSION', 'autoOn', 'log', 'notifyNtfy', 'norm',
    'playAlert', 'setStatus', 'healIncidentKey', 'healAfterPause', 'healHoldsCycle', 'classifyPause',
    `${core}\n${panel.slice(panel.indexOf('  /**\n   * Единственная точка остановки'), panel.indexOf('  /**\n   * Передача потерялась'))}\nreturn { pause };`,
  )(
    (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d),
    (k, v) => store.set(k, structuredClone(v)),
    { paused: 'cfn-paused', pause: 'cfn-pause-context', expect: 'cfn-expect', pending: 'cfn-pending', notice: 'cfn-notice-log' },
    { buildFingerprint: 'fp', pauseCascadeMs: 15000, noticeRepeatMs: 120000 },
    '1.14.31',
    () => true,
    (text) => logs.push(text),
    (text, options) => notices.push({ text, options }),
    () => {},
    () => 0,
    () => 0,
    healCore.healIncidentKey,
    // `api` объявлена ниже через const — считаем в замыкании, не в ней.
    (...args) => { calls.heals += 1; calls.reasons.push(args[0] && args[0].reason); return Promise.resolve(); },
    healCore.healHoldsCycle,
    (kind, reason) => healCore.classifyPause(kind, reason),
  );
  return { ...api, store, logs, notices, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

// ── 1. Разбор — не пауза ───────────────────────────────────────────────────
{
  const h = pauseHarness();
  h.pause('Шлюз Drive ответил отказом: Некорректный Drive file ID. Запись не сделана.', { kind: 'send', ref: 'card-7' });
  await tick();
  assert.equal(h.store.get('cfn-paused'), undefined, 'поломка отправки цикл не останавливает');
  assert.equal(h.store.get('cfn-pause-context'), undefined, 'контекста паузы нет: паузы не было');
  assert.ok(h.logs.some((l) => /^Разбор без остановки/.test(l)), 'журнал называет это разбором');
  assert.ok(!h.logs.some((l) => /^ПАУЗА/.test(l)), 'слова «ПАУЗА» в журнале нет');
  assert.equal(h.calls.heals, 1, 'разбор запущен ровно один раз');
  const notices = h.store.get('cfn-notice-log');
  assert.equal(notices.length, 1, 'разбор виден отдельным журналом');
  assert.match(notices[0].reason, /Drive file ID/, 'причина сохранена дословно');
}

{
  const h = pauseHarness();
  h.pause('Временный сбой сети: запрос не дошёл.', { kind: 'error', ref: 'card-8' });
  await tick();
  assert.equal(h.store.get('cfn-paused'), undefined, 'временный сбой не останавливает цикл');
  assert.equal(h.notices.length, 0, 'громкого пуша нет: разбирает повтор');
}

// ── 2. Один инцидент — один разбор ────────────────────────────────────────
{
  const h = pauseHarness();
  const reason = 'Notion не ответил: сеть или блокировка запроса. Запись не сделана.';
  h.pause(reason, { kind: 'send', ref: 'card-9' });
  h.pause(reason, { kind: 'send', ref: 'card-9' });
  await tick();
  assert.equal(h.calls.heals, 1, 'второй тик не запускает второй разбор той же поломки');
  assert.ok(h.logs.some((l) => /Тот же разбор продолжается/.test(l)), 'повтор назван повтором');
  const notices = h.store.get('cfn-notice-log');
  assert.equal(notices.length, 1, 'запись одна, а не две');
  assert.equal(notices[0].count, 2, 'счётчик повторов растёт на той же записи');
}

// ── 3. Установка сборки — единственная остановка транспорта ───────────────
{
  const h = pauseHarness();
  h.pause('Maintainer назвал поломку исправленной, но работает прежняя сборка 1.14.30.', {
    kind: 'heal-await-update', ref: 'card-10',
  });
  await tick();
  assert.match(String(h.store.get('cfn-paused')), /прежняя сборка/, 'цикл стоит: без установки продолжения нет');
  assert.equal(h.store.get('cfn-pause-context').with, 'install', 'адресат — установка, а не «решает человек»');
  assert.ok(h.logs.some((l) => /^ПАУЗА \(решает установка сборки\)/.test(l)), 'в журнале прямая причина остановки');
  assert.equal(h.notices.length, 1, 'пуш один');
  assert.equal(h.notices[0].options.priority, '2', 'пуш тихий: это действие, а не решение');
}

// ── 4. Решение человека остаётся громким ──────────────────────────────────
{
  const h = pauseHarness();
  h.pause('Нет активной роли с доступом: нужна строка «Роли» и Agent URL.', { kind: 'provision', ref: 'card-11' });
  await tick();
  assert.match(String(h.store.get('cfn-paused')), /нужна строка/, 'пауза стоит');
  assert.equal(h.store.get('cfn-pause-context').with, 'master', 'адресат — человек');
  assert.equal(h.notices[0].options.priority, '5', 'звонок громкий: без человека нельзя');
  assert.ok(h.logs.some((l) => /^ПАУЗА:/.test(l)), 'журнал говорит «ПАУЗА» без оговорок');
}

// Предел доработок решает приёмка (D-092): пауза стоит, но звонить нечему.
{
  const h = pauseHarness();
  h.pause('Предел доработок исчерпан: карточка вернулась в Rework третий раз.', { kind: 'rework-limit', ref: 'card-12' });
  await tick();
  assert.match(String(h.store.get('cfn-paused')), /Предел доработок/, 'пауза стоит');
  assert.equal(h.store.get('cfn-pause-context').with, 'warden', 'адресат — приёмка');
  assert.equal(h.notices[0].options.priority, '2', 'громкого звонка нет: решает приёмка');
}

// ── 5. Таблица видов: где стоим, где разбираем ────────────────────────────
{
  const hold = (kind) => healCore.healHoldsCycle(kind, 'причина');
  assert.equal(hold('send'), false);
  assert.equal(hold('prompt-compile'), false);
  assert.equal(hold('error'), false);
  assert.equal(hold('heal-await-update'), true);
  assert.equal(hold('rework-limit'), true);
  assert.equal(hold('mission-roster'), true);
  assert.equal(hold('provision'), true);
  assert.ok(healCore.HEAL_HOLDING.includes('heal-await-update'), 'установка названа в списке остановок');
}

// ── 6. Разбор не оставляет за собой стоящую паузу ─────────────────────────
{
  // Живой случай 04.11: пауза стояла, разбор продолжал сам, а Мастер всё равно
  // должен был нажать «Продолжить». Правило простое: решил продолжать — сними
  // паузу, иначе журнал снова начнёт врать.
  const heal = read('41-heal.js');
  assert.match(heal, /if \(typeof isPaused === "function" && isPaused\(\)\) resume\("временный сбой: повторяю сам"\);/,
    'временный сбой снимает паузу под собой');
  assert.match(heal, /resume\("остановка передана приёмке"\)/, 'передача приёмке не оставляет паузу');
  assert.match(heal, /resume\("поломка передана транспорту"\)/, 'передача транспорту не оставляет паузу');
}

// ── 7. Журнал установки говорит, что делать ───────────────────────────────
{
  const heal = read('41-heal.js');
  assert.match(heal, /Остановка до установки: Maintainer/, 'перед паузой установки — прямая строка');
  assert.match(heal, /Правка в репозитории; в браузере работает прежняя сборка\./,
    'Мастер видит, что осталось только установить сборку');
  assert.match(heal, /Цикл не останавливаю: следующий шаг повторит сам/,
    'временный сбой не обещает продолжения по таймеру');
}

console.log('pause-truth: ok');
