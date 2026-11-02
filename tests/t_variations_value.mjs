import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { generatePermutations, resolveRelativeRanges } from "../src/features/variations/shared.mjs";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("Value: exactly one axis value, unchanged tuple excluded, other axes still multiply", async () => {
  const { editor, requests } = editorRig();
  try {
    editor.edit("numeric", "n.denoise", "mode", "value");
    assertEquals(editor.preview().axes[0].count, 1);
    assertEquals(editor.preview().n, 0);
    editor.edit("numeric", "n.denoise", "value", "0.9");
    assertEquals(editor.preview().n, 1);
    editor.edit("images", "image.image", "enabled", true);
    editor.addImages("image.image", ["origin.png", "next.png"].map(name => ({ kind: "input", name })));
    assertEquals(editor.preview().n, 2);
    assertEquals((await editor.run()).adopted, true);
    assertEquals(requests[0].ranges["n.denoise"], { enabled: true, min: .9, max: .9, increment: .01 });
    assertEquals(generatePermutations(requests[0].ranges, { "n.denoise": 1 }, requests[0].imageParams)
      .map(item => item["n.denoise"]), [.9, .9]);
  } finally { editor.dispose(); }
});

Deno.test("Value: dormant invalid range survives mode changes in one session; a new editor starts fresh", async () => {
  const rig = editorRig();
  const mount = () => {
    const editor = makeVariationEditor({ targets: [{ id: "fake:image.png", host: "fake", filename: "image.png", origin: rig.context.origin }],
      services: rig.services, currentOrigin: () => rig.context.origin, setTimer: () => 1, clearTimer() {} });
    editor.installCatalogue(rig.catalogue); return editor;
  };
  let editor = mount();
  try {
    editor.range("n.denoise", { min: "0.7", max: "0.8" });
    editor.edit("numeric", "n.denoise", "rawIncrement", "1e");
    editor.edit("numeric", "n.denoise", "value", "0.9");
    editor.edit("numeric", "n.denoise", "mode", "value");
    assertEquals(editor.preview().n, 1);
    assertEquals((await editor.run()).adopted, true); assert(!editor.dirty());
    const row = editor.rows("numeric")["n.denoise"];
    assertEquals([row.mode, row.value, row.min, row.max, row.rawIncrement], ["value", "0.9", "0.7", "0.8", "1e"]);
    assertEquals(editor.preview().n, 1); assert(!editor.dirty());
    editor.edit("numeric", "n.denoise", "mode", "range");
    assertEquals(editor.preview().status, "invalid");
    editor.dispose(); editor = mount();
    const fresh = editor.rows("numeric")["n.denoise"];
    assertEquals([fresh.mode, fresh.value, fresh.min, fresh.max, fresh.rawIncrement], ["range", "1", "0.85", "1", "0.05"]);
    assert(!editor.dirty());
  } finally { editor.dispose(); rig.editor.dispose(); }
});

Deno.test("Value: batch compilation fixes the same absolute value for different target currents", async () => {
  const rig = editorRig(), requests = [], outputs = [];
  const second = structuredClone(rig.catalogue); second.params[0].current = .5;
  const editor = makeVariationEditor({ targets: ["first", "second"].map(id => ({ id, host: "fake", filename: `${id}.png`, origin: rig.context.origin })),
    services: { ...rig.services, probe: async () => second, run: async request => {
      requests.push(request);
      const current = { "n.denoise": request.id === "first" ? 1 : .5 };
      outputs.push(generatePermutations(resolveRelativeRanges(request.ranges, current), current, request.imageParams));
      return rig.services.run(request);
    } }, currentOrigin: () => rig.context.origin, setTimer: () => 1, clearTimer() {} });
  try {
    editor.installCatalogue(rig.catalogue);
    editor.edit("numeric", "n.denoise", "mode", "value"); editor.edit("numeric", "n.denoise", "value", "0.9");
    assertEquals(editor.preview().n, 2);
    assertEquals((await editor.run()).adopted, true);
    assertEquals(requests.map(request => request.ranges["n.denoise"].absolute), [true, true]);
    assertEquals(outputs.map(values => values.map(item => item["n.denoise"])), [[.9], [.9]]);
  } finally { editor.dispose(); rig.editor.dispose(); }
});

Deno.test("Value: recipe rejects unclassified modes and non-text values", () => {
  const { editor } = editorRig();
  try {
    assertThrows(() => editor.edit("numeric", "n.denoise", "mode", "invented"));
    assertThrows(() => editor.edit("numeric", "n.denoise", "value", Infinity));
    assert(!editor.dirty());
  } finally { editor.dispose(); }
});
