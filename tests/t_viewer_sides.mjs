import { assertEquals } from "jsr:@std/assert";
import { sides, viewerSide, columnForSide, sideForColumn, workbenchLayout, workbenchViews } from "../client-solid/features/diff/views.mjs";
import { CORE_BINDINGS } from "../client-solid/store/key-bindings.js";
import { hitLayer } from "../client-solid/features/diff/hit.mjs";

Deno.test("viewer placement: one immutable map binds identity, labels and directional keys", () => {
  assertEquals(sides, { left: "a", right: "b" });
  assertEquals(Object.isFrozen(sides), true);
  for (const [position, side] of Object.entries(sides)) {
    const binding = CORE_BINDINGS.find(b => b.id === `wb.col${position === "left" ? "Left" : "Right"}`);
    assertEquals(binding.args.column, columnForSide(side));
    assertEquals(sideForColumn(binding.args.column), side);
    assertEquals(viewerSide[side].label, side.toUpperCase());
  }
});

Deno.test("viewer placement: every kind/view derives fixed positions, subject-only visibility and wipe regions", () => {
  for (const kind of ["image", "video", "audio"]) for (const { mode } of workbenchViews(kind)) {
    for (const subject of ["a", "b"]) for (const splitT of [.25, .75]) {
      const layout = workbenchLayout({ mode, subject, splitT });
      assertEquals([layout.left, layout.right], ["a", "b"]);
      assertEquals(layout.active, subject);
      assertEquals(layout.divider, mode === "split" ? splitT : .5);
      for (const [position, side] of Object.entries(sides)) {
        assertEquals(layout.layers[side], { position, label: side.toUpperCase(), active: side === subject,
          shown: mode !== "difference" && (mode !== "full" || side === subject),
          front: mode === "one-up" && side === subject, clip: mode === "split" ? position : null });
      }
      const args = { mode, col:columnForSide(subject), splitT, stageRect:{left:100,width:1200} };
      assertEquals(hitLayer({...args,x:110}), ["two-up","split"].includes(mode) ? "a" : subject);
      assertEquals(hitLayer({...args,x:1290}), ["two-up","split"].includes(mode) ? "b" : subject);
    }
  }
});

Deno.test("viewer placement: a missing peer has no clip or phantom second cell", () => {
  for (const subject of ["a", "b"]) for (const mode of ["full", "two-up", "one-up", "split"]) {
    const layout = workbenchLayout({ mode, subject, paired:false });
    assertEquals(layout.layers[subject].shown, true);
    assertEquals(layout.layers[subject === "a" ? "b" : "a"].shown, false);
    assertEquals(layout.layers.a.clip, null);
    assertEquals(layout.layers.b.clip, null);
    for (const x of [110, 1290]) assertEquals(hitLayer({ mode, col:columnForSide(subject), paired:false, x, stageRect:{left:100,width:1200} }), subject);
  }
});
