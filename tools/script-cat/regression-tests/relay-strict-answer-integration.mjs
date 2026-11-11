// Выполняет настоящий answerStep с локальным Notion/GM и UUID, без внешних записей.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src=readFileSync(new URL('../relay.user.js',import.meta.url),'utf8');
const cut=(a,b)=>{const i=src.indexOf(a),j=src.indexOf(b,i+a.length);assert(i>=0&&j>i,a);return src.slice(i,j)};
const uuid=cut('  const isUuid = ','  /**');
const retain=cut('  function retainRejectedResult(', '  /**\n   * `rich_text`');
const step=cut('  async function answerStep(', '  /** Проверка постановки');
const QID='11111111-1111-4111-8111-111111111111', TURN='22222222-2222-4222-8222-222222222222';
const OTHER='33333333-3333-4333-8333-333333333333', ROLE='44444444-4444-4444-8444-444444444444';
const expected={kind:'answer',ref:QID,turnId:TURN,roleId:ROLE,watermark:'before'};
const role={id:ROLE,name:'Warden'}, K={expect:'expect'}, Q={wait:'Ждёт',done:'Решено'};
const run=(overrides={},settings={})=>{
  const store=new Map([['expect',structuredClone(expected)]]), writes=[], pauses=[];
  let row={properties:{'Статус':{select:{name:'Ждёт'}},'Ответ':{rich_text:[]}}};
  const marker={question_id:QID,turn_id:TURN,verdict:'answer',answer:'Ответ по существу.',...overrides};
  const replies=[{raw:`CF_ANSWER_RESULT ${JSON.stringify(marker)}`}];
  const get=(k,d)=>store.has(k)?store.get(k):d, set=(k,v)=>store.set(k,structuredClone(v));
  const env={K,Q,get,set, norm:x=>String(x||'').replace(/-/g,'').toLowerCase(),nowIso:()=> '2026-11-02T00:00:00Z',
    messagesAfter:()=>replies,parseMarker:(s)=>JSON.parse(s.slice(s.indexOf('{'))),markerMissing:async()=>false,
    pause:(text,ctx)=>pauses.push({text,...ctx}),firstLine:x=>x,dropAnswer:()=>{},
    withQuestionWriteLock:async(f)=>f(),notion:async()=>{
      if(settings.race){store.set('expect',{...expected,ref:OTHER});throw Error('network error after new turn')}
      return structuredClone(row);
    },patch:async(id,props)=>{writes.push({id,props});Object.assign(row.properties,props)},
    richText:s=>[{text:{content:s}}],logThrottled:()=>{},log:()=>{},
    recordQuestionChange:()=>{},openQuestions:()=>({at:0,rows:[]}),paintQuestions:()=>{},dbg:()=>{},
    deferredResultFor:()=>({found:false,decision:null,error:''}),
    answerQueue:()=>[],answerPending:()=>null,
    oneLine:x=>x,activeMission:async()=>null,roles:async()=>[],queueOf:async()=>({}),requestPlan:async()=>{},
  };
  const keys=Object.keys(env),values=Object.values(env);
  const invoke=new Function(...keys,`const GM_getValue=get,GM_setValue=set;${uuid}\n${retain}\n${step}\nreturn answerStep;`)(...values);
  return {store,writes,pauses,replies,invoke,row:()=>row};
};
for(const [label,override] of [
  ['отсутствует question_id',{question_id:''}],['чужой question_id',{question_id:OTHER}],
  ['неполный question_id',{question_id:'11111111-1111'}],['отсутствует turn_id',{turn_id:''}],
  ['старый turn_id',{turn_id:OTHER}],
]){
  const h=run(override);await h.invoke(role,expected);
  assert.equal(h.writes.length,0,label);assert.deepEqual(h.store.get('expect'),expected,label);
  assert.equal(h.pauses[0].kind,'marker-mismatch',label);
  assert.equal(h.store.get('cfn-rejected-results-v1')[0].raw,h.replies[0].raw,`${label}: оригинал сохранён`);
}
{
  const h=run();h.store.set('expect',{...expected,turnId:OTHER});await h.invoke(role,expected);
  assert.equal(h.writes.length,0);assert.equal(h.store.get('expect').turnId,OTHER,'не перезаписываем новое ожидание');
}
{
  const h=run();await h.invoke({...role,id:OTHER},expected);assert.equal(h.writes.length,0);assert.deepEqual(h.store.get('expect'),expected);
}
{
  const h=run();await h.invoke(role,expected);assert.equal(h.writes.length,1);assert.equal(h.writes[0].id,QID);
  assert.equal(h.row().properties['Статус'].select.name,'Решено');assert.equal(h.store.get('expect'),null);
}
{
  const h=run({}, {race:true});await h.invoke(role,expected);
  assert.equal(h.writes.length,0);assert.equal(h.store.get('expect').ref,OTHER,'ошибка сети не восстанавливает старый ход поверх нового');
}
{
  const h=run({turn_id:OTHER});h.store.set('cfn-rejected-results-v1',Array.from({length:100},(_,i)=>({i})));
  await h.invoke(role,expected);assert.equal(h.store.get('cfn-rejected-results-v1').length,100);
  assert.match(h.pauses[0].text,/сохраните ответ из чата вручную/,'при переполнении нет ложного обещания сохранения');
}
console.log('OK: question/turn identity, local preservation, races and capacity');
