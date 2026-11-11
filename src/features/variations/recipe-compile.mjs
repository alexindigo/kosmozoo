// The sole raw-recipe compiler. Catalogue, evidence and receipts are injected;
// this module owns no editor, mutable IO state or environment dependencies.
import { parseExactJson, parameterCurrent } from "../../parameters.mjs";
import { compileDiscreteAxes, validateEditorValue, admitResourceTransfer } from "./compile.mjs";
import { catalogueParams, templateValue, templateLabels, parseSemicolonList, expandTextAxes, uploadCandidate } from "./shared.mjs";
import { RECIPE_FIELDS, recipeField, recipeDispositions, snapshotDraft, freezeRecipe,
  numericText, imageIdentity, imageReference, imageReferenceValue } from "./recipe-model.mjs";

export const currentRoot = parameter => parameter.currentRoot ?? (parameter.fromOutput ? "output" : "input");
export function recipeImageView(item, metadata, check, target, batch) {
  if (item.kind === "target") return { ...item, name: target.filename, each: batch, pending: false, error: "", sameCurrent: false };
  const reference = imageReference(item);
  return { ...item, ...(reference ?? {}), sameCurrent: reference ? currentRoot(metadata) === reference.root && reference.name === metadata.current
    : !!check?.hash && check.hash === check.currentHash, pending: !reference && (!check || !!check.pending), error: check?.error ?? "" };
}
export function parseRecipeCandidate(parameter, raw, nodes) {
  let value;
  try { value = parseExactJson(raw); } catch { throw new Error(`${parameter.label}: enter one complete JSON value. Your text is kept.`); }
  if (parameter.candidateKind === "connection") {
    const slot = numericText(value?.slot ?? "");
    if (typeof value?.node !== "string" || !value.node || !Number.isSafeInteger(slot) || slot < 0) throw new Error(`${parameter.label}: choose an existing node and nonnegative output slot. Your text is kept.`);
    value = [value.node, slot];
  }
  validateEditorValue(parameter, value, nodes);
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
  uploadReceipts = null, confirmedUploads = new Map(), preview = false }) {
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
    if (mode === "value") {
      const value = numericText(read("numeric", id, "value"));
      if (value === null) throw new Error(`${entry.metadata.label}: Enter a number for Value. Your text is kept.`);
      validateEditorValue(entry.metadata, value);
      Object.assign(ranges[id], { min: value, max: value, increment: entry.metadata.minIncrement, ...(batch ? { absolute: true } : {}) });
    } else for (const [name, definition] of Object.entries(RECIPE_FIELDS.numeric)) if (definition.wire && definition.channel === "ranges") {
      const value = read("numeric", id, name);
      if (name === "rawIncrement") {
        const number = numericText(value), parsed = number !== null && number >= entry.metadata.minIncrement ? number : null;
        if (parsed === null && !preview) throw new Error("Enter a valid positive increment; incomplete text has been kept.");
        ranges[id][definition.wire] = parsed ?? entry.metadata.defaultIncrement;
      } else {
        const parsed = numericText(value);
        if (parsed === null) throw new Error(`${entry.metadata.label}: Enter a number for ${name === "min" ? "From" : "To"}. Your text is kept.`);
        ranges[id][definition.wire] = parsed;
      }
    }
    if (ranges[id].min > ranges[id].max) throw new Error("Minimum exceeds maximum; your values have been kept.");
    if (!batch) for (const name of ["min", "max"]) validateEditorValue(entry.metadata, ranges[id][name]);
    if (batch) ranges[id].clamp = [...entry.metadata.clamp];
  }
  for (const domain of ["images", "enums", "texts", "candidates"]) for (const [id, entry] of Object.entries(snapshot[domain])) {
    const enabled = read(domain, id, "enabled"); imageParams[id] = { enabled, values: [] };
    if (!enabled) continue;
    if (domain === "images") {
      const assigned = [], estimate = [], unresolved = [], items = read(domain, id, "items");
      if (!preview && !items.length) throw new Error(`${entry.metadata.label}: add at least one image before Run`);
      for (const item of items) {
        const state = recipeImageView(item, entry.metadata, lookup(id, item), target, batch);
        if (!preview && (state.pending || state.error)) throw new Error(state.error || "Checking image bytes; your work was kept.");
        let value;
        if (item.kind === "target") value = `${target.filename} [output]`;
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
      if (unresolved.length) { transfers[id] = unresolved; estimates[id] = [...new Set(estimate)]; }
    } else if (domain === "candidates") {
      imageParams[id].values = read(domain, id, "candidates").map(raw => parseRecipeCandidate(entry.metadata, raw, catalogue.nodes));
      if (!imageParams[id].values.length) throw new Error(`${entry.metadata.label}: add at least one value before Run`);
    } else if (domain === "enums") {
      imageParams[id].values = [...read(domain, id, "picks")];
      if (!preview && !imageParams[id].values.length) throw new Error(`${entry.metadata.label}: choose at least one value before Run`);
    } else {
      const text = read(domain, id, "text");
      const substitutions = Object.fromEntries(templateLabels(text).map(label => [label, parseSemicolonList(read(domain, id, "tpl", label))]));
      imageParams[id].values = expandTextAxes(text, substitutions);
      if (!preview && !imageParams[id].values.length) throw new Error(`${entry.metadata.label}: enter values for every template label before Run`);
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
