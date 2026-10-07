import { assert, assertEquals } from "jsr:@std/assert";
import { makeSourceBrowse, SOURCE_BROWSE_KEY } from "../client-solid/store/source-browse.js";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { parseUrl, feedUrl, diffUrl } from "../client/js/route-parse.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";
import { isEntryName } from "../src/entry-path.mjs";

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const pair = (folder, current, address = "h:1") => ({ address, folder, current });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

Deno.test("source memory: null/absent, address guards, invalid records and merging other tabs without touching four existing keys", () => {
  const existing = { "kosmozoo.infoGroups.v1": "groups", "kosmozoo.workspace.v1": "anchors", "kosmozoo.infoLayout.v1": "split", "kosmozoo.anchors.v1": "anchors" };
  const saved = storage({ ...existing, [SOURCE_BROWSE_KEY]: JSON.stringify({ version: 1, hosts: {
    h: pair("a", "a/image.png"), alias: pair("b", null), invalid: pair("../bad", "bad.png"),
  } }) });
  const first = makeSourceBrowse({ storage: saved }), second = makeSourceBrowse({ storage: saved });
  assertEquals(first.get("h", "h:1"), pair("a", "a/image.png"));
  assertEquals(first.get("h", "other:1"), undefined);
  assertEquals(first.get("alias", "h:1"), pair("b", null));
  assertEquals(first.get("missing", "h:1"), undefined);
  assertEquals(first.get("invalid", "h:1"), undefined);
  first.set("h", pair("a/deep", "a/deep/image.png"));
  second.set("other", pair("", "root.png", "other:1"));
  first.set("h", pair("", null));
  const document = JSON.parse(saved.getItem(SOURCE_BROWSE_KEY));
  assertEquals(document.hosts.other, pair("", "root.png", "other:1"));
  assertEquals(document.hosts.alias, pair("b", null));
  assertEquals(document.hosts.invalid, pair("../bad", "bad.png"), "ignore rather than clear other host records");
  for (const [key, value] of Object.entries(existing)) assertEquals(saved.getItem(key), value);
});

Deno.test("source memory: corrupt/future bytes preserved, quota/denied storage reported once and session pairs retained", () => {
  for (const bytes of ["{", JSON.stringify({ version: 2, hosts: {} })]) {
    const saved = storage({ [SOURCE_BROWSE_KEY]: bytes }), errors = [];
    const memory = makeSourceBrowse({ storage: saved, onError: (message) => errors.push(message) });
    memory.set("h", pair("a", "a/image.png")); memory.set("h", pair("b", null));
    assertEquals(saved.getItem(SOURCE_BROWSE_KEY), bytes);
    assertEquals(memory.get("h", "h:1"), pair("b", null));
    assertEquals(errors.length, 1);
  }
  const saved = storage({ [SOURCE_BROWSE_KEY]: JSON.stringify({ version: 1, hosts: { h: pair("a", "a/image.png") } }) }), errors = [];
  const memory = makeSourceBrowse({ storage: saved, onError: (message) => errors.push(message) });
  assertEquals(memory.get("h", "h:1").current, "a/image.png");
  saved.getItem = () => { throw new Error("denied"); };
  assertEquals(memory.get("h", "h:1").current, "a/image.png");
  memory.set("h", pair("b", "b/image.png")); memory.set("h", pair("b", null));
  assertEquals(memory.get("h", "h:1"), pair("b", null)); assertEquals(errors.length, 1);
  const full = storage(), quotaErrors = [];
  full.setItem = () => { throw new Error("quota"); };
  const quota = makeSourceBrowse({ storage: full, onError: (message) => quotaErrors.push(message) });
  quota.set("h", pair("a", "a/image.png")); quota.set("h", pair("a", null));
  assertEquals(quota.get("h", "h:1"), pair("a", null)); assertEquals(quotaErrors.length, 1);
});

Deno.test("source memory: flat-source leaf names retain the existing filesystem grammar", () => {
  const saved = storage(), memory = makeSourceBrowse({ storage: saved, validCurrent: (_address, name) => isEntryName("folder", name) });
  for (const name of ["C:file.png", "\\leaf.png", "line\n.png"]) {
    assertEquals(memory.set("flat", { address: "folder:/test", folder: "", current: name }), true);
    assertEquals(memory.get("flat", "folder:/test").current, name);
  }
});

function browser(url) {
  const entries = [new URL(url, "http://test")];
  let position = 0;
  const location = {};
  const sync = () => Object.assign(location, { pathname: entries[position].pathname, search: entries[position].search, hash: entries[position].hash });
  sync();
  const history = { state: null,
    replaceState(state, _, value) { this.state = state; entries[position] = new URL(value, entries[position]); sync(); },
    pushState(state, _, value) { this.state = state; entries.splice(position + 1); entries.push(new URL(value, entries[position])); position++; sync(); },
    back() { if (position > 0) position--; sync(); }, forward() { if (position < entries.length - 1) position++; sync(); },
  };
  return { location, history, entries };
}

async function withBrowse(run, { url = "/", saved = storage() } = {}) {
  const oldApi = { ...api }, oldLocation = globalThis.location, oldHistory = globalThis.history;
  const navigation = browser(url);
  globalThis.location = navigation.location; globalThis.history = navigation.history;
  const hosts = { h: { address: "h:1", kind: "comfy", online: true }, other: { address: "other:1", kind: "comfy", online: true }, flat: { address: "folder:/test", kind: "folder", online: true } };
  const row = (name) => ({ name, width: 100, height: 50, meta: null, judgment: null, hash: null, size: 100 });
  const lists = { h: ["root.png", "a/visible.png", "a/deep/image.png", "ab/sibling.png", "b/target.png", "h#real.png"].map(row),
    other: ["other/last.png", "other/first.png"].map(row), flat: [row("flat.png")] };
  api.collections = async () => hosts;
  api.inventory = async (id) => clientInventory(lists[id], { coverage: id === "flat" ? "root-only" : "recursive" });
  api.activity = async () => ({ supported: false });
  api.meta = async () => ({ changed: false, pending: 0 }); api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({}); api.settings = async () => ({}); api.setSettings = async () => ({}); api.prefetch = async () => ({});
  const store = makeAppStore({ pollActivity: false, storage: saved });
  try { await store.actions.boot(); await run({ store, saved, lists, row, navigation }); }
  finally {
    store.dispose(); store.actions.status.clear("transient"); Object.assign(api, oldApi);
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    if (oldHistory === undefined) delete globalThis.history; else globalThis.history = oldHistory;
  }
}

Deno.test("browse URLs: canonical full paths, filter/folder/unrelated query and encoded input diff sources round-trip once", () => {
  const old = globalThis.location;
  try {
    const file = "a/%2F#name: café.png";
    const url = feedUrl("h", file, { folder: "a", filter: "#name: café", search: "?other=kept&filter=old" });
    globalThis.location = browser(url).location;
    assertEquals(parseUrl(), { view: "feed", host: "h", file, folder: "a", filter: "#name: café" });
    assert(new URL(url, "http://test").searchParams.get("other") === "kept");
    const comparison = diffUrl({ source: "h", file }, { source: "input:other", file: "inputs/ref.png" }, { folder: "a", filter: "café" });
    globalThis.location = browser(comparison).location;
    assertEquals(parseUrl().right, { source: "input:other", file: "inputs/ref.png" });
    assertEquals(parseUrl().filter, "café");
    assertEquals(feedUrl("h", null, { search: "?filter=old&folder=old&other=kept" }), "/?other=kept#h");
  } finally { if (old === undefined) delete globalThis.location; else globalThis.location = old; }
});

Deno.test("browse: subtree/selection preservation, per-host pair restoration and explicit URL/fileless precedence", async () => {
  const saved = storage();
  await withBrowse(async ({ store }) => {
    store.actions.current.set("h", "a/deep/image.png");
    store.actions.selected.set("h:b/target.png", true);
    store.actions.folders.select("a");
    assertEquals(store.state.view().map((i) => store.state.images[i].filename), ["a/visible.png", "a/deep/image.png"]);
    assertEquals(store.state.current().image, "a/deep/image.png"); assertEquals(store.actions.bulk.images().length, 1);
    await store.actions.hosts.select("other"); store.actions.current.set("other", "other/last.png");
    await store.actions.hosts.select("h");
    assertEquals(store.state.selectedFolder(), "a"); assertEquals(store.state.current().image, "a/deep/image.png");
    await store.actions.hosts.select("other"); assertEquals(store.state.current().image, "other/last.png");
  }, { saved });
  await withBrowse(async ({ store }) => {
    assertEquals(store.state.selectedFolder(), "a"); assertEquals(store.state.current().image, "a/deep/image.png");
  }, { saved });
  await withBrowse(async ({ store }) => {
    assertEquals(store.state.selectedFolder(), ""); assertEquals(store.state.current(), null);
  }, { url: "/#h", saved });
});

Deno.test("browse: image link removes URL filter, Back/Forward restore filter/folder/current without new history entries", async () => {
  await withBrowse(async ({ store, navigation }) => {
    store.actions.current.set("h", "a/visible.png");
    store.actions.folders.select("a"); store.actions.ui.setFilter("a/");
    const before = new URL(navigation.entries.at(-1));
    await store.actions.current.navigate("h", "b/target.png");
    assertEquals(store.state.filter(), ""); assertEquals(store.state.selectedFolder(), "");
    assertEquals(store.state.current().image, "b/target.png"); assertEquals(parseUrl().filter, "");
    const count = navigation.entries.length;
    navigation.history.back(); await store.actions.route.changed();
    assertEquals(store.state.filter(), "a/"); assertEquals(store.state.selectedFolder(), "a");
    assertEquals(store.state.current().image, "a/visible.png"); assertEquals(navigation.location.search, before.search);
    navigation.history.forward(); await store.actions.route.changed();
    assertEquals(store.state.filter(), ""); assertEquals(store.state.current().image, "b/target.png");
    assertEquals(navigation.entries.length, count);
  });
});

Deno.test("browse: missing folder/current, deliberate null and failed listing retain the right pair", async () => {
  const saved = storage({ [SOURCE_BROWSE_KEY]: JSON.stringify({ version: 1, hosts: { h: pair("unavailable/deep", "unavailable/deep/old.png") } }) });
  await withBrowse(async ({ store }) => {
    assertEquals(store.state.selectedFolder(), "unavailable/deep"); assertEquals(store.state.current(), null);
    assert(store.state.folderOptions().includes("unavailable/deep")); assertEquals(store.state.view().length, 0);
    assertEquals(parseUrl().file, null); assertEquals(parseUrl().folder, "unavailable/deep");
  }, { saved });
  const nullSaved = storage({ [SOURCE_BROWSE_KEY]: JSON.stringify({ version: 1, hosts: { h: pair("a", null) } }) });
  await withBrowse(async ({ store, saved }) => {
    assertEquals(store.state.current(), null);
    const bytes = saved.getItem(SOURCE_BROWSE_KEY);
    api.inventory = async () => { throw new Error("offline"); };
    await store.actions.images.reload();
    assertEquals(saved.getItem(SOURCE_BROWSE_KEY), bytes); assertEquals(store.state.selectedFolder(), "a");
  }, { saved: nullSaved });
});

Deno.test("browse: a same-host folder/URL intent wins delayed load and refresh, while pending nested judgment stays addressed", async () => {
  await withBrowse(async ({ store, lists, navigation }) => {
    const read = deferred(); api.inventory = () => read.promise;
    const reload = store.actions.images.reload();
    store.actions.folders.select("b");
    store.actions.ui.setFilter("target");
    read.resolve(clientInventory(lists.h, { coverage: "recursive" })); await reload;
    assertEquals([store.state.selectedFolder(), store.state.filter(), store.state.current().image], ["b", "target", "b/target.png"]);
    const refresh = deferred(); api.inventory = () => refresh.promise;
    const pending = store.actions.ui.refresh(); await tick();
    navigation.history.pushState(null, "", "/?folder=a&filter=visible#h#a%2Fvisible.png");
    await store.actions.route.changed();
    refresh.resolve(clientInventory(lists.h, { coverage: "recursive" })); await pending;
    assertEquals([store.state.selectedFolder(), store.state.filter(), store.state.current().image], ["a", "visible", "a/visible.png"]);
    const writes = [], write = deferred();
    api.setJudgment = (host, name, patch) => { writes.push({ host, name, patch }); return write.promise; };
    const note = store.actions.judgments.dispatch("h:a/visible.png", { type: "note", sign: "pos", text: "retained" });
    await tick(); store.actions.folders.select("b");
    write.resolve({ notes: { pos: "retained" } }); await note;
    assertEquals(writes[0].name, "a/visible.png");
    assertEquals(store.state.images.find((x) => x.id === "h:a/visible.png").judgment.notes.pos, "retained");
  });
});

Deno.test("browse: real host# filename remains exact; flat current memory and diff context/pair stepping are preserved", async () => {
  await withBrowse(async ({ store, navigation }) => {
    store.actions.current.set("h", "h#real.png");
    assertEquals(store.state.current().image, "h#real.png"); assertEquals(parseUrl().file, "h#real.png");
    await store.actions.hosts.select("flat"); assertEquals(store.state.selectedFolder(), "");
    store.actions.current.set("flat", "flat.png"); await store.actions.hosts.select("h"); await store.actions.hosts.select("flat");
    assertEquals(store.state.current().image, "flat.png");
    navigation.history.pushState(null, "", "/diff?folder=a&filter=a%2F#h#a%2Fvisible.png:input%3Aother#inputs%2Fref.png");
    await store.actions.route.changed();
    assertEquals(store.state.host(), "h"); assertEquals(store.state.selectedFolder(), "a");
    assertEquals(store.state.diffPair().b, { source: "input:other", file: "inputs/ref.png" });
    store.actions.diff.step(1);
    assertEquals(parseUrl().left.file, "a/deep/image.png"); assertEquals(parseUrl().right.source, "input:other");
    assertEquals(parseUrl().filter, "a/"); assertEquals(parseUrl().folder, "a");
  });
});
