// features/variations/shared.mjs — the variations pure math, ONE
// implementation imported by both halves (the engine's run handler and the
// client's modal). Environment-pure: no Deno, no DOM, no node APIs (served
// to the browser via /shared/).

export function paramId(classType, input) {
  return `${classType}.${input}`;
}

export function formatValue(v) {
  return typeof v === "string" ? v : String(parseFloat(Number(v).toFixed(10)));
}

export function rangeValues(min, max, step) {
  const values = [];
  const count = Math.round((max - min) / step) + 1;
  for (let i = 0; i < count; i++) {
    values.push(Math.round((min + i * step) * 1e10) / 1e10);
  }
  return values;
}

function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  const out = [];
  for (const v of first) {
    for (const rp of restProduct) {
      out.push([v, ...rp]);
    }
  }
  return out;
}

// Permutation count for the modal's live counter: enabled numeric ranges ×
// enabled enum (LoadImage) axes, same math the engine's run uses.
export function permutationCount(ranges, imageParams = {}) {
  const enabled = Object.values(ranges).filter((r) => r.enabled);
  const imgEnabled = Object.values(imageParams).filter((p) => p.enabled && Array.isArray(p.values) && p.values.length);
  let n = 1;
  for (const r of enabled) n *= rangeValues(r.min, r.max, r.increment).length;
  for (const p of imgEnabled) n *= p.values.length;
  return enabled.length || imgEnabled.length ? n : 0;
}

// Each enabled range carries its own REQUIRED `increment` (no global
// fallback — a range without one is a client bug the run answers 400 to).
// `imageParams` adds enum axes (outermost). The current-combo exclusion
// compares FORMATTED values so a string filename and a numeric current
// compare honestly: the current combo is redundant only when EVERY axis
// sits at its current value.
export function generatePermutations(ranges, currentValues, imageParams = {}) {
  const enabled = Object.entries(ranges).filter(([, r]) => r.enabled);
  const imgEnabled = Object.entries(imageParams).filter(([, p]) => p.enabled && Array.isArray(p.values) && p.values.length);
  if (enabled.length === 0 && imgEnabled.length === 0) return [];
  for (const [, r] of enabled) {
    if (typeof r.increment !== "number" || r.increment <= 0) {
      throw new Error("every enabled range needs a positive increment");
    }
  }

  const keys = enabled.map(([k]) => k);
  const valueArrays = enabled.map(([, r]) => rangeValues(r.min, r.max, r.increment));
  const imgKeys = imgEnabled.map(([k]) => k);
  const imgArrays = imgEnabled.map(([, p]) => p.values);

  const fmt = (v) => (typeof v === "string" ? v : formatValue(v));
  const currentKey = [...keys, ...imgKeys].map((k) => fmt(currentValues[k])).join("|");

  const product = cartesianProduct([...valueArrays, ...imgArrays]);
  return product.filter((perm) => {
    if (keys.length === 0) return perm.map(fmt).join("|") !== currentKey;
    const imgOffset = keys.length;
    const numericsCurrent = keys.every((k, i) => fmt(perm[i]) === fmt(currentValues[k]));
    const imagesCurrent = imgKeys.every((k, j) => fmt(perm[imgOffset + j]) === fmt(currentValues[k]));
    return !(numericsCurrent && imagesCurrent);
  }).map((perm) => Object.fromEntries([...keys, ...imgKeys].map((k, i) => [k, perm[i]])));
}

// Substitute both bare keys ({denoise}) and node-prefixed keys
// ({scheduler:denoise}). Both map back to the same internal param name.
// `labelMap` is param -> canonical label for this graph; the template may
// use either.
export function templateReplace(template, values, currentValues, labelMap = {}) {
  const lookup = {};
  for (const [param, val] of Object.entries(currentValues)) {
    lookup[param] = val;
    const lbl = labelMap[param];
    if (lbl && lbl !== param) lookup[lbl] = val;
  }
  for (const [param, val] of Object.entries(values)) {
    lookup[param] = val;
    const lbl = labelMap[param];
    if (lbl && lbl !== param) lookup[lbl] = val;
  }
  return template.replace(/\{([\w.:]+)\}/g, (_, key) => {
    if (key in lookup) return formatValue(lookup[key]);
    return `{${key}}`;
  });
}

// Batch sweeps specify offsets from each image's OWN current value, not
// absolutes — the client can't know every image's current value, but the
// run handler just inspected the graph and does. Resolve offsets to clamped
// absolutes; params this graph doesn't have drop out entirely.
export function resolveRelativeRanges(ranges, currentValues) {
  const round = (v) => Math.round(v * 1e10) / 1e10;
  const out = {};
  for (const [key, r] of Object.entries(ranges)) {
    const cur = currentValues[key];
    if (cur == null || !Array.isArray(r.clamp)) continue;
    const [clo, chi] = r.clamp;
    const lo = Math.min(Math.max(cur + r.min, clo), chi);
    const hi = Math.min(Math.max(cur + r.max, clo), chi);
    out[key] = { ...r, min: round(Math.min(lo, hi)), max: round(Math.max(lo, hi)) };
  }
  return out;
}
