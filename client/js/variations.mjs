// client/js/variations.mjs — variations panel: expandable footer row within
// a card for batch parameter sweeps.
//
// The panel appears as a new row below the image, inside the card's DOM
// flow. It scrolls with the card, pushes notes/meta down, and multiple
// panels can be open simultaneously (tracked in a Map by image id).
//
// The panel populates from the image's extracted metadata: each slider's
// current value is read from image.meta and shown as the orange marker;
// min/max bounds default to a sensible spread around that value.

import { api } from "./api.mjs";
import { iconSvg } from "./icons.mjs";

// --- parameter definitions ---------------------------------------------------

// spread: how far from the current value the default min/max bounds sit.
// clamp: hard limits for the parameter.
const PARAMS = [
  { key: "denoise",    label: "denoise",    decimals: 2, clamp: [0, 1],   spread: 0.15 },
  { key: "ipa_weight", label: "ipa weight", decimals: 2, clamp: [0, 2],   spread: 0.3  },
  { key: "steps",      label: "steps",      decimals: 0, clamp: [1, 150], spread: 10   },
  { key: "cfg",        label: "cfg",        decimals: 1, clamp: [0, 30],  spread: 2    },
];

// --- open panels registry -----------------------------------------------------

const openPanels = new Map(); // image id → { panel, card }

// --- public API ---------------------------------------------------------------

export function toggleVariations(cardEl, image) {
  const existing = openPanels.get(image.id);
  if (existing) {
    existing.panel.remove();
    openPanels.delete(image.id);
    return;
  }
  openPanel(cardEl, image);
}

export function closeAllVariations() {
  for (const [, p] of openPanels) p.panel.remove();
  openPanels.clear();
}

// --- current value extraction --------------------------------------------------

function currentValue(key, meta) {
  const raw = meta[key];
  if (raw == null) return null;
  if (key === "ipa_weight") {
    // multi-node: "0.8+0.6" — take the first
    const first = String(raw).split("+")[0];
    const v = parseFloat(first);
    return isNaN(v) ? null : v;
  }
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

// Default min/max centered on the current value, clamped to the parameter's
// hard limits.
function defaultRange(param, current) {
  if (current == null) return { min: param.clamp[0], max: param.clamp[1] };
  const half = param.spread;
  let lo = current - half;
  let hi = current + half;
  // Round to the parameter's decimal precision
  const f = Math.pow(10, param.decimals);
  lo = Math.round(lo * f) / f;
  hi = Math.round(hi * f) / f;
  // Clamp
  lo = Math.max(lo, param.clamp[0]);
  hi = Math.min(hi, param.clamp[1]);
  // Ensure min < max (at least one step apart)
  if (lo >= hi) {
    lo = Math.max(param.clamp[0], current - param.spread * 2);
    hi = Math.min(param.clamp[1], current + param.spread * 2);
    if (lo >= hi) { lo = param.clamp[0]; hi = param.clamp[1]; }
  }
  return { min: lo, max: hi };
}

// --- panel construction ---------------------------------------------------------

function openPanel(cardEl, image) {
  const meta = image.meta ?? {};
  const panel = document.createElement("div");
  panel.className = "vz-panel";

  // --- left: sliders ---
  const sliders = document.createElement("div");
  sliders.className = "vz-sliders";

  const ranges = {};

  for (const p of PARAMS) {
    const current = currentValue(p.key, meta);
    const def = defaultRange(p, current);

    const row = buildSliderRow(p, current, def, (enabled, min, max) => {
      ranges[p.key] = { min, max, enabled };
      updateCount();
    });
    sliders.appendChild(row.el);
    ranges[p.key] = { min: def.min, max: def.max, enabled: false };
  }

  // --- right: config + run ---
  const right = document.createElement("div");
  right.className = "vz-right";

  const title = document.createElement("div");
  title.className = "vz-title";
  title.textContent = "Generate image variations";

  // increments
  const incRow = document.createElement("div");
  incRow.className = "vz-incrow";
  const incLabel = document.createElement("span");
  incLabel.textContent = "increments";
  const incInput = document.createElement("input");
  incInput.type = "number";
  incInput.className = "vz-inc";
  incInput.value = "0.05";
  incInput.step = "0.01";
  incInput.min = "0.001";
  incInput.addEventListener("input", updateCount);
  incRow.append(incLabel, incInput);

  // variations count
  const countEl = document.createElement("div");
  countEl.className = "vz-count";
  countEl.textContent = "0";

  // prefix
  const prefixLabel = document.createElement("label");
  prefixLabel.textContent = "prefix";
  const prefixInput = document.createElement("input");
  prefixInput.type = "text";
  prefixInput.className = "vz-prefix";
  prefixLabel.appendChild(prefixInput);

  // suffix
  const suffixLabel = document.createElement("label");
  suffixLabel.textContent = "suffix";
  const suffixInput = document.createElement("input");
  suffixInput.type = "text";
  suffixInput.className = "vz-suffix";
  suffixInput.value = "_{denoise}_";
  suffixLabel.appendChild(suffixInput);

  // run button
  const runBtn = document.createElement("button");
  runBtn.className = "vz-run";
  runBtn.textContent = "Run";
  runBtn.addEventListener("click", () => runVariations(image));

  // error area
  const errEl = document.createElement("div");
  errEl.className = "vz-error";

  right.append(title, incRow, countEl, prefixLabel, suffixLabel, runBtn, errEl);
  panel.append(sliders, right);

  // Insert as a new row in the card, after the imgwrap/ctitle area.
  // The card's .ctitle is the title row; we insert the panel right after it.
  const ctitle = cardEl.querySelector(".ctitle");
  if (ctitle && ctitle.nextSibling) {
    cardEl.insertBefore(panel, ctitle.nextSibling);
  } else {
    cardEl.appendChild(panel);
  }

  openPanels.set(image.id, { panel, card: cardEl });

  // --- helpers ---

  function updateCount() {
    const increment = parseFloat(incInput.value) || 0.05;
    let total = 1;
    let anyEnabled = false;
    for (const p of PARAMS) {
      const r = ranges[p.key];
      if (!r?.enabled) continue;
      anyEnabled = true;
      const count = Math.round((r.max - r.min) / increment) + 1;
      total *= Math.max(count, 1);
    }
    if (anyEnabled && total > 0) total -= 1; // exclude current
    countEl.textContent = anyEnabled ? String(total) : "0";
  }

  async function runVariations(img) {
    errEl.textContent = "";
    errEl.classList.remove("vz-ok");
    runBtn.disabled = true;
    runBtn.textContent = "Running…";

    try {
      const body = {
        id: img.id,
        host: img.host,
        filename: img.filename,
        ranges,
        increment: parseFloat(incInput.value) || 0.05,
        prefix: prefixInput.value,
        suffix: suffixInput.value,
      };
      const res = await fetch("/api/plugins/variations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error ?? `error ${res.status}`;
      } else {
        errEl.textContent = `submitted ${data.submitted}/${data.total}`;
        errEl.classList.add("vz-ok");
        setTimeout(() => closePanel(), 3000);
      }
    } catch (e) {
      errEl.textContent = `fetch failed: ${e.message}`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run";
    }
  }

  function closePanel() {
    panel.remove();
    openPanels.delete(image.id);
  }

  // close on ×
  const closeBtn = document.createElement("button");
  closeBtn.className = "vz-close";
  closeBtn.innerHTML = iconSvg("x", 14);
  closeBtn.title = "close";
  closeBtn.addEventListener("click", closePanel);
  panel.appendChild(closeBtn);

  updateCount();
}

// --- slider row builder --------------------------------------------------------

// Each row: checkbox + label + range slider + orange marker + min/max inputs.
// The marker sits at the image's current value. The min/max inputs default to
// a spread around that value.
function buildSliderRow(param, current, defaults, onChange) {
  const el = document.createElement("div");
  el.className = "vz-slider-row vz-off";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "vz-cb";

  const label = document.createElement("span");
  label.className = "vz-label";
  label.textContent = param.label;

  // current value display (the orange tick's numeric label)
  const curEl = document.createElement("span");
  curEl.className = "vz-current";
  curEl.textContent = current != null ? String(current) : "—";
  curEl.title = "current value";

  const rangeWrap = document.createElement("div");
  rangeWrap.className = "vz-rangewrap";

  const range = document.createElement("input");
  range.type = "range";
  range.className = "vz-range";
  range.min = param.clamp[0];
  range.max = param.clamp[1];
  range.step = Math.pow(10, -param.decimals);
  range.value = current ?? param.clamp[0];
  range.disabled = true;

  // Orange tick at current value
  const marker = document.createElement("div");
  marker.className = "vz-marker";
  if (current != null) {
    const pct = ((current - param.clamp[0]) / (param.clamp[1] - param.clamp[0])) * 100;
    marker.style.left = `${pct}%`;
  } else {
    marker.style.display = "none";
  }

  // Min/max inputs — populated with the spread defaults
  const step = Math.pow(10, -param.decimals);
  const minInput = document.createElement("input");
  minInput.type = "number";
  minInput.className = "vz-bound vz-min";
  minInput.value = defaults.min;
  minInput.step = step;
  minInput.disabled = true;

  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.className = "vz-bound vz-max";
  maxInput.value = defaults.max;
  maxInput.step = step;
  maxInput.disabled = true;

  // Wire events
  cb.addEventListener("change", () => {
    const on = cb.checked;
    range.disabled = !on;
    minInput.disabled = !on;
    maxInput.disabled = !on;
    el.classList.toggle("vz-off", !on);
    fireChange();
  });

  minInput.addEventListener("input", fireChange);
  maxInput.addEventListener("input", fireChange);

  function fireChange() {
    const lo = parseFloat(minInput.value) || defaults.min;
    const hi = parseFloat(maxInput.value) || defaults.max;
    onChange(cb.checked, Math.min(lo, hi), Math.max(lo, hi));
  }

  rangeWrap.append(range, marker);
  el.append(cb, label, curEl, rangeWrap, minInput, maxInput);

  return { el, cb, range, minInput, maxInput };
}
