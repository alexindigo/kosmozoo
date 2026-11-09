// Framework-free typed assignment boundary. Editor adapters and Run share data
// semantics; graph.mjs alone owns connection/wrapper interpretation.
import { cloneJsonValue, sameJsonValue, stringifyExactJson, parameterIndex } from "../../parameters.mjs";
import { assignmentValue, inputDeclaration, inputEncoding, isGraphLink, validateGraphLinks } from "../../graph.mjs";

export function compileValue(parameter, value) {
  const exact = cloneJsonValue(value);
  // Reject already rounded numbers before they can become proof or tokens.
  stringifyExactJson(exact);
  return cloneJsonValue(assignmentValue(parameter, exact));
}

export function compileDiscreteAxes(imageParams, parameters, nodes = null) {
  const index = parameterIndex(parameters);
  return Object.fromEntries(Object.entries(imageParams).map(([id, axis]) => {
    if (!axis.enabled) return [id, axis];
    const parameter = index.get(id);
    if (!parameter) throw new Error(`${id}: parameter is missing from this target`);
    const values = [];
    // Normalize the whole assignment first, then preserve its first occurrence.
    // The generic tuple kernel consumes this sequence without changing multiplicity.
    for (const candidate of cloneJsonValue(axis.values)) {
      const value = validateEditorValue(parameter, candidate, nodes);
      if (!values.some(prior => sameJsonValue(prior, value))) values.push(value);
    }
    return [id, { ...axis, values }];
  }));
}

// The editor checks only facts supplied by the shared catalogue/port schema.
// Final graph validation remains authoritative; unknown Python rules stay unknown.
export function validateEditorValue(parameter, candidate, nodes = null) {
  const value = compileValue(parameter, candidate), nodeId = parameter.nodeIds[0];
  const schema = { declarations: new Map(parameter.schema?.status === "known" ? [[`${parameter.type}.${parameter.key}`, parameter.schema]] : []),
    outputs: new Map((nodes ?? []).filter(node => node.outputs !== null).map(node => [node.type, node.outputs])) };
  const graph = Object.fromEntries((nodes ?? []).map(node => [node.id, { class_type: node.type, inputs: {} }]));
  graph[nodeId] = { class_type: parameter.type, inputs: { [parameter.key]: value } };
  validateParameterValue(graph, parameter, schema);
  if (nodes && parameter.valueKind === "connection") validateGraphLinks(graph, schema);
  return value;
}

export function validateParameterValue(graph, parameter, schema = {}) {
  const node = graph[parameter.nodeIds[0]], raw = node?.inputs?.[parameter.key];
  const declaration = inputDeclaration(node, parameter.key, schema);
  if (!declaration || isGraphLink(raw)) return;
  const encoding = inputEncoding(raw);
  const value = encoding === "comfy-array-wrapper" || encoding === "comfy-curve-wrapper" ? raw.__value__ : raw;
  const type = declaration.type;
  const invalid = reason => { throw new Error(`${parameter.id}: ${reason}`); };
  if (type === "INT" && !(typeof value === "bigint" || typeof value === "number" && Number.isSafeInteger(value))) invalid("INT requires an exact integer");
  if (type === "FLOAT" && !(typeof value === "number" && Number.isFinite(value))) invalid("FLOAT requires a finite number");
  if (type === "BOOLEAN" && typeof value !== "boolean") invalid("BOOLEAN requires true or false");
  if (type === "STRING" && typeof value !== "string") invalid("STRING requires text");
  if (Array.isArray(declaration.options)) {
    const candidates = declaration.multiselect === true && Array.isArray(value) ? value : [value];
    if (candidates.some(value => !declaration.options.some(option => sameJsonValue(option, value)))) invalid("value is not a declared option");
  }
  if (typeof value === "number" || typeof value === "bigint") {
    if (declaration.min !== undefined && value < declaration.min) invalid("value is below the declared minimum");
    if (declaration.max !== undefined && value > declaration.max) invalid("value is above the declared maximum");
  }
}

export function validateFinalGraph(graph, parameters, schema = {}) {
  validateGraphLinks(graph, schema);
  for (const parameter of parameters) {
    if (Object.hasOwn(graph[parameter.nodeIds[0]]?.inputs ?? {}, parameter.key)) validateParameterValue(graph, parameter, schema);
  }
}
