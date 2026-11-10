import { assertEquals } from 'jsr:@std/assert';
import { horizontalReveal, makeKeyboardReveal } from '../client-solid/features/variations/keyboard-reveal.js';
const geometry = { viewport: { left:37, right:463 }, target: { left:434, right:532 }, left:0, maximum:306 };
Deno.test('Tab reveal geometry is minimal, horizontal and clamped', () => {
  assertEquals(horizontalReveal(geometry),69);
  assertEquals(horizontalReveal({...geometry,target:{left:40,right:100}}),0);
  assertEquals(horizontalReveal({...geometry,left:200,target:{left:20,right:100}}),183);
  assertEquals(horizontalReveal({...geometry,maximum:30}),30);
});
function rig() {
  const jobs=new Map(), writes=[]; let id=0, current={};
  const owner=makeKeyboardReveal({schedule:fn=>{jobs.set(++id,fn);return id;},cancel:key=>jobs.delete(key),read:target=>target===current?geometry:null,write:left=>writes.push(left)});
  return {owner,jobs,writes,target:current,flush:()=>{for(const [id,fn] of [...jobs]){jobs.delete(id);fn();}},replace:()=>current={}};
}
Deno.test('Tab reveal is one shot; ordinary focus and expired tickets never write', () => {
  const r=rig();r.owner.focus(r.target);r.flush();assertEquals(r.writes,[]);
  r.owner.tab({});r.flush();r.owner.focus(r.target);r.flush();assertEquals(r.writes,[]);
  r.owner.tab({});r.owner.focus(r.target);r.flush();r.owner.focus(r.target);r.flush();assertEquals(r.writes,[69]);
});
Deno.test('Tab reveal retires pointer/key/blur/decision, replacement, removal and disposal work', () => {
  for (const retire of ['retire','dispose','replacement','removal']) {
    const r=rig();r.owner.tab({});r.owner.focus(r.target);
    const stale=[...r.jobs.values()][0];
    if(retire==='replacement')r.owner.focus({});else if(retire==='removal')r.replace();else r.owner[retire]();
    stale();r.flush();assertEquals(r.writes,[]);
  }
});
