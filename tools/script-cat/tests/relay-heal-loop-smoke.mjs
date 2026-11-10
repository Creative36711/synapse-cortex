// D-094 (1.14.23): разбор остановки не заклинивает сам себя.
//
// Боевой случай 09.11, 23:26–23:30. Пауза `prompt-compile` и пауза `arena-error`
// пришли в одну секунду, и произошло сразу три вещи:
//   • вторая пауза перезаписала первую, поэтому «Продолжить» читало чужой
//     контекст, а в журнал попадало «цикл на паузе ()» — с пустой причиной;
//   • `healAfterPause` запустился дважды: два разбора и две передачи
//     Maintainer'у на один инцидент, то есть две почти одинаковые реплики в чате;
//   • у передачи не было своего номера хода, поэтому её ключ доставки собирался
//     из первых 60 знаков — а они у всех передач одинаковы. Сообщение стояло в
//     чате, а скрипт считал его прошлым: текст остался в поле ввода, доставка
//     «не подтвердилась», и это превратилось в паузу «поломка самой доставки».
//
// Проба фиксирует четыре правила:
//   1) вторая пауза того же инцидента не подменяет причину и не запускает
//      второй разбор;
//   2) передача Maintainer'у печатает свой ход, и ключ доставки становится
//      уникальным для каждой передачи;
//   3) доставка подтверждается и без ключа, если в чате лежит наш текст;
//   4) пауза сборки промпта не зовёт человека править факты.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const read = (file) => readFileSync(join(srcDir, file), 'utf8');
const core = read('40-heal-core.js');
const heal = read('41-heal.js');
const panel = read('06-pause-panel.js');
const polls = read('17-arena-polls.js');
const tech = read('20-technical-context.js');

const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const UUID_TURN = '01a1c1ff-9c2e-7b11-8f3a-2d4c5e6f7a8b';

// ── 0. Ключ инцидента: причина — часть ключа, ход — тоже ────────────────────
const healCore = new Function('C', `${core}\nreturn { healIncidentKey, classifyPause, decideHeal, healVerdict, healHoldsCycle, HEAL_HOLDING };`)({
  healRetryMax: 2, healMaintainerMax: 2, healBackoffMs: [30000, 120000], masterTicketMax: 1,
});
const inc = (over = {}) => ({ kind: 'prompt-compile', ref: '4136f0cf-5705-8111-84eb-d250e801c3be', reason: 'Промпт не собран (retry X): missing_fact', ...over });
assert.equal(
  healCore.healIncidentKey(inc()),
  healCore.healIncidentKey(inc()),
  'тот же инцидент даёт тот же ключ',
);
assert.notEqual(
  healCore.healIncidentKey(inc()),
  healCore.healIncidentKey(inc({ reason: 'Видимая ошибка Arena в последнем сообщении: Something went wrong.' })),
  'другая причина — другой инцидент, иначе вторая пауза съедала предохранитель первой',
);
assert.notEqual(
  healCore.healIncidentKey(inc()),
  healCore.healIncidentKey(inc({ turnId: UUID_TURN })),
  'ход входит в ключ: та же поломка на другом ходе — не тот же инцидент',
);

// ── 1. Вторая пауза того же инцидента ───────────────────────────────────────
// Исполняем `pause` на модели хранилища: так проверяется поведение, а не текст.
function pauseHarness(start = {}) {
  const store = new Map(Object.entries(start));
  const logs = [];
  const api = new Function(
    'GM_getValue', 'GM_setValue', 'K', 'C', 'SCRIPT_VERSION', 'autoOn', 'log', 'notifyNtfy', 'norm',
    'playAlert', 'setStatus', 'healIncidentKey', 'healAfterPause', 'healHoldsCycle',
    `${core}\n${panel.slice(panel.indexOf('  /**\n   * Единственная точка остановки'), panel.indexOf('  /**\n   * Передача потерялась'))
      .replace(/function pause\(/, 'function pause(')}\nreturn { pause };`,
  )(
    (k, d) => (store.has(k) ? structuredClone(store.get(k)) : d),
    (k, v) => store.set(k, structuredClone(v)),
    { paused: 'cfn-paused', pause: 'cfn-pause-context', expect: 'cfn-expect', pending: 'cfn-pending', notice: 'cfn-notice-log' },
    { buildFingerprint: 'fp', pauseCascadeMs: 15000 },
    '1.14.23',
    () => true,
    (text) => logs.push(text),
    () => {},
    () => {},
    () => {},
    (x) => String(x || '').replace(/-/g, '').toLowerCase(),
    healCore.healIncidentKey,
    // D-104: «стоим или это разбор» решает таблица видов.
    healCore.healHoldsCycle,
    // Разбор не должен запуститься второй раз — считаем вызовы.
    (...args) => { api.heals = (api.heals || 0) + 1; return Promise.resolve(); },
  );
  return { ...api, store, logs };
}

{
  // Передача в очереди и не доставлена — ровно как в 23:27:22.
  // Ожидание не доставлено — условие каскада для ошибки Arena через секунду.
  const h = pauseHarness({ 'cfn-expect': { kind: 'answer', ref: 'card-1', turnId: 'turn-1', sentAt: null, verified: false } });
  // D-104: сборка промпта — работа транспорта, цикл на ней не стоит. Журнал
  // говорит «разбор», а паузы в состоянии нет.
  h.pause('Промпт не собран (retry A): missing_fact — нет task.runId.', { kind: 'prompt-compile', ref: 'card-1' });
  assert.equal(h.store.get('cfn-paused'), undefined, 'разбор транспорта паузу не ставит');
  assert.ok(h.logs.some((line) => /Разбор без остановки/.test(line)), 'журнал называет это разбором');
  assert.ok(Array.isArray(h.store.get('cfn-notice-log')), 'разбор без остановки виден отдельным журналом');

  // Стоящая остановка: предел доработок — тут причина обязана записаться.
  h.pause('Предел доработок исчерпан: карточка вернулась в Rework 3 раза.', { kind: 'rework-limit', ref: 'card-1' });
  const first = h.store.get('cfn-paused');
  assert.match(first, /Предел доработок/, 'первая пауза записана');

  h.pause('Видимая ошибка Arena в последнем сообщении: Something went wrong.', { kind: 'arena-error', ref: '' });
  assert.equal(h.store.get('cfn-paused'), first,
    'вторая пауза того же инцидента не подменяет причину: иначе «Продолжить» читает чужой контекст');
  const ctx = h.store.get('cfn-pause-context');
  assert.ok(Array.isArray(ctx.also) && ctx.also.some((x) => /Something went wrong/.test(x.reason)),
    'уточнение сохранено рядом, а не потеряно');
  assert.equal(ctx.kind, 'rework-limit', 'адресат остановки остаётся прежним');

  // Другой инцидент — по-прежнему новая пауза.
  h.pause('Другая остановка: нет активной роли Maintainer.', { kind: 'heal-no-maintainer', ref: 'x' });
  assert.match(h.store.get('cfn-paused'), /нет активной роли/, 'новая причина перезаписывает паузу');
}

// ── 2. Передача печатает свой ход, ключ становится уникальным ───────────────
{
  const diagBlock = heal.slice(heal.indexOf('function healDiagnosis'), heal.indexOf('async function sendMaintainerTurn'));
  assert.match(diagBlock, /handoffTurnId/, 'диагноз принимает номер хода передачи');
  assert.match(diagBlock, /Передача: ход \$\{handoffTurnId\}/, 'ход печатается отдельной строкой');
  assert.match(heal, /healDiagnosis\(info, verdict, decision, upload, turnId\)/,
    'вызывающий передаёт созданный им turnId, а не номер инцидента');

  const text = ['ИНЦИДЕНТ ТРАНСПОРТА · класс transport · сбой сборки промпта.', 'Остановка: «Промпт не собран»', `Передача: ход ${UUID_TURN}.`, 'x'.repeat(7000)].join('\n');
  const sendKey = new Function('flat', 'promptDispatchIds', `${polls.slice(polls.indexOf('  function sendKey'), polls.indexOf('  /**\n   * Dispatch/run из текста задания'))}\nreturn sendKey;`)(flat, () => null);
  const key = sendKey(text, UUID_TURN);
  assert.equal(key, `ход ${UUID_TURN}`, 'ключ доставки — номер этой передачи, а не общий префикс');
  assert.notEqual(key, flat(text).slice(0, 60), 'общий префикс ключом больше не служит');
  const second = sendKey(text.replace(UUID_TURN, '01a1c1f0-1111-7222-8333-444455556666'), '01a1c1f0-1111-7222-8333-444455556666');
  assert.notEqual(key, second, 'у двух передач разные ключи');
}

// ── 3. Доставка подтверждается по самому тексту ─────────────────────────────
{
  const block = polls.slice(polls.indexOf('  function sameTextSubmission'), polls.indexOf('  /** Короткий хеш текста'));
  assert.ok(block, 'сверка по тексту на месте');
  const nodeId = (n) => String(n.id || '').replace('chat-message-', '');
  const idTime = (id) => { const m = String(id).match(/^([0-9a-f]{8})-/i); return m ? parseInt(m[1], 16) * 1000 : 0; };
  const field = `ИНЦИДЕНТ ТРАНСПОРТА · класс transport · сбой сборки промпта. Передача: ход ${UUID_TURN}.` + ' х'.repeat(40);
  const nodes = [{ id: 'chat-message-01a1c1fe-3f65-702e-b20b-dbac1365d5d5', textContent: field }];
  const api = new Function('flat', 'idTime', 'nodeId', 'composer', 'composerText', 'userMessages',
    `${block}\nreturn { sameTextSubmission };`)(flat, idTime, nodeId, () => ({}), () => field, () => nodes);
  const hit = api.sameTextSubmission(field);
  assert.ok(hit && hit.id === '01a1c1fe-3f65-702e-b20b-dbac1365d5d5', 'наша реплика с этим же текстом — доказательство доставки');
  assert.equal(api.sameTextSubmission('совсем другое задание '.repeat(5)), null, 'чужой текст доставкой не считается');
  assert.match(polls, /const byText = sameTextSubmission\(text\);/, 'сверка вызывается перед вердиктом «не появилось»');
  assert.match(polls, /return accepted\(\{ \.\.\.byText, draftLeft: true \}\);/, 'при находке черновик чистится, а не остаётся в поле');
  assert.match(polls, /markade|whyNotProof\(key, known, since\)/, 'в журнал идёт причина, по которой ключ не сработал');
}

// ── 4. Один разбор на каскад, но честный второй разбор остаётся ─────────────
{
  // Сторож стоит в `pause()`, а не в `healAfterPause`: предохранитель
  // `healMaintainerMax` разрешает второй разбор того же инцидента, когда первый
  // закончился ничем. Запрет «пока висит передача» сломал бы именно этот повтор,
  // поэтому в `healAfterPause` никакого запрета нет.
  assert.match(panel, /if \(sameIncident\) \{/, 'каскад отсекается до запуска разбора');
  assert.ok(!/const running = healState\(\)\.pending;/.test(heal),
    'в healAfterPause нет запрета на второй разбор: он нужен предохранителю');
}

// ── 5. Текст паузы не зовёт человека править факты ──────────────────────────
{
  assert.match(tech, /Это дефект сборки \(\$\{who\}\), а не задача Мастера/,
    'дефект сборки назван дефектом сборки');
  assert.ok(!/исправьте факты или профиль/.test(tech),
    'прежняя формулировка «исправьте факты или профиль» убрана: она уводила разбор в постановку');
  assert.match(tech, /turnId: request\?\.turnId \|\| ""/, 'ход попадает в контекст остановки');
}

console.log('OK: relay-heal-loop — D-094: каскад не подменяет причину и не запускает второй разбор, передача опознаётся по своему ходу, доставка подтверждается по тексту, пауза сборки не зовёт человека');
