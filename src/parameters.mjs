// Complete recorded graph inputs and their names. Environment-pure; no IO or UI.
import { inputEncoding } from "./graph.mjs";

// Identity is graph-local, never a class/title. Dots are delimiters; nested
// Comfy node IDs retain their readable colon separators.
const paramPart = value => encodeURIComponent(String(value)).replace(/\./g, "%2E").replace(/%3A/g, ":");
export function paramId(nodeId, input) {
  if (!String(nodeId).length || !String(input).length) throw new Error("Empty parameter location");
  return `${paramPart(nodeId)}.${paramPart(input)}`;
}
export function parseParamId(id) {
  if (typeof id !== "string") return null;
  const parts = id.split(".");
  if (parts.length !== 2) return null;
  try {
    const [nodeId, input] = parts.map(decodeURIComponent);
    return nodeId && input && paramId(nodeId, input) === id ? { nodeId, input } : null;
  } catch { return null; }
}

// Presence matters: null/false/0/empty string are recorded values, not fallback.
export const parameterCurrent = parameter => Object.hasOwn(parameter, "currentValue") ? parameter.currentValue : parameter.current;

export function parameterIndex(params, graph = null) {
  const index = new Map();
  for (const p of params) {
    if (index.has(p.id)) throw new Error(`Duplicate variation parameter: ${p.id}`);
    const location = parseParamId(p.id);
    if (!location || p.key !== location.input || p.nodeIds?.length !== 1 || p.nodeIds[0] !== location.nodeId ||
        p.nodeId !== undefined && p.nodeId !== location.nodeId) throw new Error(`Invalid parameter location: ${p.id}`);
    if (graph && (!Object.hasOwn(graph, location.nodeId) || !Object.hasOwn(graph[location.nodeId]?.inputs ?? {}, location.input))) {
      throw new Error(`Unresolved parameter location: ${p.id}`);
    }
    index.set(p.id, p);
  }
  return index;
}

// Preserve the existing label spelling and first-carrier alias order.
export const parameterLabel = p => `${p.title ?? p.type} #${p.nodeIds[0]} \u00b7 ${p.key}`;
export function parameterAliases(params) {
  const aliases = {};
  let image = false;
  for (const p of parameterIndex(params).values()) {
    aliases[p.id] = [`${p.type}.${p.key}`, p.title ?? p.type];
    if (p.kind === "image" && !image) { aliases[p.id].push("image"); image = true; }
  }
  return aliases;
}

// JSON data only. No serialization, coercion, File copying or precision repair.
// Inspect descriptors so accessors cannot execute at this boundary.
function jsonContainer(value) {
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (!array && proto !== Object.prototype && proto !== null) throw new TypeError("Expected JSON data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Expected JSON data");
  const keys = Object.keys(descriptors).filter(key => !array || key !== "length");
  if (array && (keys.length !== value.length || keys.some((key, i) => key !== String(i)))) throw new TypeError("Expected dense JSON array");
  for (const key of keys) {
    const d = descriptors[key];
    if (!d.enumerable || !Object.hasOwn(d, "value")) throw new TypeError("Expected JSON data properties");
  }
  return { array, entries: keys.map(key => [key, descriptors[key].value]) };
}

export function cloneJsonValue(value) {
  const ancestors = new Set();
  const clone = value => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new TypeError("Expected JSON data");
    if (ancestors.has(value)) throw new TypeError("Cyclic JSON data");
    const { array, entries } = jsonContainer(value);
    ancestors.add(value);
    const result = array ? entries.map(([, v]) => clone(v)) : Object.fromEntries(entries.map(([k, v]) => [k, clone(v)]));
    ancestors.delete(value);
    return result;
  };
  return clone(value);
}

export function sameJsonValue(left, right) {
  // Validate even equal references: native Files/other non-JSON are not admitted.
  const a = cloneJsonValue(left), b = cloneJsonValue(right);
  const same = (a, b) => {
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]));
  };
  return same(a, b);
}

const IMG_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
const ANNOTATION = /^(.*)\s+\[([^\]]*)\]$/;

// Compatibility editor projection is deliberately narrower than discovery.
function legacyEditor(type, key, value, declared, options, outputClasses) {
  if (!type) return null;
  if (typeof value === "number") return { kind: "numeric", integer: declared ? declared === "INT" : Number.isInteger(value) };
  if (typeof value !== "string" || key === "filename_prefix" && outputClasses?.has(type)) return null;
  if (/loadimage$/i.test(type) && key === "image") {
    const match = ANNOTATION.exec(value), file = match ? match[1] : value;
    return IMG_FILE.test(file) ? { kind: "image", current: file, currentValue: value, fromOutput: match ? /^output$/i.test(match[2]) : false } : null;
  }
  return options?.length ? { kind: "enum", values: [...options] } : { kind: "text" };
}

export function graphParameters(graph, { types = null, enums = null, outputClasses = null, dynamicCombos = null } = {}) {
  const parameters = [];
  for (const [nodeId, node] of Object.entries(graph ?? {})) {
    const type = String(node?.class_type ?? "");
    const title = node?._meta?.title && node._meta.title !== type ? String(node._meta.title) : null;
    const nodeTypes = new Map(types), nodeEnums = new Map(enums);
    const selectBranches = combos => {
      for (const [name, options] of combos ?? []) {
        if (!name.startsWith(type + ".")) continue;
        const key = name.slice(type.length + 1);
        if (!Object.hasOwn(node.inputs ?? {}, key)) continue;
        const branch = options.get(node.inputs[key]);
        if (!branch) continue;
        for (const [key, value] of branch.types) nodeTypes.set(key, value);
        for (const [key, value] of branch.enums) nodeEnums.set(key, value);
        selectBranches(branch.dynamicCombos);
      }
    };
    selectBranches(dynamicCombos);
    for (const [key, recorded] of Object.entries(node?.inputs ?? {})) {
      const currentValue = cloneJsonValue(recorded), encoding = inputEncoding(currentValue);
      const valueKind = encoding === "kosmozoo-link" ? "connection" : currentValue === null ? "null" : Array.isArray(currentValue) ? "array" : typeof currentValue;
      const schemaKey = `${type}.${key}`, declared = nodeTypes.get(schemaKey), options = nodeEnums.get(schemaKey);
      const editor = legacyEditor(type, key, currentValue, declared, options, outputClasses);
      parameters.push({ id: paramId(nodeId, key), nodeId, nodeIds: [nodeId], key, type, title,
        kind: editor?.kind ?? valueKind, current: currentValue, ...editor, currentValue,
        valueKind, encoding,
        // Existing numeric/enum maps are partial knowledge, never proof of a
        // complete input declaration, wrapper validity or output compatibility.
        schema: { status: declared || options?.length ? "partial" : "unavailable",
          ...(declared ? { numericType: declared } : {}), ...(options?.length ? { options: [...options] } : {}) },
        legacyEditable: editor !== null });
    }
  }
  parameterIndex(parameters, graph);
  return parameters;
}

export function editableParameter(parameter) {
  if (!parameter.legacyEditable) return null;
  const { valueKind, encoding, schema, legacyEditable, currentValue, ...editable } = parameter;
  if (editable.kind === "image") editable.currentValue = currentValue;
  return editable;
}
