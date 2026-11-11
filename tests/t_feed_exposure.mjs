import { assert, assertEquals } from 'jsr:@std/assert';
import { intersection, uncovered, makeFeedExposure } from '../client-solid/lib/feed-exposure.js';
const r=(left,top,right,bottom)=>({left,top,right,bottom});
Deno.test('feed exposure: positive area through native clipping and exact union of occluders',()=>{
  assertEquals(intersection(r(0,0,10,10),r(10,0,20,10)),null);
  assertEquals(intersection(r(0,0,10,10),r(5,5,20,20)),r(5,5,10,10));
  assert(!uncovered(r(0,0,10,10),[r(0,0,5,10),r(5,0,10,10)]));
  assert(uncovered(r(0,0,10,10),[r(0,0,5,10),r(6,0,10,10)]));
});

function nativePage() {
  const document=Object.assign(new EventTarget(),{visibilityState:'visible'}), observers=[], frames=new Map();let next=0;
  const makeObserver=type=>class {
    constructor(callback){Object.assign(this,{callback,type,targets:new Set(),active:true});observers.push(this);}
    observe(el){this.active=true;this.targets.add(el);}disconnect(){this.active=false;this.targets.clear();}
  };
  const page=Object.assign(new EventTarget(),{document,innerWidth:100,innerHeight:100,
    ResizeObserver:makeObserver('resize'),IntersectionObserver:makeObserver('intersection'),
    getComputedStyle:el=>({display:el.display??'block',visibility:'visible',opacity:'1'}),
    requestAnimationFrame(fn){frames.set(++next,fn);return next;},cancelAnimationFrame(id){frames.delete(id);}});
  document.defaultView=page;
  const element=(bounds=r(0,0,100,100))=>Object.assign(new EventTarget(),{ownerDocument:document,isConnected:true,bounds,
    getBoundingClientRect(){return {...this.bounds,width:this.bounds.right-this.bounds.left,height:this.bounds.bottom-this.bounds.top};}});
  const flush=()=>{for(const[id,fn]of [...frames]){frames.delete(id);fn();}};
  return {page,document,element,observers,flush,frames};
}
Deno.test('feed exposure: registrations before page bind all native observations and dispose disconnects them',()=>{
  const p=nativePage(),owner=makeFeedExposure(),surface=p.element(),clip=p.element(),root=p.element(),cover=p.element(r(0,0,1,1));let exposures=0;
  owner.root(root);owner.surface({element:surface,clip,valid:()=>true,ready:()=>true,expose:()=>exposures++});owner.occluder(cover);
  owner.page(p.page);
  for(const el of [surface,clip,root,cover])assert(p.observers.some(o=>o.active&&o.targets.has(el)),'every retained element observed');
  p.flush();assertEquals(exposures,1);owner.dispose();assert(p.observers.every(o=>!o.active));assertEquals(p.frames.size,0);
  for(const o of p.observers)o.callback([]);p.flush();assertEquals(exposures,1);
});
Deno.test('feed exposure: page replacement retires old observers/elements and stale callbacks cannot acknowledge',()=>{
  const p=nativePage(),q=nativePage(),owner=makeFeedExposure();let exposures=0;
  const old=owner.page(p.page);owner.root(p.element());owner.surface({element:p.element(),clip:p.element(),valid:()=>true,ready:()=>true,expose:()=>exposures++});
  const callbacks=p.observers.map(o=>o.callback);owner.page(q.page);old();
  callbacks.forEach(fn=>fn([]));p.flush();q.flush();assertEquals(exposures,0);assert(p.observers.every(o=>!o.active));
  owner.root(q.element());owner.surface({element:q.element(),clip:q.element(),valid:()=>true,ready:()=>true,expose:()=>exposures++});q.flush();assertEquals(exposures,1);
  owner.dispose();assert(q.observers.every(o=>!o.active));
});
Deno.test('feed exposure: resize, placement and visibility invalidation sample fresh geometry without feed scroll',()=>{
  const p=nativePage(),owner=makeFeedExposure();owner.page(p.page);owner.root(p.element());let exposures=0;
  const media=p.element(r(120,0,150,20)),cover=p.element();owner.surface({element:media,clip:p.element(),valid:()=>true,ready:()=>true,expose:()=>exposures++});owner.occluder(cover);
  p.flush();assertEquals(exposures,0);media.bounds=r(0,0,20,20);
  p.observers.filter(o=>o.targets.has(media)).forEach(o=>o.callback([]));p.flush();assertEquals(exposures,0,'fully covered');
  cover.display='none';owner.invalidate();p.flush();assertEquals(exposures,1);
  p.document.visibilityState='hidden';owner.invalidate();p.flush();assertEquals(exposures,1);
  p.document.visibilityState='visible';p.document.dispatchEvent(new Event('visibilitychange'));p.flush();assertEquals(exposures,2);owner.dispose();
});

Deno.test('feed exposure: pagehide disconnects native observation and queued work; pageshow rebinds once',()=>{
  const p=nativePage(),owner=makeFeedExposure();owner.page(p.page);owner.root(p.element());let exposures=0;
  owner.surface({element:p.element(),clip:p.element(),valid:()=>true,ready:()=>true,expose:()=>exposures++});
  const stale=[...p.frames.values()],oldObservers=[...p.observers];p.page.dispatchEvent(new Event('pagehide'));
  assert(p.observers.every(o=>!o.active),'hidden page retires IO/RO ownership');assertEquals(p.frames.size,0);
  stale.forEach(fn=>fn());p.observers.forEach(o=>o.callback([]));p.flush();assertEquals(exposures,0);assertEquals(p.frames.size,0);
  p.page.dispatchEvent(new Event('pageshow'));p.flush();assertEquals(exposures,1);assert(p.observers.some(o=>o.active));
  stale.forEach(fn=>fn());oldObservers.forEach(o=>o.callback([]));p.flush();assertEquals(exposures,1,'retired observation leg stays fenced after recovery');owner.dispose();
});
