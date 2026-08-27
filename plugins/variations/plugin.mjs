// plugins/variations/plugin.mjs — batch parameter sweep from a card.
//
// Routes:
//   GET  /probe/:id   — inspect a graph, return per-param node labels and
//                       current values (client uses this to render the panel).
//   POST /run         — read the cached PNG's embedded graph, generate
//                       permutations (cartesian × enabled ranges, edges
//                       inclusive, current excluded), clone + mutate the
//                       graph per permutation, POST to source host's
//                       /api/prompt. Final filename per submission is
//                       <prefix><basename><suffix> — prefix/suffix wrap the
//                       original name; they do NOT replace it.

import { parsePngTextChunks } from "../../src/extractor.mjs";

// --- parameter discovery: generic, node-instance based -----------------------
//
// No hardcoded node names. Every numeric scalar input of every node instance
// in the graph is a varyable parameter. Param id = `<class_type>.<input>`,
// shared with the fields registry (client/js/fields.mjs) so one id means the
// same field everywhere. Each INSTANCE of a node type is its own target —
// two Load LoRA nodes in one graph sweep independently.

export function paramId(classType, input) {
  return `${classType}.${input}`;
}

// Everything a numeric input needs: where it lives (node ids — ALL instances
// of a same-type same-input pair share one param and sweep together, the
// multi-carrier rule), what it is (integer/float — integer params round on
// write), and its current value (the first carrier's).
export function inspectGraph(graph) {
  const out = new Map(); // id -> entry
  for (const [id, n] of Object.entries(graph ?? {})) {
    const type = String(n.class_type ?? "");
    if (!type) continue;
    const title = n._meta?.title && n._meta.title !== type ? String(n._meta.title) : null;
    for (const [key, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v !== "number") continue;
      const pid = paramId(type, key);
      const existing = out.get(pid);
      if (existing) {
        existing.nodeIds.push(id);
      } else {
        out.set(pid, {
          id: pid,
          nodeIds: [id],
          key,
          type,
          title,
          current: v,
          integer: Number.isInteger(v),
        });
      }
    }
  }
  return [...out.values()];
}

// --- graph mutation ----------------------------------------------------------

// permutation: { "<class_type>.<input>": value }. Targets are resolved by
// node id, and a param that shows on several instances sweeps ALL of them.
export function mutateGraph(graph, permutation, params) {
  const clone = structuredClone(graph);
  const byId = new Map();
  for (const p of params ?? inspectGraph(clone)) byId.set(p.id, p);
  const applied = [];
  for (const [id, value] of Object.entries(permutation)) {
    const p = byId.get(id);
    if (!p) continue;
    const v = p.integer ? Math.round(value) : value;
    for (const nodeId of p.nodeIds) {
      const node = clone[nodeId];
      if (!node?.inputs) continue;
      node.inputs[p.key] = v;
    }
    applied.push(id);
  }
  return { graph: clone, applied };
}

// --- relative ranges (batch mode) ---------------------------------------------
//
// Batch sweeps specify offsets from each image's OWN current value, not
// absolutes — the client can't know every image's current value, but this
// handler just inspected the graph and does. Resolve offsets to clamped
// absolutes here; params this graph doesn't have drop out entirely.
// Mutates + returns the per-request ranges object.
export function resolveRelativeRanges(ranges, currentValues) {
  const round = (v) => Math.round(v * 1e10) / 1e10;
  for (const [key, r] of Object.entries(ranges)) {
    const cur = currentValues[key];
    if (cur == null || !Array.isArray(r.clamp)) { delete ranges[key]; continue; }
    const [clo, chi] = r.clamp;
    const lo = Math.min(Math.max(cur + r.min, clo), chi);
    const hi = Math.min(Math.max(cur + r.max, clo), chi);
    r.min = round(Math.min(lo, hi));
    r.max = round(Math.max(lo, hi));
  }
  return ranges;
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
  return template.replace(/\{([\w.:]+)\}/g, (_, key) => {
    if (key in lookup) return formatValue(lookup[key]);
    return `{${key}}`;
  });
}

// --- filename injection ------------------------------------------------------
//
// A workflow can have multiple SaveImage nodes (e.g. one for the raw sample,
// one for an upscaled variant), each with its OWN filename_prefix. The
// original image the user is varying was produced by exactly one of them.
// We identify that node by prefix-matching against the original filename,
// then:
//   - wrap ONLY that node's filename_prefix with the user's pfx/sfx
//   - remove the OTHER SaveImage nodes so the run produces one file, not N
//
// If no SaveImage's prefix matches the original filename (unusual — e.g.
// the file was renamed after saving), fall back to wrapping every
// SaveImage and leaving them all in the graph.

function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Find the SaveImage node whose filename_prefix is the leading segment of
// the original filename. ComfyUI names outputs as `<prefix>_<counter>_.<ext>`,
// so the basename starts with the exact prefix followed by "_".
export function findProducingSaveImage(graph, originalFilename) {
  const base = stripExtension(originalFilename);
  let best = null;
  for (const [nid, n] of Object.entries(graph)) {
    if (String(n.class_type ?? "").toLowerCase() !== "saveimage") continue;
    const pfx = n.inputs?.filename_prefix;
    if (typeof pfx !== "string" || !pfx) continue;
    if (base === pfx || base.startsWith(pfx + "_")) {
      // Prefer the longest matching prefix (more specific wins over generic).
      if (!best || pfx.length > best.prefix.length) best = { id: nid, node: n, prefix: pfx };
    }
  }
  return best;
}

// Set the producing SaveImage's filename_prefix to `<pfx><basename><sfx>`
// and delete every OTHER SaveImage from the graph so the run produces
// exactly one file. `basename` is the ORIGINAL image's filename without
// its extension — including the ComfyUI counter (e.g. "StyleMix_01822_") —
// so the variation's name traces back to the source image.
// Returns { kept, dropped } — how many nodes affected.
export function narrowToOneSaveImage(graph, producing, basename, pfx, sfx) {
  producing.node.inputs.filename_prefix = pfx + basename + sfx;
  let dropped = 0;
  for (const [nid, n] of Object.entries(graph)) {
    if (nid === producing.id) continue;
    if (String(n.class_type ?? "").toLowerCase() !== "saveimage") continue;
    delete graph[nid];
    dropped++;
  }
  return { kept: 1, dropped };
}

// Fallback path: wrap every SaveImage's own prefix with the user's pfx/sfx.
// Used only when no SaveImage matches the original filename.
export function wrapAllSaveImagePrefixes(graph, pfx, sfx) {
  let touched = 0;
  for (const n of Object.values(graph)) {
    if (String(n.class_type ?? "").toLowerCase() !== "saveimage") continue;
    const orig = String(n.inputs?.filename_prefix ?? "");
    n.inputs.filename_prefix = pfx + orig + sfx;
    touched++;
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

    const { id, host, filename, ranges, increment, prefix, suffix, relative } = body;
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
    for (const p of inspection) {
      currentValues[p.id] = p.current;
      labelMap[p.id] = p.title ?? p.type;
    }

    // Batch sweeps arrive as offsets from each image's own current value;
    // resolve them now that this graph's current values are known.
    if (relative) resolveRelativeRanges(ranges, currentValues);

    const permutations = generatePermutations(ranges, fallbackInc, currentValues);
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations (check ranges and increment)" }, { status: 400 });
    }

    // "<host>#" is ALWAYS the leading segment of the generated filename so
    // outputs from different hosts don't collide when downloaded into a
    // shared ~/Downloads folder, and so a variation traces back to the
    // host that produced it. The user's prefix goes after it. If the
    // user's prefix already starts with "<host>#" we don't double-prepend.
    const hostTag = host + "#";
    const userPfx = String(prefix ?? "");
    const pfxTpl = userPfx.startsWith(hostTag) ? userPfx : hostTag + userPfx;
    const sfxTpl = String(suffix ?? "");

    // Identify which SaveImage node produced the original image, so we can
    // narrow the graph to one output per run instead of firing every
    // SaveImage the workflow declares.
    const producing = findProducingSaveImage(graph, filename);

    // Basename of the original file (without extension) — includes ComfyUI's
    // counter, e.g. "StyleMix_01822_". Used as the middle of the wrapped
    // filename_prefix so variations trace back to the source image.
    const originalBasename = stripExtension(filename);

    const errors = [];
    let submitted = 0;
    for (const perm of permutations) {
      const { graph: mutated, applied } = mutateGraph(graph, perm, inspection);
      if (applied.length === 0) {
        errors.push({ permutation: perm, error: "no applicable nodes found" });
        continue;
      }

      const pfx = templateReplace(pfxTpl, perm, currentValues, labelMap);
      const sfx = templateReplace(sfxTpl, perm, currentValues, labelMap);

      if (producing) {
        // Re-find in the CLONED graph (structuredClone gave us fresh nodes).
        const p = findProducingSaveImage(mutated, filename);
        if (!p) {
          errors.push({ permutation: perm, error: "producing SaveImage lost after clone" });
          continue;
        }
        narrowToOneSaveImage(mutated, p, originalBasename, pfx, sfx);
      } else {
        // Fallback: wrap every SaveImage's own prefix. Original workflow's
        // output count is preserved; we just add pfx/sfx around each.
        if (!wrapAllSaveImagePrefixes(mutated, pfx, sfx)) {
          errors.push({ permutation: perm, error: "no SaveImage node in graph" });
          continue;
        }
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
