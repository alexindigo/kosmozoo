// tests/t_client_foundation.mjs — the framework-free contracts: geometry is
// box-fraction (unit-free), persistence is default-absent, the diff URL
// grammar round-trips, the fields registry is registry-driven, the current
// pointer keeps its bounded trail, the rail tape windows with hysteresis,
// and deletion navigation plans the pointer.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";

const BOX = { w: 1000, h: 500 };

Deno.test("store: workbench closed by default, current-image pointer null", () => {
  const store = makeAppStore();
  assertEquals(store.state.diff.open, false);
  assertEquals(store.state.current(), null);
});

// --- diff URL grammar ------------------------------------------------------

import { parseDiffHash, diffUrl } from "../client/js/route-parse.mjs";

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

import {
  fieldList,
  fullFieldRows,
} from "../client-solid/store/fields.js";

const REGISTRY = {
  KSampler: { title: null, inputs: { steps: "number", seed: "number", sampler_name: "string" } },
  LoraLoaderModelOnly: { title: "Load LoRA", inputs: { lora_name: "string", strength_model: "number" } },
  CLIPTextEncode: { title: null, inputs: { text: "string" } },
};
const LIST = fieldList(REGISTRY);

Deno.test("fields: every node input is a field; instances each get a row", () => {
  const rows = fullFieldRows({
    nodes: [
      { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7, sampler_name: "euler" } },
      { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
      { id: "3", type: "LoraLoaderModelOnly", inputs: { lora_name: "b.safetensors", strength_model: 0.5 } },
    ],
  }, { list: LIST });
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "a.safetensors"), "lora name row");
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "b.safetensors"), "second lora name row");
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.8"));
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.5"));
  assert(rows.some(([l, v]) => l === "KSampler — steps" && v === "20"));
  assert(rows.some(([l, v]) => l === "KSampler — seed" && v === "7"));
  assert(rows.some(([l, v]) => l === "KSampler — sampler_name" && v === "euler"));
});

Deno.test("fields: unknown node types on the image simply don't render", () => {
  const rows = fullFieldRows({
    nodes: [{ id: "1", type: "FluxGuidance", inputs: { guidance: 3.5 } }],
  }, { list: LIST });
  assertEquals(rows, []); // FluxGuidance is not in the registry yet
});

Deno.test("valueDiffer: values that differ from the previous meta are marked", async () => {
  const { valueDiffer } = await import("../client-solid/store/fields.js");
  const differs = valueDiffer({
    nodes: [
      { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7 } },
      { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
    ],
  }, { list: LIST });
  assert(!differs("KSampler — seed", "7"), "same value is unchanged");
  assert(differs("KSampler — seed", "8"), "a changed value is marked");
  assert(!differs("KSampler — steps", "20"));
  assert(differs("KSampler — steps", "30"));
  assert(!differs("LoraLoaderModelOnly — strength_model", "0.8"));
  assert(differs("FluxGuidance — guidance", "3.5"), "a field the previous image lacked is marked");
  // no comparison target → nothing differs
  assert(!valueDiffer(null, { list: LIST })("KSampler — seed", "999"));
});

Deno.test("nodeImages: only LoadImage image inputs surface — SaveImage's filename_prefix is not an input file", async () => {
  const { nodeImages } = await import("../client-solid/store/fields.js");
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
  assert(imgs[0].src.includes("?kind=input"), "input ref uses input-bytes");
  // dedup: two LoadImage nodes on the same file render once
  const dup = nodeImages({ nodes: [
    { id: "1", type: "LoadImage", inputs: { image: "source.png" } },
    { id: "2", type: "LoadImage", inputs: { image: "source.png" } },
  ] }, "ark");
  assertEquals(dup.length, 1);
});

Deno.test("nodeImages: a LoadImage-from-output value is stripped of [output] and served from the output route", async () => {
  const { nodeImages } = await import("../client-solid/store/fields.js");
  const meta = {
    nodes: [
      { id: "9", type: "LoadImage", title: "Load Image", inputs: { image: "ark#ark#alisa_impl_00291__0.55_00001_.png [output]" } },
    ],
  };
  const imgs = nodeImages(meta, "ark");
  assertEquals(imgs.length, 1);
  assertEquals(imgs[0].file, "ark#ark#alisa_impl_00291__0.55_00001_.png");
  assertEquals(imgs[0].fromOutput, true);
  assert(imgs[0].src.includes("/api/collections/"), "output ref uses the feed bytes route");
  assert(!imgs[0].src.includes("[output]"), "annotation stripped from the URL");
});

// --- current-image tracking -------------------------------------------------

Deno.test("current: the replaced pointer goes onto the stack; pop walks it back", () => {
  const store = makeAppStore();
  const { assign, pop } = store.actions.current;

  // first pointer: nothing to push
  assign({ remote: "ark", image: "a.png" });
  assertEquals(store.state.current(), { remote: "ark", image: "a.png" });
  assertEquals(store.state.currentStack(), []);

  // a real change pushes the replaced pointer
  assign({ remote: "ark", image: "b.png" });
  assertEquals(store.state.currentStack(), [{ remote: "ark", image: "a.png" }]);

  // re-assigning the same target does not churn the stack
  assign({ remote: "ark", image: "b.png" });
  assertEquals(store.state.currentStack().length, 1);

  // a remote switch (image dropped) is still a change; clearing pushes too
  assign({ remote: "anton", image: null });
  assign(null);
  assertEquals(store.state.current(), null);
  assertEquals(store.state.currentStack().length, 3);
  assertEquals(store.state.currentStack().at(-1), { remote: "anton", image: null });

  // pop makes the latest previous current, consumes its entry, and does
  // not push the outgoing pointer
  assertEquals(pop(), { remote: "anton", image: null });
  assertEquals(store.state.current(), { remote: "anton", image: null });
  assertEquals(store.state.currentStack().length, 2);
  assertEquals(pop(), { remote: "ark", image: "b.png" });
  assertEquals(pop(), { remote: "ark", image: "a.png" });
  assertEquals(store.state.currentStack(), []);
  // empty trail: pop is a no-op
  assertEquals(pop(), null);
  assertEquals(store.state.current(), { remote: "ark", image: "a.png" });
});

Deno.test("current: the stack is a bounded window", () => {
  const store = makeAppStore();
  const { assign } = store.actions.current;
  assign({ remote: "ark", image: "seed.png" });
  for (let i = 0; i < 210; i++) assign({ remote: "ark", image: `img-${i}.png` });
  assertEquals(store.state.currentStack().length, 200);
  assertEquals(store.state.currentStack().at(-1), { remote: "ark", image: "img-208.png" });
});

Deno.test("current: push:false moves the pointer without touching the stack", () => {
  const store = makeAppStore();
  const { assign } = store.actions.current;
  assign({ remote: "ark", image: "before.png" });
  assign({ remote: "ark", image: "gone.png" }); // stack: [before]
  assign({ remote: "ark", image: "next.png" }, { push: false });
  assertEquals(store.state.current(), { remote: "ark", image: "next.png" });
  assertEquals(store.state.currentStack(), [{ remote: "ark", image: "before.png" }]);
});

// --- feed rail tape window ----------------------------------------------------

Deno.test("tapeWindow: whole view fits → tape is static", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(50, 100, 0, 20, 0), 0);
  assertEquals(tapeWindow(100, 100, 40, 60, 0), 0);
});

Deno.test("tapeWindow: wave mid-tape → tape holds (hysteresis)", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // capacity 100, view 1000, tape at 200, margin 25 → wave inside
  // [225, 275+... ] holds
  assertEquals(tapeWindow(1000, 100, 230, 240, 200), 200);
});

Deno.test("tapeWindow: wave at the right edge → tape re-centers on it", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // tape 0..99, margin 25 → wave ending past 75 triggers re-center:
  // center of [70,78] = 74, minus capacity/2 (50) = 24
  assertEquals(tapeWindow(1000, 100, 70, 78, 0), 24);
});

Deno.test("tapeWindow: wave at the left edge → tape re-centers, clamped at 0", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // tape 100..199, margin 25 → wave starting before 125 triggers re-center
  const next = tapeWindow(1000, 100, 100, 110, 100);
  assertEquals(next, 105 - 50); // center(105) - 50 = 55
});

Deno.test("tapeWindow: the tape clamps at the list end", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(300, 100, 280, 295, 150), 200); // maxStart = 200
});

Deno.test("tapeWindow: zero capacity is safe", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(1000, 0, 0, 0, 0), 0);
});

// --- images.fillSize ----------------------------------------------------------

Deno.test("images.fillSize: HEAD probe fills the byte size on the right entry", async () => {
  const { api } = await import("../client/js/api.mjs");
  // the store mirrors the pointer into the URL — stub the two browser
  // globals for this process (no DOM in the unit suite)
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  // fake the engine surface the store talks to (the module object is shared
  // — patched per test, restored after)
  const origEntries = api.entries;
  const origProbe = api.entrySizeProbe;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  api.entries = async () => [
    { name: "a.png", size: null, hash: null, state: "seen", meta: null, extracted: false, judgment: null, width: 100, height: 50 },
  ];
  api.entrySizeProbe = async (collection, name) => {
    assertEquals([collection, name], ["h", "a.png"]);
    return 12345;
  };
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  try {
    await store.actions.hosts.select("h");
    assertEquals(store.state.images.length, 1);
    assertEquals(store.state.images[0].size, null);
    await store.actions.images.fillSize("h:a.png");
    assertEquals(store.state.images[0].size, 12345);
    // a second call with a known size is a no-op (no probe fired)
    let probes = 0;
    api.entrySizeProbe = async () => { probes++; return 999; };
    await store.actions.images.fillSize("h:a.png");
    assertEquals(probes, 0);
    assertEquals(store.state.images[0].size, 12345);
  } finally {
    api.entries = origEntries;
    api.entrySizeProbe = origProbe;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- current-pointer visibility invariant -----------------------------------

Deno.test("current: a hidden current advances to the next visible entry (one guard, not per-action)", async () => {
  const { api } = await import("../client/js/api.mjs");
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  const origEntries = api.entries;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  const origSetJudgment = api.setJudgment;
  api.entries = async () => ["a.png", "b.png", "c.png", "d.png"].map((name) => ({
    name, size: 1, hash: null, state: "seen", meta: null, extracted: false, judgment: null, width: 100, height: 50,
  }));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.setJudgment = async () => ({});
  try {
    await store.actions.hosts.select("h");
    const img = (n) => store.state.images.find((i) => i.filename === n);

    // current on b.png; down-vote it (downvoteHides is on by default) →
    // the pointer advances to the NEXT visible entry
    store.actions.current.set("h", "b.png");
    await store.actions.judgments.setVote(img("b.png"), "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote the LAST visible entry → the pointer walks back to the previous
    store.actions.current.set("h", "d.png");
    await store.actions.judgments.setVote(img("d.png"), "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote a NON-current card → the pointer does not move
    await store.actions.judgments.setVote(img("a.png"), "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote the last visible one → nothing left → pointer clears
    await store.actions.judgments.setVote(img("c.png"), "down");
    assertEquals(store.state.current(), null);
  } finally {
    api.entries = origEntries;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    api.setJudgment = origSetJudgment;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- the src window on a sparse known list ---------------------------------

Deno.test("src window: a rendered card gets its src even when its image index is far from its feed position", async () => {
  const { api } = await import("../client/js/api.mjs");
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  const origEntries = api.entries;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  // 30 entries; dims known only for image indices 0, 25, 28 — a SPARSE
  // known list: image index ≠ feed position
  api.entries = async () => Array.from({ length: 30 }, (_, i) => ({
    name: `f${i}.png`, size: 1, hash: null, state: "seen", meta: null, extracted: false,
    judgment: null,
    width: [0, 25, 28].includes(i) ? 100 : null,
    height: [0, 25, 28].includes(i) ? 50 : null,
  }));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  try {
    await store.actions.hosts.select("h");
    assertEquals(store.state.entriesWithKnownSize(), [0, 25, 28]);
    assertEquals(store.state.feedPositionOf("h:f28.png"), 2);
    // the rendered window covers feed positions 1..2; its bounds pad to
    // [0, 12] in FEED POSITIONS — a membership check in image indices would
    // wrongly exclude image index 28 (> 12)
    store.actions.feed.register({
      virtualizer: {
        getVirtualItems: () => [
          { index: 1, start: 0, end: 100, key: "h:f25.png" },
          { index: 2, start: 100, end: 200, key: "h:f28.png" },
        ],
      },
      scrollEl: null,
    });
    const img = store.state.images[28];
    const src = store.state.window.getSrc(store.state.feedPositionOf(img.id), img);
    assert(src && src.includes(encodeURIComponent("f28.png")), `rendered card must get its src, got ${src}`);
  } finally {
    api.entries = origEntries;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- the drag primitive's anchor-edge fraction -------------------------------

Deno.test("fracFor: the fraction measures from the sized column's anchor edge", async () => {
  const { fracFor } = await import("../client-solid/lib/drag.js");
  const box = { left: 100, right: 500, top: 50, bottom: 250, width: 400, height: 200 };
  // anchored left ("x"): pointer at the right quarter of the box
  assertEquals(fracFor(box, { clientX: 200 }, "x"), 0.25);
  // anchored right ("x-" — a rev layout): the same pointer is 0.75 from the right
  assertEquals(fracFor(box, { clientX: 200 }, "x-"), 0.75);
  // anchored top ("y") and bottom ("y-")
  assertEquals(fracFor(box, { clientY: 100 }, "y"), 0.25);
  assertEquals(fracFor(box, { clientY: 100 }, "y-"), 0.75);
  // a snapped pane rect (the sized element's own box, not the container's)
  const pane = { left: 300, right: 500, top: 0, bottom: 200, width: 200, height: 200 };
  assertEquals(fracFor(pane, { clientX: 400 }, "x-"), 0.5);
});

// --- deletion navigation ------------------------------------------------------

Deno.test("planDeleteCurrent: previous current iff adjacent, else feed-above, else topmost", async () => {
  const { planDeleteCurrent } = await import("../client/js/route-parse.mjs");
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
