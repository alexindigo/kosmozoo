import { assert, assertEquals } from "jsr:@std/assert";
import { metaFromBytes, imageDims, sniffMime, EXTRACTOR_VERSION } from "../src/extractor.mjs";
import { mediaKind, MEDIA, RENDERABLE, IMAGE_EXTENSIONS, EXT_MIME } from "../src/backings/mime.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

const fixture = name => Deno.readFile(new URL(`./fixtures/media/${name}`, import.meta.url));

Deno.test("media registry: classification is shared; admission and LoadImage stay image-only", () => {
  for (const [ext, { mime, kind }] of Object.entries(MEDIA)) {
    assertEquals(mediaKind(`nested/FILE.${ext.toUpperCase()}`), kind);
    assertEquals(EXT_MIME[ext], mime);
    assertEquals(IMAGE_EXTENSIONS.has(ext), kind === "image");
    assertEquals(RENDERABLE.has(ext), kind === "image");
  }
  assertEquals(mediaKind("file.unknown"), null);
  assertEquals(mediaKind("file.constructor"), null);
});

for (const [name, mime] of Object.entries({
  "workflow.png": "image/png", "animated.png": "image/png", "workflow.webp": "image/webp",
  "workflow.mp4": "video/mp4", "workflow.mov": "video/quicktime", "workflow.webm": "video/webm",
  "comment.mp4": "video/mp4", "comment.webm": "video/webm",
})) {
  Deno.test(`media reader: ${name} dimensions, prompt, workflow and lineage survive hash-only ingestion`, async () => {
    const bytes = await fixture(name);
    assertEquals(sniffMime(bytes), mime);
    assertEquals(imageDims(bytes), { width: 160, height: 96 });
    const [meta, workflow, graph] = await metaFromBytes(bytes, name);
    assert(workflow); assertEquals(meta.seed, 42); assertEquals(meta.prompt, "A moving cosmic zoo");
    assertEquals(meta.lineage, { source: "fake:original.png", seed: 41 });
    assertEquals(graph["92"].class_type, "SaveVideo");
    assertEquals(await metaFromBytes(bytes), [meta, workflow, graph]);
    const rig = await mkStateRig("media-reader", { hosts: { c: "folder:/unused" } });
    try {
      const hash = await rig.ingest.ensureBytes("c", name, bytes);
      assertEquals(await rig.ingest.graph(hash), graph);
      assertEquals(rig.store.contentGet(hash).ext, EXTRACTOR_VERSION);
      assertEquals(rig.store.entryDims("c", name), { width: 160, height: 96 });
      assertEquals(rig.store.metaState("c", name).meta.seed, 42);
    } finally { await rig.close(); }
  });
}

Deno.test("media reader: truncation and unknown bytes never invent metadata or throw", async () => {
  for (const name of ["workflow.webp", "workflow.mp4", "workflow.mov", "workflow.webm"]) {
    const bytes = await fixture(name);
    for (const length of [0, 4, 8, 15, 32, 100]) {
      const part = bytes.subarray(0, length);
      const [meta, , graph] = await metaFromBytes(part, name);
      assertEquals(meta, null); assertEquals(graph, null);
      imageDims(part);
    }
  }
  assertEquals(await metaFromBytes(new Uint8Array(32), "unknown.mp4"), [null, false, null]);
});

Deno.test("media sniff: audio signatures are recognized before audio feed admission", () => {
  const encode = s => new TextEncoder().encode(s);
  for (const [bytes, mime] of [[encode("fLaC"), "audio/flac"], [encode("OggS"), "audio/ogg"],
    [encode("ID3\0"), "audio/mpeg"], [new Uint8Array([255, 251, 144, 0]), "audio/mpeg"],
    [encode("RIFFxxxxWAVE"), "audio/wav"]]) assertEquals(sniffMime(bytes), mime);
  assertEquals(sniffMime(new Uint8Array([255, 241, 0, 0])), null); // AAC is not MP3
});

const joinBytes = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes;
};
const text = value => new TextEncoder().encode(value);
function atom(type, payload, extended = false) {
  const header = new Uint8Array(extended ? 16 : 8), dv = new DataView(header.buffer);
  dv.setUint32(0, extended ? 1 : header.length + payload.length); header.set(text(type), 4);
  if (extended) dv.setBigUint64(8, BigInt(header.length + payload.length));
  return joinBytes(header, payload);
}
function atomList(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), list = [];
  for (let at = 0; at + 8 <= bytes.length;) {
    const length = dv.getUint32(at);
    if (length < 8 || length > bytes.length - at) break;
    list.push({ type: new TextDecoder().decode(bytes.subarray(at + 4, at + 8)), payload: bytes.subarray(at + 8, at + length) });
    at += length;
  }
  return list;
}

Deno.test("QuickTime: moov at end beyond head, 64-bit boxes and moov/meta use the same reader", async () => {
  const bytes = await fixture("workflow.mp4"), parts = atomList(bytes);
  const moov = parts.find(part => part.type === "moov");
  const children = atomList(moov.payload);
  const meta = atomList(children.find(part => part.type === "udta").payload).find(part => part.type === "meta");
  const tail = joinBytes(atom("ftyp", parts.find(part => part.type === "ftyp").payload),
    atom("free", new Uint8Array(70_000)), atom("moov", joinBytes(
      ...children.filter(part => part.type !== "udta").map(part => atom(part.type, part.payload)),
      atom("meta", meta.payload)), true));
  assertEquals(imageDims(tail.subarray(0, 65536)), null);
  assertEquals(imageDims(tail), { width: 160, height: 96 });
  assertEquals(await metaFromBytes(tail), await metaFromBytes(bytes));
});

Deno.test("QuickTime: version1 track headers and quarter-turn display geometry", async () => {
  const parts = atomList(await fixture("workflow.mp4"));
  const moov = parts.find(part => part.type === "moov");
  const payload = joinBytes(...atomList(moov.payload).map(part => {
    if (part.type !== "trak") return atom(part.type, part.payload);
    return atom("trak", joinBytes(...atomList(part.payload).map(child => {
      if (child.type !== "tkhd") return atom(child.type, child.payload);
      const header = new Uint8Array(96), dv = new DataView(header.buffer);
      header[0] = 1; dv.setInt32(56, 65536); dv.setInt32(64, -65536);
      dv.setUint32(88, 160 * 65536); dv.setUint32(92, 96 * 65536);
      return atom("tkhd", header);
    })));
  }));
  assertEquals(imageDims(joinBytes(atom("ftyp", parts[0].payload), atom("moov", payload))), { width: 96, height: 160 });
});
