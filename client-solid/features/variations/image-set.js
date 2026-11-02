// Acquisition-independent work. Files are opaque identities, never cloned or
// deduplicated by filename. Byte comparisons are readonly, session-owned evidence.
export const imageIdentity = item => item.kind === "upload" ? item.file : item.kind === "server-path" ? item.path : item.name;
export const sameImage = (a, b) => a.kind === b.kind && imageIdentity(a) === imageIdentity(b);
const filename = name => typeof name === "string" && name.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name);
export const validImageSet = items => Array.isArray(items) && items.every(item => item &&
  filename(item.name) && (item.kind === "input" || item.kind === "upload" && item.file instanceof File && item.file.name === item.name ||
    item.kind === "server-path" && typeof item.path === "string" && item.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(item.path) &&
    item.path.split("/").slice(1).every(part => part && part !== "." && part !== "..") && item.path.split("/").at(-1) === item.name)) &&
  items.every((item, index) => !items.slice(0, index).some(other => sameImage(item, other)));
export function mergeImages(items, additions, index = items.length) {
  const next = [...items], accepted = [];
  for (const item of additions) if (![...items, ...accepted].some(other => sameImage(item, other))) accepted.push(item);
  next.splice(Math.max(0, Math.min(items.length, index)), 0, ...accepted);
  return next;
}
export const uploadImage = file => ({ kind: "upload", name: file.name, file });
