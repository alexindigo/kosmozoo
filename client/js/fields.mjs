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
    const label = `${groupTitle(classType)} — ${input}`;
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
    const label = `${groupTitle(classType)} — ${input}`;
    bits.push(`${label} ${vals.map((x) => formatScalar(x)).join(", ")}`);
  }
  return bits.join(" · ");
}

// full rows (details pane / ⓘ overlay): every field the image carries
export function fullFieldRows(meta) {
  return materializeRows(meta, { gated: false });
}

// node inputs whose value names an image file (LoadImage-style references).
// Deduped: two nodes referencing the same file render one image. With a
// host, each entry carries its input-bytes src.
const NODE_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i;

export function nodeImages(meta, host) {
  const out = [];
  const seen = new Set();
  for (const n of meta?.nodes ?? []) {
    for (const [k, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v !== "string" || !NODE_IMG_EXT.test(v) || seen.has(v)) continue;
      seen.add(v);
      out.push({
        label: `${n.title ?? n.type} — ${k}`,
        file: v,
        src: host ? `/api/input-bytes/${encodeURIComponent(host)}/${encodeURIComponent(v)}` : null,
      });
    }
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
// Fields group into collapsible per-node sections ("Load " prefixes strip
// off the group name; collapse state persists in localStorage).
export function buildMetaBody(meta, host, { skipImages = false } = {}) {
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
  // group rows by their node (the part before " — "), first-appearance order
  const groups = new Map();
  for (const [label, v, long] of rows) {
    const i = label.indexOf(" — ");
    const g = i > 0 ? label.slice(0, i) : label;
    const key = g.replace(/^Load /, "");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push([label.slice(i + 3), v, long]);
  }
  const groupState = infoGroupState();
  for (const [group, grows] of groups) {
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
      const line = document.createElement("div");
      const lab = document.createElement("span");
      lab.className = "plabel";
      lab.textContent = `${input}: `;
      // image-file values (LoadImage-style refs, host known) render as links:
      // the consumer (details pane) focuses the images column on that image
      if (host && NODE_IMG_EXT.test(v)) {
        const ref = document.createElement("span");
        ref.className = "imgref";
        ref.dataset.file = v;
        ref.textContent = v;
        line.append(lab, ref);
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
      txt.className = "infotext";
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
