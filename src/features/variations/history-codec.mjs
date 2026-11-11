// Versioned persistence boundary over the declared raw leaves, never widget state.
import { cloneJsonValue, resourceReference } from "../../parameters.mjs";
import { RECIPE_FIELDS, validRecipeValue, freezeRecipe, validImageSet } from "./recipe-model.mjs";

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
