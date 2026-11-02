// Реальные query → tasks → startReview и reviewPrompt; сеть и страницы Notion
// моделируются локально. Оракул требует все страницы или честную ошибку.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
function cut(a, b) {
  const from = src.indexOf(a);
  const to = src.indexOf(b, from + a.length);
  assert(from >= 0 && to > from, `не найден блок ${a}`);
  return src.slice(from, to);
}
const queryBlock = cut('  const query = async (', '  const patch =');
const tasksBlock = cut('  async function tasks(state, mission) {', '  // ───────────────────────────── сообщения чата');
const reviewBlock = cut('  /** Принятые карточки списком:', '  /** Закрыть миссию.');
const norm = (x) => String(x || '').replace(/-/g, '').toLowerCase();
const rt = (p) => (p?.rich_text || p?.title || []).map((x) => x.plain_text || x.text?.content || '').join('');
const taskTitle = (p) => rt(p.properties['Запрос']);
const taskRole = (p) => p.properties['Кому']?.select?.name || '';
const card = (name, mission, sequence, check = 'pass') => ({
  id: name, url: `https://notion.example/${name}`,
  properties: {
    'Запрос': { title: [{ plain_text: `${name} · проверка` }] },
    'Миссия': { rich_text: [{ plain_text: mission }] },
    'Mission ID': {rich_text:[{plain_text: mission.startsWith('STAB') ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'}]},
    'Кому': { select: { name: 'Tools' } },
    'Dispatch State': { select: { name: 'Accepted' } },
    Sequence: { number: sequence },
    'Check': { select: { name: check } },
    'Ответ': { rich_text: [{ plain_text: `ответ ${name}` }] },
    PR: { url: `https://github.example/pr/${sequence}` },
  },
});
const mission = { id: '11111111-1111-4111-8111-111111111111', properties: {
  'Миссия': { title: [{ plain_text: 'STAB-1 · Stabilization' }] },
  'ТЗ URL': { url: 'https://example.test/tz' },
  'Итог': { rich_text: [{ plain_text: 'Проверки и остатки.' }] },
} };
const rows = [
  ...Array.from({ length: 205 }, (_, i) => card(`OLD-${i}`, 'NAR-2 · предыдущая миссия', i)),
  ...Array.from({ length: 35 }, (_, i) => card(`STAB-1.${i + 1}`, 'STAB-1 · Stabilization', i + 205, i === 28 ? 'fail' : 'pass')),
];

function make({ mode = 'ok' } = {}) {
  const calls = [], pauses = [], sends = [], logs = [];
  const notion = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    assert.equal(method, 'POST');
    assert.equal(path, 'data_sources/request-db/query');
    assert.equal(body.page_size, 100);
    assert.deepEqual(body.filter, { property: 'Dispatch State', select: { equals: 'Accepted' } });
    assert.deepEqual(body.sorts, [{ property: 'Sequence', direction: 'ascending' }]);
    const start = body.start_cursor ? Number(body.start_cursor.split(':')[1]) : 0;
    if (mode === 'offline' && start >= 100) throw new Error('страница 2 недоступна');
    if (mode === 'invalid' && start >= 100) return { results: null, has_more: false };
    if (mode === 'missing-flag') return { results: [] };
    if (mode === 'missing-cursor') return { results: rows.slice(0, 100), has_more: true, next_cursor: null };
    if (mode === 'repeated-cursor') return { results: [], has_more: true, next_cursor: 'cursor:100' };
    const results = rows.slice(start, start + 100);
    const has_more = start + results.length < rows.length;
    return { results, has_more, next_cursor: has_more ? `cursor:${start + results.length}` : null };
  };
  const query = new Function('notion', `${queryBlock}\nreturn query;`)(notion);
  const tasks = new Function('query', 'C', 'rt', 'norm', 'isUuid', 'cardMissionId', 'cardInMission', 'missionSkipSeen', 'taskTitle', 'firstLine', 'log',
    `${tasksBlock}\nreturn tasks;`)(
    query, { requests: 'request-db' }, rt, norm, (id) => /^[0-9a-f-]{36}$/i.test(String(id||'')),
    (row) => rt(row.properties['Mission ID']).trim(),
    (row, m) => norm(rt(row.properties['Mission ID'])) === norm(m.id), new Set(), taskTitle,
    (s, n) => String(s).slice(0, n), (text) => logs.push(text),
  );
  const api = new Function('reviewerRole', 'missionRound', 'tasks', 'pause', 'uid', 'log', 'sendToRole',
    'rt', 'taskTitle', 'taskRole', 'technicalInfo', 'roleContext', 'C',
    `${reviewBlock}\nreturn { reviewCards, reviewPrompt, startReview };`)(
    async () => ({ id: 'w', name: 'Warden', fn: 'Reviewer' }), () => 1, tasks,
    (text, context) => pauses.push({ text, context }), () => 'turn-1', (text) => logs.push(text),
    async (role, text, kind, ref, extra) => { sends.push({ role, text, kind, ref, extra }); return true; },
    rt, taskTitle, taskRole, () => 'TECH', () => 'Ты Warden', { reworkLimit: 3 },
  );
  return { query, tasks, ...api, calls, pauses, sends, logs };
}
const queue = { summary: '0 Submitted, 0 Running, 0 Ready, 0 Rework, 0 Draft' };

// Первые 205 принятых записей относятся к другой миссии; нужные 35 находятся
// только на страницах 3 и 4. Миссионный фильтр применяется ПОСЛЕ пагинации.
{
  const h = make();
  const found = await h.tasks('Accepted', mission);
  assert.equal(found.length, 35);
  assert.equal(found[0].id, 'STAB-1.1');
  assert.equal(found.at(-1).id, 'STAB-1.35');
  assert.deepEqual(h.calls.map((c) => c.body.start_cursor || ''), ['', 'cursor:100', 'cursor:200']);
  const text = h.reviewCards(found);
  assert.equal(text.split('\n').length, 35, 'ни один принятый пункт не обрезан на двадцатом');
  assert.match(text, /STAB-1\.35/);
  assert.match(text, /STAB-1\.29.*Check=fail/, 'Accepted не маскирует Check=fail');
  assert.match(text, /https:\/\/notion\.example\/STAB-1\.35/);
}
{
  const h = make();
  await h.startReview(mission, queue);
  assert.equal(h.pauses.length, 0);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].kind, 'review');
  assert.equal(h.sends[0].ref, mission.id);
  assert.match(h.sends[0].text, /ПРИНЯТЫЕ КАРТОЧКИ \(35;/);
  assert.match(h.sends[0].text, /STAB-1\.35/);
  assert.match(h.sends[0].text, /STAB-1\.29.*Check=fail/);
  assert.match(h.sends[0].text, /Accepted — состояние карточки, не доказательство pass/);
  assert.match(h.sends[0].text, /CF_REVIEW_RESULT/);
  assert.match(h.sends[0].text, /Предел доработок: 3/);
}
for (const mode of ['offline', 'invalid', 'missing-flag', 'missing-cursor', 'repeated-cursor']) {
  const h = make({ mode });
  await assert.rejects(() => h.tasks('Accepted', mission), /недоступна|неполную|курсор/i, `${mode}: неполный список не возвращается`);
  const h2 = make({ mode });
  await h2.startReview(mission, queue);
  assert.equal(h2.sends.length, 0, `${mode}: приёмка не получает пустой или частичный список`);
  assert.equal(h2.pauses.at(-1).context.kind, 'review-cards-read');
  assert.match(h2.pauses.at(-1).text, /полностью прочитать/);
}
console.log('OK: Notion pagination → полная очередь → приёмка; сетевые ошибки и курсоры не маскируются');
