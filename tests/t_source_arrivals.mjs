import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import { SourceArrivals } from "../src/source-arrivals.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { makeCollectionInventory } from "../src/backings/index.mjs";
import { SourceActivity } from "../src/source-activity.mjs";
import { Jobs } from "../src/jobs.mjs";
import { validateSourceSnapshot } from "../client/js/source-events.mjs";
import { buildContext } from "../src/context.mjs";
import { createRoot } from "solid-js";
import { makeSourceRegistry } from "../client-solid/store/source-registry.js";

Deno.test("arrivals: session sequence is independent of relist order and revalidation; missing/hidden entries don't signal", () => {
  const rows = [], arrivals = new SourceArrivals({
    hiddenNames: () => rows.filter(row => row.hidden === 1).map(row => row.name),
    goneNames: () => rows.filter(row => row.state === "gone").map(row => row.name),
  });
  assertEquals(arrivals.projection("a"), null);
  arrivals.observe("a", ["old.png"]);
  assertEquals(arrivals.projection("a"), { sequence: 1, latestVisibleSeq: 1 });
  arrivals.observe("a", ["new.png", "old.png", "new.png"]);
  assertEquals(arrivals.inventory("a").sequences, { "new.png": 2, "old.png": 1 });
  arrivals.observe("a", ["old.png", "new.png"]);
  assertEquals(arrivals.projection("a").sequence, 2);
  rows.push({ name: "new.png", hidden: 1 });
  arrivals.changed("a"); // the Store's post-commit visibility boundary
  assertEquals(arrivals.projection("a"), { sequence: 2, latestVisibleSeq: 1 });
  arrivals.observe("a", ["old.png", "new.png", "hidden.png"]);
  rows.push({ name: "hidden.png", state: "gone" });
  arrivals.changed("a");
  arrivals.remove("a", "old.png");
  assertEquals(arrivals.projection("a").latestVisibleSeq, 0);
  arrivals.forget("a"); assertEquals(arrivals.projection("a"), null);
});

Deno.test("arrivals: projections read only exclusion names at mutation boundaries, never metadata on progress snapshots", () => {
  let broadReads = 0, nameReads = 0;
  const hidden = new Set(), gone = new Set(), events = [];
  const arrivals = new SourceArrivals({ entriesForCollection: () => { broadReads++; return []; },
    hiddenNames: () => { nameReads++; return hidden; }, goneNames: () => { nameReads++; return gone; } });
  arrivals.subscribe(id => events.push(id));
  arrivals.observe("a", ["old.png", "latest.png"]);
  assertEquals(broadReads, 0, "arrival filtering must not load content metadata");
  assert(nameReads > 0);
  arrivals.changed("unobserved"); assertEquals(events, ["a"]);
  const reads = nameReads;
  for (let i = 0; i < 100; i++) assertEquals(arrivals.projection("a"), { sequence: 2, latestVisibleSeq: 2 });
  assertEquals(nameReads, reads, "Jobs progress reads the cached small projection");
  arrivals.changed("a"); arrivals.observe("a", ["latest.png", "old.png"]);
  hidden.add("old.png"); arrivals.changed("a");
  assertEquals(events, ["a"], "unchanged sequence/latest-visible does not republish");
  gone.add("latest.png"); arrivals.changed("a");
  assertEquals(events, ["a", "a"]); assertEquals(arrivals.projection("a"), { sequence: 2, latestVisibleSeq: 0 });
  const projected = arrivals.projection("a"); projected.latestVisibleSeq = 99;
  assertEquals(arrivals.projection("a").latestVisibleSeq, 0, "readers cannot mutate the cached projection");
  arrivals.forget("a"); assertEquals(arrivals.projection("a"), null);
  hidden.clear(); gone.clear(); arrivals.observe("a", ["old.png"]);
  assertEquals(arrivals.projection("a"), { sequence: 1, latestVisibleSeq: 1 }); assertEquals(events.length, 3);
});

Deno.test("arrivals: real Store hide/gone publishes only changed small projections to SourceActivity", async () => {
  const r = await mkStateRig("arrival-publication", { hosts: { a: "a:80" } });
  let sources;
  try {
    r.store.collectionAdd("a", "a:80");
    const jobs = { subscribe: () => () => {}, snapshot: () => ({}) };
    sources = new SourceActivity({ store: r.store, hosts: r.hosts, inventory: r.inventory, jobs });
    r.store.entryHide("a", "not-listed.png"); assertEquals(sources.revision, 0);
    r.store.arrivals.observe("a", ["old.png", "latest.png"]); assertEquals(sources.revision, 1);
    r.store.entryHide("a", "old.png"); assertEquals(sources.revision, 1);
    r.store.entryGone("a", "latest.png"); assertEquals(sources.revision, 2);
    assertEquals(sources.snapshot().sources.a.arrivals, { sequence: 2, latestVisibleSeq: 0 });
    r.store.entryGone("a", "latest.png"); r.store.entryHide("a", "old.png"); assertEquals(sources.revision, 2);
    assertEquals(r.store.arrivals.inventory("a").sequences, {});
  } finally { sources?.stop(); await r.close(); }
});

Deno.test("arrivals: each browser baselines independently, viewed sources stay current, opening clears; hidden-only attention clears", () => {
  createRoot(dispose => {
    try {
      const make = () => makeSourceRegistry({ createRecord: () => ({}), onRetire: () => {} });
      const one = make(), two = make();
      for (const registry of [one, two]) registry.reconcile({ a: { address: "a:80" } });
      const a = one.get("a"), b = two.get("a");
      a.acceptArrivals({ sequence: 3, latestVisibleSeq: 3 }); assertEquals(a.hasNew, false);
      a.acceptArrivals({ sequence: 4, latestVisibleSeq: 4 }); assertEquals(a.hasNew, true);
      b.acceptArrivals({ sequence: 4, latestVisibleSeq: 4 }); assertEquals(b.hasNew, false, "new browser starts quiet");
      a.markSeen(); assertEquals(a.hasNew, false);
      a.acceptArrivals({ sequence: 5, latestVisibleSeq: 5 }, true); assertEquals(a.hasNew, false);
      a.acceptArrivals({ sequence: 6, latestVisibleSeq: 6 }); assertEquals(a.hasNew, true);
      a.acceptArrivals({ sequence: 6, latestVisibleSeq: 5 }); assertEquals(a.hasNew, false);
      assertEquals(b.seenSeq, 4, "no cross-browser cursor writes");
    } finally { dispose(); }
  });
});

Deno.test("arrivals: complete inventory publishes a small all-source projection through the existing stream", async () => {
  const r = await mkStateRig("arrival-stream", { hosts: { a: "a:80", b: "b:80" } });
  let inventory, sources;
  try {
    const arrivals = new SourceArrivals(r.store); let names = ["old.png"];
    inventory = makeCollectionInventory(r.hosts, {
      bindingFactory: () => ({ inventory: async () => ({ items: names.map(name => ({ name })) }), disposeInventory: async () => {} }),
      onSnapshot: (id, _address, snapshot) => arrivals.observe(id, snapshot.items.map(f => f.name)),
    });
    const jobs = new Jobs({ hosts: r.hosts, client: inventory.binding });
    sources = new SourceActivity({ store: r.store, hosts: r.hosts, inventory, jobs, arrivals });
    assertEquals(sources.source("b").arrivals, null);
    await inventory("b"); names = ["new.png", "old.png"]; await inventory("b");
    const frame = validateSourceSnapshot(sources.snapshot());
    assertEquals(frame.sources.b.arrivals, { sequence: 2, latestVisibleSeq: 2 });
    frame.sources.b.arrivals.latestVisibleSeq = 3;
    assertThrows(() => validateSourceSnapshot(frame));
  } finally { sources?.stop(); await inventory?.stop(); await r.close(); }
});

Deno.test("arrivals: a newly added unselected source joins the existing headless worker", async () => {
  const r = await mkStateRig("arrival-membership"); let context, inventory;
  try {
    inventory = makeCollectionInventory(r.hosts, {
      bindingFactory: () => ({ inventory: async () => ({ items: [] }), disposeInventory: async () => {} }),
    });
    context = await buildContext({ start: false, env: { HOME: r.dir }, fakes: {
      stateDir: r.dir, store: r.store, settings: r.settings, hosts: r.hosts, inventory, features: [],
    } });
    await context.ctx.prefetch.start(); r.store.collectionAdd("unselected", "folder:" + r.dir);
    assert(context.ctx.prefetch.workers.has("unselected"));
  } finally { await context?.close(); await inventory?.stop(); await r.close(); }
});
