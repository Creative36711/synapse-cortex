// Проба разбора ответа: маркер, «думаю…» и собственные служебные тексты.
//
// История жалобы Мастера (2026-10-23, 16:58): Координатор ответил с маркером,
// а журнал написал «ответил без маркера» и отправил напоминание, потом ещё
// одно задание. Причины, которые проверяются здесь:
//   • маркер искался по строкам `innerText` у detached-клона — абзацы
//     склеивались, JSON рвался, хвост приклеивался к строке;
//   • в наших же текстах есть пример маркера (`<роль|done>`), и он мог
//     засчитаться как ответ;
//   • ответ, который ещё печатается, нельзя считать готовым;
//   • фон в ручном режиме не должен читать ответы и слать новое задание.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

// ── 1. Разбор маркера: код берём из самого скрипта, не копию ─────────────────
const from = src.indexOf('  function braceJson(rest) {');
const to = src.indexOf('  /** Короткая подпись элемента для журнала');
assert.ok(from > 0 && to > from, 'блок разбора маркера на месте');
const block = src.slice(from, to);
assert.match(block, /function braceJson\(rest\)/, 'скобочный разбор');
assert.match(block, /function markerJson\(raw\)/, 'разбор JSON с вариантами');
assert.match(block, /function isPlaceholderMarker\(obj\)/, 'шаблонные значения отсеиваются');
assert.match(block, /function parseMarker\(text, name\)/, 'parseMarker');

const { parseMarker } = new Function(`${block}; return { parseMarker };`)();
const NAME = 'CF_COORDINATOR_RESULT';

// 1.1. Маркер отдельной строкой — базовый случай.
assert.deepEqual(
  parseMarker('Готово.\nCF_COORDINATOR_RESULT {"mission_id":"m1","turn_id":"t1","status":"completed","next":"Architect"}', NAME),
  { mission_id: 'm1', turn_id: 't1', status: 'completed', next: 'Architect' },
  'маркер отдельной строкой разбирается',
);

// 1.2. Абзацы склеены (innerText у клона не ставит переносов) — раньше это ломало разбор.
assert.deepEqual(
  parseMarker('Следующий ход — Architect.CF_COORDINATOR_RESULT {"mission_id":"m1","turn_id":"t1","status":"completed","next":"Architect"}', NAME),
  { mission_id: 'm1', turn_id: 't1', status: 'completed', next: 'Architect' },
  'маркер без переноса перед ним разбирается',
);

// 1.3. JSON разложен переносами — скобочный разбор не зависит от раскладки.
assert.deepEqual(
  parseMarker('CF_COORDINATOR_RESULT {\n  "mission_id": "m1",\n  "next": "Architect"\n}', NAME),
  { mission_id: 'm1', next: 'Architect' },
  'переносы внутри JSON не мешают',
);

// 1.4. Маркер в блоке кода и с текстом после него.
assert.deepEqual(
  parseMarker('```\nCF_COORDINATOR_RESULT {"mission_id":"m1","next":"Kernel"}\n```\nВсё.', NAME),
  { mission_id: 'm1', next: 'Kernel' },
  'блок кода и текст после маркера не мешают',
);

// 1.4.1. Arena может вернуть маркер внутри буквального HTML-комментария.
assert.deepEqual(
  parseMarker('<!-- CF_AGENT_RESULT {"dispatch_id":"d1","run_id":"r1","status":"submitted","merged":true} -->', 'CF_AGENT_RESULT'),
  { dispatch_id: 'd1', run_id: 'r1', status: 'submitted', merged: true },
  'маркер внутри HTML-комментария извлекается до -->',
);
assert.deepEqual(
  parseMarker('<!-- CF_AGENT_RESULT {&quot;dispatch_id&quot;:&quot;d1&quot;,&quot;run_id&quot;:&quot;r1&quot;,&quot;status&quot;:&quot;submitted&quot;,&quot;merged&quot;:true} --&gt;', 'CF_AGENT_RESULT'),
  { dispatch_id: 'd1', run_id: 'r1', status: 'submitted', merged: true },
  'HTML-сущности в маркере и закрытии комментария не обрезают JSON',
);

// 1.5. Пример из нашего задания (`<роль|done>`) — не ответ.
assert.equal(
  parseMarker('Последней строкой ответа:\nCF_COORDINATOR_RESULT {"mission_id":"m1","turn_id":"t1","status":"completed","next":"<роль|done>"}', NAME),
  null,
  'шаблонный маркер из задания не засчитывается',
);

// 1.6. Пример из напоминания — тоже не ответ.
assert.equal(
  parseMarker('ответь ровно одной последней строкой: CF_COORDINATOR_RESULT {"mission_id":"m1","status":"completed","next":"<роль|done>"}', NAME),
  null,
  'шаблонный маркер из напоминания не засчитывается',
);

// 1.7. Маркера нет вовсе.
assert.equal(parseMarker('Думаю над задачей…', NAME), null, 'обычный текст — не маркер');
assert.equal(parseMarker('', NAME), null, 'пустой текст — не маркер');

// 1.8. Два маркера: берём последний, шаблонные пропускаем.
assert.deepEqual(
  parseMarker(
    'CF_COORDINATOR_RESULT {"mission_id":"old","next":"Kernel"}\nCF_COORDINATOR_RESULT {"mission_id":"m1","next":"Architect"}',
    NAME,
  ),
  { mission_id: 'm1', next: 'Architect' },
  'последний настоящий маркер важнее прошлого',
);

// 1.9. Живой ответ приёмки со сравнением «6<7» — маркер настоящий.
// 28.10 18:19 Warden трижды «ответил без маркера»: разбор ловил знак «меньше»
// в любом месте строки и выбрасывал ответ как шаблон из задания.
assert.deepEqual(
  parseMarker(
    'CF_ANSWER_RESULT {"question_id":"q1","turn_id":"t1","verdict":"answer","answer":"до этого гейт красный со строкой 6<7, порог не достигнут"}',
    'CF_ANSWER_RESULT',
  ),
  { question_id: 'q1', turn_id: 't1', verdict: 'answer', answer: 'до этого гейт красный со строкой 6<7, порог не достигнут' },
  'знак «меньше» в ответе не делает маркер шаблоном',
);

// 1.10. Скобки в коде — не шаблон: `<div>` это разметка, а не пример задания.
assert.deepEqual(
  parseMarker('CF_REVIEW_RESULT {"mission_id":"m1","verdict":"rework","remarks":"в оракуле стоит a < b, поправь"}', 'CF_REVIEW_RESULT'),
  { mission_id: 'm1', verdict: 'rework', remarks: 'в оракуле стоит a < b, поправь' },
  'одиночные скобки в тексте замечаний допустимы',
);

// 1.11. Шаблон без описания внутри (всё значение в скобках) — по-прежнему не ответ.
assert.equal(
  parseMarker('CF_ANSWER_RESULT {"question_id":"q1","verdict":"answer","answer":"<путь>"}', 'CF_ANSWER_RESULT'),
  null,
  'короткий шаблон из задания не засчитывается',
);
assert.equal(
  parseMarker('CF_ANSWER_RESULT {"question_id":"q1","verdict":"answer","answer":"<чего именно не хватает: роль, доступ>"}', 'CF_ANSWER_RESULT'),
  null,
  'шаблон с описанием внутри не засчитывается',
);

// ── 2. Сырой текст: разбор не зависит от innerText ──────────────────────────
assert.match(src, /function messageRaw\(node\)/, 'есть чтение сырого текста');
assert.match(src, /String\(clone\.textContent \|\| ""\)/, 'сырой текст берётся из textContent');
assert.match(src, /parseMarker\(m\.raw, "CF_AGENT_RESULT"\)/, 'исполнитель разбирает сырой текст');
assert.match(src, /parseMarker\(m\.raw, "CF_COORDINATOR_RESULT"\)/, 'Координатор разбирает сырой текст');

// 2.1. Свои служебные сообщения не читаются как ответ.
assert.match(src, /const isOwnPrompt = \(raw\) => \/CF_TECH\/\.test/, 'свой промпт опознаётся по CF_TECH');
assert.match(src, /looksLikeOwnTask\(messageRaw\(n\)\)/, 'свои тексты выкидываются из списка ответов');
assert.match(src, /if \(RESULT_LINE\.test\(text\)\) return false;/, 'цитата задания с маркером остаётся ответом');

// ── 2.2. Тело ответа — настоящий `.prose`, а не свёрнутое `not-prose` ───────
// Arena кладёт первым `[class*="prose"]` плашку «Thought for 2 seconds» с
// черновиком рассуждения. Из-за этого ответом считалось рассуждение: маркер
// «не находился», шаг писал «дописывает ответ» и готовил напоминание.
assert.match(src, /function messageBody\(node\)/, 'есть выбор тела сообщения');
assert.match(src, /node\.querySelectorAll\("\.prose"\)/, 'блок берётся по классу .prose');
assert.match(src, /el\.closest\("\.not-prose"\)/, 'свёрнутые рассуждения отбрасываются');
assert.doesNotMatch(src, /querySelector\('\[class\*="prose"\]'\)/, 'селектор, ловивший not-prose, убран');
assert.match(src, /const prose = messageBody\(node\);/, 'текст идёт через messageBody');
assert.match(src, /function messageRaw\(node\) \{\s*const blocks = proseBlocks\(node\);/s, 'сырой разбор берёт все настоящие блоки');

const bodyFrom = src.indexOf('  const proseBlocks = (node) =>');
const bodyTo = src.indexOf('  function messageText(node) {');
assert.ok(bodyFrom > 0 && bodyTo > bodyFrom, 'блок messageBody на месте');
const { messageBody } = new Function(`${src.slice(bodyFrom, bodyTo)}; return { messageBody };`)();
const fake = (name, { notProse = false } = {}) => ({
  name,
  classList: { contains: (c) => c === 'not-prose' && notProse },
  closest: (sel) => (notProse && String(sel).includes('.not-prose') ? {} : null),
});
const thought = fake('thought', { notProse: true });
const answer = fake('answer');
assert.equal(
  messageBody({ querySelectorAll: () => [thought, answer] }),
  answer,
  'рассуждение в not-prose не становится телом ответа',
);
const lonely = { querySelectorAll: () => [] };
assert.equal(messageBody(lonely), lonely, 'без .prose телом остаётся само сообщение');

// ── 2.3. Признаки работы не должны срабатывать на прошлом ───────────────────
assert.match(src, /const rect = el\.getBoundingClientRect\?\.\(\);/, 'видимость считается по площади');
assert.match(src, /rect\.width > 0 && rect\.height > 0/, 'нулевая площадь — не «видно»');
assert.match(src, /function busyReason\(\)/, 'причина работы ищется в одном месте');
assert.match(src, /el\.closest\('\[data-state="closed"\], \.not-prose'\)/, 'свёрнутая история — не работа');
assert.match(src, /\^thought\\b\|\^думал\|\^размышлял/, 'прошедшее время не считается работой');
assert.match(src, /label\.length > 80/, 'длинный текст транскрипта не считается индикатором');
assert.match(src, /busyLabel\(busyReason\(\)\)/, 'в журнале видно, что именно держит шаг');

// 2.4. Завершённый ответ читается сразу, без ожидания «стабильности».
assert.match(src, /function replyEnded\(node\)/, 'есть проверка «ответ закончен»');
assert.match(src, /response ended\|ответ заверш\|generation complete/i, 'подпись «Response ended» — признак конца');
assert.match(src, /data-latest-assistant-response-bottom="true"/, 'отметка низа ответа — признак конца');
assert.match(src, /ended: replyEnded\(n\)/, 'признак считается для каждого ответа');
assert.match(src, /if \(!last\.ended && expect\.lastReplySig !== signature\)/, 'закрытый ответ не ждёт стабильности');
assert.match(src, /if \(!last\.ended && Date\.now\(\) - \(expect\.lastReplyAt/, 'таймер дописывания не держит готовый ответ');

// ── 3. Ответ, который ещё печатается, — не ответ ────────────────────────────
assert.match(src, /function stillWorking\(\)/, 'есть проверка «ещё работает»');
assert.match(src, /const generating = \(\) => busyReason\(\)\?\.kind === "stop";/, 'кнопка Stop — признак работы');
assert.match(src, /thinking\|reasoning\|typing\|дума\|размышл\|анализ/i, 'плашка «думаю» — тоже признак');
assert.match(src, /if \(stillWorking\(\)\) \{/, 'ожидание маркера не срабатывает во время работы');
assert.match(src, /const signature = `\$\{last\.id\}:\$\{last\.raw\.length\}`;/, 'подпись ответа по сырому тексту');
assert.match(src, /Ответ \$\{role\.name\} ещё может дописаться/, 'ручной шаг объясняет, почему ждёт');

// 3.1. Когда маркера действительно нет — видно, что прочитано.
assert.match(src, /Прочитан хвост: «\$\{tail\(last\.text, 110\)\}»/, 'в журнале есть хвост прочитанного');
assert.match(src, /replies: \(\) => \{/, 'в консоли есть __relay.replies()');

// ── 4. Шаг — это один шаг ───────────────────────────────────────────────────
const tickStart = src.indexOf('async function tick(');
const tickBody = src.slice(tickStart, src.indexOf('// ───────────────────────────── старт', tickStart));
assert.match(
  tickBody,
  /if \(!auto && !fromToggle\) return;/,
  'фон в ручном режиме не читает ответы и не выдаёт задания',
);
const gateAt = tickBody.indexOf('if (!auto && !fromToggle) return;');
const consumeAt = tickBody.indexOf('await consumePending(fromToggle)');
assert.ok(consumeAt > 0 && gateAt > consumeAt, 'досылка очереди остаётся, ответы — только по нажатию');

// 4.1. Напоминание больше не создаёт «другой вид» ожидания.
assert.match(
  src,
  /await sendToRole\(role, markerReminder\(role, expect, sent \+ 1, markerName, why\), expect\.kind, expect\.ref,/,
  'напоминание сохраняет вид ожидания',
);
assert.match(
  src,
  /if \(expect && expect\.kind === "reminder"\) \{/,
  'ожидание старой версии приводится к исходному виду',
);
assert.match(
  src,
  /if \(expect && \(expect\.kind === "plan" \|\| expect\.kind === "reminder"\)\) \{/,
  'Координатор принимает напоминание как свой ход',
);

// 4.2. Одно и то же сообщение не уходит дважды.
assert.match(src, /function textHash\(text\)/, 'есть хеш текста');
assert.match(src, /Такое же сообщение уже уходило/, 'дубль объясняется в журнале');
assert.match(src, /lastSend: "cfn-last-send"/, 'память о последней отправке');
assert.match(src, /last\.roleId\) === norm\(role\.id\) && last\.hash === textHash\(text\)/, 'сверяются роль и текст');

// ── 5. В чате нет слова ScriptCat ───────────────────────────────────────────
const chatFrom = src.indexOf('function techHeader(role) {');
const chatTo = src.indexOf('function roleContext(role) {');
const chatText = src.slice(chatFrom, chatTo);
assert.ok(chatText.length > 0, 'блок исходящих текстов найден');
assert.ok(!/ScriptCat/.test(chatText), 'в блоке, который уходит агентам, нет «ScriptCat»');

const reminderFrom = src.indexOf('function markerReminder(role, expect, attempt, markerName, why = "") {');
const reminderTo = src.indexOf('function stillWorking() {');
const reminderText = src.slice(reminderFrom, reminderTo);
assert.ok(!/ScriptCat/.test(reminderText), 'в напоминании нет «ScriptCat»');
assert.match(reminderText, /ТЕХНИЧЕСКОЕ НАПОМИНАНИЕ/, 'первая форма напоминания на месте');
assert.match(reminderText, /НАПОМИНАНИЕ О ФОРМАТЕ/, 'вторая форма напоминания — формулировки не совпадают слово в слово');

// ── 6. Человеческий ритм вместо мгновенной отправки ────────────────────────
assert.match(src, /await sleep\(450 \+ Math\.floor\(Math\.random\(\) \* 900\)\);/, 'пауза перед вставкой текста');
assert.match(src, /await sleep\(500 \+ Math\.floor\(Math\.random\(\) \* 1200\)\);/, 'пауза перед нажатием Send');
assert.match(src, /«\$\{role\.name\}» уже открыт — отправляю задание здесь\./, 'свою же страницу не перезагружаем');

console.log('OK: relay 1.4.63 — ответ берётся из настоящего .prose, а не из «Thought for…», «думаю» не считается ответом, один шаг = одна отправка');
