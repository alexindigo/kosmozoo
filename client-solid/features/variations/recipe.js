// Feature-private raw recipe ownership. Presentation, IO evidence and mount
// leases never enter this representation. Native Files are opaque resources.
import { snapshotDraft, sameDraft } from "./draft.js";
import { validImageSet, sameImage } from "./image-set.js";
import { templateLabels } from "/shared/features/variations/shared.mjs";

const field = (type, channel, wire = null) => Object.freeze({ type, channel, wire });
export function moveRecipeImage(items, item, index) {
  const from = items.findIndex(other => sameImage(item, other));
  if (from < 0 || !Number.isInteger(index) || index < 0 || index >= items.length || from === index) return items;
  const ordered = [...items];
  ordered.splice(index, 0, ...ordered.splice(from, 1));
  return ordered;
}
export const RECIPE_FIELDS = Object.freeze({
  numeric: Object.freeze({ enabled: field("boolean", "rangeSelections", "enabled"), min: field("number", "ranges", "min"),
    max: field("number", "ranges", "max"), rawIncrement: field("string", "ranges", "increment"),
    mode: field("numeric-mode", "ranges"), value: field("number", "ranges") }),
  images: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), items: field("image-set", "imageParams") }),
  enums: Object.freeze({ enabled: field("boolean", "imageSelections", "enabled"), picks: field("strings", "imageParams") }),
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
export const freezeRecipe = value => {
  if (!value || typeof value !== "object" || value instanceof File) return value;
  for (const item of Object.values(value)) freezeRecipe(item);
  return Object.freeze(value);
};
export function recipeField(domain, name) {
  const definition = Object.hasOwn(RECIPE_FIELDS, domain) && Object.hasOwn(RECIPE_FIELDS[domain], name) ? RECIPE_FIELDS[domain][name] : null;
  if (!definition) throw new Error(`Unclassified editable field: ${domain}.${name}`);
  return definition;
}

export function makeVariationRecipe() {
  const groups = new Map(Object.keys(RECIPE_FIELDS).map(domain => [domain, new Map()]));
  let revision = 0, acceptance = null;
  const row = (domain, id) => groups.get(domain)?.get(id);
  const capture = () => Object.fromEntries([...groups].map(([domain, entries]) => [domain,
    Object.fromEntries([...entries].map(([id, entry]) => [id, snapshotDraft(entry)]))]));
  return {
    row, entries: domain => groups.get(domain), revision: () => revision, edited: () => revision++, capture,
    seed(domain, id, metadata, defaults) {
      let entry = row(domain, id);
      if (!entry) { entry = { metadata: {}, values: {}, baseline: {}, touched: [] }; groups.get(domain).set(id, entry); }
      entry.metadata = freezeRecipe(snapshotDraft({ ...entry.metadata, ...metadata }));
      for (const [name, value] of Object.entries(defaults)) {
        if (!validRecipeValue(recipeField(domain, name).type, value)) throw new Error(`Invalid default: ${domain}.${name}`);
        if (!entry.touched.includes(name)) { entry.values[name] = snapshotDraft(value); entry.baseline[name] = snapshotDraft(value); }
      }
    },
    write(domain, id, name, value) {
      const definition = recipeField(domain, name), entry = row(domain, id);
      if (!entry || !validRecipeValue(definition.type, value)) throw new Error(`Invalid editable value: ${domain}.${name}`);
      entry.values[name] = snapshotDraft(value);
      if (!entry.touched.includes(name)) entry.touched.push(name);
    },
    remaining() {
      const output = [];
      for (const [domain, entries] of groups) for (const [id, entry] of entries) for (const name of Object.keys(RECIPE_FIELDS[domain])) {
        if (!sameDraft(entry.values[name], entry.baseline[name])) output.push({ domain, id, field: name });
      }
      return output;
    },
    // One revision-atomic recipe checkpoint, never graph-field adoption. Clean
    // untouched default settlement is not an edit and remains clean, not rewound.
    acceptance: () => acceptance,
    checkpoint(snapshot, expectedRevision, receipt = null) {
      if (revision !== expectedRevision) return false;
      for (const [domain, entries] of Object.entries(snapshot)) for (const [id, captured] of Object.entries(entries)) {
        const entry = row(domain, id);
        for (const [name, value] of Object.entries(captured.values)) {
          if (!entry.touched.includes(name) && sameDraft(entry.values[name], entry.baseline[name])) continue;
          entry.baseline[name] = snapshotDraft(value);
        }
      }
      acceptance = receipt ? freezeRecipe(snapshotDraft({ revision, ...receipt })) : null;
      return true;
    },
  };
}

// Total raw provenance: a compiler read is active; disabled values and dormant
// substitutions are retained. Missing active reads and unknown/overlapping paths
// are compiler defects, rejected before effects rather than silently omitted.
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
          const numericActive = domain !== "numeric" || name === "mode" ||
            (entry.values.mode === "value" ? name === "value" : name !== "value");
          const required = domain === "naming" || name === "enabled" || entry.values.enabled && numericActive &&
            (name !== "tpl" || path.length === 4 && templateLabels(entry.values.text).includes(path[3]));
          if (!binding && required) {
            throw new Error(`Unclassified active recipe value: ${key(path)}`);
          }
          output.push({ path, disposition: binding ? "active" : "retained", ...(binding ? { operation: `${binding.channel}:${binding.id}` } : {}) });
        }
      }
    }
  }
  if (active.size) throw new Error(`Unclassified compiler binding: ${active.keys().next().value}`);
  return freezeRecipe(output);
}
