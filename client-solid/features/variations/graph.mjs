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

import { formatValue } from "/shared/features/variations/shared.mjs";
import { parameterCurrent, parseExactJson, stringifyExactJson } from "/shared/parameters.mjs";

// Presentation strategies are projections, never a second parameter catalogue.
export function editorDomain(parameter) {
  if (parameter.kind === "image") return "images";
  const value = parameterCurrent(parameter);
  if (parameter.valueKind !== "connection" && (parameter.schema?.options?.length || parameter.values?.length)) {
    const options = parameter.schema?.options ?? parameter.values;
    return options.every(value => typeof value === "string") && typeof value === "string" ? "enums" : "candidates";
  }
  if (typeof value === "number" || typeof value === "bigint") return "numeric";
  if (typeof value === "string") return "texts";
  return "candidates";
}

export function numericText(raw) {
  try {
    const text = raw.trim();
    if (!text) return null;
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
    const value = /^[+-]?\d+$/.test(text) ? parseExactJson(String(BigInt(text))) : Number(text);
    if (typeof value !== "number" && typeof value !== "bigint") return null;
    stringifyExactJson(value);
    return value;
  } catch { return null; }
}

export const sliderNumber = value => typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));

export function numericDefaults(parameter, batch) {
  const current = parameterCurrent(parameter), integer = parameter.integer ?? (typeof current === "bigint" || Number.isInteger(current));
  const tuning = paramDef(`${parameter.type}.${parameter.key}`, current, integer);
  const schema = parameter.schema ?? {};
  if (schema.min !== undefined) tuning.clamp[0] = schema.min;
  if (schema.max !== undefined) tuning.clamp[1] = schema.max;
  // Tuning cannot silently exclude a recorded seed or substitute 32-bit bounds.
  if (schema.min === undefined && current < tuning.clamp[0]) tuning.clamp[0] = current;
  if (schema.max === undefined && current > tuning.clamp[1]) tuning.clamp[1] = current;
  const safe = [current, ...tuning.clamp].every(sliderNumber);
  const defaults = batch ? { min: -tuning.spread, max: tuning.spread } : safe ? defaultRange(tuning, current) : { min: current, max: current };
  return { metadata: { input: parameter.key, tuning, defaults, integer, minIncrement: integer ? 1 : 10 ** -tuning.decimals,
    defaultIncrement: tuning.defaultInc, clamp: tuning.clamp },
    defaults: { enabled: false, min: String(defaults.min), max: String(defaults.max), rawIncrement: String(tuning.defaultInc), mode: "range", value: String(current) } };
}

// --- slider tuning overrides ---------------------------------------------------
//
// Schema tuning key = "<class_type>.<input>"; never an editable parameter ID.
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
  const clamp = [...(ov.clamp ?? defaultClamp(current, decimals))];
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
