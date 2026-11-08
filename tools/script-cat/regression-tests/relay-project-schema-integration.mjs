// Проверка схемы и ролей профиля без сети: success и отдельные ошибки до запуска.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const start = src.indexOf('  async function validateProjectSchema(settings) {');
const end = src.indexOf('  function projectsDialog() {', start);
assert(start > 0 && end > start);
const validator = src.slice(start, end);
// Независимая минимальная фикстура: вручную сверена со схемой Notion и
// фактическими чтениями/записями ScriptCat; НЕ генерируется из валидатора.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/notion-schema-minimal.json', import.meta.url), 'utf8'));
const C = { roles:'roles', missions:'missions', requests:'requests', questions:'questions', repo:'team/repo', branch:'release/next', notionV:'2025-09-03' };
const schemas = Object.fromEntries(Object.entries(fixture).map(([id, {fields, options}]) => [id, {
  object:'data_source', properties:Object.fromEntries(Object.entries(fields).map(([name,type]) => [name, {
    type, ...(type === 'select' ? {select:{options:(options[name] || []).map((name) => ({name}))}} : {}),
  }]))
}]));
const allRoles = [
  {name:'Coordinator',fn:'Coordinator',status:'Активна',id:'coord',url:'https://arena.ai/agent/coord'},
  {name:'Warden',fn:'Reviewer',status:'Активна',id:'warden',url:'https://arena.ai/agent/warden'},
  {name:'Builder',fn:'Executor',status:'Активна',id:'builder',url:'https://arena.ai/agent/builder'},
];
let currentSchemas = structuredClone(schemas), currentRoles = structuredClone(allRoles), branch = C.branch, calls = [], pagination = '';
const request = async (method, url, _headers, body) => {
  calls.push({method,url,body});
  if (url.includes('/branches/')) return {name:branch};
  if (url.includes('/query')) {
    if (pagination === 'good') return body?.start_cursor
      ? {results:currentRoles.slice(2), has_more:false}
      : {results:currentRoles.slice(0,2), has_more:true, next_cursor:'page-2'};
    if (pagination === 'repeated') return {results:[], has_more:true, next_cursor:'same'};
    return {results:currentRoles, has_more:false};
  }
  const id = url.split('/').at(-1); return structuredClone(currentSchemas[id]);
};
// D-075 п. 6: вариант «Функция» дописывается под существующую строку, поэтому
// валидатору нужен доступ к PATCH схемы. Проверяем это отдельным запросом в
// `request`, а не моком самой функции: смысл в том, что PATCH уходит.
const patches = [];
const requestWithPatch = async (method, url, headers, body) => {
  if (method === 'PATCH') {
    patches.push({url, body});
    const id = url.split('/').at(-1);
    const prop = currentSchemas[id].properties['Функция'];
    if (prop?.select) prop.select.options = body.properties['Функция'].select.options.map((o) => ({name:o.name}));
    return {};
  }
  return request(method, url, headers, body);
};
const run = new Function('C','request','mapRoleRow','location','URL','githubHeaders','connectionProblem','setTimeout',
  `${validator}\nreturn validateProjectSchema;`)(C,requestWithPatch,(row)=>row,{origin:'https://arena.ai'},URL,()=>({}),
  (e)=>String(e.message || e), (fn)=>fn());
const settings = {notion:'secret',github:'secret'};
assert.equal((await run(settings)).ok,true);
assert(calls.every((c) => c.method === 'GET' || c.url.endsWith('/query')), 'только чтение и запрос базы');
// Удаление ЛЮБОГО из независимо перечисленных полей или обязательных
// вариантов должно блокировать допуск, иначе контракт ослаблен незаметно.
for (const [id, {fields, options}] of Object.entries(fixture)) {
  for (const field of Object.keys(fields)) {
    currentSchemas = structuredClone(schemas); delete currentSchemas[id].properties[field];
    assert.equal((await run(settings)).ok, false, `пропущено обязательное поле ${id}.${field}`);
  }
  for (const [field, names] of Object.entries(options)) for (const option of names) {
    // D-075 п. 6: вариант «Функция» больше не обязателен сам по себе — он
    // дописывается под существующую строку. Поэтому его отсутствие проверяется
    // отдельными случаями ниже (со строкой проходит, без строки отказывает),
    // а здесь цикл проверяет только варианты, которые обязаны быть всегда.
    if (id === 'roles' && field === 'Функция') continue;
    currentSchemas = structuredClone(schemas);
    currentSchemas[id].properties[field].select.options = currentSchemas[id].properties[field].select.options.filter((value) => value.name !== option);
    assert.equal((await run(settings)).ok, false, `пропущен обязательный вариант ${id}.${field}.${option}`);
  }
}
currentSchemas = structuredClone(schemas);
// Repository is additive for older databases; if present, it must be text.
delete currentSchemas.requests.properties.Repository;
assert.equal((await run(settings)).ok, true, 'старые Requests без Repository работают через назначение роли');
currentSchemas.requests.properties.Repository = { type: 'url' };
assert.match((await run(settings)).text, /Repository: нужен rich_text/);
currentSchemas = structuredClone(schemas);

pagination = 'good'; calls = []; assert.equal((await run(settings)).ok, true);
assert.deepEqual(calls.filter((c) => c.url.endsWith('/query')).map((c) => c.body?.start_cursor || ''), ['', 'page-2']);
pagination = 'repeated'; assert.match((await run(settings)).text, /неверный курсор/);
pagination = '';
currentSchemas.roles.properties['Agent URL'].type = 'rich_text';
assert.match((await run(settings)).text,/Agent URL: нужен url/);
currentSchemas = structuredClone(schemas);
currentSchemas.questions.properties['Статус'].select.options = [];
assert.match((await run(settings)).text,/Статус: нет/);
currentSchemas = structuredClone(schemas);
currentRoles.push({...currentRoles[0], id:'other', url:'https://arena.ai/agent/other'});
assert.match((await run(settings)).text,/ровно один активный Coordinator/);
currentRoles = structuredClone(allRoles); currentRoles[1].url = 'https://www.arena.ai/agent/warden';
assert.match((await run(settings)).text,/домене этой вкладки/);
currentRoles = structuredClone(allRoles); currentRoles[2].id = currentRoles[0].id;
assert.match((await run(settings)).text,/один Agent URL/);
currentRoles = structuredClone(allRoles); currentSchemas.requests.properties['Кому'].select.options = [];
assert.match((await run(settings)).text,/отсутствует вариант/);
currentSchemas = structuredClone(schemas); branch = 'main';
assert.match((await run(settings)).text,/не подтвердил ветку/);
console.log('OK: проверка схемы, select, ролей, домена, однозначности агентов и базовой ветки');

// ── D-075 п. 6: вариант «Функция» добавляется под строку, а не «на всякий случай»
{
  // Строка Maintainer есть, варианта в схеме нет: проверка проходит и PATCH уходит.
  currentSchemas = structuredClone(schemas);
  currentSchemas.roles.properties['Функция'].select.options =
    currentSchemas.roles.properties['Функция'].select.options.filter((o) => o.name !== 'Maintainer');
  assert.equal(currentSchemas.roles.properties['Функция'].select.options.some((o) => o.name === 'Maintainer'), false);
  currentRoles = structuredClone(allRoles).concat([
    {name:'Transport Maintainer', fn:'Maintainer', status:'Активна', id:'maint', url:'https://arena.ai/agent/maint'},
  ]);
  branch = C.branch;
  patches.length = 0;
  const withRow = await run(settings);
  assert.equal(withRow.ok, true, `база без варианта Maintainer, но со строкой проходит: ${withRow.text}`);
  assert.equal(patches.length, 1, 'ровно один PATCH схемы');
  assert.match(patches[0].url, /roles$/, 'правится база «Роли»');
  assert.deepEqual(patches[0].body.properties['Функция'].select.options.map((o) => o.name).sort(),
    ['Auditor','Coordinator','Executor','Maintainer','Reviewer'], 'существующие варианты сохранены, добавлен один');

  // Строки нет — варианта не появляется. Maintainer при этом и не требуется:
  // закулисной роли может не быть вовсе, и её вариант «на всякий случай» ломал
  // бы включение любому проекту (D-075 п. 6).
  currentSchemas = structuredClone(schemas);
  currentSchemas.roles.properties['Функция'].select.options =
    currentSchemas.roles.properties['Функция'].select.options.filter((o) => o.name !== 'Maintainer');
  currentRoles = structuredClone(allRoles);
  patches.length = 0;
  const noRow = await run(settings);
  assert.equal(noRow.ok, true, `без строки Maintainer не требуется: ${noRow.text}`);
  assert.equal(patches.length, 0, 'ни одного PATCH: вариант без строки — право из воздуха');
  assert.equal(currentSchemas.roles.properties['Функция'].select.options.some((o) => o.name === 'Maintainer'), false,
    'вариант в схеме не появился');

  // А обязательные варианты, которые несёт система, отсутствовать не могут.
  currentSchemas = structuredClone(schemas);
  currentSchemas.roles.properties['Функция'].select.options =
    currentSchemas.roles.properties['Функция'].select.options.filter((o) => o.name !== 'Reviewer');
  patches.length = 0;
  const noReviewer = await run(settings);
  assert.equal(noReviewer.ok, true, 'Reviewer дописывается по строке Warden');
  assert.equal(patches.length, 1, 'ровно один PATCH');
  assert.ok(patches[0].body.properties['Функция'].select.options.some((o) => o.name === 'Reviewer'));

  // И повторный прогон после добавления варианта PATCH больше не нужен.
  currentRoles = structuredClone(allRoles).concat([
    {name:'Transport Maintainer', fn:'Maintainer', status:'Активна', id:'maint', url:'https://arena.ai/agent/maint'},
  ]);
  patches.length = 0;
  assert.equal((await run(settings)).ok, true);
  assert.equal(patches.length, 0, 'вариант уже есть — писать нечего');
  currentRoles = structuredClone(allRoles);
  currentSchemas = structuredClone(schemas);
}
