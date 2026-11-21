import { assertEquals } from "jsr:@std/assert";
import { downVotedNames, deleteDownVoted } from "../src/delete-down-voted.mjs";
import { makeRouter } from "../src/routes.mjs";

Deno.test("down-voted selection: listed outputs only, across folders, with both protections", () => {
  const rows = [
    { name: "down.png", vote: "down" }, { name: "a/deep/down.png", vote: "down" },
    { name: "star.png", vote: "down", favorite: 1 }, { name: "bookmark.png", vote: "down", bookmark: 1 },
    { name: "up.png", vote: "up" }, { name: "none.png" },
    { name: "gone.png", vote: "down", state: "gone" }, { name: "hidden.png", vote: "down", hidden: 1 },
    { name: "absent.png", vote: "down" },
  ];
  assertEquals(downVotedNames(rows.slice(0, -1).map(({ name }) => ({ name })).concat({ name: "fresh.png" }), rows), ["down.png", "a/deep/down.png"]);
});

function fixture(mode = "trash") {
  const rows = new Map(["a.png", "nested/b.png", "star.png", "bookmark.png", "up.png"].map(name => [name, { name, vote: "down" }]));
  rows.get("star.png").favorite = 1; rows.get("bookmark.png").bookmark = 1; rows.get("up.png").vote = "up";
  const present = new Set(rows.keys()), calls = [], arrivals = [], token = {};
  let current = true, accepting = true, afterProbe = () => {}, beforeRemove = () => {};
  const inventory = async () => ({ items: [...present].map(name => ({ name })) });
  inventory.capture = () => token; inventory.isCurrent = value => value === token && current;
  const backing = { probe: async () => { afterProbe(); return true; },
    remove: async (_address, name) => { beforeRemove(name); calls.push(name); if (name === "fail.png") return { ok: false, detail: "refused" };
      present.delete(name); return { ok: true, mode }; },
    historyDelete: async (_address, name) => { calls.push(name); return true; } };
  const ctx = { hosts: { fake: mode === "unlink" ? "folder:/images" : "fake:8188" }, inventory,
    sourceActivity: { acceptingChanges: () => accepting }, settings: { get: () => true },
    comfy: () => ({ hasAssetsPlus: async () => mode === "trash" }), backings: { backingFor: () => backing },
    store: { collectionGet: () => null, entriesForCollection: () => [...rows.values()], entryGet: (_id, name) => rows.get(name),
      entryHide: (_id, name) => { rows.get(name).hidden = 1; }, arrivals: { remove: (_id, name) => arrivals.push(name) } } };
  const router = makeRouter(ctx);
  const request = (body, headers = {}) => router.handle(new Request("http://engine/api/collections/fake/delete-down-voted", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { ctx, rows, present, calls, arrivals, request, afterProbe: fn => { afterProbe = fn; }, beforeRemove: fn => { beforeRemove = fn; },
    retire: () => { current = false; }, stop: () => { accepting = false; } };
}

for (const mode of ["trash", "unlink", "hide"]) Deno.test(`delete down-voted API: preview and exact confirmed names use ${mode}`, async () => {
  const r = fixture(mode);
  const preview = await r.request({ preview: true });
  assertEquals(await preview.json(), { count: 2, names: ["a.png", "nested/b.png"], capability: mode });
  assertEquals(r.calls, []);
  const response = await r.request({ names: ["a.png", "a.png", "star.png", "bookmark.png", "up.png", "absent.png"] });
  const result = await response.json();
  assertEquals(result.deleted, ["a.png"]); assertEquals(result.failed, []); assertEquals(result.skipped.length, 4);
  assertEquals(r.calls, ["a.png"]);
  assertEquals((await (await r.request({ preview: true })).json()).names, ["nested/b.png"], "unconfirmed names remain");
});

Deno.test("delete down-voted: re-votes, stars and bookmarks after preview are skipped", async () => {
  const r = fixture(); const preview = await (await r.request({ preview: true })).json();
  r.rows.get("a.png").vote = "up"; r.rows.get("nested/b.png").favorite = 1;
  const result = await (await r.request({ names: preview.names })).json();
  assertEquals(result.deleted, []); assertEquals(result.skipped.length, 2); assertEquals(r.calls, []);
  r.rows.get("a.png").vote = "down"; r.rows.get("a.png").bookmark = 1;
  assertEquals((await deleteDownVoted(r.ctx, "fake", { names: ["a.png"] })).body.skipped.length, 1);
});

Deno.test("delete down-voted: recheck after async capability probe, not before", async () => {
  const r = fixture(); let probes = 0;
  r.afterProbe(() => { if (++probes === 2) r.rows.get("a.png").bookmark = 1; });
  const result = await deleteDownVoted(r.ctx, "fake", { names: ["a.png"] });
  assertEquals(result.body.deleted, []); assertEquals(result.body.skipped.length, 1); assertEquals(r.calls, []);
});

Deno.test("delete down-voted: sequential partial results and retirement never continue effects", async () => {
  const r = fixture(); r.rows.set("fail.png", { name: "fail.png", vote: "down" }); r.present.add("fail.png");
  const first = await deleteDownVoted(r.ctx, "fake", { names: ["fail.png", "a.png"] });
  assertEquals(first.body, { deleted: ["a.png"], skipped: [], failed: [{ name: "fail.png", error: "refused" }] });
  r.rows.set("a.png", { name: "a.png", vote: "down" }); r.present.add("a.png"); r.calls.length = 0;
  r.beforeRemove(() => r.retire());
  const second = await deleteDownVoted(r.ctx, "fake", { names: ["a.png", "nested/b.png"] });
  assertEquals(second.body.deleted, ["a.png"]); assertEquals(second.body.skipped.length, 1); assertEquals(r.calls, ["a.png"]);
  assertEquals(r.arrivals, ["a.png"], "retired deletion cannot alter replacement source arrivals");
  r.stop(); assertEquals((await deleteDownVoted(r.ctx, "fake", { preview: true })).status, 503);
});

Deno.test("delete down-voted route: whole payload/path/JSON/origin admission before effects", async () => {
  const r = fixture();
  for (const body of [null, [], {}, { preview: false }, { preview: true, names: [] }, { names: ["a.png", "../bad.png"] }, { names: [null] }, { names: "all" }]) {
    assertEquals((await r.request(body)).status, 400);
  }
  assertEquals((await r.request({ names: ["a.png"] }, { Origin: "http://foreign" })).status, 403);
  assertEquals((await r.request({ names: ["a.png"] }, { "Content-Type": "text/plain" })).status, 415);
  assertEquals((await r.request({ names: ["a.png"] }, { "Content-Type": "application/octet-stream" })).status, 415);
  assertEquals(r.calls, []);
});
