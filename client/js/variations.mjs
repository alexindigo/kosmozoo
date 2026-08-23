// client/js/variations.mjs — variations panel: a real page-level modal
// for batch parameter sweeps.
//
// One modal at a time (page-level fixed overlay with backdrop). Layout:
//   - Title centered at top
//   - Left: parameter rows. Each row = checkbox + label + dual-thumb slider
//     with per-slider increment stepper on the right of the slider
//   - Vertical divider
//   - Right: variations count (big), prefix, suffix, Run
//
// Per-slider mechanics:
//   - Slider drag SNAPS to the row's increment
//   - Keyboard nudge (Arrow/PageUp/Down on focused thumb) still uses the
//     native fine step (unaffected by the increment)
//   - Orange tick + numeric value below marks the image's current value
//   - Values populated from image.meta; refined by an async /probe/<id> call
//     which also supplies per-graph labels (e.g. "scheduler:denoise")
//
// The label click inserts the per-graph placeholder key into whichever
// prefix/suffix input was last focused. Prefix/suffix WRAP the original
// filename basename in the submission (they don't replace it).

import { iconSvg } from "./icons.mjs";

// --- parameter definitions ---------------------------------------------------
//
// Client-side UI knowledge for each supported parameter (display label,
// value range, decimal precision, default step). The panel renders a row
// only for parameters that the graph actually carries — the probe endpoint
// tells us which ones apply per-image. Anything unknown to this registry
// is skipped even if the probe reports it, so a graph can't inject an
// unrenderable row.

const PARAM_REGISTRY = {
  denoise:    { label: "denoise",    decimals: 2, clamp: [0, 1],          defaultInc: 0.05, spread: 0.15 },
  ipa_weight: { label: "ipa weight", decimals: 2, clamp: [0, 2],          defaultInc: 0.05, spread: 0.3  },
  steps:      { label: "steps",      decimals: 0, clamp: [1, 150],        defaultInc: 1,    spread: 10   },
  cfg:        { label: "cfg",        decimals: 1, clamp: [0, 30],         defaultInc: 0.5,  spread: 2    },
  seed:       { label: "seed",       decimals: 0, clamp: [0, 4294967295], defaultInc: 1,    spread: 100  },
};

// Deterministic display order — matches the mockup and the extractor's
// probe order. Parameters not in the registry are ignored.
const PARAM_ORDER = ["denoise", "ipa_weight", "steps", "cfg", "seed"];

function paramDef(key) {
  const reg = PARAM_REGISTRY[key];
  if (!reg) return null;
  return { key, ...reg };
}

// Fallback list when the probe endpoint isn't available (e.g. image not
// ingested yet). Uses the extracted metadata to guess which params the
// graph carries — a param is presumed present if meta has a value for it.
function fallbackParams(meta) {
  const out = [];
  for (const key of PARAM_ORDER) {
    const cur = currentValue(key, meta);
    if (cur == null) continue;
    out.push({ key, label: key, current: cur });
  }
  return out;
}

// --- open modal registry (single instance) -----------------------------------

let openModal = null; // { root, image, cardEl } | null

export function toggleVariations(cardEl, image) {
  if (openModal && openModal.image?.id === image.id) {
    closeModal();
    return;
  }
  if (openModal) closeModal();
  openPanel(cardEl, image);
}

export function closeAllVariations() {
  closeModal();
}

function closeModal() {
  if (!openModal) return;
  openModal.root.remove();
  document.removeEventListener("keydown", openModal.onKey, true);
  openModal = null;
}

// --- current value extraction --------------------------------------------------

function currentValue(key, meta) {
  const raw = meta?.[key];
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
  const spread = param.spread ?? 1;
  const f = Math.pow(10, param.decimals);
  let lo = Math.round((current - spread) * f) / f;
  let hi = Math.round((current + spread) * f) / f;
  lo = Math.max(lo, param.clamp[0]);
  hi = Math.min(hi, param.clamp[1]);
  if (lo >= hi) {
    lo = Math.max(param.clamp[0], current - spread * 2);
    hi = Math.min(param.clamp[1], current + spread * 2);
    if (lo >= hi) { lo = param.clamp[0]; hi = param.clamp[1]; }
  }
  return { min: lo, max: hi };
}

// Round v to the nearest multiple of `inc`, respecting `decimals`.
function snapTo(v, inc, decimals) {
  if (!inc || inc <= 0) return v;
  const f = Math.pow(10, decimals);
  return Math.round(Math.round(v / inc) * inc * f) / f;
}

// Trim trailing zeros for display: 0.60 -> "0.6", 20.0 -> "20"
function fmt(v) {
  return String(parseFloat(Number(v).toFixed(10)));
}

// --- modal construction ---------------------------------------------------------

function openPanel(cardEl, image) {
  const meta = image.meta ?? {};

  // Root: fixed backdrop + centered panel
  const root = document.createElement("div");
  root.className = "vz-root";
  root.addEventListener("click", (e) => {
    if (e.target === root) closeModal();
  });

  const panel = document.createElement("div");
  panel.className = "vz-panel";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const ranges = {};   // param key -> { min, max, enabled, increment }
  const rows = {};     // param key -> row handle

  // Tracks last-focused prefix/suffix input so slider labels can insert
  // {key} placeholders at the cursor.
  const templateTarget = { input: null, start: 0, end: 0 };

  // --- title ---
  const title = document.createElement("div");
  title.className = "vz-title";
  title.textContent = "Generate image variations";

  // --- body (2 columns) ---
  const body = document.createElement("div");
  body.className = "vz-body";

  const left = document.createElement("div");
  left.className = "vz-left";

  // Slider rows are populated once the probe returns — the graph decides
  // which parameters have a target node, and we render only those.
  const sliders = document.createElement("div");
  sliders.className = "vz-sliders";
  const loading = document.createElement("div");
  loading.className = "vz-loading";
  loading.textContent = "inspecting graph…";
  sliders.appendChild(loading);
  left.appendChild(sliders);

  function renderSliderRows(paramsForGraph) {
    sliders.textContent = "";
    if (!paramsForGraph.length) {
      const empty = document.createElement("div");
      empty.className = "vz-loading";
      empty.textContent = "this graph exposes no varyable parameters";
      sliders.appendChild(empty);
      return;
    }
    for (const { key, label, current } of paramsForGraph) {
      const p = paramDef(key);
      if (!p) continue; // registry doesn't know this param — skip
      const def = defaultRange(p, current);
      const row = buildSliderRow(p, current, def, (state) => {
        ranges[p.key] = state;
        updateCount();
      }, templateTarget);
      if (label && label !== p.key) row.setLabel(label);
      sliders.appendChild(row.el);
      ranges[p.key] = { min: def.min, max: def.max, enabled: false, increment: p.defaultInc };
      rows[p.key] = row;
    }
    updateCount();
  }

  const divider = document.createElement("div");
  divider.className = "vz-divider";

  // --- right column ---
  const right = document.createElement("div");
  right.className = "vz-right";

  const countLabel = document.createElement("div");
  countLabel.className = "vz-rlabel";
  countLabel.textContent = "variations";
  const countEl = document.createElement("div");
  countEl.className = "vz-count";
  countEl.textContent = "0";

  const prefixLabel = document.createElement("div");
  prefixLabel.className = "vz-rlabel";
  prefixLabel.textContent = "prefix";
  const prefixInput = document.createElement("input");
  prefixInput.type = "text";
  prefixInput.className = "vz-tinput vz-prefix";
  prefixInput.title = "click a slider label to insert its {placeholder}";

  const suffixLabel = document.createElement("div");
  suffixLabel.className = "vz-rlabel";
  suffixLabel.textContent = "suffix";
  const suffixInput = document.createElement("input");
  suffixInput.type = "text";
  suffixInput.className = "vz-tinput vz-suffix";
  suffixInput.value = "_{denoise}_";
  suffixInput.title = "click a slider label to insert its {placeholder}";

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

  const runBtn = document.createElement("button");
  runBtn.className = "vz-run";
  runBtn.textContent = "Run";
  runBtn.addEventListener("click", () => runVariations(image));

  const errEl = document.createElement("div");
  errEl.className = "vz-error";

  right.append(
    countLabel, countEl,
    prefixLabel, prefixInput,
    suffixLabel, suffixInput,
    runBtn, errEl,
  );

  body.append(left, divider, right);

  const closeBtn = document.createElement("button");
  closeBtn.className = "vz-close";
  closeBtn.innerHTML = iconSvg("x", 16);
  closeBtn.title = "close (Esc)";
  closeBtn.addEventListener("click", closeModal);

  panel.append(title, body, closeBtn);
  root.appendChild(panel);
  document.body.appendChild(root);

  // Esc closes
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeModal(); }
  };
  document.addEventListener("keydown", onKey, true);

  openModal = { root, image, cardEl, onKey };

  // --- probe for the list of parameters this graph carries ---
  // The graph is the source of truth: only render sliders for parameters
  // whose target node exists in this image's graph. writeOnly params
  // (widget-only custom seed nodes etc.) are skipped for now — they need
  // a different UX and the user is deferring that.
  fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (!data?.params) {
        renderSliderRows(fallbackParams(meta));
        return;
      }
      const forGraph = [];
      for (const key of PARAM_ORDER) {
        const info = data.params[key];
        if (!info || info.writeOnly) continue;
        forGraph.push({ key, label: info.label, current: info.current });
      }
      renderSliderRows(forGraph);
    })
    .catch(() => {
      renderSliderRows(fallbackParams(meta));
    });

  // --- helpers ---

  function updateCount() {
    let total = 1;
    let anyEnabled = false;
    for (const [key, r] of Object.entries(ranges)) {
      if (!r?.enabled) continue;
      anyEnabled = true;
      const inc = r.increment || paramDef(key)?.defaultInc || 1;
      const count = Math.round((r.max - r.min) / inc) + 1;
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
      const reqBody = {
        id: img.id,
        host: img.host,
        filename: img.filename,
        ranges,           // now includes per-param increment
        prefix: prefixInput.value,
        suffix: suffixInput.value,
      };
      const res = await fetch("/api/plugins/variations/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
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
      setTimeout(() => closeModal(), 3000);
    } catch (e) {
      errEl.textContent = `fetch failed: ${e.message}`;
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run";
    }
  }

  updateCount();
}

// --- slider row builder --------------------------------------------------------
//
//  [☐]  label                                                    increment
//       min                                          max         [-][0.05][+]
//       ●──────────────●
//                current
//
// Dual thumbs snap to the row's increment on drag; keyboard uses native
// fine step (1 unit at the parameter's decimal precision).

function buildSliderRow(param, current, defaults, onChange, templateTarget) {
  const el = document.createElement("div");
  el.className = "vz-slider-row vz-off";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "vz-cb";

  const inner = document.createElement("div");
  inner.className = "vz-slider-inner";

  let placeholderKey = param.key;

  const label = document.createElement("div");
  label.className = "vz-label";
  label.textContent = param.label;
  label.title = "click to insert {" + placeholderKey + "} into prefix/suffix";
  label.addEventListener("mousedown", (e) => {
    if (!templateTarget?.input) return;
    e.preventDefault();
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

  // Fine keyboard step: 1 at the parameter's decimal precision.
  const fineStep = Math.pow(10, -param.decimals);
  let increment = param.defaultInc;

  const minLabel = document.createElement("div");
  minLabel.className = "vz-bound vz-min-lbl";
  const maxLabel = document.createElement("div");
  maxLabel.className = "vz-bound vz-max-lbl";

  const minRange = document.createElement("input");
  minRange.type = "range";
  minRange.className = "vz-thumb vz-thumb-min";
  minRange.min = param.clamp[0];
  minRange.max = param.clamp[1];
  minRange.step = fineStep;
  minRange.value = defaults.min;
  minRange.disabled = true;

  const maxRange = document.createElement("input");
  maxRange.type = "range";
  maxRange.className = "vz-thumb vz-thumb-max";
  maxRange.min = param.clamp[0];
  maxRange.max = param.clamp[1];
  maxRange.step = fineStep;
  maxRange.value = defaults.max;
  maxRange.disabled = true;

  const track = document.createElement("div");
  track.className = "vz-track";

  const marker = document.createElement("div");
  marker.className = "vz-marker";
  const curLabel = document.createElement("div");
  curLabel.className = "vz-current";

  function paintCurrent(v) {
    if (v == null) {
      marker.style.display = "none";
      curLabel.style.display = "none";
      return;
    }
    marker.style.display = "";
    curLabel.style.display = "";
    curLabel.textContent = fmt(v);
    const pct = ((v - param.clamp[0]) / (param.clamp[1] - param.clamp[0])) * 100;
    marker.style.left = `${pct}%`;
    curLabel.style.left = `${pct}%`;
  }
  paintCurrent(current);

  // --- per-slider increment stepper ---
  const incWrap = document.createElement("div");
  incWrap.className = "vz-row-inc";

  const incMinus = document.createElement("button");
  incMinus.className = "vz-step-btn";
  incMinus.textContent = "−";
  incMinus.title = "smaller step";
  incMinus.disabled = true;

  const incInput = document.createElement("input");
  incInput.type = "number";
  incInput.className = "vz-row-inc-input";
  incInput.value = String(increment);
  incInput.step = String(fineStep);
  incInput.min = String(fineStep);
  incInput.disabled = true;

  const incPlus = document.createElement("button");
  incPlus.className = "vz-step-btn";
  incPlus.textContent = "+";
  incPlus.title = "larger step";
  incPlus.disabled = true;

  function commitInc(v) {
    increment = Math.max(fineStep, +Number(v).toFixed(param.decimals + 3));
    incInput.value = String(increment);
    fireChange();
  }
  incMinus.addEventListener("click", () => commitInc(Math.max(fineStep, increment / 2)));
  incPlus.addEventListener("click", () => commitInc(increment * 2));
  incInput.addEventListener("change", () => commitInc(parseFloat(incInput.value) || param.defaultInc));

  incWrap.append(incMinus, incInput, incPlus);

  // --- drag-vs-keyboard snapping ---
  //
  // On pointerdown on a thumb we enter "drag" mode: subsequent `input`
  // events snap the value to the nearest multiple of `increment`. On
  // pointerup we exit drag mode. Keyboard events don't touch the drag
  // flag, so keyboard nudges keep the fine step.

  const dragging = { min: false, max: false };
  const attachDrag = (thumb, which) => {
    thumb.addEventListener("pointerdown", () => { dragging[which] = true; });
    // pointerup can fire outside the thumb; catch it globally
    const up = () => { dragging[which] = false; };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  attachDrag(minRange, "min");
  attachDrag(maxRange, "max");

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
    minLabel.textContent = fmt(lo);
    maxLabel.textContent = fmt(hi);
    minLabel.style.left = lpct + "%";
    maxLabel.style.left = rpct + "%";
    if (!silent) fireChange();
  }

  function fireChange() {
    const lo = Math.min(parseFloat(minRange.value), parseFloat(maxRange.value));
    const hi = Math.max(parseFloat(minRange.value), parseFloat(maxRange.value));
    onChange({ enabled: cb.checked, min: lo, max: hi, increment });
  }

  minRange.addEventListener("input", () => {
    if (dragging.min) {
      const snapped = snapTo(parseFloat(minRange.value), increment, param.decimals);
      minRange.value = String(snapped);
    }
    if (parseFloat(minRange.value) > parseFloat(maxRange.value)) {
      minRange.value = maxRange.value;
    }
    updateTrack();
  });
  maxRange.addEventListener("input", () => {
    if (dragging.max) {
      const snapped = snapTo(parseFloat(maxRange.value), increment, param.decimals);
      maxRange.value = String(snapped);
    }
    if (parseFloat(maxRange.value) < parseFloat(minRange.value)) {
      maxRange.value = minRange.value;
    }
    updateTrack();
  });

  cb.addEventListener("change", () => {
    const on = cb.checked;
    minRange.disabled = !on;
    maxRange.disabled = !on;
    incInput.disabled = !on;
    incMinus.disabled = !on;
    incPlus.disabled = !on;
    el.classList.toggle("vz-off", !on);
    updateTrack();
  });

  rangeWrap.append(minLabel, maxLabel, minRange, maxRange, track, marker, curLabel);
  inner.append(label, rangeWrap);
  el.append(cb, inner, incWrap);

  updateTrack(true);

  function setLabel(newKey) {
    placeholderKey = newKey;
    label.title = "click to insert {" + placeholderKey + "} into prefix/suffix";
  }
  function setCurrent(v) { paintCurrent(v); }
  function setAbsent() {
    cb.disabled = true;
    el.classList.add("vz-absent");
    label.title = "not present in this image's graph";
    marker.style.display = "none";
    curLabel.style.display = "none";
  }
  // The target node is present but its current value isn't readable
  // (widget-only custom node such as DomovoySeed). Row stays enabled —
  // varying still works, we just can't show the current-value marker.
  function setWriteOnly() {
    el.classList.add("vz-writeonly");
    marker.style.display = "none";
    curLabel.style.display = "none";
    label.title = "click to insert {" + placeholderKey +
      "} into prefix/suffix (current value not exposed by this graph)";
  }

  return { el, cb, minRange, maxRange, setLabel, setCurrent, setAbsent, setWriteOnly };
}
