import { assert, assertEquals } from 'jsr:@std/assert';
import { createRoot } from 'solid-js';
import { api } from '../client/js/api.mjs';
import { makeAppStore } from '../client-solid/store/app-store.js';
import { clientInventory } from './helpers/client-inventory.mjs';
import { sourceFrame, sourceCollections, injectedSourceStream } from './helpers/source-stream.mjs';

const projection=(revision,sequence,ranges=sequence?[[1,sequence]]:[])=>({revision,sequence,visibleRanges:ranges,latestVisibleSeq:ranges.at(-1)?.[1]??0});
const turn=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function nativePage(){
  const document=Object.assign(new EventTarget(),{visibilityState:'visible',querySelector:()=>null}),frames=new Map(),observers=[];let next=0;
  class Observer{constructor(callback){this.callback=callback;this.targets=new Set();observers.push(this);}observe(el){this.targets.add(el);}disconnect(){this.targets.clear();}}
  const page=Object.assign(new EventTarget(),{document,innerWidth:100,innerHeight:100,ResizeObserver:Observer,IntersectionObserver:Observer,
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),requestAnimationFrame(fn){frames.set(++next,fn);return next;},cancelAnimationFrame(id){frames.delete(id);}});
  const element=()=>({ownerDocument:document,isConnected:true,getBoundingClientRect:()=>({left:0,top:0,right:80,bottom:80,width:80,height:80})});
  const flush=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
  return {page,element,flush,observers,frames};
}
async function withStore(run){
  const saved={...api},oldLocation=globalThis.location,oldHistory=globalThis.history;
  globalThis.location={pathname:'/',search:'',hash:'#h'};globalThis.history={replaceState(){},pushState(){}};
  const source={address:'mock:1',kind:'comfy',online:true,autoRefresh:false,incarnation:'A'};let epoch='E',revision=0,arrivals=projection(1,1),rows=[row('old.png',1)],dispose;
  function row(name,arrivalSeq,hash=null){return {name,arrivalSeq,hash,width:100,height:50,size:10,judgment:null,meta:null};}
  const snapshot=()=>{const f=sourceFrame({h:source},++revision,epoch);f.sources.h.arrivals=arrivals;return f;};
  const stream=injectedSourceStream(snapshot());
  api.collections=async()=>sourceCollections({h:source});
  api.inventory=async()=>clientInventory(structuredClone(rows),{coverage:'recursive',origin:{source:'h',address:source.address,kind:source.kind,epoch,incarnation:source.incarnation},arrivals});
  api.meta=async()=>({changed:false,pending:0});api.want=async()=>({pending:0});api.nodes=async()=>({});api.settings=async()=>({});api.setSettings=async()=>({});api.prefetch=async()=>({});api.runtime=async()=>({});
  const store=createRoot(cleanup=>{dispose=cleanup;return makeAppStore({subscribeSources:stream.subscribe,storage:null});});
  const publish=async(p,nextRows=rows)=>{arrivals=p;rows=nextRows;stream.snapshot(snapshot());await store.actions.ui.refresh();await turn();};
  const page=nativePage();
  try{await store.actions.boot();store.actions.lifecycle.registerPage(page.page);store.actions.feed.register({scrollEl:page.element()});await turn();
    await run({store,page,row,publish,source,stream,snapshot,setRows:value=>{rows=value;},setProjection:value=>{arrivals=value;},setEpoch:value=>{epoch=value;}});
  }finally{store.dispose();dispose();Object.assign(api,saved);if(oldLocation===undefined)delete globalThis.location;else globalThis.location=oldLocation;if(oldHistory===undefined)delete globalThis.history;else globalThis.history=oldHistory;}
}
const register=(store,page,id)=>store.actions.feed.expose('h:'+id,{element:page.element(),clip:page.element(),resource:'/bytes/'+id,valid:()=>true,ready:()=>true});

Deno.test('unseen Store: exact exposure survives first-hash enrichment, rejects changed content and retired native tickets',()=>withStore(async({store,page,row,publish})=>{
  await publish(projection(2,3),[row('old.png',1),row('one.png',2),row('two.png',3,'a'.repeat(64))]);
  const first=register(store,page,'one.png'),old=register(store,page,'two.png');
  await publish(projection(2,3),[row('old.png',1),row('one.png',2,'c'.repeat(64)),row('two.png',3,'b'.repeat(64))]);
  page.flush();assert(!store.state.entryHasNew('h:one.png'),'first hash does not retire same content');assert(store.state.entryHasNew('h:two.png'),'old native ticket cannot acknowledge changed known content');
  old();first();const retired=register(store,page,'two.png');retired();page.flush();assert(store.state.entryHasNew('h:two.png'));
  const current=register(store,page,'two.png');page.flush();assert(!store.state.anySourceHasNew());current();
  await publish(projection(3,3,[[1,2]]),[row('old.png',1),row('one.png',2,'c'.repeat(64))]);
  await publish(projection(4,3),[row('old.png',1),row('one.png',2,'c'.repeat(64)),row('two.png',3,'b'.repeat(64))]);assert(!store.state.sourceHasNew('h'),'same namespace reappearance retains exact acknowledgment');
}));

Deno.test('unseen Store: live native exposure waits for authoritative membership and old source tickets cannot cross incarnation/epoch',()=>withStore(async({store,page,row,publish,source,stream,snapshot,setRows,setProjection,setEpoch})=>{
  await publish(projection(2,2,[[1,1]]),[row('old.png',1),row('late.png',2)]);
  const late=register(store,page,'late.png');page.flush();assert(!store.state.entryHasNew('h:late.png'));
  setProjection(projection(3,2));stream.snapshot(snapshot());await turn();assert(store.state.entryHasNew('h:late.png'));page.flush();assert(!store.state.entryHasNew('h:late.png'),'matching authoritative membership resamples still-live native exposure');late();
  await publish(projection(4,3),[row('old.png',1),row('late.png',2),row('new.png',3)]);const stale=register(store,page,'new.png');
  source.address='replacement:2';source.incarnation='B';setEpoch('F');setProjection(projection(1,3));setRows([row('new.png',3)]);stream.snapshot(snapshot());await turn();await store.actions.hosts.select('h',{force:true});
  assert(!store.state.sourceHasNew('h'),'fresh source baselines quietly');await publish(projection(2,4),[row('new.png',3),row('fresh.png',4)]);page.flush();assert(store.state.entryHasNew('h:fresh.png'));
  stale();const fresh=register(store,page,'fresh.png');page.flush();assert(!store.state.anySourceHasNew());fresh();
}));

for(const replacement of ['address','incarnation','epoch'])Deno.test(`unseen Store: ${replacement} replacement fences pending native work and late inventory independently`,()=>withStore(async({store,page,row,publish,source,stream,snapshot,setRows,setProjection,setEpoch})=>{
  await publish(projection(2,2),[row('old.png',1),row('new.png',2)]);
  const stale=register(store,page,'new.png'),currentInventory=api.inventory;
  let resolve;const gate=new Promise(yes=>resolve=yes);const old=await currentInventory();api.inventory=()=>gate;
  const pending=store.actions.ui.refresh();await turn();api.inventory=currentInventory;
  if(replacement==='address')source.address='other:2';
  if(replacement==='incarnation')source.incarnation='B';
  if(replacement==='epoch')setEpoch('F');
  setProjection(projection(1,2));setRows([row('old.png',1),row('new.png',2)]);stream.snapshot(snapshot());await turn();await store.actions.hosts.select('h',{force:true});
  assert(!store.state.anySourceHasNew(),'replacement baselines quietly');
  await publish(projection(2,3),[row('old.png',1),row('new.png',2),row('fresh.png',3)]);
  resolve(old);await pending;await turn();page.flush();assert(store.state.entryHasNew('h:fresh.png'),'old inventory/native work cannot roll back or acknowledge replacement');
  stale();register(store,page,'fresh.png');page.flush();assert(!store.state.anySourceHasNew());
}));

Deno.test('unseen Store: foreign origin and older/contradictory inventory cannot replace live entries or membership',()=>withStore(async({store,row,publish})=>{
  await publish(projection(2,2),[row('old.png',1),row('new.png',2)]);
  const inventory=api.inventory,good=await inventory(),ids=store.state.images.map(e=>e.id);
  for(const reply of [
    {...good,origin:{...good.origin,epoch:'foreign'}},
    {...good,arrivals:projection(1,1)},
    {...good,arrivals:projection(2,2,[[1,1]])},
  ]){
    api.inventory=async()=>({...reply,entries:[row('foreign.png',1)]});await store.actions.ui.refresh();await turn();
    assertEquals(store.state.images.map(e=>e.id),ids);assert(store.state.sourceHasNew('h'));assert(store.state.entryHasNew('h:new.png'));
  }
  api.inventory=inventory;
}));

for(const state of ['hidden','gone'])Deno.test(`unseen Store: authoritative ${state} of last unseen item clears shared readers without exposure`,()=>withStore(async({store,row,publish})=>{
  await publish(projection(2,2),[row('old.png',1),row('new.png',2)]);assert(store.state.entryHasNew('h:new.png'));assert(store.state.anySourceHasNew());
  await publish(projection(3,2,[[1,1]]),[row('old.png',1),{...row('new.png',2),state}]);
  assert(!store.state.entryHasNew('h:new.png'));assert(!store.state.sourceHasNew('h'));assert(!store.state.anySourceHasNew());
}));
