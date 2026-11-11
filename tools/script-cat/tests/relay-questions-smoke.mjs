// Проба 1.4.63: вопрос к Мастеру — поле в базе «Вопросы», а не остановка.
//
// 25.10 фаза 2 дала два вопроса, и оба потерялись: один остался строкой в поле
// «Ответ» карточки, второй — предложением выбрать вариант в конце хода.
// Регламент запрещал вопросы вовсе, а остановить цикл можно было только одним
// способом — «нет роли». Проверяется новый порядок:
//
//   • вопрос без варианта по умолчанию не принимается (иначе это остановка);
//   • вопрос уходит в базу «Вопросы» как строка со сроком, статусом «Ждёт» и
//     вариантом по умолчанию — Мастеру есть где его увидеть;
//   • открытые вопросы видны агенту, чтобы он не задавал их снова;
//   • ответ Мастера доставляется ровно один раз и только после отправки промпта;
//   • срок вышел — вопрос закрывается вариантом по умолчанию, а не тишиной;
//   • повторный маркер того же хода не создаёт вторую строку.

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);

const sliceBetween = (startMarker, endMarker) => {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from);
  assert.ok(from > 0 && to > from, `блок ${startMarker.slice(0, 40)} на месте`);
  return src.slice(from, to);
};

const block = sliceBetween('  const Q = {', '  async function questionBriefing(');

const store = new Map();
const created = [];
const patched = [];
const lines = [];

const liveRows = new Map();
const api = new Function(
  'C', 'rt', 'sel', 'norm', 'GM_getValue', 'GM_setValue', 'notion', 'patch', 'log', 'K', 'noteQuestionAsked', 'dbg', 'queueAnswer', 'richText', 'query',
  `${block}
   return { Q, parseQuestion, expiredQuestions, openQuestionsLine, answersLine, questionProps, askQuestion, markDelivered, closeExpired };`,
)(
  { questionHours: 24, questionLineMax: 3, questionTextMax: 180, questionDefaultMax: 200, questions: 'ds-questions' },
  (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join(''),
  (p) => p?.select?.name || '',
  (value) => String(value == null ? '' : value).trim().toLowerCase(),
  (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  (key, value) => store.set(key, value),
  async (method, path, body) => {
    if (method === 'GET') {
      const row = liveRows.get(path.slice('pages/'.length));
      if (!row) throw new Error(`нет строки ${path}`);
      return row;
    }
    created.push({ method, path, body });
    return { id: `row-${created.length}` };
  },
  async (id, properties) => patched.push({ id, properties }),
  (text) => lines.push(text),
  { qQueue: 'cfn-q-queue' },
  () => {},
  () => {},
  () => null,
  (value) => {
    const text = String(value == null ? '' : value);
    const parts = [];
    let at = 0;
    while (at < text.length && parts.length < 100) {
      let end = Math.min(text.length, at + 1900);
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
      parts.push({ type: 'text', text: { content: text.slice(at, end) } });
      at = end;
    }
    return parts;
  },
  async () => [],
);

const props = (over = {}) => ({
  'Вопрос': { title: [{ plain_text: over.text ?? 'Менять ли оракул §2?' }] },
  'Статус': { select: { name: over.status ?? 'Ждёт' } },
  'По умолчанию': { rich_text: [{ plain_text: over.fallback ?? 'не менять' }] },
  'Ответ': { rich_text: over.answer ? [{ plain_text: over.answer }] : [] },
  'Срок': { date: over.due === undefined ? { start: '2026-10-26T10:00:00.000Z' } : over.due ? { start: over.due } : null },
  'Доставлено': { date: over.delivered ? { start: over.delivered } : null },
  'Роль': { rich_text: over.role ? [{ plain_text: over.role }] : [] },
  'Карточка': { rich_text: [] },
  'Миссия': { rich_text: [{ plain_text: 'NAR-2' }] },
  'Варианты': { rich_text: [] },
  'Что блокирует': { rich_text: [] },
});

// ── 1. Разбор поля question ────────────────────────────────────────────────
{
  const q = api.parseQuestion({ text: '  Менять ли   оракул? ', default: 'не менять', options: ['A', 'B', 'C'], gate: true, need: 'Warden' });
  assert.equal(q.text, 'Менять ли оракул?', 'текст в одну строку');
  assert.equal(q.fallback, 'не менять', 'вариант по умолчанию');
  assert.deepEqual(q.options, ['A', 'B', 'C'], 'варианты сохранены');
  // D-080: сроков нет, ход останавливает только gate.
  assert.equal(q.gate, true, 'gate читается из вопроса');
  assert.equal(q.need, 'Warden', 'need называет, чьё мнение нужно');
  assert.equal(api.parseQuestion({ text: 'Вопрос?', default: 'A' }).gate, false, 'обычный вопрос ход не держит');

  assert.equal(api.parseQuestion({ text: 'Вопрос без дефолта' }), null, 'без варианта по умолчанию — не вопрос');
  assert.equal(api.parseQuestion({ default: 'A' }), null, 'без текста — не вопрос');
  assert.equal(api.parseQuestion(null), null, 'null — не вопрос');
  assert.equal(api.parseQuestion('строка вместо объекта'), null, 'строка — не вопрос');
  assert.equal(api.parseQuestion(['a']), null, 'массив — не вопрос');

  const many = api.parseQuestion({ text: 'q', default: 'a', options: ['1', '2', '3', '4', '5', '6'] });
  assert.equal(many.options.length, 4, 'вариантов не больше четырёх');
  assert.equal(api.parseQuestion({ text: 'q', default: 'a', gate: 'да' }).gate, true, 'gate строкой — это да');
  assert.equal(api.parseQuestion({ text: 'q', default: 'a' }).hours, undefined, 'срока в вопросе больше нет');
  assert.ok(api.parseQuestion({ text: 'x'.repeat(500), default: 'a' }).text.length <= 180, 'текст обрезан');
}

// ── 2. Строка записи: статус, срок, вариант по умолчанию ───────────────────
{
  const q = api.parseQuestion({ text: 'Сжигать ли старую копию?', default: 'оставить', options: ['A', 'B'], blocks: 'NAR-2.6' });
  const properties = api.questionProps(q, { roleName: 'Coordinator', card: 'NAR-2.6', mission: 'NAR-2' });
  assert.equal(properties['Статус'].select.name, 'Ждёт', 'ждёт ответа');
  assert.equal(properties['Вопрос'].title[0].text.content, 'Сжигать ли старую копию?', 'текст — заголовок строки');
  assert.equal(properties['По умолчанию'].rich_text[0].text.content, 'оставить', 'вариант по умолчанию в строке');
  // D-080: поле «Срок» в базе осталось историей, транспорт его больше не пишет.
  assert.equal(properties['Срок'], undefined, 'срок не пишется: сроков в поведении нет');
  assert.equal(properties['Тип'].select.name, 'Вопрос', 'тип строки ставит транспорт');
  assert.equal(properties['Варианты'].rich_text[0].text.content, 'A · B', 'варианты одной строкой');
  assert.equal(properties['Что блокирует'].rich_text[0].text.content, 'NAR-2.6', 'что блокирует');
  assert.equal(properties['Роль'].rich_text[0].text.content, 'Coordinator', 'роль автора');

  const noOptions = api.questionProps(api.parseQuestion({ text: 'q', default: 'a' }), {});
  assert.equal(noOptions['Варианты'], undefined, 'пустые варианты не создают поле');
  assert.equal(noOptions['Что блокирует'], undefined, 'пустое «что блокирует» не создаёт поле');
  assert.equal(noOptions['Карточка'].rich_text[0].text.content, '—', 'карточки нет — прочерк');
}

// ── 3. Срок: что считать истёкшим ──────────────────────────────────────────
{
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  const rows = [
    { id: 'a', properties: props({ status: 'Ждёт', due: '2026-10-26T11:00:00.000Z' }) },
    { id: 'b', properties: props({ status: 'Ждёт', due: '2026-10-26T13:00:00.000Z' }) },
    { id: 'c', properties: props({ status: 'Решено', due: '2026-10-20T00:00:00.000Z' }) },
    { id: 'd', properties: props({ status: 'Ждёт', due: null }) },
  ];
  // D-080: сроков нет. Функция осталась только как «есть старый Срок» — для
  // предупреждения при подключении; закрывать по ней нечего.
  assert.deepEqual(api.expiredQuestions(rows, now).map((r) => r.id), ['a', 'b'], 'старый срок виден у всех, кто ждёт');
  assert.deepEqual(api.expiredQuestions([], now), [], 'пусто — пусто');
}

// ── 3б. Длинный вариант по умолчанию не режется и не отвергается (D-072) ───
// 08.11 боевой SYN-3 встал на пределе в 200 знаков: агент дал полный вариант
// («Одним PR Warden'а: ТЗ SYN-3 1.5 …, очередь 1.7, D-070 и страница миссии…»),
// а транспорт объявил его «слишком длинным» и приёмке не передал. Решение, по
// которому идёт работа, сокращать нельзя.
{
  const longDefault = `${'Одним PR Warden\'а: ТЗ SYN-3 1.5, очередь 1.7, D-070. '.repeat(6)}конец`;
  assert.ok(longDefault.length > 200, 'вариант длиннее прежнего предела');
  const q = api.parseQuestion({ text: 'Публиковать ли одним PR?', default: longDefault });
  assert.equal(q.fallback, longDefault, 'вариант сохранён целиком, без усечения и без отказа');
  const props = api.questionProps(q, { roleName: 'Coordinator', mission: 'SYN-3' });
  assert.equal(props['По умолчанию'].rich_text.map((x) => x.text.content).join(''), longDefault,
    'в Notion уходит ровно тот же текст');
}

// ── 4. Строки для промпта ──────────────────────────────────────────────────
{
  const open = [
    { id: '1', properties: props({ text: 'Менять ли оракул?', fallback: 'не менять' }) },
    { id: '2', properties: props({ text: 'Публиковать ли копию?', fallback: 'опубликовать' }) },
  ];
  const line = api.openQuestionsLine(open);
  assert.match(line, /Обратная связь без ответа \(вопросы и предложения\):/, 'открытые названы');
  assert.match(line, /«Менять ли оракул\?» \(по умолчанию: не менять\)/, 'виден вариант по умолчанию');
  assert.match(line, /не задавай их снова/, 'повторять вопрос запрещено');
  assert.equal(api.openQuestionsLine([]), '', 'нет открытых — нет строки');

  const answered = [
    { id: '3', properties: props({ status: 'Решено', text: 'Менять ли оракул?', answer: 'менять' }) },
    { id: '4', properties: props({ status: 'Принят дефолт', fallback: 'оставить', answer: 'оставить', text: 'Копия?' }) },
  ];
  const answers = api.answersLine(answered);
  assert.match(answers, /Ответы на обратную связь/, 'ответы доставляются');
  assert.match(answers, /«Менять ли оракул\?» → менять/, 'вопрос и ответ рядом');
  assert.match(answers, /срок истёк, принят вариант по умолчанию/, 'видно, что ответил не Мастер, а срок');
  assert.equal(api.answersLine([]), '', 'нет ответов — нет строки');

  const many = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, properties: props({ text: `вопрос ${i}` }) }));
  assert.match(api.openQuestionsLine(many), /и ещё 3/, 'лишние свёрнуты');
}

// ── 5. Запись вопроса ──────────────────────────────────────────────────────
const run = async () => {
  const q = api.parseQuestion({ text: 'Сжигать ли копию?', default: 'оставить' });
  const row = await api.askQuestion(q, { roleName: 'Coordinator', card: 'NAR-2.6', mission: 'NAR-2', key: 'turn-1' });
  assert.equal(row.id, 'row-1', 'строка создана');
  assert.equal(created.length, 1, 'ровно один запрос в Notion');
  assert.equal(created[0].method, 'POST', 'создание страницы');
  assert.equal(created[0].path, 'pages', 'через pages');
  assert.equal(created[0].body.parent.data_source_id, 'ds-questions', 'пишем в базу «Вопросы»');
  assert.equal(created[0].body.parent.type, 'data_source_id', 'родитель — источник данных');
  // D-080: обычный вопрос не зовёт приёмку и не держит ход — журнал говорит
  // прямо, что ход идёт дальше и ответ придёт в следующий промпт.
  assert.match(lines.at(-1), /По умолчанию работа идёт по нему: оставить/, 'в журнале есть вариант, по которому идём');
  assert.match(lines.at(-1), /Ход не останавливается/, 'и сказано, что ход не стоит');

  await api.askQuestion(q, { key: 'turn-1' });
  assert.equal(created.length, 1, 'повторный маркер того же хода не создаёт вторую строку');

  // Ошибка Notion не срывает ход.
  const failing = new Function(
    'C', 'rt', 'sel', 'norm', 'GM_getValue', 'GM_setValue', 'notion', 'patch', 'log', 'K', 'noteQuestionAsked', 'dbg', 'queueAnswer', 'richText', 'query',
    `${block}
     return { parseQuestion, askQuestion };`,
  )(
    { questionHours: 24, questionLineMax: 3, questionTextMax: 180, questionDefaultMax: 200, questions: 'ds-questions' },
    () => '',
    () => '',
    (v) => String(v).trim().toLowerCase(),
    () => false,
    () => {},
    async () => {
      throw new Error('Notion недоступен');
    },
    async () => {},
    (text) => lines.push(text),
    { qQueue: 'cfn-q-queue' },
    () => {},
    () => {},
    () => null,
    (value) => {
      const text = String(value == null ? '' : value);
      const parts = [];
      let at = 0;
      while (at < text.length && parts.length < 100) {
        let end = Math.min(text.length, at + 1900);
        const code = text.charCodeAt(end - 1);
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
        parts.push({ type: 'text', text: { content: text.slice(at, end) } });
        at = end;
      }
      return parts;
    },
    async () => [],
  );
  const none = await failing.askQuestion(failing.parseQuestion({ text: 'q', default: 'a' }), { key: 'turn-x' });
  assert.equal(none, null, 'ошибка записи не возвращает строку');
  assert.match(lines.at(-1), /идёт по варианту по умолчанию/, 'и не срывает ход');

  // ── 6. Доставка ответа адресная, закрытия по сроку нет (D-080) ───────────
  patched.length = 0;
  const deliveredRows = [
    { id: 'row-3', properties: props({ role: 'Executor' }) },
    { id: 'row-4', properties: props({ role: 'Auditor' }) },
  ];
  await api.markDelivered(deliveredRows, Date.now(), 'Executor');
  assert.equal(patched.length, 1, 'отметка ставится только тому, кому доставлено');
  assert.match(patched[0].properties['Доставлено'].date.start, /^\d{4}-/, 'дата доставки записана');

  patched.length = 0;
  await api.markDelivered(deliveredRows);
  assert.equal(patched.length, 2, 'без роли отметка ставится всем адресатам');

  patched.length = 0;
  const expiredRows = [
    { id: 'r1', properties: props({ status: 'Ждёт', fallback: 'не менять', text: 'Оракул?', due: '2000-01-01T00:00:00.000Z' }) },
    { id: 'r2', properties: props({ status: 'Ждёт', fallback: '', due: '2000-01-01T00:00:00.000Z' }) },
  ];
  for (const row of expiredRows) liveRows.set(row.id, row);
  const closed = await api.closeExpired(expiredRows);
  assert.equal(closed, 0, 'по сроку не закрывается ничего');
  assert.equal(patched.length, 0, 'ни статус, ни ответ не переписываются');
  assert.match(lines.at(-1), /больше не закрываются/, 'предупреждение о старом поле «Срок» не молчит');

  // ── 7. Подключение к ходу ────────────────────────────────────────────────
  // D-083: разбор маркера больше не спрятан под `next !== "blocked"`.
  assert.match(src, /const asked = questionInMarker\(decision\.question, blocked/, 'вопрос Координатора разбирается из маркера');
  assert.match(src, /"Работа идёт по решению Координатора"/, 'обычный вопрос по-прежнему идёт по решению Координатора');
  // При остановке вопрос записан раньше — второй раз не пишем (иначе про одно
  // и то же в базе две строки, и обе уходят приёмке вместо Мастера).
  assert.match(src, /let askRow = askedRow;/, 'вопрос при остановке берётся из уже записанной строки');
  assert.match(src, /if \(!askRow && askText\)/, 'вопрос при остановке не выбрасывается');
  assert.match(src, /Ответ Мастера: цикл уже остановлен и ждёт его/, 'у вопроса при остановке есть прямой вариант по умолчанию');
  assert.match(src, /const outgoingQuestion = result\.question != null\s*\? result\.question\s*:\s*review\?\.decision\?\.question != null\s*\? review\.decision\.question : null;/,
    'вопрос исполнителя разбирается из маркера, null не создаёт follow-up, review-вопрос сохраняется');
  assert.match(src, /if \(!expect\.deferredResult && outgoingQuestion != null\)/, 'пустой вопрос не записывается');
  assert.match(src, /await questionBriefing\(mission\)/, 'перед планом читаются вопросы и ответы');
  assert.match(src, /if \(sent\) await markDelivered\(briefing\.fresh\)/, 'ответ доставляется только после отправки');
  assert.match(src, /kind === "text"/, 'вопрос без варианта по умолчанию не выбрасывается');
  assert.doesNotMatch(
    src,
    /Не задавай вопросов, не создавай опросов/,
    'полный запрет вопросов убран: он и приводил к потерянным вопросам',
  );

  console.log('OK: relay 1.4.63 — вопрос к Мастеру живёт в базе «Вопросы», а цикл идёт по варианту по умолчанию');
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
