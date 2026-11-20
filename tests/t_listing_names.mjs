import { assert, assertEquals } from "jsr:@std/assert";
import { isEntryPath } from "../src/entry-path.mjs";
import { comfyClient, normalizeInventory, normalizeRootInventory, parseListingEntry } from "../src/backings/comfy.mjs";
import { makeRouter } from "../src/routes.mjs";
import { mkStateRig } from "./helpers/rig.mjs";
import { testPng } from "./helpers/png.mjs";
import { resourceReferenceProblem } from "../src/parameters.mjs";
import { validImageSet, uploadImage } from "../src/features/variations/recipe-model.mjs";
import { list, write } from "../src/backings/comfy.mjs";
import { singleLineText } from "../client-solid/lib/single-line-text.js";
import { entryNames } from "../client-solid/store/entry-names.js";

const names = ["line\nbreak.png", "carriage\rreturn.png", "tab\tname.png", "dir\nname/leaf\r\t.png", 'quotes"[name]#%.png', "del\x7f.png", "next\x85.png"];
const payload = items => ({ items, has_more: false, cursor: "", latest_mtime: 1 });
const row = relpath => ({ relpath, size: 12, mtime: 1 });

Deno.test("listing names: Variations references and native files use the shared exact-name grammar", () => {
  for (const name of names) {
    assertEquals(resourceReferenceProblem(null, name + " [output]"), null);
    assert(validImageSet([{ kind: "reference", value: name + " [output]" }]));
    if (!name.includes("/")) assert(validImageSet([uploadImage(new File(["pixels"], name))]));
  }
});

Deno.test("listing names: single-line presentation and portable downloads never change identity", () => {
  for (const name of names) {
    const display = singleLineText(name), projected = entryNames({ host: "fake", filename: name });
    assert(!/[\r\n\t]/.test(display));
    assertEquals(projected.reference, "fake#" + name);
    assert(!/[\x00-\x1f]/.test(projected.download));
  }
});

Deno.test("listing names: input listing and upload receipts retain actual Comfy names independently of folder grammar", async () => {
  const inputs = names.filter(name => !name.includes("/"));
  assertEquals(await list("fake:1", "input", { fetcher: () => Response.json([...inputs.map(name => name + " [12]"), null, "nul\0.png"]) }), inputs);
  for (const name of [...inputs, "leaf..png"]) {
    const result = await write("fake:1", name, new Uint8Array([1]), { fetcher: (_url, options) => {
      assertEquals(options.body.get("image").name, name);
      return Response.json({ name, type: "input", subfolder: "" });
    } });
    assertEquals(result, { ok: true, name });
  }
});

Deno.test("listing names: every control except NUL is exact address data, including annotated stock roots", () => {
  for (const name of names) {
    assert(isEntryPath(name), JSON.stringify(name));
    assertEquals(parseListingEntry(name + " [12]"), { name, size: 12 });
  }
  assertEquals(isEntryPath("nul\0.png"), false);
  const result = normalizeRootInventory(names.filter(name => !name.includes("/")).map(name => name + " [12]"));
  assertEquals(result.items.map(item => item.name), names.filter(name => !name.includes("/")));
  assertEquals(result.skipped, { count: 0, reasons: [] });
});

Deno.test("listing names: malformed records and ambiguous duplicates are isolated and counted", () => {
  const root = normalizeRootInventory(["good.png [12]", null, "nul\0.png [12]", "../bad.png [12]", "ambiguous.png [1]", "ambiguous.png [2]", "ambiguous.png [2]"]);
  assertEquals(root.items, [{ name: "good.png", size: 12 }]);
  assertEquals(root.skipped.count, 6);
  assertEquals(root.skipped.reasons.reduce((sum, item) => sum + item.count, 0), 6);
  const nested = normalizeInventory(payload([row("a/good.png"), row("a/good.png"), row("nul\0.png"), row("a/../bad.png"), null,
    row("a/ambiguous.png"), { ...row("a/ambiguous.png"), size: 13 }, { ...row("a/size.png"), size: "12" }]));
  assertEquals(nested.items, [{ name: "a/good.png", size: 12, mtime: 1 }]);
  assertEquals(nested.skipped.count, 6);
  const bounded = normalizeRootInventory(["good.png", "a".repeat(4097) + ".png"]);
  assertEquals(bounded.items, [{ name: "good.png", size: null }]);
  assertEquals(bounded.skipped.count, 1);
});

Deno.test("listing names: accepted inventory retains diagnostics, exact bytes/meta/judgments and safe deletion", async () => {
  const bytes = testPng(12, 15), deleted = [], requested = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async req => {
    const url = new URL(req.url);
    if (url.pathname.endsWith("config")) return Response.json({ recursive: true, allowed_extensions: [".png"], list_limit: 200, scan_depth: null });
    if (url.pathname === "/internal/files/output") return Response.json([...names.filter(name => !name.includes("/")).map(name => name + " [12]"), "nul\0.png", "../bad.png"]);
    if (url.pathname.endsWith("/output/list")) return Response.json(payload([row(names[3]), row("dir/../bad.png")]));
    if (url.pathname.endsWith("/output/delete")) { const body = await req.json(); deleted.push(...body.relpaths); return Response.json({ removed: body.relpaths, failed: [] }); }
    if (url.pathname === "/api/view") {
      const name = (url.searchParams.get("subfolder") ? url.searchParams.get("subfolder") + "/" : "") + url.searchParams.get("filename");
      requested.push(name);
      assert(names.includes(name), JSON.stringify(name));
      return new Response(req.method === "HEAD" ? null : bytes, { headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length), "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT" } });
    }
    return Response.json({});
  });
  const address = `127.0.0.1:${server.addr.port}`, rig = await mkStateRig("listing-names", { hosts: { fake: address } });
  const client = comfyClient(address), router = makeRouter({ ...rig, comfy: () => client });
  try {
    const inventory = await client.inventory();
    assertEquals(new Set(inventory.items.map(item => item.name)), new Set(names));
    assertEquals(inventory.skipped.count, 3);
    assert(Object.isFrozen(inventory.skipped.reasons));
    const reply = await router.handle(new Request("http://x/api/collections/fake/entries?inventory=1"));
    const listed = await reply.json();
    assertEquals(reply.status, 200);
    assertEquals(listed.skipped.count, 3);
    for (const name of names) {
      const entry = `http://x/api/collections/fake/entries/${encodeURIComponent(name)}`;
      const got = await router.handle(new Request(entry + "/bytes"));
      assertEquals(got.status, 200); assertEquals(new Uint8Array(await got.arrayBuffer()), bytes);
      const meta = await (await router.handle(new Request(entry + "/meta"))).json();
      assertEquals(meta.name, name); assert(meta.hash);
      const patch = await router.handle(new Request(entry + "/judgment", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes: { pos: name }, favorite: true }) }));
      assertEquals(patch.status, 200);
      assertEquals(rig.store.judgmentGet("fake", name).notes.pos, name);
      assertEquals((await router.handle(new Request(entry, { method: "DELETE" }))).status, 200);
    }
    assertEquals(deleted.filter(name => names.includes(name)), names);
    assert(requested.includes(names[3]));
  } finally { await client.disposeInventory(); await rig.close(); await server.shutdown(); }
});
