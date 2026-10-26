import { assert, assertEquals } from "jsr:@std/assert";
import { makeSizes, ERROR_RETRY_MS } from "../client-solid/store/sizes.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { createRoot } from "solid-js";

function measurementEnv() {
  const original = { Image: globalThis.Image, setTimeout, clearTimeout };
  const timers = new Map(), made = [];
  let now = 0, serial = 0;
  globalThis.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  globalThis.Image = class {
    constructor() { this.naturalWidth = 640; this.naturalHeight = 360; made.push(this); }
    removeAttribute() { this.src = undefined; }
  };
  return {
    made, timers,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
    restore() {
      globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout;
      if (original.Image === undefined) delete globalThis.Image; else globalThis.Image = original.Image;
    },
  };
}

Deno.test("size failure: one delayed retry becomes a known square, never a dropped entry", () => {
  const env = measurementEnv(), entry = { id: "broken" };
  const sizes = makeSizes({ srcFor: () => "/broken.png", imageAt: () => entry });
  try {
    sizes.resolveAhead([0], 0, 0);
    env.made[0].onerror();
    sizes.resolveAhead([0], 0, 0);
    assertEquals(env.made.length, 1, "reconciliation cannot bypass the retry deadline");
    env.advance(ERROR_RETRY_MS);
    assertEquals(env.made.length, 2, "retained work retries even without a rendered feed");
    env.made[1].onerror();
    assertEquals(sizes.sizeOf(entry.id), { w: 1024, h: 1024 });
    assertEquals(sizes.loadFailed(entry.id), true);
    env.advance(ERROR_RETRY_MS * 3);
    sizes.resolveAhead([0], 0, 0);
    assertEquals(env.made.length, 2, "failure is terminal for this content/context");
  } finally { sizes.dispose(); env.restore(); }
});

Deno.test("size failure: hung loads release capacity, drain queued entries and terminate", () => {
  const env = measurementEnv();
  const entries = Array.from({ length: 10 }, (_, i) => ({ id: `hung-${i}` }));
  const sizes = makeSizes({ srcFor: id => `/bytes/${id}`, imageAt: i => entries[i] });
  try {
    sizes.resolveAhead(entries.map((_, i) => i), 0, 9);
    assertEquals(env.made.length, 6);
    env.advance(180000);
    assertEquals(entries.map(e => sizes.sizeOf(e.id)), entries.map(() => ({ w: 1024, h: 1024 })));
    assertEquals(env.made.length, 20, "each hung entry attempts exactly twice");
    assertEquals(env.timers.size, 0, "terminal work retains no native loads or deadlines");
    assert(env.made.every(image => image.onload === null && image.onerror === null && !image.src));
  } finally { sizes.dispose(); env.restore(); }
});

Deno.test("size failure: zero dimensions are a failure, retry success preserves real dimensions", () => {
  const env = measurementEnv(), entry = { id: "zero" };
  const sizes = makeSizes({ srcFor: () => "/zero.png", imageAt: () => entry });
  try {
    sizes.resolveAhead([0], 0, 0);
    env.made[0].naturalWidth = 0; env.made[0].onload();
    assertEquals(sizes.sizeOf(entry.id), null);
    env.advance(ERROR_RETRY_MS);
    assertEquals(env.made.length, 2);
    env.made[1].onload();
    assertEquals(sizes.sizeOf(entry.id), { w: 640, h: 360 });
    assertEquals(sizes.loadFailed(entry.id), false);
  } finally { sizes.dispose(); env.restore(); }
});

Deno.test("size failure: retirement cancels queued retries/deadlines and fences stale callbacks", () => {
  const env = measurementEnv(), entries = [{ id: "a", hash: "old" }, { id: "b", hash: "old" }];
  const sizes = makeSizes({ srcFor: id => `/bytes/${id}`, imageAt: i => entries[i],
    identityFor: id => entries.find(e => e.id === id)?.hash });
  try {
    sizes.setContext({}); sizes.resolveAhead([0, 1], 0, 1);
    const stale = env.made[0].onload;
    env.made[1].onerror();
    sizes.setContext({});
    env.advance(180000); stale();
    assertEquals(env.made.length, 2);
    assertEquals(sizes.sizeOf("a"), null);
    assertEquals(env.timers.size, 0);
    sizes.resolveAhead([0, 1], 0, 1);
    env.made[2].onerror(); env.advance(ERROR_RETRY_MS); env.made.at(-1).onerror();
    assertEquals(sizes.sizeOf("a"), { w: 1024, h: 1024 });
    entries[0].hash = "new";
    assertEquals(sizes.sizeOf("a"), null, "fallback cannot cross content identity");
    sizes.resolveAhead([0], 0, 0);
    env.made.at(-1).onload();
    assertEquals(sizes.sizeOf("a"), { w: 640, h: 360 });
  } finally { sizes.dispose(); assertEquals(env.timers.size, 0); env.restore(); }
});

Deno.test("size failure: authoritative dimensions arriving during measurement cannot become a fallback resize", () => {
  const env = measurementEnv(), entry = { id: "late-dims", width: null, height: null };
  const sizes = makeSizes({ srcFor: () => "/late.png", imageAt: () => entry, entryFor: () => entry });
  try {
    sizes.resolveAhead([0], 0, 0);
    entry.width = 300; entry.height = 100;
    assertEquals(sizes.sizeFor(entry), { w: 300, h: 100 }, "metadata can make the card render-ready before the native event");
    env.made[0].onerror();
    env.advance(180000);
    assertEquals(sizes.sizeFor(entry), { w: 300, h: 100 }, "a late measurement error cannot resize an already known-size card");
    assertEquals(sizes.loadFailed(entry.id), false);
    assertEquals(env.made.length, 1, "known dimensions need no measurement retry");
    assertEquals(env.timers.size, 0);
  } finally { sizes.dispose(); env.restore(); }
});

Deno.test("size identity: first hash enriches an active measurement; changed known content retires it", () => {
  const env = measurementEnv(), entry = { id: "enriched", hash: "" };
  const sizes = makeSizes({ srcFor: () => "/enriched.png", imageAt: () => entry, identityFor: () => entry.hash });
  try {
    sizes.resolveAhead([0], 0, 0);
    entry.hash = "first-hash";
    env.made[0].onload();
    assertEquals(sizes.sizeOf(entry.id), { w: 640, h: 360 }, "hash enrichment cannot strand an active callback");
    entry.hash = "replacement-hash";
    assertEquals(sizes.sizeOf(entry.id), null);
    sizes.resolveAhead([0], 0, 0);
    assertEquals(env.made.length, 2, "known replacement starts its own measurement");
  } finally { sizes.dispose(); env.restore(); }
});

Deno.test("feed failure contract: known + pending partitions the view and terminal cards retain square geometry", async () => {
  const env = measurementEnv(), saved = { ...api };
  const location = globalThis.location, history = globalThis.history;
  globalThis.location = { pathname: "/", search: "", hash: "" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const rows = [
    { name: "broken.png", width: null, height: null },
    { name: "good.png", width: 640, height: 360 },
  ].map(e => ({ size: 100, hash: null, meta: null, judgment: null, extracted: false, ...e }));
  api.collections = async () => ({ h: { address: "mock:1", kind: "comfy", online: true } });
  api.inventory = async () => clientInventory(structuredClone(rows));
  api.meta = async () => ({ changed: false, pending: 0 });
  api.want = async () => ({ pending: 0 }); api.nodes = async () => ({});
  const store = makeAppStore({ subscribeSources: null });
  try {
    await store.actions.hosts.refresh();
    await store.actions.hosts.select("h");
    assertEquals(store.state.entriesWithKnownSize(), [1]);
    assertEquals(store.state.pendingSizeCount(), 1);
    env.made[0].onerror(); env.advance(ERROR_RETRY_MS);
    assertEquals(env.made.length, 2);
    env.made[1].onerror();
    assertEquals(store.state.cardSize(0), { w: 1024, h: 1024 });
    assertEquals(store.state.entriesWithKnownSize(), [0, 1]);
    assertEquals(store.state.pendingSizeCount(), 0);
    assertEquals(store.state.entriesWithKnownSize().length + store.state.pendingSizeCount(), store.state.view().length);
    rows[0].width = 300; rows[0].height = 100; rows[0].hash = "first-known-hash";
    await store.actions.ui.refresh();
    assertEquals(store.state.images[0].hash, "first-known-hash", "the actual inventory enrichment was accepted");
    assertEquals(store.state.cardSize(0), { w: 1024, h: 1024 }, "late dims cannot resize a mounted failure card");
  } finally {
    store.dispose(); store.actions.status.clear("transient"); Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
    env.restore();
  }
});

Deno.test("feed failure contract: all-pending feed with remembered null current bootstraps without virtual items", async () => {
  const env = measurementEnv(), saved = { ...api };
  const location = globalThis.location, history = globalThis.history;
  globalThis.location = { pathname: "/", search: "", hash: "" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const storage = { getItem: key => key === "kosmozoo.sourceBrowse.v1"
    ? JSON.stringify({ version: 1, hosts: { h: { address: "mock:1", folder: "", current: null } } }) : null,
    setItem() {} };
  api.collections = async () => ({ h: { address: "mock:1", kind: "comfy", online: true } });
  api.inventory = async () => clientInventory(["a.png", "b.png"].map(name => ({
    name, size: 10, hash: "same", width: null, height: null, meta: null, judgment: null, extracted: false,
  })));
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = api.settings = api.prefetch = async () => ({});
  let dispose;
  const store = createRoot(cleanup => { dispose = cleanup; return makeAppStore({ subscribeSources: null, storage }); });
  try {
    await store.actions.boot();
    assertEquals(store.state.current(), null);
    assertEquals(env.made.length, 0, "no measurement before viewport readiness");
    store.actions.feed.register({ scrollEl: { clientWidth: 600, clientHeight: 800, scrollTop: 0 },
      viewport: () => ({ ready: true, width: 600, height: 800, items: [] }),
      virtualizer: { getVirtualItems: () => [], scrollToIndex() {} } });
    assertEquals(env.made.length, 2);
    for (const image of env.made.slice()) image.onerror();
    env.advance(ERROR_RETRY_MS);
    for (const image of env.made.slice(2)) image.onerror();
    assertEquals(store.state.entriesWithKnownSize(), [0, 1]);
    assertEquals(store.state.pendingSizeCount(), 0);
    assertEquals(store.state.current(), null, "measurement does not invent browsing intent");
  } finally {
    store.dispose(); dispose(); store.actions.status.clear("transient"); Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
    env.restore();
  }
});
