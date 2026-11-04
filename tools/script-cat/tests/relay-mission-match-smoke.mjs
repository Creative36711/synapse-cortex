// Реальные функции привязки, глобальной проверки, миграционного предпросмотра
// и preflight на поддельных Notion-страницах. Никаких сетевых записей.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../relay.user.js', import.meta.url), 'utf8');
// Декларативный промпт Координатора сохраняет предупреждение о дубликатах.
const { PromptCompiler, planRequest } = await import('./helpers/prompt-env.mjs');
const coordText = PromptCompiler.compile(planRequest()).text;
assert.match(coordText, /Дубль номера правь, не создавай/, 'Координатор предупреждён о дубликатах');
assert.match(src, /cardMissionId/, 'привязка очереди по UUID на месте');
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert(i >= 0 && j > i, a); return src.slice(i, j); };
const uuid = cut('  const isUuid = ', '  /**');
const binding = cut('  const cardMissionId = ', '  // ───────────────────────────── сообщения чата');
const active = cut('  async function activeMission()', '  const missionKind');
const migration = cut('  async function inspectMissionMigration()', '  function formatMissionMigration(');
const preflight = cut('  async function taskPreflight(', '  async function dispatchTask(');
const M1 = '11111111-1111-4111-8111-111111111111', M2 = '22222222-2222-4222-8222-222222222222';
const ID1 = '33333333-3333-4333-8333-333333333333', ID2 = '44444444-4444-4444-8444-444444444444';
const rich = (s) => ({ type:'rich_text', rich_text: s ? [{ plain_text:s }] : [] });
const title = (s) => ({ title: [{ plain_text:s }] });
const mission = (id, name, state='Активна') => ({ id, properties:{ 'Миссия': title(name), 'Состояние':{ select:{name:state} } } });
const card = (id, mid, label='Альфа', status='Ready') => ({ id, properties:{
  'Запрос': title('Карточка'), 'Миссия': rich(label), 'Mission ID':rich(mid),
  'Dependency': rich(''), 'Намерение':rich('результат'), 'Инварианты':rich('рамки'),
  'Acceptance':rich('проверить результат'), 'Scope':rich('код'), 'Sequence':{number:1},
  'Dispatch State':{select:{name:status}}, 'Check':{select:{name:'pass'}},
} });
let missions=[mission(M1,'Альфа'), mission(M2,'Бета','Завершена')], cards=[card(ID1,M1)];
const C={ missions:'missions', requests:'requests' },
  rt=(p)=>(p?.rich_text||p?.title||[]).map(x=>x.plain_text||x.text?.content||'').join(''),
  sel=(p)=>p?.select?.name||'', norm=(x)=>String(x||'').replace(/-/g,'').toLowerCase(),
  taskTitle=(p)=>rt(p.properties['Запрос']), taskState=(p)=>sel(p.properties['Dispatch State']);
const query=async (db, filter)=>db==='missions' ? (filter ? missions.filter(m=>['Активна','Возвращена'].includes(sel(m.properties['Состояние']))) : missions) : filter ? cards.filter(x=>taskState(x)===filter.select.equals) : cards;
const notion=async (_method,path)=>{const row=cards.find(c=>c.id===path.slice(6));if(!row)throw Error('not found');return structuredClone(row)};
const api=new Function('C','rt','sel','norm','taskTitle','taskState','query','notion','log',
  `${uuid}\n${binding}\n${active}\n${migration}\n${preflight}\nreturn {cardInMission,cardBindingIssue,assertMissionBindings,tasks,activeMission,inspectMissionMigration,taskPreflight};`)
  (C,rt,sel,norm,taskTitle,taskState,query,notion,()=>{});
assert.equal(api.cardInMission(cards[0], missions[0]), true);
assert.equal(api.cardInMission(card(ID1,''), missions[0]), false, 'пустой ID не относится ко всем миссиям');
assert.equal(api.cardInMission(card(ID1,M2,'Альфа'), missions[0]), false, 'имя не подменяет ID');
assert.match(api.cardBindingIssue(card(ID1,M2,'Альфа'), missions), /разные миссии/);
assert.equal((await api.tasks('Ready',missions[0])).length, 1);
await api.assertMissionBindings(missions[0]);
for (const bad of [card(ID2,''), card(ID2,'55555555-5555-4555-8555-555555555555'), card(ID2,M2,'Альфа'), card(ID2,M1,'Альфа','Неизвестно')]) {
  cards=[card(ID1,M1),bad];
  await assert.rejects(api.assertMissionBindings(missions[0]), /карточек с пустым\/неизвестным/);
}
cards=[card(ID1,''),card(ID2,M2,'Бета','Accepted')];
await assert.rejects(api.tasks('Ready',missions[0]), /без корректного Mission ID/);
let plan=await api.inspectMissionMigration();
assert.equal(plan.mapped.length,1);assert.equal(plan.mapped[0].id,M1);assert.equal(plan.existing.length,1);assert.equal(plan.conflicts.length,0);
assert.equal(rt(cards[0].properties['Mission ID']),'', 'предпросмотр не пишет');
missions.push(mission('55555555-5555-4555-8555-555555555555','Альфа','Завершена'));
plan=await api.inspectMissionMigration();assert.match(plan.conflicts[0].why,/несколько миссий/);
missions.pop();cards=[card(ID1,'','похожее, но неточное')];
plan=await api.inspectMissionMigration();assert.match(plan.conflicts[0].why,/нет точного совпадения/);
cards=[card(ID1,M1,'Альфа','Running')];plan=await api.inspectMissionMigration();assert(plan.conflicts.some(x=>/Running/.test(x.why)));
missions[1].properties['Состояние'].select.name='Возвращена';
await assert.rejects(api.activeMission(),/несколько активных/);
plan=await api.inspectMissionMigration();assert(plan.conflicts.some(x=>/активных/.test(x.why)));
missions=[mission(M1,'Альфа')];cards=[card(ID1,M1)];
assert.equal(await api.taskPreflight(cards[0],missions[0]),'');
for (const field of ['Намерение','Инварианты','Acceptance','Scope']) {
  const c=structuredClone(cards[0]);c.properties[field]=rich('');assert.match(await api.taskPreflight(c,missions[0]),new RegExp(field));
}
const badSequence=structuredClone(cards[0]);badSequence.properties.Sequence={number:null};assert.match(await api.taskPreflight(badSequence,missions[0]),/Sequence/);
const missingField=structuredClone(cards[0]);delete missingField.properties.Dependency;assert.match(await api.taskPreflight(missingField,missions[0]),/схеме/);
const dep=card(ID2,M1,'Альфа','Accepted');cards.push(dep);cards[0].properties.Dependency=rich(ID2);
assert.equal(await api.taskPreflight(cards[0],missions[0]),'');
dep.properties.Check.select.name='fail';assert.match(await api.taskPreflight(cards[0],missions[0]),/Check = fail/);
dep.properties.Check.select.name='pass';dep.properties['Dispatch State'].select.name='Ready';assert.match(await api.taskPreflight(cards[0],missions[0]),/не Accepted/);
dep.properties['Dispatch State'].select.name='Accepted';dep.properties['Mission ID']=rich(M2);assert.match(await api.taskPreflight(cards[0],missions[0]),/другой миссии/);
cards[0].properties.Dependency=rich(ID1);assert.match(await api.taskPreflight(cards[0],missions[0]),/саму карточку/);
cards[0].properties.Dependency=rich('название карточки');assert.match(await api.taskPreflight(cards[0],missions[0]),/UUID/);
console.log('OK: UUID mission binding, global guard, migration preview and dependency preflight');
