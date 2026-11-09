// Проба 1.14.8 (D-080): вопрос перестал быть остановкой по умолчанию.
//
// Что сказал Мастер:
//   · «агент обязан выдать конкретный next, а вопрос должен вставать в ступор
//     ради мнения (Warden)» — то есть одно и то же действие, вопрос, означало и
//     «спросить между делом», и «остановиться и ждать». Из-за этого агент либо
//     стоял там, где мог идти, либо выдумывал next, чтобы не стоять;
//   · «Координатор не знает, что ответ доставляется сразу» — ответ на свой
//     вопрос должен возвращаться тому, кто спросил;
//   · сроки («Срок», «Принят дефолт», `hours`) — устаревшая механика.
//
// Решение D-080:
//   1. Ход держит только явный `gate: true` (+ `need`); обычный вопрос идёт
//      рядом с работой, и ход продолжается по `default`.
//   2. Ответ адресный: `answers.mine` в промпте спрашивающего, отметка
//      «Доставлено» ставится только роли-адресату.
//   3. Сроков нет: `closeExpired` ничего не закрывает, `Срок` не пишется,
//      «Принят дефолт» больше не ставится.
//   4. `Тип` — select, значение ставит транспорт.
//
// Проба падает на бандле 1.14.7: там `parseQuestion` возвращает `hours`, любой
// вопрос зовёт приёмку, `closeExpired` закрывает строки, а блока `answers.mine`
// в промптах нет.

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
const sel = (p) => p?.select?.name || '';

// ── 1. Разбор вопроса: gate/need вместо срока ──────────────────────────────
const block = cut('  const Q = {', '  async function questionBriefing(');
const api = new Function(
  'C', 'rt', 'sel', 'norm', 'GM_getValue', 'GM_setValue', 'notion', 'patch', 'log', 'K',
  'noteQuestionAsked', 'dbg', 'queueAnswer', 'richText', 'query', 'questionRows', 'activeMission',
  `${block}\nreturn { Q, parseQuestion, questionGate, questionInMarker, questionProps, askQuestion, markDelivered, closeExpired, expiredQuestions, answersMineLine };`,
)(
  { questionLineMax: 3, questionTextMax: 180, questionDefaultMax: 200, questions: 'ds-questions' },
  rt, sel, (v) => String(v == null ? '' : v).trim().toLowerCase(),
  () => false, () => {}, async () => ({}), async () => {}, () => {}, { expect: 'cfn-expect' },
  () => {}, () => {}, () => {}, () => ({}), async () => [],
  async () => [], async () => null,
);

{
  const plain = api.parseQuestion({ text: 'Менять ли оракул?', default: 'не менять' });
  assert.equal(plain.gate, false, 'обычный вопрос не держит ход');
  assert.equal(plain.need, '', 'и никого не называет');
  assert.equal(plain.hours, undefined, 'срока в вопросе больше нет');

  const gated = api.parseQuestion({ text: 'Публиковать ли ADR?', default: 'не публиковать', gate: true, need: 'Warden' });
  assert.equal(gated.gate, true, 'gate читается');
  assert.equal(gated.need, 'Warden', 'need называет, чьё мнение нужно');

  // Модель пишет булево как придётся. Явное «да» — остановка; невнятное — нет:
  // молчаливая остановка хода дороже лишнего вопроса без неё.
  for (const value of [true, 'true', 'да', 'yes', 1, '1']) {
    assert.equal(api.questionGate(value), true, `«${value}» — это да`);
  }
  for (const value of [false, 'false', 'нет', undefined, null, 0, '', 'может быть']) {
    assert.equal(api.questionGate(value), false, `«${value}» — это не да`);
  }
}

// ── 2. Строка в базе: «Тип» ставит транспорт, «Срок» не пишется ────────────
{
  const props = api.questionProps(api.parseQuestion({ text: 'Вопрос по ходу?', default: 'идти дальше' }), { roleName: 'Executor' });
  assert.equal(props['Тип'].select.name, 'Вопрос', 'тип строки — вопрос');
  assert.equal(props['Срок'], undefined, 'срок не пишется: механики сроков нет');
  assert.equal(props['Статус'].select.name, 'Ждёт', 'строка ждёт ответа');

  const proposal = api.questionProps(
    api.parseQuestion({ text: 'ADR: принять?', default: 'оставить', proposal: true }),
    { roleName: 'Architect' },
  );
  assert.equal(proposal['Тип'].select.name, 'Предложение', 'предложение помечено типом');
}

// ── 3. Срок больше ничего не закрывает ────────────────────────────────────
{
  const lines = [];
  const closeExpired = new Function(
    'rt', 'patch', 'Q', 'richText', 'log', 'sel', 'notion', 'withQuestionWriteLock',
    `${cut('  async function closeExpired(', '  /** Строки базы «Вопросы» с нужным статусом')}\nreturn closeExpired;`,
  )(
    rt, async () => { throw new Error('по сроку PATCH не ставится'); },
    { wait: 'Ждёт', done: 'Решено', byDefault: 'Принят дефолт', cancelled: 'Отменён' },
    (t) => [{ text: { content: t } }], (text) => lines.push(text), sel,
    async () => { throw new Error('Notion не читается'); }, (work) => work(),
  );
  const rows = [{ id: 'r1', properties: { 'Статус': { select: { name: 'Ждёт' } }, 'Срок': { date: { start: '2000-01-01T00:00:00.000Z' } } } }];
  assert.equal(await closeExpired(rows), 0, 'старый срок никого не закрывает');
  assert.match(lines.at(-1), /больше не закрываются/, 'и журнал говорит прямо, что срок больше не решение');
  assert.doesNotMatch(src, /"Принят дефолт"\)/, 'статус «Принят дефолт» транспортом не ставится');
}

// ── 4. Ход держит только gate, а не сам факт вопроса ──────────────────────
{
  // D-083: ветка вопроса больше не спрятана под `next !== "blocked"` — иначе
  // вопрос, поданный вместе с остановкой, выбрасывался целиком.
  const adr = cut('      if (askedRow && (askedRow.gate', '      if (blocked) {');
  assert.match(adr, /askedRow\.gate === true \|\| askedRow\.need/, 'ход уходит приёмке только по gate/need');
  assert.match(adr, /ход идёт дальше по/, 'обычный вопрос не мешает next');
  // Остановка с адресованным вопросом — ход к адресату, а не пауза для Мастера.
  const blockedAsk = cut('      if (blocked) {\n        // D-083', '        // Право Координатора');
  assert.match(blockedAsk, /startAnswer\(mission, item\)/, 'ответ адресата ставится отдельным ходом');
  assert.match(blockedAsk, /item\.gate === true \|\| item\.need/, 'при остановке ведёт именно адресованный вопрос');
  assert.match(blockedAsk, /return true;/, 'ход Координатора на этом заканчивается, а не висит');

  const ask = cut('  async function askQuestion(q, ctx = {}) {', '  /**\n   * Отметить ответы доставленными');
  assert.match(ask, /if \(!q\.gate && !ctx\.forceAnswer\) \{/, 'askQuestion различает обычный вопрос и остановку');
  assert.match(ask, /Ход не останавливается/, 'и говорит об этом в журнале');
}

// ── 5. Ответ приходит тому, кто спросил ───────────────────────────────────
{
  assert.match(src, /def\("answers\.mine"/, 'блок адресных ответов есть в промптax');
  assert.match(src, /answers\.mine/, 'и подключён к карточкам');
  assert.match(src, /markDelivered\(answersShown, Date\.now\(\), role\.name\)/, 'отметка доставки адресная');

  const delivered = [];
  const patch = async (id, props) => delivered.push({ id, props });
  const markDelivered = new Function(
    'rt', 'sel', 'norm', 'patch', 'dbg',
    `${cut('  async function markDelivered(', '  /** Строки базы «Вопросы» с нужным статусом')}\nreturn markDelivered;`,
  )(
    rt, sel, (v) => String(v || '').trim().toLowerCase(), patch, () => {},
  );
  const rows = [
    { id: 'mine', properties: { 'Роль': { rich_text: [{ plain_text: 'Executor' }] } } },
    { id: 'other', properties: { 'Роль': { rich_text: [{ plain_text: 'Auditor' }] } } },
  ];
  await markDelivered(rows, Date.now(), 'Executor');
  assert.deepEqual(delivered.map((d) => d.id), ['mine'], 'отметка только своей роли');
  assert.match(delivered[0].props['Доставлено'].date.start, /^\d{4}-/, 'дата записана');
}

// ── 6. `Тип` описан в схеме, а лишние поля называются вслух ────────────────
{
  const schema = cut('["Обратная связь", C.questions,', '];\n    const schemas');
  assert.match(schema, /"Тип": "select"/, 'Тип — select в той же таблице, что и остальные поля');
  assert.match(schema, /"Тип": \["Вопрос", "Предложение"\]/, 'и его варианты проверяются');
  assert.match(src, /лишние поля — \$\{extra\.join/, 'лишнее поле в живой базе называется, а не молчит');
  assert.doesNotMatch(src, /afterCreate\.feedback/, 'формулы «Тип» больше нет ни в коде, ни в шаблоне');
}

console.log(
  'OK: relay 1.14.8 — вопрос держит ход только по gate, ответ приходит спросившему, ' +
    'сроки убраны из поведения, «Тип» пишет транспорт',
);
