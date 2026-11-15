// The Run destination is a ComfyUI source chosen independently of where the
// target image came from. Its own object_info is the authority for what can run
// there; the workflow and images come from the target (or its saved archive).
import { sameOrigin, validOrigin } from "../../source-origin.mjs";
import { parameterContract, parameterCurrent, sameJsonValue } from "../../parameters.mjs";
import { inspectSource, projectInspection } from "./inspection.mjs";

const CHANNELS = ["params", "stringParams", "enumParams", "textParams", "parameters"];
const text = value => typeof value === "string" ? value : JSON.stringify(value);

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

// Up to `limit` destination choices that read most like the missing value.
// Folders and extensions are noise for model files; weak matches are omitted.
export function closestChoices(current, values, limit = 3) {
  const key = value => text(value).toLowerCase().split(/[\\/]/).at(-1).replace(/\.[a-z0-9]{2,12}$/, "").slice(0, 160);
  const wanted = key(current);
  if (!wanted) return [];
  return values.map(value => {
    const candidate = key(value);
    return { value, score: 1 - distance(wanted, candidate) / Math.max(wanted.length, candidate.length, 1) };
  }).filter(entry => entry.score >= 0.4).sort((a, b) => b.score - a.score || text(a.value).localeCompare(text(b.value)))
    .slice(0, limit).map(entry => entry.value);
}

// Conflicts are evidence-based: a class the host does not list, or a value
// outside a closed list the host declares. Unknown/custom inputs stay unflagged.
export function destinationConflicts(parameters, graph, missing) {
  const absent = new Set(missing ?? []), conflicts = {};
  for (const parameter of parameters) {
    const types = parameter.nodeIds.map(nodeId => String(graph[nodeId]?.class_type ?? ""));
    const node = types.find(type => absent.has(type));
    if (node) { conflicts[parameter.id] = { kind: "node", type: node }; continue; }
    if (parameter.valueKind === "connection") continue;
    const choices = parameterContract(parameter).choices;
    if (choices?.evidence !== "closed" || !choices.values.length) continue;
    const current = parameterCurrent(parameter);
    if (choices.values.some(value => sameJsonValue(value, current))) continue;
    conflicts[parameter.id] = { kind: "value", current, choices: choices.values, suggestions: closestChoices(current, choices.values) };
  }
  return conflicts;
}

// Classes the destination lacks that the image's own source has. When the
// source cannot be inspected, everything the destination lacks counts.
export async function destinationMissing(app, { graph, hash, name, originContext, inspected }) {
  const missing = inspected.missing ?? [];
  if (!missing.length || !originContext) return missing;
  const origin = await inspectSource(app, originContext.origin.source, name, originContext, { graph, hash });
  return origin.error || !origin.installed ? missing : missing.filter(type => origin.installed.has(type));
}

// Catalogue of the target's workflow as the destination sees it. Nodes the
// destination lacks keep the original descriptors, so editing stays stable and
// the conflict (not a guessed domain) is what blocks the Run.
export async function inspectDestination(app, { graph, hash, name, original, originContext, destination }) {
  const local = !destination || originContext && sameOrigin(destination, originContext.origin);
  let inspected;
  if (local) {
    if (!originContext) return { error: "The original source is unavailable; choose where to run", status: 409 };
    inspected = await inspectSource(app, originContext.origin.source, name, originContext, { graph, hash });
  } else {
    if (!validOrigin(destination) || destination.kind !== "comfy") return { error: "Run on requires a ComfyUI source", status: 400 };
    inspected = await inspectSource(app, destination.source, name, { origin: destination }, { graph, hash });
  }
  if (inspected.error) return inspected;
  if (!inspected.outputClasses) return { error: `${inspected.context.origin.source}: node information unavailable: ${inspected.schemaError ?? "unknown error"}`, status: 502 };
  // On the image's own source the workflow already ran: behaviour is unchanged.
  // Conflicts describe moving the workflow to a different host.
  const catalogue = projectInspection(inspected, name);
  const missing = local ? [] : await destinationMissing(app, { graph, hash, name, originContext, inspected });
  if (missing.length && original) {
    const absent = new Set(missing), keep = parameter => parameter.nodeIds.some(nodeId => absent.has(String(graph[nodeId]?.class_type ?? "")));
    for (const channel of CHANNELS) {
      const before = new Map((original[channel] ?? []).map(parameter => [parameter.id, parameter]));
      catalogue[channel] = catalogue[channel].map(parameter => keep(parameter) && before.has(parameter.id) ? before.get(parameter.id) : parameter);
    }
    const nodes = new Map((original.nodes ?? []).map(node => [node.id, node]));
    catalogue.nodes = catalogue.nodes.map(node => absent.has(node.type) && nodes.has(node.id) ? nodes.get(node.id) : node);
    catalogue.outputNaming ??= original.outputNaming ?? null;
    if (!catalogue.outputNamingTargets?.length) catalogue.outputNamingTargets = original.outputNamingTargets ?? [];
  }
  return { ...catalogue, context: originContext ?? null,
    destination: { origin: inspected.context.origin, missing, conflicts: local ? {} : destinationConflicts(catalogue.parameters, graph, missing) } };
}
