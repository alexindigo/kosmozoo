// features/variations/shared.mjs — the variations pure math, ONE
// implementation imported by both halves (the engine's run handler and the
// client's modal). Environment-pure: no Deno, no DOM, no node APIs (served
// to the browser via /shared/).

import { sameContext } from "../../source-origin.mjs";
import { isEntryPath } from "../../entry-path.mjs";
import { parseParamId, parameterIndex, cloneJsonValue, sameJsonValue, formatJsonValue } from "../../parameters.mjs";
export { paramId, parseParamId, parameterIndex, parameterLabel, parameterAliases, parameterCurrent } from "../../parameters.mjs";

// Legacy editor projection only. Typed Run uses `parameters` without flattening
// both sources; the compatibility arrays retain their original alias ordering.
export const catalogueParams = catalogue => ["params", "stringParams", "enumParams", "textParams"]
  .flatMap(key => catalogue[key] ?? []);

export function formatValue(v) {
  return typeof v === "string" ? v : typeof v === "number" ? String(parseFloat(v.toFixed(10))) : formatJsonValue(v);
}

// One UTF-8 naming contract for preview and both graph writers. Keep the
// existing conservative 200-byte prefix cap, below NAME_MAX minus the counter.
export const HEADROOM = 15;
export const OUTPUT_NAME_BUDGET = Math.min(200, 255 - HEADROOM);
export const TOKEN_NAME_BUDGET = 40;
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(value).length;

function foldName(value, budget, headBudget = Math.ceil((budget - 1) / 2)) {
  if (byteLength(value) <= budget) return value;
  if (budget === 0) return "";
  const points = Array.from(value), tailBudget = budget - 1 - headBudget;
  let head = "", tail = "", used = 0;
  for (const point of points) {
    const size = byteLength(point);
    if (used + size > headBudget) break;
    head += point; used += size;
  }
  used = 0;
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index], size = byteLength(point);
    if (used + size > tailBudget) break;
    tail = point + tail; used += size;
  }
  return head + "~" + tail;
}

export function outputName({ prefix = "", sourceStem = "", suffix = "", budget = OUTPUT_NAME_BUDGET }) {
  prefix = String(prefix); suffix = String(suffix);
  const affixes = byteLength(prefix) + byteLength(suffix);
  if (affixes > budget) throw new Error(`Prefix and suffix are ${affixes} bytes; the limit is ${budget} bytes. Shorten Prefix or Suffix.`);
  return prefix + foldName(String(sourceStem), budget - affixes) + suffix;
}

// Original graph facts identify the output, never a mutable filename value.
// An explicit candidate is the complete recorded prefix, including its original
// directory. It cannot change destinations or be silently folded/sanitized.
export function composeOutputName(target, values = {}, prefix = "", suffix = "") {
  const directory = target.directory ?? "", selected = !!target.parameterId && Object.hasOwn(values, target.parameterId);
  let sourceStem = target.sourceStem ?? "";
  if (selected) {
    const candidate = values[target.parameterId];
    if (typeof candidate !== "string") throw new Error(`${target.parameterId}: filename_prefix requires text`);
    if (candidate !== "" && !isEntryPath(candidate)) throw new Error(`${target.parameterId}: invalid filename_prefix path`);
    const slash = candidate.lastIndexOf("/"), candidateDirectory = slash < 0 ? "" : candidate.slice(0, slash + 1);
    if (candidateDirectory !== directory) throw new Error(`${target.parameterId}: filename_prefix must retain the original output directory`);
    sourceStem = candidate.slice(slash + 1);
    if (byteLength(prefix) + byteLength(sourceStem) + byteLength(suffix) > OUTPUT_NAME_BUDGET) {
      throw new Error(`${target.parameterId}: composed filename_prefix exceeds ${OUTPUT_NAME_BUDGET} bytes; the selected name was not shortened`);
    }
  }
  if ((target.leafOnly ?? !!directory) && /[/\\]/.test(prefix + suffix)) throw new Error("Prefix/suffix must stay within the producing directory's filename leaf");
  const value = directory + outputName({ prefix, sourceStem, suffix });
  if (selected && value !== "" && !isEntryPath(value)) throw new Error(`${target.parameterId}: invalid composed filename_prefix path`);
  return { value, selected, ...(selected ? { parameterId: target.parameterId, candidate: values[target.parameterId] } : {}) };
}

// Preview and Run use this same projection; automatic contributions are derived,
// never assigned over manual Prefix/Suffix or over the selected parameter value.
export function variationOutputName(target, request, permutation, currentValues, aliases = {}, parameters = []) {
  const automatic = request.automaticNaming === true ? automaticNaming(request.ranges ?? {}, currentValues, request.imageParams ?? {}).suffix : "";
  const prefix = templateReplaceWithProof(String(request.prefix ?? ""), permutation, currentValues, aliases, parameters);
  const suffix = templateReplaceWithProof(String(request.suffix ?? "") + automatic, permutation, currentValues, aliases, parameters);
  return { ...composeOutputName(target, permutation, prefix.text, suffix.text), prefix: prefix.text, suffix: suffix.text,
    complete: prefix.complete && suffix.complete };
}

function namingToken(value, kind) {
  let text = formatValue(value);
  if (kind === "image") {
    // A resource path identifies graph input, never an output naming directory.
    text = text.split("/").at(-1);
    const dot = text.lastIndexOf(".");
    if (dot > text.lastIndexOf("/") + 1) text = text.slice(0, dot);
  }
  return foldName(text, TOKEN_NAME_BUDGET, 19);
}

export function rangeValues(min, max, step) {
  const { axes: [axis] } = permutationPlan({ value: { enabled: true, min, max, increment: step } }, {});
  if (axis.length > MAX_PERMUTATION_VISITS) throw new Error("permutation work budget exceeded");
  return Array.from({ length: axis.length }, (_, index) => axis.at(index));
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

// Stock ComfyUI preserves the requested name, then tries "stem (n).ext";
// each occupied candidate is a byte-dedupe opportunity, not just a conflict.
// This is count preparation only. Run always uses actual upload receipts.
export function uploadCandidate(name, index = 0) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid upload candidate index");
  if (!index) return name;
  const dot = name.lastIndexOf("."), split = dot > 0 ? dot : name.length;
  return `${name.slice(0, split)} (${index})${name.slice(split)}`;
}
export function uploadFamily(name, names) {
  const dot = name.lastIndexOf("."), split = dot > 0 ? dot : name.length;
  const prefix = name.slice(0, split) + " (", suffix = ")" + name.slice(split);
  return names.filter(candidate => candidate === name || candidate.startsWith(prefix) && candidate.endsWith(suffix) &&
    /^[1-9]\d*$/.test(candidate.slice(prefix.length, -suffix.length)) && Number.isSafeInteger(Number(candidate.slice(prefix.length, -suffix.length))));
}

const MAX_PERMUTATION_VISITS = 100_000;
const MAX_PERMUTATION_AXES = 128;

export function generatePermutations(ranges, currentValues, imageParams = {}) {
  const plan = permutationPlan(ranges, currentValues, imageParams);
  if (!plan.axes.length || plan.total === 0) return [];
  // Output count excludes current tuples; it cannot certify raw traversal cost.
  // Count every prefix visit before entering the synchronous generator.
  let width = 1, visits = 0;
  for (const axis of plan.axes) {
    width *= axis.length; visits += width;
    if (visits > MAX_PERMUTATION_VISITS) throw new Error("permutation work budget exceeded; increase the increment or reduce the axes");
  }
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

// One typed axis representation owns both count and generation. Discrete sequence
// order/multiplicity is supplied by the caller; typed normalization/deduplication
// belongs to the compiler. Counting never allocates the Cartesian product.
export function permutationPlan(ranges, currentValues, imageParams = {}) {
  const { enabled, imgEnabled } = permutationAxes(ranges, imageParams);
  if (enabled.length + imgEnabled.length > MAX_PERMUTATION_AXES) throw new Error("permutation axis work budget exceeded");
  const axes = [];
  for (const [id, range] of enabled) {
    if ([range.min, range.max, range.increment].some(value => typeof value === "bigint") || [range.min, range.max, range.increment].every(Number.isSafeInteger)) {
      const integer = value => {
        if (typeof value === "bigint") return value;
        if (!Number.isSafeInteger(value)) throw new Error("Exact integer ranges require integer bounds/increment");
        return BigInt(value);
      };
      const min = integer(range.min), max = integer(range.max), increment = integer(range.increment);
      if (increment <= 0n) throw new Error("every enabled range needs a positive increment");
      const size = max < min ? 0n : ((max - min) * 2n + increment) / (increment * 2n) + 1n;
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("range is too large");
      const length = Number(size), at = index => {
        const value = min + BigInt(index) * increment;
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
      };
      const isCurrent = value => Object.hasOwn(currentValues, id) && sameJsonValue(value, currentValues[id]);
      const cur = currentValues[id];
      const target = typeof cur === "bigint" ? cur : Number.isSafeInteger(cur) ? BigInt(cur) : null;
      const matches = target !== null && length > 0 && target >= min && target <= min + (size - 1n) * increment && (target - min) % increment === 0n ? 1 : 0;
      axes.push({ id, length, at, isCurrent, matches });
      continue;
    }
    if (!Number.isFinite(range.increment) || range.increment <= 0) throw new Error("every enabled range needs a positive increment");
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) throw new Error("range bounds must be finite");
    const length = Math.max(0, Math.round((range.max - range.min) / range.increment) + 1);
    if (!Number.isSafeInteger(length)) throw new Error("range is too large");
    const at = index => Math.round((range.min + index * range.increment) * 1e10) / 1e10;
    const isCurrent = value => Object.hasOwn(currentValues, id) && typeof currentValues[id] === "number" && formatValue(value) === formatValue(currentValues[id]);
    let matches = 0;
    const target = typeof currentValues[id] === "number" ? Number(formatValue(currentValues[id])) : NaN;
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
    const values = cloneJsonValue(parameter.values);
    const isCurrent = value => Object.hasOwn(currentValues, id) && sameJsonValue(value, currentValues[id]);
    axes.push({ id, values, length: values.length, at: index => values[index], isCurrent, matches: values.filter(isCurrent).length });
  }
  const product = axes.reduce((n, axis) => n * axis.length, 1);
  const current = axes.reduce((n, axis) => n * axis.matches, 1);
  return { axes, total: axes.length ? product - current : 0 };
}

// Separate automatic projection: caller text is never rewritten. An axis needs
// two distinct surviving values, after excluding the complete current tuple.
export function automaticNaming(ranges, currentValues, imageParams = {}) {
  const plan = permutationPlan(ranges, currentValues, imageParams);
  const ids = plan.total < 2 ? [] : plan.axes.filter(axis => {
    if (axis.length < 2) return false;
    const otherAllCurrent = plan.axes.filter(other => other !== axis).every(other => other.length === other.matches);
    if (axis.values) {
      // Direct callers may supply an unsorted/repeated discrete sequence. Only
      // distinct values that survive whole-current exclusion contribute a token.
      let first, found = false;
      for (const value of axis.values) {
        if (otherAllCurrent && axis.isCurrent(value)) continue;
        if (!found) { first = value; found = true; }
        else if (!sameJsonValue(first, value)) return true;
      }
      return false;
    }
    // Numeric axes are monotone; current matches are a contiguous interval.
    // Inspect endpoints without enumerating potentially enormous ranges.
    const first = otherAllCurrent && axis.isCurrent(axis.at(0)) ? axis.matches : 0;
    const last = axis.length - 1 - (otherAllCurrent && axis.isCurrent(axis.at(axis.length - 1)) ? axis.matches : 0);
    return first < last && !sameJsonValue(axis.at(first), axis.at(last));
  }).map(axis => axis.id);
  return { ids, suffix: ids.map(id => `_{${id}}`).join("") };
}

// --- text template axes ({{label}} substitutions) ------------------------------

// Label dictionaries are own-entry maps. Object prototype names are valid
// labels only when explicitly configured, never implicit substitution values.
export const templateValue = (entries, label) => entries != null && Object.hasOwn(entries, label) ? entries[label] : undefined;

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
  const axes = labels.map(label => templateValue(tplValues, label));
  if (axes.some(values => !Array.isArray(values) || !values.length)) return [];
  return cartesianProduct(axes).map(combo => {
    const values = Object.fromEntries(labels.map((label, index) => [label, combo[index]]));
    return template.replace(/\{\{([^{}]+?)\}\}/g, (match, name) => values[name.trim()] ?? match);
  });
}

// Every placeholder-shaped token is considered, including unknown syntax.
// Canonical IDs use the same parser as catalogue admission; compatibility
// aliases select their FIRST carrier, even when only a later carrier varies.
export function templateReplaceWithProof(template, values, currentValues, labelMap = {}, params = []) {
  const lookup = new Map(Object.entries({ ...currentValues, ...values }));
  const kinds = new Map(params.map(parameter => [parameter.id, parameter.kind]));
  const aliases = new Map();
  for (const [param, labels] of Object.entries(labelMap)) {
    for (const label of Array.isArray(labels) ? labels : [labels]) {
      if (label && !aliases.has(label)) aliases.set(label, param);
    }
  }
  let complete = !/[{}]/.test(template.replace(/\{[^{}]*\}/g, ""));
  const text = template.replace(/\{([^{}]*)\}/g, (_, key) => {
    const canonical = parseParamId(key);
    const resolved = lookup.has(key) ? key : aliases.get(key);
    if ((canonical || resolved !== undefined) && lookup.has(resolved)) return namingToken(lookup.get(resolved), kinds.get(resolved));
    complete = false;
    return `{${key}}`;
  });
  return { text, complete };
}

export function templateReplace(template, values, currentValues, labelMap = {}, params = []) {
  return templateReplaceWithProof(template, values, currentValues, labelMap, params).text;
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

// Exact effective operations, derived from the request rather than a second
// acknowledgement whitelist. Enabled-empty is invalid, never an omitted axis.
export function runOperationFields(request) {
  const fields = { ranges: [], imageParams: [], naming: ["prefix", "suffix"], rangeSelections: [], imageSelections: [] };
  for (const [channel, selections] of [["ranges", "rangeSelections"], ["imageParams", "imageSelections"]]) {
    if (!record(request[channel] ?? {})) throw new Error(`Invalid ${channel} plan`);
    for (const [id, axis] of Object.entries(request[channel] ?? {})) {
      if (!record(axis) || typeof axis.enabled !== "boolean") throw new Error(`Choose whether ${id} is enabled`);
      if (Object.hasOwn(request[channel === "ranges" ? "imageParams" : "ranges"] ?? {}, id)) throw new Error(`Ambiguous operation: ${id}`);
      fields[selections].push(id);
      if (!axis.enabled) continue;
      if (channel === "imageParams" && (!Array.isArray(axis.values) || !axis.values.length)) throw new Error(`${id}: choose at least one value before Run`);
      fields[channel].push(id);
    }
  }
  return fields;
}

// The captured transaction records every target's applicability. Only the
// documented relative numeric absence is an exclusion; positive other kinds
// must find a carrier. Raw recipe dispositions remain a separate representation.
export function targetRunPlan(payload, catalogue) {
  const parameters = catalogue.parameters ?? catalogueParams(catalogue), index = parameterIndex(parameters);
  const numeric = parameter => parameter && (parameter.kind === "numeric" || parameter.valueKind === "number" || catalogue.params?.some(p => p.id === parameter.id));
  const ranges = {}, operations = [];
  for (const [id, axis] of Object.entries(payload.ranges)) {
    const applicable = !(payload.relative && axis.enabled && !index.has(id));
    operations.push({ id: `rangeSelections:${id}`, parameter: id, channel: "rangeSelections", disposition: applicable ? axis.enabled ? "apply" : "off" : "absent-relative-numeric" });
    if (axis.enabled) operations.push({ id: `ranges:${id}`, parameter: id, channel: "ranges", disposition: applicable ? "apply" : "absent-relative-numeric" });
    if (applicable) ranges[id] = axis;
    if (applicable && axis.enabled && !numeric(index.get(id))) throw new Error(`${id}: numeric parameter is missing from this target`);
  }
  for (const [id, axis] of Object.entries(payload.imageParams)) {
    operations.push({ id: `imageSelections:${id}`, parameter: id, channel: "imageSelections", disposition: axis.enabled ? "apply" : "off" });
    if (axis.enabled) operations.push({ id: `imageParams:${id}`, parameter: id, channel: "imageParams", disposition: "apply" });
    if (axis.enabled && !index.has(id)) throw new Error(`${id}: parameter is missing from this target`);
  }
  operations.push(...["prefix", "suffix"].map(parameter => ({ id: `naming:${parameter}`, parameter, channel: "naming", disposition: "apply" })));
  const request = { ...payload, ranges };
  runOperationFields(request);
  return { payload: request, operations };
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
  let expected;
  try { expected = runOperationFields(request); } catch { return null; }
  const { ranges, imageParams, rangeSelections, imageSelections } = expected;
  const indexes = new Set(), prompts = new Set();
  const list = (values, allowed) => Array.isArray(values) && values.length === allowed.length && new Set(values).size === values.length && values.every(value => allowed.includes(value));
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
    // A fixed Value axis is absolute even when neighbouring batch axes are
    // offsets. Retain the numeric channel and its target applicability proof.
    if (r.absolute === true) { out[key] = { ...r }; continue; }
    if ([cur, r.min, r.max, ...r.clamp].some(value => typeof value === "bigint")) {
      const exact = value => {
        if (typeof value === "bigint") return value;
        if (!Number.isSafeInteger(value)) throw new Error("Exact relative integer ranges require integer offsets and bounds");
        return BigInt(value);
      };
      const [clo, chi] = r.clamp.map(exact), base = exact(cur);
      const clamp = value => value < clo ? clo : value > chi ? chi : value;
      const lo = clamp(base + exact(r.min)), hi = clamp(base + exact(r.max));
      out[key] = { ...r, min: lo < hi ? lo : hi, max: lo > hi ? lo : hi };
      continue;
    }
    const [clo, chi] = r.clamp;
    const lo = Math.min(Math.max(cur + r.min, clo), chi);
    const hi = Math.min(Math.max(cur + r.max, clo), chi);
    out[key] = { ...r, min: round(Math.min(lo, hi)), max: round(Math.max(lo, hi)) };
  }
  return out;
}
