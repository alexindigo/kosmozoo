import { assertEquals } from "jsr:@std/assert";
import { estimateGenerationTime } from "../client-solid/features/variations/time-estimate.js";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { makeVariationSession } from "../client-solid/features/variations/session.js";
import { editorRig } from "./helpers/variation-editor.mjs";

Deno.test("variation time: weighted original durations use the displayed per-image job estimate", () => {
  assertEquals(estimateGenerationTime(3, [60000, 180000]).display, "12m");
  assertEquals(estimateGenerationTime(3, [60000, 180000]).partial, false);
  assertEquals(estimateGenerationTime(3, [60000, 180000, null]).display, "above 12m");
  assertEquals(estimateGenerationTime(3, [60000, 180000, null]).partial, true);
  assertEquals(estimateGenerationTime(3, [null, undefined]).display, "--");
  assertEquals(estimateGenerationTime(3, [0]).display, "0s");
  assertEquals(estimateGenerationTime(1, [3600000]).display, "1h");
  assertEquals(estimateGenerationTime(1, [721000]).display, "12m 1s");
  assertEquals(estimateGenerationTime(1, [500]).display, "0.5s");
  for (const n of [null, 0, -1, NaN, Infinity, "3"]) assertEquals(estimateGenerationTime(n, [60000]).display, "--");
  assertEquals(estimateGenerationTime(3, [-1, NaN, Infinity, "60000"]).display, "--");
});

function fixture(times, read = async () => ({ name: "image.png", hash: "a".repeat(64), generationTimeMs: 60000 })) {
  const base = editorRig(); base.editor.dispose();
  let origin = base.context.origin, changes = 0;
  const targets = times.map((generationTimeMs, i) => ({ id: `fake:image${i}.png`, host: "fake", filename: `image${i}.png`,
    hash: "a".repeat(64), origin, ...(generationTimeMs === undefined ? {} : { generationTimeMs }) }));
  const editor = makeVariationEditor({ targets, services: { ...base.services, generationTime: read },
    currentOrigin: () => origin, changed: () => changes++ });
  editor.installCatalogue(base.catalogue);
  const enable = () => {
    editor.setEnabled("n.denoise", true);
    editor.edit("numeric", "n.denoise", "mode", "value");
    editor.edit("numeric", "n.denoise", "value", "0.9");
  };
  return { editor, enable, changes: () => changes, replace: () => { origin = { ...origin, incarnation: "replacement" }; } };
}

Deno.test("variation time: private preview tracks recipe count, full/partial/unknown and source retirement", () => {
  const f = fixture([60000, null]); f.enable();
  assertEquals(f.editor.preview().timeEstimate.display, "above 1m");
  f.replace(); assertEquals(f.editor.preview().timeEstimate.display, "--"); f.editor.dispose();
  const single = fixture([60000]); single.enable();
  assertEquals(single.editor.preview().timeEstimate.display, "1m");
  single.editor.edit("numeric", "n.denoise", "mode", "range");
  single.editor.range("n.denoise", { min: "0.5", max: "0.7" });
  single.editor.edit("numeric", "n.denoise", "rawIncrement", "0.1");
  assertEquals(single.editor.preview().timeEstimate.display, "3m");
  single.editor.edit("numeric", "n.denoise", "rawIncrement", "-");
  assertEquals(single.editor.preview().timeEstimate.display, "--"); single.editor.dispose();
});

Deno.test("variation time: async observations do not edit the recipe and reject foreign bytes", async () => {
  let calls = 0;
  const f = fixture([undefined], async target => { calls++; return { name: target.filename, hash: "a".repeat(64), generationTimeMs: 60000 }; });
  const revision = f.editor.revision(), dirty = f.editor.dirty();
  await Promise.all([f.editor.loadGenerationTimes(), f.editor.loadGenerationTimes()]);
  assertEquals(calls, 1); assertEquals(f.editor.revision(), revision); assertEquals(f.editor.dirty(), dirty);
  f.enable(); assertEquals(f.editor.preview().timeEstimate.display, "1m"); f.editor.dispose();
  const foreign = fixture([undefined], async target => ({ name: target.filename, hash: "b".repeat(64), generationTimeMs: 60000 }));
  await foreign.editor.loadGenerationTimes(); foreign.enable();
  assertEquals(foreign.editor.preview().timeEstimate.display, "--"); foreign.editor.dispose();
});

Deno.test("variation time: late source-replaced and disposed reads cannot publish or retarget", async () => {
  for (const action of ["replace", "dispose"]) {
    let finish, signal;
    const f = fixture([undefined], (target, options) => { signal = options.signal; return new Promise(resolve => { finish = () => resolve({ name: target.filename, hash: target.hash, generationTimeMs: 60000 }); }); });
    const reading = f.editor.loadGenerationTimes();
    if (action === "replace") f.replace(); else f.editor.dispose();
    const before = f.changes(); finish(); await reading;
    assertEquals(f.changes(), before);
    if (action === "dispose") assertEquals(signal.aborted, true);
    else { f.enable(); assertEquals(f.editor.preview().timeEstimate.display, "--"); f.editor.dispose(); }
  }
});

Deno.test("variation time: session captures known timing and archive recalls use byte hashes, never graph hashes", async () => {
  let state = { open: false, session: null };
  const session = makeVariationSession({ read: () => state, write: next => { state = next; } });
  const target = { id: "fake:image.png", host: "fake", filename: "image.png", hash: "a".repeat(64), generationTimeMs: 720000 };
  await session.open([target], false);
  assertEquals(state.images[0].hash, target.hash);
  assertEquals(state.images[0].generationTimeMs, 720000);
  state = { open: false, session: null };
  await session.openHistory({ id: "run", leaseId: "lease", targets: [{ ...target, hash: "b".repeat(64) }],
    resources: [{ id: "target-0", hash: "c".repeat(64) }] });
  assertEquals(state.images[0].hash, "c".repeat(64));
});
