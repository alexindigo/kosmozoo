// Real, decodable test pixels (the fixture generator's PNG/chunk recipe).
import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}

export function testPng(width, height, color = [36, 40, 48, 255], graph = null, lineage = null) {
  const header = new Uint8Array(13), view = new DataView(header.buffer);
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6;
  const raw = new Uint8Array((1 + width * 4) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(color, y * (1 + width * 4) + 1 + x * 4);
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header)];
  if (graph) parts.push(chunk("tEXt", new TextEncoder().encode(`prompt\0${JSON.stringify(graph)}`)));
  if (lineage) parts.push(chunk("tEXt", new TextEncoder().encode(`kz\0${JSON.stringify(lineage)}`)));
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array()));
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
