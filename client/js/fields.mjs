// client/js/fields.mjs — the metadata fields registry and its surfaces.
//
// NOTHING is hardcoded about nodes. The field list derives from the engine's
// node registry (see /api/nodes): node types accumulate as the scraper walks,
// and each image's meta.nodes carries the actual values. A registry field id
// is `<class_type>.<input>`; value kinds stay with the id. The picker's
// card/strip toggle state persists in core.fields.cfg; surfaces render only
// fields the image actually carries.
//   card panel ("under image") — picker-governed
//   strip — picker-governed (strip column)
//   details pane / ⓘ overlay — ALL registry fields, picker-exempt by design

import { state } from "./state.mjs";
import { render } from "../app/services/notify.mjs";
import { api } from "./api.mjs";

const LONG_TEXT = 120; // chars: full-text fields render in the desc area

export function fieldId(classType, input) { return `${classType}.${input}`; }

export function parseFieldId(id) {
  const i = id.lastIndexOf(".");
  return [id.slice(0, i), id.slice(i + 1)];
}

// --- the dynamic registry → groups -------------------------------------------

// Instances of a node type in one meta, sorted by their (numeric-ish) node id.
function instancesOf(meta, classType) {
  const nodes = (meta?.nodes ?? []).filter((n) => n.type === classType);
  nodes.sort((a, b) => {
    const na = +a.id, nb = +b.id;
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.id).localeCompare(String(b.id));
  });
  return nodes;
}

// Group title for a node type: its own display title when the registry kept
// one, else the class_type itself.
function groupTitle(classType) {
  return state.nodesRegistry?.[classType]?.title || classType;
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

// [groupTitle, [[id, getter]]], sorted by group title, fields sorted by input
export function fieldGroups() {
  const reg = state.nodesRegistry ?? {};
  const entries = Object.entries(reg)
    .map(([classType, info]) => [classType, info])
    .sort(([a, aInfo], [b, bInfo]) => (aInfo.title || a).localeCompare(bInfo.title || b));
  return entries.map(([classType, info]) => [
    groupTitle(classType),
    Object.keys(info.inputs ?? {})
      .sort()
      .map((input) => [fieldId(classType, input), fieldGetter(classType, input)]),
  ]);
}

export function currentFieldList() {
  return fieldGroups().flatMap(([, fields]) => fields);
}

// --- picker config ------------------------------------------------------------

export function loadFieldsCfg(stored) {
  const out = {};
  for (const [id] of currentFieldList()) {
    out[id] = { card: false, strip: false, ...(stored?.[id] ?? {}) };
  }
  // Fields may come and go with the registry; preserved toggles for ids not
  // yet discovered still apply when they appear.
  for (const [id, cfg] of Object.entries(stored ?? {})) {
    if (!(id in out)) out[id] = { card: cfg.card ?? false, strip: cfg.strip ?? false };
  }
  return out;
}

export async function persist() {
  await api.setSettings("core.fields", { cfg: state.fieldsCfg }).catch(() => {});
}

// --- surfaces ------------------------------------------------------------------

// [label, text, long?] rows from meta, gated by cfg (card) when gated=true.
function materializeRows(meta, { gated }) {
  const rows = [];
  for (const [id, getter] of currentFieldList()) {
    if (gated && !state.fieldsCfg[id]?.card) continue;
    const v = getter(meta);
    if (v == null) continue;
    const [classType, input] = parseFieldId(id);
    const vals = Array.isArray(v) ? v : [v];
    // rows are labeled by the actual node name (class_type) — never the
    // registry title, which any workflow renames per instance
    const label = `${classType} — ${input}`;
    for (const text of vals) {
      const long = String(text).length > LONG_TEXT;
      rows.push([label, long ? String(text) : formatScalar(text), long]);
    }
  }
  return rows;
}

function formatScalar(v) {
  if (typeof v === "number") return String(parseFloat(v.toFixed(10)));
  return String(v);
}

export function fillCardMeta(props, desc, meta) {
  props.textContent = "";
  desc.textContent = "";
  desc.title = "";
  if (!meta) {
    const span = document.createElement("span");
    span.className = "nometa";
    span.textContent = "no metadata yet";
    props.appendChild(span);
    return;
  }
  const rows = materializeRows(meta, { gated: true });
  if (rows.length) {
    // long-text fields go to desc (truncated at 300 so the whole card stays
    // compact); the first one also lands in desc.title for hover
    let firstLong = true;
    for (const [label, v, long] of rows) {
      if (long) {
        desc.textContent = String(v).length > 300 ? String(v).slice(0, 300) + "…" : v;
        if (firstLong) desc.title = label + " — " + String(v);
        firstLong = false;
        continue;
      }
      const line = document.createElement("div");
      const lab = document.createElement("span");
      lab.className = "plabel";
      lab.textContent = `${label}: `;
      line.append(lab, document.createTextNode(v));
      props.appendChild(line);
    }
  } else {
    props.textContent = "(no fields toggled on this image)";
  }
}

// one-line strip: short fields joined by " · " (long-field texts clipped)
export function metaStripText(meta) {
  const bits = [];
  for (const [id, getter] of currentFieldList()) {
    if (!state.fieldsCfg[id]?.strip) continue;
    const v = getter(meta);
    if (v == null) continue;
    const [classType, input] = parseFieldId(id);
    const vals = Array.isArray(v) ? v : [v];
    const label = `${classType} — ${input}`;
    bits.push(`${label} ${vals.map((x) => formatScalar(x)).join(", ")}`);
  }
  return bits.join(" · ");
}

// full rows (details pane / ⓘ overlay): every field the image carries
export function fullFieldRows(meta) {
  return materializeRows(meta, { gated: false });
}

// The "changed vs the previous image" highlight: builds the previous meta's
// keyspace; the returned predicate marks a current row whose (label, value)
// isn't in it — a changed value, or a field the previous image didn't carry.
// Values compare through the same formatting both sides (materializeRows).
export function valueDiffer(compareMeta) {
  if (!compareMeta) return () => false;
  const seen = new Map(); // label -> Set of values (multi-instance: any match is "unchanged")
  for (const [label, v] of fullFieldRows(compareMeta)) {
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
const NODE_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;
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
          ? `/api/images/${encodeURIComponent(host + ":" + file)}/bytes`
          : `/api/input-bytes/${encodeURIComponent(host)}/${encodeURIComponent(file)}`)
        : null,
    });
  }
  return out;
}

// collapse state for the info panel's per-node sections, in localStorage
const LS_INFOGROUPS = "kosmozoo.infoGroups.v1";

function infoGroupState() {
  try { return JSON.parse(localStorage.getItem(LS_INFOGROUPS)) ?? {}; }
  catch { return {}; }
}

function setInfoGroupCollapsed(group, collapsed) {
  const s = infoGroupState();
  if (collapsed) s[group] = true;
  else delete s[group];
  try { localStorage.setItem(LS_INFOGROUPS, JSON.stringify(s)); } catch { /* ignore */ }
}

// full-metadata body, shared by the ⓘ overlay and the details workspace
// space. Returns an element; the caller appends it to its own container.
// `host` (when known) enables inline rendering of node-referenced images;
// `opts.skipImages` leaves those to a caller-drawn column instead.
// `opts.compareMeta` (the previous image's meta) marks field VALUES that
// differ from it with .pdiff (white).
// Fields group into collapsible per-node sections named by the actual node
// type (class_type — stable, never a per-instance rename; collapse state
// persists in localStorage). Prompt groups (CLIPTextEncode) sink to the
// bottom.
export function buildMetaBody(meta, host, { skipImages = false, compareMeta = null } = {}) {
  const differs = valueDiffer(compareMeta);
  const wrap = document.createElement("div");
  const rows = meta ? fullFieldRows(meta) : [];
  if (!rows.length) {
    const p = document.createElement("div");
    p.className = "info-none";
    p.textContent = meta?.nodes?.length
      ? "This image has no scalar node fields."
      : "This image has no embedded parameters.";
    wrap.appendChild(p);
    return wrap;
  }
  // group rows by their node type (the part before " — "), first-appearance
  // order
  const groups = new Map();
  for (const [label, v, long] of rows) {
    const i = label.indexOf(" — ");
    const key = i > 0 ? label.slice(0, i) : label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([label.slice(i + 3), v, long]);
  }
  // prompt groups (CLIPTextEncode) sink to the bottom of the section list
  const ordered = [...groups].sort((a, b) => +/clip\s*text\s*encode/i.test(a[0]) - +/clip\s*text\s*encode/i.test(b[0]));
  const groupState = infoGroupState();
  for (const [group, grows] of ordered) {
    const collapsed = groupState[group] === true;
    const sec = document.createElement("div");
    sec.className = "infogroup" + (collapsed ? " collapsed" : "");
    sec.dataset.group = group;
    const headBtn = document.createElement("button");
    headBtn.className = "infogroup-head";
    headBtn.title = collapsed ? "expand" : "collapse";
    headBtn.append(
      document.createTextNode(group),
      Object.assign(document.createElement("span"), { className: "chev", textContent: "▾" }),
    );
    headBtn.addEventListener("click", () => {
      const nowCollapsed = !sec.classList.contains("collapsed");
      sec.classList.toggle("collapsed", nowCollapsed);
      headBtn.title = nowCollapsed ? "expand" : "collapse";
      setInfoGroupCollapsed(group, nowCollapsed);
    });
    sec.appendChild(headBtn);
    const body = document.createElement("div");
    body.className = "infogroup-body";
    const props = document.createElement("div");
    props.className = "props";
    const longs = [];
    // short values first; text prompts (long values) render below them
    for (const [input, v, long] of grows) {
      if (long) { longs.push([input, v]); continue; }
      const changed = differs(`${group} — ${input}`, v);
      const line = document.createElement("div");
      const lab = document.createElement("span");
      lab.className = "plabel";
      lab.textContent = `${input}: `;
      // image-file values (LoadImage-style refs, host known) render as links:
      // the consumer (details pane) focuses the images column on that image
      if (host && NODE_IMG_EXT.test(v)) {
        const ref = document.createElement("span");
        ref.className = "imgref" + (changed ? " pdiff" : "");
        ref.dataset.file = v;
        ref.textContent = v;
        line.append(lab, ref);
      } else if (changed) {
        const val = document.createElement("span");
        val.className = "pdiff";
        val.textContent = v;
        line.append(lab, val);
      } else {
        line.append(lab, document.createTextNode(v));
      }
      props.appendChild(line);
    }
    body.appendChild(props);
    for (const [input, v] of longs) {
      const sec2 = document.createElement("div");
      sec2.className = "infosec";
      const lab = document.createElement("div");
      lab.className = "plabel";
      lab.textContent = input;
      const txt = document.createElement("div");
      txt.className = "infotext" + (differs(`${group} — ${input}`, v) ? " pdiff" : "");
      txt.textContent = v;
      sec2.append(lab, txt);
      body.appendChild(sec2);
    }
    sec.appendChild(body);
    wrap.appendChild(sec);
  }
  if (host && !skipImages) {
    for (const img of nodeImages(meta, host)) {
      const sec = document.createElement("div");
      sec.className = "infoimg";
      const lab = document.createElement("div");
      lab.className = "plabel";
      lab.textContent = img.label;
      const im = document.createElement("img");
      im.src = img.src;
      im.loading = "lazy";
      im.alt = img.file;
      sec.append(lab, im);
      wrap.appendChild(sec);
    }
  }
  return wrap;
}

// --- the picker overlay ------------------------------------------------------------

let onChangedHook = null;

export function initFieldsOverlay({ onChanged } = {}) {
  onChangedHook = onChanged ?? null;
}

export function notifyFieldsChanged() {
  onChangedHook?.();
}

export function openFieldsOverlay() {
  state.fieldsOverlayOpen = true;
  render();
}
