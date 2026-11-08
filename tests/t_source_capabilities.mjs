import { assert, assertEquals } from "jsr:@std/assert";
import { createRoot } from "solid-js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { sourceFrame, injectedSourceStream } from "./helpers/source-stream.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { makeSourceDiscovery, knownCapabilities, enrichCapabilities, DISCOVERY_DEADLINE_MS } from "../client-solid/store/source-discovery.js";

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const capabilities = (mode = "trash", supported = true) => ({ list: true, read: true, add: true,
  delete: mode, rename: false, subfolders: { supported, reason: null } });
const discovered = frame => Object.fromEntries(Object.entries(frame.sources).map(([id, source]) =>
  [id, { ...source, online: true, capabilities: capabilities() }]));

Deno.test("source capabilities: new engine identity autonomously recovers without source refresh", async () => {
  const saved = { ...api }, location = globalThis.location, history = globalThis.history;
  let frame = sourceFrame({ h: {} }), reads = 0, cleanup;
  const stream = injectedSourceStream(frame);
  globalThis.location = { pathname: "/", search: "", hash: "#h#a.png" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  api.collections = async () => { reads++; return discovered(frame); };
  api.inventory = async () => clientInventory([{ name: "a.png", width: 100, height: 50, hash: "content" }], { coverage: "recursive" });
  api.runtime = async () => ({ app: { version: "0.4.0" } });
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({}); api.settings = async () => ({}); api.setSettings = async () => ({}); api.prefetch = async () => ({});
  const store = createRoot(dispose => { cleanup = dispose; return makeAppStore({ subscribeSources: stream.subscribe, storage: null }); });
  try {
    await store.actions.boot(); await flush();
    assertEquals(store.state.hosts.h.capabilities.delete, "trash");
    frame = sourceFrame({ h: {} }, 0, "replacement-engine");
    stream.snapshot(frame); await flush();
    assertEquals(store.state.hosts.h.capabilities?.delete, "trash", "replacement source must acquire its own capability");
    assertEquals(reads, 2);
  } finally {
    store.dispose(); cleanup(); store.actions.status.clear("transient"); Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
  }
});

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function clock() {
  let now = 0, next = 0;
  const timers = new Map(), delays = [];
  return {
    timers, delays,
    schedule(callback, delay) { delays.push(delay); timers.set(++next, { at: now + delay, callback }); return next; },
    cancel(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; timers.delete(entry[0]); entry[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}
function ownerRig() {
  const time = clock(), first = {}, calls = [], publications = [];
  let targets = [first];
  const owner = makeSourceDiscovery({ ...time, capture: () => ({ targets: [...targets] }),
    read(options) { const held = deferred(); calls.push({ ...held, ...options }); return held.promise; },
    accept(response, ticket) {
      const accepted = ticket.targets.filter(target => targets.includes(target));
      publications.push(response);
      return response?.known ? accepted : [];
    },
  });
  return { owner, time, calls, publications, first, targets: value => { targets = value; owner.reconcile(); } };
}

Deno.test("source discovery: single flight retains new demand during old read and settles without polling", async () => {
  const r = ownerRig();
  try {
    r.owner.start(); await flush(); const second = {};
    r.targets([r.first, second]); for (let i = 0; i < 10; i++) r.owner.reconcile();
    assertEquals(r.calls.length, 1);
    r.calls[0].resolve({ known: true }); await flush(); assertEquals(r.calls.length, 2);
    r.calls[1].resolve({ known: true }); await flush();
    await r.time.advance(300000); assertEquals(r.calls.length, 2); assertEquals(r.time.timers.size, 0);
  } finally { r.owner.dispose(); }
});

Deno.test("source discovery: failure and partial reads retain capped backoff despite duplicate observations", async () => {
  const r = ownerRig();
  try {
    r.owner.start(); await flush();
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = r.calls.length;
      r.calls.at(-1).reject(Error("unavailable")); await flush();
      for (let i = 0; i < 10; i++) r.owner.reconcile();
      assertEquals(r.time.delays.at(-1), delay);
      await r.time.advance(delay - 1); assertEquals(r.calls.length, before);
      await r.time.advance(1); assertEquals(r.calls.length, before + 1);
    }
    r.calls.at(-1).resolve({ known: false }); await flush(); assertEquals(r.time.delays.at(-1), 30000);
    await r.time.advance(30000); r.calls.at(-1).resolve({ known: true }); await flush();
    assertEquals(r.time.timers.size, 0);
  } finally { r.owner.dispose(); }
});

Deno.test("source discovery: 120s deadline aborts and fences ignored-abort late replies", async () => {
  const r = ownerRig();
  try {
    r.owner.start(); await flush();
    await r.time.advance(DISCOVERY_DEADLINE_MS - 1); assert(!r.calls[0].signal.aborted);
    await r.time.advance(1); assert(r.calls[0].signal.aborted); assertEquals(r.time.delays.at(-1), 1000);
    await r.time.advance(1000); assertEquals(r.calls.length, 2);
    r.calls[0].resolve({ known: true, stale: true }); await flush(); assertEquals(r.publications, []);
    r.calls[1].resolve({ known: true }); await flush(); assertEquals(r.publications, [{ known: true }]);
  } finally { r.owner.dispose(); }
});

Deno.test("source discovery: refresh coalesces, policy invalidation retires old work, last policy wins", async () => {
  const r = ownerRig();
  try {
    r.owner.start(); await flush(); const a = r.owner.refresh(), b = r.owner.refresh();
    assertEquals(r.calls.length, 1);
    const updated = r.owner.refresh({ invalidate: true }); await flush();
    assertEquals(await a, false); assertEquals(await b, false); assert(r.calls[0].signal.aborted);
    r.calls[0].resolve({ known: true, mode: "trash" }); await flush(); assertEquals(r.publications, []);
    r.calls[1].resolve({ known: true, mode: "hide" }); assertEquals(await updated, true);
    assertEquals(r.publications, [{ known: true, mode: "hide" }]); assertEquals(r.time.timers.size, 0);
  } finally { r.owner.dispose(); }
});

Deno.test("source discovery: retirement, page suspension/resume and disposal cancel work without losing unresolved demand", async () => {
  const r = ownerRig();
  r.owner.start(); await flush(); r.owner.suspend();
  assert(r.calls[0].signal.aborted); assertEquals(r.time.timers.size, 0);
  r.calls[0].resolve({ known: true }); await flush(); assertEquals(r.publications, []);
  r.owner.resume(); await flush(); assertEquals(r.calls.length, 2);
  r.targets([]); await flush(); assert(r.calls[1].signal.aborted); assertEquals(r.calls.length, 2);
  r.targets([{}]); await flush(); assertEquals(r.calls.length, 3);
  r.owner.dispose(); r.calls[2].resolve({ known: true }); await flush();
  await r.time.advance(300000); assertEquals(r.publications, []); assertEquals(r.time.timers.size, 0);
});

Deno.test("source capabilities: valid false settles; partial null stays unresolved without erasing known fields", () => {
  assert(knownCapabilities(capabilities(false, false)));
  assert(!knownCapabilities(capabilities(null, null)));
  assert(!knownCapabilities({ delete: "trash" }));
  assertEquals(enrichCapabilities(capabilities("trash", true), capabilities(null, null)), capabilities("trash", true));
  assertEquals(enrichCapabilities(null, capabilities(false, false)), capabilities(false, false));
});

async function withClient(run, { initial = sourceFrame({ h: {} }), read } = {}) {
  const saved = { ...api }, location = globalThis.location, history = globalThis.history;
  let current = initial ?? sourceFrame({ h: {} }), reads = 0, inventories = 0, cleanup;
  let readImpl = read ?? (() => discovered(current));
  const stream = injectedSourceStream();
  globalThis.location = { pathname: "/", search: "", hash: "#h#a.png" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  api.collections = options => { reads++; return Promise.resolve().then(() => readImpl(options)); };
  api.inventory = async () => { inventories++; return clientInventory([{ name: "a.png", width: 100, height: 50, hash: "content" }], { coverage: "recursive" }); };
  api.runtime = async () => ({ app: { version: "0.4.0" } });
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({}); api.settings = async () => ({}); api.setSettings = async () => ({}); api.prefetch = async () => ({});
  const store = createRoot(dispose => { cleanup = dispose; return makeAppStore({ subscribeSources: callbacks => {
    const dispose = stream.subscribe(callbacks); if (initial && stream.connections.length === 1) stream.snapshot(initial); return dispose;
  }, storage: null }); });
  const emit = async frame => { current = frame; stream.snapshot(frame); await flush(); };
  try { await run({ store, stream, emit, reads: () => reads, inventories: () => inventories, setRead: fn => { readImpl = fn; } }); }
  finally {
    store.dispose(); cleanup(); store.actions.status.clear("transient"); Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
  }
}

Deno.test("source capabilities Store: stream membership boots during failed discovery; committed add does not repeat or fail", async () => {
  await withClient(async ({ store, reads }) => {
    await store.actions.boot(); assertEquals(store.state.images.length, 1); assertEquals(store.state.hosts.h.capabilities, null);
    let mutations = 0;
    api.addCollection = async () => { mutations++; return { name: "added", ...sourceFrame({ added: {} }, 2).sources.added,
      sourceCursor: { epoch: "stream", revision: 2 }, online: true }; };
    assertEquals(await store.actions.hosts.add("added", "mock:1"), { ok: true }); await flush();
    assert(Object.hasOwn(store.state.hosts, "added")); assertEquals(mutations, 1); assertEquals(reads(), 1, "new demand retains failure backoff");
  }, { read: () => { throw Error("discovery unavailable"); } });
});

Deno.test("source capabilities Store: additions, omissions, same-address readd and reserved IDs acquire only current identities", async () => {
  await withClient(async ({ store, emit, reads, setRead }) => {
    await store.actions.boot(); await flush();
    const frame = sourceFrame({ h: {} }, 1);
    frame.sources = Object.fromEntries([["h", frame.sources.h], ["constructor", sourceFrame({ constructor: {} }).sources.constructor]]);
    await emit(frame); assertEquals(store.state.hosts.constructor.capabilities.delete, "trash");
    const old = deferred(); setRead(() => old.promise);
    const refresh = store.actions.hosts.refresh(); await flush();
    await emit(sourceFrame({ h: {}, constructor: { incarnation: "new" } }, 2));
    old.resolve(discovered(frame)); await refresh; await flush();
    assertEquals(store.state.hosts.constructor.capabilities, null);
    setRead(() => discovered(sourceFrame({ h: {}, constructor: { incarnation: "new" } }, 2)));
    await store.actions.hosts.refresh();
    assertEquals(store.state.hosts.constructor.capabilities.delete, "trash"); assert(reads() >= 3);
    await emit(sourceFrame({ h: {} }, 3));
    setRead(() => discovered(sourceFrame({ h: {}, constructor: { incarnation: "again" } }, 4)));
    await emit(sourceFrame({ h: {}, constructor: { incarnation: "again" } }, 4));
    assertEquals(store.state.hosts.constructor.incarnation, "again"); assertEquals(store.state.hosts.constructor.capabilities.delete, "trash");
  });
});

Deno.test("source capabilities Store: pending inventory follows live discovery, accepted inventory wins; discovery preserves selection/current/feed", async () => {
  await withClient(async ({ store, inventories, setRead }) => {
    const inventory = deferred(); api.inventory = () => inventory.promise;
    const boot = store.actions.boot(); await flush();
    assertEquals(store.state.inventory.subfolders.supported, true);
    inventory.resolve(clientInventory([{ name: "a.png", width: 100, height: 50, hash: "content" }], { coverage: "root-only" }));
    await boot; const image = store.state.images[0], current = store.state.current();
    store.handles.invoke("selection.set", { id: "h:a.png", value: true });
    setRead(() => discovered(sourceFrame({ h: {} })));
    await store.actions.hosts.refresh();
    assertEquals(store.state.inventory.subfolders.supported, false); assertEquals(store.state.images[0], image);
    assertEquals(store.state.current(), current); assertEquals(Object.keys(store.state.selected), ["h:a.png"]); assertEquals(inventories(), 0);
  });
});

Deno.test("source capabilities Store: HTTP bootstrap awaits membership; matching later stream retains known capabilities", async () => {
  const held = deferred();
  await withClient(async ({ store, emit }) => {
    let booted = false; const boot = store.actions.boot().then(() => { booted = true; }); await flush();
    assertEquals(booted, false);
    held.resolve(discovered(sourceFrame({ h: {} }))); await boot;
    assertEquals(store.state.hosts.h.capabilities.delete, "trash");
    await emit(sourceFrame({ h: {} })); assertEquals(store.state.hosts.h.capabilities.delete, "trash");
  }, { initial: null, read: () => held.promise });
});

Deno.test("source capabilities Store: authoritative false settles; unresolved null retries to known without manual refresh", async () => {
  let count = 0;
  await withClient(async ({ store, reads }) => {
    await store.actions.boot(); await flush(); assertEquals(store.state.hosts.h.capabilities.subfolders.supported, null);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assertEquals(store.state.hosts.h.capabilities.delete, false); assertEquals(reads(), 2);
    await new Promise(resolve => setTimeout(resolve, 1100)); assertEquals(reads(), 2);
  }, { read: () => {
    const result = discovered(sourceFrame({ h: {} })); result.h.capabilities = capabilities(false, count++ ? false : null); return result;
  } });
});

Deno.test("source capabilities Store: preference invalidation fences a held pre-toggle reply", async () => {
  await withClient(async ({ store, setRead }) => {
    await store.actions.boot(); const stale = deferred(); setRead(() => stale.promise);
    const refresh = store.actions.hosts.refresh(); await flush();
    setRead(() => { const value = discovered(sourceFrame({ h: {} })); value.h.capabilities.delete = "hide"; return value; });
    await store.actions.menu.deleteAssetsPlus(false); assertEquals(store.state.hosts.h.capabilities.delete, "hide");
    stale.resolve(discovered(sourceFrame({ h: {} }))); await refresh; await flush();
    assertEquals(store.state.hosts.h.capabilities.delete, "hide");
  });
});

Deno.test("source capabilities Store: existing refresh port acquires before boot", async () => {
  await withClient(async ({ store, reads }) => {
    await store.actions.hosts.refresh();
    assertEquals(store.state.hosts.h.capabilities.delete, "trash");
    await store.actions.boot(); assertEquals(reads(), 1); assertEquals(store.state.images.length, 1);
  }, { initial: null });
});

Deno.test("source capabilities Store: failed HTTP-only bootstrap retries instead of inventing empty membership", async () => {
  let count = 0;
  await withClient(async ({ store, reads }) => {
    let done = false; const boot = store.actions.boot().then(() => { done = true; });
    await flush(); assertEquals(done, false); assertEquals(store.state.noSources(), false);
    await boot; assertEquals(reads(), 2); assertEquals(store.state.images.length, 1);
  }, { initial: null, read: () => { if (!count++) throw Error("temporary"); return discovered(sourceFrame({ h: {} })); } });
});

Deno.test("source capabilities Store: startup replacement fences held old bootstrap and follows new demand", async () => {
  await withClient(async ({ store, emit, setRead }) => {
    const old = deferred(); let signal;
    setRead(options => { signal = options.signal; return old.promise; });
    const boot = store.actions.boot(); await flush();
    const frame = sourceFrame({ h: {} }, 0, "new-engine"); setRead(() => discovered(frame)); await emit(frame);
    assert(signal.aborted); await boot;
    old.resolve(discovered(sourceFrame({ h: {} }))); await flush();
    assertEquals(store.state.hosts.h.sourceVersion.epoch, "new-engine"); assertEquals(store.state.hosts.h.capabilities.delete, "trash");
  });
});

Deno.test("source capabilities Store: all exact reserved IDs acquire capabilities through own-key membership", async () => {
  await withClient(async ({ store, emit }) => {
    await store.actions.boot();
    const frame = sourceFrame(Object.fromEntries(["h", "__proto__", "constructor", "prototype", "toString"].map(id => [id, {}])), 1);
    await emit(frame);
    for (const id of Object.keys(frame.sources)) assertEquals(store.state.hosts[id].capabilities.delete, "trash", id);
  });
});

Deno.test("source capabilities Store: authoritative empty stream needs no capability polling", async () => {
  await withClient(async ({ store, reads }) => {
    await store.actions.boot(); assertEquals(store.state.noSources(), true); assertEquals(reads(), 0);
    await new Promise(resolve => setTimeout(resolve, 1100)); assertEquals(reads(), 0);
  }, { initial: sourceFrame({}), read: () => { throw Error("no discovery demand"); } });
});

Deno.test("source capabilities Store: disposal settles boot waiting for membership and fences late discovery", async () => {
  const held = deferred(); let signal, settings = 0;
  await withClient(async ({ store }) => {
    api.settings = async () => { settings++; return {}; };
    const boot = store.actions.boot(); await flush(); store.dispose(); await boot;
    assert(signal.aborted); assertEquals(settings, 0);
    held.resolve(discovered(sourceFrame({ h: {} }))); await flush();
    assertEquals(Object.keys(store.state.hosts), []); assertEquals(store.state.images.length, 0);
  }, { initial: null, read: options => { signal = options.signal; return held.promise; } });
});
