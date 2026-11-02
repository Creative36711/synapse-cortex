import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const prefix = process.env.RELAY_BROWSER_PREFIX;
if (!prefix) throw new Error('Set RELAY_BROWSER_PREFIX to a directory containing playwright-core and @sparticuz/chromium.');
const { chromium } = await import(pathToFileURL(join(prefix, 'node_modules/playwright-core/index.mjs')).href);
const { default: chromiumBin } = await import(pathToFileURL(join(prefix, 'node_modules/@sparticuz/chromium/build/index.js')).href);
const script = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
const id = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ids = { roles: id(11), missions: id(12), requests: id(13), questions: id(14) };
const databaseIds = { roles: id(51), missions: id(52), requests: id(53), questions: id(54) };
const databaseSources = Object.fromEntries(Object.keys(ids).map((key) => [databaseIds[key], ids[key]]));
const schemas = {
  roles: { 'Роль':'title', 'Функция':'select', 'Статус':'select', 'Agent URL':'url', 'Зона записи':'rich_text', 'Гейт':'rich_text' },
  missions: { 'Миссия':'title','Состояние':'select','Создана':'date','Завершена':'date','Возвращена':'date','Круг':'number','Замечания':'rich_text','Итог':'rich_text','ТЗ URL':'url' },
  requests: { 'Запрос':'title','Миссия':'rich_text','Mission ID':'rich_text','Dependency':'rich_text','Кому':'select','Sequence':'number','Dispatch State':'select','Run ID':'rich_text','Recipient Agent ID':'rich_text','Started At':'date','Submitted At':'date','PR':'url','Check':'select','Output Drive File ID':'rich_text','Payload Drive File ID':'rich_text','Намерение':'rich_text','Инварианты':'rich_text','Acceptance':'rich_text','Свободно':'rich_text','Scope':'rich_text','Ответ':'rich_text','Branch':'rich_text','Report SHA':'rich_text' },
  questions: { 'Вопрос':'title','Статус':'select','По умолчанию':'rich_text','Ответ':'rich_text','Варианты':'rich_text','Срок':'date','Доставлено':'date','Материал':'url','Роль':'rich_text','Карточка':'rich_text','Миссия':'rich_text','Что блокирует':'rich_text' },
};
const options = { roles: { 'Функция':['Coordinator','Executor','Auditor','Reviewer'],'Статус':['Активна'] }, missions: { 'Состояние':['Активна','Возвращена','Завершена','Провалена'] }, requests:{ 'Dispatch State':['Draft','Ready','Running','Submitted','Accepted','Rework','Blocked'],'Check':['pass','fail'],'Кому':['Builder'] }, questions:{ 'Статус':['Ждёт','Решено','Принят дефолт','Отменён'] } };
const sources = Object.fromEntries(Object.entries(schemas).map(([k, fields]) => [ids[k], { object:'data_source', properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { type, ...(type === 'select' ? {select: {options:(options[k]?.[name] || []).map(name => ({name}))}} : {}) }])) }]));
const role = (name, fn, agent) => ({ id:id(agent), properties:{ 'Роль':{title:[{plain_text:name}]}, 'Функция':{select:{name:fn}}, 'Статус':{select:{name:'Активна'}}, 'Agent URL':{url:`https://arena.ai/agent/agent-${agent}`} } });
const roles = [role('Coordinator','Coordinator',31),role('Warden','Reviewer',32),role('Builder','Executor',33)];
const browser = await chromium.launch({ executablePath: await chromiumBin.executablePath(), args: chromiumBin.args, headless:true });
const ctx = await browser.newContext({ viewport:{width:1000,height:900} });
let external = [];
await ctx.route('**/*', route => { const url = route.request().url(); if (url.startsWith('https://arena.ai/')) return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Mock</title><main>Offline Arena mock</main>'}); external.push(url); return route.abort(); });
await ctx.addInitScript(({script, sources, ids, roles, databaseSources}) => {
  if (!localStorage.getItem('gm:cfn-state-v')) localStorage.setItem('gm:cfn-state-v', JSON.stringify(999));
  const get = (key, fallback) => { const s = localStorage.getItem('gm:'+key); return s === null ? fallback : JSON.parse(s); };
  const set = (key, value) => localStorage.setItem('gm:'+key, JSON.stringify(value));
  window.GM_getValue = get; window.GM_setValue = set;
  window.GM_xmlhttpRequest = (req) => {
    const history = JSON.parse(sessionStorage.getItem('mock-calls') || '[]');
    history.push({ method:req.method, url:req.url, data:req.data }); sessionStorage.setItem('mock-calls', JSON.stringify(history));
    let result = {}, path = req.url;
    const ds = path.match(/\/data_sources\/([^/?]+)/)?.[1];
    if (path.includes('/users/me')) result = {object:'user'};
    else if (path.includes('/data_sources/') && path.includes('/query')) result = { results: ds === ids.roles ? roles : [], has_more:false };
    else if (ds) result = sources[ds] || { object:'data_source' };
    else if (path.includes('/databases/')) {
      const dbId = path.split('/').at(-1);
      result = {data_sources: sessionStorage.getItem('mock-multiple') === '1'
        ? [{id:databaseSources[dbId]},{id:ids.roles}] : [{id:databaseSources[dbId]}]};
    }
    else if (path.includes('/branches/')) result = {name:'release/next'};
    else if (path.includes('/contents/')) result = [];
    else if (path.includes('api.github.com/repos/')) result = {full_name:'team/synapse'};
    else if (path.includes('script.google.com')) {
      const data = JSON.parse(req.data || '{}');
      const registry = get('cfn-project-profiles-v1', []);
      const p = registry.find(x => x.id === data.projectId);
      result = p ? {ok:true,version:'1.6',projectScoped:true,projectId:p.id,project:{name:p.driveFolder}} : {ok:true,version:'1.5'};
    }
    setTimeout(() => req.onload({status:200,responseText:JSON.stringify(result)}), 0);
  };
  window.setInterval = () => 0;
  window.addEventListener('load', () => { (0, eval)(script); }, { once:true });
}, {script,sources,ids,roles,databaseSources});
const page = await ctx.newPage(); const errors=[]; page.on('pageerror', e=> errors.push(e.message)); page.on('dialog', d=>d.accept());
await page.goto('https://arena.ai/agent/example'); await page.locator('#cfn-setup').waitFor();
await page.locator('#cfn-setup').click(); await page.locator('#cfn-connection-projects').click();
await page.locator('#cfn-project-new').click(); await page.locator('#cfn-project-save').click();
assert.match(await page.locator('#cfn-project-note').innerText(), /Проверьте четыре/);
await page.locator('#cfn-project-lookup-notion').fill('lookup-secret'); await page.locator('#cfn-project-resolve').click();
assert.equal(await page.locator('#cfn-project-lookup-notion').inputValue(), '', 'некорректные ссылки не удерживают токен');
assert(!(await page.evaluate(() => JSON.parse(sessionStorage.getItem('mock-calls') || '[]'))).some((call) => call.url.includes('/v1/databases/')), 'неверные ссылки не вызывают запросов');
for (const [key,value] of Object.entries(databaseIds)) await page.locator(`#cfn-project-${key}`).fill(`https://www.notion.so/Database-${value.replace(/-/g,'')}?v=${id(99)}`);
for (const [key,value] of Object.entries({name:'Synapse',pageUrl:'https://app.notion.com/p/example',questionsUrl:'https://app.notion.com/p/feedback',repo:'team/synapse',branch:'release/next',driveFolder:'synapse'})) await page.locator(`#cfn-project-${key}`).fill(value);
await page.evaluate(() => sessionStorage.setItem('mock-multiple','1'));
await page.locator('#cfn-project-lookup-notion').fill('lookup-secret'); await page.locator('#cfn-project-resolve').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('не ровно один'),null,{timeout:20000});
assert.equal(await page.locator('#cfn-project-lookup-notion').inputValue(), '');
assert.match(await page.locator('#cfn-project-roles').inputValue(), /https:/, 'неоднозначные источники не подставляются');
await page.evaluate(() => sessionStorage.removeItem('mock-multiple'));
await page.locator('#cfn-project-lookup-notion').fill('lookup-secret'); await page.locator('#cfn-project-resolve').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('ID четырёх источников найдены'),null,{timeout:20000});
for (const [key,value] of Object.entries(ids)) assert.equal(await page.locator(`#cfn-project-${key}`).inputValue(), value);
assert.equal(await page.locator('#cfn-project-lookup-notion').inputValue(), '');
assert.equal(await page.evaluate(() => localStorage.getItem('gm:cfn-notion-token')), null, 'токен поиска не сохраняется в legacy');
await page.locator('#cfn-project-save').click();
const registry = await page.evaluate(() => JSON.parse(localStorage.getItem('gm:cfn-project-profiles-v1')));
assert.equal(registry.length,1); const project = registry[0]; assert.equal(project.branch,'release/next');
assert.equal(await page.locator('#cfn-project-list').inputValue(), project.id);
// Смоделирован оставшийся после прежней навигации отложенный автоматический шаг.
await page.evaluate((id) => localStorage.setItem(`gm:project:${id}:cfn-step-request`, JSON.stringify(true)), project.id);
await page.locator('#cfn-project-switch').click();
await page.waitForFunction((id) => sessionStorage.getItem('cfn-active-project-v1') === id, project.id);
await page.locator('#cfn-setup').waitFor();
await page.waitForFunction(() => document.querySelector('#cfn-panel-project')?.textContent === 'Synapse');
assert.equal(await page.evaluate((id) => sessionStorage.getItem('cfn-project-switch-hold:'+id),project.id),'1');
await page.locator('#cfn-step').click();
await page.waitForTimeout(100);
assert.match(await page.locator('#cfn-log').innerText(), /не разрешён/);
assert.equal(await page.evaluate((id) => sessionStorage.getItem('cfn-project-switch-hold:'+id),project.id),'1', 'попытка шага до допуска не снимает hold');
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-step-request`)),project.id),true, 'автоматический шаг ещё ожидает ручного запуска');
// До первого допуска можно исправить опечатку, не теряя UUID и секреты.
// Второй профиль даёт реальное предупреждение о совпавшем репозитории для проверки гонки.
const other = {...project, id:id(60), name:'Other', roles:id(61), missions:id(62), requests:id(63), questions:id(64), repo:'example/relay-fixture', driveFolder:'other'};
await page.evaluate((p) => {
  const profiles=JSON.parse(localStorage.getItem('gm:cfn-project-profiles-v1'));
  localStorage.setItem('gm:cfn-project-profiles-v1', JSON.stringify([...profiles,p]));
}, other);
await page.locator('#cfn-setup').click(); await page.locator('#cfn-connection-projects').click();
await page.locator('#cfn-project-edit').click(); await page.locator('#cfn-project-name').fill('Synapse corrected');
// Редактирование не должно обойти допуск из другой вкладки во время confirm.
await page.locator('#cfn-project-repo').fill('example/relay-fixture');
await page.evaluate((id) => { window.confirm = () => { localStorage.setItem(`gm:project:${id}:cfn-project-ever-approved`, JSON.stringify(true)); return true; }; }, project.id);
await page.locator('#cfn-project-save').click();
assert.match(await page.locator('#cfn-project-note').innerText(), /допуск изменился/);
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gm:cfn-project-profiles-v1'))[0].name), 'Synapse');
await page.evaluate((id) => { localStorage.setItem(`gm:project:${id}:cfn-project-ever-approved`, JSON.stringify(false)); window.confirm = () => true; }, project.id);
await page.locator('#cfn-project-repo').fill('team/synapse');
await page.locator('#cfn-project-save').click();
await page.waitForFunction(() => document.querySelector('#cfn-panel-project')?.textContent === 'Synapse corrected');
assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('gm:cfn-project-profiles-v1'))[0].id), project.id);
assert.equal(await page.evaluate((id) => sessionStorage.getItem('cfn-project-switch-hold:'+id),project.id),'1');
await page.locator('#cfn-setup').click();
assert.equal(await page.locator('#cfn-connection-notion').inputValue(),'');
await page.locator('#cfn-connection-notion').fill('n-token');
await page.locator('#cfn-connection-url').fill('https://script.google.com/macros/s/mock/exec');
await page.locator('#cfn-connection-key').fill('p-key');
await page.locator('#cfn-connection-github').fill('g-token');
await page.locator('#cfn-connections-save').click();
assert.match(await page.locator('#cfn-connections-note').innerText(), /Сохранено/);
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-notion-token`)),project.id),'n-token');
assert.equal(await page.evaluate(() => localStorage.getItem('gm:cfn-notion-token')), null, 'старые секреты не затронуты');
await page.locator('#cfn-connection-projects').click();
// Другой таб меняет доступ в момент подтверждения: выданный по старым данным
// допуск не сохраняется. После новой проверки — обычное подтверждение.
await page.evaluate((id) => {
  window.confirm = (text) => {
    if (text.includes('Источники, основные поля')) localStorage.setItem(`gm:project:${id}:cfn-github-token`, JSON.stringify('token-changed-during-confirm'));
    return true;
  };
}, project.id);
await page.locator('#cfn-project-enable').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('изменились во время подтверждения'),null,{timeout:20000});
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-project-approved`)),project.id),false);
// Изменение самого профиля во время подтверждения также запрещает допуск.
const checkedRegistry = await page.evaluate(() => localStorage.getItem('gm:cfn-project-profiles-v1'));
await page.evaluate(() => { window.confirm = (text) => {
  if (text.includes('Источники, основные поля')) {
    const profiles = JSON.parse(localStorage.getItem('gm:cfn-project-profiles-v1'));
    profiles[0].branch = 'changed-in-another-tab';
    localStorage.setItem('gm:cfn-project-profiles-v1', JSON.stringify(profiles));
  }
  return true;
}; });
await page.locator('#cfn-project-enable').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('Профиль изменён во время подтверждения'),null,{timeout:20000});
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-project-approved`)),project.id),false);
await page.evaluate((registry) => { localStorage.setItem('gm:cfn-project-profiles-v1', registry); window.confirm = () => true; }, checkedRegistry);
await page.locator('#cfn-project-enable').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('Работа проекта разрешена'),null,{timeout:20000});
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-project-approved`)),project.id),true);
assert.equal(await page.evaluate((id) => sessionStorage.getItem(`project:${id}:cfn-auto-enabled`),project.id),null,'включение не запускает цикл');
assert.equal(await page.evaluate((id) => sessionStorage.getItem('cfn-project-switch-hold:'+id),project.id),'1');
assert.equal(await page.locator('#cfn-project-edit').isVisible(),false,'после допуска изменять источники в старом состоянии нельзя');
await page.waitForTimeout(150);
const callsBeforeManual = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mock-calls') || '[]'));
assert(!callsBeforeManual.some((call) => call.url.includes('/repos/team/synapse/contents/docs/decisions')), 'сторож ADR не работает до ручного запуска');
assert(!callsBeforeManual.some((call) => call.url.includes('/data_sources/' + '00000014-1111-4111-8111-000000000014' + '/query')), 'сторож обратной связи тоже на hold');
// Замена секрета снимает допуск; его можно вернуть только повторной проверкой.
await page.locator('#cfn-project-close').click(); await page.locator('#cfn-setup').click();
await page.locator('#cfn-connection-github').fill('new-g-token'); await page.locator('#cfn-connections-save').click();
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-project-approved`)),project.id),false);
assert.match(await page.locator('#cfn-connections-note').innerText(), /Допуск проекта снят/);
await page.locator('#cfn-connection-projects').click(); await page.locator('#cfn-project-enable').click();
await page.waitForFunction(() => document.querySelector('#cfn-project-note')?.textContent.includes('Работа проекта разрешена'),null,{timeout:20000});
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-project-approved`)),project.id),true);
await page.locator('#cfn-project-close').click();
await page.locator('#cfn-step').click();
await page.waitForFunction((id) => sessionStorage.getItem('cfn-project-switch-hold:'+id) === null, project.id);
assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem(`gm:project:${id}:cfn-step-request`)),project.id),false, 'старый отложенный шаг погашен именно ручным действием');
await page.waitForTimeout(300);
await page.locator('#cfn-setup').click(); await page.locator('#cfn-connection-projects').click();
await page.evaluate((id) => sessionStorage.setItem(`project:${id}:cfn-auto-enabled`,'1'),project.id);
await page.locator('#cfn-project-list').selectOption('unconfigured');
await page.locator('#cfn-project-switch').click();
assert.match(await page.locator('#cfn-project-note').innerText(), /Остановите автоцикл/);
await page.locator('#cfn-project-close').click(); await page.locator('#cfn-setup').click();
await page.locator('#cfn-connection-stop-auto').click(); await page.locator('#cfn-connection-projects').click();
await page.locator('#cfn-project-list').selectOption('unconfigured'); await page.locator('#cfn-project-switch').click();
await page.waitForFunction(() => sessionStorage.getItem('cfn-active-project-v1') === 'unconfigured');
await page.waitForFunction(() => document.querySelector('#cfn-panel-project')?.textContent === 'Проект не настроен');
assert.equal(await page.evaluate(() => sessionStorage.getItem('cfn-project-switch-hold:unconfigured')),'1');
assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
console.log('OK: Chromium — создание профиля, проверка схемы и ролей, отдельные секреты, switch/hold, запрет переключения на авто; сеть не использована');
await browser.close();
