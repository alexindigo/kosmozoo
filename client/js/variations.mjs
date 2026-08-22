// client/js/variations.mjs — variations panel: overlay on a card's image
// area for batch parameter sweeps.
//
// The panel is absolutely positioned within the card's .imgwrap (position:
// relative), covers the image, and scrolls with the card. Multiple panels
// can be open simultaneously (tracked in a Map by image id).

import { api } from "./api.mjs";
import { iconSvg } from "./icons.mjs";

// --- parameter definitions ---------------------------------------------------

const PARAMS = [
  { key: "denoise", label: "denoise", min: 0, max: 1, decimals: 2 },
  { key: "ipa_weight", label: "ipa weight", min: 0, max: 2, decimals: 2 },
  { key: "steps", label: "steps", min: 1, max: 150, decimals: 0 },
  { key: "cfg", label: "cfg", min: 0, max: 30, decimals: 1 },
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

// --- panel construction ---------------------------------------------------------

function openPanel(cardEl, image) {
  const imgwrap = cardEl.querySelector(".imgwrap");
  if (!imgwrap) return;

  // Ensure .imgwrap is position:relative for the overlay
  if (getComputedStyle(imgwrap).position === "static") {
    imgwrap.style.position = "relative";
  }

  const meta = image.meta ?? {};
  const panel = document.createElement("div");
  panel.className = "vz-panel";

  // --- left: sliders ---
  const sliders = document.createElement("div");
  sliders.className = "vz-sliders";

  const ranges = {};
  const sliderRefs = {};

  for (const p of PARAMS) {
    const current = getCurrentValue(p.key, meta);
    const row = buildSliderRow(p, current, (enabled, min, max) => {
      ranges[p.key] = { min, max, enabled };
      updateCount();
    });
    sliders.appendChild(row.el);
    ranges[p.key] = { min: current ?? p.min, max: current ?? p.max, enabled: false };
    sliderRefs[p.key] = row;
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
  imgwrap.appendChild(panel);

  openPanels.set(image.id, { panel, card: cardEl });

  // --- helpers ---

  function getCurrentValue(key, meta) {
    const raw = meta[key];
    if (raw == null) return null;
    if (key === "ipa_weight") {
      const first = String(raw).split("+")[0];
      const v = parseFloat(first);
      return isNaN(v) ? null : v;
    }
    const v = parseFloat(raw);
    return isNaN(v) ? null : v;
  }

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
        setTimeout(() => {
          closePanel();
        }, 3000);
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

  // close on × (add a small × button)
  const closeBtn = document.createElement("button");
  closeBtn.className = "vz-close";
  closeBtn.innerHTML = iconSvg("x", 14);
  closeBtn.title = "close";
  closeBtn.addEventListener("click", closePanel);
  panel.appendChild(closeBtn);

  updateCount();
}

// --- slider row builder --------------------------------------------------------

function buildSliderRow(param, currentValue, onChange) {
  const el = document.createElement("div");
  el.className = "vz-slider-row";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "vz-cb";

  const label = document.createElement("span");
  label.className = "vz-label";
  label.textContent = param.label;

  const rangeWrap = document.createElement("div");
  rangeWrap.className = "vz-rangewrap";

  const range = document.createElement("input");
  range.type = "range";
  range.className = "vz-range";
  range.min = param.min;
  range.max = param.max;
  range.step = Math.pow(10, -param.decimals);
  range.value = currentValue ?? param.min;
  range.disabled = true;

  // Orange tick at current value
  const marker = document.createElement("div");
  marker.className = "vz-marker";
  if (currentValue != null) {
    const pct = ((currentValue - param.min) / (param.max - param.min)) * 100;
    marker.style.left = `${pct}%`;
  }

  // Min/max display
  const minInput = document.createElement("input");
  minInput.type = "number";
  minInput.className = "vz-bound vz-min";
  minInput.value = currentValue ?? param.min;
  minInput.step = Math.pow(10, -param.decimals);
  minInput.disabled = true;

  const maxInput = document.createElement("input");
  maxInput.type = "number";
  maxInput.className = "vz-bound vz-max";
  maxInput.value = param.max;
  maxInput.step = Math.pow(10, -param.decimals);
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

  range.addEventListener("input", () => {
    // For now the range slider sets the CENTER of the range.
    // The min/max inputs define the actual bounds.
    // A future iteration could use a dual-thumb slider.
  });

  minInput.addEventListener("input", fireChange);
  maxInput.addEventListener("input", fireChange);

  function fireChange() {
    const min = parseFloat(minInput.value) || param.min;
    const max = parseFloat(maxInput.value) || param.max;
    onChange(cb.checked, Math.min(min, max), Math.max(min, max));
  }

  rangeWrap.append(range, marker);
  el.append(cb, label, rangeWrap, minInput, maxInput);

  return { el, cb, range, minInput, maxInput };
}
