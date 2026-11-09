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
  generatePermutations, permutationAxes, permutationPlan, resolveRelativeRanges,
  parameterIndex, parameterCurrent, catalogueParams, parameterAliases, validRunAcknowledgement, runOperationFields, targetRunPlan,
  composeOutputName, variationOutputName, paramId,
} from "./shared.mjs";
import { validEntryName, backingFor as defaultBackingFor } from "../../backings/index.mjs";
import { sourceOrigin, sameOrigin, validOrigin, validContext, expectedOrigin } from "../../source-origin.mjs";
import { dependencyClosure } from "../../graph.mjs";
import { sha256 } from "../../cache.mjs";
import { IMAGE_EXTENSIONS, mediaExtension } from "../../backings/mime.mjs";
import { listImages, readImage, folderError } from "./folder-images.mjs";
import { inspectImage } from "./image-inspection.mjs";
import { readJson, mediaHeaders } from "../../routes.mjs";
import { graphParameters, editableParameter, cloneJsonValue, sameJsonValue, parseExactJson, stringifyExactJson } from "../../parameters.mjs";
import { compileValue, compileDiscreteAxes, validateFinalGraph } from "./compile.mjs";

const exactResponse = (value, init = {}) => new Response(stringifyExactJson(value), {
  ...init, headers: { "Content-Type": "application/json", ...init.headers },
});

// hard cap on permutations per run — a sweep is a human-scale batch, not a
// fork bomb (F7). Above the cap the run answers 413.
const MAX_PERMUTATIONS = 500;

// --- graph inspection (ComfyUI conventions) -----------------------------------

const PARAMETER_CHANNELS = { numeric: "params", image: "stringParams", enum: "enumParams", text: "textParams" };
export function parameterCatalogue(graph, schema = {}) {
  const parameters = graphParameters(graph, schema);
  const catalogue = Object.fromEntries(Object.values(PARAMETER_CHANNELS).map(channel => [channel, []]));
  for (const parameter of parameters) {
    const editable = editableParameter(parameter);
    if (editable) catalogue[PARAMETER_CHANNELS[editable.kind]].push(editable);
  }
  parameterIndex(catalogueParams(catalogue), graph);
  return { ...catalogue, parameters };
}

// Compatibility inspection ports all project the same descriptor pipeline.
export const inspectGraph = (graph, types = null) => parameterCatalogue(graph, { types }).params;
export const stringParams = graph => parameterCatalogue(graph).stringParams;
export const enumParams = (graph, enums) => parameterCatalogue(graph, { enums }).enumParams;
export const textParams = (graph, enums, outputClasses) => parameterCatalogue(graph, { enums, outputClasses }).textParams;

// --- graph mutation --------------------------------------------------------------

export function mutateGraph(graph, permutation, params, dynamicCombos = null, { rangeIds = null } = {}) {
  const clone = cloneJsonValue(graph);
  const byId = parameterIndex(params ?? inspectGraph(clone));
  // Prepare branch switches before explicit scalar writes, independent of axis
  // order. An inactive child cannot be reintroduced by a later assignment.
  for (const [nodeId, node] of Object.entries(clone)) {
    const type = String(node.class_type ?? ""), inputs = node.inputs;
    if (!inputs) continue;
    const selections = new Map(Object.entries(permutation).flatMap(([id, value]) => {
      const p = byId.get(id);
      return p?.nodeIds.includes(nodeId) ? [[p.key, value]] : [];
    }));
    const prepare = combos => {
      for (const [name, options] of combos ?? []) {
        if (!name.startsWith(type + ".")) continue;
        const key = name.slice(type.length + 1);
        if (!Object.hasOwn(inputs, key)) continue;
        const value = selections.has(key) ? selections.get(key) : inputs[key], branch = options.get(value);
        if (selections.has(key) && !branch) throw new Error(`Unknown dynamic option for ${nodeId}.${key}: ${value}`);
        if (!branch) continue;
        if (!Object.is(inputs[key], value)) {
          for (const child of Object.keys(inputs)) if (child.startsWith(key + ".")) delete inputs[child];
          for (const [child, value] of branch.defaults) {
            if (value === undefined) throw new Error(`No object_info default for ${nodeId}.${child.slice(type.length + 1)}`);
            inputs[child.slice(type.length + 1)] = cloneJsonValue(value);
          }
        }
        prepare(branch.dynamicCombos);
      }
    };
    prepare(dynamicCombos);
  }
  const applied = [], writes = [];
  for (const [id, value] of Object.entries(permutation)) {
    const p = byId.get(id);
    if (!p) continue;
    const v = compileValue(p, p.integer && typeof value === "number" && (rangeIds === null || rangeIds.has(id)) ? Math.round(value) : value);
    for (const nodeId of p.nodeIds) {
      const node = clone[nodeId];
      if (!node?.inputs || !Object.hasOwn(node.inputs, p.key)) continue;
      node.inputs[p.key] = cloneJsonValue(v);
      writes.push({ id, nodeId, key: p.key, value: cloneJsonValue(v) });
    }
    if (writes.some(write => write.id === id)) applied.push(id);
  }
  return { graph: clone, applied, writes };
}

// Descriptor IDs are not proof. Every carrier must have received the assignment
// and survived output narrowing/rewriting. Colliding descriptors stay uncertified.
function survivingAxes(graph, writes, inspection, namingProofs = []) {
  return [...new Set(writes.map(write => write.id))].filter(id => {
    const descriptors = inspection.filter(param => param.id === id);
    if (descriptors.length !== 1) return false;
    const carriers = descriptors[0].nodeIds;
    return carriers.length > 0 && carriers.every(nodeId => writes.some(write => write.id === id && write.nodeId === nodeId &&
      Object.hasOwn(graph[nodeId]?.inputs ?? {}, write.key) && (sameJsonValue(graph[nodeId].inputs[write.key], write.value) ||
        namingProofs.some(proof => proof.nodeId === nodeId && proof.parameterId === id && write.key === "filename_prefix" &&
          sameJsonValue(proof.candidate, write.value) && sameJsonValue(graph[nodeId].inputs[write.key], proof.value)))));
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

export function outputNamingTargets(graph, filename, producingId, outputClasses) {
  return outputNodeIndex(graph, outputClasses).map(nodeId => {
    const path = outputPath(graph[nodeId].inputs?.filename_prefix ?? "");
    return { nodeId, parameterId: paramId(nodeId, "filename_prefix"), directory: path.directory,
      sourceStem: nodeId === producingId ? stripExtension(outputPath(filename).leaf) : path.leaf,
      leafOnly: filename.includes("/") };
  });
}

function writeOutputNames(graph, targets, pfx, sfx, { values = {}, proofs = [] } = {}) {
  const written = [];
  for (const target of targets) {
    const node = graph[target.nodeId];
    if (!node?.inputs) throw new Error(`Producing output node ${target.nodeId} is missing`);
    const result = composeOutputName(target, values, pfx, sfx);
    node.inputs.filename_prefix = result.value;
    if (result.selected) proofs.push({ ...result, nodeId: target.nodeId });
    written.push(target.nodeId);
  }
  return written;
}

export { HEADROOM, OUTPUT_NAME_BUDGET as NAME_MAX_WITHOUT_COUNTER } from "./shared.mjs";

// Wrap ONLY the producing node's filename_prefix. Other output nodes stay
// only when the producer depends on them, including through lazy inputs.
export function narrowToOneOutputNode(graph, producingId, basename, pfx, sfx, outputClasses, options = {}) {
  const dependencies = dependencyClosure(graph, producingId);
  let kept = 0, dropped = 0;
  for (const nid of outputNodeIndex(graph, outputClasses)) {
    if (dependencies.has(nid)) { kept++; continue; }
    delete graph[nid];
    dropped++;
  }
  const target = options.targets?.find(target => target.nodeId === producingId) ?? {
    nodeId: producingId, directory: outputPath(graph[producingId].inputs.filename_prefix).directory, sourceStem: outputPath(basename).leaf };
  return { kept, dropped, written: writeOutputNames(graph, [target], pfx, sfx, options) };
}

// Fallback: wrap every output node's own prefix with the user's pfx/sfx.
// The same shared writer keeps affixes whole and folds only the source stem.
export function wrapAllOutputPrefixes(graph, pfx, sfx, outputClasses, options = {}) {
  const targets = options.targets ?? outputNamingTargets(graph, "", null, outputClasses);
  return writeOutputNames(graph, targets, pfx, sfx, options);
}

// The lineage tag: ComfyUI writes every extra_pnginfo key as a JSON-encoded
// PNG text chunk, so a variation's output PNG carries where it came from —
// rename-proof, host-move-proof. A re-varied variation tags its immediate
// parent; the chain walks via repeated jumps.
export function lineageTag(source, params) {
  return { kz: cloneJsonValue({ v: 1, source, params }) };
}

// --- registration ----------------------------------------------------------------

// app: { store, cache, hosts, ingest, comfy, backings } — the engine surface
// for features.
export function register(app) {
  const backingFor = app.backings?.backingFor ?? defaultBackingFor;
  app.route("GET", "/folder-chooser", async () => Response.json(await app.desktop.capability()));
  app.route("POST", "/choose-folder", async req => {
    let body;
    try { body = await readJson(req); } catch { return Response.json({ error: "Folder path required" }, { status: 400 }); }
    if (!body || typeof body.path !== "string") return Response.json({ error: "Folder path required" }, { status: 400 });
    try { return Response.json(await app.desktop.choose({ path: body.path, signal: req.signal })); }
    catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 502 }); }
  });
  const source = (req, host) => {
    const origin = expectedOrigin(req), token = app.backings.capture(host);
    if (!origin || !token || !sameOrigin(origin, sourceOrigin(host, app.backings.source(host))) || !app.backings.accepting()) throw Object.assign(new Error("Source origin changed"), { status: 412 });
    return { origin, token };
  };
  app.route("POST", "/folder-images", async req => {
    try { return Response.json(await listImages((await readJson(req)).path)); }
    catch (error) { return folderError(error); }
  });
  app.route("GET", "/folder-image", async req => {
    try {
      const { bytes, mime } = await readImage(new URL(req.url).searchParams.get("path"));
      return new Response(bytes, { headers: mediaHeaders({ "Content-Type": mime, "Cache-Control": "no-store" }) });
    } catch (error) { return folderError(error); }
  });
  app.route("POST", "/inspect-path/<host>", async (req, { host }) => {
    try {
      const { origin, token } = source(req, host), body = await readJson(req), file = await readImage(body.path);
      return await inspectImage(app, token, host, { ...body, ...file }, origin);
    } catch (error) { return folderError(error); }
  });
  app.route("POST", "/upload-path/<host>", async (req, { host }) => {
    try {
      const { origin, token } = source(req, host), body = await readJson(req);
      if (!/^[a-f0-9]{64}$/.test(body.hash)) return Response.json({ error: "Inspected image hash required" }, { status: 400 });
      const file = await readImage(body.path);
      if (await sha256(file.bytes) !== body.hash) return Response.json({ error: "Image changed since it was added. Remove and add it again." }, { status: 409 });
      if (!app.backings.isCurrent(token)) return Response.json({ error: "Source origin changed before upload" }, { status: 412 });
      const backing = backingFor(token.address);
      if (!backing.write) return Response.json({ error: "This source cannot upload images" }, { status: 400 });
      const receipt = await backing.write(token.address, file.name, file.bytes);
      if (!receipt.ok) return Response.json({ error: receipt.error }, { status: receipt.status });
      if (!app.backings.isCurrent(token)) return Response.json({ error: "Source changed after upload; no follow-up was authorized", uploaded: { name: receipt.name, origin } }, { status: 412 });
      return Response.json({ name: receipt.name, origin });
    } catch (error) { return folderError(error); }
  });
  // Readonly comparison through the existing byte/hash owner. This deliberately
  // does not upload to ComfyUI or create another input cache.
  app.route("POST", "/inspect-image/<host>", async (req, { host }) => {
    let origin;
    try { origin = expectedOrigin(req); } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
    const token = app.backings.capture(host);
    if (!origin || !token || !sameOrigin(origin, sourceOrigin(host, app.backings.source(host))) || !app.backings.accepting()) return Response.json({ error: "Source origin changed" }, { status: 412 });
    let form;
    try { form = await req.formData(); } catch { return Response.json({ error: "Multipart image required" }, { status: 400 }); }
    const file = form.get("image"), current = form.get("current"), kind = form.get("kind");
    if (!(file instanceof File) || !IMAGE_EXTENSIONS.has(mediaExtension(file.name)) || !validEntryName(token.address, current) || !["input", "output"].includes(kind)) return Response.json({ error: "Image and current input required" }, { status: 400 });
    let names;
    try { names = JSON.parse(form.get("names") ?? "[]"); } catch { return Response.json({ error: "Input names must be an array" }, { status: 400 }); }
    return inspectImage(app, token, host, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), current, kind, names }, origin);
  });
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
    if (!graph) return { error: "no embedded ComfyUI graph", status: 422 };
    try { stringifyExactJson(graph); }
    catch (error) { return { error: `Embedded graph cannot be represented exactly: ${error.message}`, status: 422 }; }
    const { types, enums, outputClasses, dynamicCombos, declarations, outputs } = await backing.objectInfo();
    if (!app.backings.isCurrent(token)) return { error: "source changed during inspection", status: 409 };
    return { graph, addr, types, enums, outputClasses, dynamicCombos, declarations, outputs, token, backing, context: { origin, graphHash: hash } };
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
    // Project the actual first naming target, including fallback node prefixes.
    // The client owns formatting, but cannot infer these graph facts from a name.
    const producing = findProducingOutputNode(r.graph, name, r.outputClasses ?? new Set());
    const targets = outputNamingTargets(r.graph, name, producing?.id, r.outputClasses ?? new Set());
    return exactResponse({
      ...parameterCatalogue(r.graph, r),
      context: r.context,
      nodes: Object.entries(r.graph).map(([id, node]) => ({ id, type: String(node.class_type ?? ""), title: node._meta?.title ?? null,
        outputs: r.outputs?.get(String(node.class_type ?? "")) ?? null })),
      outputNaming: targets.find(target => target.nodeId === producing?.id) ?? targets[0] ?? null,
      outputNamingTargets: targets,
    });
  });

  app.route("POST", "/run", async (req) => {
    let body;
    try { body = await readJson(req, { parse: parseExactJson }); }
    catch { return Response.json({ error: "JSON body required" }, { status: 400 }); }

    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "JSON object required" }, { status: 400 });
    const { id, host, filename, ranges, relative, imageParams, acknowledgement, context } = body;
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
    const catalogue = parameterCatalogue(graph, r), fullInspection = catalogue.parameters;
    const currentValues = Object.fromEntries([...parameterIndex(fullInspection).values()].map(p => [p.id, parameterCurrent(p)]));
    const legacy = catalogueParams(catalogue), legacyIds = new Set(legacy.map(p => p.id));
    const labelMap = parameterAliases([...legacy, ...fullInspection.filter(p => !legacyIds.has(p.id))]);

    // Batch sweeps arrive as offsets from each image's own current value;
    // resolve them now that this graph's current values are known.
    let axes, resolvedRanges, permutations, effectivePlan, selectedValues;
    try {
      runOperationFields(body);
      effectivePlan = targetRunPlan({ ...body, imageParams: imageParams ?? {} }, catalogue);
      axes = permutationAxes(effectivePlan.payload.ranges, imageParams ?? {});
      const selectedRanges = Object.fromEntries(axes.enabled);
      selectedValues = compileDiscreteAxes(Object.fromEntries(axes.imgEnabled), fullInspection);
      resolvedRanges = relative ? resolveRelativeRanges(selectedRanges, currentValues) : selectedRanges;
      if (Object.keys(selectedRanges).some(id => !Object.hasOwn(resolvedRanges, id))) throw new Error("Every applicable relative range needs clamp bounds");
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

    const namingTargets = outputNamingTargets(graph, filename, producing?.id, outputClasses ?? new Set());
    const firstNamingTarget = namingTargets.find(target => target.nodeId === producing?.id) ?? namingTargets[0];
    const namingRequest = { ...body, ranges: resolvedRanges, imageParams: selectedValues };
    const originalBasename = stripExtension(outputPath(filename).leaf);

    const errors = [];
    const accepted = [];
    let submitted = 0, uncertain = false, retired = false;
    const prepared = [];
    const rejectPlan = error => exactResponse({ error, outcome: "rejected", submitted: 0, total: permutations.length,
      errors: permutations.map(permutation => ({ permutation, error: `Plan rejected: ${error}` })),
      acknowledgement: { ...acknowledgement, target: { id, host, filename }, context: r.context, accepted: [] } }, { status: 400 });
    for (const [index, perm] of permutations.entries()) {
      if (!app.backings.isCurrent(token)) {
        return rejectPlan("source changed; no jobs were submitted");
      }
      let mutation;
      try { mutation = mutateGraph(graph, perm, fullInspection, r.dynamicCombos, { rangeIds: new Set(Object.keys(resolvedRanges)) }); }
      catch (error) { return rejectPlan(error.message); }
      const { graph: mutated, applied, writes } = mutation;
      if (applied.length === 0) {
        return rejectPlan("No applicable nodes found; no jobs were submitted");
      }

      let namingWrites;
      const namingProofs = [];
      try {
        if (!firstNamingTarget) return rejectPlan("No output node in graph");
        // Validate every explicit output prefix, including retained dependencies,
        // without giving those dependencies new sidebar-affix writes.
        for (const target of namingTargets) if (Object.hasOwn(perm, target.parameterId)) composeOutputName(target, perm);
        const naming = variationOutputName(firstNamingTarget, namingRequest, perm, currentValues, labelMap, fullInspection);
        if (!naming.complete) return rejectPlan("Unresolved naming token: check prefix and suffix; no jobs were submitted");
        const { prefix: pfx, suffix: sfx } = naming;
        const options = { targets: namingTargets, values: perm, proofs: namingProofs };
        if (producing) {
          namingWrites = narrowToOneOutputNode(mutated, producing.id, originalBasename, pfx, sfx, outputClasses, options).written;
        } else {
          namingWrites = wrapAllOutputPrefixes(mutated, pfx, sfx, outputClasses ?? new Set(), options);
          if (!namingWrites.length) {
            return rejectPlan("No output node in graph");
          }
        }
      } catch (error) { return rejectPlan(error.message); }

      try { validateFinalGraph(mutated, fullInspection, r); }
      catch (e) {
        return rejectPlan(e.message);
      }

      const surviving = survivingAxes(mutated, writes, fullInspection, namingProofs);
      // Only writer-owned targets certify naming. outputName guarantees whole
      // affixes by construction; retained dependency outputs are not targets.
      const naming = namingWrites.length ? ["prefix", "suffix"] : [];
      const missing = Object.keys(perm).filter(id => !surviving.includes(id));
      if (missing.length) return rejectPlan(`Operation ${missing.join(", ")} was pruned or overwritten in the final graph; no jobs were submitted`);
      const appliedPlan = {
        ranges: surviving.filter(id => resolvedRanges[id]?.enabled && !imageParams?.[id]?.enabled),
        imageParams: surviving.filter(id => imageParams?.[id]?.enabled && !resolvedRanges[id]?.enabled),
      };
      const selections = Object.fromEntries(["ranges", "imageParams"].map(channel => [channel,
        [...appliedPlan[channel], ...axes.excluded[channel].filter(id => !Object.hasOwn(perm, id))]]));
      prepared.push({ index, perm, mutated, applied: appliedPlan, selections, naming });
    }
    // All final prompts and their exact write coverage are prepared before the
    // first irreversible enqueue. A failure in a later tuple cannot leak jobs.
    for (const { index, perm, mutated, applied, selections, naming } of prepared) {
      if (!app.backings.isCurrent(token)) {
        retired = true; errors.push({ permutation: perm, error: "source changed; remaining jobs were not submitted" }); break;
      }
      const res = await backing.enqueue({
        prompt: mutated,
        extra_data: { extra_pnginfo: lineageTag(`${host}:${filename}`, perm) },
      });
      if (!res.ok) {
        console.error(`[variations] permutation failed ${stringifyExactJson(perm)} -> ${res.error}`);
        errors.push({ permutation: perm, error: res.error });
      } else {
        submitted++;
        if (!app.backings.isCurrent(token)) { retired = true; errors.push({ permutation: perm, error: "source changed after submission; configuration was not acknowledged" }); }
        else if (res.acceptance !== "confirmed") { uncertain ||= res.acceptance !== "partial"; errors.push({ permutation: perm, error: res.error ?? "submission acceptance is unconfirmed; do not automatically resubmit" }); }
        else {
          accepted.push({ index, promptId: res.promptId, applied, selections, naming });
        }
      }
    }

    if (errors.length) console.error(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}, ${errors.length} failed`);
    else console.log(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}`);
    return exactResponse({ submitted, total: permutations.length, errors, operations: effectivePlan.operations,
      outcome: retired ? "retired" : uncertain ? "uncertain-effects" : errors.length ? submitted ? "partial-effects" : "rejected" : "accepted-plan",
      acknowledgement: { ...acknowledgement, target: { id, host, filename }, context: r.context, accepted },
    });
  });
}
