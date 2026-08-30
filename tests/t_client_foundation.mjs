// tests/t_client_foundation.mjs — Phase 6 contract tests: geometry is
// box-fraction (unit-free), persistence is default-absent, state has one
// render path.

import { assert, assertEquals } from "jsr:@std/assert";
import { freshView, viewToPersisted, viewFromPersisted, transform, mapFrac, pivotScreen, panFrac } from "../client/js/geometry.mjs";
import { state } from "../client/js/state.mjs";
import { render, subscribe } from "../client/app/services/notify.mjs";

const BOX = { w: 1000, h: 500 };

Deno.test("geometry: fresh view is identity", () => {
  const v = freshView();
  assertEquals(v, { s: 1, txf: 0, tyf: 0, fh: false, fv: false, rot: 0 });
  assertEquals(viewToPersisted(v), null); // untouched view is not persisted
});

Deno.test("geometry: default-absent persistence round-trip", () => {
  assertEquals(viewFromPersisted(null), null);
  assertEquals(viewFromPersisted(viewToPersisted(freshView())), null);
  const v = { s: 2, txf: 0.1, tyf: -0.05, fh: true, fv: false, rot: 90 };
  const back = viewFromPersisted(viewToPersisted(v));
  assertEquals(back.s, 2);
  assertEquals(back.txf, 0.1);
  assertEquals(back.fh, true);
  assertEquals(back.rot, 90);
});

Deno.test("geometry: txf/tyf are box fractions — same view, different box sizes", () => {
  // A view panned 10% of the box width must move the image by 10% of
  // whatever box it is laid out in — that is what unit-free means, and what
  // makes a shared registration work across images of differing dimensions.
  const v = { ...freshView(), txf: 0.1 };
  const big = transform(v, { w: 2000, h: 1000 });
  const small = transform(v, { w: 500, h: 250 });
  assert(big.includes("translate(200px"), `big box: ${big}`);
  assert(small.includes("translate(50px"), `small box: ${small}`);
});

Deno.test("geometry: mapFrac centres at 0.5,0.5 with identity view", () => {
  const v = freshView();
  const [x, y] = mapFrac(v, BOX, 0.5, 0.5, 1600, 900);
  assertEquals([x, y], [800, 450]);
});

Deno.test("geometry: panFrac is the inverse of the display transform (rotation=0)", () => {
  const v = { ...freshView(), s: 2 };
  // dragging 100 screen-px right at scale 2 in a 1000-wide box = +0.05 frac
  const [dx] = panFrac(v, BOX, 100, 0);
  assert(Math.abs(dx - 0.05) < 1e-9, `panFrac dx=${dx}`);
});

Deno.test("geometry: pivotScreen is window centre for identity view", () => {
  const [x, y] = pivotScreen(freshView(), BOX, 1600, 900);
  assertEquals([x, y], [800, 450]);
});

Deno.test("state: single render path — render() fans out to all subscribers", () => {
  let a = 0, b = 0;
  const unsubA = subscribe(() => a++);
  const unsubB = subscribe(() => b++);
  render();
  assertEquals(a, 1);
  assertEquals(b, 1); // every subscriber ran from the single render call
  unsubA();
  unsubB();
  render();
  assertEquals(a, 1); // unsubscribed listeners stay quiet
});

Deno.test("state: workbench closed by default, current-image pointer null", () => {
  assertEquals(state.diff.open, false);
  assertEquals(state.current, null);
});

Deno.test("state: ROI manual-first (null until set), guides a list", () => {
  assertEquals(state.roi, null);
  assert(Array.isArray(state.guides));
});

// --- diff URL grammar ------------------------------------------------------

import { parseDiffHash, diffUrl } from "../client/js/route.mjs";

Deno.test("diff: parseDiffHash round-trips host-vs-host sides", () => {
  const { left, right } = parseDiffHash("fake#flux-basic.png:another#flux-lora.png");
  assertEquals(left, { source: "fake", file: "flux-basic.png" });
  assertEquals(right, { source: "another", file: "flux-lora.png" });
});

Deno.test("diff: anchor source and hostile filenames round-trip", () => {
  const weird = "a b#c:d.png";
  const hash = diffUrl({ source: "fake", file: weird }, { source: "anchor", file: "ref one.png" }).slice("/diff#".length);
  const { left, right } = parseDiffHash(hash);
  assertEquals(left, { source: "fake", file: weird });
  assertEquals(right, { source: "anchor", file: "ref one.png" });
});

Deno.test("diff: malformed sides parse to null, not garbage", () => {
  assertEquals(parseDiffHash("nosource").left, null);
  assertEquals(parseDiffHash("fake#:anchor#x.png").left, null);
  assertEquals(parseDiffHash("").right, null);
});

// --- metadata fields: registry-driven ---------------------------------------

import { fullFieldRows, metaStripText } from "../client/js/fields.mjs";

const REGISTRY = {
  KSampler: { title: null, inputs: { steps: "number", seed: "number", sampler_name: "string" } },
  LoraLoaderModelOnly: { title: "Load LoRA", inputs: { lora_name: "string", strength_model: "number" } },
  CLIPTextEncode: { title: null, inputs: { text: "string" } },
};

Deno.test("fields: every node input is a field; instances each get a row", () => {
  const prev = state.nodesRegistry;
  state.nodesRegistry = REGISTRY;
  try {
    const rows = fullFieldRows({
      nodes: [
        { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7, sampler_name: "euler" } },
        { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
        { id: "3", type: "LoraLoaderModelOnly", inputs: { lora_name: "b.safetensors", strength_model: 0.5 } },
      ],
    });
    assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "a.safetensors"), "lora name row");
    assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "b.safetensors"), "second lora name row");
    assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.8"));
    assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.5"));
    assert(rows.some(([l, v]) => l === "KSampler — steps" && v === "20"));
    assert(rows.some(([l, v]) => l === "KSampler — seed" && v === "7"));
    assert(rows.some(([l, v]) => l === "KSampler — sampler_name" && v === "euler"));
  } finally {
    state.nodesRegistry = prev;
  }
});

Deno.test("fields: unknown node types on the image simply don't render", () => {
  const prev = state.nodesRegistry;
  state.nodesRegistry = REGISTRY;
  try {
    const rows = fullFieldRows({
      nodes: [{ id: "1", type: "FluxGuidance", inputs: { guidance: 3.5 } }],
    });
    assertEquals(rows, []); // FluxGuidance is not in the registry yet
  } finally {
    state.nodesRegistry = prev;
  }
});

Deno.test("fields: the one-line strip respects toggles and joins short values", () => {
  const prevReg = state.nodesRegistry;
  const prevCfg = state.fieldsCfg;
  state.nodesRegistry = REGISTRY;
  state.fieldsCfg = {
    "KSampler.seed": { strip: true, card: false },
    "KSampler.steps": { strip: true, card: false },
    "LoraLoaderModelOnly.lora_name": { strip: true, card: false },
    "LoraLoaderModelOnly.strength_model": { strip: false, card: false },
  };
  try {
    const strip = metaStripText({
      nodes: [
        { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7 } },
        { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
      ],
    });
    assertEquals(strip, "KSampler — seed 7 · KSampler — steps 20 · LoraLoaderModelOnly — lora_name a.safetensors");
  } finally {
    state.nodesRegistry = prevReg;
    state.fieldsCfg = prevCfg;
  }
});

Deno.test("valueDiffer: values that differ from the previous meta are marked", async () => {
  const { valueDiffer } = await import("../client/js/fields.mjs");
  const prev = state.nodesRegistry;
  state.nodesRegistry = REGISTRY;
  try {
    const differs = valueDiffer({
      nodes: [
        { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7 } },
        { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
      ],
    });
    assert(!differs("KSampler — seed", "7"), "same value is unchanged");
    assert(differs("KSampler — seed", "8"), "a changed value is marked");
    assert(!differs("KSampler — steps", "20"));
    assert(differs("KSampler — steps", "30"));
    assert(!differs("LoraLoaderModelOnly — strength_model", "0.8"));
    assert(differs("FluxGuidance — guidance", "3.5"), "a field the previous image lacked is marked");
    // no comparison target → nothing differs
    assert(!valueDiffer(null)("KSampler — seed", "999"));
  } finally {
    state.nodesRegistry = prev;
  }
});

Deno.test("nodeImages: only LoadImage image inputs surface — SaveImage's filename_prefix is not an input file", async () => {
  const { nodeImages } = await import("../client/js/fields.mjs");
  const meta = {
    nodes: [
      { id: "1", type: "LoadImage", inputs: { image: "source.png" } },
      { id: "2", type: "SaveImage", inputs: { filename_prefix: "ark#var_output_00001_.png" } },
      { id: "3", type: "CLIPTextEncode", inputs: { text: "a .png mentioned in text" } },
    ],
  };
  const imgs = nodeImages(meta, "ark");
  assertEquals(imgs.length, 1);
  assertEquals(imgs[0].file, "source.png");
  assertEquals(imgs[0].fromOutput, false);
  assert(imgs[0].src.includes("/api/input-bytes/"), "input ref uses input-bytes");
  // dedup: two LoadImage nodes on the same file render once
  const dup = nodeImages({ nodes: [
    { id: "1", type: "LoadImage", inputs: { image: "source.png" } },
    { id: "2", type: "LoadImage", inputs: { image: "source.png" } },
  ] }, "ark");
  assertEquals(dup.length, 1);
});

Deno.test("nodeImages: a LoadImage-from-output value is stripped of [output] and served from the output route", async () => {
  const { nodeImages } = await import("../client/js/fields.mjs");
  const meta = {
    nodes: [
      { id: "9", type: "LoadImage", title: "Load Image", inputs: { image: "ark#ark#alisa_impl_00291__0.55_00001_.png [output]" } },
    ],
  };
  const imgs = nodeImages(meta, "ark");
  assertEquals(imgs.length, 1);
  assertEquals(imgs[0].file, "ark#ark#alisa_impl_00291__0.55_00001_.png");
  assertEquals(imgs[0].fromOutput, true);
  assert(imgs[0].src.includes("/api/images/"), "output ref uses the feed bytes route");
  assert(!imgs[0].src.includes("[output]"), "annotation stripped from the URL");
});

// --- current-image tracking -------------------------------------------------

Deno.test("assignCurrent: the replaced pointer goes onto the stack; popCurrent walks it back", async () => {
  const { assignCurrent, popCurrent } = await import("../client/js/route.mjs");
  const savedCurrent = state.current, savedStack = state.currentStack;
  try {
    state.current = null;
    state.currentStack = [];

    // first pointer: nothing to push
    assignCurrent({ remote: "ark", image: "a.png" });
    assertEquals(state.current, { remote: "ark", image: "a.png" });
    assertEquals(state.currentStack, []);

    // a real change pushes the replaced pointer
    assignCurrent({ remote: "ark", image: "b.png" });
    assertEquals(state.currentStack, [{ remote: "ark", image: "a.png" }]);

    // re-assigning the same target does not churn the stack
    assignCurrent({ remote: "ark", image: "b.png" });
    assertEquals(state.currentStack.length, 1);

    // a remote switch (image dropped) is still a change; clearing pushes too
    assignCurrent({ remote: "anton", image: null });
    assignCurrent(null);
    assertEquals(state.current, null);
    assertEquals(state.currentStack.length, 3);
    assertEquals(state.currentStack.at(-1), { remote: "anton", image: null });

    // pop makes the latest previous current, consumes its entry, and does
    // not push the outgoing pointer
    assertEquals(popCurrent(), { remote: "anton", image: null });
    assertEquals(state.current, { remote: "anton", image: null });
    assertEquals(state.currentStack.length, 2);
    assertEquals(popCurrent(), { remote: "ark", image: "b.png" });
    assertEquals(popCurrent(), { remote: "ark", image: "a.png" });
    assertEquals(state.currentStack, []);
    // empty trail: pop is a no-op
    assertEquals(popCurrent(), null);
    assertEquals(state.current, { remote: "ark", image: "a.png" });
  } finally {
    state.current = savedCurrent;
    state.currentStack = savedStack;
  }
});

Deno.test("assignCurrent: the stack is a bounded window", async () => {
  const { assignCurrent } = await import("../client/js/route.mjs");
  const savedCurrent = state.current, savedStack = state.currentStack;
  try {
    state.current = { remote: "ark", image: "seed.png" };
    state.currentStack = [];
    for (let i = 0; i < 210; i++) assignCurrent({ remote: "ark", image: `img-${i}.png` });
    assertEquals(state.currentStack.length, 200);
    assertEquals(state.currentStack.at(-1), { remote: "ark", image: "img-208.png" });
  } finally {
    state.current = savedCurrent;
    state.currentStack = savedStack;
  }
});

Deno.test("assignCurrent: push:false moves the pointer without touching the stack", async () => {
  const { assignCurrent } = await import("../client/js/route.mjs");
  const savedCurrent = state.current, savedStack = state.currentStack;
  try {
    state.current = { remote: "ark", image: "gone.png" };
    state.currentStack = [{ remote: "ark", image: "before.png" }];
    assignCurrent({ remote: "ark", image: "next.png" }, { push: false });
    assertEquals(state.current, { remote: "ark", image: "next.png" });
    assertEquals(state.currentStack, [{ remote: "ark", image: "before.png" }]);
  } finally {
    state.current = savedCurrent;
    state.currentStack = savedStack;
  }
});

// --- feed rail tape window ----------------------------------------------------

Deno.test("tapeWindow: whole view fits → tape is static", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  assertEquals(tapeWindow(50, 100, 0, 20, 0), 0);
  assertEquals(tapeWindow(100, 100, 40, 60, 0), 0);
});

Deno.test("tapeWindow: wave mid-tape → tape holds (hysteresis)", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  // capacity 100, view 1000, tape at 200, margin 25 → wave inside
  // [225, 275+... ] holds
  assertEquals(tapeWindow(1000, 100, 230, 240, 200), 200);
});

Deno.test("tapeWindow: wave at the right edge → tape re-centers on it", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  // tape 0..99, margin 25 → wave ending past 75 triggers re-center:
  // center of [70,78] = 74, minus capacity/2 (50) = 24
  assertEquals(tapeWindow(1000, 100, 70, 78, 0), 24);
});

Deno.test("tapeWindow: wave at the left edge → tape re-centers, clamped at 0", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  // tape 100..199, margin 25 → wave starting before 125 triggers re-center
  const next = tapeWindow(1000, 100, 100, 110, 100);
  assertEquals(next, 105 - 50); // center(105) - 50 = 55
});

Deno.test("tapeWindow: the tape clamps at the list end", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  assertEquals(tapeWindow(300, 100, 280, 295, 150), 200); // maxStart = 200
});

Deno.test("tapeWindow: zero capacity is safe", async () => {
  const { tapeWindow } = await import("../client/js/feedrail.mjs");
  assertEquals(tapeWindow(1000, 0, 0, 0, 0), 0);
});

// --- deletion navigation ------------------------------------------------------

Deno.test("planDeleteCurrent: previous current iff adjacent, else feed-above, else topmost", async () => {
  const { planDeleteCurrent } = await import("../client/js/route.mjs");
  const imgs = ["a", "b", "c", "d", "e"].map((f) => ({ host: "h", filename: f }));
  const cur = (f) => ({ remote: "h", image: f });
  const prev = (f) => (f ? { remote: "h", image: f } : null);

  // current not among the deleted → nothing to do
  assertEquals(planDeleteCurrent(imgs, new Set(["d"]), "h", cur("a"), prev("b")), null);
  // previous current adjacent to the deleted one (either side) → pop
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), prev("b")), { kind: "pop" });
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), prev("d")), { kind: "pop" });
  // previous current exists but NOT adjacent → nearest surviving above
  assertEquals(planDeleteCurrent(imgs, new Set(["d"]), "h", cur("d"), prev("a")), { kind: "set", image: "c" });
  // no previous current → nearest surviving above
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), null), { kind: "set", image: "b" });
  // nothing above → the new topmost
  assertEquals(planDeleteCurrent(imgs, new Set(["a"]), "h", cur("a"), null), { kind: "set", image: "b" });
  // bulk: the image above is deleted too → walk further up
  assertEquals(planDeleteCurrent(imgs, new Set(["b", "c"]), "h", cur("c"), null), { kind: "set", image: "a" });
  // previous current adjacent but deleted itself → feed rule, not pop
  assertEquals(planDeleteCurrent(imgs, new Set(["b", "c"]), "h", cur("c"), prev("b")), { kind: "set", image: "a" });
  // everything gone → clear
  assertEquals(planDeleteCurrent(imgs, new Set(["a", "b", "c", "d", "e"]), "h", cur("c"), null), { kind: "clear" });
  // a cross-host previous current is never "next to" the deleted one
  assertEquals(
    planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), { remote: "other", image: "b" }),
    { kind: "set", image: "b" },
  );
});
