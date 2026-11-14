// Environment-pure raw recipe declarations and resource identity. Mutable owners
// stay in the dialog; native Files remain opaque identities at this boundary.
import { resourceReference, resourceReferenceProblem, parseExactJson, stringifyExactJson } from "../../parameters.mjs";
import { templateLabels } from "./shared.mjs";

const nativeFile = value => typeof File !== "undefined" && value instanceof File;
export function snapshotDraft(value) {
  if (value == null || typeof value !== "object" || nativeFile(value)) return value;
  if (Array.isArray(value)) return value.map(snapshotDraft);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotDraft(item)]));
}
export function sameDraft(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || nativeFile(a) || nativeFile(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameDraft(a[key], b[key]));
}
export const freezeRecipe = value => {
  if (!value || typeof value !== "object" || nativeFile(value)) return value;
  for (const item of Object.values(value)) freezeRecipe(item);
  return Object.freeze(value);
};
export function numericText(raw) {
  try {
    const text = raw.trim();
    if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const value = /^[+-]?\d+$/.test(text) ? parseExactJson(String(BigInt(text))) : Number(text);
    if (typeof value !== "number" && typeof value !== "bigint") return null;
    stringifyExactJson(value);
    return value;
  } catch { return null; }
}
const targetIdentity = Symbol("target-image");
export const imageReference = item => item.kind === "reference" ? resourceReference(item.value) : item.kind === "input" ? resourceReference(item.name) : null;
export const imageReferenceValue = item => item.kind === "reference" ? item.value : item.kind === "input" ? item.name : null;
export const imageIdentity = item => imageReference(item) ? JSON.stringify([imageReference(item).root, imageReference(item).name]) : item.kind === "target" ? targetIdentity : item.kind === "upload" ? item.file : item.kind === "archive" ? JSON.stringify(["archive", item.runId, item.resourceId]) : item.kind === "server-path" ? item.path : item.name;
export const sameImage = (a, b) => (imageReference(a) && imageReference(b) || a.kind === b.kind) && imageIdentity(a) === imageIdentity(b);
const filename = name => typeof name === "string" && name.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(name) && ![".", ".."].includes(name);
export const validImageSet = items => Array.isArray(items) && items.every(item => item &&
  (item.kind === "target" || imageReference(item) && !resourceReferenceProblem(null, imageReferenceValue(item)) || filename(item.name) && (item.kind === "upload" && nativeFile(item.file) && item.file.name === item.name ||
    item.kind === "server-path" && typeof item.path === "string" && item.path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(item.path) &&
    item.path.split("/").slice(1).every(part => part && part !== "." && part !== "..") && item.path.split("/").at(-1) === item.name) ||
    item.kind === "archive" && typeof item.runId === "string" && /^[0-9a-f-]{36}$/i.test(item.runId) && typeof item.resourceId === "string" && /^image-\d+$/.test(item.resourceId) && typeof item.name === "string" && item.name.length > 0)) &&
  items.every((item, index) => !items.slice(0, index).some(other => sameImage(item, other)));
export function mergeImages(items, additions, index = items.length) {
  const next = [...items], accepted = [];
  for (const item of additions) if (![...items, ...accepted].some(other => sameImage(item, other))) accepted.push(item);
  next.splice(Math.max(0, Math.min(items.length, index)), 0, ...accepted);
  return next;
}
export const uploadImage = file => ({ kind: "upload", name: file.name, file });
export function moveRecipeImage(items, item, index) {
  const from = items.findIndex(other => sameImage(item, other));
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= items.length || from === index) return items;
  const ordered = [...items];
  ordered.splice(index, 0, ...ordered.splice(from, 1));
  return ordered;
}
const field = (type, channel, wire = null) => Object.freeze({ type, channel, wire });
export const RECIPE_FIELDS = Object.freeze({
  numeric: Object.freeze({ enabled: field("boolean", "rangeSelections", "enabled"), min: field("string", "ranges", "min"),
    max: field("string", "ranges", "max"), rawIncrement: field("string", "ranges", "increment"),
    mode: field("numeric-mode", "ranges"), value: field("string", "ranges") }),
  images: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), items: field("image-set", "imageParams") }),
  enums: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), picks: field("strings", "imageParams") }),
  candidates: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), candidates: field("strings", "imageParams") }),
  texts: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), text: field("string", "imageParams"), tpl: field("templates", "imageParams") }),
  naming: Object.freeze({ prefix: field("string", "naming"), suffix: field("string", "naming") }),
});
export const validRecipeValue = (type, value) => {
  if (["boolean", "string"].includes(type)) return typeof value === type;
  if (type === "number") return Number.isFinite(value);
  if (type === "numeric-mode") return value === "range" || value === "value";
  if (type === "image-set") return validImageSet(value);
  if (type === "strings") return Array.isArray(value) && value.every(item => typeof item === "string");
  if (type === "templates") return value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(item => typeof item === "string");
  return false;
};
export function recipeField(domain, name) {
  const definition = Object.hasOwn(RECIPE_FIELDS, domain) && Object.hasOwn(RECIPE_FIELDS[domain], name) ? RECIPE_FIELDS[domain][name] : null;
  if (!definition) throw new Error(`Unclassified editable field: ${domain}.${name}`);
  return definition;
}
// One exhaustive classification over the declared leaves, shared by all compilers.
export function recipeDispositions(snapshot, bindings) {
  const key = path => JSON.stringify(path), active = new Map();
  for (const binding of bindings) {
    if (active.has(key(binding.path))) throw new Error(`Overlapping recipe disposition: ${key(binding.path)}`);
    active.set(key(binding.path), binding);
  }
  const output = [];
  for (const [domain, rows] of Object.entries(snapshot)) {
    if (!Object.hasOwn(RECIPE_FIELDS, domain)) throw new Error(`Unclassified recipe domain: ${domain}`);
    for (const [id, entry] of Object.entries(rows)) {
      const fields = RECIPE_FIELDS[domain];
      for (const name of Object.keys(entry.values)) recipeField(domain, name);
      for (const [name, definition] of Object.entries(fields)) {
        const value = entry.values[name];
        if (!validRecipeValue(definition.type, value)) throw new Error(`Invalid recipe value: ${domain}.${name}`);
        const paths = name === "tpl" && Object.keys(value).length ? Object.keys(value).map(label => [domain, id, name, label]) : [[domain, id, name]];
        for (const path of paths) {
          const binding = active.get(key(path));
          active.delete(key(path));
          const numericActive = domain !== "numeric" || name === "mode" || (entry.values.mode === "value" ? name === "value" : name !== "value");
          const required = domain === "naming" || name === "enabled" || entry.values.enabled && numericActive &&
            (name !== "tpl" || path.length === 4 && templateLabels(entry.values.text).includes(path[3]));
          if (!binding && required) throw new Error(`Unclassified active recipe value: ${key(path)}`);
          output.push({ path, disposition: binding ? "active" : "retained", ...(binding ? { operation: `${binding.channel}:${binding.id}` } : {}) });
        }
      }
    }
  }
  if (active.size) throw new Error(`Unclassified compiler binding: ${active.keys().next().value}`);
  return freezeRecipe(output);
}
