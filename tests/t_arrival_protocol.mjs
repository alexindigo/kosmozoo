import { assert, assertEquals, assertRejects } from 'jsr:@std/assert';
import { SourceArrivals } from '../src/source-arrivals.mjs';
import { SourceActivity } from '../src/source-activity.mjs';
import { makeCollectionInventory } from '../src/backings/index.mjs';
import { makeRouter } from '../src/routes.mjs';
import { mkStateRig, sourceContext } from './helpers/rig.mjs';
import { sourceActivity } from './helpers/source-stream.mjs';
import { validateSourceSnapshot, subscribeSources } from '../client/js/source-events.mjs';
import { api } from '../client/js/api.mjs';
import { sourceFrame } from './helpers/source-stream.mjs';
import { makeUnseenItems } from '../client-solid/store/unseen-items.js';

const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
async function frame(reader) {
  const decoder=new TextDecoder();let text='',bytes=0;
  while(!text.endsWith('\n\n')){const next=await reader.read();assert(!next.done);assert(next.value.byteLength<=16384);bytes+=next.value.byteLength;text+=decoder.decode(next.value,{stream:true});}
  return {value:JSON.parse(text.split('\n').find(line=>line.startsWith('data: ')).slice(6)),bytes};
}
Deno.test('arrival protocol: fragmented membership uses cached bytes on progress, legacy parity and bounded slow/fast frames',async()=>{
  const costs=[];
  for(const count of [2000,20000]){
    const rig=await mkStateRig('arrival-fragmented',{hosts:{a:'mock:1'}});let owner;
    const excluded=new Set();let walks=0,rangeReads=0,progress;
    const arrivals=new SourceArrivals({hiddenNames(){walks++;return excluded;},goneNames(){walks++;return [];}});
    const names=Array.from({length:count},(_,i)=>`entry-${i+1}.png`),start=performance.now();
    arrivals.observe('a',names);for(let i=2;i<=count;i+=2)excluded.add(`entry-${i}.png`);arrivals.changed('a');
    const projection=arrivals.projection('a',true),wire=arrivals.wire('a');
    assertEquals(projection.visibleRanges.length,count/2);assertEquals(projection.latestVisibleSeq,count-1);
    const base=arrivals.projection.bind(arrivals),proxy=new Proxy(projection,{get(target,key,receiver){if(key==='visibleRanges')rangeReads++;return Reflect.get(target,key,receiver);}});
    arrivals.projection=(id,items)=>items?proxy:base(id,items);
    owner=new SourceActivity({store:rig.store,hosts:rig.hosts,inventory:rig.inventory,arrivals,
      jobs:{subscribe(fn){progress=fn;return()=>{};},snapshot:()=>sourceActivity()},setHeartbeat:()=>0,clearHeartbeat:()=>{}});
    const modern=owner.open(new Request('http://fixture/api/events?arrivals=items-v1')).body.getReader();
    const legacy=owner.open(new Request('http://fixture/api/events')).body.getReader();
    const slow=owner.open(new Request('http://fixture/api/events?arrivals=items-v1')).body.getReader();
    try{
      await slow.read();const first=await frame(modern),old=await frame(legacy);
      validateSourceSnapshot(first.value,{items:true});validateSourceSnapshot(old.value);
      assertEquals(first.value.sources.a.arrivals,projection);assertEquals(Object.keys(old.value.sources.a.arrivals),['sequence','latestVisibleSeq']);
      const reads=walks;
      for(let i=0;i<100;i++){progress();const current=await frame(modern);validateSourceSnapshot(current.value,{items:true});assertEquals(current.value.sources.a.arrivals.visibleRanges.length,count/2);}
      assertEquals(walks,reads);assertEquals(rangeReads,0,'progress never enumerates immutable range arrays');assertEquals(arrivals.wire('a'),wire);
      assert(owner.deliveryStats().every(s=>s.activeFrames+s.pendingFrames<=2&&s.queuedBytes===0));
      const ledger=makeUnseenItems();ledger.accept({sequence:0,latestVisibleSeq:0,revision:1,visibleRanges:[]});
      ledger.accept({...projection,revision:projection.revision+1});ledger.acknowledge(count-1);assert(ledger.isUnseen(1));assert(!ledger.isUnseen(count-1));
      arrivals.projection=base;const previous=arrivals.projection('a',true);arrivals.remove('a','entry-1.png');
      const next=arrivals.projection('a',true);assertEquals(next.latestVisibleSeq,previous.latestVisibleSeq);assertEquals(next.revision,previous.revision+1);
      const reconnect=owner.open(new Request('http://fixture/api/events?arrivals=items-v1')).body.getReader();
      try{assertEquals((await frame(reconnect)).value.sources.a.arrivals,next);}finally{await reconnect.cancel();}
      costs.push({sequences:count,intervals:count/2,bytes:first.bytes,wallMs:performance.now()-start,progressPublications:100,extraNameWalks:walks-reads-2,rangeReads});
    }finally{await modern.cancel();await legacy.cancel();await slow.cancel();owner.stop();await rig.close();}
  }
  console.log('ARRIVAL_COST '+JSON.stringify(costs));
});

Deno.test('arrival inventory: an older returning read publishes latest accepted snapshot plus synchronous visibility and origin',async()=>{
  const rig=await mkStateRig('arrival-coherence',{hosts:{a:'mock:1'}}),gate=deferred(),accepted=deferred();let latest,first=true;
  const snapshot=(names,revision)=>Object.freeze({revision,generation:1,items:names.map(name=>({name,size:10})),folders:[''],coverage:'root-only',subfolders:{supported:false,reason:'fixture'},unavailable:[]});
  latest=snapshot(['old.png'],'I:1');
  const registry=makeCollectionInventory(rig.hosts,{bindingFactory:()=>({inventory:async()=>latest,disposeInventory:async()=>{}}),
    onSnapshot:(id,_address,value,token)=>rig.store.arrivals.observe(id,value.items.map(item=>item.name),token),onRetire:token=>rig.store.arrivals.forget(token.id)});
  const inventory=Object.assign(async id=>{const value=await registry(id);if(first){first=false;accepted.resolve();await gate.promise;}return value;},
    {capture:registry.capture,isCurrent:registry.isCurrent,accepted:registry.accepted,reconcile:registry.reconcile,binding:registry.binding});
  const ctx=sourceContext({...rig,inventory}),router=makeRouter(ctx);
  try{
    const response=router.handle(new Request('http://fixture/api/collections/a/entries?inventory=1&arrivals=items-v1'));await accepted.promise;
    latest=snapshot(['old.png','new.png'],'I:2');await registry('a');rig.store.entryHide('a','old.png');gate.resolve();
    const reply=await (await response).json();assertEquals(reply.revision,'I:2');assertEquals(reply.entries.map(e=>[e.name,e.arrivalSeq]),[['new.png',2]]);
    assertEquals(reply.arrivals.visibleRanges,[[2,2]]);assertEquals(reply.arrivals.latestVisibleSeq,2);
    assertEquals(reply.origin,{source:'a',address:'mock:1',kind:'comfy',epoch:ctx.sourceActivity.epoch,incarnation:registry.capture('a').incarnation});
    const previous=registry.capture('a');delete rig.hosts.a;registry.reconcile();assert(!registry.isCurrent(previous));assertEquals(rig.store.arrivals.projection('a',true),null);
  }finally{ctx.sourceActivity.stop();await ctx.jobs.stop();await registry.stop();await rig.close();}
});

Deno.test('arrival inventory: retired late snapshots cannot repopulate the replacement namespace',async()=>{
  const gate=deferred(),hosts={a:'mock:1'},arrivals=new SourceArrivals({hiddenNames:()=>[],goneNames:()=>[]});
  const inventory=makeCollectionInventory(hosts,{bindingFactory:()=>({inventory:()=>gate.promise,disposeInventory:async()=>{}}),
    onSnapshot:(id,_address,value,token)=>arrivals.observe(id,value.items.map(item=>item.name),token),onRetire:token=>arrivals.forget(token.id)});
  const pending=inventory('a');hosts.a='mock:2';inventory.reconcile();gate.resolve({items:[{name:'late.png'}]});
  await assertRejects(()=>pending);assertEquals(arrivals.projection('a',true),null);await inventory.stop();
});

Deno.test('production API: negotiated inventory rejects missing/malformed telemetry instead of a legacy acknowledgment fallback',async()=>{
  const previous=globalThis.fetch,inventory=api.inventory;
  const origin={source:'a',address:'mock:1',kind:'comfy',epoch:'E',incarnation:'A'};
  const arrivals={sequence:2,latestVisibleSeq:2,revision:1,visibleRanges:[[1,2]]};let payload;
  globalThis.fetch=(_url)=>{const url=new URL(_url,'http://fixture');assertEquals(url.searchParams.get('arrivals'),'items-v1');return Promise.resolve(Response.json(payload));};
  try{
    for(const bad of [{entries:[]},{origin,entries:[]},{arrivals,entries:[]},{origin,arrivals:{sequence:2,latestVisibleSeq:2}},
      {origin,arrivals:{...arrivals,visibleRanges:[[1,1],[2,2]]}}]){payload=bad;await assertRejects(()=>inventory('a'));}
    payload={origin,arrivals,entries:[]};assertEquals(await inventory('a'),payload);
  }finally{globalThis.fetch=previous;}
});

Deno.test('production subscription: one opted-in native owner rejects legacy arrivals atomically',()=>{
  const previous=[],timers=new Map();let delivered=0,instance,next=0;
  const dispose=subscribeSources({onSnapshot(){delivered++;},onConnection(){}},{items:true,
    createEventSource(url){assertEquals(url,'/api/events?arrivals=items-v1');instance={addEventListener(_event,fn){this.deliver=fn;},close(){previous.push('closed');}};return instance;},
    setTimer(fn){timers.set(++next,fn);return next;},clearTimer:id=>timers.delete(id)});
  const legacy=sourceFrame({a:{}});legacy.sources.a.arrivals={sequence:1,latestVisibleSeq:1};
  instance.deliver({data:JSON.stringify(legacy),lastEventId:`${legacy.epoch}:${legacy.revision}`});
  assertEquals(delivered,0);assertEquals(previous,['closed']);assertEquals(timers.size,1);dispose();assertEquals(timers.size,0);
});
