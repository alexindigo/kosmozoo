// tests/t_client_foundation.mjs — the framework-free contracts: geometry is
// box-fraction (unit-free), persistence is default-absent, the diff URL
// grammar round-trips, the fields registry is registry-driven, the current
// pointer keeps its bounded trail, the rail tape windows with hysteresis,
// and deletion navigation plans the pointer.

import { assert, assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { clientInventory } from "./helpers/client-inventory.mjs";

api.inventory = async (...args) => clientInventory(await api.entries(...args));

const BOX = { w: 1000, h: 500 };

Deno.test("store: workbench closed by default, current-image pointer null", () => {
  const store = makeAppStore();
  assertEquals(store.state.diff.open, false);
  assertEquals(store.state.current(), null);
});

// --- diff URL grammar ------------------------------------------------------

import { parseDiffHash, diffUrl } from "../client/js/route-parse.mjs";

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

import {
  fieldList,
  fullFieldRows,
} from "../client-solid/store/fields.js";

const REGISTRY = {
  KSampler: { title: null, inputs: { steps: "number", seed: "number", sampler_name: "string" } },
  LoraLoaderModelOnly: { title: "Load LoRA", inputs: { lora_name: "string", strength_model: "number" } },
  CLIPTextEncode: { title: null, inputs: { text: "string" } },
};
const LIST = fieldList(REGISTRY);

Deno.test("fields: every node input is a field; instances each get a row", () => {
  const rows = fullFieldRows({
    nodes: [
      { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7, sampler_name: "euler" } },
      { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
      { id: "3", type: "LoraLoaderModelOnly", inputs: { lora_name: "b.safetensors", strength_model: 0.5 } },
    ],
  }, { list: LIST });
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "a.safetensors"), "lora name row");
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — lora_name" && v === "b.safetensors"), "second lora name row");
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.8"));
  assert(rows.some(([l, v]) => l === "LoraLoaderModelOnly — strength_model" && v === "0.5"));
  assert(rows.some(([l, v]) => l === "KSampler — steps" && v === "20"));
  assert(rows.some(([l, v]) => l === "KSampler — seed" && v === "7"));
  assert(rows.some(([l, v]) => l === "KSampler — sampler_name" && v === "euler"));
});

Deno.test("fields: unknown node types on the image simply don't render", () => {
  const rows = fullFieldRows({
    nodes: [{ id: "1", type: "FluxGuidance", inputs: { guidance: 3.5 } }],
  }, { list: LIST });
  assertEquals(rows, []); // FluxGuidance is not in the registry yet
});

Deno.test("valueDiffer: values that differ from the previous meta are marked", async () => {
  const { valueDiffer } = await import("../client-solid/store/fields.js");
  const differs = valueDiffer({
    nodes: [
      { id: "1", type: "KSampler", inputs: { steps: 20, seed: 7 } },
      { id: "2", type: "LoraLoaderModelOnly", inputs: { lora_name: "a.safetensors", strength_model: 0.8 } },
    ],
  }, { list: LIST });
  assert(!differs("KSampler — seed", "7"), "same value is unchanged");
  assert(differs("KSampler — seed", "8"), "a changed value is marked");
  assert(!differs("KSampler — steps", "20"));
  assert(differs("KSampler — steps", "30"));
  assert(!differs("LoraLoaderModelOnly — strength_model", "0.8"));
  assert(differs("FluxGuidance — guidance", "3.5"), "a field the previous image lacked is marked");
  // no comparison target → nothing differs
  assert(!valueDiffer(null, { list: LIST })("KSampler — seed", "999"));
});

Deno.test("nodeImages: only LoadImage image inputs surface — SaveImage's filename_prefix is not an input file", async () => {
  const { nodeImages } = await import("../client-solid/store/fields.js");
  const meta = {
    nodes: [
      { id: "1", type: "LoadImage", inputs: { image: "source.png" } },
      { id: "2", type: "SaveImage", inputs: { filename_prefix: "ark#var_output_00001_.png" } },
      { id: "3", type: "CLIPTextEncode", inputs: { text: "a .png mentioned in text" } },
    ],
  };
  const imgs = nodeImages(meta, "ark");
  assertEquals(imgs.length, 1);
  assertEquals(imgs[0].file, "source.png");
  assertEquals(imgs[0].fromOutput, false);
  assert(imgs[0].src.includes("?kind=input"), "input ref uses input-bytes");
  // dedup: two LoadImage nodes on the same file render once
  const dup = nodeImages({ nodes: [
    { id: "1", type: "LoadImage", inputs: { image: "source.png" } },
    { id: "2", type: "LoadImage", inputs: { image: "source.png" } },
  ] }, "ark");
  assertEquals(dup.length, 1);
});

Deno.test("nodeImages: a LoadImage-from-output value is stripped of [output] and served from the output route", async () => {
  const { nodeImages } = await import("../client-solid/store/fields.js");
  const meta = {
    nodes: [
      { id: "9", type: "LoadImage", title: "Load Image", inputs: { image: "ark#ark#alisa_impl_00291__0.55_00001_.png [output]" } },
    ],
  };
  const imgs = nodeImages(meta, "ark");
  assertEquals(imgs.length, 1);
  assertEquals(imgs[0].file, "ark#ark#alisa_impl_00291__0.55_00001_.png");
  assertEquals(imgs[0].fromOutput, true);
  assert(imgs[0].src.includes("/api/collections/"), "output ref uses the feed bytes route");
  assert(!imgs[0].src.includes("[output]"), "annotation stripped from the URL");
});

// --- current-image tracking -------------------------------------------------

Deno.test("current: the replaced pointer goes onto the stack; pop walks it back", () => {
  const store = makeAppStore();
  const { assign, pop } = store.actions.current;

  // first pointer: nothing to push
  assign({ remote: "ark", image: "a.png" });
  assertEquals(store.state.current(), { remote: "ark", image: "a.png" });
  assertEquals(store.state.currentStack(), []);

  // a real change pushes the replaced pointer
  assign({ remote: "ark", image: "b.png" });
  assertEquals(store.state.currentStack(), [{ remote: "ark", image: "a.png" }]);

  // re-assigning the same target does not churn the stack
  assign({ remote: "ark", image: "b.png" });
  assertEquals(store.state.currentStack().length, 1);

  // a remote switch (image dropped) is still a change; clearing pushes too
  assign({ remote: "anton", image: null });
  assign(null);
  assertEquals(store.state.current(), null);
  assertEquals(store.state.currentStack().length, 3);
  assertEquals(store.state.currentStack().at(-1), { remote: "anton", image: null });

  // pop makes the latest previous current, consumes its entry, and does
  // not push the outgoing pointer
  assertEquals(pop(), { remote: "anton", image: null });
  assertEquals(store.state.current(), { remote: "anton", image: null });
  assertEquals(store.state.currentStack().length, 2);
  assertEquals(pop(), { remote: "ark", image: "b.png" });
  assertEquals(pop(), { remote: "ark", image: "a.png" });
  assertEquals(store.state.currentStack(), []);
  // empty trail: pop is a no-op
  assertEquals(pop(), null);
  assertEquals(store.state.current(), { remote: "ark", image: "a.png" });
});

Deno.test("current: the stack is a bounded window", () => {
  const store = makeAppStore();
  const { assign } = store.actions.current;
  assign({ remote: "ark", image: "seed.png" });
  for (let i = 0; i < 210; i++) assign({ remote: "ark", image: `img-${i}.png` });
  assertEquals(store.state.currentStack().length, 200);
  assertEquals(store.state.currentStack().at(-1), { remote: "ark", image: "img-208.png" });
});

Deno.test("current: push:false moves the pointer without touching the stack", () => {
  const store = makeAppStore();
  const { assign } = store.actions.current;
  assign({ remote: "ark", image: "before.png" });
  assign({ remote: "ark", image: "gone.png" }); // stack: [before]
  assign({ remote: "ark", image: "next.png" }, { push: false });
  assertEquals(store.state.current(), { remote: "ark", image: "next.png" });
  assertEquals(store.state.currentStack(), [{ remote: "ark", image: "before.png" }]);
});

// --- feed rail tape window ----------------------------------------------------

Deno.test("tapeWindow: whole view fits → tape is static", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(50, 100, 0, 20, 0), 0);
  assertEquals(tapeWindow(100, 100, 40, 60, 0), 0);
});

Deno.test("tapeWindow: wave mid-tape → tape holds (hysteresis)", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // capacity 100, view 1000, tape at 200, margin 25 → wave inside
  // [225, 275+... ] holds
  assertEquals(tapeWindow(1000, 100, 230, 240, 200), 200);
});

Deno.test("tapeWindow: wave at the right edge → tape re-centers on it", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // tape 0..99, margin 25 → wave ending past 75 triggers re-center:
  // center of [70,78] = 74, minus capacity/2 (50) = 24
  assertEquals(tapeWindow(1000, 100, 70, 78, 0), 24);
});

Deno.test("tapeWindow: wave at the left edge → tape re-centers, clamped at 0", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  // tape 100..199, margin 25 → wave starting before 125 triggers re-center
  const next = tapeWindow(1000, 100, 100, 110, 100);
  assertEquals(next, 105 - 50); // center(105) - 50 = 55
});

Deno.test("tapeWindow: the tape clamps at the list end", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(300, 100, 280, 295, 150), 200); // maxStart = 200
});

Deno.test("tapeWindow: zero capacity is safe", async () => {
  const { tapeWindow } = await import("../client/js/rail.mjs");
  assertEquals(tapeWindow(1000, 0, 0, 0, 0), 0);
});

// --- images.fillSize ----------------------------------------------------------

Deno.test("images.fillSize: HEAD probe fills the byte size on the right entry", async () => {
  const { api } = await import("../client/js/api.mjs");
  // the store mirrors the pointer into the URL — stub the two browser
  // globals for this process (no DOM in the unit suite)
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  // fake the engine surface the store talks to (the module object is shared
  // — patched per test, restored after)
  const origEntries = api.entries;
  const origProbe = api.entrySizeProbe;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  api.entries = async () => [
    { name: "a.png", size: null, hash: null, state: "seen", meta: null, extracted: false, judgment: null, width: 100, height: 50 },
  ];
  api.entrySizeProbe = async (collection, name) => {
    assertEquals([collection, name], ["h", "a.png"]);
    return 12345;
  };
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  try {
    await store.actions.hosts.select("h");
    assertEquals(store.state.images.length, 1);
    assertEquals(store.state.images[0].size, null);
    await store.actions.images.fillSize("h:a.png");
    assertEquals(store.state.images[0].size, 12345);
    // a second call with a known size is a no-op (no probe fired)
    let probes = 0;
    api.entrySizeProbe = async () => { probes++; return 999; };
    await store.actions.images.fillSize("h:a.png");
    assertEquals(probes, 0);
    assertEquals(store.state.images[0].size, 12345);
  } finally {
    api.entries = origEntries;
    api.entrySizeProbe = origProbe;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- current-pointer visibility invariant -----------------------------------

Deno.test("current: a hidden current advances to the next visible entry (one guard, not per-action)", async () => {
  const { api } = await import("../client/js/api.mjs");
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  const origEntries = api.entries;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  const origSetJudgment = api.setJudgment;
  api.entries = async () => ["a.png", "b.png", "c.png", "d.png"].map((name) => ({
    name, size: 1, hash: null, state: "seen", meta: null, extracted: false, judgment: null, width: 100, height: 50,
  }));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.setJudgment = async () => ({});
  try {
    await store.actions.hosts.select("h");
    const img = (n) => store.state.images.find((i) => i.filename === n);

    // current on b.png; down-vote it (downvoteHides is on by default) →
    // the pointer advances to the NEXT visible entry
    store.actions.current.set("h", "b.png");
    await store.actions.judgments.setVote(img("b.png").id, "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote the LAST visible entry → the pointer walks back to the previous
    store.actions.current.set("h", "d.png");
    await store.actions.judgments.setVote(img("d.png").id, "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote a NON-current card → the pointer does not move
    await store.actions.judgments.setVote(img("a.png").id, "down");
    assertEquals(store.state.current(), { remote: "h", image: "c.png" });

    // down-vote the last visible one → nothing left → pointer clears
    await store.actions.judgments.setVote(img("c.png").id, "down");
    assertEquals(store.state.current(), null);
  } finally {
    api.entries = origEntries;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    api.setJudgment = origSetJudgment;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- independent bookmarks and in-flight judgment writes -------------------

async function withBookmarkStore(run) {
  const { api } = await import("../client/js/api.mjs");
  const saved = { ...api };
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  let names = ["a.png", "b.png"];
  api.entries = async () => names.map((name) => ({
    name, size: 1, hash: null, state: "seen", meta: null, extracted: false,
    judgment: { favorite: true, vote: "up" }, width: 100, height: 50,
  }));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.collections = async () => ({ h: { address: "h:1", kind: "comfy", online: true },
    other: { address: "other:1", kind: "comfy", online: true } });
  api.activity = async () => ({ supported: false });
  try {
    await store.actions.hosts.refresh();
    await store.actions.hosts.select("h");
    await run(store, api, (next) => { names = next; });
  } finally {
    store.dispose(); store.actions.status.clear("transient");
    Object.assign(api, saved);
    delete globalThis.location;
    delete globalThis.history;
  }
}

Deno.test("bookmark: immediate independent toggle, ordered writes, latest intent survives refresh", async () => {
  await withBookmarkStore(async (store, api, list) => {
    const requests = [];
    api.setJudgment = (host, file, patch) => new Promise((resolve) => {
      requests.push({ host, file, patch, resolve });
    });
    const a = store.state.images[0];
    const first = store.actions.judgments.toggleBookmark(a.id);
    assertEquals(a.judgment.bookmark, true, "bookmark flips before the request completes");
    assertEquals(a.judgment.favorite, true);
    assertEquals(a.judgment.vote, "up");
    const second = store.actions.judgments.toggleBookmark(a.id);
    assertEquals(a.judgment.bookmark, undefined);
    await Promise.resolve();
    assertEquals(requests.length, 1, "rapid toggles serialize for this entry");
    assertEquals(requests[0].patch, { bookmark: true });
    list(["new.png", "a.png", "b.png"]);
    await store.actions.ui.refresh();
    assertEquals(store.state.images[1].judgment.bookmark, undefined);
    requests[0].resolve({});
    await first;
    await Promise.resolve();
    assertEquals(requests.length, 2);
    assertEquals(requests[1].patch, { bookmark: null });
    requests[1].resolve({});
    await second;
    assertEquals(store.state.images[1].judgment.bookmark, undefined);
    assertEquals(store.state.images[1].judgment.favorite, true);
  });
});

Deno.test("bookmark: rollback re-resolves identity after prepend and does not touch another host", async () => {
  await withBookmarkStore(async (store, api, list) => {
    let reject;
    api.setJudgment = () => new Promise((_, no) => { reject = no; });
    const write = store.actions.judgments.toggleBookmark(store.state.images[0].id);
    await Promise.resolve();
    list(["new.png", "a.png", "b.png"]);
    await store.actions.ui.refresh();
    assertEquals(store.state.images[1].judgment.bookmark, true, "refresh preserves the pending flag");
    reject(new Error("offline"));
    await write;
    assertEquals(store.state.images[1].judgment.bookmark, undefined);
    assertEquals(store.state.images[0].judgment.bookmark, undefined);
    assert(store.state.chips.some((c) => c.kind === "error" && c.msg.includes("bookmark failed")));

    const outgoing = store.actions.judgments.toggleBookmark(store.state.images[1].id);
    await Promise.resolve();
    await store.actions.hosts.select("other");
    reject(new Error("offline again"));
    await outgoing;
    assert(store.state.images.every((im) => im.host === "other" && !im.judgment.bookmark));
  });
});

Deno.test("bookmark: a superseded failure cannot undo a later toggle; latest failure restores confirmed state", async () => {
  await withBookmarkStore(async (store, api) => {
    const pending = [];
    api.setJudgment = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    const a = store.state.images[0];
    const first = store.actions.judgments.toggleBookmark(a.id);
    const second = store.actions.judgments.toggleBookmark(a.id);
    const third = store.actions.judgments.toggleBookmark(a.id);
    await Promise.resolve();
    pending[0].reject(new Error("first failed"));
    await first;
    await Promise.resolve();
    assertEquals(a.judgment.bookmark, true, "a stale failure leaves the newest intent intact");
    pending[1].resolve({});
    await second;
    await Promise.resolve();
    pending[2].reject(new Error("last failed"));
    await third;
    assertEquals(a.judgment.bookmark, undefined, "latest failure restores the last successful write");
    assertEquals(a.judgment.favorite, true);
  });
});

Deno.test("bookmark: a listing started before the toggle cannot overwrite its completed save", async () => {
  await withBookmarkStore(async (store, api) => {
    let deliver;
    const stale = store.state.images.map((im) => ({
      name: im.filename, size: im.size, width: im.width, height: im.height,
      meta: null, extracted: false, judgment: { favorite: true, vote: "up" },
    }));
    api.entries = () => new Promise((resolve) => { deliver = resolve; });
    api.setJudgment = async () => ({});
    const read = store.actions.ui.refresh();
    while (!deliver) await Promise.resolve();
    await store.actions.judgments.toggleBookmark(store.state.images[0].id);
    deliver(stale);
    await read;
    assertEquals(store.state.images[0].judgment.bookmark, true);
    api.entries = async () => stale;
    await store.actions.ui.refresh();
    assertEquals(store.state.images[0].judgment.bookmark, undefined,
      "a later fresh server read remains authoritative");
  });
});

Deno.test("bookmark: a listing started during the pending save cannot restore stale server state", async () => {
  await withBookmarkStore(async (store, api) => {
    let finish, deliver;
    const stale = store.state.images.map((im) => ({
      name: im.filename, size: im.size, width: im.width, height: im.height,
      meta: null, extracted: false, judgment: { favorite: true, vote: "up" },
    }));
    api.setJudgment = () => new Promise((resolve) => { finish = resolve; });
    const write = store.actions.judgments.toggleBookmark(store.state.images[0].id);
    await Promise.resolve();
    api.entries = () => new Promise((resolve) => { deliver = resolve; });
    const read = store.actions.ui.refresh();
    while (!deliver) await Promise.resolve();
    finish({});
    await write;
    deliver(stale);
    await read;
    assertEquals(store.state.images[0].judgment.bookmark, true);
  });
});

// --- refresh: merge new arrivals, never a wipe --------------------------------

Deno.test("refresh merges new entries into the feed — no wipe, pointer and nodes survive", async () => {
  const { api } = await import("../client/js/api.mjs");
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  const origEntries = api.entries;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  const origCollections = api.collections;
  const entry = (name) => ({
    name, size: 1, hash: null, state: "seen", meta: null, extracted: false,
    judgment: null, width: 100, height: 50,
  });
  let list = ["a.png", "b.png", "c.png"];
  api.entries = async () => list.map(entry);
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.collections = async () => ({ h: { address: "h:1", kind: "comfy", online: true } });
  try {
    await store.actions.hosts.refresh();
    await store.actions.hosts.select("h");
    const before = store.state.images;
    const aNode = before[0];
    const currentId = store.state.currentEntry()?.entry?.id;
    assertEquals(store.state.feedMergeNonce(), 0);
    // two new arrivals at the top of the server's listing
    list = ["new1.png", "new2.png", "a.png", "b.png", "c.png"];
    await store.actions.ui.refresh();
    // merged, not wiped: the new entries prepended, the old entry's store
    // node is the SAME reference (no remount), the count grew
    assertEquals(store.state.images.length, 5);
    assertEquals(store.state.images.map((i) => i.filename), ["new1.png", "new2.png", "a.png", "b.png", "c.png"]);
    assert(store.state.images[2] === aNode, "unchanged entries keep their store nodes — no remount");
    // the current pointer is id-keyed: it follows its entry through the merge
    assertEquals(store.state.currentEntry()?.entry?.id, currentId);
    // the merge nonce moved (the feed's above-fold compensation keys off it)
    assertEquals(store.state.feedMergeNonce(), 1);
  } finally {
    api.entries = origEntries;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    api.collections = origCollections;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- compensation belongs to the loaded feed ------------------------------

Deno.test("feed: compensation preserves current but cannot suppress the new collection's scroll", async () => {
  await withBookmarkStore(async (store, api) => {
    api.setSettings = async () => ({});
    const col = { scrollTop: 0, clientHeight: 100 };
    store.actions.feed.register({
      scrollEl: col,
      virtualizer: {
        scrollToIndex() {},
        getVirtualItems: () => store.state.images.map((im, index) => ({
          key: im.id, index, start: index * 100, end: (index + 1) * 100,
        })),
      },
    });
    const settled = async () => {
      for (let i = 0; i < 100 && store.state.feedActivity() !== "settled"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assertEquals(store.state.feedActivity(), "settled");
      store.state.window.freeze();
    };
    try {
      store.actions.current.set("h", "a.png");
      store.actions.feed.compensating();
      col.scrollTop = 110;
      store.actions.feed.scrolled(col.scrollTop);
      await settled();
      assertEquals(store.state.current(), { remote: "h", image: "a.png" },
        "compensation in the same feed preserves its current entry");

      store.actions.feed.compensating();
      col.scrollTop = 120;
      store.actions.feed.scrolled(col.scrollTop);
      await store.actions.hosts.select("other");
      store.actions.current.set("other", "a.png");
      col.scrollTop = 110;
      store.actions.feed.scrolled(col.scrollTop);
      await settled();
      assertEquals(store.state.current(), { remote: "other", image: "b.png" },
        "the new feed's first scroll selects its viewport entry");
    } finally {
      store.state.window.freeze();
    }
  });
});

// --- the src window on a sparse known list ---------------------------------

Deno.test("src window: a rendered card gets its src even when its image index is far from its feed position", async () => {
  const { api } = await import("../client/js/api.mjs");
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const store = makeAppStore();
  const origEntries = api.entries;
  const origMeta = api.meta;
  const origWant = api.want;
  const origNodes = api.nodes;
  // 30 entries; dims known only for image indices 0, 25, 28 — a SPARSE
  // known list: image index ≠ feed position
  api.entries = async () => Array.from({ length: 30 }, (_, i) => ({
    name: `f${i}.png`, size: 1, hash: null, state: "seen", meta: null, extracted: false,
    judgment: null,
    width: [0, 25, 28].includes(i) ? 100 : null,
    height: [0, 25, 28].includes(i) ? 50 : null,
  }));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  try {
    await store.actions.hosts.select("h");
    assertEquals(store.state.entriesWithKnownSize(), [0, 25, 28]);
    assertEquals(store.state.feedPositionOf("h:f28.png"), 2);
    // the rendered window covers feed positions 1..2; its bounds pad to
    // [0, 12] in FEED POSITIONS — a membership check in image indices would
    // wrongly exclude image index 28 (> 12)
    store.actions.feed.register({
      virtualizer: {
        getVirtualItems: () => [
          { index: 1, start: 0, end: 100, key: "h:f25.png" },
          { index: 2, start: 100, end: 200, key: "h:f28.png" },
        ],
      },
      scrollEl: null,
    });
    const img = store.state.images[28];
    // the settle-driven window: nothing fires until a settle ripples out
    // from the anchor — settle(anchor=2, cover 1..2) covers pos 2 in step 0
    store.state.window.settle(2, 1, 2);
    const src = store.state.window.getSrc(store.state.feedPositionOf(img.id), img);
    assert(src && src.includes(encodeURIComponent("f28.png")), `rendered card must get its src, got ${src}`);
  } finally {
    api.entries = origEntries;
    api.meta = origMeta;
    api.want = origWant;
    api.nodes = origNodes;
    delete globalThis.location;
    delete globalThis.history;
  }
});

// --- the image-src window: settle ripple, freeze, in-flight preservation ---

Deno.test("image window: settle ripples C, C+1, C-1, … and freeze stops it", async () => {
  const { makeImageWindow } = await import("../client-solid/store/image-window.js");
  const w = makeImageWindow({
    entryAt: (p) => ({ id: `e${p}`, host: "h", filename: `f${p}.png` }),
    count: () => 11,
    rippleMs: 10,
  });
  const has = (p) => w.getSrc(p, { id: `e${p}`, host: "h", filename: `f${p}.png` }) != null;
  w.settle(5, 0, 10);
  assert(has(5), "C fires first");
  assert(!has(6) && !has(4), "neighbors have not fired yet");
  await new Promise((r) => setTimeout(r, 16));   // ring 1
  assert(has(6), "C+1 fires before C-1");
  assert(!has(4), "C-1 has not fired yet");
  await new Promise((r) => setTimeout(r, 16));   // ring 2
  assert(has(4), "C-1 fires next");
  w.freeze();
  const wasAt9 = has(9);
  await new Promise((r) => setTimeout(r, 120));
  assertEquals(has(9), wasAt9, "a frozen window fires no further rings");
  assert(has(5) && has(6) && has(4), "members stay assigned through a freeze");
});

Deno.test("image window: a started load survives the next settle; a loaded one is reaped", async () => {
  const { makeImageWindow } = await import("../client-solid/store/image-window.js");
  const w = makeImageWindow({
    entryAt: (p) => ({ id: `e${p}`, host: "h", filename: `f${p}.png` }),
    count: () => 30,
    rippleMs: 5,
  });
  const has = (p) => w.getSrc(p, { id: `e${p}`, host: "h", filename: `f${p}.png` }) != null;
  w.settle(5, 4, 6);
  w.markStarted("e5");            // the card's loading phase reports a start
  w.settle(20, 19, 21);           // a far-away settle (big scroll)
  assert(has(5), "the started id stays a member across re-windows");
  assert(has(20), "the new anchor is covered");
  w.markLoaded("e5");
  w.settle(22, 21, 23);
  assert(!has(5), "a loaded id is reaped by the next settle");
});

// --- the drag primitive's anchor-edge fraction -------------------------------

Deno.test("fracFor: the fraction measures from the sized column's anchor edge", async () => {
  const { fracFor } = await import("../client-solid/lib/drag.js");
  const box = { left: 100, right: 500, top: 50, bottom: 250, width: 400, height: 200 };
  // anchored left ("x"): pointer at the right quarter of the box
  assertEquals(fracFor(box, { clientX: 200 }, "x"), 0.25);
  // anchored right ("x-" — a rev layout): the same pointer is 0.75 from the right
  assertEquals(fracFor(box, { clientX: 200 }, "x-"), 0.75);
  // anchored top ("y") and bottom ("y-")
  assertEquals(fracFor(box, { clientY: 100 }, "y"), 0.25);
  assertEquals(fracFor(box, { clientY: 100 }, "y-"), 0.75);
  // a snapped pane rect (the sized element's own box, not the container's)
  const pane = { left: 300, right: 500, top: 0, bottom: 200, width: 200, height: 200 };
  assertEquals(fracFor(pane, { clientX: 400 }, "x-"), 0.5);
});

// --- deletion navigation ------------------------------------------------------

Deno.test("planDeleteCurrent: previous current iff adjacent, else feed-above, else topmost", async () => {
  const { planDeleteCurrent } = await import("../client/js/route-parse.mjs");
  const imgs = ["a", "b", "c", "d", "e"].map((f) => ({ host: "h", filename: f }));
  const cur = (f) => ({ remote: "h", image: f });
  const prev = (f) => (f ? { remote: "h", image: f } : null);

  // current not among the deleted → nothing to do
  assertEquals(planDeleteCurrent(imgs, new Set(["d"]), "h", cur("a"), prev("b")), null);
  // previous current adjacent to the deleted one (either side) → pop
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), prev("b")), { kind: "pop" });
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), prev("d")), { kind: "pop" });
  // previous current exists but NOT adjacent → nearest surviving above
  assertEquals(planDeleteCurrent(imgs, new Set(["d"]), "h", cur("d"), prev("a")), { kind: "set", image: "c" });
  // no previous current → nearest surviving above
  assertEquals(planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), null), { kind: "set", image: "b" });
  // nothing above → the new topmost
  assertEquals(planDeleteCurrent(imgs, new Set(["a"]), "h", cur("a"), null), { kind: "set", image: "b" });
  // bulk: the image above is deleted too → walk further up
  assertEquals(planDeleteCurrent(imgs, new Set(["b", "c"]), "h", cur("c"), null), { kind: "set", image: "a" });
  // previous current adjacent but deleted itself → feed rule, not pop
  assertEquals(planDeleteCurrent(imgs, new Set(["b", "c"]), "h", cur("c"), prev("b")), { kind: "set", image: "a" });
  // everything gone → clear
  assertEquals(planDeleteCurrent(imgs, new Set(["a", "b", "c", "d", "e"]), "h", cur("c"), null), { kind: "clear" });
  // a cross-host previous current is never "next to" the deleted one
  assertEquals(
    planDeleteCurrent(imgs, new Set(["c"]), "h", cur("c"), { remote: "other", image: "b" }),
    { kind: "set", image: "b" },
  );
});

const deferredSourceRead = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function withSourceStore(run, { initialUnknown = false } = {}) {
  const { api } = await import("../client/js/api.mjs");
  const saved = { ...api }, location = globalThis.location, history = globalThis.history;
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  const sources = { h: { address: "h:1", online: true, kind: "comfy", pinned: false, autoRefresh: true },
    other: { address: "other:1", online: true, kind: "comfy", pinned: false, autoRefresh: true } };
  const activity = { h: { supported: true, state: "idle", epoch: "E", terminalRevision: 0, resyncRevision: 0 },
    other: { supported: true, state: "idle", epoch: "F", terminalRevision: 0, resyncRevision: 0 } };
  if (initialUnknown) Object.assign(activity.h, { state: "unknown", sampledAt: null });
  const row = (name, extra = {}) => ({ name, size: null, hash: null, width: 100, height: 50,
    meta: null, judgment: null, extracted: false, ...extra });
  const lists = { h: [row("a.png"), row("b.png")], other: [row("other.png")] };
  api.collections = async () => structuredClone(sources);
  api.activity = async (id) => ({ ...activity[id], pinned: sources[id].pinned, autoRefresh: sources[id].autoRefresh });
  api.patchCollection = async (id, patch) => { Object.assign(sources[id], patch); return { ...sources[id] }; };
  api.entries = async (id) => structuredClone(lists[id]);
  api.meta = async () => ({ v: 1, changed: false, pending: 0 });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.settings = async () => ({});
  api.setSettings = async () => ({});
  api.prefetch = async () => ({ pending: {} });
  const store = makeAppStore({ pollActivity: false });
  try {
    await store.actions.boot();
    await run({ store, api, sources, activity, lists, row });
  } finally {
    store.dispose();
    store.actions.status.clear("transient");
    Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
  }
}

Deno.test("source flags: confirmed independent serialized writer and stale collection/activity fences", async () => {
  await withSourceStore(async ({ store, api, sources }) => {
    const collection = deferredSourceRead(), telemetry = deferredSourceRead(), writes = [];
    api.collections = () => collection.promise;
    const read = store.actions.hosts.refresh();
    api.activity = () => telemetry.promise;
    const poll = store.actions.hosts.pollActivity("h");
    api.patchCollection = (id, patch) => {
      const pending = deferredSourceRead(); writes.push({ id, patch, ...pending }); return pending.promise;
    };
    const pin = store.actions.hosts.patch("h", { pinned: true });
    const refreshOff = store.actions.hosts.patch("h", { autoRefresh: false });
    assertEquals(store.state.hosts.h.pinned, false, "render only confirmed flags");
    assertEquals(store.state.sourceSaving.h, true);
    await Promise.resolve();
    assertEquals(writes.length, 1);
    writes[0].resolve({ pinned: true, autoRefresh: true });
    await pin;
    await Promise.resolve();
    assertEquals(writes[1].patch, { autoRefresh: false });
    writes[1].resolve({ pinned: true, autoRefresh: false });
    await refreshOff;
    collection.resolve(sources);
    telemetry.resolve({ supported: true, epoch: "E", terminalRevision: 0, resyncRevision: 0, pinned: false, autoRefresh: true });
    await Promise.all([read, poll]);
    assertEquals([store.state.hosts.h.pinned, store.state.hosts.h.autoRefresh], [true, false]);
    assertEquals(store.state.sourceSaving.h, undefined);
    api.patchCollection = async () => { throw new Error("offline"); };
    assertEquals((await store.actions.hosts.patch("h", { pinned: false })).ok, false);
    assertEquals(store.state.hosts.h.pinned, true);
    assert(store.state.chips.some((c) => c.kind === "error" && c.msg.includes("source h save failed")));
  });
});

Deno.test("source refresh: completion during listing retains a follow-up, coalesces and preserves user state", async () => {
  await withSourceStore(async ({ store, api, activity, row }) => {
    const original = store.state.images[0], reads = [];
    store.actions.selected.set(original.id, true);
    store.actions.ui.setFilter(".png");
    store.actions.views.set(original.id, { s: 2 }, { persist: false });
    store.actions.diff.setMode("split");
    store.actions.diff.setSplit(.4);
    const current = store.state.current(), trail = [...store.state.currentStack()];
    api.entries = () => { const read = deferredSourceRead(); reads.push(read); return read.promise; };
    activity.h.terminalRevision = 1;
    await store.actions.hosts.pollActivity("h");
    assertEquals(reads.length, 1);
    activity.h.terminalRevision = 3;
    await store.actions.hosts.pollActivity("h");
    assertEquals(reads.length, 1, "one refresh flight per loaded source session");
    reads[0].resolve([row("first.png"), row("a.png"), row("b.png")]);
    for (let i = 0; i < 30 && reads.length < 2; i++) await Promise.resolve();
    assertEquals(reads.length, 2);
    reads[1].resolve([row("second.png"), row("first.png"), row("a.png"), row("b.png")]);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assertEquals(store.state.images.map((i) => i.filename), ["second.png", "first.png", "a.png", "b.png"]);
    assert(store.state.images[2] === original);
    assertEquals(store.state.selected[original.id], true);
    assertEquals(store.state.current(), current);
    assertEquals(store.state.currentStack(), trail);
    assertEquals(store.state.filter(), ".png");
    assertEquals(store.state.views[original.id].s, 2);
    assertEquals([store.state.diff.mode, store.state.diff.splitT], ["split", .4]);
    assertEquals(store.state.feedMergeNonce(), 2);
  });
});

Deno.test("source refresh: failed target retries, disabled/unselected sources never merge or select", async () => {
  await withSourceStore(async ({ store, api, activity, sources, lists, row }) => {
    let reads = 0;
    api.entries = async (id) => { reads++; if (reads === 1) throw new Error("listing offline"); return lists[id]; };
    lists.h.unshift(row("new.png"));
    activity.h.terminalRevision++;
    await store.actions.hosts.pollActivity("h");
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert(!store.state.images.some((i) => i.filename === "new.png"));
    await store.actions.ui.refresh();
    assert(store.state.images.some((i) => i.filename === "new.png"));
    await store.actions.hosts.pollActivity("other");
    lists.other.unshift(row("other-new.png"));
    activity.other.terminalRevision++;
    await store.actions.hosts.pollActivity("other");
    assertEquals(store.state.host(), "h");
    assert(store.state.images.every((i) => i.host === "h"));
    sources.h.autoRefresh = false;
    activity.h.terminalRevision++;
    lists.h.unshift(row("disabled.png"));
    await store.actions.hosts.pollActivity("h");
    assert(!store.state.images.some((i) => i.filename === "disabled.png"));
    await store.actions.ui.refresh();
    assert(store.state.images.some((i) => i.filename === "disabled.png"));
    await store.actions.hosts.select("other");
    assertEquals(store.state.images[0].filename, "other-new.png");
  });
});

for (const roundTrip of [false, true]) {
  Deno.test(`source fences: stale load, refresh, want, meta and size after A→B${roundTrip ? "→A" : ""}`, async () => {
    await withSourceStore(async ({ store, api, lists }) => {
      const listing = deferredSourceRead(), metadata = deferredSourceRead(), size = deferredSourceRead();
      const collections = deferredSourceRead();
      api.collections = () => collections.promise;
      const manualBeforeSwitch = store.actions.ui.refresh();
      api.entrySizeProbe = () => size.promise;
      const sizing = store.actions.images.fillSize("h:a.png");
      api.entries = (id) => id === "h" ? listing.promise : Promise.resolve(lists[id]);
      api.meta = (id) => id === "h" ? metadata.promise : Promise.resolve({ changed: false, pending: 0 });
      const loading = store.actions.images.reload();
      await store.actions.hosts.select("other");
      if (roundTrip) {
        api.entries = async (id) => lists[id];
        api.meta = async () => ({ changed: false, pending: 0 });
        await store.actions.hosts.select("h");
      }
      listing.resolve([{ name: "stale.png", width: 10, height: 10 }]);
      metadata.resolve({ changed: true, v: 10, pending: 12, items: { "a.png": { seed: 999 } } });
      size.resolve(999);
      collections.resolve({ h: { address: "h:1" }, other: { address: "other:1" } });
      await Promise.all([manualBeforeSwitch, loading, sizing]);
      assertEquals(store.state.images.map((i) => i.filename), roundTrip ? ["a.png", "b.png"] : ["other.png"]);
      assertEquals(store.state.images[0].size, null);
      assertEquals(store.state.metaPending, 0);
      assertEquals(store.state.images[0].meta, null);
    });
  });
}

Deno.test("source enrichment: size probe re-resolves inserted identity; known content replacement cannot inherit old dims/meta", async () => {
  await withSourceStore(async ({ store, api, lists, row }) => {
    const probe = deferredSourceRead();
    api.entrySizeProbe = () => probe.promise;
    const sizing = store.actions.images.fillSize("h:a.png");
    lists.h.unshift(row("new.png"));
    await store.actions.ui.refresh();
    probe.resolve(123);
    await sizing;
    assertEquals(store.state.images[0].size, null);
    assertEquals(store.state.images[1].size, 123);
    lists.h[1] = row("a.png", { hash: "old", meta: { seed: 1 } });
    await store.actions.ui.refresh();
    lists.h[1] = row("a.png", { hash: "different", width: null, height: null });
    await store.actions.ui.refresh();
    assertEquals(store.state.images[1].hash, "different");
    assertEquals(store.state.images[1].width, null);
    assertEquals(store.state.images[1].meta, null);
  });
});

for (const channel of ["metadata", "want"]) {
  for (const roundTrip of [false, true]) {
    Deno.test(`source ${channel}: actual in-flight response is fenced across A→B${roundTrip ? "→A" : ""}`, async () => {
      await withSourceStore(async ({ store, api }) => {
        const pending = deferredSourceRead();
        let started = false;
        if (channel === "metadata") {
          api.meta = (id) => {
            if (id !== "h") return Promise.resolve({ changed: false, pending: 0 });
            started = true; return pending.promise;
          };
        } else {
          api.want = (id) => {
            if (id !== "h") return Promise.resolve({ pending: 0 });
            started = true; return pending.promise;
          };
        }
        const read = store.actions.ui.refresh();
        for (let i = 0; i < 40 && !started; i++) await Promise.resolve();
        assert(started, "the old source request really reached the channel");
        await store.actions.hosts.select("other");
        api.meta = async () => ({ changed: false, pending: 0 });
        api.want = async () => ({ pending: 0 });
        if (roundTrip) await store.actions.hosts.select("h");
        pending.resolve(channel === "metadata" ? {
          changed: true, v: 100, pending: 500, items: { "a.png": { seed: 999 } }, dims: { "a.png": { width: 999, height: 999 } },
        } : { pending: 500 });
        await read;
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assertEquals(store.state.metaPending, 0);
        assertEquals(store.state.images[0].meta, null);
        assertEquals(store.state.images[0].width, 100);
        assertEquals(store.state.images[0].host, roundTrip ? "h" : "other");
      });
    });
  }
}

Deno.test("source enrichment: metadata learned through polling during a listing survives the older same-content result", async () => {
  await withSourceStore(async ({ store, api, lists, row }) => {
    lists.h = [row("a.png", { hash: "same-content", width: null, height: null }), row("b.png")];
    const stale = structuredClone(lists.h);
    api.want = async () => ({ pending: 1 });
    api.meta = async () => ({ changed: false });
    await store.actions.images.reload();
    const listing = deferredSourceRead();
    let started = false;
    api.entries = () => { started = true; return listing.promise; };
    api.meta = async () => ({ changed: true, v: 2, pending: 0,
      items: { "a.png": { seed: 77 } }, dims: { "a.png": { width: 128, height: 64 } } });
    const refresh = store.actions.ui.refresh();
    for (let i = 0; i < 40 && !started; i++) await Promise.resolve();
    assert(started);
    for (let i = 0; i < 150 && store.state.images[0].width !== 128; i++) await new Promise((r) => setTimeout(r, 20));
    assertEquals(store.state.images[0].width, 128, "source-owned metadata poll delivers enrichment before the listing completes");
    listing.resolve(stale);
    await refresh;
    assertEquals(store.state.images[0].meta, { seed: 77 });
    assertEquals([store.state.images[0].width, store.state.images[0].height], [128, 64]);
  });
});

Deno.test("source activity: engine epoch/recovery changes catch up the selected feed", async () => {
  await withSourceStore(async ({ store, activity, lists, row }) => {
    lists.h.unshift(row("recovered.png"));
    activity.h.epoch = "replacement-engine";
    await store.actions.hosts.pollActivity("h");
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assertEquals(store.state.images[0].filename, "recovered.png");
    lists.h.unshift(row("gap-catchup.png"));
    activity.h.resyncRevision++;
    await store.actions.hosts.pollActivity("h");
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assertEquals(store.state.images[0].filename, "gap-catchup.png");
  });
});

Deno.test("source activity: first known snapshot after the initial listing catches up without inventing terminal revisions", async () => {
  await withSourceStore(async ({ store, activity, lists, row }) => {
    assertEquals(store.state.sourceActivity.h.state, "unknown");
    lists.h.unshift(row("during-startup-baseline.png"));
    activity.h.state = "idle"; activity.h.sampledAt = 1;
    await store.actions.hosts.pollActivity("h");
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assertEquals(store.state.images[0].filename, "during-startup-baseline.png");
    assertEquals(store.state.sourceActivity.h.terminalRevision, 0);
  }, { initialUnknown: true });
});

Deno.test("source lifecycle: an old activity response cannot configure a removed/re-added source ID", async () => {
  await withSourceStore(async ({ store, api, sources }) => {
    const old = deferredSourceRead();
    const activity = api.activity;
    api.activity = (id) => id === "h" ? old.promise : activity(id);
    const poll = store.actions.hosts.pollActivity("h");
    api.removeCollection = async (id) => { delete sources[id]; return { removed: id }; };
    await store.actions.hosts.remove("h");
    api.addCollection = async (id, address) => {
      sources[id] = { address, kind: "comfy", online: true, pinned: false, autoRefresh: false };
      return sources[id];
    };
    await store.actions.hosts.add("h", "h:1");
    old.resolve({ supported: true, state: "running", epoch: "obsolete", terminalRevision: 99,
      resyncRevision: 99, pinned: true, autoRefresh: true });
    await poll;
    assertEquals([store.state.hosts.h.pinned, store.state.hosts.h.autoRefresh], [false, false]);
    assertEquals(store.state.sourceActivity.h, undefined);
    assertEquals(store.state.host(), "other");
  });
});
