// client-solid/store/fields.js — the metadata fields machinery, parameterized
// over the store's node registry. NOTHING is hardcoded about nodes: the field
// list derives from the engine's node registry; a field id is
// `<class_type>.<input>`.

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

export function fieldId(classType, input) { return `${classType}.${input}`; }

export function parseFieldId(id) {
  const i = id.lastIndexOf(".");
  return [id.slice(0, i), id.slice(i + 1)];
}

function instancesOf(meta, classType) {
  const nodes = (meta?.nodes ?? []).filter((n) => n.type === classType);
  nodes.sort((a, b) => {
    const na = +a.id, nb = +b.id;
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });
  return nodes;
}

// One getter per registry field id: reads the value from every instance of
// the type, skipping empty slots. Returns them as an array (multi-instance)
// or a scalar (single instance).
function fieldGetter(classType, input) {
  return (m) => {
    const inst = instancesOf(m, classType);
    const vals = [];
    for (const n of inst) {
      const v = n.inputs?.[input];
      if (v == null || v === "") continue;
      vals.push(typeof v === "boolean" ? String(v) : v);
    }
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
  for (const [id, getter] of list) {
    const v = getter(meta);
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
// `image` input qualifies. Sweeping every node input for a ".png" string
// catches SaveImage's filename_prefix (a generated output name, not an input
// file). ComfyUI annotates a LoadImage-from-output value as
// "<filename> [output]": strip the annotation for the real filename, and
// serve it from the OUTPUT bytes route (it is not in the input dir — the
// input-bytes route would 404). Input-dir refs use input-bytes.
// Deduped: two nodes referencing the same file render one image. With a
// host, each entry carries its src.
export const NODE_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
// uploads to a host's input dir are raster-only (no svg)
export const UPLOAD_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const OUTPUT_TAG = /\s+\[output\]$/i;

export function nodeImages(meta, host) {
  const out = [];
  const seen = new Set();
  for (const n of meta?.nodes ?? []) {
    if (!/loadimage$/i.test(String(n.type ?? ""))) continue;
    const raw = n.inputs?.image;
    if (typeof raw !== "string") continue;
    const fromOutput = OUTPUT_TAG.test(raw);
    const file = fromOutput ? raw.replace(OUTPUT_TAG, "") : raw;
    if (!NODE_IMG_EXT.test(file) || seen.has(file)) continue;
    seen.add(file);
    out.push({
      label: `${n.title ?? n.type} — image`,
      file,
      fromOutput, // LoadImage-from-output: served by the output bytes route
      src: host
        ? (fromOutput
          ? `/api/collections/${encodeURIComponent(host)}/entries/${encodeURIComponent(file)}/bytes`
          : `/api/collections/${encodeURIComponent(host)}/entries/${encodeURIComponent(file)}/bytes?kind=input`)
        : null,
    });
  }
  return out;
}
