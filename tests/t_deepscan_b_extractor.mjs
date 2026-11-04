import { assert, assertEquals } from "jsr:@std/assert";
import { deflateSync } from "node:zlib";
import { metaFromBytes, parsePngTextChunks } from "../src/extractor.mjs";

const encode = value => new TextEncoder().encode(value);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out;
};
function chunk(type, bytes, little = false) {
  const out = new Uint8Array(bytes.length + (little ? 8 + (bytes.length & 1) : 12));
  const dv = new DataView(out.buffer);
  if (little) { out.set(encode(type)); dv.setUint32(4, bytes.length, true); }
  else { dv.setUint32(0, bytes.length); out.set(encode(type), 4); }
  out.set(bytes, 8); return out;
}
const png = (...chunks) => join(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks);
const ztext = (key, value) => chunk("zTXt", join(encode(key + "\0\0"), deflateSync(encode(value))));
const graph = { "1": { class_type: "RandomNoise", inputs: { noise_seed: 42 } } };

Deno.test("deepscan B PNG: expanded metadata has a shared byte budget, including duplicate keys", async () => {
  const large = "x".repeat(9 * 1024 * 1024);
  assert((await parsePngTextChunks(png(ztext("prompt", large)))).prompt === undefined, "oversized expanded text must be absent");
  const itext = chunk("iTXt", join(encode("prompt\0"), new Uint8Array([1, 0, 0, 0]), deflateSync(encode(large))));
  assert((await parsePngTextChunks(png(itext))).prompt === undefined, "iTXt must share the streaming expansion cap");
  const part = "x".repeat(5 * 1024 * 1024);
  const result = await parsePngTextChunks(png(ztext("one", part), ztext("two", part)));
  assertEquals(result.one.length, part.length); assert(result.two === undefined, "aggregate budget must cover all chunks");
  const duplicate = await parsePngTextChunks(png(ztext("one", part), ztext("one", part + "y")));
  assertEquals(duplicate.one.length, part.length, "repeated keys cannot reset the aggregate byte budget");
});

Deno.test("deepscan B PNG: ingestion never inflates unused keywords and keeps normal metadata", async () => {
  const Native = globalThis.DecompressionStream; let inflations = 0;
  globalThis.DecompressionStream = class extends Native { constructor(...args) { super(...args); inflations++; } };
  try {
    const bytes = png(ztext("unrelated", "unused"), ztext("prompt", JSON.stringify(graph)));
    const [meta, , result] = await metaFromBytes(bytes, "image.png");
    assertEquals(result, graph); assertEquals(meta.seed, 42); assertEquals(inflations, 1);
  } finally { globalThis.DecompressionStream = Native; }
});

function webp(values, ranges = null) {
  const entries = values.length, header = 10 + entries * 12;
  const payloads = values.map(encode), tiff = new Uint8Array(header + payloads.reduce((n, p) => n + p.length, 0));
  const dv = new DataView(tiff.buffer); tiff.set(encode("II")); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, entries, true);
  let at = header;
  for (let i = 0; i < entries; i++) {
    const entry = 10 + i * 12, range = ranges?.[i] ?? [at, payloads[i].length];
    dv.setUint16(entry + 2, 2, true); dv.setUint32(entry + 4, range[1], true); dv.setUint32(entry + 8, range[0], true);
    tiff.set(payloads[i], at); at += payloads[i].length;
  }
  const exif = chunk("EXIF", tiff, true), riff = join(encode("RIFF"), new Uint8Array(4), encode("WEBP"), exif);
  new DataView(riff.buffer).setUint32(4, riff.length - 8, true); return riff;
}

Deno.test("deepscan B TIFF: repeated payload ranges decode once and preserve last-entry wins", async () => {
  const value = "prompt:" + JSON.stringify(graph), count = 300, header = 10 + count * 12;
  const bytes = webp(Array(count).fill(value), Array(count).fill([header, encode(value).length]));
  const Native = globalThis.TextDecoder; let decoded = 0;
  globalThis.TextDecoder = class extends Native { decode(bytes, ...args) { decoded += bytes?.byteLength ?? 0; return super.decode(bytes, ...args); } };
  try {
    assertEquals((await metaFromBytes(bytes, "image.webp"))[2], graph);
    assert(decoded < 4096, `decoded ${decoded} bytes from repeated references`);
  } finally { globalThis.TextDecoder = Native; }
  const other = "prompt:" + JSON.stringify({ "2": { class_type: "RandomNoise", inputs: { noise_seed: 7 } } });
  const offset = 10 + 3 * 12, first = encode(value).length, second = encode(other).length;
  assertEquals((await metaFromBytes(webp([value, other, value], [[offset, first], [offset + first, second], [offset, first]]), "image.webp"))[2], graph);
});

Deno.test("deepscan B TIFF: aggregate distinct ranges are bounded before text decoding", async () => {
  const bytes = webp(Array(10).fill("unused:" + "x".repeat(1024 * 1024)));
  const Native = globalThis.TextDecoder; let decoded = 0;
  globalThis.TextDecoder = class extends Native { decode(bytes, ...args) { decoded += bytes?.byteLength ?? 0; return super.decode(bytes, ...args); } };
  try { await metaFromBytes(bytes, "image.webp"); assert(decoded <= 8 * 1024 * 1024); }
  finally { globalThis.TextDecoder = Native; }
});

function wave(value) {
  const list = chunk("LIST", join(encode("INFO"), chunk("ICMT", encode(value), true)), true);
  const bytes = join(encode("RIFF"), new Uint8Array(4), encode("WAVE"), list);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true); return bytes;
}
function id3(value) {
  const payload = join(new Uint8Array([3]), encode("prompt\0" + value));
  const frame = join(encode("TXXX"), new Uint8Array(6), payload);
  new DataView(frame.buffer).setUint32(4, payload.length);
  const header = join(encode("ID3"), new Uint8Array([3, 0, 0, 0, 0, 0, 0]));
  let size = frame.length; for (let i = 9; i >= 6; i--) { header[i] = size & 127; size >>>= 7; }
  return join(header, frame);
}

Deno.test("deepscan B text: internal NUL runs are linear in WAV and ID3; trailing NULs still trim", async () => {
  for (const [bytes, name] of [[wave("\0".repeat(100_000) + "x"), "image.wav"], [id3("\0".repeat(100_000) + "x"), "image.mp3"]]) {
    const start = performance.now(); assertEquals((await metaFromBytes(bytes, name))[0], null);
    assert(performance.now() - start < 1000, "internal NUL run must not stall the event loop");
  }
  assertEquals((await metaFromBytes(wave(JSON.stringify({ prompt: graph }) + "\0\0"), "image.wav"))[2], graph);
  assertEquals((await metaFromBytes(id3(JSON.stringify(graph) + "\0\0"), "image.mp3"))[2], graph);
});
