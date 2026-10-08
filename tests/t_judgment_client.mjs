import { assert, assertEquals } from "jsr:@std/assert";
import { makeAppStore } from "../client-solid/store/app-store.js";
import { api } from "../client/js/api.mjs";
import { makeJudgments } from "../client-solid/store/judgments.js";
import { clientInventory } from "./helpers/client-inventory.mjs";

const initial = { vote: "up", favorite: true, bookmark: true, notes: { pos: "saved", neg: "old" } };
const changed = { vote: "down", favorite: null, bookmark: null, notes: { pos: "edited" } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => Promise.resolve();
const set = (field, value) => ({ type: "set", patch: { [field]: value } });
const local = (value) => value ?? undefined;

async function withStore(run, judgment = initial) {
  const saved = { ...api };
  const location = globalThis.location, history = globalThis.history;
  globalThis.location = { hash: "", pathname: "/" };
  globalThis.history = { state: null, replaceState() {}, pushState() {} };
  let names = ["a.png", "b.png"];
  const listing = () => names.map((name) => ({
    name, size: 1, hash: null, state: "seen", meta: null, extracted: false,
    judgment: structuredClone(judgment), width: 100, height: 50,
  }));
  api.entries = async () => listing();
  api.inventory = async (...args) => clientInventory(await api.entries(...args));
  api.meta = async () => ({ v: 1, changed: false });
  api.want = async () => ({ pending: 0 });
  api.nodes = async () => ({});
  api.collections = async () => ({ h: { address: "folder:/fixture/h", kind: "folder", online: true },
    other: { address: "other:1", kind: "comfy", online: true } });
  api.activity = async () => ({ supported: false });
  api.setSettings = async () => ({});
  api.setJudgment = async () => ({});
  const store = makeAppStore();
  const requests = [];
  const holdWrites = () => {
    api.setJudgment = (host, file, patch) => {
      const request = { host, file, patch, ...deferred() };
      requests.push(request);
      return request.promise;
    };
  };
  try {
    await store.actions.hosts.refresh();
    await store.actions.hosts.select("h");
    await run({ store, requests, holdWrites, listing, list: (next) => { names = next; } });
  } finally {
    store.dispose(); store.actions.status.clear("transient");
    Object.assign(api, saved);
    if (location === undefined) delete globalThis.location; else globalThis.location = location;
    if (history === undefined) delete globalThis.history; else globalThis.history = history;
  }
}

Deno.test("judgment intent: up and down toggle off; named vote setter remains non-toggling", async () => {
  await withStore(async ({ store }) => {
    const { dispatch, setVote, toggleFavorite, toggleBookmark, saveNotes } = store.actions.judgments;
    const id = "h:a.png", judgment = () => store.state.images[0].judgment;
    assertEquals(await dispatch(id, { type: "toggle", field: "vote", value: "up" }), { ok: true });
    assertEquals(judgment().vote, undefined);
    await dispatch(id, { type: "toggle", field: "vote", value: "down" });
    assertEquals(judgment().vote, "down");
    await dispatch(id, { type: "toggle", field: "vote", value: "down" });
    assertEquals(judgment().vote, undefined);
    await setVote(id, "down");
    await setVote(id, "down");
    assertEquals(judgment().vote, "down");
    await toggleFavorite(id);
    await toggleBookmark(id);
    await saveNotes(id, { pos: "new", neg: "" });
    assertEquals(judgment(), { vote: "down", notes: { pos: "new" } });
  });
});

Deno.test("judgment intent: one normalized multi-field patch, immutable note snapshot, ID-only API", async () => {
  await withStore(async ({ store, requests, holdWrites }) => {
    holdWrites();
    const notes = { pos: "new", neg: "" };
    const write = store.actions.judgments.dispatch("h:a.png", {
      type: "set", patch: { vote: null, favorite: false, bookmark: false, notes },
    });
    notes.pos = "mutated caller";
    assertEquals(store.state.images[0].judgment, { notes: { pos: "new" } });
    await tick();
    assertEquals(requests[0].patch, { vote: null, favorite: null, bookmark: null, notes: { pos: "new" } });
    requests[0].resolve({});
    assertEquals(await write, { ok: true });
    assertEquals((await store.actions.judgments.toggleFavorite(store.state.images[0])).ok, false);
    assertEquals(requests.length, 1, "image objects are not accepted as IDs");
  });
});

for (const field of Object.keys(initial)) {
  Deno.test(`judgment ${field}: older failure preserves intent, latest failure restores last success`, async () => {
    await withStore(async ({ store, requests, holdWrites }) => {
      holdWrites();
      const dispatch = store.actions.judgments.dispatch;
      const first = dispatch("h:a.png", set(field, changed[field]));
      const second = dispatch("h:a.png", set(field, initial[field]));
      const third = dispatch("h:a.png", set(field, changed[field]));
      assertEquals(store.state.images[0].judgment[field], local(changed[field]));
      await tick();
      assertEquals(requests.length, 1);
      requests[0].reject(new Error("first failed"));
      assertEquals((await first).ok, false);
      await tick();
      assertEquals(store.state.images[0].judgment[field], local(changed[field]));
      requests[1].resolve({});
      assertEquals(await second, { ok: true });
      await tick();
      requests[2].reject(new Error("last failed"));
      assertEquals((await third).ok, false);
      assertEquals(store.state.images[0].judgment[field], initial[field]);
      assert(store.state.chips.some((c) => c.kind === "error" && c.msg.includes(`${field} failed`)));
    });
  });

  Deno.test(`judgment ${field}: failed newer write restores successfully changed value, not initial baseline`, async () => {
    await withStore(async ({ store, requests, holdWrites }) => {
      holdWrites();
      const first = store.actions.judgments.dispatch("h:a.png", set(field, changed[field]));
      const second = store.actions.judgments.dispatch("h:a.png", set(field, initial[field]));
      await tick();
      requests[0].resolve({});
      await first;
      await tick();
      assertEquals(store.state.images[0].judgment[field], initial[field]);
      requests[1].reject(new Error("newer failed"));
      await second;
      assertEquals(store.state.images[0].judgment[field], local(changed[field]));
    });
  });

  Deno.test(`judgment ${field}: rollback finds original ID after prepend and host navigation`, async () => {
    await withStore(async ({ store, requests, holdWrites, list }) => {
      holdWrites();
      const write = store.actions.judgments.dispatch("h:a.png", set(field, changed[field]));
      await tick();
      list(["new.png", "a.png", "b.png"]);
      await store.actions.ui.refresh();
      assertEquals(store.state.images[1].judgment[field], local(changed[field]));
      requests[0].reject(new Error("offline"));
      await write;
      assertEquals(store.state.images[1].judgment[field], initial[field]);
      assertEquals(store.state.images[0].judgment[field], initial[field]);
      const outgoing = store.actions.judgments.dispatch("h:a.png", set(field, changed[field]));
      await tick();
      await store.actions.hosts.select("other");
      requests[1].reject(new Error("offline again"));
      await outgoing;
      assert(store.state.images.every((im) => im.host === "other"));
      assertEquals(store.state.images.map((im) => im.judgment[field]), Array(3).fill(initial[field]));
      assertEquals(requests.map(({ host, file }) => [host, file]), [["h", "a.png"], ["h", "a.png"]]);
    });
  });

  for (const timing of ["before", "during"]) {
    Deno.test(`judgment ${field}: listing begun ${timing} write cannot undo completion; fresh read authoritative`, async () => {
      await withStore(async ({ store, requests, holdWrites, listing }) => {
        const stale = listing(), read = deferred();
        holdWrites();
        api.entries = () => read.promise;
        let refresh;
        if (timing === "before") {
          refresh = store.actions.ui.refresh();
          await tick();
        }
        const write = store.actions.judgments.dispatch("h:a.png", set(field, changed[field]));
        await tick();
        if (timing === "during") {
          refresh = store.actions.ui.refresh();
          await tick();
        }
        requests[0].resolve({});
        await write;
        read.resolve(stale);
        await refresh;
        assertEquals(store.state.images[0].judgment[field], local(changed[field]));
        api.entries = async () => stale;
        await store.actions.ui.refresh();
        assertEquals(store.state.images[0].judgment[field], initial[field]);
      });
    });
  }
}

Deno.test("judgment: cross-field rollback independent, per-entry serialization does not block other entries", async () => {
  await withStore(async ({ store, requests, holdWrites }) => {
    holdWrites();
    const dispatch = store.actions.judgments.dispatch;
    const vote = dispatch("h:a.png", set("vote", "down"));
    const favorite = dispatch("h:a.png", set("favorite", null));
    const bookmark = dispatch("h:b.png", set("bookmark", null));
    await tick();
    assertEquals(requests.map(({ file }) => file), ["a.png", "b.png"]);
    requests[0].reject(new Error("vote offline"));
    await vote;
    assertEquals(store.state.images[0].judgment.vote, "up");
    assertEquals(store.state.images[0].judgment.favorite, undefined);
    await tick();
    assertEquals(requests[2].patch, { favorite: null });
    requests[1].resolve({});
    requests[2].resolve({});
    await Promise.all([favorite, bookmark]);
    assertEquals(store.state.images[0].judgment.favorite, undefined);
  });
});

Deno.test("judgment: pending vote overlays only vote; authoritative unrelated fields seed later rollback", async () => {
  await withStore(async ({ store, requests, holdWrites, listing }) => {
    holdWrites();
    const vote = store.actions.judgments.dispatch("h:a.png", set("vote", "down"));
    await tick();
    const fresh = listing();
    fresh[0].judgment.favorite = undefined;
    fresh[0].judgment.notes = { neg: "server edit" };
    api.entries = async () => fresh;
    await store.actions.ui.refresh();
    assertEquals(store.state.images[0].judgment.vote, "down");
    assertEquals(store.state.images[0].judgment.favorite, undefined);
    assertEquals(store.state.images[0].judgment.notes, { neg: "server edit" });
    const favorite = store.actions.judgments.toggleFavorite("h:a.png");
    requests[0].resolve({});
    await vote;
    await tick();
    requests[1].reject(new Error("favorite offline"));
    await favorite;
    assertEquals(store.state.images[0].judgment.favorite, undefined);
    assertEquals(store.state.images[0].judgment.notes, { neg: "server edit" });
  });
});

Deno.test("judgment: reload after navigation preserves write completion for original identity", async () => {
  await withStore(async ({ store, requests, holdWrites, listing }) => {
    holdWrites();
    const write = store.actions.judgments.dispatch("h:a.png", { type: "set", patch: changed });
    await tick();
    await store.actions.hosts.select("other");
    const read = deferred();
    api.entries = () => read.promise;
    const returning = store.actions.hosts.select("h");
    requests[0].resolve({});
    await write;
    read.resolve(listing());
    await returning;
    assertEquals(store.state.images[0].judgment, { vote: "down", notes: { pos: "edited" } });
  });
});

Deno.test("judgment: bulk and keyboard intents share ordering and capture IDs before visibility moves", async () => {
  await withStore(async ({ store, requests, holdWrites, list }) => {
    // Check the intent surface first so the red phase fails rather than waiting on old bulk writers.
    assertEquals(typeof store.actions.judgments.dispatch, "function");
    holdWrites();
    store.actions.selected.set("h:a.png", true);
    store.actions.selected.set("h:b.png", true);
    store.actions.current.set("h", "a.png");
    store.actions.keys.register({ id: "test.vote", key: "x", command: "judgment.apply",
      args: { target: "current", intent: { type: "toggle", field: "vote", value: "down" } } });
    store.actions.keys.dispatch({ key: "x", preventDefault() {} });
    const bulkVote = store.actions.bulk.vote("up");
    const bulkFavorite = store.actions.bulk.favorite();
    assertEquals(store.state.images.map((im) => im.judgment.vote), ["up", "up"]);
    store.actions.selected.set("h:a.png", false);
    list(["new.png", "a.png", "b.png"]);
    await store.actions.ui.refresh();
    await tick();
    assertEquals(requests.map(({ file, patch }) => [file, patch]), [["a.png", { vote: "down" }], ["b.png", { vote: "up" }]]);
    requests[0].resolve({});
    requests[1].resolve({});
    for (let i = 0; i < 10; i++) await tick();
    assertEquals(requests.slice(2).map(({ file, patch }) => [file, patch]), [["a.png", { vote: "up" }], ["b.png", { favorite: true }]]);
    requests[2].resolve({});
    requests[3].resolve({});
    for (let i = 0; i < 10; i++) await tick();
    assertEquals(requests[4].file, "a.png");
    requests[4].reject(new Error("favorite offline"));
    await Promise.all([bulkVote, bulkFavorite]);
    assertEquals(store.state.images.map((im) => im.filename), ["new.png", "a.png", "b.png"]);
    assert(store.state.chips.some((c) => c.kind === "info" && c.msg === "1 image favorited"), "bulk reports successful writes only");
  });
});

Deno.test("judgment notes: failed autosave keeps draft and exposes failure, retry clears only saved text", async () => {
  await withStore(async ({ store }) => {
    assertEquals(typeof store.actions.judgments.dispatch, "function");
    const id = "h:a.png";
    const save = (text) => store.actions.judgments.saveNotes(id, { pos: text });
    api.setJudgment = async () => { throw new Error("offline"); };
    store.actions.notes.setDraft(id, "pos", "unsaved", save);
    await store.actions.notes.flushDraft(id, "pos", save);
    assertEquals(store.state.drafts[`${id}:pos`], "unsaved");
    assertEquals(store.state.images[0].judgment.notes, initial.notes);
    api.setJudgment = async () => ({});
    await store.actions.notes.flushDraft(id, "pos", save);
    assertEquals(store.state.drafts[`${id}:pos`], undefined);
    assertEquals(store.state.images[0].judgment.notes, { pos: "unsaved" });
  });
});

Deno.test("judgment note intent: independent boxes merge latest pending notes through one PATCH queue", async () => {
  await withStore(async ({ store, requests, holdWrites }) => {
    holdWrites();
    const id = "h:a.png", dispatch = store.actions.judgments.dispatch;
    const positive = dispatch(id, { type: "note", sign: "pos", text: "new positive" });
    const negative = dispatch(id, { type: "note", sign: "neg", text: "new negative" });
    assertEquals(store.state.images[0].judgment.notes, { pos: "new positive", neg: "new negative" });
    await tick();
    assertEquals(requests.length, 1);
    assertEquals(requests[0].patch, { notes: { pos: "new positive", neg: "old" } });
    await store.actions.ui.refresh();
    assertEquals(store.state.images[0].judgment.notes, { pos: "new positive", neg: "new negative" });
    requests[0].resolve({});
    assertEquals(await positive, { ok: true });
    await tick();
    assertEquals(requests[1].patch, { notes: { pos: "new positive", neg: "new negative" } });
    requests[1].resolve({});
    assertEquals(await negative, { ok: true });
    assertEquals(store.state.images[0].judgment.notes, { pos: "new positive", neg: "new negative" });
    api.setJudgment = async () => ({});
    await dispatch(id, { type: "note", sign: "pos", text: "" });
    assertEquals(store.state.images[0].judgment.notes, { neg: "new negative" });
  });
});

Deno.test("judgment notes: delayed flush passes original entry ID after host switch", async () => {
  await withStore(async ({ store }) => {
    const id = "h:a.png", calls = [];
    const save = (text, originId) => {
      calls.push([text, originId]);
      return { ok: true };
    };
    store.actions.notes.setDraft(id, "pos", "outgoing draft", save);
    await store.actions.hosts.select("other");
    assertEquals(await store.actions.notes.flushDraft(id, "pos", save), { ok: true });
    assertEquals(calls, [["outgoing draft", id]]);
    assertEquals(store.state.drafts[`${id}:pos`], undefined);
    assertEquals(store.state.images[0].judgment.notes, initial.notes);
  });
});

Deno.test("judgment note intent: unloaded entry without a notes snapshot fails instead of replacing unknown notes", async () => {
  await withStore(async ({ store, requests, holdWrites }) => {
    holdWrites();
    const vote = store.actions.judgments.setVote("h:a.png", "down");
    await tick();
    await store.actions.hosts.select("other");
    let noteWrites = 0;
    api.setJudgment = async () => { noteWrites++; return {}; };
    const note = store.actions.judgments.dispatch("h:a.png", { type: "note", sign: "pos", text: "outgoing" });
    requests[0].resolve({});
    await vote;
    assertEquals((await note).ok, false);
    assertEquals(noteWrites, 0);
  });
});

Deno.test("judgment notes: debounced save passes captured entry ID after host switch", async () => {
  await withStore(async ({ store }) => {
    const id = "h:a.png", saved = deferred();
    const save = (text, originId) => {
      saved.resolve([text, originId]);
      return { ok: true };
    };
    store.actions.notes.setDraft(id, "neg", "outgoing autosave", save);
    await store.actions.hosts.select("other");
    const args = await saved.promise;
    await tick();
    assertEquals(args, ["outgoing autosave", id]);
    assertEquals(store.state.drafts[`${id}:neg`], undefined);
    assertEquals(store.state.images[0].judgment.notes, initial.notes);
  });
});

for (const reload of [false, true]) {
  Deno.test(`judgment snapshots: initially absent notes stay immutable${reload ? " through reload" : ""}`, async () => {
    await withStore(async ({ store, requests, holdWrites }) => {
      holdWrites();
      const first = store.actions.judgments.dispatch("h:a.png", { type: "note", sign: "pos", text: "confirmed" });
      await tick();
      const sent = structuredClone(requests[0].patch);
      if (reload) {
        await store.actions.hosts.select("other");
        await store.actions.hosts.select("h");
      }
      const second = store.actions.judgments.dispatch("h:a.png", { type: "note", sign: "neg", text: "failed edit" });
      requests[0].resolve({});
      await first;
      await tick();
      requests[1].reject(new Error("newer save failed"));
      await second;
      assertEquals(store.state.images[0].judgment.notes, sent.notes,
        "rollback restores the actual successful PATCH, not a later reactive mutation");
      assertEquals(requests[0].patch, sent, "queued snapshots never become reactive store backing objects");
    }, null);
  });
}

for (const mode of ["flush", "debounce"]) {
  Deno.test(`judgment retained drafts: real ${mode} saves to captured address after unload`, async () => {
    await withStore(async ({ store, list }) => {
      const file = "a:b#c.png", id = `h:${file}`, calls = [], saved = deferred();
      list([file, "b.png"]);
      await store.actions.images.reload();
      api.setJudgment = async (host, filename, patch) => { calls.push([host, filename, structuredClone(patch)]); return {}; };
      const save = (text, originId) => {
        const promise = store.actions.judgments.dispatch(originId, { type: "note", sign: "pos", text });
        promise.then(saved.resolve);
        return promise;
      };
      store.actions.notes.setDraft(id, "pos", "outgoing", save);
      await store.actions.hosts.select("other");
      const result = mode === "flush" ? await store.actions.notes.flushDraft(id, "pos", save) : await saved.promise;
      await tick();
      assertEquals(result, { ok: true });
      assertEquals(calls, [["h", file, { notes: { pos: "outgoing", neg: "old" } }]]);
      assertEquals(store.state.drafts[`${id}:pos`], undefined);
      assertEquals(store.state.images[0].judgment.notes, initial.notes, "never retarget the current host's row");
    });
  });
}

Deno.test("judgment retained drafts: failure keeps origin and both signs through successful retry", async () => {
  await withStore(async ({ store }) => {
    const id = "h:a.png", calls = [];
    const save = (sign) => (text, originId) => store.actions.judgments.dispatch(originId, { type: "note", sign, text });
    api.setJudgment = async (host, file, patch) => {
      calls.push([host, file, structuredClone(patch)]);
      if (calls.length === 1) throw new Error("offline");
      return {};
    };
    store.actions.notes.setDraft(id, "pos", "positive", save("pos"));
    store.actions.notes.setDraft(id, "neg", "negative", save("neg"));
    await store.actions.hosts.select("other");
    assertEquals((await store.actions.notes.flushDraft(id, "pos", save("pos"))).ok, false);
    assertEquals(store.state.drafts[`${id}:pos`], "positive");
    assertEquals(await store.actions.notes.flushDraft(id, "neg", save("neg")), { ok: true });
    assertEquals(await store.actions.notes.flushDraft(id, "pos", save("pos")), { ok: true });
    assertEquals(calls, [
      ["h", "a.png", { notes: { pos: "positive", neg: "old" } }],
      ["h", "a.png", { notes: { pos: "saved", neg: "negative" } }],
      ["h", "a.png", { notes: { pos: "positive", neg: "negative" } }],
    ]);
    assertEquals(store.state.drafts[`${id}:pos`], undefined);
    assertEquals(store.state.drafts[`${id}:neg`], undefined);
    assertEquals(store.state.images[0].judgment.notes, initial.notes);
  });
});

Deno.test("judgment retained drafts: fresh listing updates retained merge baseline before unload", async () => {
  await withStore(async ({ store, listing }) => {
    const id = "h:a.png", calls = [];
    const save = (text, originId) => store.actions.judgments.dispatch(originId, { type: "note", sign: "pos", text });
    store.actions.notes.setDraft(id, "pos", "local edit", save);
    const fresh = listing();
    fresh[0].judgment.notes = { neg: "server edit" };
    api.entries = async (host) => host === "h" ? fresh : listing();
    await store.actions.ui.refresh();
    await store.actions.hosts.select("other");
    api.setJudgment = async (_host, _file, patch) => { calls.push(structuredClone(patch)); return {}; };
    assertEquals(await store.actions.notes.flushDraft(id, "pos", save), { ok: true });
    assertEquals(calls, [{ notes: { pos: "local edit", neg: "server edit" } }]);
  });
});

Deno.test("judgment retained drafts: older successful save cannot release a newer unsaved draft", async () => {
  await withStore(async ({ store, requests, holdWrites }) => {
    const id = "h:a.png";
    const save = (text, originId) => store.actions.judgments.dispatch(originId, { type: "note", sign: "pos", text });
    holdWrites();
    store.actions.notes.setDraft(id, "pos", "first", save);
    const first = store.actions.notes.flushDraft(id, "pos", save);
    await tick();
    store.actions.notes.setDraft(id, "pos", "second", save);
    await store.actions.hosts.select("other");
    requests[0].resolve({});
    await first;
    assertEquals(store.state.drafts[`${id}:pos`], "second");
    api.setJudgment = async (host, file, patch) => {
      assertEquals([host, file, patch], ["h", "a.png", { notes: { pos: "second", neg: "old" } }]);
      return {};
    };
    assertEquals(await store.actions.notes.flushDraft(id, "pos", save), { ok: true });
    assertEquals(store.state.drafts[`${id}:pos`], undefined);
  });
});

function writerFor(entryFor, write = async () => ({})) {
  return makeJudgments({ entryFor, write, apply() {}, onError() {} });
}

Deno.test("judgment lifecycle: completed records reclaimed, independent of total entries judged", async () => {
  const writer = writerFor((id) => ({ id, host: "h", filename: id, judgment: initial }));
  for (let i = 0; i < 100; i++) {
    await writer.dispatch(`h:f${i}.png`, set("favorite", null));
    assertEquals(writer.size, 0, "without drafts or overlapping reads, settlement leaves no retained history");
  }
});

Deno.test("judgment lifecycle: only older same-collection reads retain completed records", async () => {
  const response = deferred();
  const writer = writerFor(() => ({ host: "h", filename: "a.png", judgment: initial }), () => response.promise);
  const unrelated = writer.beginRead("other"), before = writer.beginRead("h");
  const saving = writer.dispatch("h:a.png", set("favorite", null));
  await tick();
  const during = writer.beginRead("h");
  response.resolve({});
  await saving;
  assertEquals(writer.size, 1);
  assertEquals(writer.overlay("h:a.png", initial, before).favorite, undefined);
  assertEquals(writer.overlay("h:a.png", initial, during).favorite, undefined);
  const fresh = writer.beginRead("h");
  assertEquals(writer.overlay("h:a.png", initial, fresh).favorite, true, "fresh reads remain authoritative");
  writer.endRead(before);
  assertEquals(writer.size, 1, "a second overlapping older read still protects the record");
  writer.endRead(during);
  assertEquals(writer.size, 0, "fresh and unrelated reads cannot pin completed history");
  writer.endRead(fresh);
  writer.endRead(unrelated);
});

Deno.test("judgment lifecycle: drafts retain address and baseline through failure until both released", async () => {
  let entry = { host: "h", filename: "a:b.png", judgment: initial }, fail = true;
  const calls = [];
  const writer = writerFor(() => entry, async (host, file, patch) => {
    calls.push([host, file, structuredClone(patch)]);
    if (fail) throw new Error("offline");
    return {};
  });
  writer.retain("h:a:b.png", "pos");
  writer.retain("h:a:b.png", "neg");
  writer.retain("h:a:b.png", "pos");
  entry = null;
  assertEquals((await writer.dispatch("h:a:b.png", { type: "note", sign: "pos", text: "positive" })).ok, false);
  assertEquals(writer.size, 1);
  fail = false;
  await writer.dispatch("h:a:b.png", { type: "note", sign: "pos", text: "positive" });
  writer.release("h:a:b.png", "pos");
  assertEquals(writer.size, 1, "repeated retain for one draft is idempotent; the other draft still holds the entry");
  await writer.dispatch("h:a:b.png", { type: "note", sign: "neg", text: "negative" });
  writer.release("h:a:b.png", "neg");
  assertEquals(writer.size, 0);
  assertEquals(calls.at(-1), ["h", "a:b.png", { notes: { pos: "positive", neg: "negative" } }]);
});

Deno.test("judgment lifecycle: release and read cleanup cannot reclaim an active write", async () => {
  const response = deferred();
  const writer = writerFor(() => ({ host: "h", filename: "a.png", judgment: initial }), () => response.promise);
  writer.retain("h:a.png", "pos");
  const read = writer.beginRead("h");
  const saving = writer.dispatch("h:a.png", { type: "note", sign: "pos", text: "pending" });
  await tick();
  writer.release("h:a.png", "pos");
  writer.endRead(read);
  assertEquals(writer.size, 1);
  response.resolve({});
  await saving;
  assertEquals(writer.size, 0);
});
