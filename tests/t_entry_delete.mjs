import { assertEquals } from "jsr:@std/assert";
import { deleteEntry } from "../src/entry-delete.mjs";
import { makeRouter } from "../src/routes.mjs";

function rig(mode, ok = true) {
  const calls = [];
  const backing = {
    probe: async () => true,
    remove: async (address, name) => { calls.push(["remove", address, name]); return { ok, mode, detail: "cannot remove" }; },
    historyDelete: async (address, name) => { calls.push(["history", address, name]); return true; },
  };
  const address = mode === "unlink" ? "folder:/images" : "fake:8188";
  const ctx = { hosts: { fake: address }, backings: { backingFor: () => backing },
    settings: { get: () => true }, comfy: () => ({ hasAssetsPlus: async () => mode === "trash" }),
    store: { collectionGet: () => null, entryHide: (id, name) => calls.push(["hide", id, name]),
      arrivals: { remove: (id, name) => calls.push(["arrival", id, name]) } } };
  return { ctx, calls, address };
}

for (const mode of ["unlink", "trash", "hide"]) {
  Deno.test(`entry delete: domain and HTTP share ${mode} effects and response`, async () => {
    const direct = rig(mode), http = rig(mode);
    const result = await deleteEntry(direct.ctx, "fake", "a.png");
    const response = await makeRouter(http.ctx).handle(new Request("http://engine/api/collections/fake/entries/a.png", { method: "DELETE" }));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), result.body);
    assertEquals(http.calls, direct.calls);
    assertEquals(direct.calls, mode === "hide"
      ? [["hide", "fake", "a.png"], ["history", direct.address, "a.png"]]
      : [["remove", direct.address, "a.png"], ["arrival", "fake", "a.png"]]);
  });
}

Deno.test("entry delete: removal failure does not acknowledge deletion", async () => {
  const { ctx, calls, address } = rig("trash", false);
  assertEquals(await deleteEntry(ctx, "fake", "nested/a.png"), { status: 409, body: { error: "cannot remove" } });
  assertEquals(calls, [["remove", address, "nested/a.png"]]);
  assertEquals(await deleteEntry(ctx, "missing", "a.png"), { status: 404, body: { error: "unknown collection" } });
});
