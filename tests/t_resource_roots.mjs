// tests/t_resource_roots.mjs — input, output and temp are distinct resource
// roots end to end: one stock annotation reading, root-keyed byte cache/GET/
// HEAD/single-flight/revalidation, no output pollution, strict unknown roots,
// source fencing, and root-qualified Details/viewer/Variations identities.
// Same-named files in the three roots carry deliberately different real PNGs.
// Namespace imports keep every case individually observable before the
// contract exists (a missing export fails its own case, not the module).
import { assert, assertEquals, assertNotEquals, assertThrows } from "jsr:@std/assert";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/cache.mjs";
import { makeRouter } from "../src/routes.mjs";
import * as folder from "../src/backings/folder.mjs";
import * as parameters from "../src/parameters.mjs";
import * as entryUrl from "../client/js/entry-url.mjs";
import * as fields from "../client-solid/store/fields.js";
import { pairSides } from "../client-solid/features/diff/pair.mjs";
import { inspectImage } from "../src/features/variations/image-inspection.mjs";
import { parameterCatalogue } from "../src/features/variations/server.mjs";
import { objectInfoView } from "../src/backings/comfy.mjs";
import { makeVariationEditor } from "../client-solid/features/variations/editor.js";
import { mkStateRig } from "./helpers/rig.mjs";
import { fakeComfyInline } from "./helpers/fake-comfy-inline.mjs";
import { loadImage, saveImage } from "./helpers/comfy-object-info.mjs";

const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url).pathname).then(bytes => new Uint8Array(bytes));
const NAME = "same.png";

async function rootsRig({ gate = null } = {}) {
  const [input, output, temp, changed] = await Promise.all(["flux-basic.png", "flux-controlnet.png", "flux-ipadapter.png", "flux-lora.png"].map(fixture));
  const roots = { input: { [NAME]: { bytes: input, etag: '"in-1"' } }, output: { [NAME]: { bytes: output, etag: '"out-1"' } },
    temp: { [NAME]: { bytes: temp, etag: '"tmp-1"' } } };
  const comfy = fakeComfyInline({ roots, gate });
  const hosts = { c: comfy.addr };
  const rig = await mkStateRig("roots", { hosts, revalidateMs: 1 });
  const router = makeRouter({ hosts, store: rig.store, settings: rig.settings, plugins: null, cache: rig.cache, ingest: rig.ingest, inventory: rig.inventory });
  const hashes = { input: await sha256(input), output: await sha256(output), temp: await sha256(temp), changed: await sha256(changed) };
  return { ...rig, comfy, hosts, router, roots, bytes: { input, output, temp, changed }, hashes,
    async dispose() { await comfy.close(); await rig.close(); } };
}

const get = (r, query = "", method = "GET") => r.router.handle(new Request(`http://x/api/collections/c/entries/${NAME}/bytes${query}`, { method }));

Deno.test("roots: one stock reading gives image descriptors an explicit current root", () => {
  const schema = objectInfoView({ LoadImage: loadImage([NAME]) });
  const roots = Object.fromEntries(["same.png", "same.png [input]", "same.png [output]", "same.png [temp]", "same [draft].png"].map(value => {
    const [p] = parameters.graphParameters({ n: { class_type: "LoadImage", inputs: { image: value } } }, schema);
    return [value, [p.current, p.currentRoot, p.fromOutput, p.currentValue]];
  }));
  assertEquals(roots, { "same.png": ["same.png", "input", false, "same.png"], "same.png [input]": ["same.png", "input", false, "same.png [input]"],
    "same.png [output]": ["same.png", "output", true, "same.png [output]"], "same.png [temp]": ["same.png", "temp", false, "same.png [temp]"],
    "same [draft].png": ["same [draft].png", "input", false, "same [draft].png"] });
  assertEquals(parameters.RESOURCE_ROOTS, ["input", "output", "temp"]);
});

Deno.test("roots: same-named input/output/temp bytes stay distinct through GET, HEAD, storage and single-flight", async () => {
  const r = await rootsRig();
  try {
    const seen = {};
    for (const [kind, query] of [["output", ""], ["output", "?kind=output"], ["input", "?kind=input"], ["temp", "?kind=temp"]]) {
      const response = await get(r, query);
      assertEquals(response.status, 200, query);
      const body = new Uint8Array(await response.arrayBuffer());
      assertEquals(await sha256(body), r.hashes[kind], `${query} serves its own root's bytes`);
      assertEquals(response.headers.get("ETag"), `"${r.hashes[kind]}"`);
      seen[kind] = r.hashes[kind];
      const head = await get(r, query, "HEAD");
      assertEquals([head.status, head.headers.get("content-length")], [200, String(r.bytes[kind].length)], `HEAD ${query}`);
    }
    assertEquals(new Set(Object.values(seen)).size, 3);
    assertEquals(r.store.fileInfo("c", NAME).hash, r.hashes.output);
    assertEquals(r.store.resourceCacheGet("c", NAME, "input").hash, r.hashes.input);
    assertEquals(r.store.resourceCacheGet("c", NAME, "temp").hash, r.hashes.temp);
    assertEquals(r.store.entryGet("c", NAME, "temp").hash, r.hashes.temp);
    // Referenced roots never become extracted output content.
    assertEquals(r.store.contentGet(r.hashes.temp)?.ext ?? 0, 0);
    assertEquals(r.store.contentGet(r.hashes.input)?.ext ?? 0, 0);
    assertEquals(r.comfy.state.reads.sort(), ["input:same.png", "output:same.png", "temp:same.png"], "one backing read per root");
    // Concurrent same-root requests share one flight; another root never joins it.
    const fresh = await rootsRig();
    try {
      const results = await Promise.all([fresh.ingest.ensure("c", NAME, "temp"), fresh.ingest.ensure("c", NAME, "temp"), fresh.ingest.ensure("c", NAME, "input")]);
      assertEquals(results.map(result => result.hash), [fresh.hashes.temp, fresh.hashes.temp, fresh.hashes.input]);
      assertEquals(fresh.comfy.state.reads.sort(), ["input:same.png", "temp:same.png"]);
    } finally { await fresh.dispose(); }
  } finally { await r.dispose(); }
});

Deno.test("roots: an unknown root fails explicitly with no backing read or row", async () => {
  const r = await rootsRig();
  try {
    for (const method of ["GET", "HEAD"]) assertEquals((await get(r, "?kind=bogus", method)).status, 400, method);
    assertEquals((await get(r, "?kind=Output")).status, 400);
    assertEquals(await r.ingest.ensure("c", NAME, "bogus"), { status: 400 });
    const listing = await r.router.handle(new Request("http://x/api/collections/c/entries?kind=temp"));
    assertEquals(listing.status, 400, "a temp listing never falls back to the output inventory");
    await listing.body?.cancel();
    assertEquals(r.comfy.state.reads, []);
    assertThrows(() => r.store.resourceCacheGet("c", NAME, "bogus"), TypeError);
    assertThrows(() => entryUrl.entryBytesUrl("c", NAME, { kind: "bogus" }), TypeError);
  } finally { await r.dispose(); }
});

Deno.test("roots: revalidation is root-specific after changed bytes", async () => {
  const r = await rootsRig();
  try {
    for (const kind of ["input", "output", "temp"]) await r.ingest.ensure("c", NAME, kind);
    r.roots.temp[NAME] = { bytes: r.bytes.changed, etag: '"tmp-2"' };
    await r.ingest.revalidateNow("c", NAME, { kind: "temp" });
    assertEquals(r.store.resourceCacheGet("c", NAME, "temp").hash, r.hashes.changed);
    assertEquals(r.store.resourceCacheGet("c", NAME, "input").hash, r.hashes.input);
    assertEquals(r.store.fileInfo("c", NAME).hash, r.hashes.output);
    const served = await get(r, "?kind=temp");
    assertEquals(await sha256(new Uint8Array(await served.arrayBuffer())), r.hashes.changed);
    // The input boolean facade still names the input root only.
    r.roots.input[NAME] = { bytes: r.bytes.temp, etag: '"in-2"' };
    await r.ingest.revalidateNow("c", NAME, { input: true });
    assertEquals(r.store.resourceCacheGet("c", NAME, "input").hash, r.hashes.temp);
    assertEquals(r.store.resourceCacheGet("c", NAME, "temp").hash, r.hashes.changed);
    assertEquals(r.store.fileInfo("c", NAME).hash, r.hashes.output);
  } finally { await r.dispose(); }
});

Deno.test("roots: source retirement during a temp read publishes nothing", async () => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const r = await rootsRig({ gate: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  try {
    const pending = get(r, "?kind=temp");
    await reached;
    r.hosts.c = "127.0.0.1:1"; // the source now names another backend
    release();
    const response = await pending;
    assertEquals(response.status, 409);
    await response.body?.cancel();
    assertEquals(r.store.entryGet("c", NAME, "temp"), null);
  } finally { await r.dispose(); }
});

Deno.test("roots: a folder source has no temp root to alias", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kz-root-folder-"));
  await mkdir(join(dir, "images"));
  await writeFile(join(dir, "images", NAME), await fixture("flux-basic.png"));
  const addr = `folder:${join(dir, "images")}`;
  assertEquals((await folder.read(addr, NAME, "output")).status, 200);
  assertEquals((await folder.read(addr, NAME, "input")).status, 200, "a folder's files are its input listing (existing contract)");
  assertEquals((await folder.read(addr, NAME, "temp")).status, 404);
  assertEquals(await folder.stat(addr, NAME, "temp"), null);
  assert(await folder.stat(addr, NAME, "output"));
});

Deno.test("roots: Variations inspection compares with the current's own root", async () => {
  const r = await rootsRig();
  try {
    const token = r.inventory.capture("c"), origin = { source: "c" };
    const app = { ingest: r.ingest, backings: { isCurrent: r.inventory.isCurrent } };
    const inspect = async (kind, bytes) => (await (await inspectImage(app, token, "c", { name: "upload.png", bytes, current: NAME, kind }, origin)).json());
    const temp = await inspect("temp", r.bytes.temp), output = await inspect("output", r.bytes.temp), input = await inspect("input", r.bytes.temp);
    assertEquals([temp.currentHash, output.currentHash, input.currentHash], [r.hashes.temp, r.hashes.output, r.hashes.input]);
    assertEquals([temp.hash === temp.currentHash, output.hash === output.currentHash, input.hash === input.currentHash], [true, false, false]);
    const bad = await inspectImage(app, token, "c", { name: "upload.png", bytes: r.bytes.temp, current: NAME, kind: "bogus" }, origin);
    assertEquals(bad.status, 400);
  } finally { await r.dispose(); }
});

Deno.test("roots: Details discovery and the viewer side codec keep root + file identity", () => {
  const meta = { nodes: [{ type: "LoadImage", title: "A", inputs: { image: NAME } }, { type: "LoadImage", title: "B", inputs: { image: `${NAME} [output]` } },
    { type: "LoadImage", title: "C", inputs: { image: `${NAME} [temp]` } }, { type: "LoadImage", title: "D", inputs: { image: `${NAME} [input]` } },
    { type: "SaveImage", inputs: { filename_prefix: "out.png" } }, { type: "LoadImage", inputs: { image: "notes.txt" } }] };
  const images = fields.nodeImages(meta, "c");
  assertEquals(images.map(im => [im.label, im.root, im.file, im.key, im.source, im.fromOutput, im.src]), [
    ["A — image", "input", NAME, "input:same.png", "input:c", false, "/api/collections/c/entries/same.png/bytes?kind=input"],
    ["B — image", "output", NAME, "output:same.png", "c", true, "/api/collections/c/entries/same.png/bytes"],
    ["C — image", "temp", NAME, "temp:same.png", "temp:c", false, "/api/collections/c/entries/same.png/bytes?kind=temp"],
  ], "same name in three roots is three images; the [input] repeat is the same resource");
  assertEquals(fields.imageReference("x.png [temp]"), { root: "temp", file: "x.png", key: "temp:x.png" });
  assertEquals(fields.imageReference("photo [draft]"), null);
  for (const source of ["c", "input:c", "temp:c"]) {
    const parsed = entryUrl.parseResourceSource(source);
    assertEquals(entryUrl.resourceSource(parsed.collection, parsed.root), source);
  }
  assertEquals(entryUrl.parseResourceSource("anchor").anchor, true);
  const current = { remote: "c", image: "gen.png" };
  for (const image of images) {
    const { b } = pairSides({ current, workspace: "details", nodeImages: images, infoFile: NAME, infoSource: image.source, host: "c" });
    assertEquals(b, { source: image.source, file: NAME }, `selection of the ${image.root} image resolves to that root`);
  }
  // Legacy carriers (fromOutput only, no source) keep their meaning.
  assertEquals(pairSides({ current, workspace: "details", nodeImages: [{ file: "o.png", fromOutput: true }], infoFile: null, host: "c" }).b, { source: "c", file: "o.png" });
});

Deno.test("roots: a temp current excludes equal temp bytes and keeps its exact assignment, without upload", async () => {
  const graph = { image: { class_type: "LoadImage", inputs: { image: `${NAME} [temp]` } }, out: { class_type: "SaveImage", inputs: { images: ["image", 0], filename_prefix: "x" } } };
  const schema = objectInfoView({ LoadImage: loadImage([NAME]), SaveImage: saveImage() });
  const origin = { source: "c", address: "c:1", kind: "comfy", epoch: "e", incarnation: "i" };
  const catalogue = { context: { origin, graphHash: "a".repeat(64) }, ...parameterCatalogue(graph, schema),
    nodes: Object.entries(graph).map(([id, node]) => ({ id, type: node.class_type, title: null, outputs: schema.outputs.get(node.class_type) ?? null })) };
  const kinds = [], runs = [];
  const editor = makeVariationEditor({ targets: [{ id: "c:gen.png", host: "c", filename: "gen.png", origin }], currentOrigin: () => origin, setTimer: () => 0, clearTimer() {},
    services: { inspectImage: async (_h, _file, current, kind, expected) => { kinds.push([current, kind]); return { hash: "b".repeat(64), currentHash: "b".repeat(64), existing: [], origin: expected }; },
      uploadInput: () => { throw new Error("equal current bytes must not upload"); }, run: async request => { runs.push(request); return { ok: false, status: 500, data: {} }; } } });
  try {
    editor.installCatalogue(catalogue); editor.installInputs({ origin, files: [NAME] });
    editor.setEnabled("image.image", true);
    editor.addImages("image.image", [{ kind: "upload", name: "copy.png", file: new File(["temp bytes"], "copy.png") }, { kind: "input", name: NAME }]);
    await editor.inspectImages();
    assertEquals(kinds, [[NAME, "temp"]], "comparison names the temp root");
    assertEquals(editor.rows("images")["image.image"].images.map(item => item.sameCurrent), [true, false], "the same-named input is a different resource");
    assertEquals(editor.preview().n, 1, "only the distinct input survives current exclusion");
    await editor.run();
    assertEquals(runs[0].imageParams["image.image"].values, [`${NAME} [temp]`, NAME]);
  } finally { editor.dispose(); }
});

Deno.test("roots: dimensions are looked up and recorded per root; referenced head reads never create output rows", async () => {
  const { testPng } = await import("./helpers/png.mjs");
  const png = { input: testPng(30, 20, [200, 40, 40, 255]), output: testPng(60, 40, [40, 160, 60, 255]), temp: testPng(90, 70, [40, 70, 200, 255]) };
  const roots = Object.fromEntries(Object.entries(png).map(([root, bytes]) => [root, { [NAME]: { bytes, etag: `"${root}"` } }]));
  const comfy = fakeComfyInline({ roots });
  const hosts = { c: comfy.addr };
  const rig = await mkStateRig("roots-dims", { hosts });
  try {
    // Temp first, before any output entry exists.
    assertEquals(await rig.ingest.dims("c", NAME, "temp"), { status: 200, dims: { width: 90, height: 70 } });
    assertEquals(rig.store.entryGet("c", NAME, "output"), null, "a referenced-root head read creates no output inventory row");
    assertEquals(rig.store.entryDims("c", NAME, "temp"), { width: 90, height: 70 });
    // A known output short-circuits only the output root.
    rig.store.entryDimsPut("c", NAME, { width: 640, height: 480 });
    const reads = comfy.state.reads.length;
    assertEquals(await rig.ingest.dims("c", NAME), { status: 200, dims: { width: 640, height: 480 } });
    assertEquals(await rig.ingest.dims("c", NAME, "output"), { status: 200, dims: { width: 640, height: 480 } });
    assertEquals(comfy.state.reads.length, reads, "cached output dimensions need no read");
    assertEquals(await rig.ingest.dims("c", NAME, "input"), { status: 200, dims: { width: 30, height: 20 } });
    assertEquals(await rig.ingest.dims("c", NAME, "temp"), { status: 200, dims: { width: 90, height: 70 } });
    assertEquals(rig.store.entryDims("c", NAME), { width: 640, height: 480 });
    // An unknown root fails before any lookup or read, even with known output dims.
    const before = comfy.state.reads.length;
    assertEquals(await rig.ingest.dims("c", NAME, "bogus"), { status: 400, dims: null });
    assertEquals(comfy.state.reads.length, before);
    assertThrows(() => rig.store.entryDims("c", NAME, "bogus"), TypeError);
  } finally { await comfy.close(); await rig.close(); }
});
