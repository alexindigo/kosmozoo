// Acquisition-independent work. Files are opaque identities, never cloned or
// deduplicated by filename. Byte comparisons are readonly, session-owned evidence.
import { resourceReference, resourceReferenceProblem } from "/shared/parameters.mjs";
const targetIdentity = Symbol("target-image");
export const imageReference = item => item.kind === "reference" ? resourceReference(item.value) : item.kind === "input" ? resourceReference(item.name) : null;
export const imageReferenceValue = item => item.kind === "reference" ? item.value : item.kind === "input" ? item.name : null;
export const imageIdentity = item => imageReference(item) ? JSON.stringify([imageReference(item).root, imageReference(item).name]) : item.kind === "target" ? targetIdentity : item.kind === "upload" ? item.file : item.kind === "server-path" ? item.path : item.name;
export const sameImage = (a, b) => (imageReference(a) && imageReference(b) || a.kind === b.kind) && imageIdentity(a) === imageIdentity(b);
const filename = name => typeof name === "string" && name.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name);
export const validImageSet = items => Array.isArray(items) && items.every(item => item &&
  (item.kind === "target" || imageReference(item) && !resourceReferenceProblem(null, imageReferenceValue(item)) || filename(item.name) && (item.kind === "upload" && item.file instanceof File && item.file.name === item.name ||
    item.kind === "server-path" && typeof item.path === "string" && item.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(item.path) &&
    item.path.split("/").slice(1).every(part => part && part !== "." && part !== "..") && item.path.split("/").at(-1) === item.name))) &&
  items.every((item, index) => !items.slice(0, index).some(other => sameImage(item, other)));
export function mergeImages(items, additions, index = items.length) {
  const next = [...items], accepted = [];
  for (const item of additions) if (![...items, ...accepted].some(other => sameImage(item, other))) accepted.push(item);
  next.splice(Math.max(0, Math.min(items.length, index)), 0, ...accepted);
  return next;
}
export const uploadImage = file => ({ kind: "upload", name: file.name, file });
