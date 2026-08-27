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
    assert(rows.some(([l, v]) => l === "Load LoRA — lora_name" && v === "a.safetensors"), "lora name row");
    assert(rows.some(([l, v]) => l === "Load LoRA — lora_name" && v === "b.safetensors"), "second lora name row");
    assert(rows.some(([l, v]) => l === "Load LoRA — strength_model" && v === "0.8"));
    assert(rows.some(([l, v]) => l === "Load LoRA — strength_model" && v === "0.5"));
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
    assertEquals(strip, "KSampler — seed 7 · KSampler — steps 20 · Load LoRA — lora_name a.safetensors");
  } finally {
    state.nodesRegistry = prevReg;
    state.fieldsCfg = prevCfg;
  }
});
