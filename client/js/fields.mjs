// client/js/fields.mjs — the metadata fields registry and its surfaces.
//
// The registry itself (groups, extractors, defaults) is empirical field
// knowledge ported per plan decision #7. The surfaces are fresh:
//   card panel ("under image") + image strip — picker-governed
//   lightbox strip — picker-governed (strip column)
//   ⓘ overlay — ALL fields, picker-exempt by design (the full-details view)
// The picker overlay has per-field card/strip toggles and per-group masters.

import { S, render } from "./state.mjs";
import { api } from "./api.mjs";

export const META_FIELD_GROUPS = [
  ["KSampler", [
    ["seed",     (m) => m.seed],
    ["steps",    (m) => m.steps],
    ["cfg",      (m) => m.cfg],
    ["denoise",  (m) => m.denoise != null ? Number(m.denoise).toFixed(2) : null],
    ["sampler",  (m) => m.sampler_name
      ? (m.scheduler ? `${m.sampler_name}/${m.scheduler}` : m.sampler_name)
      : null],
  ]],
  ["LoRA loaders", [
    ["loras", (m) => (m.loras || []).map((l) =>
      l.name + (l.strength != null ? "@" + l.strength : "")).join(", ") || null],
  ]],
  ["FluxGuidance", [["guidance", (m) => m.guidance]]],
  ["Model loaders", [
    ["model", (m) => m.model],
    ["vae",   (m) => m.vae],
  ]],
  ["IPAdapter", [
    ["ipa_model",    (m) => m.ipa_model],
    ["ipa_weight",   (m) => m.ipa_weight],
    ["ipa_type",     (m) => m.ipa_type],
    ["ipa_range",    (m) => m.ipa_range],
    ["clip_vision",  (m) => m.clip_vision],
  ]],
  ["ControlNet", [["controlnet", (m) => m.controlnet]]],
  ["PuLID", [
    ["pulid",        (m) => m.pulid],
    ["pulid_weight", (m) => m.pulid_weight],
    ["pulid_range",  (m) => m.pulid_range],
  ]],
  ["ModelSampling", [["shift", (m) => m.shift]]],
  ["CLIP", [
    ["clip_skip", (m) => m.clip_skip],
    ["prompt",    (m) => m.prompt],
    ["negative",  (m) => m.negPrompt],
  ]],
  ["Latent", [["size", (m) => (m.width && m.height) ? `${m.width}×${m.height}` : null]]],
];

export const META_FIELDS = META_FIELD_GROUPS.flatMap(([, fields]) => fields);

const DEFAULT_CFG = {
  seed: { card: true, strip: false }, steps: { card: true, strip: false },
  cfg: { card: true, strip: false }, denoise: { card: true, strip: false },
  sampler: { card: true, strip: false }, loras: { card: true, strip: false },
  size: { card: true, strip: false }, prompt: { card: true, strip: false },
  // everything else off by default
};

export function loadFieldsCfg(stored) {
  const out = {};
  for (const [name] of META_FIELDS) {
    out[name] = { card: false, strip: false, ...DEFAULT_CFG[name], ...(stored?.[name] ?? {}) };
  }
  return out;
}

async function persist() {
  await api.setSettings("core.fields", { cfg: S.fieldsCfg }).catch(() => {});
}

// --- surfaces -------------------------------------------------------------------

export function fillCardMeta(props, desc, meta) {
  const cfg = S.fieldsCfg;
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
  const rows = [];
  for (const [name, get] of META_FIELDS) {
    if (name === "prompt" || name === "negative") continue;
    if (!cfg[name]?.card) continue;
    const v = get(meta);
    if (v != null && v !== "") rows.push([name, v]);
  }
  if (rows.length) {
    for (const [k, v] of rows) {
      const line = document.createElement("div");
      const label = document.createElement("span");
      label.className = "plabel";
      label.textContent = `${k}: `;
      line.append(label, document.createTextNode(v));
      props.appendChild(line);
    }
  } else {
    props.textContent = "(no sampler metadata)";
  }
  if (meta.prompt && cfg.prompt?.card) {
    const excerpt = meta.prompt.length > 300 ? meta.prompt.slice(0, 300) + "…" : meta.prompt;
    const negBit = (cfg.negative?.card && meta.negPrompt)
      ? `\n\nneg: ${meta.negPrompt.length > 140 ? meta.negPrompt.slice(0, 140) + "…" : meta.negPrompt}`
      : "";
    desc.textContent = excerpt + negBit;
    desc.title = meta.prompt;
  }
}

// one-line strip: "seed 1 · 20 steps · …"
export function metaStripText(meta) {
  const bits = [];
  for (const [name, get] of META_FIELDS) {
    if (!S.fieldsCfg[name]?.strip) continue;
    const v = get(meta);
    if (v == null || v === "") continue;
    bits.push(name === "prompt" || name === "negative" ? String(v) : `${name} ${v}`);
  }
  return bits.join(" · ");
}

// lightbox strip content
export function lightboxStripText(meta) {
  return meta ? metaStripText(meta) : "";
}

// the ⓘ overlay: every field the image carries, regardless of the picker
export function fullFieldRows(meta) {
  const rows = [];
  for (const [name, get] of META_FIELDS) {
    if (name === "prompt" || name === "negative") continue;
    const v = get(meta);
    if (v != null && v !== "") rows.push([name, v]);
  }
  return rows;
}

// picker changes re-apply to every rendered card
export function refreshAllCardMeta() {
  document.querySelectorAll(".card").forEach((card) => {
    const meta = S.images[Number(card.dataset.idx)]?.meta;
    const props = card.querySelector(".props");
    const desc = card.querySelector(".desc");
    if (props && desc) fillCardMeta(props, desc, meta);
    const strip = card.querySelector(".mstrip");
    if (strip) {
      const txt = meta ? metaStripText(meta) : "";
      strip.textContent = txt;
      strip.style.display = txt ? "block" : "none";
    }
  });
  if (S.lightbox.open) render();
}

// --- the picker overlay ------------------------------------------------------------

export function initFieldsOverlay() {
  const overlay = document.getElementById("fieldsOverlay");
  document.getElementById("fieldsClose").addEventListener("click", () => { overlay.hidden = true; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
}

export function openFieldsOverlay() {
  buildFieldsPanel();
  document.getElementById("fieldsOverlay").hidden = false;
}

function buildFieldsPanel() {
  const tbl = document.getElementById("fieldsTable");
  tbl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "frow head";
  head.innerHTML = `<span class="fname2">field (grouped by node)</span><span>under image</span><span>strip</span>`;
  tbl.appendChild(head);

  for (const [gname, fields] of META_FIELD_GROUPS) {
    const group = document.createElement("div");
    group.className = "fgroup";
    const ghead = document.createElement("div");
    ghead.className = "fgrouphead";
    const glabel = document.createElement("span");
    glabel.className = "gname";
    glabel.textContent = gname;
    ghead.appendChild(glabel);
    const gbody = document.createElement("div");
    gbody.className = "fgroupbody";
    gbody.dataset.group = gname;

    for (const col of ["card", "strip"]) {
      const master = document.createElement("label");
      master.className = "switchwrap mini";
      master.title = `toggle all ${gname} (${col === "card" ? "under image" : "strip"})`;
      const mcb = document.createElement("input");
      mcb.type = "checkbox";
      mcb.dataset.col = col;
      mcb.checked = fields.some(([n]) => S.fieldsCfg[n][col]);
      const mtrack = document.createElement("span");
      mtrack.className = "track";
      mcb.addEventListener("change", async () => {
        for (const [n] of fields) S.fieldsCfg[n][col] = mcb.checked;
        await persist();
        refreshAllCardMeta();
        gbody.querySelectorAll(`input[data-col="${col}"]`).forEach((cb) => { cb.checked = mcb.checked; });
      });
      master.append(mcb, mtrack);
      ghead.appendChild(master);
    }

    for (const [name] of fields) {
      const row = document.createElement("div");
      row.className = "frow";
      const n = document.createElement("span");
      n.className = "fname2";
      n.textContent = name;
      row.append(n, fieldToggle(name, "card", gbody), fieldToggle(name, "strip", gbody));
      gbody.appendChild(row);
    }
    group.append(ghead, gbody);
    tbl.appendChild(group);
  }
}

function fieldToggle(field, col, gbody) {
  const lab = document.createElement("label");
  lab.className = "switchwrap mini";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!S.fieldsCfg[field][col];
  cb.dataset.field = field;
  cb.dataset.col = col;
  const track = document.createElement("span");
  track.className = "track";
  cb.addEventListener("change", async () => {
    S.fieldsCfg[field][col] = cb.checked;
    await persist();
    refreshAllCardMeta();
    // sync the group masters
    const gname = gbody.dataset.group;
    const fields = META_FIELD_GROUPS.find((g) => g[0] === gname)[1];
    const group = gbody.closest(".fgroup");
    group.querySelectorAll(".fgrouphead input").forEach((m) => {
      m.checked = fields.some(([n]) => S.fieldsCfg[n][m.dataset.col]);
    });
  });
  lab.append(cb, track);
  return lab;
}
