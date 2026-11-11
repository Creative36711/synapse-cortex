// ADR читается заново из модели Notion; Git blob SHA проверяется до отправки Reviewer.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../relay.user.js',import.meta.url),'utf8');
const a=source.indexOf('  async function verifiedAdrMaterial('),b=source.indexOf('  /** Ход приёмки по вопросу:',a);
assert(a>=0&&b>a);
const block=source.slice(a,b);
const text='Статус: proposed\n# Полный ADR\nОтдельные вопросы и варианты.\n';
const bytes=Buffer.from(text), sha=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const base={id:'q',url:'https://github.com/example/repo/blob/main/docs/decisions/A.md',text:'ADR',fullText:`CF_ADR_CONTENT ${sha}`};
function harness(fullText,adrBlocks,{offline=false,status='Ждёт'}={}){
  const sends=[],logs=[];
  const fn=new Function('notion','sel','Q','questionFromRowComplete','logThrottled','reviewerRole','dropAnswer','uid','log','oneLine','sendToRole','answerPrompt','missionForQuestion','roleRows','norm',
    `${block}\nreturn {startAnswer,verifiedAdrMaterial};`)(
    async()=>{if(offline)throw Error('offline');return {properties:{'Статус':{select:{name:status}}}}},
    p=>p?.select?.name||'',{wait:'Ждёт'},async()=>({fullText,adrBlocks,url:base.url}),(...x)=>logs.push(x),
    async()=>({id:'w',name:'Warden'}),()=>{},()=> 'turn',()=>{},x=>x,
    async(_r,prompt,kind,ref)=>sends.push({prompt,kind,ref}),(_m,_r,item)=>item.fullText,
    async(_item,candidate)=>candidate||null,async()=>[],
    x=>String(x||'').replace(/-/g,'').toLowerCase());
  return {...fn,sends,logs};
}
{
  const full=`CF_ADR_CONTENT ${sha}\nКонтекст\n${text}`;
  const h=harness(full,[`CF_ADR_CONTENT ${sha}`,text]);
  assert.equal(await h.startAnswer({id:'mission'},base),true);
  assert.equal(h.sends.length,1);assert.equal(h.sends[0].prompt,full,'передаётся перечитанный полный материал');
}
{
  const wrapper=`CF_ADR_CONTENT ${sha}\nПОЛНЫЙ НЕИЗМЕНЁННЫЙ ТЕКСТ ФАЙЛА:\n${text}\nКОНЕЦ ТЕКСТА CF_ADR_CONTENT_END ${sha}`;
  const h=harness(wrapper,[wrapper]);assert.equal(await h.startAnswer({id:'mission'},base),true);
}
for(const [label,full,blocks] of [
  ['один маркер',`CF_ADR_CONTENT ${sha}`,[`CF_ADR_CONTENT ${sha}`]],
  ['изменённый исходник',`CF_ADR_CONTENT ${sha}\n${text}`,[text.replace('варианты','иная информация')]],
  ['чужой SHA',`CF_ADR_CONTENT ${'a'.repeat(40)}\n${text}`,[text]],
  ['нет завершающего перевода',`CF_ADR_CONTENT ${sha}\n${text}`,[text.trimEnd()]],
]){
  const h=harness(full,blocks);assert.equal(await h.startAnswer({id:'mission'},base),false,label);assert.equal(h.sends.length,0,label);
}
{
  const h=harness('',[],{offline:true});assert.equal(await h.startAnswer({id:'mission'},base),false);assert.equal(h.sends.length,0);
}
console.log('OK: ADR page reread and exact Git blob verification; tampering and unavailable Notion stop handoff');
