// Проба 1.14.7: «сообщение возвращается в поле ввода» и «Send не находится».
//
// Случай Мастера (09.11, сборка 1.14.6):
//   13:30:32 «В чате появилось новое сообщение (01a1bfdb-…), но текст остался
//            в поле ввода — повторно не отправляю, поле можно очистить
//            вручную»;
//   14:03:27 «Send нажат, но своё сообщение в чате не появилось (в поле 8403
//            симв., клик 1 без следа, активной кнопки Send нет за 20 с)»;
//   14:04:23 доставка Maintainer'у не подтверждена за 45 с.
//
// Разбор показал три разных дефекта, и ни один из них — не «Arena не любит
// текст»:
//   а) подтверждённая доставка оставляла наш же черновик в поле и звала
//      человека чистить вручную — отсюда «сообщение вернулось в поле»;
//   б) ожидание кнопки Send каждые 1,5 с перезаписывало уже введённый текст,
//      поэтому поле не набирало состояние и кнопка оставалась серой;
//   в) передача Maintainer'у не содержала ни `dispatch`, ни `"turn_id": "…"`,
//      и ключ доставки был пустым — доставка не подтверждалась никогда.
//
// Здесь проверяются все три на настоящем коде из бандла.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim()}`);
  return src.slice(a, b);
};

const flatSrc = 'const flat = (x) => String(x || "").replace(/[\\s\\u00a0]+/g, " ").trim().toLowerCase();';
assert.ok(src.includes(flatSrc), 'flat() на месте');

// ── 1. Ключ передачи Maintainer'у ───────────────────────────────────────────
// Текст передачи (41-heal.js → healDiagnosis) называет ход строкой
// «Вид паузы: …; ход <turnId>.» и не печатает ни dispatch, ни "turn_id": "…".
const sendKeySrc = cut('  function sendKey(text, turnId = "") {', '  /**\n   * Dispatch/run из текста задания');
// `sendKey` опирается на общий разбор dispatch/run — берём его из бандла же,
// чтобы проба проверяла боевой код, а не пересказ.
const idsSrc = cut('  function promptDispatchIds(text) {', '  /**\n   * Ход приёмки, ответа на вопрос или арбитража');
const { sendKey } = new Function(`${flatSrc}\n${idsSrc}\n${sendKeySrc}\nreturn { sendKey };`)();

const turnId = '01a1c1f0-1111-7e32-8f63-e54ec016c5f8';
const heal = [
  'ИНЦИДЕНТ ТРАНСПОРТА · класс transport · поле ввода и кнопка Send.',
  'Остановка: «доставка не подтверждена»',
  `Вид паузы: send; карточка SYN-3; run —; ход ${turnId}.`,
  'Разбор 1 из 2. Сборка 1.14.6 @ 9a5030dcdf2765ec.',
  'СНИМОК СТРАНИЦЫ И ЖУРНАЛ ПОПЫТОК (без переписки и секретов):',
  JSON.stringify({ phase: 'maintainer', page: { composerChars: 8403 } }, null, 2),
  'Правило ответа: первой строкой FIXED … либо NOTFIXED …',
].join('\n');

// Без номера хода ключа нет — так и было в 1.14.6, и это не опознавание.
assert.equal(sendKey(heal), '', 'без номера хода длинный текст ключа не даёт');
// С номером хода ключ находится и он свой у каждой передачи.
const healKey = sendKey(heal, turnId);
assert.equal(healKey, `ход ${turnId}`, 'передача Maintainer-у опознаётся по номеру хода');
assert.notEqual(
  sendKey(heal, '01a1c1f0-2222-7e32-8f63-e54ec016c5f8'),
  healKey,
  'чужой номер хода в тексте не подтверждает эту передачу',
);
// Номер хода, которого в тексте нет, ключом не становится: иначе подтверждением
// годилась бы любая реплика.
assert.equal(
  sendKey(heal, 'ffffffff-ffff-7fff-8fff-ffffffffffff'),
  '',
  'номер хода, которого нет в тексте, ключа не даёт',
);
// Прежние формы ключа не сломаны.
const task = 'Задача NAR-1.8 · Крафт (dispatch 4016f0cf-5705-81f4-8e07-d987ab5f34db, run 1fc527ed-3af9-4e09-9288-523ed62c5d24).';
assert.match(sendKey(task), /dispatch 4016f0cf/, 'задание по-прежнему опознаётся по dispatch id');

// ── 2. Подтверждённая доставка сама убирает черновик ────────────────────────
// Раньше здесь стояло только «поле можно очистить вручную», и текст оставался
// в редакторе — Мастер видел его снова и решал, что отправка не прошла.
const acceptSrc = cut('    const accepted = (found) => {', '    const blocked = () => ({');
assert.match(acceptSrc, /clearComposer\(composer\(\)\)/, 'черновик убирается тем же путём, что при отмене');
assert.match(acceptSrc, /holds = composerHolds\(key, text\)/, 'после очистки признак перепроверяется');
assert.match(
  acceptSrc,
  /draftLeft: holds/,
  'draftLeft остаётся, но означает «очистить не удалось», а не «оставлено человеку»',
);
// Очистка не должна подменять доказательство доставки: ok:true остаётся.
assert.match(acceptSrc, /return \{ ok: true, via: "message", msgId: found\.id/, 'доставка остаётся подтверждённой');

// ── 3. Ожидание кнопки Send не перезаписывает уже введённый текст ───────────
const waitSrc = cut('  async function waitSendReady(editor, text, timeoutMs = C.sendReadyMs) {', '  /**\n   * Отличительная строка задания');
assert.match(waitSrc, /const holdsText = /, 'перед перевставкой проверяется, что поле пусто');
assert.match(waitSrc, /!holdsText && rewrites < 2/, 'перевставка только в пустое поле и не больше двух раз');
assert.match(waitSrc, /rewrites \+= 1/, 'число перевставок считается');

// ── 4. Номер хода доходит от очереди до ключа ───────────────────────────────
const deliverSrc = cut('  async function deliver(editor, text, turnId = "") {', '    const known = userNodeIds();');
assert.match(deliverSrc, /sendKey\(text, turnId\)/, 'deliver передаёт номер хода в ключ');
const callSrc = cut('    const delivery = await deliver(', '    if (delivery.captcha) {');
assert.match(callSrc, /await deliver\(editor, pending\.text, pending\.turnId\)/, 'очередь отдаёт номер хода при отправке');
// Номер хода кладётся в очередь ещё в sendToRole.
assert.match(src, /turnId: payload\.turnId \|\| "",/, 'очередь несёт turnId');

// ── 5. Содержимое текста отправке не мешает ─────────────────────────────────
// Вставка идёт execCommand, а «длинный текст ключа не даёт» — про опознавание,
// не про доставку. Проверяем, что ключ считается от текста, а не наоборот.
assert.ok(
  sendKey(heal, turnId).length < heal.length,
  'ключ короче текста: доставка не зависит от того, что текст длинный',
);

console.log('relay-composer-draft-smoke: ok (1.14.7, три дефекта поля ввода)');
