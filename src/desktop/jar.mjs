// Read-only installed Firefox resources. Mozilla mozpack/mozjar.py documents
// central-directory-first optimized jars; member offsets/data remain normal ZIP.
import { inflateRawSync } from "node:zlib";
const decoder = new TextDecoder();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function jarMember(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break;
  if (end < Math.max(0, bytes.length - 65557) || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("Unknown Firefox archive layout");
  let offset = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  for (let index = 0; index < count; index++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid Firefox resource directory");
    const nameLength = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === wanted) {
      const method = view.getUint16(offset + 10, true), expected = view.getUint32(offset + 24, true), compressed = view.getUint32(offset + 20, true);
      const local = view.getUint32(offset + 42, true);
      if (expected > 4 * 1024 * 1024 || local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) throw new Error("Invalid or excessive Firefox resource");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + compressed > bytes.length) throw new Error("Truncated Firefox resource");
      const input = bytes.subarray(start, start + compressed);
      const output = method === 0 ? input : method === 8 ? inflateRawSync(input, { maxOutputLength: 4 * 1024 * 1024 }) : null;
      if (!output || output.length !== expected || crc32(output) !== view.getUint32(offset + 16, true)) throw new Error("Firefox resource checksum/encoding failed");
      return decoder.decode(output);
    }
    offset += 46 + nameLength + extra + comment;
  }
  return null;
}
