import { assertEquals } from "jsr:@std/assert";
import { makeDownVotedDeletion, downVotedDeleteLabel, deletionEffect } from "../client-solid/store/down-voted-delete.js";

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  let state = null, source = { id: "acropolis" }, live = true;
  const previews = [], removals = [], applied = [], messages = [];
  const owner = makeDownVotedDeletion({ capture: () => source, isCurrent: () => live,
    read: () => state, publish: value => { state = value; }, closeMenu() {},
    preview: (captured, options) => { const d = deferred(); previews.push({ ...d, captured, options }); return d.promise; },
    remove: (captured, names) => { const d = deferred(); removals.push({ ...d, captured, names }); return d.promise; },
    apply: (...args) => applied.push(args), status: value => messages.push(value) });
  return { owner, previews, removals, applied, messages, state: () => state,
    select: value => { source = value; }, retire: () => { live = false; } };
}

Deno.test("down-voted client: labels and capability effects name exactly the source and action", () => {
  assertEquals(downVotedDeleteLabel("acropolis"), "Delete down-voted images from acropolis source");
  assertEquals(["trash", "unlink", "hide"].map(deletionEffect), ["They go to ComfyUI's trash.", "The files are deleted.", "They are hidden."]);
});

Deno.test("down-voted client: Cancel aborts preview and fences late success; no deletion", async () => {
  const r = fixture(), request = r.owner.request();
  assertEquals(r.state().phase, "preview"); assertEquals(await r.owner.confirm(), false);
  r.owner.cancel(); assertEquals(r.previews[0].options.signal.aborted, true);
  r.previews[0].resolve({ names: ["a.png"], capability: "trash" });
  assertEquals(await request, false); assertEquals(r.state(), null); assertEquals(r.removals, []);
});

Deno.test("down-voted client: captured preview names/source, single admission, partial results", async () => {
  const r = fixture(), request = r.owner.request(), names = ["a.png", "nested/b.png"];
  r.previews[0].resolve({ names, capability: "trash" }); await request;
  names.push("not-previewed.png"); r.select({ id: "another" });
  assertEquals(r.state().source, "acropolis"); assertEquals(r.state().count, 2);
  const pending = r.owner.confirm();
  assertEquals(r.state().phase, "deleting"); assertEquals(r.owner.cancel(), false); assertEquals(await r.owner.confirm(), false);
  assertEquals(await r.owner.request(), false);
  assertEquals(r.removals[0].names, ["a.png", "nested/b.png"]); assertEquals(r.removals[0].captured.id, "acropolis");
  r.removals[0].resolve({ deleted: ["a.png"], skipped: [{ name: "nested/b.png", reason: "starred" }], failed: [] });
  assertEquals(await pending, true); assertEquals(r.applied[0][1], ["a.png"]);
  assertEquals(r.messages, ["1 deleted, 1 skipped, 0 failed"]); assertEquals(r.state(), null);
});

Deno.test("down-voted client: zero preview has no confirm admission", async () => {
  const r = fixture(), request = r.owner.request();
  r.previews[0].resolve({ names: [], capability: "hide" }); await request;
  assertEquals(r.state().count, 0); assertEquals(await r.owner.confirm(), false); assertEquals(r.removals, []);
});

Deno.test("down-voted client: replacement/disposal fence previews and removed source cannot confirm", async () => {
  const r = fixture(), old = r.owner.request(), fresh = r.owner.request();
  r.previews[0].resolve({ names: ["old.png"], capability: "unlink" }); assertEquals(await old, false);
  r.previews[1].resolve({ names: ["fresh.png"], capability: "trash" }); await fresh;
  r.retire(); assertEquals(await r.owner.confirm(), false); assertEquals(r.state().phase, "error"); assertEquals(r.removals, []);
  r.owner.cancel(); const last = r.owner.request(); r.owner.dispose();
  r.previews[2].resolve({ names: ["retired.png"], capability: "trash" }); assertEquals(await last, false);
});

Deno.test("down-voted client: failures never offer replay or apply unconfirmed effects", async () => {
  const r = fixture(), request = r.owner.request();
  r.previews[0].resolve({ names: ["a.png"], capability: "trash" }); await request;
  const pending = r.owner.confirm(); r.removals[0].reject(Error("disconnected"));
  assertEquals(await pending, false); assertEquals(r.state().phase, "error");
  assertEquals(await r.owner.confirm(), false); assertEquals(r.applied, []); assertEquals(r.messages, []);
  assertEquals(r.removals.length, 1);
});

Deno.test("down-voted client: API failures present semantic detail, not encoded transport addresses", async () => {
  const r = fixture(), request = r.owner.request();
  r.previews[0].reject(Object.assign(Error("POST /api/collections/acropolis/delete-down-voted?origin=encoded: 503"), { detail: "Source unavailable" }));
  assertEquals(await request, false); assertEquals(r.state().error, "Source unavailable");
  assertEquals(r.removals, []);
});
