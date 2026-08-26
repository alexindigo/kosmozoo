// client/js/variations.mjs — variations knowledge service.
//
// The parameter registry (display labels, ranges, precision, steps), the
// current-value extraction and the range/snap math. The surfaces live in
// <VariationsModal>/<SliderRow> (client/app/components/); the engine-side
// endpoints are the variations plugin's /probe and /run.

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
  lora_strength:      { label: "lora strength",       decimals: 2, clamp: [-2, 2], defaultInc: 0.1, spread: 0.3 },
  lora_clip_strength: { label: "lora clip strength",  decimals: 2, clamp: [-2, 2], defaultInc: 0.1, spread: 0.3 },
};

// Deterministic display order — matches the mockup and the extractor's
// probe order. Parameters not in the registry are ignored.
export const PARAM_ORDER = [
  "denoise", "ipa_weight", "steps", "cfg", "seed",
  "guidance", "lora_strength", "lora_clip_strength", "shift", "pulid_weight",
];

export function paramDef(key) {
  const reg = PARAM_REGISTRY[key];
  if (!reg) return null;
  return { key, ...reg };
}

export function currentValue(key, meta) {
  const raw = meta?.[key];
  if (key === "lora_strength" || key === "lora_clip_strength") {
    // meta.loras is a list of loaders; the fallback current is the first
    // one's model strength (clip strength isn't extracted — the probe
    // endpoint is the authority for that row).
    const first = (meta?.loras ?? [])[0];
    const v = parseFloat(first?.strength);
    return isNaN(v) ? null : v;
  }
  if (raw == null) return null;
  if (key === "ipa_weight") {
    const first = String(raw).split("+")[0];
    const v = parseFloat(first);
    return isNaN(v) ? null : v;
  }
  const v = parseFloat(raw);
  return isNaN(v) ? null : v;
}

// Fallback list when the probe endpoint isn't available (e.g. image not
// ingested yet). Uses the extracted metadata to guess which params the
// graph carries — a param is presumed present if meta has a value for it.
export function fallbackParams(meta) {
  const out = [];
  for (const key of PARAM_ORDER) {
    const cur = currentValue(key, meta);
    if (cur == null) continue;
    out.push({ key, label: key, current: cur });
  }
  return out;
}

export function defaultRange(param, current) {
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
export function snapTo(v, inc, decimals) {
  if (!inc || inc <= 0) return v;
  const f = Math.pow(10, decimals);
  return Math.round(Math.round(v / inc) * inc * f) / f;
}

// Trim trailing zeros for display: 0.60 -> "0.6", 20.0 -> "20"
export function fmt(v) {
  return String(parseFloat(Number(v).toFixed(10)));
}
