// features/variations/shared.mjs — the variations pure math, ONE
// implementation imported by both halves (the engine's run handler and the
// client's modal). Environment-pure: no Deno, no DOM, no node APIs (served
// to the browser via /shared/).

import { sameContext } from "../../source-origin.mjs";

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

// Each enabled range carries its own REQUIRED `increment` (no global
// fallback — a range without one is a client bug the run answers 400 to).
// `imageParams` adds enum axes (outermost). The current-combo exclusion
// compares FORMATTED values so a string filename and a numeric current
// compare honestly: the current combo is redundant only when EVERY axis
// sits at its current value.
export function permutationAxes(ranges, imageParams = {}) {
  const enabled = Object.entries(ranges).filter(([, r]) => r.enabled);
  const imgEnabled = Object.entries(imageParams).filter(([, p]) => p.enabled && Array.isArray(p.values) && p.values.length);
  return { enabled, imgEnabled, excluded: {
    ranges: Object.entries(ranges).filter(([, r]) => r.enabled === false).map(([id]) => id),
    imageParams: Object.entries(imageParams).filter(([, p]) => p.enabled === false).map(([id]) => id),
  } };
}

export function generatePermutations(ranges, currentValues, imageParams = {}) {
  const plan = permutationPlan(ranges, currentValues, imageParams);
  if (!plan.axes.length || plan.total === 0) return [];
  const output = [];
  const visit = (index, values, current) => {
    if (index === plan.axes.length) { if (!current) output.push(Object.fromEntries(values)); return; }
    const axis = plan.axes[index];
    for (let i = 0; i < axis.length; i++) {
      const value = axis.at(i);
      visit(index + 1, [...values, [axis.id, value]], current && axis.isCurrent(value));
    }
  };
  visit(0, [], true);
  return output;
}

// One typed axis representation owns both count and generation. Counting does
// not allocate the Cartesian product or serialize arbitrary text through a separator.
export function permutationPlan(ranges, currentValues, imageParams = {}) {
  const { enabled, imgEnabled } = permutationAxes(ranges, imageParams);
  const fmt = value => typeof value === "string" ? value : formatValue(value);
  const axes = [];
  for (const [id, range] of enabled) {
    if (!Number.isFinite(range.increment) || range.increment <= 0) throw new Error("every enabled range needs a positive increment");
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) throw new Error("range bounds must be finite");
    const length = Math.max(0, Math.round((range.max - range.min) / range.increment) + 1);
    if (!Number.isSafeInteger(length)) throw new Error("range is too large");
    const at = index => Math.round((range.min + index * range.increment) * 1e10) / 1e10;
    const isCurrent = value => Object.hasOwn(currentValues, id) && fmt(value) === fmt(currentValues[id]);
    let matches = 0;
    const target = Number(fmt(currentValues[id]));
    if (length && Number.isFinite(target)) {
      const bound = inclusive => {
        let low = 0, high = length;
        while (low < high) { const mid = low + Math.floor((high - low) / 2), value = at(mid); if (value < target || inclusive && value === target) low = mid + 1; else high = mid; }
        return low;
      };
      const start = bound(false);
      if (start < length && isCurrent(at(start))) matches = bound(true) - start;
    }
    axes.push({ id, length, at, isCurrent, matches });
  }
  for (const [id, parameter] of imgEnabled) {
    const values = parameter.values, isCurrent = value => Object.hasOwn(currentValues, id) && fmt(value) === fmt(currentValues[id]);
    axes.push({ id, length: values.length, at: index => values[index], isCurrent, matches: values.filter(isCurrent).length });
  }
  const product = axes.reduce((n, axis) => n * axis.length, 1);
  const current = axes.reduce((n, axis) => n * axis.matches, 1);
  return { axes, total: axes.length ? product - current : 0 };
}

// --- text template axes ({{label}} substitutions) ------------------------------

// Distinct {{label}} names in first-appearance order. The name is trimmed;
// empty names ({{ }}) are not labels.
export function templateLabels(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(/\{\{([^{}]+?)\}\}/g)) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Semicolon-separated label values: trimmed, but interior EMPTIES are real
// values ("green; ; banana" = three values, the middle one an empty string —
// it substitutes the token with ""). Only a wholly empty input means
// "not configured".
export function parseSemicolonList(raw) {
  const s = String(raw ?? "");
  if (s.trim() === "") return [];
  return s.split(";").map((v) => v.trim());
}

// The entire text is ONE literal template. Formatting is never a list separator.
// Only explicit labels create Cartesian axes; substitution changes their tokens
// and leaves every other character intact. Missing values keep the row
// inert. Clearing the field yields one empty string for sweep-to-empty.
export function expandTextAxes(text, tplValues = {}) {
  const template = String(text ?? "");
  const labels = templateLabels(template);
  if (labels.some((l) => !(tplValues[l]?.length > 0))) return [];
  return cartesianProduct(labels.map(label => tplValues[label])).map(combo => {
    const values = Object.fromEntries(labels.map((label, index) => [label, combo[index]]));
    return template.replace(/\{\{([^{}]+?)\}\}/g, (match, name) => values[name.trim()] ?? match);
  });
}

// Substitute both bare keys ({denoise}) and node-prefixed keys
// ({scheduler:denoise}). Both map back to the same internal param name.
// `labelMap` is param -> canonical label for this graph; the template may
// use either.
export function templateReplaceWithProof(template, values, currentValues, labelMap = {}) {
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
  let complete = true;
  const text = template.replace(/\{([\w.:]+)\}/g, (_, key) => {
    if (Object.hasOwn(lookup, key)) return formatValue(lookup[key]);
    complete = false;
    return `{${key}}`;
  });
  return { text, complete };
}

export function templateReplace(template, values, currentValues, labelMap = {}) {
  return templateReplaceWithProof(template, values, currentValues, labelMap).text;
}

// Additive Run evidence, shared by producer and consumer. Counts alone never
// certify configuration. The returned field sets are intersections over every
// accepted permutation; an invalid response returns null before any baseline write.
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const shape = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function validRunAcknowledgement(value) {
  return shape(value, ["version", "runId", "requestId"]) && value.version === 2 && uuid(value.runId) && uuid(value.requestId);
}
export function acknowledgedFields(request, response) {
  const correlation = request?.acknowledgement, ack = response?.acknowledgement;
  const ackKeys = ["version", "runId", "requestId", "target", "context", "accepted"];
  if (!validRunAcknowledgement(correlation) || !shape(ack, ackKeys) ||
      ack.version !== correlation.version || ack.runId !== correlation.runId || ack.requestId !== correlation.requestId ||
      !sameContext(request.context, ack.context) ||
      !shape(ack.target, ["id", "host", "filename"]) || ["id", "host", "filename"].some(key => ack.target[key] !== request[key]) ||
      !Number.isSafeInteger(response.total) || response.total <= 0 || response.submitted !== response.total ||
      !Array.isArray(response.errors) || response.errors.length || !Array.isArray(ack.accepted) || ack.accepted.length !== response.total) return null;
  const ranges = Object.keys(request.ranges ?? {}).filter(id => request.ranges[id]?.enabled === true);
  const imageParams = Object.keys(request.imageParams ?? {}).filter(id => request.imageParams[id]?.enabled === true && request.imageParams[id]?.values?.length);
  const rangeSelections = Object.keys(request.ranges ?? {}).filter(id => typeof request.ranges[id]?.enabled === "boolean");
  const imageSelections = Object.keys(request.imageParams ?? {}).filter(id => typeof request.imageParams[id]?.enabled === "boolean");
  if (ranges.some(id => imageParams.includes(id))) return null;
  const indexes = new Set(), prompts = new Set();
  const list = (values, allowed) => Array.isArray(values) && new Set(values).size === values.length && values.every(value => allowed.includes(value));
  for (const accepted of ack.accepted) {
    if (!shape(accepted, ["index", "promptId", "applied", "selections", "naming"]) || !Number.isSafeInteger(accepted.index) ||
        accepted.index < 0 || accepted.index >= response.total || indexes.has(accepted.index) ||
        typeof accepted.promptId !== "string" || !accepted.promptId.trim() || accepted.promptId !== accepted.promptId.trim() || prompts.has(accepted.promptId) ||
        !shape(accepted.applied, ["ranges", "imageParams"]) || !list(accepted.applied.ranges, ranges) ||
        !list(accepted.applied.imageParams, imageParams) || !list(accepted.naming, ["prefix", "suffix"]) ||
        !shape(accepted.selections, ["ranges", "imageParams"]) || !list(accepted.selections.ranges, rangeSelections) ||
        !list(accepted.selections.imageParams, imageSelections)) return null;
    for (const channel of ["ranges", "imageParams"]) for (const id of accepted.selections[channel]) {
      if (request[channel][id].enabled === true ? !accepted.applied[channel].includes(id)
        : accepted.applied.ranges.includes(id) || accepted.applied.imageParams.includes(id)) return null;
    }
    indexes.add(accepted.index); prompts.add(accepted.promptId);
  }
  return {
    ranges: ranges.filter(id => ack.accepted.every(item => item.applied.ranges.includes(id))),
    imageParams: imageParams.filter(id => ack.accepted.every(item => item.applied.imageParams.includes(id))),
    naming: ["prefix", "suffix"].filter(key => ack.accepted.every(item => item.naming.includes(key))),
    rangeSelections: rangeSelections.filter(id => ack.accepted.every(item => item.selections.ranges.includes(id))),
    imageSelections: imageSelections.filter(id => ack.accepted.every(item => item.selections.imageParams.includes(id))),
  };
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
