// The sole raw-recipe compiler. Catalogue, evidence and receipts are injected;
// this module owns no editor, mutable IO state or environment dependencies.
import { parseExactJson, parameterCurrent, sameJsonValue } from "../../parameters.mjs";
import { compileDiscreteAxes, validateEditorValue, admitResourceTransfer } from "./compile.mjs";
import { catalogueParams, templateValue, templateLabels, parseSemicolonList, expandTextAxes, uploadCandidate } from "./shared.mjs";
import { recipeField, recipeDispositions, snapshotDraft, freezeRecipe,
  numericText, imageIdentity, imageReference, imageReferenceValue } from "./recipe-model.mjs";
import { variationProblem, problemError, problemFrom } from "./problems.mjs";
const fail = (code, metadata, context) => problemError(variationProblem(code, { phase: "compile", parameter: { id: metadata.id, label: metadata.label ?? metadata.id }, ...context }));

export const currentRoot = parameter => parameter.currentRoot ?? (parameter.fromOutput ? "output" : "input");
// Shared active numeric operation admission. Raw text remains in the recipe;
// preview alone may estimate an incomplete increment, never recall or Run.
export function compileNumericOperation(values, metadata, { batch = false, preview = false } = {}) {
  if (values.mode === "value") {
    const value = numericText(values.value);
    if (value === null) throw fail("numeric-text", metadata, { field: "Value", value: values.value, expected: metadata.schema?.type });
    validateEditorValue(metadata, value);
    return { min: value, max: value, increment: metadata.minIncrement, ...(batch ? { absolute: true } : {}) };
  }
  const min = numericText(values.min), max = numericText(values.max), number = numericText(values.rawIncrement);
  if (min === null || max === null) throw fail("numeric-text", metadata, { field: min === null ? "From" : "To", value: min === null ? values.min : values.max });
  const increment = number !== null && number > 0 && number >= metadata.minIncrement ? number : null;
  if (increment === null && !preview) throw fail("numeric-step", metadata, { field: "Step", value: values.rawIncrement, numbers: { minimum: metadata.minIncrement } });
  if (min > max) throw fail("numeric-order", metadata, { numbers: { from: values.min, to: values.max } });
  if (!batch) for (const value of [min, max]) validateEditorValue(metadata, value);
  return { min, max, increment: increment ?? metadata.defaultIncrement };
}
export function recipeImageView(item, metadata, check, target, batch) {
  if (item.kind === "target") return { ...item, name: target.filename, each: batch, pending: false, error: "", sameCurrent: false };
  if (item.kind === "archive") return { ...item, pending: false, error: "", sameCurrent: false };
  const reference = imageReference(item);
  return { ...item, ...(reference ?? {}), sameCurrent: reference ? currentRoot(metadata) === reference.root && reference.name === metadata.current
    : !!check?.hash && check.hash === check.currentHash, pending: !reference && (!check || !!check.pending), error: check?.error ?? "", ...(check?.problem ? { problem: check.problem } : {}) };
}
export function parseRecipeCandidate(parameter, raw, nodes, index) {
  let value;
  try { value = parseExactJson(raw); } catch (error) { if (error.code === "exact-json") throw fail("exact-json", parameter, {}); throw new Error(`${parameter.label}: enter one complete JSON value. Your text is kept.`); }
  if (parameter.candidateKind === "connection") {
    const slot = numericText(value?.slot ?? "");
    if (typeof value?.node !== "string" || !value.node || !Number.isSafeInteger(slot) || slot < 0) throw fail("candidate-connection", parameter, { node: value?.node, slot: value?.slot, numbers: { candidate: index === undefined ? undefined : index + 1 } });
    value = [value.node, slot];
  }
  try { validateEditorValue(parameter, value, nodes); }
  catch (error) { throw problemError(problemFrom(error, { numbers: { candidate: index === undefined ? undefined : index + 1 } })); }
  return value;
}
export function previewRecipeUploads(snapshot, lookup, confirmedUploads, target, batch) {
  const names = new Map(), occupied = new Map(confirmedUploads);
  for (const [id, entry] of Object.entries(snapshot.images)) for (const item of entry.values.items) {
    for (const record of lookup(id, item)?.existing ?? []) occupied.set(record.name, record.hash);
  }
  for (const [id, entry] of Object.entries(snapshot.images)) {
    if (!entry.values.enabled) continue;
    for (const item of entry.values.items) {
      const identity = imageIdentity(item);
      if (item.kind === "target" || imageReference(item) || recipeImageView(item, entry.metadata, lookup(id, item), target, batch).sameCurrent || names.has(identity)) continue;
      const hash = lookup(id, item)?.hash;
      if (!hash) { names.set(identity, `\0pending-${names.size}`); continue; }
      let name = item.name, index = 0;
      while (occupied.has(name) && occupied.get(name) !== hash) name = uploadCandidate(item.name, ++index);
      occupied.set(name, hash); names.set(identity, name);
    }
  }
  return names;
}
export function compileRecipe(snapshot, { catalogue, target, batch = false, lookup = () => undefined,
  uploadReceipts = null, confirmedUploads = new Map(), resourceValues = new Map(), resourceIdentities = null, preview = false }) {
  const bindings = [], uploads = [], uploadHashes = new Map(), ranges = {}, imageParams = {}, transfers = {}, estimates = {};
  const parameters = catalogue.parameters ?? catalogueParams(catalogue);
  const uploadPreview = preview ? previewRecipeUploads(snapshot, lookup, confirmedUploads, target, batch) : null;
  const read = (domain, id, name, label) => {
    const definition = recipeField(domain, name), entry = snapshot[domain][id];
    const path = label === undefined ? [domain, id, name] : [domain, id, name, label];
    const value = label === undefined ? entry.values[name] : templateValue(entry.values[name], label);
    if (definition.channel && (label === undefined || Object.hasOwn(entry.values[name], label))) bindings.push({ channel: definition.channel, id: domain === "naming" ? name : id, path, value: snapshotDraft(value) });
    return value;
  };
  for (const [id, entry] of Object.entries(snapshot.numeric)) {
    const enabled = read("numeric", id, "enabled"); ranges[id] = { enabled };
    if (!enabled) continue;
    const mode = read("numeric", id, "mode");
    const values = { mode };
    for (const name of mode === "value" ? ["value"] : ["min", "max", "rawIncrement"]) values[name] = read("numeric", id, name);
    Object.assign(ranges[id], compileNumericOperation(values, entry.metadata, { batch, preview }));
    if (batch) ranges[id].clamp = [...entry.metadata.clamp];
  }
  for (const domain of ["images", "enums", "texts", "candidates"]) for (const [id, entry] of Object.entries(snapshot[domain])) {
    const enabled = read(domain, id, "enabled"); imageParams[id] = { enabled, values: [] };
    if (!enabled) continue;
    if (domain === "images") {
      const assigned = [], estimate = [], unresolved = [], items = read(domain, id, "items");
      if (!preview && !items.length) throw new Error(`${entry.metadata.label}: add at least one image before Run`);
      for (const item of items) {
        // Admission identities are count-only data, never names or assignments.
        // Their equality is supplied by the engine's resource membership owner.
        if (resourceIdentities?.has(imageIdentity(item))) {
          const identity = resourceIdentities.get(imageIdentity(item));
          if (typeof identity === "string") { assigned.push(identity); estimate.push(identity); continue; }
          admitResourceTransfer(entry.metadata);
          estimate.push(identity);
          unresolved.push(imageIdentity(item));
          continue;
        }
        const state = recipeImageView(item, entry.metadata, lookup(id, item), target, batch);
        const resolved = resourceValues.get(imageIdentity(item));
        if (!resolved && !preview && (state.pending || state.error)) throw new Error(state.error || "Checking image bytes; your work was kept.");
        let value;
        if (resolved) value = resolved.value;
        else if (item.kind === "target") value = `${target.filename} [output]`;
        else if (state.sameCurrent) value = parameterCurrent(entry.metadata);
        else if (imageReference(item)) value = imageReferenceValue(item);
        else {
          const identity = imageIdentity(item);
          admitResourceTransfer(entry.metadata);
          uploads.push(item);
          uploadHashes.set(identity, lookup(id, item)?.hash);
          if (uploadReceipts?.has(identity)) value = uploadReceipts.get(identity).name;
          else {
            if (uploadReceipts) throw new Error(`${item.name}: upload acknowledgement unavailable; your image was kept`);
            unresolved.push(identity);
            if (preview) estimate.push(uploadPreview.get(identity));
            continue;
          }
        }
        assigned.push(value); estimate.push(value);
      }
      imageParams[id].values = [...new Set(assigned)];
      if (unresolved.length) { transfers[id] = unresolved; estimates[id] = estimate.filter((value, i) => !estimate.slice(0, i).some(other => sameJsonValue(value, other))); }
    } else if (domain === "candidates") {
      imageParams[id].values = read(domain, id, "candidates").map((raw, index) => parseRecipeCandidate(entry.metadata, raw, catalogue.nodes, index));
      if (!imageParams[id].values.length) throw new Error(`${entry.metadata.label}: add at least one value before Run`);
    } else if (domain === "enums") {
      imageParams[id].values = [...read(domain, id, "picks")];
      if (!preview && !imageParams[id].values.length) throw new Error(`${entry.metadata.label}: choose at least one value before Run`);
    } else {
      const text = read(domain, id, "text");
      const substitutions = Object.fromEntries(templateLabels(text).map(label => [label, parseSemicolonList(read(domain, id, "tpl", label))]));
      imageParams[id].values = expandTextAxes(text, substitutions, { parameter: { id, label: entry.metadata.label } });
      if (!preview && !imageParams[id].values.length) throw fail("template-empty", entry.metadata, { names: Object.keys(substitutions).filter(label => !substitutions[label].length) });
    }
  }
  const payload = freezeRecipe({ ranges, imageParams: compileDiscreteAxes(imageParams, parameters, catalogue.nodes), automaticNaming: true,
    prefix: read("naming", "root", "prefix"), suffix: read("naming", "root", "suffix"), ...(batch ? { relative: true } : {}) });
  const dispositions = recipeDispositions(snapshot, bindings);
  const estimate = freezeRecipe({ ...payload, imageParams: { ...payload.imageParams,
    ...Object.fromEntries(Object.entries(estimates).map(([id, values]) => [id, { ...payload.imageParams[id], values }])) } });
  return { payload, estimate, transfers, bindings: freezeRecipe(bindings), dispositions,
    uploads: [...new Map(uploads.map(item => [imageIdentity(item), item])).values()], uploadHashes };
}
