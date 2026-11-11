// Versioned persistence boundary over the declared raw leaves, never widget state.
import { cloneJsonValue, resourceReference } from "../../parameters.mjs";
import { RECIPE_FIELDS, validRecipeValue, freezeRecipe, validImageSet, snapshotDraft, sameDraft, numericText } from "./recipe-model.mjs";
import { sameJsonValue } from "../../parameters.mjs";
import { acknowledgedFields, catalogueParams, parameterAliases, templateReplaceWithProof, templateLabels } from "./shared.mjs";
import { validateEditorValue, admitResourceTransfer } from "./compile.mjs";
import { parseRecipeCandidate } from "./recipe-compile.mjs";

// Saved-plan correlation is deliberately outside the unchanged strict v2 proof.
export function acknowledgedHistoryFields(request, response) {
  if (!request.history || !response?.history || !sameJsonValue(request.history, response.history)) return null;
  return acknowledgedFields(request, response);
}

export const HISTORY_FORMAT = 1;
export const historyId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const ownRecord = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid history record");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || keys && !keys.includes(key)) throw new Error("Invalid history property");
  }
  return value;
};
function dataTree(value, seen = new Set()) {
  if (typeof File !== "undefined" && value instanceof File) return;
  if (value === null || ["string", "boolean", "bigint"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || seen.has(value)) throw new Error("Invalid history data");
  seen.add(value);
  const array = Array.isArray(value);
  if (!array) ownRecord(value);
  else if (Object.keys(value).length !== value.length) throw new Error("Invalid history array");
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !d.enumerable || !Object.hasOwn(d, "value") || array && !/^(0|[1-9]\d*)$/.test(key)) throw new Error("Invalid history property");
    dataTree(d.value, seen);
  }
  seen.delete(value);
}
export function encodeHistoryRecipe(snapshot, runId) {
  if (!historyId(runId)) throw new Error("Invalid history Run ID");
  dataTree(snapshot);
  ownRecord(snapshot, Object.keys(RECIPE_FIELDS));
  const resources = [], files = new Map();
  const imageSet = items => {
    if (!validImageSet(items)) throw new Error("Invalid history image set");
    return items.map(item => {
      ownRecord(item, ["kind", "name", "file", "path", "value", "runId", "resourceId", "hash", "sourceKind", "root", "leaseId"]);
      if (item.kind === "target") return { kind: "target" };
      const id = `image-${resources.length}`, reference = item.kind === "input" ? resourceReference(item.name) : item.kind === "reference" ? resourceReference(item.value) : null;
      const descriptor = { id, kind: item.kind, name: reference?.name ?? item.name,
        ...(reference ? { root: reference.root, value: item.kind === "input" ? item.name : item.value } : {}),
        ...(item.kind === "server-path" ? { path: item.path } : {}),
        ...(item.kind === "archive" ? { runId: item.runId, resourceId: item.resourceId, leaseId: item.leaseId ?? null, hash: item.hash ?? null, sourceKind: item.sourceKind } : {}) };
      resources.push(descriptor);
      if (item.kind === "upload") files.set(id, item.file);
      return { kind: "archive", runId, resourceId: id, name: descriptor.name, sourceKind: item.sourceKind ?? item.kind };
    });
  };
  const recipe = Object.fromEntries(Object.entries(RECIPE_FIELDS).map(([domain, fields]) => {
    const rows = ownRecord(snapshot[domain]);
    return [domain, Object.fromEntries(Object.entries(rows).map(([id, entry]) => {
      ownRecord(entry, ["metadata", "values", "baseline", "touched"]);
      const project = values => {
        ownRecord(values, Object.keys(fields));
        return Object.fromEntries(Object.entries(fields).map(([name, definition]) => {
          const value = values[name];
          if (!validRecipeValue(definition.type, value)) throw new Error(`Invalid history field: ${domain}.${name}`);
          return [name, definition.type === "image-set" ? imageSet(value) : cloneJsonValue(value)];
        }));
      };
      return [id, { metadata: cloneJsonValue(entry.metadata), values: project(entry.values), baseline: project(entry.baseline), touched: cloneJsonValue(entry.touched) }];
    }))];
  }));
  return { format: HISTORY_FORMAT, recipe: freezeRecipe(recipe), resources: freezeRecipe(resources), files };
}
export function decodeHistoryRecipe(document) {
  const data = cloneJsonValue(document);
  if (data.format !== HISTORY_FORMAT) throw new Error("Unsupported variation history format");
  ownRecord(data.recipe, Object.keys(RECIPE_FIELDS));
  for (const [domain, fields] of Object.entries(RECIPE_FIELDS)) {
    for (const entry of Object.values(ownRecord(data.recipe[domain]))) {
      ownRecord(entry, ["metadata", "values", "baseline", "touched"]);
      for (const values of [entry.values, entry.baseline]) {
        ownRecord(values, Object.keys(fields));
        for (const [name, definition] of Object.entries(fields)) {
          if (!validRecipeValue(definition.type, values[name])) throw new Error(`Invalid saved field: ${domain}.${name}`);
        }
      }
    }
  }
  return freezeRecipe(data.recipe);
}

// A data patch, not a second editor. Every destination contract is checked; only
// active contributors enter the patch, leaving dormant destination buffers alone.
export function planHistoryOverlay(saved, destination, catalogues, cohortMode) {
  const source = decodeHistoryRecipe(saved), patch = [], warnings = [];
  const parameters = catalogues.map(c => new Map((c.parameters ?? catalogueParams(c)).map(p => [p.id, p])));
  for (const [domain, rows] of Object.entries(source)) for (const [id, entry] of Object.entries(rows)) {
    if (domain === "naming" || !entry.values.enabled) continue;
    try {
      const target = destination[domain]?.[id];
      if (!target) throw new Error("location or editor type is missing");
      if (domain === "numeric" && entry.values.mode === "range" && saved.cohortMode !== cohortMode) throw new Error("Range uses a different absolute/relative basis");
      for (let index = 0; index < parameters.length; index++) {
        const p = parameters[index].get(id);
        if (!p) throw new Error("location is missing from a target");
        if (p.type !== entry.metadata.type || p.key !== entry.metadata.key || !sameDraft(p.nodeIds, entry.metadata.nodeIds) ||
          p.valueKind !== entry.metadata.valueKind || p.kind !== entry.metadata.kind) throw new Error("parameter type or resource semantics changed");
        const v = entry.values;
        if (domain === "numeric") {
          const names = v.mode === "value" ? ["value"] : ["min", "max", "rawIncrement"];
          for (const name of names) {
            const number = numericText(v[name]);
            if (number === null) throw new Error(`saved ${name} is incomplete`);
            if (name !== "rawIncrement" && (v.mode === "value" || cohortMode === "single")) validateEditorValue(p, number);
          }
        } else if (domain === "candidates") for (const raw of v.candidates) parseRecipeCandidate({ ...target.metadata, ...p }, raw, catalogues[index].nodes);
        else if (domain === "enums") for (const value of v.picks) validateEditorValue(p, value, catalogues[index].nodes);
        else if (domain === "texts") validateEditorValue(p, v.text, catalogues[index].nodes);
        else for (const item of v.items) {
          if (item.kind !== "target") {
            if (item.kind !== "archive" || !saved.resources?.some(r => r.id === item.resourceId && r.hash)) throw new Error("saved image bytes are unavailable");
            admitResourceTransfer(p);
          }
        }
      }
      const names = domain === "numeric" ? ["enabled", "mode", ...(entry.values.mode === "value" ? ["value"] : ["min", "max", "rawIncrement"])] : Object.keys(RECIPE_FIELDS[domain]);
      for (const name of names) {
        let value = snapshotDraft(entry.values[name]);
        if (domain === "texts" && name === "tpl") {
          const used = new Set(templateLabels(entry.values.text));
          // Labels are literal data, including inherited setter names. Build
          // own entries rather than assigning through Object.prototype.
          value = Object.fromEntries([
            ...Object.entries(target.values.tpl).filter(([label]) => !used.has(label)),
            ...[...used].filter(label => Object.hasOwn(entry.values.tpl, label)).map(label => [label, entry.values.tpl[label]]),
          ]);
        }
        patch.push({ domain, id, name, value });
      }
    } catch (error) { warnings.push({ id, label: entry.metadata.label ?? id, reason: error.message }); }
  }
  for (const name of ["prefix", "suffix"]) {
    const naming = source.naming.root;
    if (sameDraft(naming.values[name], naming.baseline[name])) continue;
    const complete = catalogues.every(c => {
      const params = c.parameters ?? catalogueParams(c), current = Object.fromEntries(params.map(p => [p.id, p.currentValue ?? p.current]));
      return templateReplaceWithProof(naming.values[name], {}, current, parameterAliases(params), params).complete;
    });
    if (complete) patch.push({ domain: "naming", id: "root", name, value: naming.values[name] });
    else warnings.push({ id: name, label: name === "prefix" ? "Prefix" : "Suffix", reason: "unresolved naming token" });
  }
  const overlap = patch.some(({ domain, id, name, value }) => {
    const entry = destination[domain][id];
    if (domain === "texts" && name === "tpl") return templateLabels(source.texts[id].values.text).some(label =>
      !sameDraft(entry.values.tpl[label], entry.baseline.tpl[label]) && !sameDraft(entry.values.tpl[label], value[label]));
    return !sameDraft(entry.values[name], entry.baseline[name]) && !sameDraft(entry.values[name], value);
  });
  return freezeRecipe({ patch, warnings, overlap });
}
