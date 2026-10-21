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
  generatePermutations, permutationAxes, permutationPlan, resolveRelativeRanges, templateReplaceWithProof,
  paramId, parameterIndex, catalogueParams, parameterAliases, validRunAcknowledgement,
} from "./shared.mjs";
import { validEntryName } from "../../backings/index.mjs";
import { sourceOrigin, sameOrigin, validOrigin, validContext } from "../../source-origin.mjs";
import { dependencyClosure, validateGraphLinks } from "./graph.mjs";

// hard cap on permutations per run — a sweep is a human-scale batch, not a
// fork bomb (F7). Above the cap the run answers 413.
const MAX_PERMUTATIONS = 500;

const IMG_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

// ComfyUI stores output-sourced LoadImage widget values as "name.png [output]"
const ANNOTATION = /^(.*)\s+\[([^\]]*)\]$/;

// --- graph inspection (ComfyUI conventions) -----------------------------------

// One walk, explicit classification precedence, one descriptor constructor.
// Strategies supply only kind-specific metadata; identity/location is shared.
const PARAMETER_KINDS = [
  { kind: "numeric", channel: "params", accepts: p => typeof p.value === "number",
    describe: p => ({ integer: p.declared ? p.declared === "INT" : Number.isInteger(p.value) }) },
  { kind: "image", channel: "stringParams", accepts: p => p.image,
    describe: p => {
      const match = ANNOTATION.exec(p.value), file = match ? match[1] : p.value;
      return IMG_FILE.test(file) ? { current: file, fromOutput: match ? /^output$/i.test(match[2]) : false } : null;
    } },
  { kind: "enum", channel: "enumParams", accepts: p => p.options?.length,
    describe: p => ({ values: p.options }) },
  { kind: "text", channel: "textParams", accepts: () => true, describe: () => ({}) },
];
export function parameterCatalogue(graph, { types = null, enums = null, outputClasses = null } = {}) {
  const catalogue = Object.fromEntries(PARAMETER_KINDS.map(strategy => [strategy.channel, []]));
  for (const [nodeId, node] of Object.entries(graph ?? {})) {
    const type = String(node.class_type ?? "");
    if (!type) continue;
    const title = node._meta?.title && node._meta.title !== type ? String(node._meta.title) : null;
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (typeof value !== "number" && typeof value !== "string") continue;
      if (typeof value === "string" && key === "filename_prefix" && outputClasses?.has(type)) continue;
      const schemaKey = `${type}.${key}`;
      const context = { value, declared: types?.get(schemaKey), options: enums?.get(schemaKey),
        image: typeof value === "string" && /loadimage$/i.test(type) && key === "image" };
      const strategy = PARAMETER_KINDS.find(strategy => strategy.accepts(context));
      const metadata = strategy.describe(context);
      if (!metadata) continue;
      catalogue[strategy.channel].push({ id: paramId(nodeId, key), nodeId, nodeIds: [nodeId], key,
        type, title, kind: strategy.kind, current: value, ...metadata });
    }
  }
  parameterIndex(catalogueParams(catalogue), graph);
  return catalogue;
}

// Compatibility inspection ports all project the same descriptor pipeline.
export const inspectGraph = (graph, types = null) => parameterCatalogue(graph, { types }).params;
export const stringParams = graph => parameterCatalogue(graph).stringParams;
export const enumParams = (graph, enums) => parameterCatalogue(graph, { enums }).enumParams;
export const textParams = (graph, enums, outputClasses) => parameterCatalogue(graph, { enums, outputClasses }).textParams;

// --- graph mutation --------------------------------------------------------------

export function mutateGraph(graph, permutation, params) {
  const clone = structuredClone(graph);
  const byId = parameterIndex(params ?? inspectGraph(clone));
  const applied = [], writes = [];
  for (const [id, value] of Object.entries(permutation)) {
    const p = byId.get(id);
    if (!p) continue;
    const v = typeof value === "string" ? value : (p.integer ? Math.round(value) : value);
    for (const nodeId of p.nodeIds) {
      const node = clone[nodeId];
      if (!node?.inputs || !Object.hasOwn(node.inputs, p.key)) continue;
      node.inputs[p.key] = v;
      writes.push({ id, nodeId, key: p.key, value: v });
    }
    if (writes.some(write => write.id === id)) applied.push(id);
  }
  return { graph: clone, applied, writes };
}

// Descriptor IDs are not proof. Every carrier must have received the assignment
// and survived output narrowing/rewriting. Colliding descriptors stay uncertified.
function survivingAxes(graph, writes, inspection) {
  return [...new Set(writes.map(write => write.id))].filter(id => {
    const descriptors = inspection.filter(param => param.id === id);
    if (descriptors.length !== 1) return false;
    const carriers = descriptors[0].nodeIds;
    return carriers.length > 0 && carriers.every(nodeId => writes.some(write => write.id === id && write.nodeId === nodeId &&
      Object.hasOwn(graph[nodeId]?.inputs ?? {}, write.key) && Object.is(graph[nodeId].inputs[write.key], write.value)));
  });
}

// --- output nodes ----------------------------------------------------------------

function stripExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

const outputPath = (value) => {
  const name = String(value), slash = name.lastIndexOf("/");
  return { directory: slash < 0 ? "" : name.slice(0, slash + 1), leaf: name.slice(slash + 1) };
};

// Output nodes are identified by object_info's `output_node: true` (F4 —
// not a hardcoded class-name pattern). Among those, the node that PRODUCED
// the source image is identified by prefix-matching the original filename
// (ComfyUI names outputs `<prefix>_<counter>_.<ext>`).
export function findProducingOutputNode(graph, originalFilename, outputClasses) {
  const base = stripExtension(originalFilename);
  const directory = outputPath(originalFilename).directory;
  let best = null, ambiguous = false;
  for (const [nid, n] of Object.entries(graph)) {
    if (!outputClasses.has(String(n.class_type ?? ""))) continue;
    const pfx = n.inputs?.filename_prefix;
    if (typeof pfx !== "string" || !pfx) continue;
    if (outputPath(pfx).directory !== directory) continue;
    if (base === pfx || base.startsWith(pfx + "_")) {
      if (!best || pfx.length > best.prefix.length) { best = { id: nid, node: n, prefix: pfx }; ambiguous = false; }
      else if (directory && pfx.length === best.prefix.length) ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

// Index the graph's output nodes once per run (not per permutation).
export function outputNodeIndex(graph, outputClasses) {
  const out = [];
  for (const [nid, n] of Object.entries(graph)) {
    if (outputClasses.has(String(n.class_type ?? ""))) out.push(nid);
  }
  return out;
}

// Filesystem NAME_MAX is 255 bytes; ComfyUI appends "_NNNNN_.png" (~12)
// to the prefix. Fold over-long names in the MIDDLE: keep head AND tail —
// head carries the pipeline identity, tail carries the newest lineage —
// and mark the fold with "~". (Ported from kosmozoo.dev's variations
// plugin after a lineage-chained batch died at SaveImage with
// ENAMETOOLONG — assembled prefixes hit 252–264 chars.)
export function clampBasename(basename, max) {
  if (basename.length <= max) return basename;
  const keep = max - 1;                 // one char reserved for the "~"
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return basename.slice(0, head) + "~" + basename.slice(basename.length - tail);
}

export const HEADROOM = 15;  // ComfyUI's "_NNNNN_.png" counter suffix
export const NAME_MAX_WITHOUT_COUNTER = 200;  // hard cap on the assembled prefix
// How much of NAME_MAX remains for a node's own middle after pfx/sfx have
// claimed their share (fallback path wraps every node's prefix).
export function clampBudget(pfx, sfx) {
  return 255 - HEADROOM - String(pfx).length - String(sfx).length;
}

// Wrap ONLY the producing node's filename_prefix. Other output nodes stay
// only when the producer depends on them, including through lazy inputs.
export function narrowToOneOutputNode(graph, producingId, basename, pfx, sfx, outputClasses) {
  const dependencies = dependencyClosure(graph, producingId);
  let kept = 0, dropped = 0;
  for (const nid of outputNodeIndex(graph, outputClasses)) {
    if (dependencies.has(nid)) { kept++; continue; }
    delete graph[nid];
    dropped++;
  }
  // Assembled prefix gets the middle-fold treatment: pfx head and sfx tail
  // both survive, at most NAME_MAX_WITHOUT_COUNTER chars total.
  const directory = outputPath(graph[producingId].inputs.filename_prefix).directory;
  graph[producingId].inputs.filename_prefix = directory + clampBasename(pfx + outputPath(basename).leaf + sfx, NAME_MAX_WITHOUT_COUNTER);
  return { kept, dropped };
}

// Fallback: wrap every output node's own prefix with the user's pfx/sfx.
// The middle budget subtracts pfx/sfx so a long pfx/sfx can't push the
// assembled prefix over NAME_MAX either.
export function wrapAllOutputPrefixes(graph, pfx, sfx, outputClasses) {
  let touched = 0;
  for (const n of Object.values(graph)) {
    if (!outputClasses.has(String(n.class_type ?? ""))) continue;
    const orig = String(n.inputs?.filename_prefix ?? "");
    const { directory, leaf } = outputPath(orig);
    n.inputs.filename_prefix = directory + pfx + clampBasename(leaf, clampBudget(pfx, sfx)) + sfx;
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
  const inspect = async (collection, name, expected = null) => {
    if (!app.backings.accepting()) return { error: "Sources are stopping; no new operation was admitted", status: 503 };
    const token = app.backings.capture(collection);
    const addr = token?.address;
    if (!addr) return { error: "unknown collection", status: 404 };
    const origin = sourceOrigin(collection, app.backings.source(collection));
    if (expected && !sameOrigin(expected.origin, origin)) return { error: "Source origin changed; work was kept", status: 412 };
    const backing = app.backings.comfy(collection);
    if (!validEntryName(addr, name)) return { error: "bad entry path", status: 400 };
    const hash = app.store.hashFor(collection, name);
    if (!hash) return { error: "image not ingested (no hash)", status: 404 };
    if (expected?.graphHash && expected.graphHash !== hash) return { error: "Graph catalogue changed; work was kept", status: 412 };
    const graph = await app.ingest.graph(hash);
    if (!app.backings.isCurrent(token)) return { error: "source changed during inspection", status: 409 };
    if (!graph) return { error: "no embedded ComfyUI graph in this PNG", status: 422 };
    const { types, enums, outputClasses } = await backing.objectInfo();
    if (!app.backings.isCurrent(token)) return { error: "source changed during inspection", status: 409 };
    return { graph, addr, types, enums, outputClasses, token, backing, context: { origin, graphHash: hash } };
  };

  app.route("GET", "/probe/<id>", async (_req, { id }) => {
    const i = id.indexOf(":");
    if (i < 0) return Response.json({ error: "id must be collection:name" }, { status: 400 });
    const collection = id.slice(0, i), name = id.slice(i + 1);
    let expected = null;
    const raw = new URL(_req.url).searchParams.get("origin");
    if (raw !== null) {
      try { expected = { origin: JSON.parse(raw) }; } catch { return Response.json({ error: "Invalid expected origin" }, { status: 400 }); }
      if (!validOrigin(expected.origin)) return Response.json({ error: "Invalid expected origin" }, { status: 400 });
    }
    const r = await inspect(collection, name, expected);
    if (r.error) return Response.json({ error: r.error }, { status: r.status });
    return Response.json({
      ...parameterCatalogue(r.graph, r),
      context: r.context,
    });
  });

  app.route("POST", "/run", async (req) => {
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ error: "JSON body required" }, { status: 400 }); }

    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "JSON object required" }, { status: 400 });
    const { id, host, filename, ranges, prefix, suffix, relative, imageParams, acknowledgement, context } = body;
    if (!id || !host || !filename || !ranges) {
      return Response.json({ error: "missing required fields" }, { status: 400 });
    }
    if (!validContext(context) || context.origin.source !== host) {
      return Response.json({ error: "Version2 requires the captured source/graph context" }, { status: 400 });
    }
    if (!validRunAcknowledgement(acknowledgement) || id !== `${host}:${filename}` ||
        Object.keys(ranges).some(key => ranges[key]?.enabled && imageParams?.[key]?.enabled)) {
      return Response.json({ error: "invalid or ambiguous submission acknowledgement request" }, { status: 400 });
    }

    const r = await inspect(host, filename, context);
    if (r.error) return Response.json({ error: r.error }, { status: r.status });
    const { graph, outputClasses, token, backing } = r;

    // Inspect once for current values + labels. Types come from the host's
    // object_info — the current value is not a reliable integer signal.
    const fullInspection = catalogueParams(parameterCatalogue(graph, r));
    const currentValues = Object.fromEntries([...parameterIndex(fullInspection).values()].map(p => [p.id, p.current]));
    const labelMap = parameterAliases(fullInspection);

    // Batch sweeps arrive as offsets from each image's own current value;
    // resolve them now that this graph's current values are known.
    let axes, resolvedRanges, permutations;
    try {
      axes = permutationAxes(ranges, imageParams ?? {});
      const selectedRanges = Object.fromEntries(axes.enabled);
      const selectedValues = Object.fromEntries(axes.imgEnabled);
      resolvedRanges = relative ? resolveRelativeRanges(selectedRanges, currentValues) : selectedRanges;
      const count = permutationPlan(resolvedRanges, currentValues, selectedValues).total;
      if (count > MAX_PERMUTATIONS) return Response.json({ error: `too many permutations (${count} > ${MAX_PERMUTATIONS})` }, { status: 413 });
      permutations = generatePermutations(resolvedRanges, currentValues, selectedValues);
    } catch (e) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations to submit (enable an axis or move it off the current values)" }, { status: 400 });
    }
    if (permutations.length > MAX_PERMUTATIONS) {
      return Response.json({ error: `too many permutations (${permutations.length} > ${MAX_PERMUTATIONS})` }, { status: 413 });
    }
    console.log(`[variations] run ${host}:${filename} — ${permutations.length} permutations over ${axes.imgEnabled.length} enum/text axes`);

    // Output nodes by object_info's output_node flag, indexed once per run.
    const producing = outputClasses?.size
      ? findProducingOutputNode(graph, filename, outputClasses)
      : null;
    if (filename.includes("/") && !producing) {
      return Response.json({ error: "Cannot identify an unambiguous producing output directory for this image" }, { status: 400 });
    }

    const pfxTpl = String(prefix ?? "");
    const sfxTpl = String(suffix ?? "");
    const originalBasename = stripExtension(outputPath(filename).leaf);

    const errors = [];
    const accepted = [];
    let submitted = 0;
    for (const [index, perm] of permutations.entries()) {
      if (!app.backings.isCurrent(token)) {
        errors.push({ permutation: perm, error: "source changed; remaining jobs were not submitted" });
        break;
      }
      const { graph: mutated, applied, writes } = mutateGraph(graph, perm, fullInspection);
      if (applied.length === 0) {
        console.error(`[variations] permutation matched no nodes ${JSON.stringify(perm)}`);
        errors.push({ permutation: perm, error: "no applicable nodes found" });
        continue;
      }

      const prefixProof = templateReplaceWithProof(pfxTpl, perm, currentValues, labelMap);
      const suffixProof = templateReplaceWithProof(sfxTpl, perm, currentValues, labelMap);
      const pfx = prefixProof.text, sfx = suffixProof.text;
      if (filename.includes("/") && /[/\\]/.test(pfx + sfx)) {
        errors.push({ permutation: perm, error: "Prefix/suffix must stay within the producing directory's filename leaf" });
        continue;
      }

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

      try { validateGraphLinks(mutated); }
      catch (e) {
        errors.push({ permutation: perm, error: e.message });
        continue;
      }

      const surviving = survivingAxes(mutated, writes, fullInspection);
      const outputs = outputNodeIndex(mutated, outputClasses ?? new Set()).map(nodeId => ({
        value: mutated[nodeId].inputs?.filename_prefix,
        directory: outputPath(graph[nodeId].inputs?.filename_prefix ?? "").directory,
      }));
      const naming = [];
      if (outputs.length && outputs.every(({ value }) => typeof value === "string")) {
        if (prefixProof.complete && outputs.every(({ value, directory }) => value.slice(directory.length).startsWith(pfx))) naming.push("prefix");
        if (suffixProof.complete && outputs.every(({ value }) => value.endsWith(sfx))) naming.push("suffix");
      }
      const res = await backing.enqueue({
        prompt: mutated,
        extra_data: { extra_pnginfo: lineageTag(`${host}:${filename}`, perm) },
      });
      if (!res.ok) {
        console.error(`[variations] permutation failed ${JSON.stringify(perm)} → ${res.error}`);
        errors.push({ permutation: perm, error: res.error });
      } else {
        submitted++;
        if (!app.backings.isCurrent(token)) errors.push({ permutation: perm, error: "source changed after submission; configuration was not acknowledged" });
        else if (res.acceptance !== "confirmed") errors.push({ permutation: perm, error: res.error ?? "submission acceptance is unconfirmed; do not automatically resubmit" });
        else {
          const applied = {
            ranges: surviving.filter(id => resolvedRanges[id]?.enabled && !imageParams?.[id]?.enabled),
            imageParams: surviving.filter(id => imageParams?.[id]?.enabled && !resolvedRanges[id]?.enabled),
          };
          // On uses the surviving write proof; off was consumed by the same
          // selection filter that constructed this permutation, not a value write.
          const selections = Object.fromEntries(["ranges", "imageParams"].map(channel => [channel,
            [...applied[channel], ...axes.excluded[channel].filter(id => !Object.hasOwn(perm, id))]]));
          accepted.push({ index, promptId: res.promptId, applied, selections, naming });
        }
      }
    }

    if (errors.length) console.error(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}, ${errors.length} failed`);
    else console.log(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}`);
    return Response.json({ submitted, total: permutations.length, errors,
      acknowledgement: { ...acknowledgement, target: { id, host, filename }, context: r.context, accepted },
    });
  });
}
