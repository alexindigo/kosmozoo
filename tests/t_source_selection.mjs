import { assert, assertEquals } from "jsr:@std/assert";
import { makeSourceSelection, SOURCE_SELECTION_KEY } from "../client-solid/store/source-selection.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { sourceCollections, sourceFrame, injectedSourceStream } from "./helpers/source-stream.mjs";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

Deno.test("selection memory: hydration, independent sources, address fencing, explicit clear/delete/prune and snapshots", () => {
  const saved = storage(), first = makeSourceSelection({ storage: saved });
  for (const name of ["a.png", "nested/b.png", "c.png"]) first.set("a", "a:1", name, true);
  first.set("b", "b:1", "other.png", true);
  const second = makeSourceSelection({ storage: saved });
  assertEquals(second.names("a", "a:1"), ["a.png", "nested/b.png", "c.png"]);
  assertEquals(second.names("b", "b:1"), ["other.png"]);
  assertEquals(second.names("a", "repointed:1"), []); assert(second.has("a", "a:1", "a.png"));
  const snapshot = second.names("a", "a:1"); snapshot.length = 0;
  assertEquals(first.names("a", "a:1").length, 3);
  second.set("a", "a:1", "a.png", false); second.remove("a", "a:1", ["c.png"]);
  assertEquals(first.names("a", "a:1"), ["nested/b.png"]);
  second.prune("a", "a:1", ["unselected.png"]); assertEquals(first.names("a", "a:1"), []);
  second.clear("b", "b:1"); assertEquals(first.names("b", "b:1"), []);
  second.set("a", "new:1", "new.png", true);
  assertEquals(first.names("a", "a:1"), []); assertEquals(first.names("a", "new:1"), ["new.png"]);
});

Deno.test("selection memory: read-merge-write preserves other tabs, unknown fields, invalid records and prototype names", () => {
  const saved = storage({ untouched: "kept", [SOURCE_SELECTION_KEY]: JSON.stringify({ version: 1, extra: "kept", hosts: { invalid: { address: 7, names: null } } }) });
  const first = makeSourceSelection({ storage: saved }), second = makeSourceSelection({ storage: saved });
  first.set("a", "a:1", "first.png", true); second.set("b", "b:1", "second.png", true);
  first.clear("a", "a:1"); second.set("__proto__", "proto:1", "own.png", true);
  const document = JSON.parse(saved.getItem(SOURCE_SELECTION_KEY));
  assertEquals(document.hosts.b.names, ["second.png"]); assertEquals(document.hosts.invalid, { address: 7, names: null });
  assertEquals(document.extra, "kept"); assertEquals(saved.getItem("untouched"), "kept");
  assertEquals(first.names("__proto__", "proto:1"), ["own.png"]); assertEquals(first.names("constructor", "proto:1"), []);
});

Deno.test("selection memory: corrupt/future documents preserved and denied/quota failures retain session intent with one report", () => {
  for (const bytes of ["{", JSON.stringify({ version: 2, hosts: {} }), JSON.stringify({ version: 1, hosts: [] })]) {
    const saved = storage({ [SOURCE_SELECTION_KEY]: bytes }), errors = [], memory = makeSourceSelection({ storage: saved, onError: message => errors.push(message) });
    memory.set("a", "a:1", "one.png", true); memory.set("a", "a:1", "two.png", true);
    assertEquals(saved.getItem(SOURCE_SELECTION_KEY), bytes); assertEquals(memory.names("a", "a:1"), ["one.png", "two.png"]);
    assertEquals(errors.length, 1); assert(errors[0].startsWith("Card selection memory unavailable: "));
  }
  for (const failure of ["read", "write"]) {
    const saved = storage(), errors = [], memory = makeSourceSelection({ storage: saved, onError: message => errors.push(message) });
    memory.set("a", "a:1", "one.png", true);
    if (failure === "read") saved.getItem = () => { throw new Error("denied"); };
    else saved.setItem = () => { throw new Error("quota"); };
    memory.set("a", "a:1", "two.png", true); memory.remove("a", "a:1", ["one.png"]);
    assertEquals(memory.names("a", "a:1"), ["two.png"]); assertEquals(errors.length, 1);
  }
});

async function withSelection(run, saved = storage()) {
  const oldApi = { ...api }, oldLocation = globalThis.location, oldHistory = globalThis.history;
  globalThis.location = { pathname: "/", search: "", hash: "#a" };
  globalThis.history = { state: null, replaceState(_state, _title, href) {
    const next = new URL(href, "http://fixture");
    Object.assign(globalThis.location, { pathname: next.pathname, search: next.search, hash: next.hash });
  }, pushState(state, title, href) { this.replaceState(state, title, href); } };
  const sources = { a: { address: "a:1", kind: "comfy", online: true, incarnation: "a-registration" }, b: { address: "b:1", kind: "comfy", online: true, incarnation: "b-registration" } };
  const row = name => ({ name, size: 1, hash: null, width: 20, height: 30, meta: null, judgment: null });
  const rows = { a: ["one.png", "nested/two.png", "three.png"].map(row), b: [row("other.png")] };
  let coverage = "recursive", epoch = "first", revision = 0;
  const frame = () => sourceFrame(sources, revision++, epoch), stream = injectedSourceStream(frame());
  api.collections = async () => {
    const snapshot = sourceFrame(sources, revision, epoch);
    return sourceCollections(Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, { ...source, ...snapshot.sources[id] }])));
  };
  api.inventory = async id => clientInventory(rows[id], { coverage });
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({}); api.settings = async () => ({}); api.setSettings = async () => ({}); api.prefetch = async () => ({});
  api.deleteEntry = async () => ({});
  const store = makeAppStore({ storage: saved, subscribeSources: callbacks => stream.subscribe(callbacks) });
  try {
    await store.actions.boot();
    await run({ store, saved, rows, sources, row, setCoverage: value => { coverage = value; },
      async restart() { epoch = "restarted"; stream.snapshot(frame()); for (let i = 0; i < 100; i++) await Promise.resolve(); await store.actions.images.reload(); } });
  } finally {
    store.dispose(); store.actions.status.clear("transient"); Object.assign(api, oldApi);
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldHistory === undefined) delete globalThis.history; else globalThis.history = oldHistory;
  }
}

Deno.test("selection Store: reload, epoch replacement, A-B-A, filters/folders and browser hydration retain intent; Clear is source-local", async () => {
  const saved = storage();
  await withSelection(async ({ store, restart }) => {
    for (const image of store.state.images) store.actions.selected.set(image.id, true);
    assertEquals(Object.keys(store.state.selected).length, 3);
    store.actions.ui.setFilter("one"); store.actions.folders.select("nested");
    assertEquals(store.actions.bulk.images().length, 3, "visibility never changes action membership");
    await store.actions.images.reload(); await restart(); assertEquals(store.actions.bulk.images().length, 3);
    await store.actions.hosts.select("b"); store.actions.selected.set("b:other.png", true);
    await store.actions.hosts.select("a"); assertEquals(store.actions.bulk.images().length, 3);
    store.actions.bulk.clear(); assertEquals(store.actions.bulk.images().length, 0);
    await store.actions.hosts.select("b"); assertEquals(store.actions.bulk.images().map(image => image.id), ["b:other.png"]);
    await store.actions.hosts.select("a"); store.actions.selected.set("a:one.png", true);
  }, saved);
  await withSelection(async ({ store }) => { assertEquals(Object.keys(store.state.selected), ["a:one.png"]); }, saved);
});

Deno.test("selection Store: incomplete inventories hide missing targets without pruning; complete inventories and successful deletes remove them", () => withSelection(async ({ store, rows, setCoverage }) => {
  for (const image of store.state.images) store.actions.selected.set(image.id, true);
  const complete = rows.a; rows.a = [complete[0]]; setCoverage("root-only"); await store.actions.images.reload();
  assertEquals(store.actions.bulk.images().map(image => image.id), ["a:one.png"]);
  rows.a = complete; await store.actions.images.reload(); assertEquals(Object.keys(store.state.selected).length, 3);
  rows.a = [complete[0], complete[2]]; setCoverage("recursive"); await store.actions.images.reload();
  rows.a = complete; await store.actions.images.reload(); assertEquals(Object.keys(store.state.selected), ["a:one.png", "a:three.png"]);
  api.deleteEntry = async (_host, filename) => { if (filename === "three.png") throw new Error("kept"); return {}; };
  await store.handles.invoke("image.delete.request", { target: "selected" });
  await store.handles.invoke("image.delete.confirm");
  assertEquals(Object.keys(store.state.selected), ["a:three.png"]);
  await store.actions.images.reload(); assertEquals(Object.keys(store.state.selected), ["a:three.png"]);
}));
