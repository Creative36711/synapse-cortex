// D-083: прямой вопрос к роли — это ход к ней, а не остановка цикла.
//
// 09.11 Координатор дважды оказался в одном и том же тупике. Ему нужен был
// ответ Warden «здесь и сейчас»: B5 не выдаётся без опубликованного ТЗ 1.7,
// B2 ждёт правок V-2, остальные стоят за B2 по Sequence. Он прислал
// next:"blocked" + need:"Warden" — и получил «роль активна, решай сам», хотя
// решения без Warden не существовало. Второй раз — то же самое.
//
// Причин было три, и все в транспорте:
//
//   1. Ветка вопроса стояла под `next !== "blocked"`. Вопрос, поданный вместе
//      с остановкой, выбрасывался целиком: строки не было, приёмка не звалась.
//   2. `need` не сохранялся ни в очередь приёмки, ни в строку базы. Даже
//      записанный вопрос уходил «активному Reviewer», а не названной роли —
//      то есть адресовать обратную связь было нечем.
//   3. Промпт описывал только `next:"blocked"` и ни слова не говорил о том,
//      что вопрос с `need` и есть прямой канал. Агент выбирал единственный
//      известный ему способ попросить ответ — остановку.
//
// Проба держит все три: механику (что читается и куда уходит), адрес и текст
// промпта. На 1.14.10 она падает на первом же фрагменте.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'relay.user.js'), 'utf8');

const cut = (start, end) => {
  const from = src.indexOf(start);
  assert.notEqual(from, -1, `начало фрагмента найдено: ${start}`);
  const to = src.indexOf(end, from);
  assert.notEqual(to, -1, `конец фрагмента найден: ${end}`);
  return src.slice(from, to);
};

// ── 1. Очередь приёмки сохраняет адресата и gate ───────────────────────────
{
  const body = cut('  function queueAnswer(row, q, ctx = {}) {', '\n  const dropAnswer');
  let stored = [];
  const make = new Function('GM_setValue', 'K', 'questionMaterial', 'answerQueue',
    `${body}\nreturn queueAnswer;`);
  const queueAnswer = make((_k, v) => { stored = v; }, { answers: 'answers' }, (u) => u || '', () => stored);
  const row = { id: '4136f0cf-5705-81aa-8a69-e70cc4e4cefa' };
  const item = queueAnswer(row, { text: 'Нужно решение по ТЗ', fallback: 'ждать', gate: true, need: 'Warden' }, { roleName: 'Coordinator' });

  assert.equal(item.need, 'Warden', 'адресат вопроса переживает постановку в очередь');
  assert.equal(item.gate, true, '«этот вопрос держит ход» тоже переживает постановку');
  assert.equal(stored[0].need, 'Warden', 'в хранилище лежит тот же адресат');

  // Обычный вопрос адресата не получает: иначе любое «спросить между делом»
  // уводило бы ход к чужой роли.
  stored = [];
  const plain = queueAnswer({ id: 'row-2' }, { text: 'Мелочь', fallback: 'как решил', gate: false, need: 'Warden' });
  assert.equal(plain.need, '', 'без gate адресат не применяется');
  assert.equal(plain.gate, false, 'обычный вопрос не держит ход');
}

// ── 1b. Адресат виден в самой строке Notion ────────────────────────────────
{
  const body = cut('  function questionProps(q, ctx = {}) {', '\n  /**\n   * Полный текст вопроса');
  assert.match(body, /function questionProps/, 'фрагмент собран целиком');
  const make = new Function('richText', 'missionLabel', 'questionType', 'questionMaterial', 'Q',
    `${body}\nreturn questionProps;`);
  const RT = (t) => [{ type: 'text', text: { content: String(t) } }];
  const props = make(RT, () => 'SYN-3 · миссия', () => 'вопрос', (u) => u, { wait: 'Ждёт' })(
    { text: 'Нужно решение по ТЗ', fallback: 'ждать', gate: true, need: 'Warden', options: [] },
    { roleName: 'Coordinator' },
  );
  const blocks = props['Что блокирует'].rich_text[0].text.content;
  assert.match(blocks, /ждёт ответа/, 'признак остановки на месте');
  assert.match(blocks, /нужен ответ «Warden»/, 'Мастер видит в строке, кого именно ждут');
  // Без gate адресат в строку не пишется: иначе «кому» спорит с «ходит ли ход».
  const plain = make(RT, () => 'SYN-3 · миссия', () => 'вопрос', (u) => u, { wait: 'Ждёт' })(
    { text: 'Мелочь', fallback: 'как решил', gate: false, need: 'Warden', options: [] }, {},
  );
  assert.equal(plain['Что блокирует'], undefined, 'у обычного вопроса пометки о адресате нет');
}

// ── 1c. Строка из базы возвращает и gate, и адресата ──────────────────────
{
  const from = src.indexOf('  function questionFromRow(row) {');
  const to = src.indexOf('  /** Отметка «эту строку приёмке уже передавали»', from);
  assert.ok(from > 0 && to > from, 'questionFromRow собрана целиком');
  const body = src.slice(from, to);
  const make = new Function('rt', 'qOptions', 'questionMaterial',
    `${body}\nreturn questionFromRow;`);
  const rt = (p) => (Array.isArray(p?.rich_text) ? p.rich_text.map((i) => i.plain_text || '').join('') : '') ||
    (Array.isArray(p?.title) ? p.title.map((i) => i.plain_text || '').join('') : '');
  const row = {
    properties: {
      'Вопрос': { title: [{ plain_text: 'Нужно решение по ТЗ 1.7' }] },
      'По умолчанию': { rich_text: [{ plain_text: 'ждать' }] },
      'Варианты': { rich_text: [] },
      'Материал': { url: null },
      'Что блокирует': { rich_text: [{ plain_text: 'ждёт ответа · нужен ответ «Warden»' }] },
    },
  };
  const q = make(rt, () => [], (u) => u || '')(row);
  assert.equal(q.gate, true, 'строка без «ждёт ответа» ход не держит — это правило D-081 живо');
  assert.equal(q.need, 'Warden', 'адресат восстанавливается из строки, иначе он живёт только один ход');

  // Метки нет — адресата нет: ручная строка не назначает роль на глазок.
  const noMark = make(rt, () => [], (u) => u || '')({ properties: { ...row.properties, 'Что блокирует': { rich_text: [] } } });
  assert.equal(noMark.need, '', 'без метки адресат пуст');
  assert.equal(noMark.gate, false, 'без метки ход не держится');
}

// ── 2. Адресованная обратная связь уходит названной роли ───────────────────
{
  const body = cut('    const asked = String(item.need || "").trim();', '  async function dispatchTask(');
  // Адресат читается из очереди: значит он обязан там быть — см. блок 1.
  assert.match(body, /const asked = String\(item\.need \|\| ""\)\.trim\(\)/, 'адресат берётся из вопроса');
  const calls = { startAnswer: [], log: [] };
  // `new Function` не видит внешних `const`: каждое свободное имя фрагмента
  // передаётся параметром, иначе — ReferenceError или тихий `undefined`.
  const make = new Function(
    'roleRows', 'missionForQuestion', 'norm', 'reviewerRole', 'log', 'logThrottled', 'oneLine', 'dropAnswer', 'answerQueue',
    'notion', 'sel', 'Q', 'questionFromRowComplete', 'verifiedAdrMaterial', 'sendToRole', 'answerPrompt',
    'uid', 'GM_getValue', 'K',
    `async function startAnswer(mission, item) { const questionMission = await missionForQuestion(item, mission); ${body.slice(0, body.lastIndexOf('  }'))}} return startAnswer;`,
  );
  const roles = [
    { name: 'Warden', status: 'Активна', url: 'https://arena.ai/agent/01a1c045-1111-7222-8333-944455556666', fn: 'Reviewer' },
    { name: 'Spec Auditor', status: 'Активна', url: 'https://arena.ai/agent/01a19db6-aaaa-bbbb-cccc-dddddddddddd', fn: 'Auditor' },
    { name: 'Locale Auditor', status: 'Ждёт', url: '', fn: 'Auditor' },
  ];
  const build = (over = {}) => make(
    async () => roles,
    async (_item, fallback) => fallback,
    (x) => String(x || '').trim().toLowerCase(),
    async () => roles[1],
    (t) => calls.log.push(t),
    // logThrottled(key, text, loud) — в журнал идёт второй аргумент, не ключ.
    (_key, text) => calls.log.push(text),
    (t) => String(t || ''),
    () => {},
    () => [],
    async () => ({ properties: {} }),
    () => '',
    { wait: 'Ждёт' },
    async () => ({ fullText: '', url: '' }),
    async () => true,
    async (role) => { calls.startAnswer.push(role.name); return true; },
    () => 'prompt',
    () => 'turn-1',
    () => null,
    { answers: 'answers' },
  );
  const mission = { id: '4126f0cf-5705-819c-89c3-c1566cf5b67a', properties: {} };

  // Назван Warden — ход уходит Warden, а не первому Reviewer в списке.
  assert.equal(await build()(mission, { id: 'row-1', text: 'Нужно решение', need: 'Warden' }), true, 'ход поставлен');
  assert.deepEqual(calls.startAnswer, ['Warden'], 'адресованный вопрос ушёл именно названной роли');

  // Адресат назван, но не готов: вопрос не отдаём другому и не теряем.
  calls.log.length = 0;
  calls.startAnswer.length = 0;
  const notReady = await build()(mission, { id: 'row-2', text: 'Нужно решение', need: 'Locale Auditor' });
  assert.equal(notReady, false, 'неготовый адресат — не повод отдать вопрос другому');
  assert.deepEqual(calls.startAnswer, [], 'ход никуда не ушёл');
  assert.match(calls.log.join(' '), /не готова/, 'журнал говорит, что адресат не готов, а не молчит');

  // Совсем неизвестное имя — та же история: строка живёт, Мастер увидит.
  calls.log.length = 0;
  const unknown = await build()(mission, { id: 'row-3', text: 'Нужно решение', need: 'Kernel' });
  assert.equal(unknown, false, 'роль без строки в «Ролях» вопрос не получает');
  assert.match(calls.log.join(' '), /нет в «Ролях»/, 'сказано, чего именно не хватает');

  // Вопрос без адресата — прежнее поведение: активный Reviewer.
  calls.startAnswer.length = 0;
  await build()(mission, { id: 'row-4', text: 'Обычный вопрос' });
  assert.deepEqual(calls.startAnswer, ['Spec Auditor'], 'без need ответ даёт активная роль с функцией Reviewer');
}

// ── 3. При остановке вопрос читается, а не выбрасывается ───────────────────
{
  const block = cut('      const blocked = norm(decision.next) === "blocked";', '        // D-083: остановка с адресованным вопросом');
  assert.match(block, /const asked = questionInMarker\(decision\.question, blocked/, 'вопрос разбирается при любом next');
  assert.match(block, /if \(blocked\) asked\.question\.gate = true;/, 'при остановке вопрос держит ход по определению');
  assert.match(block, /if \(!asked\.question\.need && need\) asked\.question\.need = need;/, 'need остановки становится адресатом вопроса');

  // Ветка вопроса не должна снова оказаться под `next !== "blocked"`.
  assert.doesNotMatch(src, /if \(norm\(decision\.next\) !== "blocked"\) \{\s*\/\/ Та же история, что у исполнителя/,
    'ветка вопроса больше не спрятана под проверкой next');

  const stopFrom = src.indexOf('        // D-083: остановка с адресованным вопросом');
  const stopTo = src.indexOf('        // Право Координатора остановить цикл.', stopFrom);
  assert.ok(stopFrom > 0 && stopTo > stopFrom, 'ветка остановки собрана целиком');
  const stop = src.slice(stopFrom, stopTo);
  assert.match(stop, /startAnswer\(mission, item\)/, 'при остановке ход переводится адресату');
  assert.match(stop, /GM_setValue\("cfn-blocked-norole", 0\)/, 'законный прямой вопрос не считается ложной остановкой');
  // Строка question при остановке не пишется второй раз.
  assert.match(src, /let askRow = askedRow;/, 'вопрос при остановке не дублируется');
}

// ── 4. Промпт: канал назван, адрес назван, «только остановкой» не написано ──
{
  const { PromptCompiler, planRequest, dispatchRequest } = await import('./helpers/prompt-env.mjs');
  const coordinator = PromptCompiler.compile(planRequest()).text;
  const executor = PromptCompiler.compile(dispatchRequest('Executor')).text;

  assert.match(coordinator, /question в маркере/, 'канал обратной связи привязан к полю маркера');
  assert.match(coordinator, /gate:true\s*\+\s*need:/, 'адресный gate-вопрос задаёт точную роль');
  assert.match(coordinator, /Ответ вернётся Координатору новым планом/, 'ответ возвращает Координатора к следующему плану');
  assert.match(coordinator, /Срочно нужен ответ: question с gate:true \+ need:/,
    'прямой канал противопоставлен остановке — именно это Координатор и не знал');
  assert.match(coordinator, /Обратную связь в Notion руками не пиши/, 'запрет ручной записи сохранён');

  // Исполнителю адрес не нужен, а бюджет его карточки платить не должен.
  assert.doesNotMatch(executor, /не next:"blocked"/, 'исполнителю клауза про остановку не нужна');
  assert.match(executor, /question в маркере/, 'канал назван и у исполнителя');
  assert.match(executor, /Результат вернётся с прежними ID после ответа/,
    'gate-ответ возобновляет тот же результат с прежними ID');

  // Не «вопрос ради вопроса»: обычный вопрос по-прежнему не держит ход.
  assert.match(executor, /Без gate — по default/, 'обычный вопрос не останавливает работу');
}

console.log('OK: D-083 — прямой вопрос к роли уходит адресату и держит ход, остановка для этого не нужна');
