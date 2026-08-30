// client-solid/store/fields.tsx — the metadata fields machinery, parameterized
// over the store's node registry + stored picker cfg (plan §2: kept logic,
// rewired to the store). NOTHING is hardcoded about nodes: the field list
// derives from the engine's node registry; a field id is `<class_type>.<input>`.
// The legacy fields.mjs keeps its state-bound copy until cutover.

const LONG_TEXT = 120; // chars: full-text fields render in the desc area

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

// [[id, getter]] flat, sorted by group title then input — the registry shape
export function fieldList(registry) {
  const reg = registry ?? {};
  return Object.entries(reg)
    .sort(([a, aInfo], [b, bInfo]) => (aInfo.title || a).localeCompare(bInfo.title || b))
    .flatMap(([classType, info]) =>
      Object.keys(info.inputs ?? {}).sort()
        .map((input) => [fieldId(classType, input), fieldGetter(classType, input)]));
}

// Picker config merged over the live list: fields may come and go with the
// registry; preserved toggles for ids not yet discovered still apply when
// they appear.
export function fieldsCfgFrom(list, stored) {
  const out = {};
  for (const [id] of list) {
    out[id] = { card: false, strip: false, ...(stored?.[id] ?? {}) };
  }
  for (const [id, cfg] of Object.entries(stored ?? {})) {
    if (!(id in out)) out[id] = { card: cfg.card ?? false, strip: cfg.strip ?? false };
  }
  return out;
}

export function formatScalar(v) {
  if (typeof v === "number") return String(parseFloat(v.toFixed(10)));
  return String(v);
}

// [label, text, long?] rows from meta, gated by cfg.card when gated=true.
// Rows are labeled by the actual node name (class_type) — never the registry
// title, which any workflow renames per instance.
export function materializeRows(meta, { gated, list, cfg }) {
  const rows = [];
  for (const [id, getter] of list) {
    if (gated && !cfg[id]?.card) continue;
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

// one-line strip: short fields joined by " · " (long-field texts clipped)
export function metaStripText(meta, { list, cfg }) {
  const bits = [];
  for (const [id, getter] of list) {
    if (!cfg[id]?.strip) continue;
    const v = getter(meta);
    if (v == null) continue;
    const [classType, input] = parseFieldId(id);
    const vals = Array.isArray(v) ? v : [v];
    const label = `${classType} — ${input}`;
    bits.push(`${label} ${vals.map((x) => formatScalar(x)).join(", ")}`);
  }
  return bits.join(" · ");
}
