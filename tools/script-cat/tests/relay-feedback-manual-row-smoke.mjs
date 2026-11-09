// D-082: обратная связь, созданная руками, тоже доходит до приёмки.
//
// 09.11 Координатор дважды создал предложение для Warden прямо в базе
// «Обратная связь» и считал, что спросил. Не дошло ни одно, и причин было две —
// обе в чтении, а не в записи:
//
//   1. «Статус» остался пустым (это пишет транспорт, а агент — не транспорт), а
//      запрос шёл строго `Статус = Ждёт`. Транспорт видел только свои строки.
//   2. В «Миссии» стоял голый UUID миссии. Сравнение `missionSame` работает по
//      словам названия, UUID названием не является — строка выпадала даже со
//      статусом.
//
// Проба держит оба случая и запрет из промпта: без неё правка «просто
// поправили запрос» незаметно откатится, потому что оба дефекта выглядят как
// «строка есть, значит видна».
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
const rt = (p) => (Array.isArray(p?.rich_text) ? p.rich_text.map((i) => i.plain_text || i.text?.content || '').join('') : '') ||
  (Array.isArray(p?.title) ? p.title.map((i) => i.plain_text || i.text?.content || '').join('') : '');
const sel = (p) => p?.select?.name || '';
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();

// ── 1. Строка без статуса и строка с UUID в «Миссии» — «свои» ──────────────
{
  const block = cut('  const missionKeyOf = (text) =>', '  async function questionRows(');
  const questionRowsSrc = cut('  async function questionRows(', '\n  /**', 0);
  const body = cut('  async function questionRows(', '  /**\n   * Что показать агенту про вопросы');
  const MISSION_STOPWORDS = new Set(['и', 'миссия', 'миссии', 'фаза', 'этап']);
  const missionWords = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w && !MISSION_STOPWORDS.has(w));
  const missionSame = (a, b) => {
    const left = missionWords(a), right = missionWords(b);
    if (!left.length || !right.length) return false;
    const key = (list) => [...list].sort().join(' ');
    if (key(left) === key(right)) return true;
    const [small, big] = left.length <= right.length ? [left, right] : [right, left];
    return small.length >= 3 && small.every((w) => big.includes(w));
  };
  const Q = { wait: 'Ждёт' };
  const make = new Function('rt', 'norm', 'missionSame', 'Q', 'query', 'C',
    `${block}${body}\nreturn { questionRows, rowInMission };`);
  const name = 'SYN-3 · Фаза 1.2 — измеримость: инвариант, который нельзя обойти молча';
  const mission = { id: '4126f0cf-5705-819c-89c3-c1566cf5b67a', properties: { 'Миссия': { title: [{ plain_text: name }] } } };
  const manual = { id: 'row-manual', properties: {
    'Вопрос': { title: [{ plain_text: 'SYN-3 · Предложение Warden: опубликовать ТЗ 1.7' }] },
    'Статус': { select: null },                                   // агент статуса не поставил
    'Миссия': { rich_text: [{ plain_text: mission.id }] },         // голый UUID вместо имени
    'Ответ': { rich_text: [] },
  } };
  const byName = { id: 'row-name', properties: {
    'Вопрос': { title: [{ plain_text: 'Имя миссии с хвостом' }] },
    'Статус': { select: { name: 'Ждёт' } },
    'Миссия': { rich_text: [{ plain_text: 'SYN-3 · Фаза 1.2 - измеримость (4126f0cf-5705-819c-89c3-c1566cf5b67a), круг 0' }] },
    'Ответ': { rich_text: [] },
  } };
  const foreign = { id: 'row-foreign', properties: {
    'Вопрос': { title: [{ plain_text: 'Чужая миссия' }] },
    'Статус': { select: { name: 'Ждёт' } },
    'Миссия': { rich_text: [{ plain_text: 'STAB-9 · Другая миссия' }] },
    'Ответ': { rich_text: [] },
  } };
  const rows = [manual, byName, foreign];
  const filters = [];
  const query = async (_ds, filter) => {
    filters.push(filter);
    const or = filter?.or || [];
    const statuses = or.map((c) => (c.select?.is_empty ? '' : c.select?.equals));
    return rows.filter((row) => statuses.includes(sel(row.properties['Статус']) || ''));
  };
  const api = make(rt, norm, missionSame, Q, query, { questions: 'ds' });

  const open = await api.questionRows([Q.wait], mission);
  assert.deepEqual(open.map((r) => r.id), ['row-manual', 'row-name'],
    'руками созданная строка без статуса и строка с UUID в «Миссии» — обе свои');
  assert(!open.some((r) => r.id === 'row-foreign'), 'строка чужой миссии не попадает в чтение');
  assert(filters[0].or.some((c) => c.select?.is_empty === true),
    'запрос открытых строк спрашивает и пустой статус: иначе руками созданная строка невидима');

  // Пустая «Миссия» — общая строка, как и было: правило не должно стать строже.
  assert.equal(api.rowInMission({ properties: { 'Миссия': { rich_text: [] } } }, mission), true, 'пустая «Миссия» — общая строка');
  // Другая миссия по UUID — не своя: мягкость не должна тянуть чужое.
  assert.equal(api.rowInMission({ properties: { 'Миссия': { rich_text: [{ plain_text: '40c6f0cf-5705-8133-b5fe-df05f4273d45' }] } } }, mission), false,
    'UUID другой миссии — не своя строка');
}

// ── 2. handWaitingRow принимает строку без статуса и не трогает решённую ────
{
  const body = cut('  function handWaitingRow(row, q = null, ctx = {}) {', '\n  /**\n   * Такой вопрос уже есть');
  const Q = { wait: 'Ждёт' };
  let queued = [];
  const make = new Function('sel', 'rt', 'Q', 'GM_setValue', 'queueAnswer', 'questionFromRow', 'answerHandoffKey', 'withQuestionWriteLock',
    `${body}\nreturn handWaitingRow;`);
  const hand = make(sel, rt, Q, () => {}, (row) => queued.push(row.id), () => ({ text: 'x' }), (id) => `h:${id}`, (w) => w());
  const waitingNoStatus = { id: 'a', properties: { 'Статус': { select: null }, 'Ответ': { rich_text: [] } } };
  const waiting = { id: 'b', properties: { 'Статус': { select: { name: 'Ждёт' } }, 'Ответ': { rich_text: [] } } };
  const solved = { id: 'c', properties: { 'Статус': { select: { name: 'Решено' } }, 'Ответ': { rich_text: [{ plain_text: 'да' }] } } };
  assert.equal(hand(waitingNoStatus), true, 'строка без статуса — долг транспорта, а не ответ');
  assert.equal(hand(waiting), true, 'обычная строка «Ждёт» — как раньше');
  assert.equal(hand(solved), false, 'решённая строка приёмке не передаётся');
  assert.deepEqual(queued, ['a', 'b'], 'в очередь приёмки попали обе ждущие строки');
}

// ── 3. «Миссия» в строке — имя, а не UUID ──────────────────────────────────
{
  const block = cut('  const missionKeyOf = (text) =>', '  async function questionRows(');
  const make = new Function(`${block}\nreturn { missionLabel };`);
  const { missionLabel } = make();
  const name = 'SYN-3 · Фаза 1.2 — измеримость';
  assert.equal(missionLabel(name), name, 'имя миссии пишется как есть');
  assert.equal(missionLabel('4126f0cf-5705-819c-89c3-c1566cf5b67a'), '',
    'голый UUID не пишется: иначе строка перестанет быть своей для той же миссии');
  assert.equal(missionLabel(''), '', 'пусто остаётся пустым');
}

// ── 4. Промпт: канал назван, запрет есть у Координатора ────────────────────
{
  const { PromptCompiler, dispatchRequest, planRequest } = await import('./helpers/prompt-env.mjs');
  const executor = PromptCompiler.compile(dispatchRequest('Executor')).text;
  const coordinator = PromptCompiler.compile(planRequest()).text;
  assert.match(executor, /Вопрос — question в маркере/, 'канал вопроса назван в общем правиле');
  assert.match(executor, /Опрос в чате — остановка/, 'запрет опроса в чате цел');
  assert.match(coordinator, /Обратную связь в Notion руками не пиши/,
    'Координатору прямо запрещено писать строку в базу: именно он это и сделал 09.11');
  assert.doesNotMatch(executor, /Обратную связь в Notion руками не пиши/,
    'исполнителю клауза не нужна — она платится бюджетом его карточки');
}

// ── 5. Приёмка видит, что за записью стоят ещё ─────────────────────────────
{
  const { PromptCompiler, answerRequest } = await import('./helpers/prompt-env.mjs');
  // `answerRequest` подменяет вопрос целиком (`...over`), поэтому поля хода
  // передаются явно: иначе id/текст теряются и промпт падает раньше проверки.
  const q = { id: 'row-1', turnId: 'turn-1', text: 'Расширить зону?', fullText: 'Можно ли расширить зону?', options: ['A', 'B'], fallback: 'A', role: 'Executor Core' };
  const one = PromptCompiler.compile(answerRequest({ question: { ...q, pending: 1 } })).text;
  const many = PromptCompiler.compile(answerRequest({ question: { ...q, pending: 3 } })).text;
  assert.doesNotMatch(one, /В очереди приёмки ещё/, 'одна запись — лишней строки нет');
  assert.match(many, /В очереди приёмки ещё 2/, 'приёмка знает, сколько записей ждут за этой');
  assert.match(many, /Статус «Ждёт»/, 'и где смотреть полный список');
}

console.log('OK: обратная связь из рук агента — строка без статуса и с UUID в «Миссии» доходит до приёмки; промпт называет канал и запрещает ручную запись');
