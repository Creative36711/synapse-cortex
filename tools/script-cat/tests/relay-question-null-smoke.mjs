// Проба 1.4.74: `"question":null` — это «вопроса нет», а не ошибка.
//
// Случай Мастера (25.10, 20:53). Tools закончил NAR-2.15 и прислал полный
// маркер, в котором поле вопроса было явно пустым:
//   CF_AGENT_RESULT {"dispatch":"…","run":"…","check":0,"report":"…",
//                    "pr":62,"merged":true,"question":null}
// Скрипт проверял `result.question !== undefined`, то есть считал `null`
// вопросом, `parseQuestion(null)` вопрос не принимал — и Мастер получил
// ГРОМКУЮ ошибку «Вопрос исполнителя без варианта по умолчанию» при том, что
// вопроса не было вовсе. Работа при этом шла своим ходом: PR #62 слит,
// NAR-2.15 Accepted, «Вопросы» пусты.
//
// Заодно тот же маркер дал вторую ложную строку: агент назвал ключи
// `dispatch`/`run` вместо `dispatch_id`/`run_id`, значения были верные, а
// журнал сказал «чужой или битый id». Теперь синонимы принимаются молча.
//
// Здесь проверяется:
//   • `null`, пустая строка и объект без текста — «вопроса нет», журнал молчит;
//   • вопрос с вариантом по умолчанию записывается как раньше;
//   • вопрос без варианта по умолчанию не выбрасывается, а получает честный
//     вариант «работа идёт по решению исполнителя/Координатора»;
//   • короткие ключи id не считаются чужими.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { assertUserscriptVersionContract } from '../version-oracle.mjs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const versionMatch = assertUserscriptVersionContract(src);
const V = versionMatch[1];

assert.match(src, new RegExp(`@version\\s+${V.replace(/\./g, '\\.')}`), `версия ${V}`);

// ── 1. В коде нет проверки «вопрос есть, если поле не undefined» ────────────
assert.doesNotMatch(
  src,
  /result\.question !== undefined/,
  'null больше не считается вопросом у исполнителя',
);
assert.doesNotMatch(
  src,
  /decision\.question !== undefined/,
  'null больше не считается вопросом у Координатора',
);
assert.match(
  src,
  /questionInMarker\(result\.question, "Работа идёт по решению исполнителя"\)/,
  'исполнитель: вопрос без варианта получает вариант «решение исполнителя»',
);
assert.match(
  src,
  /questionInMarker\(decision\.question, "Работа идёт по решению Координатора"\)/,
  'Координатор: вопрос без варианта получает вариант «решение Координатора»',
);
assert.doesNotMatch(
  src,
  /Вопрос исполнителя без варианта по умолчанию — не принят/,
  'громкой ошибки на пустое поле больше нет',
);

// ── 2. Песочница: oneLine + parseQuestion + questionInMarker ───────────────
const from = src.indexOf('const oneLine = (value, max) =>');
const to = src.indexOf('  /**\n   * Полный текст вопроса — в тело страницы.') > 0
  ? src.indexOf('  /**\n   * Полный текст вопроса — в тело страницы.')
  : src.indexOf('  function questionRows(');
assert.ok(from > 0 && to > from, 'разбор вопроса на месте');

const api = new Function(
  'C',
  `${src.slice(from, to)}
   return { oneLine, parseQuestion, questionInMarker };`,
)({ questionTextMax: 180, questionDefaultMax: 200, questionHours: 24 });

const FALLBACK = 'Работа идёт по решению исполнителя';

// 2.1. Поле пустое — вопроса нет, и это не повод для строки в журнале.
for (const empty of [undefined, null, '', '   ', {}, { text: '' }, { text: '  ', default: 'A' }]) {
  assert.equal(
    api.questionInMarker(empty, FALLBACK).kind,
    'none',
    `пустое поле (${JSON.stringify(empty)}) — не вопрос`,
  );
}

// 2.2. Нормальный вопрос с вариантом по умолчанию — как было.
{
  const got = api.questionInMarker(
    { text: 'Поднять лимит гайда до 294912?', options: ['Да', 'Нет'], default: 'Да', gate: true, need: 'Warden' },
    FALLBACK,
  );
  assert.equal(got.kind, 'asked', 'вопрос с вариантом принят');
  assert.equal(got.question.fallback, 'Да', 'вариант агента не перебит');
  // D-080: срока нет; сохранены признаки остановки.
  assert.equal(got.question.gate, true, 'gate агента сохранён');
  assert.equal(got.question.need, 'Warden', 'need агента сохранён');
  assert.equal(got.question.hours, undefined, 'срока в вопросе нет');
  assert.deepEqual(got.question.options, ['Да', 'Нет'], 'варианты сохранены');
}

// 2.3. Вопрос без варианта по умолчанию — не выбрасывается.
{
  const got = api.questionInMarker({ text: 'Поднять лимит гайда до 294912?', hours: 300 }, FALLBACK);
  assert.equal(got.kind, 'text', 'вопрос без варианта найден, а не потерян');
  assert.equal(got.question.text, 'Поднять лимит гайда до 294912?', 'текст сохранён');
  assert.equal(got.question.fallback, FALLBACK, 'вариант по умолчанию честный');
  assert.deepEqual(got.question.options, [], 'вариантов нет — пустой список, а не undefined');
  assert.equal(got.question.gate, false, 'без gate ход не держится (D-080)');
  assert.equal(got.question.hours, undefined, 'срока больше нет');
  assert.equal(typeof got.question.blocks, 'string', 'поле «что блокирует» готово к записи');
}
{
  const got = api.questionInMarker({ text: 'Что делать?', default: '', hours: 0 }, FALLBACK);
  assert.equal(got.kind, 'text', 'пустой default — это «без варианта», а не «нет вопроса»');
  assert.equal(got.question.fallback, FALLBACK, 'подставлен честный вариант по умолчанию');
}

// 2.4. Голой строкой вопрос тоже понимается — так агенты иногда пишут.
{
  const got = api.questionInMarker('Поднять лимит гайда?', FALLBACK);
  assert.equal(got.kind, 'text', 'строка — вопрос без варианта');
  assert.equal(got.question.text, 'Поднять лимит гайда?', 'текст строки сохранён');
}

// ── 3. Короткие ключи id — не чужие ────────────────────────────────────────
const idFrom = src.indexOf('const isUuid = (value) =>');
const idTo = src.indexOf('async function notion(method, path, body) {');
const { adoptIds } = new Function(
  'norm',
  `${src.slice(idFrom, idTo)}; return { adoptIds };`,
)((x) => String(x || '').trim().toLowerCase());

const REF = '4046f0cf-5705-81aa-86d1-cadfee435eb2';
const RUN = '4a2dba8e-7a61-4a69-9151-f9dfcc5f6df2';

// 3.1. Ровно тот маркер, что пришёл от Tools: ключи короткие, значения верные.
{
  const { result, stray } = adoptIds({ dispatch: REF, run: RUN }, { ref: REF, runId: RUN });
  assert.equal(result.dispatch_id, REF, 'id карточки взят из короткого ключа');
  assert.equal(result.run_id, RUN, 'run взят из короткого ключа');
  assert.deepEqual(stray, [], 'журнал молчит: id не чужой и не битый');
}

// 3.2. А чужое значение по-прежнему называется вслух.
{
  const { result, stray } = adoptIds({ dispatch: '4016f0cf-5705-8197-be3a-c06bf51885ac', run: RUN }, { ref: REF, runId: RUN });
  assert.equal(result.dispatch_id, undefined, 'чужой id не превращается в id текущей карточки');
  assert.equal(result.dispatch, '4016f0cf-5705-8197-be3a-c06bf51885ac', 'исходное значение сохранено');
  assert.equal(stray.length, 1, 'подмена названа');
  assert.match(stray[0], /dispatch_id/, 'в журнале видно, что именно не совпало');
}

console.log('relay-question-null-smoke: ok');
