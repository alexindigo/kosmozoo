// Framework-free typed assignment boundary. Editor adapters and Run share data
// semantics; graph.mjs alone owns connection/wrapper interpretation.
import { cloneJsonValue, sameJsonValue, stringifyExactJson, parameterIndex, inputContract, parameterContract, resourceReferenceProblem } from "../../parameters.mjs";
import { assignmentValue, inputDeclaration, inputEncoding, isGraphLink, validateGraphLinks } from "../../graph.mjs";
import { variationProblem, problemError } from "./problems.mjs";
const invalid = (code, parameter, context = {}) => problemError(variationProblem(code, { phase: "compile", parameter: { id: parameter.id, label: parameter.label ?? parameter.id }, ...context }));
function graphProblem(error) {
  if (!error.issue) throw error;
  const { id, key, ...context } = error.issue;
  throw invalid("graph-link", { id: `${id}.${key}` }, { ...context, detail: error.message });
}

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
    if (!parameter) throw invalid("parameter-missing", { id });
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
  let value;
  try { value = compileValue(parameter, candidate); }
  catch (error) { throw invalid("value-encoding", parameter, { value: candidate, expected: parameterContract(parameter).type, detail: error.message }); }
  const nodeId = parameter.nodeIds[0];
  const schema = { declarations: new Map(parameter.schema?.status === "known" ? [[`${parameter.type}.${parameter.key}`, parameter.schema]] : []),
    outputs: new Map((nodes ?? []).filter(node => node.outputs !== null).map(node => [node.type, node.outputs])) };
  const graph = Object.fromEntries((nodes ?? []).map(node => [node.id, { class_type: node.type, inputs: {} }]));
  graph[nodeId] = { class_type: parameter.type, inputs: { [parameter.key]: value } };
  validateParameterValue(graph, parameter, schema);
   if (nodes && parameter.valueKind === "connection") { try { validateGraphLinks(graph, schema); } catch (error) { graphProblem(error); } }
  return value;
}

export function validateParameterValue(graph, parameter, schema = {}) {
  const node = graph[parameter.nodeIds[0]], raw = node?.inputs?.[parameter.key];
  const declaration = inputDeclaration(node, parameter.key, schema);
  if (!declaration || isGraphLink(raw)) return;
  const encoding = inputEncoding(raw);
  const value = encoding === "comfy-array-wrapper" || encoding === "comfy-curve-wrapper" ? raw.__value__ : raw;
  // The selected declaration's contract, not a descriptor from another branch.
  const contract = inputContract(declaration), type = contract.type;
  const typeError = () => { throw invalid("value-type", parameter, { value, expected: type, actual: value === null ? "null" : typeof value }); };
  if (type === "INT" && !(typeof value === "bigint" || typeof value === "number" && Number.isSafeInteger(value))) typeError();
  if (type === "FLOAT" && !(typeof value === "number" && Number.isFinite(value))) typeError();
  if (type === "BOOLEAN" && typeof value !== "boolean") typeError();
  if (type === "STRING" && typeof value !== "string") typeError();
  const candidates = contract.choices?.multiselect && Array.isArray(value) ? value : [value];
  if (contract.role === "resource") {
    // A picker listing is evidence of what existed, never the accepted domain.
    for (const candidate of candidates) { const problem = resourceReferenceProblem(contract, candidate); if (problem) throw invalid("resource-reference", parameter, { value: candidate, detail: problem }); }
  } else if (contract.choices?.evidence === "closed") {
    for (const candidate of candidates) if (!contract.choices.values.some(option => sameJsonValue(option, candidate))) throw invalid("value-choice", parameter, { value: candidate, numbers: { options: contract.choices.values.length } });
  }
  if (typeof value === "number" || typeof value === "bigint") {
    for (const side of ["min", "max"]) if (declaration[side] !== undefined && (side === "min" ? value < declaration.min : value > declaration.max)) throw invalid("value-bound", parameter, { value, side, numbers: { bound: declaration[side], min: declaration.min, max: declaration.max } });
  }
}

// A planned transfer is a resource intent, never a literal candidate: its target
// name exists only after an actual receipt. Known non-resource inputs and
// listing-only pickers reject before any read or write; unknown stays backend-owned.
export function admitResourceTransfer(parameter) {
  const contract = parameterContract(parameter);
  if (contract.knowledge !== "known") return contract;
  if (contract.role !== "resource") throw invalid("transfer-unsupported", parameter, { detail: "accepts only its declared values, not uploaded files" });
  if (!contract.resource.upload) throw invalid("transfer-unsupported", parameter, { detail: "does not accept uploaded files" });
  return contract;
}

export function validateFinalGraph(graph, parameters, schema = {}) {
  try { validateGraphLinks(graph, schema); } catch (error) { graphProblem(error); }
  for (const parameter of parameters) {
    if (Object.hasOwn(graph[parameter.nodeIds[0]]?.inputs ?? {}, parameter.key)) validateParameterValue(graph, parameter, schema);
  }
}
