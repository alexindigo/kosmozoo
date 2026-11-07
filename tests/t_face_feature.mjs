import { assert, assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { makeZoomable } from "../client/js/zoomable.mjs";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { facePresentation } from "../client-solid/features/face-alignment/presentation.mjs";
import { resource } from "./helpers/face-fixtures.mjs";

Deno.test("face presentation: known content remains immutable while its detection record is pending", () => {
  const hash = "a".repeat(64), nextHash = "b".repeat(64);
  for (const source of ["fake", "input:fake"]) {
    const current = { ...resource("same.png", source), hash };
    const accepted = facePresentation(current, { id: "old-record", image: { hash } }, true);
    const pending = facePresentation({ ...current, hash: nextHash }, null, true);
    assertEquals(pending.src, `/api/content/${nextHash}/bytes`, "known replacement never requests a cached named URL");
    assertEquals(pending.hash, nextHash); assertEquals(pending.resource.hash, nextHash);
    assertEquals(pending.recordId, undefined, "pending detection cannot claim a face result");
    assertEquals(pending.resource.kind, current.kind);
    assertEquals(accepted.src, `/api/content/${hash}/bytes`); assertEquals(accepted.recordId, "old-record");
    const mismatched = facePresentation({ ...current, hash: nextHash }, { id: "old-record", image: { hash } }, true);
    assertEquals(mismatched.src, pending.src); assertEquals(mismatched.recordId, undefined, "old ML record cannot retarget current known content");
    const off = facePresentation(current, { id: "old-record", image: { hash } }, false);
    assertEquals(off.src, current.src); assertEquals(off.hash, undefined, "OFF does not claim named pixels are hash-verified");
  }
});

Deno.test("face presentation: unknown engine content and local anchor bytes keep honest initial paths", () => {
  const initial = resource(), hash = "c".repeat(64);
  assertEquals(facePresentation(initial, null, true), { ...initial, resource: initial, hash: undefined });
  const upgraded = facePresentation(initial, { id: "result", image: { hash } }, true);
  assertEquals(upgraded.src, `/api/content/${hash}/bytes`); assertEquals(upgraded.hash, hash);
  const anchor = { ...resource("local.png", "anchor"), src: "data:image/png;base64,AA==" };
  assertEquals(facePresentation(anchor, null, true).src, anchor.src);
  const knownAnchor = facePresentation({ ...anchor, hash }, null, true);
  assertEquals(knownAnchor.src, anchor.src); assertEquals(knownAnchor.hash, hash);
});

Deno.test("comparison resources: accepted inventory content changes retire same-name requests", async () => {
  const saved = { ...api };
  let hash = "a".repeat(64);
  api.collections = async () => ({ fake: { address: "fake:1", kind: "comfy", online: true } });
  api.inventory = async () => clientInventory([{ name: "same.png", width: 512, height: 512, hash }]);
  api.meta = async () => ({ v: 1, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = api.settings = api.setSettings = async () => ({}); api.prefetch = async () => ({ pending: {} });
  const store = makeAppStore({ subscribeSources: null });
  try {
    await store.actions.boot();
    const first = store.actions.diff.resolve({ source: "fake", file: "same.png" });
    assertEquals(first.hash, hash);
    hash = "b".repeat(64); await store.actions.ui.refresh();
    const next = store.actions.diff.resolve({ source: "fake", file: "same.png" });
    assertEquals(next.hash, hash); assertEquals(first.name, next.name);
    assertEquals(store.actions.diff.resolve({ source: "input:fake", file: "same.png" }).hash, undefined, "same-name output cannot supply an input hash");
  } finally { store.dispose(); Object.assign(api, saved); }
});

Deno.test("comparison seam: exclusive installed alignment and token-owned accepted display", () => {
  const store = makeAppStore({ subscribeSources: null });
  let comparison;
  try {
    store.actions.features.register({ name: "proof", install: input => {
      comparison = input.comparison;
      return { alignmentModes: ["face"], ports: {}, comparison: { resource: () => null } };
    } });
    assertEquals(store.handles.invoke("workbench.alignment", { mode: "unknown" }), false);
    assert(store.handles.invoke("workbench.alignment", { mode: "face" }));
    assertEquals(store.state.diff.locked, false);
    store.handles.invoke("workbench.lock", { value: true });
    assertEquals(store.state.diff.alignment, "shared");
    store.handles.invoke("workbench.lock", { value: false });
    assertEquals(store.state.diff.alignment, "independent");
    const retire = store.actions.diff.registerDisplay(() => ({ a: { hash: "old" } }));
    const current = store.actions.diff.registerDisplay(() => ({ a: { hash: "new" } }));
    retire(); assertEquals(comparison.accepted().a.hash, "new");
    current(); assertEquals(comparison.accepted(), {});
  } finally { store.dispose(); }
});

Deno.test("gesture owner: resolved camera port bypasses raw crops; trusted activation rejects pan", () => {
  const handlers = new Map(), moves = [], choices = [];
  const el = { addEventListener: (k, fn) => handlers.set(k, fn), removeEventListener: k => handlers.delete(k), setPointerCapture() {} };
  const g = { width: 400, height: 300, mediaWidth: 200, mediaHeight: 200 };
  const binding = makeZoomable(el, { panAlways: true, target: () => ({ key: "a", geometry: g,
    box: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 300 }) },
    interaction: { pan: (...args) => moves.push(args), zoom: (...args) => moves.push(args) } }),
    getView: () => { throw new Error("raw crop read in registered gesture"); },
    setView: () => { throw new Error("derived registration persisted"); }, onActivate: e => choices.push(e) });
  const event = { ctrlKey: true, deltaY: -10, clientX: 200, clientY: 150, pointerId: 1, preventDefault() {}, stopPropagation() {} };
  try {
    handlers.get("wheel")(event); assertEquals(moves[0].slice(0, 2), [190, 130]);
    for (const detail of [1, 2]) {
      handlers.get("pointerdown")(event); handlers.get("pointerup")();
      handlers.get("click")({ ...event, detail });
    }
    handlers.get("dblclick")({ ...event, isTrusted: true }); assertEquals(choices.length, 1);
    handlers.get("pointerdown")(event);
    handlers.get("pointermove")({ clientX: 230, clientY: 170 });
    assertEquals(moves[1], [30, 20]);
    handlers.get("pointerup")();
    handlers.get("dblclick")({ ...event, isTrusted: true }); assertEquals(choices.length, 1);
  } finally { binding.dispose(); }
  assertEquals(handlers.size, 0);
});

Deno.test("gesture activation: dragged sequences retire, fresh clicks need no cooldown, accepted generations cannot mix", () => {
  const handlers = new Map(); let activations = 0, generation = "frame-1";
  const el = { addEventListener: (k, fn) => handlers.set(k, fn), removeEventListener: k => handlers.delete(k), setPointerCapture() {} };
  const g = { width: 400, height: 300, mediaWidth: 200, mediaHeight: 200 };
  const binding = makeZoomable(el, { panAlways: true, target: () => ({ key: "image", activationKey: generation, geometry: g,
    box: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }) }, interaction: { pan() {}, zoom() {} } }),
    onActivate: () => activations++ });
  const event = { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
  const click = (detail, move = 0) => {
    handlers.get("pointerdown")(event);
    if (move) handlers.get("pointermove")({ clientX: 100 + move, clientY: 100 });
    handlers.get("pointerup")(); handlers.get("click")({ ...event, detail });
    if (detail === 2) handlers.get("dblclick")({ ...event, isTrusted: true });
  };
  try {
    click(1); click(2, 20); assertEquals(activations, 0, "a dragged click cannot complete activation");
    click(1); click(2); assertEquals(activations, 1, "a fresh intentional double-click is immediately available");
    click(1); generation = "frame-2"; click(2);
    assertEquals(activations, 1, "one click on each accepted frame is not a double-click on either");
  } finally { binding.dispose(); }
});
