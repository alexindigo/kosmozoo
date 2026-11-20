// src/backings/comfy.mjs — the ComfyUI backing: a host's output/input dirs
// over HTTP. One timeout for every fetch; every fetch checks r.ok.

import { RENDERABLE, IMAGE_EXTENSIONS, EXT_MIME } from "./mime.mjs";
import { isEntryPath, isEntryLeaf, splitEntryPath } from "../entry-path.mjs";
import { makeInventoryOwner } from "./inventory-owner.mjs";
import { makeMetadataCollector, interpretHeaders } from "./comfy-metadata.mjs";
import { makeGenerationTimes } from "./comfy-generation.mjs";
import { InventoryError, bounded, cancelled } from "./inventory.mjs";
import { cloneJsonValue, parseExactJson, stringifyExactJson } from "../parameters.mjs";
import { makePromptLane, promptRequest } from "./comfy-submission.mjs";

const HOST_TIMEOUT_MS = 10_000;

export const validName = isEntryPath;

export function viewUrl(addr, name, kind) {
  const { filename, subfolder } = splitEntryPath(name);
  const query = new URLSearchParams({ type: kind, filename });
  if (subfolder) query.set("subfolder", subfolder);
  return `http://${addr}/api/view?${query}`;
}

// Online probe: only the status code of /api/system_stats is inspected.
export async function probe(addr, { fetcher = fetch } = {}) {
  try {
    const r = await fetcher(`http://${addr}/api/system_stats`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    await r.body?.cancel();
    return r.status === 200;
  } catch {
    return false;
  }
}

// ComfyUI listings annotate names with a trailing "[...]" — a size in some
// versions, a subfolder marker ("[output]") in others. The annotation is
// NEVER part of the identity; the size only when numeric. Greedy prefix so
// "a [b].png [7]" keeps its inner brackets.
export function parseListingEntry(n) {
  const text = String(n), plain = { name: text, size: null };
  if (!text.endsWith("]")) return plain;
  // Locate the rightmost eligible opening bracket without repartitioning a
  // whitespace run. The old greedy prefix retains all but one separator char.
  for (let at = text.length - 2; at > 0; at--) {
    if (text[at] === "]") break;
    if (text[at] !== "[" || !/\s/.test(text[at - 1])) continue;
    const annotation = text.slice(at + 1, -1);
    return { name: text.slice(0, at - 1), size: /^\d+$/.test(annotation) ? Number(annotation) : null };
  }
  return plain;
}

// kind 'output' → [{ name, size }] (feed listing); kind 'input' → [name]
// (LoadImage sweep sources, renderable only).
export async function list(addr, kind = "output", options = {}) {
  if (kind === "output") return (await inventory(addr, options)).items;
  const r = await (options.fetcher ?? fetch)(`http://${addr}/internal/files/${kind}`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`ComfyUI listing: ${r.status}`); // E8: a down host is not an empty dir
  const raw = await r.json();
  if (kind === "input") {
    return normalizeRootInventory(raw).items.map(item => item.name)
      .filter((n) => IMAGE_EXTENSIONS.has(n.split(".").pop().toLowerCase()));
  }
  return raw.map(parseListingEntry);
}

// Source-content stamp: an OPAQUE string that changes when a file's content
// is rewritten under the same name — the revalidation signal. ComfyUI's
// ETag (aiohttp derives it from mtime_ns+size; fallback Last-Modified|CL).
// Compare for equality only — stamps are never ordered.
export async function stat(addr, name, kind = "output", { fetcher = fetch } = {}) {
  if (!validName(name)) return null;
  try {
    const r = await fetcher(viewUrl(addr, name, kind), { method: "HEAD", signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (!r.ok) return null;
    const { stamp, size } = interpretHeaders(r);
    return stamp == null && size == null ? null : { stamp, size: Number.isNaN(size) ? null : size };
  } catch {
    return null;
  }
}

// Read bytes. `range: [start, end]` (inclusive) asks for a head slice (the
// dims pass, ): aiohttp's FileResponse honors Range and answers 206; a
// server that ignores it answers 200 with the full body — callers accept
// both. Upstream serves some files as application/octet-stream (with
// nosniff) — the browser can't render those, so map the extension when the
// upstream type is useless.
export async function read(addr, name, kind = "output", { range, idleMs = HOST_TIMEOUT_MS, fetcher = fetch } = {}) {
  if (!validName(name)) return { status: 400 };
  const controller = new AbortController();
  let timer;
  const clear = () => clearTimeout(timer);
  const progress = () => {
    clear();
    timer = setTimeout(() => controller.abort(new Error("ComfyUI byte read stalled")), idleMs);
  };
  progress();
  let r;
  try {
    r = await fetcher(viewUrl(addr, name, kind), {
      headers: range ? { Range: `bytes=${range[0]}-${range[1]}` } : undefined,
      signal: controller.signal,
    });
  } catch {
    clear();
    return { status: 502 };
  }
  if (!r.ok) {
    clear();
    await r.body?.cancel();
    return { status: r.status };
  }
  const headers = new Headers();
  const mime = EXT_MIME[name.split(".").pop().toLowerCase()];
  const ct = r.headers.get("Content-Type");
  if (mime && (!ct || /octet-stream/i.test(ct))) headers.set("Content-Type", mime);
  else if (ct) headers.set("Content-Type", ct);
  const cl = r.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  const reader = r.body?.getReader();
  if (!reader) { clear(); return { status: r.status, body: null, headers }; }
  progress();
  const body = new ReadableStream({
    async pull(stream) {
      try {
        const { value, done } = await reader.read();
        if (done) { clear(); reader.releaseLock(); stream.close(); }
        else { progress(); stream.enqueue(value); }
      } catch (error) { clear(); reader.releaseLock(); stream.error(error); }
    },
    async cancel(reason) {
      clear();
      // Cancelling the native reader already cancels the fetch body. Aborting
      // first errors that reader and turns ordinary cancellation into rejection.
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  });
  return { status: r.status, body, headers };
}

// Upload one image into the input dir (the same mechanism the ComfyUI web
// UI uses). No overwrite flag: stock Comfy may choose a collision-free name.
// The engine's input route forwards backing conflicts; use the returned name,
// never invent successful upload provenance from the requested filename.
export async function write(addr, name, bytes, { fetcher = fetch } = {}) {
  if (!isEntryLeaf(name)) return { ok: false, status: 400, error: "bad filename" };
  const form = new FormData();
  form.append("image", new Blob([bytes]), name);
  try {
    const r = await fetcher(`http://${addr}/api/upload/image`, {
      method: "POST", body: form, signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (!r.ok) return { ok: false, status: r.status, error: `ComfyUI ${r.status}` };
    const d = await r.json().catch(() => null);
    if (!d || !isEntryLeaf(d.name) ||
        (d.type !== undefined && d.type !== "input") || (d.subfolder !== undefined && d.subfolder !== "")) {
      return { ok: false, status: 502, error: "upload acceptance is unconfirmed: invalid returned input name; do not automatically retry" };
    }
    return { ok: true, name: d.name };
  } catch (e) {
    return { ok: false, status: 502, error: `upload failed: ${e.message}` };
  }
}

// --- deletion ------------------------------------------------------------------
//
// ComfyUI core has no file-delete API. The assets_plus extension adds one
// (POST /api/assets_plus/output/delete, mode "trash" = recoverable). Delete
// without it is impossible — the engine then only hides the image (the
// routes) and tidies Comfy's history on a best-effort basis.

// Capability probe (assets_plus extension) for one address. Only DEFINITIVE
// answers are cached (true, or an HTTP 404 from the extension endpoint) for
// a 60 s TTL; network errors and odd shapes fall through uncached.
const ASSETS_PLUS_TTL_MS = 60_000;

export async function hasAssetsPlus(addr, cache = new Map(), { fetcher = fetch } = {}) {
  const c = cache.get(addr);
  if (c && Date.now() - c.t < ASSETS_PLUS_TTL_MS) return c.v;
  try {
    const r = await fetcher(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: ["__kosmozoo_capability_probe__"], mode: "trash" }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    if (r.ok) {
      const d = await r.json();
      if (Array.isArray(d?.removed) && Array.isArray(d?.failed)) {
        cache.set(addr, { v: true, t: Date.now() });
        return true;
      }
    } else if (r.status === 404) {
      cache.set(addr, { v: false, t: Date.now() }); // no extension
    }
  } catch { /* unreachable — not definitive, not cached */ }
  return false;
}

// Trash one image via assets_plus. { ok, mode, detail }.
export async function remove(addr, name, { fetcher = fetch } = {}) {
  if (!validName(name)) return { ok: false, mode: null, detail: "bad filename" };
  let r;
  try {
    r = await fetcher(`http://${addr}/api/assets_plus/output/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relpaths: [name], mode: "trash" }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, mode: null, detail: `host unreachable: ${e?.message ?? e}` };
  }
  if (!r.ok) return { ok: false, mode: null, detail: `host returned ${r.status}` };
  let d;
  try { d = await r.json(); } catch { return { ok: false, mode: null, detail: "host returned no JSON" }; }
  if (!Array.isArray(d?.removed) || !Array.isArray(d?.failed)) {
    return { ok: false, mode: null, detail: "host has no assets_plus delete" };
  }
  if (d.removed.includes(name)) return { ok: true, mode: "trash" };
  return { ok: false, mode: null, detail: d.failed.includes(name) ? "not found on host" : "delete failed on host" };
}

// Best-effort history cleanup for the hide path: find the prompt that
// produced the file and delete its history entry. The file itself is
// untouched — this only tidies Comfy's own history panel.
export async function historyDelete(addr, name, { fetcher = fetch } = {}) {
  if (!validName(name)) return false;
  try {
    const r = await fetcher(`http://${addr}/api/history`, { signal: AbortSignal.timeout(HOST_TIMEOUT_MS) });
    if (!r.ok) return false;
    const history = await r.json();
    let promptId = null;
    for (const [pid, entry] of Object.entries(history)) {
      for (const nodeOut of Object.values(entry?.outputs ?? {})) {
        const items = [...(nodeOut?.images ?? []), ...(nodeOut?.gifs ?? [])];
        if (items.some((o) => o?.type === "output" &&
            (o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename) === name)) {
          promptId = pid; break;
        }
      }
      if (promptId) break;
    }
    if (!promptId) return false;
    const dr = await fetcher(`http://${addr}/api/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    return dr.ok;
  } catch {
    return false;
  }
}

// --- the prompt/graph surface (variations feature) ----------------------------

// object_info cache for one address: { types: Map<paramId,"INT"|"FLOAT"> |
// null, outputClasses: Set<class_type> | null, enums:
// Map<"<type>.<input>", string[]> | null, dynamicCombos: Map<schemaKey,
// Map<optionKey, branch schema>> | null, t }. TTL'd (a host's node set
// is stable per version); misses are not cached forever.
const OBJECT_INFO_TTL_MS = 60_000;

// Filesystem inventory is independent of retained prompt history and delete
// preferences. The pinned AssetsPlus handler treats limit=0 as an unsliced
// scan and negative scan_depth as unlimited depth.
// One per-record acceptance boundary for both upstream listing shapes. Never
// select arbitrary metadata for an ambiguous identity. Counts refer to records;
// identical duplicates are harmless, contradictory occurrences are all omitted.
function listingRecords(raw, decode) {
  const entries = new Map(), counts = new Map(), conflicts = new Set(), reasons = new Map();
  const skip = (reason, count = 1) => reasons.set(reason, (reasons.get(reason) ?? 0) + count);
  for (const record of raw) {
    const { item, reason } = decode(record);
    if (reason) { skip(reason); continue; }
    if (!item) continue; // Non-media files are not output candidates.
    if (conflicts.has(item.name)) { skip("conflicting duplicate"); continue; }
    const prior = entries.get(item.name), count = counts.get(item.name) ?? 0;
    if (prior && (prior.size !== item.size || prior.mtime !== item.mtime)) {
      entries.delete(item.name); conflicts.add(item.name); skip("conflicting duplicate", count + 1);
    } else { entries.set(item.name, item); counts.set(item.name, count + 1); }
  }
  return { items: [...entries.values()], skipped: { count: [...reasons.values()].reduce((sum, n) => sum + n, 0),
    reasons: [...reasons].map(([reason, count]) => ({ reason, count })) } };
}

function mergeSkipped(...values) {
  const reasons = new Map();
  for (const value of values) for (const item of value.reasons) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + item.count);
  return { count: values.reduce((sum, value) => sum + value.count, 0), reasons: [...reasons].map(([reason, count]) => ({ reason, count })) };
}

export function normalizeInventory(payload, { descendants = false } = {}) {
  if (!payload || !Array.isArray(payload.items) || payload.has_more !== false ||
      typeof payload.cursor !== "string" || !Number.isFinite(payload.latest_mtime)) {
    throw new Error("ComfyUI inventory: malformed or incomplete scan");
  }
  return listingRecords(payload.items, item => {
    if (!item || !validName(item.relpath)) return { reason: "invalid relative path" };
    if (descendants && !item.relpath.includes("/")) return { reason: "unexpected root record in descendant listing" };
    if (!RENDERABLE.has(item.relpath.split(".").pop().toLowerCase())) return { reason: "not a media file" };
    if (!Number.isSafeInteger(item.size) || item.size < 0) return { reason: "invalid file size" };
    if (!Number.isFinite(item.mtime)) return { reason: "invalid modification time" };
    return { item: { name: item.relpath, size: item.size, mtime: item.mtime } };
  });
}

export function normalizeRootInventory(raw) {
  if (!Array.isArray(raw)) throw new Error("ComfyUI listing: invalid array");
  return listingRecords(raw, value => {
    if (typeof value !== "string") return { reason: "invalid listing record" };
    const item = parseListingEntry(value);
    if (!validName(item.name) || item.name.includes("/")) return { reason: "invalid relative path" };
    if (!RENDERABLE.has(item.name.split(".").pop().toLowerCase())) return {};
    if (item.size !== null && (!Number.isSafeInteger(item.size) || item.size < 0)) return { reason: "invalid file size" };
    return { item };
  });
}

export async function inventory(addr, { client, ...options } = {}) {
  if (client) return client(addr).inventory(options);
  // Compatibility for stateless standalone driver consumers. Production
  // discovery receives the context's existing address owner.
  const owner = comfyClient(addr, { fetcher: options.fetcher });
  try { return await owner.inventory(options); }
  finally { owner.disposeInventory(); }
}

// Keep dynamic branches, their declared defaults and their input types together.
// Dotted child names are ComfyUI's prompt keys, not variation parameter IDs.
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_ENTRIES = 100_000;
function schemaBudget() {
  let remaining = MAX_SCHEMA_ENTRIES;
  return { path: "object_info", take(count = 1) {
    if (count > remaining) throw Object.assign(new RangeError("ComfyUI object_info expansion budget exceeded"), { schemaIssue: { code: "schema-budget", path: this.path, numbers: { limit: MAX_SCHEMA_ENTRIES, requested: MAX_SCHEMA_ENTRIES - remaining + count } } });
    remaining -= count;
  }, set(map, key, value) { this.take(); map.set(key, value); } };
}

// Declared facts the shared input contract interprets: constraints, resource
// upload/folder/provider metadata and display text. Raw config stays evidence.
const DECLARATION_FACTS = ["min", "max", "step", "default", "lazy", "rawLink", "forceInput", "multiselect",
  "image_upload", "audio_upload", "video_upload", "file_upload", "image_folder", "remote", "slotType",
  "display_name", "tooltip", "multiline", "advanced"];
const DYNAMIC_TYPES = new Set(["COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3", "COMFY_DYNAMICGROUP_V3", "COMFY_DYNAMICSLOT_V3"]);
const MAX_AUTOGROW_NAMES = 100;

// Upstream Autogrow._expand_schema_for_dynamic: names win over prefix; the first
// declared template input repeats as "<input>.<name>", required only below min
// when the template itself is required. Malformed templates stay unknown.
function autogrowChildren(template) {
  if (!template || typeof template !== "object" || Array.isArray(template) || !Number.isSafeInteger(template.min) || template.min < 0) return null;
  let names;
  if (Object.hasOwn(template, "names")) {
    if (!Array.isArray(template.names) || template.names.some(name => typeof name !== "string" || !name || name.includes("."))) return null;
    names = template.names.slice(0, MAX_AUTOGROW_NAMES);
  } else if (Object.hasOwn(template, "prefix")) {
    const max = template.max;
    if (typeof template.prefix !== "string" || template.prefix.includes(".") || !Number.isSafeInteger(max) || max < 1 || max > MAX_AUTOGROW_NAMES) return null;
    names = Array.from({ length: max }, (_, index) => `${template.prefix}${index}`);
  } else return null;
  for (const [section, inputs] of Object.entries(template.input ?? {})) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return null;
    const first = Object.values(inputs)[0];
    if (first === undefined) continue;
    const type = Array.isArray(first) ? first[0] : first;
    if (DYNAMIC_TYPES.has(type) || section !== "required" && section !== "optional") return null;
    return names.map((name, index) => [name, index < template.min && section === "required" ? "required" : "optional", first]);
  }
  return null;
}

function inputSchema(input, prefix, budget, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) throw Object.assign(new RangeError("ComfyUI object_info nesting budget exceeded"), { schemaIssue: { code: "schema-depth", path: prefix, numbers: { limit: MAX_SCHEMA_DEPTH, depth } } });
  const schema = { types: new Map(), enums: new Map(), declarations: new Map(), dynamicCombos: new Map(), defaults: new Map(), lazy: new Set(), warnings: [] };
  // Child prompt keys share this prefix, so their declarations, lazy flags and
  // nested dynamic combo branches (each owning its own defaults) join the parent
  // whole. Child defaults stay unmerged: group rows, autogrow names and slot
  // children exist only when present upstream, so no absent value is created.
  const adopt = child => {
    schema.warnings.push(...child.warnings);
    for (const channel of ["types", "enums", "declarations", "dynamicCombos"]) for (const [key, value] of child[channel]) budget.set(schema[channel], key, value);
    for (const key of child.lazy) { budget.take(); schema.lazy.add(key); }
  };
  for (const section of ["required", "optional"]) {
    for (const [key, spec] of Object.entries(input?.[section] ?? {})) {
      budget.path = `${prefix}.${key}`;
      budget.take();
      const name = `${prefix}.${key}`, t = Array.isArray(spec) ? spec[0] : spec;
      const config = Array.isArray(spec) ? spec[1] : null;
      const declaration = { type: typeof t === "string" ? t : Array.isArray(t) ? "COMBO" : null, section };
      for (const key of DECLARATION_FACTS) {
        if (config && Object.hasOwn(config, key)) declaration[key] = config[key];
      }
      if (Array.isArray(t)) declaration.options = t;
      else if (t === "COMBO" && Array.isArray(config?.options)) declaration.options = config.options;
      budget.set(schema.declarations, name, declaration);
      if (t === "COMFY_DYNAMICGROUP_V3" && config?.template) {
        const max = config.max ?? 20;
        if (!Number.isSafeInteger(max) || max < 1 || max > 20) throw Object.assign(new Error("Invalid dynamic group bounds"), { schemaIssue: { code: "schema-group", path: name, value: max, numbers: { limit: 20 } } });
        for (let index = 0; index < max; index++) {
          adopt(inputSchema(config.template, `${name}.${index}`, budget, depth + 1));
        }
      }
      if (t === "COMFY_AUTOGROW_V3") {
        const children = autogrowChildren(config?.template);
        if (!children) schema.warnings.push({ input: name, detail: "invalid autogrow template" });
        else if (config?.template?.names?.length > MAX_AUTOGROW_NAMES) schema.warnings.push({ input: name, detail: `${config.template.names.length} declared names with only ${MAX_AUTOGROW_NAMES} supported` });
        if (children) {
          budget.take(children.length);
          for (const [child, childSection, childSpec] of children) adopt(inputSchema({ [childSection]: { [child]: childSpec } }, name, budget, depth + 1));
        }
      }
      // Upstream DynamicSlot recursively parses its children (_io.py:1320-1328)
      // as "<slot>.<input>" while connected, including nested dynamic inputs.
      if (t === "COMFY_DYNAMICSLOT_V3" && config?.inputs && typeof config.inputs === "object") adopt(inputSchema(config.inputs, name, budget, depth + 1));
      if (config?.lazy === true) { budget.take(); schema.lazy.add(name); }
      if (config && Object.hasOwn(config, "default")) budget.set(schema.defaults, name, config.default);
      else if (section === "required") budget.set(schema.defaults, name, undefined);
      if (t === "INT" || t === "FLOAT") budget.set(schema.types, name, t);
      let raw = Array.isArray(t) ? t : t === "COMBO" ? config?.options : null;
      if (t === "COMFY_DYNAMICCOMBO_V3" && Array.isArray(config?.options)) {
        const branches = new Map();
        budget.take(config.options.length);
        const invalid = config.options.filter(option => typeof option?.key !== "string").length;
        if (invalid) schema.warnings.push({ input: name, detail: `${invalid} dynamic options have invalid keys` });
        for (const option of config.options) {
          if (typeof option?.key !== "string") continue;
          const branch = inputSchema(option.inputs, name, budget, depth + 1);
          branches.set(option.key, branch);
          // Flat type/enum lookups also describe existing dotted prompt inputs.
          for (const channel of ["types", "enums"]) for (const [k, v] of branch[channel]) budget.set(schema[channel], k, v);
        }
        budget.set(schema.dynamicCombos, name, branches);
        raw = [...branches.keys()];
      }
      if (Array.isArray(raw) && raw.length) {
        budget.take(raw.length);
        const list = [...new Set(raw.filter(v => typeof v === "string"))];
        if (list.length) budget.set(schema.enums, name, list);
      }
    }
  }
  return schema;
}

export async function objectInfo(addr, cache = new Map(), { fetcher = fetch, signal, graph } = {}) {
  // Cache the backend catalogue, not the success/failure of one consumer's
  // expansion. Only that graph's class definitions spend its schema budget.
  const classes = graph === undefined ? null : [...new Set(Object.values(graph).map(node => String(node?.class_type ?? "")))].sort();
  const scope = JSON.stringify(classes);
  let c = cache.get(addr);
  if (!c || Date.now() - c.t >= OBJECT_INFO_TTL_MS) {
    c = { raw: null, t: Date.now(), error: null };
    try {
      const timeout = AbortSignal.timeout(HOST_TIMEOUT_MS);
      const r = await fetcher(`http://${addr}/api/object_info`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!r.ok) {
        r.body?.cancel().catch(() => {});
        throw new Error(`ComfyUI object_info returned HTTP ${r.status}`);
      }
      const raw = parseExactJson(await r.text());
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid object_info");
      c.raw = raw;
    } catch (error) { c.error = error.message; }
    // Retain backend data only. A consumer's cancelled/failed acquisition must
    // neither poison later consumers nor evict a concurrent successful read.
    if (c.raw) cache.set(addr, c);
  }
  // Retain only the latest view, so graph changes cannot grow a scope cache.
  if (c.scope === scope) return c.view;
  const out = objectInfoView(c.raw, classes, c.error);
  c.scope = scope; c.view = out;
  return out;
}

// Pure normalization of one raw catalogue for the given class scope (null: all).
export function objectInfoView(raw, classes = null, error = null) {
  let out = { types: null, outputClasses: null, enums: null, lazyInputs: null, dynamicCombos: null, declarations: null, outputs: null, installed: null, schemaError: error };
  try {
    if (raw) {
      const candidate = { types: new Map(), outputClasses: new Set(), enums: new Map(), lazyInputs: new Map(), dynamicCombos: new Map(), declarations: new Map(), outputs: new Map(), installed: new Set(), schemaError: null, schemaWarnings: [] };
      const budget = schemaBudget();
      const entries = classes === null ? Object.entries(raw) : classes.filter(type => Object.hasOwn(raw, type)).map(type => [type, raw[type]]);
      for (const [type, def] of entries) {
        // Presence in object_info is the backend's own statement that a class is installed.
        candidate.installed.add(type);
        const schema = inputSchema(def?.input, type, budget);
        candidate.schemaWarnings.push(...schema.warnings.map(warning => ({ ...warning, type })));
        budget.set(candidate.lazyInputs, type, new Set([...schema.lazy].map(key => key.slice(type.length + 1))));
        if (def?.output_node) { budget.take(); candidate.outputClasses.add(type); }
        if (Array.isArray(def?.output)) {
          budget.take(def.output.length);
          budget.set(candidate.outputs, type, def.output.map((type, index) => ({ type,
            name: def.output_name?.[index] ?? null, isList: def.output_is_list?.[index] === true })));
        }
        for (const channel of ["types", "enums", "dynamicCombos", "declarations"]) for (const [key, value] of schema[channel]) budget.set(candidate[channel], key, value);
      }
      out = candidate;
    }
  } catch (error) { out.schemaError = error.message; if (error.schemaIssue) out.schemaIssue = error.schemaIssue; /* No partial view is published. */ }
  return out;
}

// ONE stateful client per address: the caches are instance state created by
// the context, never module globals. Stateless I/O stays with the module
// functions above.
export function comfyClient(addr, { fetcher = fetch, clock = () => performance.now(), epoch = crypto.randomUUID(),
  waveTimeoutMs = 60_000, readerTimeoutMs = 120_000, requestTimeoutMs = HOST_TIMEOUT_MS } = {}) {
  const assetsPlus = new Map();
  const objectInfoCache = new Map();
  let disposed = false, config = null, configTask = null, recursiveKnown = false;
  let owner, metadata;
  const assertAlive = () => { if (disposed) throw new Error("ComfyUI inventory owner removed"); };
  const request = (path, signal = owner.signal) => {
    const timeout = new AbortController();
    const combined = AbortSignal.any([owner.signal, signal, timeout.signal]);
    return bounded(async () => {
      const response = await fetcher(`http://${addr}${path}`, { signal: combined });
      const payload = response.ok ? await response.json() : null;
      if (!response.ok) response.body?.cancel().catch(() => {});
      assertAlive();
      return { status: response.status, ok: response.ok, payload };
    }, { signal: combined, timeoutMs: requestTimeoutMs,
      timeoutError: new InventoryError("discovery-timeout", `ComfyUI discovery deadline: ${path}`),
      onTimeout: (error) => timeout.abort(error) });
  };
  async function discover(signal = owner.signal) {
    assertAlive();
    if (config && clock() - config.at < ASSETS_PLUS_TTL_MS) return config.value;
    if (configTask) return configTask;
    configTask = (async () => {
      const r = await request("/api/assets_plus/config", signal);
      assertAlive();
      let value;
      if (r.status === 404 && !recursiveKnown) {
        value = { supported: false, reason: "AssetsPlus is unavailable; stock ComfyUI lists output root only" };
      } else {
        if (!r.ok) throw new Error(`ComfyUI inventory config: ${r.status}`);
        const d = r.payload;
        assertAlive();
        if (!d || typeof d.recursive !== "boolean" || !Array.isArray(d.allowed_extensions) ||
            d.allowed_extensions.some((x) => typeof x !== "string") ||
            !Number.isInteger(d.list_limit) || d.list_limit <= 0 ||
            (d.scan_depth !== null && !Number.isInteger(d.scan_depth))) {
          throw new Error("ComfyUI inventory config: incompatible response");
        }
        value = { supported: true, reason: null };
      }
      config = { at: clock(), value };
      return value;
    })().finally(() => { configTask = null; });
    return configTask;
  }

  async function membership(signal) {
    let support = await discover(signal);
    const rootResponse = await request("/internal/files/output", signal);
    if (!rootResponse.ok) throw new Error(`ComfyUI listing: ${rootResponse.status}`);
    const roots = normalizeRootInventory(rootResponse.payload);
    assertAlive();
    if (support.supported) {
      // The native search runs before AssetsPlus opens images for metadata.
      // '/' matches every descendant and no root, so oversized root images
        // cannot poison nested discovery. Root visibility stays stock-owned;
        // publication order comes only from uniform HEAD observations.
      const query = new URLSearchParams({ recursive: "1", scan_depth: "-1", limit: "0", extensions: [...RENDERABLE].join(","), query: "/" });
      const r = await request(`/api/assets_plus/output/list?${query}`, signal);
      assertAlive();
      if (r.status === 404 && !recursiveKnown) {
        support = { supported: false, reason: "AssetsPlus output listing is unavailable; stock output root only" };
        config = { at: clock(), value: support };
      } else {
        if (!r.ok) throw new Error(`ComfyUI inventory: ${r.status}`);
        const nested = normalizeInventory(r.payload, { descendants: true });
        const items = [...roots.items, ...nested.items];
        assertAlive();
        recursiveKnown = true;
        return { coverage: "recursive", subfolders: support, items, skipped: mergeSkipped(roots.skipped, nested.skipped) };
      }
    }
    return { coverage: "root-only", subfolders: support, items: roots.items, skipped: roots.skipped };
  }

  async function observeNames(names, { signal, deadlineMs }) {
    const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
    const results = new Map(); let index = 0, failure = null;
    const worker = async () => {
      try {
        while (!combined.aborted && index < names.length) {
          const name = names[index++];
          results.set(name, await metadata.observe(name, { signal: combined, deadlineMs }));
        }
      } catch (error) { failure ??= error; stop.abort(error); }
    };
    await Promise.allSettled(Array.from({ length: Math.min(4, names.length) }, worker));
    if (failure || signal.aborted) throw failure ?? signal.reason ?? cancelled();
    return results;
  }
  async function collect({ signal, deadlineMs }) {
    let listed = await membership(signal);
    const discovered = new Set(listed.items.map((item) => item.name));
    const results = await observeNames([...discovered], { signal, deadlineMs });
    const firstMissing = [...results].filter(([, result]) => result.kind === "not-found").map(([name]) => name);
    if (firstMissing.length) {
      listed = await membership(signal);
      for (const item of listed.items) discovered.add(item.name);
      const added = listed.items.map((item) => item.name).filter((name) => !results.has(name));
      for (const [name, result] of await observeNames(added, { signal, deadlineMs })) results.set(name, result);
      const retry = listed.items.map((item) => item.name).filter((name) => results.get(name)?.kind === "not-found");
      for (const [name, result] of await observeNames(retry, { signal, deadlineMs })) results.set(name, result);
    }
    const records = [], unavailable = [], current = new Set(listed.items.map((item) => item.name));
    for (const item of listed.items) {
      const result = results.get(item.name);
      if (result?.kind === "present") records.push({ name: item.name, size: result.size ?? item.size, modified: result.modified });
      else if (result?.kind === "not-found") unavailable.push({ name: item.name, reason: "confirmed-source-not-found", status: 404 });
      else throw new InventoryError("incomplete-metadata", `No valid metadata for ${item.name}`, { path: item.name });
    }
    for (const name of firstMissing) if (!current.has(name)) unavailable.push({ name, reason: "not-found-after-reconcile", status: 404 });
    return { records, discovered: [...discovered], unavailable, coverage: listed.coverage, subfolders: listed.subfolders, skipped: listed.skipped };
  }
  owner = makeInventoryOwner({ collect, clock, epoch, waveTimeoutMs, readerTimeoutMs });
  metadata = makeMetadataCollector({ urlFor: (name, kind) => viewUrl(addr, name, kind), fetcher, clock,
    signal: owner.signal, requestTimeoutMs });
  const telemetry = async (path, signal) => {
    const timeout = AbortSignal.timeout(HOST_TIMEOUT_MS);
    const r = await fetcher(`http://${addr}${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!r.ok) throw new Error(`ComfyUI telemetry ${path}: ${r.status}`);
    return r.json();
  };
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  const generationTimes = makeGenerationTimes();
  const submissions = makePromptLane((prompt, { signal, onSent }) => {
    const request = promptRequest(`http://${addr}/api/prompt`, submissionBody(prompt), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(HOST_TIMEOUT_MS)]), onSent,
    });
    return { sent: request.sent, result: request.result.then(async ({ response, error, sent }) => {
      try { return { ...(error ? enqueueFailure(addr, error) : await enqueueResponse(addr, response)), sent }; }
      catch (error) { return { ...enqueueFailure(addr, error), sent }; }
    }) };
  }, { signal: owner.signal });
  let historyReady = false, fullHistoryTask = null;
  const readHistory = async ({ maxItems, promptId, signal } = {}) => {
    const path = promptId ? `/api/history/${encodeURIComponent(promptId)}`
      : `/api/history${maxItems === undefined ? "" : `?max_items=${maxItems}`}`;
    const d = await telemetry(path, signal);
    if (!object(d)) throw new Error("ComfyUI history: invalid object");
    const records = Object.entries(d).map(([id, entry]) => {
      if (!object(entry) || (entry.status !== undefined && !object(entry.status))) {
        throw new Error("ComfyUI history: invalid entry");
      }
      const status = entry.status;
      if (status && (typeof status.completed !== "boolean" || typeof status.status_str !== "string" || !Array.isArray(status.messages))) {
        throw new Error("ComfyUI history: invalid status");
      }
      const messages = status?.messages ?? [];
      const interrupted = messages.some((m) => Array.isArray(m) && m[0] === "execution_interrupted");
      const failed = messages.some((m) => Array.isArray(m) && m[0] === "execution_error");
      const terminal = !!status && (status.completed || status.status_str === "error" || interrupted || failed);
      return { id, terminal, outcome: interrupted ? "interrupted" : failed || status?.status_str === "error" ? "error" : terminal ? "success" : null };
    });
    if (!disposed) {
      generationTimes.observe(d);
      if (maxItems === undefined && !promptId) historyReady = true;
    }
    return records;
  };
  const history = (options = {}) => {
    if (options.maxItems !== undefined || options.promptId) return readHistory(options);
    if (!fullHistoryTask) {
      fullHistoryTask = readHistory(options).finally(() => { fullHistoryTask = null; });
    }
    return fullHistoryTask;
  };
  return {
    addr,
    inventory(options) { assertAlive(); return owner.inventory(options); },
    invalidateInventory: owner.invalidateInventory,
    peekInventory: owner.peekInventory,
    observeMetadata: (name, options) => metadata.observe(name, options),
    inventoryDiagnostics: () => metadata.stats(),
    async subfolders() {
      try { return await discover(); }
      catch (error) { return { supported: recursiveKnown ? true : null, reason: error.message }; }
    },
    async disposeInventory() {
      disposed = true;
      generationTimes.clear();
      await owner.disposeInventory();
      metadata.dispose();
      await Promise.allSettled([configTask].filter(Boolean));
    },
    hasAssetsPlus: () => hasAssetsPlus(addr, assetsPlus, { fetcher }),
    objectInfo: (options) => objectInfo(addr, objectInfoCache, { fetcher, ...options }),
    progressSocket: () => new WebSocket(`ws://${addr}/ws?clientId=${crypto.randomUUID()}`),
    enqueue: (prompt) => submissions.submit(prompt).result,
    submit: (prompt, ports) => submissions.submit(prompt, ports),
    async queue({ signal } = {}) {
      const d = await telemetry("/api/queue", signal);
      const ids = (rows) => {
        if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || typeof r[1] !== "string" || !r[1])) {
          throw new Error("ComfyUI queue: invalid prompt identities");
        }
        return rows.map((r) => r[1]);
      };
      return { running: ids(d?.queue_running), pending: ids(d?.queue_pending),
        prompts: new Map(d.queue_running.map(row => [row[1], {
          graph: object(row[2]) ? row[2] : null,
          outputs: Array.isArray(row[4]) ? row[4] : null,
          otherClient: !!row[3]?.client_id,
        }])) };
    },
    history,
    async generationTime(name) {
      if (disposed || !isEntryPath(name)) return null;
      if (!historyReady) {
        try { await history(); } catch { return null; }
      }
      return disposed ? null : generationTimes.read(name);
    },
    async logs({ signal } = {}) {
      const d = await telemetry("/internal/logs/raw", signal);
      // Stock Comfy returns terminal geometry here, not a log-buffer count.
      // Both characterized producers normalize to the same entry snapshot.
      const count = Number.isSafeInteger(d?.size) && d.size >= 0;
      const terminal = object(d?.size) && Number.isSafeInteger(d.size.cols) && d.size.cols >= 0 &&
        Number.isSafeInteger(d.size.rows) && d.size.rows >= 0;
      if (!object(d) || !Array.isArray(d.entries) || !(count || terminal) ||
          d.entries.some((e) => !object(e) || typeof e.m !== "string" || !["string", "number"].includes(typeof e.t))) {
        throw new Error("ComfyUI logs: invalid buffer");
      }
      return { entries: d.entries.map(({ t, m }) => ({ t, m })), size: count ? d.size : d.entries.length };
    },
  };
}

export const createBinding = comfyClient;

export function createDriver(fetcher) {
  return {
    validName,
    probe: addr => probe(addr, { fetcher }),
    list: (addr, kind, options) => list(addr, kind, { ...options, fetcher }),
    stat: (addr, name, kind) => stat(addr, name, kind, { fetcher }),
    read: (addr, name, kind, options) => read(addr, name, kind, { ...options, fetcher }),
    write: (addr, name, bytes) => write(addr, name, bytes, { fetcher }),
    remove: (addr, name) => remove(addr, name, { fetcher }),
    historyDelete: (addr, name) => historyDelete(addr, name, { fetcher }),
    createBinding: (addr, options) => comfyClient(addr, { ...options, fetcher }),
  };
}

// Recorded executions may contain fingerprints that ComfyUI trusts instead of
// recomputing. Every new submission owns a clone; only descriptor metadata is
// execution-only, never an input (or arbitrary nested field) of the same name.
export function freshSubmissionGraph(graph) {
  const clone = cloneJsonValue(graph);
  for (const node of Object.values(clone)) delete node.is_changed;
  return clone;
}

// Queue a prompt graph. Returns { ok, status, error? } — the caller owns
// permutation-level error reporting. Failures log the host's FULL body to
// the engine console: the response error is capped for display, but a
// validation detail truncated at the boundary is undiagnosable. Untrusted values
// are JSON-quoted so control characters cannot become additional log records.
const logValue = value => JSON.stringify(String(value)).replace(/[\u007f-\u009f\u2028\u2029]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
export async function enqueue(addr, prompt, { fetcher = fetch } = {}) {
  try {
    const resp = await fetcher(`http://${addr}/api/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: submissionBody(prompt),
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
    });
    return await enqueueResponse(addr, resp);
  } catch (e) { return enqueueFailure(addr, e); }
}

const submissionBody = prompt => stringifyExactJson({ ...prompt, prompt: freshSubmissionGraph(prompt.prompt) });
function enqueueFailure(addr, error) {
  console.error(`[comfy] enqueue ${logValue(addr)} -> fetch failed: ${logValue(error.message)}`);
  return { ok: false, status: 502, error: `fetch failed: ${error.message}` };
}
async function enqueueResponse(addr, resp) {
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[comfy] enqueue ${logValue(addr)} -> ${resp.status}: ${logValue(text)}`);
      return { ok: false, status: resp.status, error: `ComfyUI ${resp.status}: ${text.slice(0, 200)}` };
    }
    const data = await resp.json().catch(() => null);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const identity = object(data) && typeof data.prompt_id === "string" && data.prompt_id.trim() && data.prompt_id === data.prompt_id.trim();
    const nodeErrors = object(data?.node_errors) ? data.node_errors : null;
    if (!identity || nodeErrors === null || data.error !== undefined) {
      return { ok: true, status: resp.status, acceptance: "uncertain", error: "submission acceptance is unconfirmed; do not automatically resubmit" };
    }
    const partial = Object.keys(nodeErrors).length > 0;
    return { ok: true, status: resp.status, acceptance: partial ? "partial" : "confirmed",
      promptId: data.prompt_id, nodeErrors, ...(partial ? { error: "ComfyUI accepted only part of the prompt (node errors); configuration was not acknowledged" } : {}) };
}
