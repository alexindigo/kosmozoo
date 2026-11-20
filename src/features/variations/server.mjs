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
  composeOutputName, variationOutputName, reproducesOriginal, MAX_JOBS_PER_IMAGE,
} from "./shared.mjs";
import { validEntryName, backingFor as defaultBackingFor } from "../../backings/index.mjs";
import { sourceOrigin, sameOrigin, validOrigin, validContext, expectedOrigin } from "../../source-origin.mjs";
import { dependencyClosure } from "../../graph.mjs";
import { sha256 } from "../../cache.mjs";
import { IMAGE_EXTENSIONS, mediaExtension } from "../../backings/mime.mjs";
import { listImages, readImage, folderError } from "./folder-images.mjs";
import { inspectImage } from "./image-inspection.mjs";
import { readJson, mediaHeaders } from "../../routes.mjs";
import { isResourceRoot, cloneJsonValue, sameJsonValue, parseExactJson, stringifyExactJson, paramId } from "../../parameters.mjs";
import { compileValue, compileDiscreteAxes, validateFinalGraph } from "./compile.mjs";
import { parameterCatalogue, findProducingOutputNode, outputNodeIndex, outputNamingTargets,
  outputPath, stripExtension, inspectSource, projectInspection } from "./inspection.mjs";
import { registerHistory, historyResponse } from "./history-routes.mjs";
import { registerPexels } from "./pexels.mjs";
import { inspectDestination } from "./destination.mjs";
import { submitPrompt } from "../../backings/comfy-submission.mjs";
import { problemRoutes } from "./problem-transport.mjs";
import { variationProblem, problemFrom, problemError, backendProblem, effectCounts } from "./problems.mjs";
export { parameterCatalogue, findProducingOutputNode, outputNodeIndex, outputNamingTargets } from "./inspection.mjs";

const exactResponse = (value, init = {}) => new Response(stringifyExactJson(value), {
  ...init, headers: { "Content-Type": "application/json", ...init.headers },
});

// hard cap on permutations per run — a sweep is a human-scale batch, not a
// fork bomb (F7). Above the cap the run answers 413.

// --- graph inspection (ComfyUI conventions) -----------------------------------

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
        if (selections.has(key) && !branch) throw problemError(variationProblem("dynamic-option", { phase: "mutation", parameter: { id: paramId(nodeId, key) }, node: nodeId, value }));
        if (!branch) continue;
        if (!Object.is(inputs[key], value)) {
          for (const child of Object.keys(inputs)) if (child.startsWith(key + ".")) delete inputs[child];
          for (const [child, value] of branch.defaults) {
            if (value === undefined) throw problemError(variationProblem("dynamic-default", { phase: "mutation", parameter: { id: paramId(nodeId, key) }, child: `${nodeId}.${child.slice(type.length + 1)}`, value: selections.get(key) }));
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

function writeOutputNames(graph, targets, pfx, sfx, { values = {}, proofs = [] } = {}) {
  const written = [];
  for (const target of targets) {
    const node = graph[target.nodeId];
    if (!node?.inputs) throw problemError(variationProblem("producer-missing", { phase: "naming", node: target.nodeId }));
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

// app: { store, cache, hosts, ingest, comfy, backings, paths } — the engine surface
// for features.
export function register(app) {
  app = problemRoutes(app);
  const backingFor = app.backings?.backingFor ?? defaultBackingFor;
  const history = registerHistory(app);
  app.route("POST", "/plan", async req => {
    try { return exactResponse(await history.plan(await readJson(req, { parse: parseExactJson }))); }
    catch (error) { return exactResponse({ error: error.message, ...(error.problem ? { problem: error.problem } : {}) }, { status: error.status ?? 400 }); }
  });
  registerPexels(app);
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
      if (!/^[a-f0-9]{64}$/.test(body.hash)) return Response.json({ error: "Inspected image hash required", problem: variationProblem("image-changed", { phase: "upload", resource: body.path }) }, { status: 400 });
      const file = await readImage(body.path);
      if (await sha256(file.bytes) !== body.hash) return Response.json({ error: "Image changed since it was added. Remove and add it again.", problem: variationProblem("image-changed", { phase: "upload", resource: body.path }) }, { status: 409 });
      if (!app.backings.isCurrent(token)) return Response.json({ error: "Source origin changed before upload", problem: variationProblem("upload-retired", { phase: "upload", destination: host, resource: body.path, stage: "before" }) }, { status: 412 });
      const backing = backingFor(token.address);
      if (!backing.write) return Response.json({ error: "This source cannot upload images" }, { status: 400 });
      const receipt = await backing.write(token.address, file.name, file.bytes);
      if (!receipt.ok) return Response.json({ error: receipt.error, problem: backendProblem(receipt, { phase: "upload", destination: host, resource: file.name }) }, { status: receipt.status });
      if (!app.backings.isCurrent(token)) return Response.json({ error: "Source changed after upload; no follow-up was authorized", uploaded: { name: receipt.name, origin }, problem: variationProblem("upload-retired", { phase: "upload", destination: host, resource: file.name, stage: "after", uploaded: { name: receipt.name, origin } }) }, { status: 412 });
      return Response.json({ name: receipt.name, origin });
    } catch (error) { return folderError(error); }
  });
  // Readonly comparison through the existing byte/hash owner. This deliberately
  // does not upload to ComfyUI or create another input cache.
  app.route("POST", "/inspect-image/<host>", async (req, { host }) => {
    const invalid = (error, field, resource) => Response.json({ error, problem: variationProblem("comparison-request", { phase: "comparison", source: host, field, resource }) }, { status: 400 });
    let origin;
    try { origin = expectedOrigin(req); } catch (error) { return invalid(error.message, "source origin"); }
    const token = app.backings.capture(host);
    if (!origin || !token || !sameOrigin(origin, sourceOrigin(host, app.backings.source(host))) || !app.backings.accepting()) return Response.json({ error: "Source origin changed" }, { status: 412 });
    let form;
    try { form = await req.formData(); } catch { return invalid("Multipart image required", "multipart image body"); }
    const file = form.get("image"), current = form.get("current"), kind = form.get("kind");
    if (!(file instanceof File) || !IMAGE_EXTENSIONS.has(mediaExtension(file.name)) || !validEntryName(token.address, current) || !isResourceRoot(kind)) return invalid("Image and current input required", "image file, current reference or resource root", file?.name);
    let names;
    try { names = JSON.parse(form.get("names") ?? "[]"); } catch { return invalid("Input names must be an array", "input name list", file.name); }
    return inspectImage(app, token, host, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), current, kind, names }, origin);
  });
  const inspect = (collection, name, expected = null) => inspectSource(app, collection, name, expected);

  app.route("GET", "/probe/<id>", async (_req, { id }) => {
    const i = id.indexOf(":");
    if (i < 0) return Response.json({ error: "id must be collection:name", problem: variationProblem("inspection-request", { phase: "inspection", field: "image address (expected collection:name)" }) }, { status: 400 });
    const collection = id.slice(0, i), name = id.slice(i + 1);
    let expected = null;
    const raw = new URL(_req.url).searchParams.get("origin");
    if (raw !== null) {
      try { expected = { origin: JSON.parse(raw) }; } catch { return Response.json({ error: "Invalid expected origin", problem: variationProblem("inspection-request", { field: "source origin" }) }, { status: 400 }); }
      if (!validOrigin(expected.origin)) return Response.json({ error: "Invalid expected origin", problem: variationProblem("inspection-request", { field: "source origin" }) }, { status: 400 });
    }
    let destination = null;
    const rawDestination = new URL(_req.url).searchParams.get("destination");
    if (rawDestination !== null) {
      try { destination = JSON.parse(rawDestination); } catch { return Response.json({ error: "Invalid Run destination", problem: variationProblem("inspection-request", { field: "Run destination" }) }, { status: 400 }); }
      if (!validOrigin(destination)) return Response.json({ error: "Invalid Run destination", problem: variationProblem("inspection-request", { field: "Run destination" }) }, { status: 400 });
    }
    const r = await inspect(collection, name, expected);
    if (r.error) return Response.json(r, { status: r.status });
    if (!destination) return exactResponse(projectInspection(r, name));
    const d = await inspectDestination(app, { graph: r.graph, hash: r.context.graphHash, name, original: projectInspection(r, name), originContext: r.context, destination });
    if (d.error) return Response.json(d, { status: d.status });
    return exactResponse(d);
  });

  app.route("POST", "/run", async (req) => {
    const invalidRequest = detail => Response.json({ error: detail, problem: variationProblem("run-request", { phase: "submission", detail }) }, { status: 400 });
    let body;
    try { body = await readJson(req, { parse: parseExactJson }); }
    catch { return invalidRequest("JSON body required"); }

    if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest("JSON object required");
    const { id, host, filename, ranges, relative, imageParams, acknowledgement, context } = body;
    if (!id || !host || !filename || !ranges) {
      return invalidRequest(`missing required fields: ${["id", "host", "filename", "ranges"].filter(key => !body[key]).join(", ")}`);
    }
    const sameHost = reproducesOriginal(host, context?.origin?.source);
    // Saved-plan requests execute on their engine-bound destination; direct
    // requests stay bound to the target's own source.
    if (!validContext(context) || !body.history && context.origin.source !== host) {
      return Response.json({ error: "Version2 requires the captured source/graph context", problem: variationProblem("plan-binding", { phase: "submission", detail: "Version2 requires the captured source/graph context" }) }, { status: 400 });
    }
    if (!validRunAcknowledgement(acknowledgement) || id !== `${host}:${filename}` ||
        Object.keys(ranges).some(key => ranges[key]?.enabled && imageParams?.[key]?.enabled)) {
      return Response.json({ error: "invalid or ambiguous submission acknowledgement request", problem: variationProblem("plan-binding", { phase: "submission", detail: "invalid or ambiguous submission acknowledgement request" }) }, { status: 400 });
    }

    const execute = async (r, journal = null) => {
    if (r.error) return Response.json(r, { status: r.status });
    const { graph, outputClasses, token, backing } = r;
    if (!outputClasses) return Response.json({ error: `ComfyUI node information is unavailable: ${r.schemaError ?? "could not identify output nodes"}; no jobs were submitted`, problem: variationProblem(r.schemaIssue?.code ?? "declarations-unavailable", { phase: "destination", target: { name: filename, source: host }, destination: context.origin.source, detail: r.schemaError, ...r.schemaIssue }) }, { status: 502 });

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
      const count = permutationPlan(resolvedRanges, currentValues, selectedValues, { sameHost }).total;
      if (count > MAX_JOBS_PER_IMAGE) return Response.json({ error: `too many permutations (${count} > ${MAX_JOBS_PER_IMAGE})`, problem: variationProblem("too-many", { phase: "plan", numbers: { count } }) }, { status: 413 });
      permutations = generatePermutations(resolvedRanges, currentValues, selectedValues, { sameHost });
    } catch (e) {
      return Response.json({ error: e.message, problem: problemFrom(e, { phase: "plan", target: { name: filename, source: host } }) }, { status: 400 });
    }
    if (permutations.length === 0) {
      return Response.json({ error: "no permutations to submit (enable an axis or move it off the current values)", problem: variationProblem("run-no-work", { phase: "plan", names: [...axes.enabled, ...axes.imgEnabled].map(([id]) => fullInspection.find(parameter => parameter.id === id)?.label ?? id) }) }, { status: 400 });
    }
    if (permutations.length > MAX_JOBS_PER_IMAGE) {
      return Response.json({ error: `too many permutations (${permutations.length} > ${MAX_JOBS_PER_IMAGE})`, problem: variationProblem("too-many", { phase: "plan", numbers: { count: permutations.length } }) }, { status: 413 });
    }
    console.log(`[variations] run ${host}:${filename} — ${permutations.length} permutations over ${axes.imgEnabled.length} enum/text axes`);

    // Output nodes by object_info's output_node flag, indexed once per run.
    const producing = outputClasses?.size
      ? findProducingOutputNode(graph, filename, outputClasses)
      : null;
    if (filename.includes("/") && !producing) {
      const directory = outputPath(filename).directory;
      return Response.json({ error: "Cannot identify an unambiguous producing output directory for this image", problem: variationProblem("producer-ambiguous", { phase: "naming", target: { name: filename, source: host }, directory, numbers: { outputs: outputNodeIndex(graph, outputClasses).filter(id => outputPath(graph[id].inputs?.filename_prefix ?? "").directory === directory).length } }) }, { status: 400 });
    }

    const namingTargets = outputNamingTargets(graph, filename, producing?.id, outputClasses ?? new Set());
    const firstNamingTarget = namingTargets.find(target => target.nodeId === producing?.id) ?? namingTargets[0];
    const namingRequest = { ...body, ranges: resolvedRanges, imageParams: selectedValues };
    const originalBasename = stripExtension(outputPath(filename).leaf);

    const errors = [];
    const accepted = [];
    let submitted = 0, uncertain = false, retired = false;
    const prepared = [];
    const rejectPlan = error => {
      const problem = problemFrom(error, { phase: "preflight", target: { id, name: filename, source: host }, destination: context.origin.source, numbers: { planned: permutations.length }, effects: { sent: 0, confirmed: 0, partial: 0, unknown: 0, unsent: permutations.length } });
      const message = typeof error === "string" ? error : error.message ?? problem.message;
      return exactResponse({ error: message, problem, outcome: "rejected", submitted: 0, total: permutations.length,
        errors: permutations.map(permutation => ({ permutation, error: `Plan rejected: ${message}`, problem })),
        acknowledgement: { ...acknowledgement, target: { id, host, filename }, context: r.context, accepted: [] } }, { status: 400 });
    };
    for (const [index, perm] of permutations.entries()) {
      if (!app.backings.isCurrent(token)) {
        return rejectPlan(problemError(variationProblem("dispatch-retired", { phase: "preflight", destination: context.origin.source, stage: "before", effects: { sent: 0, confirmed: 0, partial: 0, unknown: 0, unsent: permutations.length } })));
      }
      let mutation;
      try { mutation = mutateGraph(graph, perm, fullInspection, r.dynamicCombos, { rangeIds: new Set(Object.keys(resolvedRanges)) }); }
      catch (error) { return rejectPlan(error); }
      const { graph: mutated, applied, writes } = mutation;
      // Only the kernel's empty identity tuple on another destination needs no
      // graph-axis writes. Naming/final graph/off-selection proofs still follow.
      if (applied.length === 0 && (sameHost || Object.keys(perm).length > 0)) {
        return rejectPlan(problemError(variationProblem("mutation-empty", { phase: "mutation", names: Object.keys(perm), numbers: { planned: permutations.length } })));
      }

      let namingWrites;
      const namingProofs = [];
      try {
        if (!firstNamingTarget) return rejectPlan(problemError(variationProblem("output-missing", { phase: "naming", destination: context.origin.source })));
        // Validate every explicit output prefix, including retained dependencies,
        // without giving those dependencies new sidebar-affix writes.
        for (const target of namingTargets) if (Object.hasOwn(perm, target.parameterId)) {
          composeOutputName(target, perm, "", "", { preliminary: !producing || target.nodeId === producing.id });
        }
        const naming = variationOutputName(firstNamingTarget, namingRequest, perm, currentValues, labelMap, fullInspection, { sameHost });
        if (!naming.complete) return rejectPlan(problemError(naming.problems[0]));
        const { prefix: pfx, suffix: sfx } = naming;
        const options = { targets: namingTargets, values: perm, proofs: namingProofs };
        if (producing) {
          namingWrites = narrowToOneOutputNode(mutated, producing.id, originalBasename, pfx, sfx, outputClasses, options).written;
        } else {
          namingWrites = wrapAllOutputPrefixes(mutated, pfx, sfx, outputClasses ?? new Set(), options);
          if (!namingWrites.length) {
            return rejectPlan(problemError(variationProblem("output-missing", { phase: "naming", destination: context.origin.source })));
          }
        }
      } catch (error) { return rejectPlan(error); }

      try { validateFinalGraph(mutated, fullInspection, r); }
      catch (e) {
        return rejectPlan(e);
      }

      const surviving = survivingAxes(mutated, writes, fullInspection, namingProofs);
      // Only writer-owned targets certify naming. outputName guarantees whole
      // affixes by construction; retained dependency outputs are not targets.
      const naming = namingWrites.length ? ["prefix", "suffix"] : [];
      const missing = Object.keys(perm).filter(id => !surviving.includes(id));
      if (missing.length) return rejectPlan(problemError(variationProblem("mutation-lost", { phase: "mutation", names: missing, numbers: { planned: permutations.length } })));
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
    const responses = [];
    for (const { index, perm, mutated, applied, selections, naming } of prepared) {
      if (!app.backings.isCurrent(token)) {
        retired = true; errors.push({ permutation: perm, error: "source changed; remaining jobs were not submitted", problem: variationProblem("dispatch-retired", { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source, stage: "during" }) }); break;
      }
      const job = {
        prompt: mutated,
        extra_data: { extra_pnginfo: lineageTag(`${host}:${filename}`, perm) },
      };
      const request = journal ? journal.submit(job, index) : submitPrompt(backing, job, { isCurrent: () => app.backings.isCurrent(token) });
      responses.push(request.result.then(res => ({ res, index, perm, applied, selections, naming }), error => ({ error, index, perm })));
      await request.sent;
    }
    const results = await Promise.all(responses);
    // Drain every admitted request before propagating an internal journal error.
    // A failed durable write must never become an ordinary upstream rejection.
    const failure = results.find(result => result.error);
    const counts = effectCounts(results.map(({ res, error }) => ({ state: error ? "unknown" : res.acceptance === "confirmed" ? "confirmed" : res.acceptance === "partial" ? "partial" : res.acceptance === "uncertain" || res.failure?.kind === "transport" || res.status >= 500 ? "unknown" : "rejected", sent: res?.sent === true })), permutations.length);
    if (results.some(({ res }) => res?.sent === undefined)) counts.sent = null;
    if (failure) {
      counts.sent = null;
      counts.unsent = permutations.length - results.length;
      const problem = variationProblem("dispatch-tracking", { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source, detail: failure.error.message, effects: counts });
      return exactResponse({ error: problem.message, problem, effectCounts: counts, submitted: counts.confirmed, total: permutations.length, outcome: "uncertain-effects", errors: [{ error: problem.message, problem }] }, { status: 500 });
    }
    for (const { res, index, perm, applied, selections, naming } of results) {
      if (!res.ok) {
        console.error(`[variations] permutation failed ${stringifyExactJson(perm)} -> ${res.error}`);
        errors.push({ index, permutation: perm, error: res.error, problem: backendProblem(res, { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source, numbers: { index: index + 1, total: permutations.length }, effects: counts }) });
      } else {
        submitted++;
        if (!app.backings.isCurrent(token)) { retired = true; errors.push({ index, permutation: perm, error: "source changed after submission; configuration was not acknowledged", problem: variationProblem("dispatch-retired", { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source, stage: "after", numbers: { index: index + 1, total: permutations.length }, effects: counts }) }); }
        else if (res.acceptance !== "confirmed") { uncertain ||= res.acceptance !== "partial"; errors.push({ index, permutation: perm, error: res.error ?? "submission acceptance is unconfirmed; do not automatically resubmit", problem: backendProblem(res, { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source, numbers: { index: index + 1, total: permutations.length }, effects: counts }) }); }
        else {
          accepted.push({ index, promptId: res.promptId, applied, selections, naming });
        }
      }
    }

    if (errors.length) console.error(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}, ${errors.length} failed`);
    else console.log(`[variations] ${host}:${filename} → submitted ${submitted}/${permutations.length}`);
    return exactResponse({ submitted, total: permutations.length, errors, effectCounts: counts, operations: effectivePlan.operations,
      outcome: retired ? "retired" : uncertain ? "uncertain-effects" : errors.length ? submitted ? "partial-effects" : "rejected" : "accepted-plan",
      acknowledgement: { ...acknowledgement, target: { id, host, filename }, context: r.context, accepted },
    });
    };
    if (body.history) {
      try {
        const result = await history.dispatch(body, execute);
        return historyResponse(result.data, result.status);
      } catch (error) { return historyResponse({ error: error.message, problem: problemFrom(error, { phase: "submission", target: { name: filename, source: host }, destination: context.origin.source }) }, error.status ?? 500); }
    }
    return execute(await inspect(host, filename, context));
  });
}
