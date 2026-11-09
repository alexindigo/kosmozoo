// Keep the existing Kosmozoo edge predicate shared by catalogue, pruning and
// telemetry. Upstream is_link differs (string IDs, arbitrary numeric slots).
// This is encoding provenance, not validation or permission to submit a value.
export const isGraphLink = value => Array.isArray(value) && value.length === 2 &&
  (typeof value[0] === "string" || Number.isSafeInteger(value[0])) &&
  Number.isInteger(value[1]) && value[1] >= 0;

export function inputEncoding(value) {
  if (isGraphLink(value)) return "kosmozoo-link";
  // Raw arrays are not proven literals. In particular a malformed/differently
  // encoded link must never become a literal fallback to bypass validation.
  if (Array.isArray(value)) return "unresolved-array";
  if (value !== null && typeof value === "object" && Object.hasOwn(value, "__value__")) {
    if (Object.hasOwn(value, "__type__") && value.__type__ === "CURVE") return "comfy-curve-wrapper";
    if (Array.isArray(value.__value__)) return "comfy-array-wrapper";
  }
  return "json";
}

// ComfyUI links are input values, not arbitrary arrays in widget/metadata data.
export function linkInputs(node) {
  return Object.entries(node?.inputs ?? {}).filter(([, value]) => isGraphLink(value));
}

// One traversal for pruning and telemetry. The edge predicate lets telemetry
// infer completed strong ancestors without treating lazy inputs as evaluated.
export function dependencyClosure(graph, roots, accept = () => true) {
  const kept = new Set(), pending = (Array.isArray(roots) ? roots : [roots]).map(String);
  while (pending.length) {
    const id = pending.pop();
    if (kept.has(id)) continue;
    kept.add(id);
    for (const [key, link] of linkInputs(graph[id])) {
      if (accept(graph[id], key)) pending.push(String(link[0]));
    }
  }
  return kept;
}

// These wrappers are the stock frontend's array/curve serialization contract.
// Nested values are data, never edges. Do not infer wrappers from other objects.
export function assignmentValue(parameter, value) {
  if (parameter.valueKind === "connection") {
    if (!isGraphLink(value)) throw new Error(`${parameter.id}: choose an existing node and nonnegative output slot`);
    return value;
  }
  return Array.isArray(value) ? { __value__: value } : value;
}

export function inputDeclaration(node, key, schema = {}) {
  const type = String(node?.class_type ?? ""), name = `${type}.${key}`;
  let declaration = schema.declarations?.get(name);
  const select = combos => {
    for (const [name, branches] of combos ?? []) {
      if (!name.startsWith(type + ".")) continue;
      const branch = branches.get(node.inputs?.[name.slice(type.length + 1)]);
      if (!branch) continue;
      if (branch.declarations?.has(`${type}.${key}`)) declaration = branch.declarations.get(`${type}.${key}`);
      select(branch.dynamicCombos);
    }
  };
  select(schema.dynamicCombos);
  return declaration;
}

function compatibleTypes(source, destination) {
  if (typeof source !== "string" || typeof destination !== "string") return null;
  const a = source.split(",").map(s => s.trim()), b = destination.split(",").map(s => s.trim());
  // MATCH/custom Python comparators are not reconstructible from object_info.
  if (a.includes("*") || b.includes("*") || a.includes("MATCH") || b.includes("MATCH")) return null;
  if (a.some(type => b.includes(type))) return true;
  const stock = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "IMAGE", "MASK", "LATENT", "MODEL", "CLIP", "VAE", "CONDITIONING", "SIGMAS", "SAMPLER"]);
  if (![...a, ...b].every(type => stock.has(type))) return null;
  return a.some(type => b.includes(type));
}

export function validateGraphLinks(graph, schema = {}) {
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, link] of linkInputs(node)) {
      if (!Object.hasOwn(graph, link[0])) throw new Error(`Dangling ComfyUI link: ${id}.${key} references missing node ${link[0]}`);
      const ports = schema.outputs?.get(String(graph[link[0]].class_type ?? ""));
      if (ports && link[1] >= ports.length) throw new Error(`Invalid output slot: ${id}.${key} references ${link[0]} slot ${link[1]}`);
      const declaration = inputDeclaration(node, key, schema);
      if (ports && declaration && compatibleTypes(ports[link[1]]?.type, declaration.type) === false) {
        throw new Error(`Incompatible link type: ${id}.${key} expects ${declaration.type}, received ${ports[link[1]].type}`);
      }
    }
  }
  // Diagnose malformed numeric-slot pairs after all recognized references. Other
  // recorded custom arrays retain unknown encoding/backend validation; this does
  // not reclassify them as proven literals or change the retained edge predicate.
  for (const [id, node] of Object.entries(graph)) for (const [key, value] of Object.entries(node?.inputs ?? {})) {
    if (Array.isArray(value) && value.length === 2 && (typeof value[0] === "string" || Number.isSafeInteger(value[0])) &&
        typeof value[1] === "number" && !isGraphLink(value)) {
      throw new Error(`Unresolved ComfyUI array: ${id}.${key}; invalid numeric output slot`);
    }
  }
}
