import { assert, assertEquals } from "jsr:@std/assert";
import { VALUE_PREVIEW_GAP, valuePreviewPlacement } from "../client-solid/lib/value-preview.js";
Deno.test("preview geometry: six viewport sizes bound body and notch to actual anchor", () => {
  for (const [width,height] of [[1600,1000],[1024,768],[768,600],[500,700],[360,640],[1024,360]]) {
    const trigger = { left: width-190, right: width-30, top: height/2, bottom: height/2+20 };
    const p = valuePreviewPlacement(trigger, {width,height}, {width:480,height:360});
    assert(p.left>=8 && p.top>=8 && p.left+p.width<=width-8 && p.top+p.height<=height-8);
    assertEquals(p.left+p.anchor,(trigger.left+trigger.right)/2);
  }
});
Deno.test("preview geometry: CSS hover bridge uses the actual above/below placement gap", () => {
  for (const top of [20, 700]) {
    const trigger = { left: 100, right: 280, top, bottom: top + 20 };
    const p = valuePreviewPlacement(trigger, {width: 1000, height: 800}, {width: 480, height: 360});
    assertEquals(p.gap, VALUE_PREVIEW_GAP);
    assertEquals(p.side === "below" ? p.top - trigger.bottom : trigger.top - (p.top + p.height), p.gap);
  }
});
