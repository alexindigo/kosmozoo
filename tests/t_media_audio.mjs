import { assert, assertEquals } from "jsr:@std/assert";
import { metaFromBytes, imageDims, sniffMime, EXTRACTOR_VERSION } from "../src/extractor.mjs";
import { makeSizes } from "../client-solid/store/sizes.js";
import { mediaGeometry } from "../client-solid/store/media-geometry.js";
import { mkStateRig } from "./helpers/rig.mjs";

const fixture = ext => Deno.readFile(new URL(`./fixtures/media/workflow.${ext}`, import.meta.url));
for (const [ext, mime] of Object.entries({ flac: "audio/flac", mp3: "audio/mpeg", opus: "audio/ogg", wav: "audio/wav" })) {
  Deno.test(`audio ${ext}: embedded parameters/workflow/lineage reach ingest and hash-only graph`, async () => {
    const bytes = await fixture(ext);
    assertEquals(sniffMime(bytes), mime);
    assertEquals(imageDims(bytes), null, "audio never invents image dimensions");
    const [meta, workflow, graph] = await metaFromBytes(bytes, `audio.${ext}`);
    assert(workflow); assertEquals(meta.seed, 42); assertEquals(meta.prompt, "A singing cosmic zoo");
    assertEquals(meta.lineage, { source: "fake:original.png", seed: 41 });
    assertEquals(graph["92"].class_type, "SaveAudio");
    assertEquals(await metaFromBytes(bytes), [meta, workflow, graph]);
    const rig = await mkStateRig("audio-reader", { hosts: { c: "folder:/unused" } });
    try {
      const hash = await rig.ingest.ensureBytes("c", `audio.${ext}`, bytes);
      assertEquals(await rig.ingest.graph(hash), graph);
      assertEquals(rig.store.contentGet(hash).ext, EXTRACTOR_VERSION);
      assertEquals(rig.store.metaState("c", `audio.${ext}`).meta.prompt, "A singing cosmic zoo");
    } finally { await rig.close(); }
  });
}

Deno.test("audio geometry: immediately ready, fixed across late dimensions, no native measurement or source read", () => {
  const entries = ["flac", "mp3", "opus", "wav"].map(ext => ({ id: ext, filename: `audio.${ext}` }));
  const sizes = makeSizes({ srcFor() { throw new Error("audio needs no size IO"); },
    imageAt: i => entries[i], entryFor: id => entries.find(e => e.id === id) });
  try {
    for (const entry of entries) {
      assertEquals(sizes.sizeFor(entry), { w: 1024, h: 160, kind: "audio" });
      entry.width = 1; entry.height = 1; entry.meta = { width: 40, height: 90 };
      assertEquals(sizes.sizeFor(entry), { w: 1024, h: 160, kind: "audio" });
      assertEquals(sizes.loadFailed(entry.id), false);
    }
    sizes.resolveAhead([0, 1, 2, 3], 0, 3);
    assertEquals(mediaGeometry({ width: 1024, size: { w: 1024, h: 160, kind: "audio" } }).height, 160);
    assertEquals(mediaGeometry({ width: 1024, size: { w: 1024, h: 160 } }).height, 576);
    sizes.setContext({});
    assertEquals(sizes.sizeFor(entries[0]), { w: 1024, h: 160, kind: "audio" });
  } finally { sizes.dispose(); }
});

const text = s => new TextEncoder().encode(s);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out;
};
const le32 = n => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, n, true); return out; };
const sync = n => new Uint8Array([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const graph = { "1": { class_type: "CLIPTextEncode", inputs: { text: "é宇宙" } },
  "2": { class_type: "KSampler", inputs: { positive: ["1", 0], seed: 42 } } };

Deno.test("OpusTags: reconstruct continued packets by lacing, not payload substring; reject missing pages", async () => {
  const comments = ["PROMPT=" + JSON.stringify(graph), "WORKFLOW={}", "padding=" + "x".repeat(66000)];
  const packet = join(text("OpusTags"), le32(4), text("test"), le32(comments.length),
    ...comments.flatMap(s => [le32(text(s).length), text(s)]));
  const page = (payload, laces, sequence, flags = 0) => {
    const header = new Uint8Array(27); header.set(text("OggS")); header[5] = flags;
    const dv = new DataView(header.buffer); dv.setUint32(14, 77, true); dv.setUint32(18, sequence, true);
    header[26] = laces.length; return join(header, new Uint8Array(laces), payload);
  };
  const head = page(text("OpusHead"), [8], 0, 2), first = page(packet.subarray(0, 65025), Array(255).fill(255), 1);
  const tail = packet.subarray(65025), laces = Array(Math.floor(tail.length / 255)).fill(255).concat(tail.length % 255);
  const full = join(head, first, page(tail, laces, 2, 1));
  const [meta, workflow, raw] = await metaFromBytes(full, "continued.opus");
  assertEquals(raw, graph); assertEquals(meta.prompt, "é宇宙"); assert(workflow);
  assertEquals(await metaFromBytes(join(head, first, page(tail, laces, 3, 1))), [null, false, null]);
  assertEquals(await metaFromBytes(join(head, first, page(tail, laces, 2))), [null, false, null]);
  assertEquals(await metaFromBytes(join(text("OggS"), text("OpusTagsPROMPT=" + JSON.stringify(graph)))), [null, false, null]);
});

Deno.test("ID3 TXXX: v2.3 UTF16 BOM and v2.4 UTF8 preserve non-ASCII metadata; skip compressed frames", async () => {
  for (const version of [3, 4]) {
    const encode = s => version === 4 ? text(s) : join(new Uint8Array([255, 254]),
      new Uint8Array([...s].flatMap(c => [c.charCodeAt(0) & 255, c.charCodeAt(0) >>> 8])));
    const body = join(new Uint8Array([version === 4 ? 3 : 1]), encode("PrOmPt"), new Uint8Array(version === 4 ? 1 : 2), encode(JSON.stringify(graph)));
    const size = version === 4 ? sync(body.length) : new Uint8Array(le32(body.length)).reverse();
    const frame = join(text("TXXX"), size, new Uint8Array(2), body);
    const bytes = join(text("ID3"), new Uint8Array([version, 0, 0]), sync(frame.length), frame);
    assertEquals((await metaFromBytes(bytes))[2], graph);
    bytes[19] = version === 4 ? 8 : 128;
    assertEquals(await metaFromBytes(bytes), [null, false, null]);
  }
});

Deno.test("audio readers: truncated and malformed container lengths are absent, never thrown or guessed", async () => {
  for (const ext of ["flac", "mp3", "opus", "wav"]) {
    const bytes = await fixture(ext);
    for (const length of [0, 4, 8, 10, 15, 32, 100]) {
      const [meta, , raw] = await metaFromBytes(bytes.subarray(0, length), `bad.${ext}`);
      assertEquals(meta, null); assertEquals(raw, null);
    }
    const corrupt = bytes.slice(); corrupt.fill(255, 4, Math.min(32, corrupt.length));
    assertEquals((await metaFromBytes(corrupt, `bad.${ext}`))[2], null);
  }
});
