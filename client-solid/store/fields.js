// client-solid/store/fields.js — the metadata fields machinery, parameterized
// over the store's node registry. NOTHING is hardcoded about nodes: the field
// list derives from the engine's node registry; a field id is
// `<class_type>.<input>`.
import { entryBytesUrl, resourceSource } from "/js/api.mjs";
import { resourceReference } from "/shared/parameters.mjs";

const LONG_TEXT = 120; // chars: full-text fields render in the desc area

// image aspect from metadata — shared by the feed card and the anchors space
export function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}

// byte size for display (card details header etc.)
export function fmtBytes(n) {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtGenerationTime(ms, { compact = false } = {}) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Number((ms / 1000).toFixed(2))}s`;
  const total = Math.round(ms / 1000), seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60, hours = Math.floor(total / 3600);
  if (!compact) return hours ? `${hours}h ${minutes}m ${seconds}s` : total >= 60 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds || !total ? `${seconds}s` : ""].filter(Boolean).join(" ");
}

export function fieldId(classType, input) { return `${classType}.${input}`; }

export function parseFieldId(id) {
  const i = id.lastIndexOf(".");
  return [id.slice(0, i), id.slice(i + 1)];
}

function fieldValues(meta) {
  const types = new Map(), values = new Map();
  for (const node of meta?.nodes ?? []) {
    const type = node.type;
    if (!types.has(type)) types.set(type, []);
    types.get(type).push(node);
  }
  const order = (a, b) => {
    const na = +a.id, nb = +b.id;
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  };
  for (const [type, nodes] of types) {
    const inputs = new Map(); values.set(type, inputs);
    for (const node of nodes.sort(order)) for (const [input, value] of Object.entries(node.inputs ?? {})) {
      if (value == null || value === "") continue;
      if (!inputs.has(input)) inputs.set(input, []);
      inputs.get(input).push(typeof value === "boolean" ? String(value) : value);
    }
  }
  return values;
}

// One getter per registry field id: reads the value from every instance of
// the type, skipping empty slots. Returns them as an array (multi-instance)
// or a scalar (single instance).
function fieldGetter(classType, input) {
  return (m, index = fieldValues(m)) => {
    const vals = index.get(classType)?.get(input) ?? [];
    return vals.length > 1 ? vals : (vals[0] ?? null);
  };
}

// [[id, getter]] flat, sorted by group title then input — the registry shape.
// This list is also the hook a future overlay-fields picker will target (the
// card-strip picker was deleted: it toggled a gate nothing read — a later
// picker decides which detail OVERLAYS show).
export function fieldList(registry) {
  const reg = registry ?? {};
  const entries = Object.entries(reg);
  return entries
    .sort(([a, aInfo], [b, bInfo]) => (aInfo.title || a).localeCompare(bInfo.title || b))
    .flatMap(([classType, info]) =>
      Object.keys(info.inputs ?? {}).sort()
        .map((input) => [fieldId(classType, input), fieldGetter(classType, input)]));
}

export function formatScalar(v) {
  if (typeof v === "number") return String(parseFloat(v.toFixed(10)));
  return String(v);
}

// [label, text, long?] rows from meta. Rows are labeled by the actual node
// name (class_type) — never the registry title, which any workflow renames
// per instance.
export function materializeRows(meta, { list }) {
  const rows = [];
  // Per-render index: linear in supplied inputs, without mutable-identity caches
  // or a node scan for every absent registry field.
  const index = fieldValues(meta);
  for (const [id, getter] of list) {
    const v = getter(meta, index);
    if (v == null) continue;
    const [classType, input] = parseFieldId(id);
    const vals = Array.isArray(v) ? v : [v];
    const label = `${classType} — ${input}`;
    for (const text of vals) {
      const long = String(text).length > LONG_TEXT;
      rows.push([label, long ? String(text) : formatScalar(text), long]);
    }
  }
  return rows;
}

// full rows (details pane / ⓘ overlay): every field the image carries
export function fullFieldRows(meta, { list }) {
  return materializeRows(meta, { list });
}

// The "changed vs the previous image" highlight: builds the previous meta's
// keyspace; the returned predicate marks a current row whose (label, value)
// isn't in it — a changed value, or a field the previous image didn't carry.
// Values compare through the same formatting both sides (materializeRows).
export function valueDiffer(compareMeta, { list }) {
  if (!compareMeta) return () => false;
  const seen = new Map(); // label -> Set of values (multi-instance: any match is "unchanged")
  for (const [label, v] of fullFieldRows(compareMeta, { list })) {
    if (!seen.has(label)) seen.set(label, new Set());
    seen.get(label).add(v);
  }
  return (label, v) => !seen.get(label)?.has(v);
}

// node inputs that reference an image FILE — only a LoadImage-type node's
// `image` input qualifies (metadata carries no backend declarations, so this
// honest offline discovery rule stays). Sweeping every node input for a ".png"
// string catches SaveImage's filename_prefix (a generated output name, not an
// input file). The shared resourceReference owner reads ComfyUI's stock root
// annotations exactly; each image keeps its explicit root and is served from
// that root's bytes route. Identity is root + file: an input and an output (or
// temp) file of the same name are distinct images; repeats of one resource
// render once. With a host, each entry carries its src and viewer side source.
export const NODE_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
// uploads to a host's input dir are raster-only (no svg)
export const UPLOAD_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

// A metadata value that names an image file: its stock root and file name, plus
// the stable root-qualified key Details uses to address that image.
export function imageReference(value) {
  const reference = resourceReference(value);
  if (!reference || !NODE_IMG_EXT.test(reference.name)) return null;
  return { root: reference.root, file: reference.name, key: `${reference.root}:${reference.name}` };
}

export function nodeImages(meta, host) {
  const out = [];
  const seen = new Set();
  for (const n of meta?.nodes ?? []) {
    if (!/loadimage$/i.test(String(n.type ?? ""))) continue;
    const reference = imageReference(n.inputs?.image);
    if (!reference || seen.has(reference.key)) continue;
    seen.add(reference.key);
    out.push({
      label: `${n.title ?? n.type} — image`,
      ...reference,
      fromOutput: reference.root === "output", // compatibility facade of root
      source: host ? resourceSource(host, reference.root) : null,
      src: host ? entryBytesUrl(host, reference.file, { kind: reference.root }) : null,
    });
  }
  return out;
}
