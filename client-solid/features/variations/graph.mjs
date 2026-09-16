// client-solid/features/variations/graph.mjs — variations knowledge service.
//
// The variations panel is probe-driven: the engine's /probe enumerates every
// numeric scalar input of every node instance in the image's graph; the
// client renders one row per probe entry. Defaults (decimals, step, spread)
// infer from the observed value; the OVERRIDES map below is the ONLY
// per-param knowledge left — and it's just slider tuning, not discovery.
//
// The slider row component is ./SliderRow.tsx beside this module; the
// engine-side endpoints are the variations feature's /probe and /run.

import { paramId, formatValue } from "/shared/features/variations/shared.mjs";

// --- slider tuning overrides ---------------------------------------------------
//
// id = "<class_type>.<input>" — the same identity the fields registry uses.
// Everything is inferred from the observed value when not listed here.
const OVERRIDES = {
  "KSampler.denoise":               { clamp: [0, 1], decimals: 2, defaultInc: 0.05, spread: 0.15 },
  "BasicScheduler.denoise":         { clamp: [0, 1], decimals: 2, defaultInc: 0.05, spread: 0.15 },
  "KSampler.steps":                 { clamp: [1, 150], decimals: 0, defaultInc: 1, spread: 10 },
  "BasicScheduler.steps":           { clamp: [1, 150], decimals: 0, defaultInc: 1, spread: 10 },
  "KSampler.cfg":                   { clamp: [0, 30], decimals: 1, defaultInc: 0.5, spread: 2 },
  "CFGGuider.cfg":                  { clamp: [0, 30], decimals: 1, defaultInc: 0.5, spread: 2 },
  "FluxGuidance.guidance":          { clamp: [0, 30], decimals: 1, defaultInc: 0.5, spread: 2 },
  "KSampler.seed":                  { clamp: [0, 4294967295], decimals: 0, defaultInc: 1, spread: 100 },
  "RandomNoise.noise_seed":         { clamp: [0, 4294967295], decimals: 0, defaultInc: 1, spread: 100 },
  "LoraLoaderModelOnly.strength_model": { clamp: [-2, 2], decimals: 2, defaultInc: 0.1, spread: 0.3 },
  "LoraLoader.strength_model":          { clamp: [-2, 2], decimals: 2, defaultInc: 0.1, spread: 0.3 },
  "LoraLoader.strength_clip":           { clamp: [-2, 2], decimals: 2, defaultInc: 0.1, spread: 0.3 },
};

// Infer tuning from the observed current value. Floats get decimals from the
// value's own precision (capped at 3); integers are exact. Spread is a
// sensible share of the magnitude (20% for floats, 20 steps for integers).
export function paramDef(id, current, integer) {
  const ov = OVERRIDES[id] ?? {};
  const decimals = ov.decimals ?? (integer ? 0 : defaultDecimals(current));
  const spread = ov.spread ?? defaultSpread(current, integer, decimals);
  const defaultInc = ov.defaultInc ?? defaultIncrement(decimals);
  const clamp = ov.clamp ?? defaultClamp(current, decimals);
  return { key: id, label: id, decimals, spread, defaultInc, clamp };
}

function defaultDecimals(current) {
  if (typeof current !== "number") return 2;
  const s = String(current);
  const i = s.indexOf(".");
  if (i < 0) return 0;
  return Math.min(s.length - i - 1, 3);
}

function defaultSpread(current, integer, decimals) {
  if (typeof current !== "number" || current === 0) return integer ? 5 : 1;
  const mag = Math.abs(current);
  return integer ? Math.max(Math.round(mag * 0.2), 5) : Math.max(mag * 0.2, 5 * Math.pow(10, -decimals));
}

function defaultIncrement(decimals) {
  return decimals === 0 ? 1 : Math.pow(10, -decimals) * 5;
}

function defaultClamp(current, decimals) {
  if (typeof current !== "number") return [0, 1];
  const f = Math.pow(10, decimals);
  const lo = Math.min(0, Math.floor(current * 2 * f) / f);
  const hi = Math.max(current * 2, current + Math.pow(10, -decimals) * 10);
  return [lo, hi];
}

export function defaultRange(param, current) {
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

// Round v to the nearest multiple of `inc`, respecting `decimals`.
export function snapTo(v, inc, decimals) {
  if (!inc || inc <= 0) return v;
  const f = Math.pow(10, decimals);
  return Math.round(Math.round(v / inc) * inc * f) / f;
}

// Trim trailing zeros for display: the shared module's formatValue (F5)
export const fmt = formatValue;

// Fallback list when the probe endpoint isn't available (e.g. image not
// ingested yet): build entries from the image's own meta.nodes — same shape
// the probe returns.
export function fallbackParams(meta) {
  const out = [];
  for (const n of meta?.nodes ?? []) {
    for (const [key, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v !== "number") continue;
      out.push({
        id: paramId(n.type, key),
        nodeId: n.id,
        key,
        type: n.type,
        title: n.title ?? null,
        current: v,
        integer: Number.isInteger(v),
      });
    }
  }
  return out;
}
