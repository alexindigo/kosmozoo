import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert";
import { IDENTITY_VIEW, readZoomView, zoomViewPixels, zoomViewTransform } from "../client/js/zoom-view.mjs";
import { mediaGeometry, mediaViewRect } from "../client-solid/store/media-geometry.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { makeZoomable } from "../client/js/zoomable.mjs";
import { api } from "../client/js/api.mjs";

Deno.test("zoom views: crop round-trips across fit, padding, natural cap and viewer allocations", () => {
  const crop = { ...IDENTITY_VIEW, s: 3, cx: .38, cy: .67 };
  for (const size of [{ w: 128, h: 64 }, { w: 2048, h: 512 }, { w: 640, h: 1024 }]) {
    for (const [width, height, surface] of [[720, 600, "card"], [233, 600, "card"], [1400, 914, "viewer"], [700, 914, "viewer"]]) {
      const g = mediaGeometry({ width, height, size, surface });
      const p = zoomViewPixels(crop, g);
      assertAlmostEquals(.5 - p.tx / (p.s * g.mediaWidth), crop.cx);
      assertAlmostEquals(.5 - p.ty / (p.s * g.mediaHeight), crop.cy);
      const legacy = { s: p.s, txf: p.tx / g.width, tyf: p.ty / g.height };
      const converted = readZoomView(legacy, g);
      assertAlmostEquals(converted.cx, crop.cx);
      assertAlmostEquals(converted.cy, crop.cy);
      const r = mediaViewRect(size, crop, width, height);
      // Canvas destination observes the same crop, independent of native CSS.
      assertAlmostEquals((width / 2 - r.dx) / r.dw, crop.cx);
      assertAlmostEquals((height / 2 - r.dy) / r.dh, crop.cy);
    }
  }
});

Deno.test("zoom views: pending geometry cannot interpret a legacy crop or produce a transform", () => {
  const old = { s: 2, txf: .1, tyf: -.2 }, g = { width: 400, height: 225, mediaWidth: 128, mediaHeight: 64 };
  for (const field of Object.keys(g)) {
    for (const invalid of [0, NaN, -1, Infinity]) {
      assertEquals(readZoomView(old, { ...g, [field]: invalid }), null);
      assertEquals(zoomViewTransform(old, { ...g, [field]: invalid }), "");
    }
  }
  const converted = readZoomView(old, g);
  assertAlmostEquals(converted.cx, .34375);
  assertAlmostEquals(converted.cy, .8515625);
  assertEquals(zoomViewPixels(converted, g), { s: 2, tx: 40, ty: -45 });
  assertEquals(readZoomView({ version: 2, s: NaN, cx: Infinity, cy: NaN }), IDENTITY_VIEW);
});

Deno.test("zoom views: both owning ports convert once in the first valid fit, never reinterpret on resize", async () => {
  const saved = api.setSettings, patches = [];
  api.setSettings = async (ns, patch) => { patches.push([ns, JSON.parse(JSON.stringify(patch))]); };
  const store = makeAppStore({ subscribeSources: null });
  const g = mediaGeometry({ width: 400, size: { w: 128, h: 64 } });
  const resized = mediaGeometry({ width: 700, size: { w: 128, h: 64 } });
  try {
    for (const port of [store.actions.views, store.actions.diff.views]) {
      const legacy = { s: 2, txf: .1, tyf: -.2 };
      port.set("input:fake:shared", legacy, { persist: false });
      assertEquals(port.get("input:fake:shared", { ...g, height: 0 }), legacy);
      const crop = JSON.parse(JSON.stringify(port.get("input:fake:shared", g)));
      assertEquals(crop.version, 2);
      assert(!Object.hasOwn(crop, "txf"), "replacement removes the old frame-dependent fields");
      assertEquals(port.get("input:fake:shared", resized), crop);
      assertEquals(port.get("input:fake:shared"), crop);
    }
    await new Promise(r => setTimeout(r, 450));
    assertEquals(patches.length, 1, "only persisted owner migrates; resize and viewer produce no settings writes");
    assertEquals(patches[0][0], "core.views");
    assertEquals(patches[0][1]["input:fake:shared"].version, 2);
  } finally { store.dispose(); api.setSettings = saved; }
});

Deno.test("zoom gestures: unchanged wheel/pan deltas, distinct-peer entanglement and disposal fencing", () => {
  const handlers = new Map(), views = new Map();
  const el = { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), setPointerCapture() {} };
  const box = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 225 }) };
  const g = { width: 400, height: 225, mediaWidth: 128, mediaHeight: 64 };
  let geometry = g, writes = 0;
  const binding = makeZoomable(el, { target: () => ({ key: "a", box, geometry: () => geometry }),
    also: () => ({ key: "b", geometry: g }), panAlways: true,
    getView: k => views.get(k), setView: (k, v) => { views.set(k, v); writes++; } });
  const event = { ctrlKey: true, preventDefault() {}, stopPropagation() {}, clientX: 240, clientY: 90, deltaY: -40, pointerId: 1 };
  geometry = { ...g, height: 0 }; handlers.get("wheel")(event);
  assertEquals(writes, 0);
  geometry = g; handlers.get("wheel")(event);
  const p = zoomViewPixels(views.get("a"), g), s = Math.exp(.48);
  assertAlmostEquals(p.s, s);
  assertAlmostEquals(p.tx, (1-s)*40);
  assertAlmostEquals(p.ty, (1-s)*-22.5);
  assertEquals(views.get("a"), views.get("b"));
  handlers.get("pointerdown")(event);
  handlers.get("pointermove")({ clientX: 270, clientY: 108 });
  const pan = zoomViewPixels(views.get("a"), g);
  assertAlmostEquals(pan.tx-p.tx, 30/s);
  assertAlmostEquals(pan.ty-p.ty, 18/s);
  binding.dispose();
  assertEquals(handlers.size, 0, "retiring a binding retires its active drag listeners too");
});

Deno.test("zoom gestures: injected allocation owns wheel; native media retains pan/click lifetime", () => {
  const wheel = new Map(), native = new Map();
  const node = handlers => ({ addEventListener: (n, fn) => handlers.set(n, fn), removeEventListener: n => handlers.delete(n), setPointerCapture() {} });
  const el = node(native), surface = node(wheel);
  const box = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600 }) };
  const geometry = { width: 1000, height: 600, mediaWidth: 400, mediaHeight: 240 };
  let crop;
  const binding = makeZoomable(el, { surface, box, geometry, key: 'card', getView: () => crop, setView: (_, v) => { crop = v; } });
  assertEquals([...wheel.keys()], ['wheel']);
  assertEquals([...native.keys()], ['pointerdown', 'click']);
  wheel.get('wheel')({ ctrlKey: true, deltaY: -20, clientX: 14, clientY: 24, preventDefault() {} });
  assertAlmostEquals(crop.s, Math.exp(.24));
  assert(crop.cx < .5 && crop.cy < .5, 'letterbox cursor uses the explicitly supplied fitted frame');
  binding.dispose();
  assertEquals(wheel.size + native.size, 0);
});
