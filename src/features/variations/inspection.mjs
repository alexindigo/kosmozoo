// Engine-only graph inspection seam for current names and validated saved targets.
import { validEntryName } from "../../backings/index.mjs";
import { sourceOrigin, sameOrigin } from "../../source-origin.mjs";
import { graphParameters, editableParameter, stringifyExactJson } from "../../parameters.mjs";
import { parameterIndex, catalogueParams, paramId } from "./shared.mjs";
import { variationProblem } from "./problems.mjs";

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
export const stripExtension = name => { const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(0, dot) : name; };
export const outputPath = value => {
  const name = String(value), slash = name.lastIndexOf("/");
  return { directory: slash < 0 ? "" : name.slice(0, slash + 1), leaf: name.slice(slash + 1) };
};
export function findProducingOutputNode(graph, originalFilename, outputClasses) {
  const base = stripExtension(originalFilename), directory = outputPath(originalFilename).directory;
  let best = null, ambiguous = false;
  for (const [nid, n] of Object.entries(graph)) {
    if (!outputClasses.has(String(n.class_type ?? ""))) continue;
    const pfx = n.inputs?.filename_prefix;
    if (typeof pfx !== "string" || !pfx || outputPath(pfx).directory !== directory) continue;
    if (base === pfx || base.startsWith(pfx + "_")) {
      if (!best || pfx.length > best.prefix.length) { best = { id: nid, node: n, prefix: pfx }; ambiguous = false; }
      else if (directory && pfx.length === best.prefix.length) ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}
export function outputNodeIndex(graph, outputClasses) {
  return Object.entries(graph).filter(([, n]) => outputClasses.has(String(n.class_type ?? ""))).map(([id]) => id);
}
export function outputNamingTargets(graph, filename, producingId, outputClasses) {
  return outputNodeIndex(graph, outputClasses).map(nodeId => {
    const path = outputPath(graph[nodeId].inputs?.filename_prefix ?? "");
    return { nodeId, parameterId: paramId(nodeId, "filename_prefix"), directory: path.directory,
      sourceStem: nodeId === producingId ? stripExtension(outputPath(filename).leaf) : path.leaf,
      leafOnly: filename.includes("/") };
  });
}
export async function inspectSource(app, collection, name, expected = null, archived = null) {
  const failure = (code, error, status, context = {}) => ({ error, status, problem: variationProblem(code, { phase: "inspection", target: { source: collection, name }, source: collection, ...context }) });
  if (!app.backings.accepting()) return failure("source-stopping", "Sources are stopping; no new operation was admitted", 503);
  const token = app.backings.capture(collection), addr = token?.address;
  if (!addr) return failure("source-missing", "unknown collection", 404);
  const origin = sourceOrigin(collection, app.backings.source(collection));
  if (expected && !sameOrigin(expected.origin, origin)) return failure("catalogue-stale", "Source origin changed; work was kept", 412);
  const backing = app.backings.comfy(collection);
  if (!validEntryName(addr, name)) return failure("source-path", "bad entry path", 400);
  // `archived` is supplied only by the engine history membership resolver.
  const hash = archived?.hash ?? app.store.hashFor(collection, name);
  if (!hash) return failure("source-unindexed", "image not ingested (no hash)", 404);
  if (expected?.graphHash && expected.graphHash !== hash) return failure("workflow-changed", "Graph catalogue changed; work was kept", 412);
  const graph = archived?.graph ?? await app.ingest.graph(hash);
  if (!app.backings.isCurrent(token)) return failure("inspection-retired", "source changed during inspection", 409);
  if (!graph) return failure("workflow-missing", "no embedded ComfyUI graph", 422);
  try { stringifyExactJson(graph); }
  catch (error) { return failure("workflow-inexact", `Embedded graph cannot be represented exactly: ${error.message}`, 422, { detail: error.message }); }
  const { types, enums, outputClasses, dynamicCombos, declarations, outputs, installed, schemaError, schemaIssue, schemaWarnings } = await backing.objectInfo({ graph });
  if (!app.backings.isCurrent(token)) return failure("inspection-retired", "source changed during inspection", 409);
  // Known only with a successful catalogue; unavailable knowledge is never "missing".
  const missing = installed ? [...new Set(Object.values(graph).map(node => String(node?.class_type ?? "")))].filter(type => !installed.has(type)).sort() : null;
  return { graph, addr, types, enums, outputClasses, dynamicCombos, declarations, outputs, installed, missing, schemaError, schemaIssue, schemaWarnings, token, backing, context: { origin, graphHash: hash } };
}
export function projectInspection(r, name) {
  const producing = findProducingOutputNode(r.graph, name, r.outputClasses ?? new Set());
  const targets = outputNamingTargets(r.graph, name, producing?.id, r.outputClasses ?? new Set());
  const catalogue = parameterCatalogue(r.graph, r);
  const problems = (r.schemaWarnings ?? []).flatMap(warning => Object.entries(r.graph).filter(([, node]) => node.class_type === warning.type).map(([id]) => {
    const input = warning.input.slice(warning.type.length + 1), parameter = catalogue.parameters.find(parameter => parameter.nodeIds.includes(id) && (parameter.key === input || parameter.key.startsWith(input + ".")));
    return variationProblem("schema-incomplete", { severity: "warning", phase: "catalogue", target: { source: r.context.origin.source, name },
      parameter: { id: parameter?.id ?? paramId(id, input), label: `${warning.type}.${input}` }, detail: warning.detail });
  }));
  return { ...catalogue, problems, context: r.context,
    nodes: Object.entries(r.graph).map(([id, node]) => ({ id, type: String(node.class_type ?? ""), title: node._meta?.title ?? null,
      outputs: r.outputs?.get(String(node.class_type ?? "")) ?? null })),
    outputNaming: targets.find(target => target.nodeId === producing?.id) ?? targets[0] ?? null, outputNamingTargets: targets };
}
