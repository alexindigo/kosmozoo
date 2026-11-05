import { assertEquals } from "jsr:@std/assert";
import { createRoot } from "solid-js";
import { makeAppStore } from "../client-solid/store/app-store.js";

function page(scale) {
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      emit(type) { for (const callback of listeners.get(type) ?? []) callback(); },
      count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
    };
  };
  return Object.assign(target(), { visualViewport: Object.assign(target(), { scale, offsetLeft: 0, offsetTop: 0, width: 900, height: 600 }) });
}

Deno.test("native magnification reaches Store state; replacement and disposal retire observation", () => {
  let cleanup;
  const store = createRoot(dispose => { cleanup = dispose; return makeAppStore({ subscribeSources: null, storage: null }); });
  const first = page(1.5), replacement = page(1);
  try {
    const retire = store.actions.lifecycle.registerPage(first);
    assertEquals(store.state.nativeMagnification(), true, "already-magnified registration publishes immediately");
    assertEquals(store.state.nativeViewport(), { magnified: true, rect: { left: 0, top: 0, width: 900, height: 600 } });
    const late = [...first.visualViewport.listeners.get("resize"), ...first.visualViewport.listeners.get("scroll")];
    const lateShow = [...first.listeners.get("pageshow")];
    store.actions.lifecycle.registerPage(replacement);
    assertEquals(store.state.nativeMagnification(), false, "inactive initial sample resets prior registration");
    assertEquals(store.state.nativeViewport().rect, { left: 0, top: 0, width: 900, height: 600 });
    assertEquals(first.count() + first.visualViewport.count(), 0);
    for (const callback of [...late, ...lateShow]) callback();
    retire(); retire();
    assertEquals(store.state.nativeMagnification(), false, "retained callbacks cannot republish or retire replacement");
    replacement.visualViewport.scale = 2;
    replacement.emit("pageshow");
    assertEquals(store.state.nativeMagnification(), true);
    replacement.visualViewport.offsetLeft = 30;
    replacement.visualViewport.offsetTop = 40;
    replacement.visualViewport.emit("scroll");
    assertEquals(store.state.nativeViewport(), { magnified: true, rect: { left: 30, top: 40, width: 900, height: 600 } });
    replacement.visualViewport.scale = 1;
    replacement.visualViewport.emit("resize");
    assertEquals(store.state.nativeMagnification(), false);
    const afterDisposal = [...replacement.visualViewport.listeners.get("resize"), ...replacement.visualViewport.listeners.get("scroll")];
    store.dispose(); store.dispose();
    replacement.visualViewport.scale = 2;
    for (const callback of afterDisposal) callback();
    replacement.emit("pageshow");
    assertEquals(replacement.count() + replacement.visualViewport.count(), 0);
    store.actions.lifecycle.registerPage(first);
    assertEquals(first.count() + first.visualViewport.count(), 0, "disposed Store cannot register observation again");
    assertEquals(store.state.nativeMagnification(), false);
  } finally { store.dispose(); cleanup(); }
});

Deno.test("native observer publishes coherent scale/rectangle changes and fences all retired listeners", async () => {
  const { observeNativeMagnification } = await import("../client-solid/lib/native-magnification.js");
  const target = page(1), values = [];
  const dispose = observeNativeMagnification(target, value => values.push(value));
  const rect = { left: 0, top: 0, width: 900, height: 600 };
  const snapshot = (magnified, rectangle = rect) => ({ magnified, rect: rectangle });
  assertEquals(values, [snapshot(false)], "even an inactive initial sample must publish");
  target.visualViewport.emit("resize"); target.visualViewport.emit("scroll"); target.emit("pageshow");
  for (const scale of [1.01, 2, 1.5, Infinity, NaN, "2", undefined, 0.5, 1, 3]) {
    target.visualViewport.scale = scale; target.visualViewport.emit("resize");
  }
  assertEquals(values, [snapshot(false), snapshot(true), snapshot(false), snapshot(true)]);
  Object.assign(target.visualViewport, { offsetLeft: 120, offsetTop: 70, width: 450, height: 300 });
  target.visualViewport.emit("scroll");
  const panned = { left: 120, top: 70, width: 450, height: 300 };
  assertEquals(values.at(-1), snapshot(true, panned), "scroll publishes flag and entire current rectangle atomically");
  const count = values.length;
  target.visualViewport.emit("resize"); target.visualViewport.emit("scroll"); target.emit("pageshow");
  assertEquals(values.length, count, "all unchanged event kinds deduplicate");
  target.visualViewport.scale = 1;
  target.emit("pageshow");
  assertEquals(values.at(-1), snapshot(false, panned));
  target.visualViewport.width = 500;
  target.emit("pageshow");
  assertEquals(values.at(-1), snapshot(false, { ...panned, width: 500 }), "restoration updates inactive geometry too");
  const beforeDispose = values.slice();
  const retained = [...target.visualViewport.listeners.get("resize"), ...target.visualViewport.listeners.get("scroll"), ...target.listeners.get("pageshow")];
  dispose(); dispose(); target.visualViewport.scale = 2;
  for (const callback of retained) callback();
  assertEquals(values, beforeDispose);
  assertEquals(target.count() + target.visualViewport.count(), 0);
  for (const missing of [undefined, new EventTarget()]) {
    const samples = [], stop = observeNativeMagnification(missing, value => samples.push(value));
    assertEquals(samples, [snapshot(false, null)]); stop(); stop();
  }
});
