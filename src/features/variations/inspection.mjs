// Engine-only graph inspection seam for current names and validated saved targets.
import { validEntryName } from "../../backings/index.mjs";
import { sourceOrigin, sameOrigin } from "../../source-origin.mjs";
import { graphParameters, editableParameter, stringifyExactJson } from "../../parameters.mjs";
import { parameterIndex, catalogueParams, paramId } from "./shared.mjs";

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
  if (!app.backings.accepting()) return { error: "Sources are stopping; no new operation was admitted", status: 503 };
  const token = app.backings.capture(collection), addr = token?.address;
  if (!addr) return { error: "unknown collection", status: 404 };
  const origin = sourceOrigin(collection, app.backings.source(collection));
  if (expected && !sameOrigin(expected.origin, origin)) return { error: "Source origin changed; work was kept", status: 412 };
  const backing = app.backings.comfy(collection);
  if (!validEntryName(addr, name)) return { error: "bad entry path", status: 400 };
  // `archived` is supplied only by the engine history membership resolver.
  const hash = archived?.hash ?? app.store.hashFor(collection, name);
  if (!hash) return { error: "image not ingested (no hash)", status: 404 };
  if (expected?.graphHash && expected.graphHash !== hash) return { error: "Graph catalogue changed; work was kept", status: 412 };
  const graph = archived?.graph ?? await app.ingest.graph(hash);
  if (!app.backings.isCurrent(token)) return { error: "source changed during inspection", status: 409 };
  if (!graph) return { error: "no embedded ComfyUI graph", status: 422 };
  try { stringifyExactJson(graph); }
  catch (error) { return { error: `Embedded graph cannot be represented exactly: ${error.message}`, status: 422 }; }
  const { types, enums, outputClasses, dynamicCombos, declarations, outputs, schemaError } = await backing.objectInfo({ graph });
  if (!app.backings.isCurrent(token)) return { error: "source changed during inspection", status: 409 };
  return { graph, addr, types, enums, outputClasses, dynamicCombos, declarations, outputs, schemaError, token, backing, context: { origin, graphHash: hash } };
}
export function projectInspection(r, name) {
  const producing = findProducingOutputNode(r.graph, name, r.outputClasses ?? new Set());
  const targets = outputNamingTargets(r.graph, name, producing?.id, r.outputClasses ?? new Set());
  return { ...parameterCatalogue(r.graph, r), context: r.context,
    nodes: Object.entries(r.graph).map(([id, node]) => ({ id, type: String(node.class_type ?? ""), title: node._meta?.title ?? null,
      outputs: r.outputs?.get(String(node.class_type ?? "")) ?? null })),
    outputNaming: targets.find(target => target.nodeId === producing?.id) ?? targets[0] ?? null, outputNamingTargets: targets };
}
