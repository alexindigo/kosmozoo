// client/js/variations.mjs — variations panel: overlay on a card's image
// area for batch parameter sweeps.
//
// The panel is absolutely positioned within the card's .imgwrap (which has
// position: relative), covers the image, and scrolls with the card.
// Multiple panels can be open simultaneously (tracked in a Map by image id).
//
// Layout matches the mockup:
//   - Title centered at top of the left area
//   - Left column: 4 slider rows (checkbox + label + dual-thumb slider)
//   - Vertical divider
//   - Right column: increments (-/+ stepper), variations count (big),
//     prefix, suffix, Run button
//
// The panel populates from the image's extracted metadata: each slider's
// current value is read from image.meta and shown as the orange marker;
// min/max bounds default to a sensible spread around that value.

import { iconSvg } from "./icons.mjs";

// --- parameter definitions ---------------------------------------------------

const PARAMS = [
  { key: "denoise",    label: "denoise",    decimals: 2, clamp: [0, 1],           spread: 0.15 },
  { key: "ipa_weight", label: "ipa weight", decimals: 2, clamp: [0, 2],           spread: 0.3  },
  { key: "steps",      label: "steps",      decimals: 0, clamp: [1, 150],         spread: 10   },
  { key: "cfg",        label: "cfg",        decimals: 1, clamp: [0, 30],          spread: 2    },
  { key: "seed",       label: "seed",       decimals: 0, clamp: [0, 4294967295],  spread: 100  },
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
    const first = String(raw).split("+")[0];
    const v = parseFloat(first);
    return isNaN(v) ? null : v;
  }
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

function defaultRange(param, current) {
  if (current == null) return { min: param.clamp[0], max: param.clamp[1] };
  const f = Math.pow(10, param.decimals);
  let lo = Math.round((current - param.spread) * f) / f;
  let hi = Math.round((current + param.spread) * f) / f;
  lo = Math.max(lo, param.clamp[0]);
  hi = Math.min(hi, param.clamp[1]);
  if (lo >= hi) {
    lo = Math.max(param.clamp[0], current - param.spread * 2);
    hi = Math.min(param.clamp[1], current + param.spread * 2);
    if (lo >= hi) { lo = param.clamp[0]; hi = param.clamp[1]; }
  }
  return { min: lo, max: hi };
}

// --- panel construction ---------------------------------------------------------

function openPanel(cardEl, image) {
  const imgwrap = cardEl.querySelector(".imgwrap");
  if (!imgwrap) return;

  const meta = image.meta ?? {};
  const panel = document.createElement("div");
  panel.className = "vz-panel";
  // Block pointer events from reaching the image below
  panel.addEventListener("click", (e) => e.stopPropagation());
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  panel.addEventListener("pointerup", (e) => e.stopPropagation());
  panel.addEventListener("wheel", (e) => e.stopPropagation());

  const ranges = {};

  // Tracks the last-focused prefix/suffix input so slider labels can insert
  // {key} placeholders at the cursor. Held in a closure so the label
  // mousedown handlers see the currently-focused input.
  const templateTarget = { input: null, start: 0, end: 0 };

  // --- left column: title + sliders ---
  const left = document.createElement("div");
  left.className = "vz-left";

  const title = document.createElement("div");
  title.className = "vz-title";
  title.textContent = "Generate image variations";
  left.appendChild(title);

  const sliders = document.createElement("div");
  sliders.className = "vz-sliders";
  const rows = {}; // param key -> { el, setLabel, setCurrent }
  for (const p of PARAMS) {
    const current = currentValue(p.key, meta);
    const def = defaultRange(p, current);
    const row = buildSliderRow(p, current, def, (enabled, min, max) => {
      ranges[p.key] = { min, max, enabled };
      updateCount();
    }, templateTarget);
    sliders.appendChild(row.el);
    ranges[p.key] = { min: def.min, max: def.max, enabled: false };
    rows[p.key] = row;
  }
  left.appendChild(sliders);

  // Probe the graph asynchronously for the canonical label per param
  // (e.g. "scheduler:denoise" vs "denoise") and current values authoritatively
  // read from the graph itself. Panel is visible immediately with meta-based
  // defaults; labels/currents refine when probe returns.
  fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data?.params) return;
      for (const [param, info] of Object.entries(data.params)) {
        const row = rows[param];
        if (!row) continue;
        if (!info) {
          row.setAbsent();
          continue;
        }
        if (info.label) row.setLabel(info.label);
        if (info.current != null) row.setCurrent(info.current);
      }
    })
    .catch(() => { /* probe unavailable — labels stay at PARAMS defaults */ });

  // --- vertical divider ---
  const divider = document.createElement("div");
  divider.className = "vz-divider";

  // --- right column: config + run ---
  const right = document.createElement("div");
  right.className = "vz-right";

  // increments (with -/+ stepper)
  const incLabel = document.createElement("div");
  incLabel.className = "vz-rlabel";
  incLabel.textContent = "increments";

  const incRow = document.createElement("div");
  incRow.className = "vz-incrow";
  const incMinus = document.createElement("button");
  incMinus.className = "vz-step-btn";
  incMinus.textContent = "−";
  incMinus.title = "decrease";
  const incInput = document.createElement("input");
  incInput.type = "number";
  incInput.className = "vz-inc";
  incInput.value = "0.05";
  incInput.step = "0.01";
  incInput.min = "0.001";
  const incPlus = document.createElement("button");
  incPlus.className = "vz-step-btn";
  incPlus.textContent = "+";
  incPlus.title = "increase";
  incMinus.addEventListener("click", () => {
    const v = parseFloat(incInput.value) || 0.05;
    incInput.value = Math.max(0.001, +(v - 0.01).toFixed(3));
    updateCount();
  });
  incPlus.addEventListener("click", () => {
    const v = parseFloat(incInput.value) || 0.05;
    incInput.value = +(v + 0.01).toFixed(3);
    updateCount();
  });
  incInput.addEventListener("input", updateCount);
  incRow.append(incMinus, incInput, incPlus);

  // variations count
  const countLabel = document.createElement("div");
  countLabel.className = "vz-rlabel";
  countLabel.textContent = "variations";
  const countEl = document.createElement("div");
  countEl.className = "vz-count";
  countEl.textContent = "0";

  // prefix
  const prefixLabel = document.createElement("div");
  prefixLabel.className = "vz-rlabel";
  prefixLabel.textContent = "prefix";
  const prefixInput = document.createElement("input");
  prefixInput.type = "text";
  prefixInput.className = "vz-tinput vz-prefix";
  prefixInput.title = "click a slider name (denoise/ipa weight/steps/cfg) to insert its placeholder";

  // suffix
  const suffixLabel = document.createElement("div");
  suffixLabel.className = "vz-rlabel";
  suffixLabel.textContent = "suffix";
  const suffixInput = document.createElement("input");
  suffixInput.type = "text";
  suffixInput.className = "vz-tinput vz-suffix";
  suffixInput.value = "_{denoise}_";
  suffixInput.title = "click a slider name (denoise/ipa weight/steps/cfg) to insert its placeholder";

  // Track focused template input so slider-label clicks insert into it.
  for (const inp of [prefixInput, suffixInput]) {
    const remember = () => {
      templateTarget.input = inp;
      templateTarget.start = inp.selectionStart ?? inp.value.length;
      templateTarget.end = inp.selectionEnd ?? inp.value.length;
    };
    inp.addEventListener("focus", remember);
    inp.addEventListener("select", remember);
    inp.addEventListener("keyup", remember);
    inp.addEventListener("mouseup", remember);
    inp.addEventListener("input", remember);
  }

  // Run button
  const runBtn = document.createElement("button");
  runBtn.className = "vz-run";
  runBtn.textContent = "Run";
  runBtn.addEventListener("click", () => runVariations(image));

  // error area
  const errEl = document.createElement("div");
  errEl.className = "vz-error";

  right.append(
    incLabel, incRow,
    countLabel, countEl,
    prefixLabel, prefixInput,
    suffixLabel, suffixInput,
    runBtn, errEl,
  );

  panel.append(left, divider, right);
  imgwrap.appendChild(panel);

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
    if (anyEnabled && total > 0) total -= 1;
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
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!res.ok) {
        errEl.textContent = data?.error ?? text ?? `error ${res.status}`;
        return;
      }
      errEl.textContent = `submitted ${data.submitted}/${data.total}`;
      errEl.classList.add("vz-ok");
      setTimeout(() => closePanel(), 3000);
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

  const closeBtn = document.createElement("button");
  closeBtn.className = "vz-close";
  closeBtn.innerHTML = iconSvg("x", 14);
  closeBtn.title = "close";
  closeBtn.addEventListener("click", closePanel);
  panel.appendChild(closeBtn);

  updateCount();
}

// --- slider row builder --------------------------------------------------------
//
// Each row layout (matching the mockup):
//   [☐]  label
//        [min-value]        [max-value]
//        ●─────────●
//              [current]
//
// Checkbox on the far left, label above the slider, dual-thumb slider with
// numeric labels above each thumb, orange marker below with current value.

function buildSliderRow(param, current, defaults, onChange, templateTarget) {
  const el = document.createElement("div");
  el.className = "vz-slider-row vz-off";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "vz-cb";

  const inner = document.createElement("div");
  inner.className = "vz-slider-inner";

  // The label's placeholder key is mutable — updated by setLabel() after
  // the async probe returns (e.g. "denoise" -> "scheduler:denoise").
  let placeholderKey = param.key;

  const label = document.createElement("div");
  label.className = "vz-label";
  label.textContent = param.label;
  label.title = "click to insert {" + placeholderKey + "} into prefix/suffix";
  // mousedown fires before the input's blur, so the input still holds
  // the cursor position we captured in templateTarget.
  label.addEventListener("mousedown", (e) => {
    if (!templateTarget?.input) return;
    e.preventDefault(); // don't steal focus from the input
    const inp = templateTarget.input;
    const s = templateTarget.start;
    const en = templateTarget.end;
    const placeholder = "{" + placeholderKey + "}";
    inp.value = inp.value.slice(0, s) + placeholder + inp.value.slice(en);
    const caret = s + placeholder.length;
    inp.setSelectionRange(caret, caret);
    templateTarget.start = caret;
    templateTarget.end = caret;
    inp.focus();
  });

  const rangeWrap = document.createElement("div");
  rangeWrap.className = "vz-rangewrap";

  const step = Math.pow(10, -param.decimals);

  // Min/max value labels above the thumbs
  const minLabel = document.createElement("div");
  minLabel.className = "vz-bound vz-min-lbl";
  minLabel.textContent = String(defaults.min);

  const maxLabel = document.createElement("div");
  maxLabel.className = "vz-bound vz-max-lbl";
  maxLabel.textContent = String(defaults.max);

  // Dual-thumb range inputs
  const minRange = document.createElement("input");
  minRange.type = "range";
  minRange.className = "vz-thumb vz-thumb-min";
  minRange.min = param.clamp[0];
  minRange.max = param.clamp[1];
  minRange.step = step;
  minRange.value = defaults.min;
  minRange.disabled = true;

  const maxRange = document.createElement("input");
  maxRange.type = "range";
  maxRange.className = "vz-thumb vz-thumb-max";
  maxRange.min = param.clamp[0];
  maxRange.max = param.clamp[1];
  maxRange.step = step;
  maxRange.value = defaults.max;
  maxRange.disabled = true;

  // The colored band between the two thumbs
  const track = document.createElement("div");
  track.className = "vz-track";

  // Orange tick at current value + label below
  const marker = document.createElement("div");
  marker.className = "vz-marker";
  const curLabel = document.createElement("div");
  curLabel.className = "vz-current";
  if (current != null) {
    curLabel.textContent = String(current);
    const pct = ((current - param.clamp[0]) / (param.clamp[1] - param.clamp[0])) * 100;
    marker.style.left = `${pct}%`;
    curLabel.style.left = `${pct}%`;
  } else {
    marker.style.display = "none";
    curLabel.style.display = "none";
  }

  function updateTrack(silent = false) {
    const minV = parseFloat(minRange.value);
    const maxV = parseFloat(maxRange.value);
    const lo = Math.min(minV, maxV);
    const hi = Math.max(minV, maxV);
    const range = param.clamp[1] - param.clamp[0];
    const lpct = ((lo - param.clamp[0]) / range) * 100;
    const rpct = ((hi - param.clamp[0]) / range) * 100;
    track.style.left = lpct + "%";
    track.style.width = (rpct - lpct) + "%";
    minLabel.textContent = String(lo);
    maxLabel.textContent = String(hi);
    minLabel.style.left = lpct + "%";
    maxLabel.style.left = rpct + "%";
    if (!silent) onChange(cb.checked, lo, hi);
  }

  minRange.addEventListener("input", () => {
    if (parseFloat(minRange.value) > parseFloat(maxRange.value)) {
      minRange.value = maxRange.value;
    }
    updateTrack();
  });
  maxRange.addEventListener("input", () => {
    if (parseFloat(maxRange.value) < parseFloat(minRange.value)) {
      maxRange.value = minRange.value;
    }
    updateTrack();
  });

  cb.addEventListener("change", () => {
    const on = cb.checked;
    minRange.disabled = !on;
    maxRange.disabled = !on;
    el.classList.toggle("vz-off", !on);
    updateTrack();
  });

  rangeWrap.append(minLabel, maxLabel, minRange, maxRange, track, marker, curLabel);
  inner.append(label, rangeWrap);
  el.append(cb, inner);

  updateTrack(true);

  // Refine the placeholder key from the graph probe (e.g. "scheduler:denoise").
  // The visible label stays the human-friendly PARAMS.label; only the
  // insertion string and tooltip change.
  function setLabel(newKey) {
    placeholderKey = newKey;
    label.title = "click to insert {" + placeholderKey + "} into prefix/suffix";
  }

  // Refresh the orange marker with the authoritative current value from the
  // graph (may differ from meta when the extractor version is behind).
  function setCurrent(v) {
    if (v == null) {
      marker.style.display = "none";
      curLabel.style.display = "none";
      return;
    }
    marker.style.display = "";
    curLabel.style.display = "";
    curLabel.textContent = String(v);
    const pct = ((v - param.clamp[0]) / (param.clamp[1] - param.clamp[0])) * 100;
    marker.style.left = `${pct}%`;
    curLabel.style.left = `${pct}%`;
  }

  // The graph doesn't carry this parameter — grey the whole row out and keep
  // the checkbox disabled.
  function setAbsent() {
    cb.disabled = true;
    el.classList.add("vz-absent");
    label.title = "not present in this image's graph";
    marker.style.display = "none";
    curLabel.style.display = "none";
  }

  return { el, cb, minRange, maxRange, setLabel, setCurrent, setAbsent };
}
