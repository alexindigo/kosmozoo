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
  denoise:      { label: "denoise",      decimals: 2, clamp: [0, 1],          defaultInc: 0.05, spread: 0.15 },
  ipa_weight:   { label: "ipa weight",   decimals: 2, clamp: [0, 2],          defaultInc: 0.05, spread: 0.3  },
  steps:        { label: "steps",        decimals: 0, clamp: [1, 150],        defaultInc: 1,    spread: 10   },
  cfg:          { label: "cfg",          decimals: 1, clamp: [0, 30],         defaultInc: 0.5,  spread: 2    },
  seed:         { label: "seed",         decimals: 0, clamp: [0, 4294967295], defaultInc: 1,    spread: 100  },
  guidance:     { label: "guidance",     decimals: 1, clamp: [0, 30],         defaultInc: 0.5,  spread: 2    },
  shift:        { label: "shift",        decimals: 2, clamp: [0, 10],         defaultInc: 0.5,  spread: 1    },
  pulid_weight: { label: "pulid weight", decimals: 2, clamp: [0, 2],          defaultInc: 0.05, spread: 0.3  },
};

// Deterministic display order — matches the mockup and the extractor's
// probe order. Parameters not in the registry are ignored.
const PARAM_ORDER = [
  "denoise", "ipa_weight", "steps", "cfg", "seed",
  "guidance", "shift", "pulid_weight",
];

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

  // Track placeholder keys per param so the enable/disable path can
  // auto-insert / remove them in the suffix. The key mutates after the
  // probe returns (e.g. denoise -> scheduler:denoise) — the row exposes
  // its current placeholderKey via getPlaceholderKey().
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
      try {
        const row = buildSliderRow(p, current, def, (state) => {
          const wasEnabled = ranges[p.key]?.enabled;
          ranges[p.key] = state;
          if (state.enabled !== wasEnabled) {
            reorderSliderCards();
            if (state.enabled) autoInsertSuffix(state.placeholderKey);
            else autoRemoveSuffix(state.placeholderKey);
          }
          updateCount();
        }, templateTarget);
        if (label && label !== p.key) row.setLabel(label);
        sliders.appendChild(row.el);
        ranges[p.key] = { min: def.min, max: def.max, enabled: false, increment: p.defaultInc };
        rows[p.key] = row;
      } catch (e) {
        console.error(`[variations] buildSliderRow(${key}) failed:`, e);
      }
    }
    // Default-on: denoise is the most common single-axis sweep. If the
    // graph exposes it, flip it on so the user lands on a sensible starting
    // state (auto-suffix + reorder + count all happen via the change event).
    if (rows.denoise) {
      rows.denoise.cb.checked = true;
      rows.denoise.cb.dispatchEvent(new Event("change"));
    }
    updateCount();
  }

  // Move enabled cards to the top of the sliders container, keeping
  // registry order within each group. DOM reorder — no re-render.
  function reorderSliderCards() {
    const items = [...sliders.children].filter((el) => el.classList.contains("vz-slider-row"));
    // Deterministic sort key: enabled first (0), disabled second (1);
    // within each group, PARAM_ORDER index.
    const keyOrder = new Map(PARAM_ORDER.map((k, i) => [k, i]));
    items.sort((a, b) => {
      const ea = a.classList.contains("vz-off") ? 1 : 0;
      const eb = b.classList.contains("vz-off") ? 1 : 0;
      if (ea !== eb) return ea - eb;
      return (keyOrder.get(a.dataset.paramKey) ?? 999) - (keyOrder.get(b.dataset.paramKey) ?? 999);
    });
    for (const el of items) sliders.appendChild(el);
  }

  // Append `_{key}` to the suffix if not already present. No trailing
  // underscore — ComfyUI's SaveImage node writes `<prefix>_<counter>_.<ext>`
  // and adds its own separator underscore before the counter. Trailing
  // one here would double up.
  function autoInsertSuffix(placeholderKey) {
    if (!placeholderKey) return;
    const token = `_{${placeholderKey}}`;
    if (suffixInput.value.includes(token)) return;
    suffixInput.value = suffixInput.value + token;
  }

  // Remove `_{key}` from the suffix if present. Idempotent.
  function autoRemoveSuffix(placeholderKey) {
    if (!placeholderKey) return;
    const token = `_{${placeholderKey}}`;
    if (!suffixInput.value.includes(token)) return;
    suffixInput.value = suffixInput.value.split(token).join("");
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
  // No default — enabling a param auto-inserts its `_{key}_` here.
  suffixInput.value = "";
  suffixInput.title = "click a slider label to insert its {placeholder} (enabled sliders auto-append)";

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

  // Spacer pushes Run + error to the BOTTOM of the right column, so the
  // primary action sits opposite the tallest content on the left.
  const rightSpacer = document.createElement("div");
  rightSpacer.className = "vz-rspacer";

  right.append(
    countLabel, countEl,
    prefixLabel, prefixInput,
    suffixLabel, suffixInput,
    rightSpacer,
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
  console.log("[variations] fetching probe for", image.id);
  fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
    .then((r) => {
      console.log("[variations] probe status:", r.status);
      return r.ok ? r.json() : null;
    })
    .then((data) => {
      console.log("[variations] probe data:", JSON.stringify(data?.params ?? null));
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
      console.log("[variations] forGraph:", forGraph.length, "params");
      renderSliderRows(forGraph);
    })
    .catch((e) => {
      console.warn("[variations] probe failed:", e);
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
    const n = anyEnabled ? total : 0;
    countEl.textContent = String(n);
    // Warning colors: >1000 red, >100 yellow, otherwise the default. This
    // is a gentle "you're about to submit a lot of runs" cue.
    countEl.classList.toggle("vz-count-warn", n > 100 && n <= 1000);
    countEl.classList.toggle("vz-count-hot", n > 1000);
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
// The dual-thumb slider is noUiSlider (MIT, vendored at
// client/vendor/nouislider.min.js). It renders two draggable handles on a
// track, with a connect band between them. Alignment is structural:
// noUiSlider's internal layout puts thumbs and track on the same
// centerline by construction. Drag snaps to the row's increment; keyboard
// nudge on a focused handle uses the fine step.

function buildSliderRow(param, current, defaults, onChange, templateTarget) {
  const el = document.createElement("div");
  el.className = "vz-slider-row vz-off";
  el.dataset.paramKey = param.key;

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

  // Lane 1: min/max value labels above the track. Absolute `left: %` is
  // the only positioning — horizontal only, set by JS.
  const laneLabels = document.createElement("div");
  laneLabels.className = "vz-lane vz-lane-labels";
  const minLabel = document.createElement("div");
  minLabel.className = "vz-bound vz-min-lbl";
  const maxLabel = document.createElement("div");
  maxLabel.className = "vz-bound vz-max-lbl";
  laneLabels.append(minLabel, maxLabel);

  // Lane 2: the noUiSlider element. The library renders the track, both
  // thumbs, and the connect band inside this div. We add our orange marker
  // on top as an absolutely positioned overlay.
  const laneTrack = document.createElement("div");
  laneTrack.className = "vz-lane vz-lane-track";

  const sliderEl = document.createElement("div");
  sliderEl.className = "vz-slider";
  laneTrack.appendChild(sliderEl);

  const marker = document.createElement("div");
  marker.className = "vz-marker";
  laneTrack.appendChild(marker);

  // Lane 3: current-value label below the track.
  const laneCurrent = document.createElement("div");
  laneCurrent.className = "vz-lane vz-lane-current";
  const curLabel = document.createElement("div");
  curLabel.className = "vz-current";
  laneCurrent.appendChild(curLabel);

  rangeWrap.append(laneLabels, laneTrack, laneCurrent);

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

  const incInput = document.createElement("input");
  incInput.type = "number";
  incInput.className = "vz-row-inc-input";
  incInput.value = String(increment);
  incInput.step = String(fineStep);
  incInput.min = String(fineStep);

  const incPlus = document.createElement("button");
  incPlus.className = "vz-step-btn";
  incPlus.textContent = "+";
  incPlus.title = "larger step";

  function commitInc(v) {
    increment = Math.max(fineStep, +Number(v).toFixed(param.decimals + 3));
    incInput.value = String(increment);
    // Don't change slider.options.step — that would break keyboard nudge
    // (arrow keys use options.step). Drag snapping is handled in the
    // `slide` event which only fires during pointer drag.
    fireChange();
  }
  incMinus.addEventListener("click", () => commitInc(Math.max(fineStep, increment / 2)));
  incPlus.addEventListener("click", () => commitInc(increment * 2));
  incInput.addEventListener("change", () => commitInc(parseFloat(incInput.value) || param.defaultInc));

  incWrap.append(incMinus, incInput, incPlus);

  // --- the slider ---
  // step: fineStep — keyboard nudges use the fine step directly.
  // Drag snapping is handled in the `slide` event: we snap to the row's
  // increment and set the values back. This way keyboard and drag have
  // different step sizes without fighting the library's internal step.
  const slider = noUiSlider.create(sliderEl, {
    start: [defaults.min, defaults.max],
    connect: true,
    range: { min: param.clamp[0], max: param.clamp[1] },
    step: fineStep,           // keyboard nudges use the fine step
    behaviour: "drag",        // allow dragging the connect band
    keyboardSupport: true,
  });

  // Wire updates: min/max labels, marker position, fireChange
  slider.on("update", (values) => {
    const [lo, hi] = values.map(Number);
    minLabel.textContent = fmt(lo);
    maxLabel.textContent = fmt(hi);
    const range = param.clamp[1] - param.clamp[0];
    minLabel.style.left = ((lo - param.clamp[0]) / range) * 100 + "%";
    maxLabel.style.left = ((hi - param.clamp[0]) / range) * 100 + "%";
    fireChange();
  });

  // Drag snap: the slide event fires during pointer drag with the current
  // (fine-stepped) values. Snap to the row's increment and set back.
  slider.on("slide", (values) => {
    const snapped = values.map((v) => snapTo(Number(v), increment, param.decimals));
    if (snapped[0] !== Number(values[0]) || snapped[1] !== Number(values[1])) {
      slider.set(snapped.map(String));
    }
  });

  function fireChange() {
    const values = slider.get().map(Number);
    const lo = Math.min(values[0], values[1]);
    const hi = Math.max(values[0], values[1]);
    onChange({ enabled: cb.checked, min: lo, max: hi, increment, placeholderKey });
  }

  // Checkbox enables/disables the slider (attribute goes on the DOM element,
  // not the API object).
  cb.addEventListener("change", () => {
    const on = cb.checked;
    if (on) sliderEl.removeAttribute("disabled");
    else sliderEl.setAttribute("disabled", true);
    incInput.disabled = !on;
    incMinus.disabled = !on;
    incPlus.disabled = !on;
    el.classList.toggle("vz-off", !on);
    fireChange();
  });

  // Initial state: disabled
  sliderEl.setAttribute("disabled", true);

  inner.append(label, rangeWrap);
  el.append(cb, inner, incWrap);

  // The slider fires `update` once on create, so labels paint immediately.

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

  return {
    el, cb, slider,
    setLabel, setCurrent, setAbsent, setWriteOnly,
    getPlaceholderKey: () => placeholderKey,
  };
}
