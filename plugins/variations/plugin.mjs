// plugins/variations/plugin.mjs — batch parameter sweep from a card.
//
// Routes:
//   GET  /probe/:id   — inspect a graph, return per-param node labels and
//                       current values (client uses this to render the panel
//                       with correct `<node>:<param>` labels for the graph
//                       it's looking at; KSampler nodes drop the prefix).
//   POST /run         — read the cached PNG's embedded graph, generate
//                       permutations (cartesian × enabled ranges, edges
//                       inclusive, current excluded), clone + mutate the
//                       graph per permutation, POST to source host's
//                       /api/prompt. Final filename per submission is
//                       <prefix><basename><suffix> — prefix/suffix wrap the
//                       original name; they do NOT replace it.

import { parsePngTextChunks, firstNode, scalarInput } from "../../src/extractor.mjs";

// --- parameter probes: locate the node that carries each param --------------
//
// Each probe returns { node, key, ownerLabel } where:
//   node        — the graph node object (or null if absent)
//   key         — the input key on that node
//   ownerLabel  — user-facing label prefix; "" for KSampler-carrier,
//                 "<lowercased-node>" otherwise (e.g. "scheduler", "cfgguider").

function probeDenoise(nodes) {
  const ks = nodes.find((n) => n.class_type === "KSampler");
  if (ks) return { node: ks, key: "denoise", ownerLabel: "" };
  const sched = firstNode(nodes, "scheduler");
  if (sched && typeof sched.inputs?.denoise === "number") {
    return { node: sched, key: "denoise", ownerLabel: "scheduler" };
  }
  return { node: null };
}

function probeCfg(nodes) {
  const ks = nodes.find((n) => n.class_type === "KSampler");
  if (ks) return { node: ks, key: "cfg", ownerLabel: "" };
  const guider = firstNode(nodes, "cfgguider");
  if (guider && typeof guider.inputs?.cfg === "number") {
    return { node: guider, key: "cfg", ownerLabel: "cfgguider" };
  }
  return { node: null };
}

function probeSteps(nodes) {
  const ks = nodes.find((n) => n.class_type === "KSampler");
  if (ks) return { node: ks, key: "steps", ownerLabel: "" };
  const sched = firstNode(nodes, "scheduler");
  if (sched && typeof sched.inputs?.steps === "number") {
    return { node: sched, key: "steps", ownerLabel: "scheduler" };
  }
  return { node: null };
}

function probeSeed(nodes) {
  const ks = nodes.find((n) => n.class_type === "KSampler");
  if (ks && typeof ks.inputs?.seed === "number") {
    return { node: ks, key: "seed", ownerLabel: "" };
  }
  // SamplerCustomAdvanced flow: RandomNoise.noise_seed
  const rn = firstNode(nodes, "randomnoise");
  if (rn && typeof rn.inputs?.noise_seed === "number") {
    return { node: rn, key: "noise_seed", ownerLabel: "randomnoise" };
  }
  // rgthree Seed node with a scalar seed input
  const s = firstNode(nodes, "seed");
  if (s && typeof s.inputs?.seed === "number") {
    return { node: s, key: "seed", ownerLabel: "seed" };
  }
  return { node: null };
}

// ipa_weight: potentially many IPAdapter nodes, all get the same value.
function probeIpaWeight(nodes) {
  const carriers = [];
  for (const n of nodes) {
    if (!String(n.class_type ?? "").toLowerCase().includes("ipadapter")) continue;
    if (typeof n.inputs?.weight === "number") carriers.push(n);
  }
  if (!carriers.length) return { node: null };
  // ipa_weight is never on KSampler; always prefix with "ipadapter"
  return { node: carriers, key: "weight", ownerLabel: "ipadapter" };
}

const PARAM_PROBES = {
  denoise: probeDenoise,
  cfg: probeCfg,
  steps: probeSteps,
  seed: probeSeed,
  ipa_weight: probeIpaWeight,
};

// --- per-image inspection ----------------------------------------------------

// Return { <param>: { label, current } | null } for every param, given the
// graph parsed from the image's PNG. `label` is the user-facing template key
// (e.g. "denoise" for KSampler-carriers, "scheduler:denoise" otherwise).
function inspectGraph(graph) {
  const nodes = Object.values(graph);
  const out = {};
  for (const [param, probe] of Object.entries(PARAM_PROBES)) {
    const r = probe(nodes);
    if (!r.node) { out[param] = null; continue; }
    const node = Array.isArray(r.node) ? r.node[0] : r.node;
    const current = node.inputs?.[r.key] ?? null;
    const label = r.ownerLabel ? `${r.ownerLabel}:${param}` : param;
    out[param] = { label, current };
  }
  return out;
}

// --- graph mutation ----------------------------------------------------------

function mutateGraph(graph, permutation) {
  const clone = structuredClone(graph);
  const nodes = Object.values(clone);
  const applied = [];
  for (const [param, value] of Object.entries(permutation)) {
    const probe = PARAM_PROBES[param];
    if (!probe) continue;
    const r = probe(nodes);
    if (!r.node) continue;
    const targets = Array.isArray(r.node) ? r.node : [r.node];
    // integer-typed params round; floats pass through
    const v = (param === "steps" || param === "seed") ? Math.round(value) : value;
    for (const t of targets) t.inputs[r.key] = v;
    applied.push(param);
  }
  return { graph: clone, applied };
}

// --- permutation engine ------------------------------------------------------

function rangeValues(min, max, step) {
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

// Each enabled range now carries its own `increment`. A single global
// `fallbackIncrement` is used for entries missing one (legacy callers).
export function generatePermutations(ranges, fallbackIncrement, currentValues) {
  const enabled = Object.entries(ranges).filter(([, r]) => r.enabled);
  if (enabled.length === 0) return [];
  const keys = enabled.map(([k]) => k);
  const valueArrays = enabled.map(([, r]) => {
    const inc = (typeof r.increment === "number" && r.increment > 0)
      ? r.increment : fallbackIncrement;
    return rangeValues(r.min, r.max, inc);
  });
  const product = cartesianProduct(valueArrays);
  const currentKey = keys.map((k) => String(currentValues[k])).join("|");
  return product.filter((perm) => {
    const key = keys.map((k, i) => String(perm[i])).join("|");
    return key !== currentKey;
  }).map((perm) => Object.fromEntries(keys.map((k, i) => [k, perm[i]])));
}

// --- filename template -------------------------------------------------------

function formatValue(v) {
  return String(parseFloat(Number(v).toFixed(10)));
}

// Substitute both bare keys ({denoise}) and node-prefixed keys
// ({scheduler:denoise}). Both map back to the same internal param name.
// `labelMap` is param -> canonical label for this graph (e.g. denoise -> "denoise"
// on KSampler or "scheduler:denoise" on custom). The template may use either.
export function templateReplace(template, values, currentValues, labelMap = {}) {
  // Build a lookup that accepts both bare param names and their labels.
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
  return template.replace(/\{([\w:]+)\}/g, (_, key) => {
    if (key in lookup) return formatValue(lookup[key]);
    return `{${key}}`;
  });
}

// --- filename injection ------------------------------------------------------
//
// Prefix/suffix WRAP the original filename (basename without extension).
// SaveImage's filename_prefix input receives `<prefix><basename><suffix>`.
// ComfyUI adds its own numeric counter + ".png" downstream.

function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function setFilenamePrefix(graph, wrapped) {
  const nodes = Object.values(graph);
  let touched = false;
  for (const n of nodes) {
    const ct = String(n.class_type ?? "").toLowerCase();
    if (ct === "saveimage" && n.inputs) {
      n.inputs.filename_prefix = wrapped;
      touched = true;
    }
  }
  return touched;
}

// --- plugin registration -----------------------------------------------------

export function register(kz) {
  // Inspect a graph without modifying anything — the client uses this to
  // learn the per-graph label for each param (e.g. "denoise" vs
  // "scheduler:denoise") and the current values for orange-marker placement.
  kz.route("GET", "/probe/<id>", async (_req, { id }) => {
    const i = id.indexOf(":");
    if (i < 0) return Response.json({ error: "id must be host:filename" }, { status: 400 });
    const host = id.slice(0, i), filename = id.slice(i + 1);
    const hash = kz._hashFor(host, filename);
    if (!hash) return Response.json({ error: "image not ingested (no hash)" }, { status: 404 });
    const bytes = await kz._cacheGet(hash);
    if (!bytes) return Response.json({ error: "image not in cache" }, { status: 404 });
    const chunks = await parsePngTextChunks(bytes);
    if (!chunks?.prompt) return Response.json({ error: "no embedded ComfyUI graph in this PNG" }, { status: 422 });
    let graph;
    try { graph = JSON.parse(chunks.prompt); }
    catch { return Response.json({ error: "embedded graph is not valid JSON" }, { status: 422 }); }
    return Response.json({ params: inspectGraph(graph) });
  });

  kz.route("POST", "/run", async (req) => {
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ error: "JSON body required" }, { status: 400 }); }

    const { id, host, filename, ranges, increment, prefix, suffix } = body;
    if (!id || !host || !filename || !ranges) {
      return Response.json({ error: "missing required fields" }, { status: 400 });
    }
    // Legacy callers may send a single global `increment`; new clients embed
    // an `increment` per range entry. `generatePermutations` falls back to
    // the global one for any range without its own.
    const fallbackInc = typeof increment === "number" ? increment : 0.05;

    const addr = kz._hostAddr(host);
    if (!addr) return Response.json({ error: "unknown host" }, { status: 404 });

    const hash = kz._hashFor(host, filename);
    if (!hash) return Response.json({ error: "image not ingested (no hash)" }, { status: 404 });
    const bytes = await kz._cacheGet(hash);
    if (!bytes) return Response.json({ error: "image not in cache" }, { status: 404 });

    const chunks = await parsePngTextChunks(bytes);
    if (!chunks?.prompt) return Response.json({ error: "no embedded ComfyUI graph in this PNG" }, { status: 422 });
    let graph;
    try { graph = JSON.parse(chunks.prompt); }
    catch { return Response.json({ error: "embedded graph is not valid JSON" }, { status: 422 }); }

    // Inspect once for current values + labels.
    const inspection = inspectGraph(graph);
    const currentValues = {};
    const labelMap = {};
    for (const [param, info] of Object.entries(inspection)) {
      if (!info) continue;
      currentValues[param] = info.current;
      labelMap[param] = info.label;
    }

    const permutations = generatePermutations(ranges, fallbackInc, currentValues);
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations (check ranges and increment)" }, { status: 400 });
    }

    const basename = stripExtension(filename);
    const pfx = prefix ?? "";
    const sfx = suffix ?? "";

    const errors = [];
    let submitted = 0;
    for (const perm of permutations) {
      const { graph: mutated, applied } = mutateGraph(graph, perm);
      if (applied.length === 0) {
        errors.push({ permutation: perm, error: "no applicable nodes found" });
        continue;
      }

      // Wrap the original basename with the templated prefix/suffix.
      const wrapped =
        templateReplace(pfx, perm, currentValues, labelMap) +
        basename +
        templateReplace(sfx, perm, currentValues, labelMap);
      if (!setFilenamePrefix(mutated, wrapped)) {
        errors.push({ permutation: perm, error: "no SaveImage node in graph" });
        continue;
      }

      try {
        const resp = await fetch(`http://${addr}/api/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: mutated }),
        });
        if (!resp.ok) {
          const text = await resp.text();
          errors.push({ permutation: perm, error: `ComfyUI ${resp.status}: ${text.slice(0, 200)}` });
        } else {
          submitted++;
        }
      } catch (e) {
        errors.push({ permutation: perm, error: `fetch failed: ${e.message}` });
      }
    }

    return Response.json({ submitted, total: permutations.length, errors });
  });
}
