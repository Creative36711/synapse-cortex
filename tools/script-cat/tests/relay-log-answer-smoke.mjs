// Проба 1.4.40: в журнал хода попадает весь ответ, а не одна строка маркера.
//
// История: NAR-1.8, 23.10.2026. Kernel отчитался по делу без маркера, получил
// Техническое напоминание «ответь ровно одной последней строкой» и прислал
// ровно её. В Drive-журнал записался только маркер, Координатор прочитал его,
// не увидел работы и поставил Rework при уже слитом PR #32.
//
// Что проверяется здесь:
//   1) журнал собирается из всех сообщений хода и не дублирует повторы;
//   2) маркер без отчёта не считается ответом (порог minAnswerChars);
//   3) напоминание больше не просит «одну строку», а требует отчёт целиком;
//   4) в коде нет записи `hit.text` в журнал — только собранный ответ.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
import { assertUserscriptVersionContract } from '../version-oracle.mjs';
import { promptShim } from './helpers/prompt-shim.mjs';
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];

assert.match(src, new RegExp(`@version\\s+${V.replace(/\./g, '\\.')}`), `версия ${V}`);

// ── 1. runAnswer + answerBody ───────────────────────────────────────────────
const runFrom = src.indexOf('function runAnswer(expect, hit) {');
const runTo = src.indexOf('async function markerMissing(');
assert.ok(runFrom > 0 && runTo > runFrom, 'блок сборки ответа найден');

const buildAnswer = new Function(
  'messagesAfter',
  `${src.slice(runFrom, runTo)}\nreturn { runAnswer, answerBody };`,
);

const marker = (dispatch, run) =>
  `CF_AGENT_RESULT {"dispatch_id":"${dispatch}","run_id":"${run}","status":"submitted","check":0,"pr":32,"merged":true}`;
const report =
  'Изменённые файлы PR #32: docs/decisions/NAR-1.8.md, src/core/engine.ts, src/core/meta.ts. ' +
  'wc -l src/core/engine.ts = 599. Все 50 smoke зелёные, exit 0. Новые модули: director 243, ' +
  'character 414, checks 374, economy 396, dialogue-runtime 360, encounters 352, meta 221, roguelike 103.';

// 1.1. Отчёт и маркер — два сообщения одного хода: в журнале оба.
{
  const msgs = [
    { id: 'm1', text: report },
    { id: 'm2', text: marker('d1', 'r1') },
  ];
  const { runAnswer } = buildAnswer(() => msgs);
  const answer = runAnswer({ watermark: 'w' }, msgs[1]);
  assert.equal(answer.parts, 2, 'обе части хода попали в журнал');
  assert.match(answer.text, /### Часть 1 из 2/, 'части подписаны');
  assert.match(answer.text, /engine\.ts = 599/, 'отчёт в журнале есть');
  assert.match(answer.text, /CF_AGENT_RESULT/, 'маркер тоже на месте');
  assert.ok(answer.body > 200, `отчёт длиннее порога (${answer.body})`);
}

// 1.2. Ответ одним маркером — это не ответ: тело короче порога.
{
  const msgs = [{ id: 'm1', text: marker('d1', 'r1') }];
  const { runAnswer } = buildAnswer(() => msgs);
  const answer = runAnswer({ watermark: 'w' }, msgs[0]);
  assert.equal(answer.parts, 1, 'одна часть');
  assert.ok(answer.body < 200, `маркер без отчёта короче порога (${answer.body})`);
  assert.ok(!/engine\.ts/.test(answer.text), 'отчёта нет — не выдумываем');
}

// 1.3. Агент повторил отчёт целиком: в журнале две части, а не три.
{
  const msgs = [
    { id: 'm1', text: report },
    { id: 'm2', text: marker('d1', 'r1') },
    { id: 'm3', text: report },
    { id: 'm4', text: marker('d1', 'r1') },
  ];
  const { runAnswer } = buildAnswer(() => msgs);
  const answer = runAnswer({ watermark: 'w' }, msgs[3]);
  assert.equal(answer.parts, 2, 'одинаковые части не дублируются');
  assert.equal((answer.text.match(/engine\.ts = 599/g) || []).length, 1, 'отчёт записан один раз');
}

// 1.4. Маркер нашёлся не в последнем сообщении: он всё равно попадёт в журнал.
{
  const msgs = [{ id: 'm1', text: marker('d1', 'r1') }];
  const { runAnswer } = buildAnswer(() => msgs);
  const answer = runAnswer({ watermark: 'w' }, { id: 'm9', text: marker('d1', 'r1') });
  assert.equal(answer.parts, 1, 'ответ не потерялся и не удвоился');
}

// 1.5. Адресный возврат — граница исходного отчёта: он и реплики после него
// не примешиваются к результату автора, который позже читается Coordinator.
{
  const returned = 'АДРЕСНЫЙ ВОЗВРАТ ОТВЕТА · question_id q1';
  const laterReply = 'Ответ автора на адресный возврат: уточнение, не часть отчёта.';
  const before = [
    { id: 'm1', text: report },
    { id: 'm2', text: marker('d1', 'r1') },
    { id: 'm3', text: returned },
    { id: 'm4', text: laterReply },
  ];
  const { runAnswer } = buildAnswer(() => before);
  const preserved = runAnswer({ watermark: 'w' }, before[1]);
  assert.equal(preserved.parts, 2, 'до адресного возврата сохранены отчёт и исходный маркер');
  assert.ok(preserved.text.includes(report), 'исходный отчёт остаётся целым');
  assert.ok(preserved.text.includes(marker('d1', 'r1')), 'исходное решение остаётся в журнале');
  assert.doesNotMatch(preserved.text, /АДРЕСНЫЙ ВОЗВРАТ ОТВЕТА|Ответ автора на адресный возврат/,
    'транспортная реплика и ответ автора не портят исходный отчёт');

  const after = [
    { id: 'm1', text: report },
    { id: 'm2', text: returned },
    { id: 'm3', text: laterReply },
    { id: 'm4', text: marker('d1', 'r1') },
  ];
  const bounded = buildAnswer(() => after).runAnswer({ watermark: 'w' }, after[3]);
  assert.equal(bounded.parts, 1, 'маркер-хвост после возврата не примешивается к отчёту');
  assert.equal(bounded.text, report, 'после возврата остаётся только исходное тело');
}

// 1.6. answerBody не считает служебные строки отчётом.
{
  const { answerBody } = buildAnswer(() => []);
  assert.equal(answerBody('### Часть 1 из 2\n\nCF_AGENT_RESULT {"pr":32}'), 0, 'подпись части и маркер — не текст');
  assert.ok(answerBody(report) > 200, 'настоящий отчёт считается');
}

// ── 2. Порог и запись в журнал в submitExecutor ─────────────────────────────
assert.match(src, /minAnswerChars: 200,/, 'порог ответа в конфиге');
const submitFrom = src.indexOf('async function submitExecutor(');
const submitBlock = src.slice(submitFrom, src.indexOf('// ───────────────────────────── PR', submitFrom));
assert.ok(submitFrom > 0 && submitBlock.length > 0, 'исполнитель найден');
assert.match(submitBlock, /const answer = runAnswer\(expect, hit\);/, 'журнал собирается из всего хода');
assert.match(
  submitBlock,
  /if \(answer\.body < C\.minAnswerChars\) \{/,
  'маркер без отчёта не проходит порог',
);
assert.match(
  submitBlock,
  /return markerMissing\(role, expect, "CF_AGENT_RESULT", manual, "thin"\);/,
  'вместо записи пустого журнала — напоминание про отчёт',
);
assert.match(
  submitBlock,
  /const partsNote = answer\.parts > 1 \? `_Ответ собран из \$\{answer\.parts\} сообщений хода\._\\n\\n` : "";/,
  'видно, что ответ собран из нескольких сообщений',
);
assert.match(
  submitBlock,
  /`\\n\\n\$\{marker\}\\n## Ответ \$\{role\.name\}\\n\\n\$\{partsNote\}\$\{answer\.text\}\\n`/,
  'в журнал пишется собранный ответ',
);
assert.match(
  submitBlock,
  /await appendToJournal\(/,
  'запись идёт в журнал выдачи (1.4.63), а не в id из карточки',
);
assert.ok(!/## Ответ \$\{role\.name\}\\n\\n\$\{hit\.text\}/.test(src), 'запись одного `hit.text` больше не используется');

// 2.1. Выполняем настоящий submitExecutor с заглушками до границы Drive.
// Проверяем именно пятый аргумент реального вызова appendToJournal: шаблон,
// оставленный только в неиспользуемой переменной, эту пробу не пройдёт.
{
  const submitFrom = src.indexOf('async function submitExecutor(role, expect, manual = false) {');
  const submitTo = src.indexOf('// ───────────────────────────── ход Координатора', submitFrom);
  assert.ok(submitFrom > 0 && submitTo > submitFrom, 'границы submitExecutor найдены');
  const submitSource = src.slice(submitFrom, submitTo);
  const makeSubmitExecutor = new Function(
    'C',
    'messagesAfter',
    'parseMarker',
    'norm',
    'GM_getValue',
    'currentDispatch',
    'adoptIds',
    'notion',
    'dispatchGuard',
    'rt',
    'questionInMarker',
    'deferredResultFor',
    'appendToJournal',
    // D-046: проверка противоречия pr/merged стоит до чтения карточки и до Drive.
    'prMergeConflict',
    'runAnswer', 'isUuid', 'activeMission', 'cardInMission',
    `${submitSource}\nreturn submitExecutor;`,
  );

  const runtimeResult = {
    dispatch_id: 'd1',
    run_id: 'r1',
    status: 'submitted',
    check: 0,
    pr: 32,
    merged: true,
  };
  const runtimeMarker = marker('d1', 'r1');
  const runtimeMessages = [
    { id: 'report', text: report, raw: report },
    { id: 'result', text: runtimeMarker, raw: runtimeMarker },
  ];
  const appendCalls = [];
  const stopAfterAppend = new Error('captured appendToJournal arguments');
  const runtimeRunAnswer = buildAnswer(() => runtimeMessages).runAnswer;
  const submitExecutor = makeSubmitExecutor(
    { minAnswerChars: 200, markerReminders: 2 },
    () => runtimeMessages,
    (raw, name) => (name === 'CF_AGENT_RESULT' && raw.includes('CF_AGENT_RESULT') ? runtimeResult : null),
    (value) => String(value ?? '').toLowerCase(),
    () => false,
    () => true,
    (result) => ({ result, stray: [] }),
    async () => ({ properties: { 'Output Drive File ID': 'log-1' } }),
    () => null,
    (value) => String(value ?? ''),
    () => ({ kind: 'none' }),
    () => ({ found: false, decision: null, error: '' }),
    async (...args) => {
      appendCalls.push(args);
      throw stopAfterAppend;
    },
    () => false,
    runtimeRunAnswer, (value) => Boolean(value), async () => ({ id:'m1' }), () => true,
  );

  let stoppedAtAppend = null;
  try {
    await submitExecutor(
      { fn: 'Kernel', name: 'Kernel', id: 'role-kernel' },
      { kind: 'dispatch', ref: 'd1', runId: 'r1', missionId:'m1', watermark: 'w' },
      false,
    );
  } catch (error) {
    stoppedAtAppend = error;
  }

  assert.equal(stoppedAtAppend, stopAfterAppend, 'submitExecutor reached the intercepted Drive append');
  assert.equal(appendCalls.length, 1, 'submitExecutor called appendToJournal exactly once');
  const [dispatchId, runId, logId, entryMarker, entry] = appendCalls[0];
  assert.equal(dispatchId, 'd1', 'actual append uses this dispatch');
  assert.equal(runId, 'r1', 'actual append uses this run');
  assert.equal(logId, 'log-1', 'actual append uses the card journal');
  assert.equal(entryMarker, '<!-- CF_DISPATCH d1:r1 -->', 'actual append receives the dispatch marker');
  assert.ok(
    entry.includes(report),
    'appendToJournal actual entry argument must contain the assembled report body (not an unused template)',
  );
  assert.ok(entry.includes(runtimeMarker), 'actual journal entry includes the marker message');
  assert.ok(
    entry.includes('_Ответ собран из 2 сообщений хода._'),
    'actual journal entry includes the multi-message partsNote',
  );
}

// ── 3. Напоминание требует отчёт, а не строку ──────────────────────────────
assert.ok(!/ответь ровно одной последней строкой/.test(src), 'формулировка «ровно одна последняя строка» убрана');

const remindFrom = src.indexOf('function markerReminder(role, expect, attempt, markerName, why = "") {');
const remindTo = src.indexOf('function stillWorking() {');
assert.ok(remindFrom > 0 && remindTo > remindFrom, 'напоминание найдено');
const roleContextStub = () => 'КОНТЕКСТ';
const remind = new Function(
  'C', 'roleContext',
  `${promptShim}\n${src.slice(remindFrom, remindTo)}\nreturn markerReminder;`,
)({ markerReminders: 2 }, roleContextStub);

const roleKernel = { name: 'Kernel', fn: 'Executor' };
const expect = { kind: 'dispatch', ref: 'd1', runId: 'r1', title: 'NAR-1.8' };

const plain = remind(roleKernel, expect, 1, 'CF_AGENT_RESULT').text;
assert.match(plain, /не хватило последней строки с CF_AGENT_RESULT/, 'обычное напоминание про маркер');
assert.match(plain, /пришли ответ целиком/, 'просим отчёт целиком');
assert.match(plain, /не вместо отчёта/, 'прямой запрет на маркер вместо отчёта');

const thin = remind(roleKernel, expect, 2, 'CF_AGENT_RESULT', 'thin').text;
assert.match(thin, /Техническое напоминание \(2 из 2;/, 'видно, что отчёта нет');
assert.match(thin, /пришёл только маркер CF_AGENT_RESULT, без отчёта/, 'причина названа');
assert.match(thin, /Маркер без фактов не считается ответом/, 'объяснено, почему не принято');
assert.match(thin, /пришли ответ целиком/, 'просим факты');

// ── 4. Ручной шаг и пауза знают про «маркер без отчёта» ────────────────────
assert.match(
  src,
  /`\$\{role\.name\} прислал только маркер \$\{markerName\}, без отчёта — напоминание \$\{sent \+ 1\} из \$\{C\.markerReminders\}\./,
  'журнал отличает маркер без отчёта',
);
assert.match(src, /"Relay: маркер без отчёта"/, 'тихий пуш называет причину');
assert.match(
  src,
  /why === "thin"\s*\n\s*\? `\$\{role\.name\} присылает только маркер \$\{markerName\}, без отчёта, после \$\{C\.markerReminders\} напоминаний\./,
  'пауза объясняет, что агент присылает только маркер',
);

console.log(
  `OK: relay ${V} — журнал хода собирается из всех ответов, маркер без отчёта не считается ответом, ` +
    'напоминание требует отчёт целиком',
);
