// Acquisition-independent work. Files are opaque identities, never cloned or
// deduplicated by filename. Byte comparisons are readonly, session-owned evidence.
export const imageIdentity = item => item.kind === "upload" ? item.file : item.name;
export const sameImage = (a, b) => a.kind === b.kind && imageIdentity(a) === imageIdentity(b);
const filename = name => typeof name === "string" && name.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name);
export const validImageSet = items => Array.isArray(items) && items.every(item => item &&
  filename(item.name) && (item.kind === "input" || item.kind === "upload" && item.file instanceof File && item.file.name === item.name)) &&
  items.every((item, index) => !items.slice(0, index).some(other => sameImage(item, other)));
export const mergeImages = (items, additions) => additions.reduce((set, item) => set.some(other => sameImage(item, other)) ? set : [...set, item], [...items]);
export const uploadImage = file => ({ kind: "upload", name: file.name, file });
