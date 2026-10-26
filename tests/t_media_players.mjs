import { assert, assertEquals } from "jsr:@std/assert";
import { makeMediaPlayers } from "../client-solid/store/media-players.js";
import { makeSizes } from "../client-solid/store/sizes.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { CORE_BINDINGS } from "../client-solid/store/key-bindings.js";
import { api } from "../client/js/api.mjs";

Deno.test("players: focus/primary routing, exclusive native start and owner retirement", () => {
  let workbench = false;
  const owner = makeMediaPlayers({ workbenchOpen: () => workbench });
  const player = overrides => ({ available: () => true, focused: () => false, primary: () => false,
    workbench: false, pauses: 0, toggles: 0, pause() { this.pauses++; }, toggle() { this.toggles++; return true; }, ...overrides });
  const a = player({ focused: () => true }), b = player({ workbench: true, primary: () => true });
  const ra = owner.register(a), rb = owner.register(b);
  assert(owner.toggle()); assertEquals(a.toggles, 1); assertEquals(b.toggles, 0);
  rb.started(); assertEquals(a.pauses, 1);
  workbench = true; assert(owner.toggle()); assertEquals(b.toggles, 1);
  b.available = () => false; rb.started();
  assertEquals(b.pauses, 1); assertEquals(a.pauses, 1, "late unavailable play events cannot pause a valid peer");
  ra.dispose(); assertEquals(a.pauses, 2);
  ra.started(); assertEquals(a.pauses, 3, "retired callbacks cannot acquire playback");
  rb.dispose(); assertEquals(owner.toggle(), false); owner.dispose();
});

Deno.test("media shortcut: Space consumes without scrolling, rebinds, typing/modal guards win", () => {
  const saved = api.setSettings; api.setSettings = async () => ({});
  const store = makeAppStore({ subscribeSources: null });
  let toggles = 0;
  const registration = store.actions.media.register({ workbench: false, available: () => true,
    focused: () => true, primary: () => false, pause() {}, toggle() { toggles++; return true; } });
  const event = (key, typing = false) => ({ key, target: { matches: () => typing },
    prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  try {
    for (const binding of CORE_BINDINGS) store.actions.keys.register(binding);
    const space = event(" "); store.actions.keys.dispatch(space); assert(space.prevented); assertEquals(toggles, 1);
    store.actions.keys.dispatch(event(" ", true)); assertEquals(toggles, 1);
    store.actions.keys.togglePanel(); store.actions.keys.dispatch(event(" ")); assertEquals(toggles, 1);
    store.actions.keys.closePanel();
    store.actions.keys.startCapture("media.toggle"); store.actions.keys.captureEvent(event("p"));
    store.actions.keys.dispatch(event(" ")); assertEquals(toggles, 1);
    store.actions.keys.dispatch(event("p")); assertEquals(toggles, 2);
    store.actions.media.toggle(); assertEquals(toggles, 3, "the compatibility port delegates to the same semantic handle");
  } finally { registration.dispose(); store.actions.status.clear("transient"); store.dispose(); api.setSettings = saved; }
});

Deno.test("video measurement uses the retained six-slot owner and retires native video loads", () => {
  const saved = { document: globalThis.document, Image: globalThis.Image };
  const made = [];
  globalThis.Image = class {};
  globalThis.document = { createElement(tag) {
    assertEquals(tag, "video");
    const el = { tagName: "VIDEO", videoWidth: 320, videoHeight: 180, pauses: 0, loads: 0,
      pause() { this.pauses++; }, load() { this.loads++; }, removeAttribute() { this.src = null; } };
    made.push(el); return el;
  } };
  const entries = Array.from({ length: 8 }, (_, i) => ({ id: String(i), filename: `${i}.webm` }));
  const sizes = makeSizes({ srcFor: id => `/${id}`, imageAt: i => entries[i], entryFor: id => entries[Number(id)] });
  try {
    sizes.resolveAhead(entries.map((_, i) => i), 0, 7);
    assertEquals(made.length, 6); assert(made.every(el => el.preload === "metadata"));
    const stale = made[1].onloadedmetadata;
    made[0].onloadedmetadata(); assertEquals(made.length, 7);
    assertEquals(sizes.sizeFor(entries[0]), { w: 320, h: 180 });
    assertEquals(made[0].src, null); assertEquals(made[0].pauses, 1); assertEquals(made[0].loads, 1);
    sizes.setContext({}); stale(); assertEquals(sizes.sizeOf("1"), null);
    assert(made.every(el => !el.src && el.onloadedmetadata === null));
  } finally {
    sizes.dispose();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
  }
});
