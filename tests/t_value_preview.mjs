import { assert, assertEquals } from "jsr:@std/assert";
import { makeValuePreview, valuePreviewPlacement } from "../client-solid/lib/value-preview.js";
Deno.test("preview geometry: six viewport sizes bound body and notch to actual anchor", () => {
  for (const [width,height] of [[1600,1000],[1024,768],[768,600],[500,700],[360,640],[1024,360]]) {
    const trigger = { left: width-190, right: width-30, top: height/2, bottom: height/2+20 };
    const p = valuePreviewPlacement(trigger, {width,height}, {width:480,height:360});
    assert(p.left>=8 && p.top>=8 && p.left+p.width<=width-8 && p.top+p.height<=height-8);
    assertEquals(p.left+p.anchor,(trigger.left+trigger.right)/2);
  }
});
Deno.test("preview lifetime: gap grace, selection and drag retain identity; dismissal cannot reopen", () => {
  const states=[]; let timer;
  const p=makeValuePreview({show: v=>states.push(v), setTimer: f=>(timer=f,1),clearTimer:()=>timer=null});
  p.hold("trigger",true,true);p.hold("trigger",false);assert(timer);
  p.hold("panel",true,true);assertEquals(timer,null);
  p.hold("selection",true);p.hold("panel",false);assertEquals(timer,null);
  p.dismiss();p.hold("selection",true);assertEquals(states,[true,false]);p.dispose();
});
