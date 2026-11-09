// Проба 1.14.9 (D-081): вопрос Координатора не дошёл до Warden.
//
// Случай Мастера (09.11, журнал 15:34–15:49):
//   15:34:53 «Новая обратная связь: «ADR: опубликовать ТЗ SYN-3 1.6 …» —
//            по умолчанию: Вариант 1 … Отвечает приёмка»;
//   15:35:18 автоцикл включён;
//   15:39:10 маркер Координатора: дальше «Locale Auditor»;
//   15:49:13 ответ Locale Auditor записан → ход вернулся Координатору.
//
// Круг замкнулся, строка осталась «Ждёт», хода Warden не было.
//
// Разбор: дефектов три, все наши.
//   1. `gate` не переживал запись в базу. Отметку «ждёт ответа» читал
//      `questionFromRow`, но `questionProps` её никогда не писал: любая строка,
//      прочитанная из Notion, становилась обычным вопросом. Здесь же — вторая
//      половина: «повтор с gate» возвращал строку, не ставя её в очередь.
//   2. Очередь приёмки читалась НИЖЕ ветки «ожидание принадлежит другой роли».
//      Пока цикл чего-то ждал (а после «Продолжить» — того же Координатора),
//      приёмка не проверялась вовсе. Вопрос жил строкой, но хода к Warden не
//      получал — ровно то, что увидел Мастер.
//   3. `живая база`: `Тип` в Notion был формулой, а код уже писал select —
//      значение уходило в пустоту.
//
// Проба падает на бандле 1.14.8: `questionProps` не пишет «ждёт ответа», а
// проверка `answerPending()` стоит после ветки чужого ожидания.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `фрагмент на месте: ${from.trim()}`);
  return src.slice(a, b);
};
const rt = (p) =>
  (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');

// ── 1. Отметка остановки переживает запись и чтение ────────────────────────
{
  const api = new Function(
    'C', 'rt', 'sel', 'richText',
    `${cut('  const Q = {', '  async function questionBriefing(')}
     return { parseQuestion, questionInMarker, questionProps, questionFromRow };`,
  )(
    { questionTextMax: 180, questionDefaultMax: 200 },
    rt,
    (p) => p?.select?.name || '',
    (t) => [{ type: 'text', text: { content: t } }],
  );

  // Вопрос Координатора из журнала: остановка + ссылка на ADR.
  const asked = api.parseQuestion({
    text: 'ADR: опубликовать ТЗ SYN-3 1.6 (V-2, три уточнения), очередь 1.8 и решение D-081',
    default: 'Вариант 1. Warden публикует ТЗ SYN-3 1.6',
    blocks: 'B0-r1 (Sequence 2) нельзя выставить в Ready',
    gate: true,
  });
  assert.equal(asked.gate, true, 'вопрос разобран как остановка');

  const props = api.questionProps(asked, { roleName: 'Coordinator', mission: 'SYN-3' });
  const blocksText = rt(props['Что блокирует']);
  assert.match(blocksText, /ждёт ответа/, 'отметка остановки записана в строку');
  assert.match(blocksText, /B0-r1/, 'и не съела «что блокирует» — оно осталось читаемым');

  // Самое важное: чтение строки обратно даёт тот же gate.
  const fromRow = api.questionFromRow({ properties: props });
  assert.equal(fromRow.gate, true, 'gate восстановлен из строки — остановка не потерялась');

  // Обычный вопрос отметки не получает и остановкой не становится.
  const plain = api.questionProps(api.parseQuestion({ text: 'Менять ли оракул?', default: 'не менять' }), {});
  assert.equal(api.questionFromRow({ properties: plain }).gate, false, 'обычный вопрос остаётся обычным');
}

// ── 2. Очередь приёмки читается ДО ветки чужого ожидания ───────────────────
{
  const at = src.indexOf('const waiting = answerPending();');
  const ownerBranch = src.indexOf('if (expect && norm(expect.roleId) !== norm(me.id)) {');
  assert.ok(at > 0, 'проверка очереди приёмки есть в тике');
  assert.ok(ownerBranch > 0, 'ветка «ожидание другой роли» на месте');
  assert.ok(at < ownerBranch, 'очередь приёмки важнее ожидания чужого хода');

  const around = src.slice(Math.max(0, at - 700), at + 400);
  assert.match(around, /me\.fn !== "Reviewer"/, 'приёмка не зовёт себя');
  assert.match(around, /startAnswer\(missionForAnswer, waiting\)/, 'и ставит ход отдельной записью');

  // Раньше вопрос не доходил: цикл возвращался к странице ожидания выше.
  const tick = cut('async function tick(fromToggle = false) {', '\n  // ──');
  const early = tick.indexOf('const waiting = answerPending();');
  const late = tick.indexOf('if (expect?.kind === "dispatch")');
  assert.ok(early > 0 && late > early, 'проверка стоит в начале тика, до разбора хода');
}

// ── 3. Повтор вопроса с остановкой всё равно ставит ход приёмке ────────────
{
  const ask = cut('  async function askQuestion(q, ctx = {}) {', '  /**\n   * Отметить ответы доставленными');
  // Ветка «строка уже есть» передаёт её приёмке — очередь ответа не теряется.
  assert.match(ask, /handWaitingRow\(same\.row, complete, ctx\)/, 'висящая строка передаётся приёмке');
  // Чтение страницы может не удаться: тогда вопрос берётся из самой строки.
  assert.match(src, /handWaitingRow\(same\.row, complete \|\| questionFromRow\(same\.row\), item\.ctx \|\| \{\}\)/,
    'очередь приёмки не остаётся с пустым вопросом, если страница не прочиталась');
  // Повтор того же хода с gate не теряет признак остановки.
  assert.match(ask, /return q\.gate \? \{ id: "", text: q\.text, gate: true, need: q\.need \|\| "", repeat: true \} : null;/,
    'повтор с gate возвращает остановку вызывающему');
}

// ── 4. ADR-предложение держит ход по своей природе ─────────────────────────
{
  assert.match(src, /gate: true,\s*\n\s*need: "",/, 'предложение ADR всегда с остановкой');
  assert.match(src, /Вопрос при `blocked` задаётся уже стоящему циклу/,
    'вопрос при остановке тоже держит ход');
}

// ── 5. В схеме «Обратной связи» есть «Тип», и он select ────────────────────
{
  const schema = cut('["Обратная связь", C.questions,', '];\n    const schemas');
  assert.match(schema, /"Тип": "select"/, 'Тип описан как select');
}

console.log(
  'OK: relay 1.14.9 — остановка вопроса переживает запись в базу, очередь приёмки важнее ' +
    'чужого ожидания, вопрос Координатора доходит до Warden',
);
