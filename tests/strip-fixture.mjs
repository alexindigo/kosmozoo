// tests/strip-fixture.mjs — reduce a real ComfyUI output PNG to a tiny
// fixture: keep the PNG signature, IHDR, all pre-IDAT tEXt chunks (the
// embedded prompt/workflow graphs), and a freshly-synthesised minimal IDAT
// for a 1x1 image. A few KB instead of ~800 KB.
//
// Usage:
//   deno run --allow-read --allow-write tests/strip-fixture.mjs <in.png> [out.png]
//
// If out.png is omitted the input is rewritten in place.

import { readFile, writeFile } from "node:fs/promises";

const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(t, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const [inPath, outPath] = Deno.args;
if (!inPath) {
  console.error("usage: strip-fixture.mjs <in.png> [out.png]");
  Deno.exit(2);
}
const buf = new Uint8Array(await readFile(inPath));
for (let i = 0; i < 8; i++) {
  if (buf[i] !== PNG_SIG[i]) {
    console.error("not a PNG:", inPath);
    Deno.exit(1);
  }
}

// Walk chunks; keep signature, IHDR, and any pre-IDAT tEXt/zTXt/iTXt.
const kept = [buf.subarray(0, 8)];
let off = 8;
let ihdr = null;
const textChunks = [];
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
while (off + 12 <= buf.length) {
  const len = dv.getUint32(off);
  const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  if (type === "IDAT") break;
  const whole = buf.subarray(off, off + 12 + len);
  if (type === "IHDR") ihdr = whole;
  else if (type === "tEXt" || type === "zTXt" || type === "iTXt") textChunks.push(whole);
  off += 12 + len;
}
if (!ihdr) {
  console.error("no IHDR:", inPath);
  Deno.exit(1);
}

// Rewrite IHDR to 1x1 (keep bit depth 8, color type 6 RGBA).
const ihdr1 = new Uint8Array(ihdr);
const idv = new DataView(ihdr1.buffer);
idv.setUint32(8, 1); // width
idv.setUint32(12, 1); // height
// fix IHDR crc after mutation
const icrc = crc32(ihdr1.subarray(4, 8 + 13));
idv.setUint32(8 + 13, icrc);

// Minimal IDAT: one scanline, filter byte 0, single transparent RGBA pixel.
// zlib-stream: 78 9c 63 60 60 60 60 00 00 00 04 00 01  (raw deflate of 5 zero
// bytes wrapped in a zlib header with correct adler32).
const idatData = Uint8Array.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]);
const idat = chunk("IDAT", idatData);
const iend = chunk("IEND", new Uint8Array(0));

const total =
  8 + ihdr1.length + textChunks.reduce((s, c) => s + c.length, 0) + idat.length + iend.length;
const out = new Uint8Array(total);
let o = 0;
out.set(buf.subarray(0, 8), o); o += 8;
out.set(ihdr1, o); o += ihdr1.length;
for (const t of textChunks) { out.set(t, o); o += t.length; }
out.set(idat, o); o += idat.length;
out.set(iend, o); o += iend.length;

await writeFile(outPath ?? inPath, out);
console.log(`${inPath} -> ${outPath ?? inPath}: ${buf.length} -> ${out.length} bytes, ${textChunks.length} text chunk(s) kept`);
