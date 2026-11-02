// One copy/save naming projection. References retain the complete source path;
// downloads are portable filesystem leaves, never a second entry identity.
export function entryNames(entry, { sourcePrefix = true } = {}) {
  const tag = entry.host + "#";
  const prefix = (name) => sourcePrefix && !name.startsWith(tag) ? tag + name : name;
  return {
    reference: prefix(entry.filename),
    download: portableLeaf(prefix(entry.filename.split("/").at(-1))),
  };
}

const utf8 = new TextEncoder();
const reserved = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;

function portableLeaf(name) {
  let clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") || "image";
  if (reserved.test(clean)) clean = "_" + clean;
  if (utf8.encode(clean).length <= 255) return clean;
  // Keep the extension without cutting a Unicode code point. Bound even a
  // pathological extension so the filename always fits one filesystem component.
  const dot = clean.lastIndexOf(".");
  const extension = dot > 0 ? truncate(clean.slice(dot), 32) : "";
  return truncate(dot > 0 ? clean.slice(0, dot) : clean, 255 - utf8.encode(extension).length)
    .replace(/[. ]+$/, "") + extension;
}

function truncate(text, bytes) {
  let result = "";
  for (const point of text) {
    bytes -= utf8.encode(point).length;
    if (bytes < 0) break;
    result += point;
  }
  return result;
}
