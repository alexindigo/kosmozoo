// src/features/variations/server.mjs — batch parameter sweep from a card.
//
// GET /probe/<id> — inspect a graph: per-param labels + current values
// POST /run — permutations (cartesian × enabled ranges, edges
// inclusive, current excluded), clone + mutate the
// graph per permutation, enqueue on the source host.
// Final filename per submission is <prefix><basename><suffix>.
//
// ComfyUI knowledge lives HERE (graph conventions, LoadImage axes, output
// nodes) — the backing owns object_info/enqueue; the store owns the bytes.

import {
  generatePermutations, resolveRelativeRanges, templateReplace,
  paramId, formatValue,
} from "./shared.mjs";

// hard cap on permutations per run — a sweep is a human-scale batch, not a
// fork bomb (F7). Above the cap the run answers 413.
const MAX_PERMUTATIONS = 500;

const IMG_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

// ComfyUI stores output-sourced LoadImage widget values as "name.png [output]"
const ANNOTATION = /^(.*)\s+\[([^\]]*)\]$/;

// --- graph inspection (ComfyUI conventions) -----------------------------------

// string-valued image inputs: every node whose type ends in "LoadImage",
// whose `image` input names an image file. id = paramId(type, "image").
export function stringParams(graph) {
  const out = [];
  for (const [id, n] of Object.entries(graph ?? {})) {
    const type = String(n.class_type ?? "");
    if (!/loadimage$/i.test(type)) continue;
    const v = n.inputs?.image;
    if (typeof v !== "string") continue;
    const m = ANNOTATION.exec(v);
    const file = m ? m[1] : v;
    if (!IMG_FILE.test(file)) continue;
    const title = n._meta?.title && n._meta.title !== type ? String(n._meta.title) : null;
    out.push({
      id: paramId(type, "image"), nodeIds: [id], key: "image", type, title,
      current: file, fromOutput: m ? /^output$/i.test(m[2]) : false,
    });
  }
  return out;
}

// Per-node enum params: every graph node input whose <type>.<input> the
// host lists options for and whose graph value is a string. values = THAT
// key's option list only — never mixed. One row per NODE instance (the id
// carries the node id, unlike the multi-carrier numeric params). LoadImage
// .image is excluded (the imgRows own it).
export function enumParams(graph, enums) {
  const out = [];
  for (const [id, n] of Object.entries(graph ?? {})) {
    const type = String(n.class_type ?? "");
    for (const [key, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v !== "string") continue;
      if (type.toLowerCase().endsWith("loadimage") && key === "image") continue;
      const values = enums?.get(`${type}.${key}`);
      if (!values?.length) continue;
      out.push({
        id: `${type}#${id}.${key}`,
        nodeId: id, nodeIds: [id], key, type,
        title: n._meta?.title && n._meta.title !== type ? String(n._meta.title) : null,
        current: v, values,
      });
    }
  }
  return out;
}

// Per-node text params: string inputs that are neither enum-typed (the host
// publishes an option list — the enum rows own those) nor LoadImage.image
// (the imgRows own it). filename_prefix on output nodes is excluded too —
// the run rewrites it per permutation, so a pick would never survive.
// values are user-supplied at run time; the probe only reports the current
// text.
export function textParams(graph, enums, outputClasses) {
  const out = [];
  for (const [id, n] of Object.entries(graph ?? {})) {
    const type = String(n.class_type ?? "");
    const isOutput = outputClasses?.has(type) ?? false;
    for (const [key, v] of Object.entries(n.inputs ?? {})) {
      if (typeof v !== "string") continue;
      if (type.toLowerCase().endsWith("loadimage") && key === "image") continue;
      if (isOutput && key === "filename_prefix") continue;
      if (enums?.get(`${type}.${key}`)?.length) continue;
      out.push({
        id: `${type}#${id}.${key}`,
        nodeId: id, nodeIds: [id], key, type,
        title: n._meta?.title && n._meta.title !== type ? String(n._meta.title) : null,
        current: v,
      });
    }
  }
  return out;
}

// Every numeric scalar input of every node instance is a varyable parameter
// (multi-carrier: same-type same-input instances share one param and sweep
// together). The host's declared type wins over value inference for integer.
export function inspectGraph(graph, types = null) {
  const out = new Map();
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
        const declared = types?.get(pid);
        out.set(pid, {
          id: pid, nodeIds: [id], key, type, title, current: v,
          integer: declared ? declared === "INT" : Number.isInteger(v),
        });
      }
    }
  }
  return [...out.values()];
}

// --- graph mutation --------------------------------------------------------------

export function mutateGraph(graph, permutation, params) {
  const clone = structuredClone(graph);
  const byId = new Map();
  for (const p of params ?? inspectGraph(clone)) byId.set(p.id, p);
  const applied = [];
  for (const [id, value] of Object.entries(permutation)) {
    const p = byId.get(id);
    if (!p) continue;
    const v = typeof value === "string" ? value : (p.integer ? Math.round(value) : value);
    for (const nodeId of p.nodeIds) {
      const node = clone[nodeId];
      if (!node?.inputs) continue;
      node.inputs[p.key] = v;
    }
    applied.push(id);
  }
  return { graph: clone, applied };
}

// --- output nodes ----------------------------------------------------------------

function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

// Output nodes are identified by object_info's `output_node: true` (F4 —
// not a hardcoded class-name pattern). Among those, the node that PRODUCED
// the source image is identified by prefix-matching the original filename
// (ComfyUI names outputs `<prefix>_<counter>_.<ext>`).
export function findProducingOutputNode(graph, originalFilename, outputClasses) {
  const base = stripExtension(originalFilename);
  let best = null;
  for (const [nid, n] of Object.entries(graph)) {
    if (!outputClasses.has(String(n.class_type ?? ""))) continue;
    const pfx = n.inputs?.filename_prefix;
    if (typeof pfx !== "string" || !pfx) continue;
    if (base === pfx || base.startsWith(pfx + "_")) {
      if (!best || pfx.length > best.prefix.length) best = { id: nid, node: n, prefix: pfx };
    }
  }
  return best;
}

// Index the graph's output nodes once per run (not per permutation).
export function outputNodeIndex(graph, outputClasses) {
  const out = [];
  for (const [nid, n] of Object.entries(graph)) {
    if (outputClasses.has(String(n.class_type ?? ""))) out.push(nid);
  }
  return out;
}

// Wrap ONLY the producing node's filename_prefix with pfx/sfx and delete
// every OTHER output node so the run produces one file, not N.
export function narrowToOneOutputNode(graph, producingId, basename, pfx, sfx, outputClasses) {
  let dropped = 0;
  for (const nid of outputNodeIndex(graph, outputClasses)) {
    if (nid === producingId) continue;
    delete graph[nid];
    dropped++;
  }
  graph[producingId].inputs.filename_prefix = pfx + basename + sfx;
  return { kept: 1, dropped };
}

// Fallback: wrap every output node's own prefix with the user's pfx/sfx.
export function wrapAllOutputPrefixes(graph, pfx, sfx, outputClasses) {
  let touched = 0;
  for (const n of Object.values(graph)) {
    if (!outputClasses.has(String(n.class_type ?? ""))) continue;
    const orig = String(n.inputs?.filename_prefix ?? "");
    n.inputs.filename_prefix = pfx + orig + sfx;
    touched++;
  }
  return touched;
}

// The lineage tag: ComfyUI writes every extra_pnginfo key as a JSON-encoded
// PNG text chunk, so a variation's output PNG carries where it came from —
// rename-proof, host-move-proof. A re-varied variation tags its immediate
// parent; the chain walks via repeated jumps.
export function lineageTag(source, params) {
  return { kz: JSON.parse(JSON.stringify({ v: 1, source, params })) };
}

// --- registration ----------------------------------------------------------------

// app: { store, cache, hosts, ingest, comfy, backings } — the engine surface
// for features.
export function register(app) {
  const inspect = async (collection, name) => {
    const hash = app.store.hashFor(collection, name);
    if (!hash) return { error: "image not ingested (no hash)", status: 404 };
    const graph = await app.ingest.graph(hash);
    if (!graph) return { error: "no embedded ComfyUI graph in this PNG", status: 422 };
    const addr = app.hosts[collection];
    if (!addr) return { error: "unknown collection", status: 404 };
    const { types, enums, outputClasses } = await app.backings.comfy(collection).objectInfo();
    return { graph, addr, types, enums, outputClasses };
  };

  app.route("GET", "/probe/<id>", async (_req, { id }) => {
    const i = id.indexOf(":");
    if (i < 0) return Response.json({ error: "id must be collection:name" }, { status: 400 });
    const collection = id.slice(0, i), name = id.slice(i + 1);
    const r = await inspect(collection, name);
    if (r.error) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({
      params: inspectGraph(r.graph, r.types),
      stringParams: stringParams(r.graph),
      enumParams: enumParams(r.graph, r.enums),
      textParams: textParams(r.graph, r.enums, r.outputClasses),
    });
  });

  app.route("POST", "/run", async (req) => {
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ error: "JSON body required" }, { status: 400 }); }

    const { id, host, filename, ranges, prefix, suffix, relative, imageParams } = body;
    if (!id || !host || !filename || !ranges) {
      return Response.json({ error: "missing required fields" }, { status: 400 });
    }

    const r = await inspect(host, filename);
    if (r.error) return Response.json({ error: r.error }, { status: r.status });
    const { graph, addr, types, enums, outputClasses } = r;

    // Inspect once for current values + labels. Types come from the host's
    // object_info — the current value is not a reliable integer signal.
    const inspection = inspectGraph(graph, types);
    const currentValues = {};
    const labelMap = {};
    for (const p of inspection) {
      currentValues[p.id] = p.current;
      labelMap[p.id] = p.title ?? p.type;
    }
    const strParams = stringParams(graph);
    for (const p of strParams) {
      currentValues[p.id] = p.current;
      labelMap[p.id] = p.title ?? p.type;
    }
    // enum axes (LoRA names, samplers, …): picks land on the right node via
    // fullInspection; the current value feeds the current-combo exclusion
    // and the prefix/suffix templating like every other axis
    const enParams = enumParams(graph, enums);
    for (const p of enParams) {
      currentValues[p.id] = p.current;
      labelMap[p.id] = p.title ?? p.type;
    }
    // text axes (prompts, …): same wiring — user-supplied values this time
    const txtParams = textParams(graph, enums, outputClasses);
    for (const p of txtParams) {
      currentValues[p.id] = p.current;
      labelMap[p.id] = p.title ?? p.type;
    }
    const fullInspection = [...inspection, ...strParams, ...enParams, ...txtParams];

    // Batch sweeps arrive as offsets from each image's own current value;
    // resolve them now that this graph's current values are known.
    const resolvedRanges = relative ? resolveRelativeRanges(ranges, currentValues) : ranges;

    let permutations;
    try {
      permutations = generatePermutations(resolvedRanges, currentValues, imageParams ?? {});
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations (check ranges and increment)" }, { status: 400 });
    }
    if (permutations.length > MAX_PERMUTATIONS) {
      return Response.json({ error: `too many permutations (${permutations.length} > ${MAX_PERMUTATIONS})` }, { status: 413 });
    }

    // Output nodes by object_info's output_node flag, indexed once per run.
    const producing = outputClasses?.size
      ? findProducingOutputNode(graph, filename, outputClasses)
      : null;

    const pfxTpl = String(prefix ?? "");
    const sfxTpl = String(suffix ?? "");
    const originalBasename = stripExtension(filename);

    const errors = [];
    let submitted = 0;
    for (const perm of permutations) {
      const { graph: mutated, applied } = mutateGraph(graph, perm, fullInspection);
      if (applied.length === 0) {
        errors.push({ permutation: perm, error: "no applicable nodes found" });
        continue;
      }

      // {image} = the LoadImage filename chosen for this permutation (the
      // prefixed {LoadImage.image} token resolves via currentValues too)
      const imgAxes = Object.fromEntries(Object.entries(perm).filter(([k]) => k.endsWith(".image")));
      const rawImage = Object.values(imgAxes)[0];
      const tokenValues = rawImage != null ? { ...perm, image: rawImage } : perm;
      const pfx = templateReplace(pfxTpl, tokenValues, currentValues, labelMap);
      const sfx = templateReplace(sfxTpl, tokenValues, currentValues, labelMap);

      if (producing) {
        const p = findProducingOutputNode(mutated, filename, outputClasses);
        if (!p) {
          errors.push({ permutation: perm, error: "producing output node lost after clone" });
          continue;
        }
        narrowToOneOutputNode(mutated, p.id, originalBasename, pfx, sfx, outputClasses);
      } else {
        if (!wrapAllOutputPrefixes(mutated, pfx, sfx, outputClasses ?? new Set())) {
          errors.push({ permutation: perm, error: "no output node in graph" });
          continue;
        }
      }

      const res = await app.backings.comfy(host).enqueue({
        prompt: mutated,
        extra_data: { extra_pnginfo: lineageTag(`${host}:${filename}`, perm) },
      });
      if (!res.ok) errors.push({ permutation: perm, error: res.error });
      else submitted++;
    }

    return Response.json({ submitted, total: permutations.length, errors });
  });
}
