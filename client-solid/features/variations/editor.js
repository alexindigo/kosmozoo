// Dialog-private Run owner over its raw recipe. Catalogue and image
// evidence are readonly context; compilation classifies every captured leaf.
import { snapshotDraft, createRunId } from "./draft.js";
import { editorDomain, numericDefaults, numericText, sliderNumber } from "./graph.mjs";
import { parseExactJson, stringifyExactJson, sameJsonValue } from "/shared/parameters.mjs";
import { compileDiscreteAxes, validateEditorValue } from "/shared/features/variations/compile.mjs";
import { templateLabels, templateValue, parseSemicolonList, expandTextAxes, permutationPlan,
  resolveRelativeRanges, acknowledgedFields, targetRunPlan, catalogueParams, parameterIndex, parameterCurrent, parameterLabel, parameterAliases,
   variationOutputName, uploadCandidate, uploadFamily } from "/shared/features/variations/shared.mjs";
import { validOrigin, sameOrigin, validContext, sameContext } from "/shared/source-origin.mjs";
import { validImageSet, mergeImages, sameImage, imageIdentity, uploadImage } from "./image-set.js";
import { classifyImageFiles } from "./image-drop.js";
import { RECIPE_FIELDS as EDITOR_FIELDS, makeVariationRecipe, recipeField as descriptor,
  validRecipeValue as validValue, freezeRecipe as freeze, recipeDispositions, moveRecipeImage } from "./recipe.js";
export { RECIPE_FIELDS as EDITOR_FIELDS } from "./recipe.js";
const filename = value => typeof value === "string" && value.length > 0 && !/[\\/\x00-\x1f\x7f]/.test(value) && ![".", ".."].includes(value);
const allParameters = catalogue => catalogue.parameters ?? catalogueParams(catalogue);
// Legacy-first ordering preserves existing manual aliases independently of layout.
const namingParameters = catalogue => {
  const all = parameterIndex(allParameters(catalogue)), ids = new Set();
  return [...catalogueParams(catalogue), ...all.values()].filter(parameter => !ids.has(parameter.id) && ids.add(parameter.id))
    .map(parameter => all.get(parameter.id) ?? parameter);
};
const currentValues = catalogue => Object.fromEntries([...parameterIndex(allParameters(catalogue)).values()]
  .map(parameter => [parameter.id, parameterCurrent(parameter)]));
// Raw numeric spelling belongs to the recipe; all numeric consumers share this
// parser. Empty/incomplete text is never coerced to zero or an earlier value.
const numberText = numericText;

// Kind-specific defaults plug into one catalogue installation lifecycle. Labels,
// identity validation and seeding always pass through the common owner boundary.
const ROW_STRATEGIES = {
  numeric: { initialize: numericDefaults },
  images: { initialize: () => ({ metadata: { files: [], filesReady: false },
    defaults: { enabled: false, items: [] } }) },
  enums: { initialize: p => ({ metadata: { values: p.schema?.options ?? p.values }, defaults: { enabled: false, picks: [parameterCurrent(p)] } }) },
  texts: { initialize: p => ({ defaults: { enabled: false, text: parameterCurrent(p), tpl: {} } }) },
  candidates: { initialize: p => ({ metadata: { candidateKind: p.valueKind === "connection" ? "connection" : p.schema?.options?.length ? "options" : typeof parameterCurrent(p) === "boolean" ? "boolean" : "json",
    options: p.schema?.options ?? (typeof parameterCurrent(p) === "boolean" ? [true, false] : null) },
    defaults: { enabled: false, candidates: [stringifyExactJson(p.valueKind === "connection" ? { node: String(parameterCurrent(p)[0]), slot: String(parameterCurrent(p)[1]) } : parameterCurrent(p))] } }) },
};

export function makeVariationEditor({ targets, services, currentOrigin, changed = () => {}, close = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const recipe = makeVariationRecipe();
  const capturedTargets = freeze(snapshotDraft(targets));
  const catalogues = new Map();
  let locations = [];
  const imageChecks = new Map(), confirmedUploads = new Map();
  const inputCatalogues = new Map(), sourceFiles = new Map();
  const sourceRecord = (map, origin, create) => {
    const previous = map.get(origin.source);
    if (previous && sameOrigin(previous.origin, origin)) return previous;
    if (!create) return null;
    const record = { origin: freeze(snapshotDraft(origin)), ...create() };
    map.set(origin.source, record); return record;
  };
  const cachedInput = (origin, name) => sourceRecord(sourceFiles, origin)?.files.get(name);
  const batch = capturedTargets.length > 1;
  let alive = true, closeGeneration = 0, deciding = false, active = null, timer = null;
  let result = null, running = false, catalogueReady = false, acceptedRevision = null;
  const row = recipe.row;
  const evidence = (id, item) => imageChecks.get(id)?.get(imageIdentity(item));
  const imageView = (id, item, metadata, lookup = evidence) => {
    if (item.kind === "target") return { ...item, name: capturedTargets[0].filename, each: batch, pending: false, error: "", sameCurrent: false };
    const check = item.kind === "input" ? null : lookup(id, item);
    return { ...item, sameCurrent: item.kind === "input" ? item.name === parameterCurrent(metadata)
      : !!check?.hash && check.hash === check.currentHash, pending: item.kind !== "input" && (!check || !!check.pending), error: check?.error ?? "" };
  };
  const notify = () => { if (alive) changed(); };
  const invalidateClose = () => { closeGeneration++; if (timer !== null) clearTimer(timer); timer = null; };
  const seed = (domain, id, metadata, defaults) => {
    if (!alive) return;
    recipe.seed(domain, id, metadata, defaults);
    notify();
  };
  const write = recipe.write;
  const increment = (entry, values = entry.values) => {
    const value = numberText(values.rawIncrement);
    return value !== null && value >= entry.metadata.minIncrement ? value : null;
  };
  const view = domain => Object.freeze(Object.fromEntries([...recipe.entries(domain)].map(([id, entry]) => [id,
     freeze({ ...entry.metadata, ...snapshotDraft(entry.values), ...(domain === "numeric" ? { increment: increment(entry),
        numbers: Object.fromEntries(["min", "max", "value"].map(name => [name, numberText(entry.values[name])])),
        sliderSafe: [...entry.metadata.clamp, entry.metadata.current, increment(entry), ...["min", "max", "value"].map(name => numberText(entry.values[name]))].filter(value => value !== null).every(sliderNumber) } : {}),
        ...(domain === "candidates" ? { choices: candidateChoices(entry), candidateViews: entry.values.candidates.map((raw, index) => {
          let value = null, error = "";
          try { value = parseExactJson(raw); parseCandidate(entry.metadata, raw); } catch (problem) { error = problem.message; }
          return { raw, index, error, label: raw,
            node: value?.node ?? "", slot: value?.slot ?? "" };
        }) } : {}),
       ...(domain === "images" ? { images: entry.values.items.map(item => imageView(id, item, entry.metadata)) } : {}) })])));
  const dirty = () => acceptedRevision === null ? recipe.dirty() : recipe.revision() !== acceptedRevision;
  const parseCandidate = (parameter, raw) => {
    let value;
    try { value = parseExactJson(raw); } catch { throw new Error(`${parameter.label}: enter one complete JSON value. Your text is kept.`); }
    if (parameter.candidateKind === "connection") {
      const slot = numericText(value?.slot ?? "");
      if (typeof value?.node !== "string" || !value.node || !Number.isSafeInteger(slot) || slot < 0) throw new Error(`${parameter.label}: choose an existing node and nonnegative output slot. Your text is kept.`);
      value = [value.node, slot];
    }
    validateEditorValue(parameter, value, catalogues.get(capturedTargets[0].id)?.nodes);
    return value;
  };
  const candidateChoices = entry => (entry.metadata.options ?? []).map(value => ({ text: stringifyExactJson(value),
    label: stringifyExactJson(value),
    on: entry.values.candidates.some(raw => { try { return sameJsonValue(parseExactJson(raw), value); } catch { return false; } }) }));
  const catalogueRows = () => {
    const domains = new Map([...new Set(locations.map(row => row.domain))].map(domain => [domain, view(domain)]));
    return locations.map(({ id, domain }) => ({ ...domains.get(domain)[id], domain }));
  };
  const captureRows = recipe.capture;
  const owns = ticket => alive && active === ticket;
  const originCurrent = target => validOrigin(target.origin) && sameOrigin(target.origin, currentOrigin(target.host));
  const check = (ticket, target) => {
    if (!owns(ticket)) throw Object.assign(new Error("Operation retired; work was kept"), { stale: true });
    if (!originCurrent(target)) throw Object.assign(new Error("Source origin changed; no follow-up was authorized. Your work has been kept."), { stale: true });
  };
  const physicalMatch = (a, b) => validOrigin(a) && validOrigin(b) && a.address === b.address && a.kind === b.kind && a.epoch === b.epoch;
  const inspectionQueue = [], pendingInspections = new Set();
  let inspecting = 0;
  const pumpInspections = () => {
    while (inspecting < 4 && inspectionQueue.length) {
      const task = inspectionQueue.shift(); inspecting++;
      task().finally(() => { inspecting--; pumpInspections(); });
    }
  };
  const inspectItems = id => {
    const entry = row("images", id), target = capturedTargets[0];
    if (!imageChecks.has(id)) imageChecks.set(id, new Map());
    const checks = imageChecks.get(id);
    for (const item of entry.values.items) {
      if (item.kind === "target" || item.kind === "input" || checks.has(imageIdentity(item))) continue;
      const check = { pending: true }, identity = imageIdentity(item); checks.set(identity, check);
      let finish;
      const pending = new Promise(resolve => { finish = resolve; }); pendingInspections.add(pending);
      inspectionQueue.push(async () => {
        try {
          if (!alive || !originCurrent(target)) throw new Error("Source origin changed; your images were kept");
          const inspect = item.kind === "server-path" ? services.inspectPath : services.inspectImage;
          const result = await inspect(target.host, item.kind === "server-path" ? item.path : item.file, entry.metadata.current, entry.metadata.fromOutput ? "output" : "input", target.origin, uploadFamily(item.name, entry.metadata.files));
          if (!alive || !originCurrent(target) || !sameOrigin(result?.origin, target.origin)) throw new Error("Source origin changed; your images were kept");
          if (!/^[a-f0-9]{64}$/.test(result.hash) || !/^[a-f0-9]{64}$/.test(result.currentHash)) throw new Error("Image comparison unavailable");
          const existing = result.existing ?? [];
          if (!Array.isArray(existing) || existing.some(item => !filename(item?.name) || !/^[a-f0-9]{64}$/.test(item.hash))) throw new Error("Upload comparison unavailable");
          Object.assign(check, { hash: result.hash, currentHash: result.currentHash, existing });
        } catch (error) { check.error = error.message; }
        finally { check.pending = false; pendingInspections.delete(pending); finish(); notify(); }
      });
    }
    pumpInspections();
  };
  const previewUploads = (snapshot, lookup = evidence) => {
    const names = new Map(), occupied = new Map(confirmedUploads);
    for (const [id, entry] of Object.entries(snapshot.images)) for (const item of entry.values.items) {
      for (const record of lookup(id, item)?.existing ?? []) occupied.set(record.name, record.hash);
    }
    for (const [id, entry] of Object.entries(snapshot.images)) {
      if (!entry.values.enabled) continue;
      for (const item of entry.values.items) {
        const identity = imageIdentity(item);
        if (item.kind === "target" || item.kind === "input" || imageView(id, item, entry.metadata, lookup).sameCurrent || names.has(identity)) continue;
        const hash = lookup(id, item)?.hash;
        if (!hash) { names.set(identity, `\0pending-${names.size}`); continue; }
        let name = item.name, index = 0;
        while (occupied.has(name) && occupied.get(name) !== hash) name = uploadCandidate(item.name, ++index);
        occupied.set(name, hash); names.set(identity, name);
      }
    }
    return names;
  };

  // This compiler is the only reader that attaches producer channels to editor
  // leaves. Dirty tracking uses the same declarations, never whole row objects.
  const compile = (snapshot, uploadReceipts = null, preview = false, lookup = evidence, target = capturedTargets[0]) => {
    const bindings = [], uploads = [], uploadHashes = new Map(), ranges = {}, imageParams = {};
    const catalogue = catalogues.get(capturedTargets[0].id), parameters = allParameters(catalogue);
    const uploadPreview = preview ? previewUploads(snapshot, lookup) : null;
    const read = (domain, id, name, label) => {
      const definition = descriptor(domain, name), entry = snapshot[domain][id];
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
        const value = numberText(read("numeric", id, "value"));
        if (value === null) throw new Error(`${entry.metadata.label}: Enter a number for Value. Your text is kept.`);
        validateEditorValue(entry.metadata, value);
        Object.assign(ranges[id], { min: value, max: value, increment: entry.metadata.minIncrement,
          ...(batch ? { absolute: true } : {}) });
      } else for (const [name, definition] of Object.entries(EDITOR_FIELDS.numeric)) if (definition.wire && definition.channel === "ranges") {
        const value = read("numeric", id, name);
        if (name === "rawIncrement") {
          const parsed = increment(entry);
          if (parsed === null && !preview) throw new Error("Enter a valid positive increment; incomplete text has been kept.");
          ranges[id][definition.wire] = parsed ?? entry.metadata.defaultIncrement;
        } else {
          const parsed = numberText(value);
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
        const values = [];
        const items = read(domain, id, "items");
        if (!preview && !items.length) throw new Error(`${entry.metadata.label}: add at least one image before Run`);
        for (const item of items) {
          const state = imageView(id, item, entry.metadata, lookup);
          if (!preview && (state.pending || state.error)) throw new Error(state.error || "Checking image bytes; your work was kept.");
          if (item.kind === "target") values.push(`${target.filename} [output]`);
          else if (state.sameCurrent) values.push(parameterCurrent(entry.metadata));
          else if (item.kind === "input") values.push(item.name);
          else {
            const identity = imageIdentity(item);
            uploads.push(item);
            uploadHashes.set(identity, lookup(id, item)?.hash);
            if (preview) values.push(uploadPreview.get(identity));
            else if (uploadReceipts?.has(identity)) values.push(uploadReceipts.get(identity).name);
          }
        }
        imageParams[id].values = [...new Set(values)];
      } else if (domain === "candidates") {
        imageParams[id].values = read(domain, id, "candidates").map(raw => parseCandidate(entry.metadata, raw));
        if (!imageParams[id].values.length) throw new Error(`${entry.metadata.label}: add at least one value before Run`);
      } else if (domain === "enums") {
        imageParams[id].values = [...read(domain, id, "picks")];
        if (!preview && !imageParams[id].values.length) throw new Error(`${entry.metadata.label}: choose at least one value before Run`);
      }
      else {
        const text = read(domain, id, "text");
        const substitutions = Object.fromEntries(templateLabels(text).map(label => [label, parseSemicolonList(read(domain, id, "tpl", label))]));
        imageParams[id].values = expandTextAxes(text, substitutions);
        if (!preview && !imageParams[id].values.length) throw new Error(`${entry.metadata.label}: enter values for every template label before Run`);
      }
    }
    const payload = freeze({ ranges, imageParams: compileDiscreteAxes(imageParams, parameters, catalogue.nodes), automaticNaming: true,
      prefix: read("naming", "root", "prefix"), suffix: read("naming", "root", "suffix"), ...(batch ? { relative: true } : {}) });
    recipeDispositions(snapshot, bindings);
    return { payload, uploads: [...new Map(uploads.map(item => [imageIdentity(item), item])).values()], uploadHashes };
  };
  const count = (payload, catalogue) => {
    const values = currentValues(catalogue);
    return permutationPlan(batch ? resolveRelativeRanges(payload.ranges, values) : payload.ranges, values, payload.imageParams).total;
  };
  const compatible = ticket => owns(ticket) && ticket.editRevision === recipe.revision() && !deciding && ticket.targets.every(originCurrent);
  const canClose = ticket => compatible(ticket) && ticket.closeGeneration === closeGeneration && acceptedRevision === ticket.editRevision;
  const publish = value => { result = Object.freeze(value); notify(); };

  seed("naming", "root", {}, { prefix: "", suffix: "" });
  return {
    rows: view,
    catalogue: catalogueRows,
    setEnabled(id, enabled) { const location = locations.find(row => row.id === id); if (!location) throw new Error(`Unknown parameter: ${id}`); return this.edit(location.domain, id, "enabled", enabled); },
    candidate(id, index, raw) {
      const values = [...row("candidates", id).values.candidates];
      if (index < 0 || index >= values.length) throw new Error("Unknown candidate");
      values[index] = raw; return this.edit("candidates", id, "candidates", values);
    },
    addCandidate(id) {
      const entry = row("candidates", id);
      return this.edit("candidates", id, "candidates", [...entry.values.candidates, entry.metadata.candidateKind === "connection" ? entry.baseline.candidates[0] : ""]);
    },
    removeCandidate(id, index) { return this.edit("candidates", id, "candidates", row("candidates", id).values.candidates.filter((_, i) => i !== index)); },
    moveCandidate(id, from, to) {
      const values = [...row("candidates", id).values.candidates];
      if (to < 0 || to >= values.length || from === to) return false;
      values.splice(to, 0, ...values.splice(from, 1)); return this.edit("candidates", id, "candidates", values);
    },
    pickCandidate(id, raw, on) {
      const entry = row("candidates", id), value = parseCandidate(entry.metadata, raw);
      const values = entry.values.candidates.filter(text => { try { return !sameJsonValue(parseExactJson(text), value); } catch { return true; } });
      if (on) values.push(raw); return this.edit("candidates", id, "candidates", values);
    },
    connectionNodes: () => (catalogues.get(capturedTargets[0].id)?.nodes ?? []).map(node => ({ ...node,
      label: `${node.title ?? node.type} #${node.id} (${node.outputs ? node.outputs.map((port, slot) => `${slot}: ${port.name ?? port.type} ${port.type}`).join(", ") : "ports unknown"})` })),
    connection(id, index, node, slot) {
      return this.candidate(id, index, stringifyExactJson({ node, slot }));
    },
    naming: name => row("naming", "root").values[name],
    dirty,
    running: () => running,
    result: () => {
      if (!result?.adopted || !dirty()) return result;
      return { ...result, state: "kept", reason: "Newer edits have been kept.", text: `submitted ${result.submitted}/${result.total} — newer edits have been kept` };
    },
    ready: () => catalogueReady,
    sourceInputs: origin => sourceRecord(inputCatalogues, origin) ?? { files: [], pending: false, error: "" },
    async loadSourceInputs(origin, retry = false) {
      if (!alive || !validOrigin(origin) || !sameOrigin(origin, currentOrigin(origin.source))) return;
      const record = sourceRecord(inputCatalogues, origin, () => ({ files: [], pending: false, error: "", loaded: false }));
      if (record.pending || record.loaded && !retry) return;
      record.pending = true; record.error = ""; notify();
      try {
        const data = await services.inputList(origin.source, origin);
        if (!alive || !sameOrigin(origin, currentOrigin(origin.source)) || sourceRecord(inputCatalogues, origin) !== record) return;
        if (!sameOrigin(data?.origin, origin) || !Array.isArray(data.files)) throw new Error("Source-bound input catalogue unavailable");
        record.files = data.files.map(file => typeof file === "string" ? file : file.name).filter(filename);
        record.loaded = true;
        if (sameOrigin(origin, capturedTargets[0].origin)) this.installInputs(data);
      } catch (error) { record.error = `${origin.source}: ${error.message}`; }
      finally {
        record.pending = false;
        if (alive && sameOrigin(origin, capturedTargets[0].origin))
          for (const [id] of recipe.entries("images")) seed("images", id, { filesReady: true }, {});
        notify();
      }
    },
    sourceInputState(id, origin, name) {
      const cached = cachedInput(origin, name), item = sameOrigin(origin, capturedTargets[0].origin)
        ? { kind: "input", name } : cached?.file ? uploadImage(cached.file) : null;
      return { selected: !!item && row("images", id).values.items.some(other => sameImage(item, other)),
        pending: !!cached?.pending && cached.wanted.has(id), error: cached?.error ?? "" };
    },
    async toggleSourceInput(id, origin, name) {
      if (!alive || deciding || !filename(name) || !validOrigin(origin) || !originCurrent(capturedTargets[0]) ||
        !sameOrigin(origin, currentOrigin(origin.source))) return false;
      if (sameOrigin(origin, capturedTargets[0].origin)) {
        const item = { kind: "input", name };
        return this.sourceInputState(id, origin, name).selected ? this.removeImage(id, item) : this.addImages(id, [item]);
      }
      const source = sourceRecord(sourceFiles, origin, () => ({ files: new Map() }));
      if (!source.files.has(name)) source.files.set(name, { file: null, pending: false, error: "", wanted: new Set() });
      const cached = source.files.get(name);
      if (cached.file) {
        cached.error = "";
        const item = uploadImage(cached.file);
        return this.sourceInputState(id, origin, name).selected ? this.removeImage(id, item) : this.addImages(id, [item]);
      }
      if (cached.wanted.has(id)) cached.wanted.delete(id); else cached.wanted.add(id);
      if (cached.pending) { notify(); return; }
      cached.pending = true; cached.error = ""; notify();
      try {
        const file = await services.readInput(origin, name);
        if (!alive || sourceRecord(sourceFiles, origin) !== source || !sameOrigin(origin, currentOrigin(origin.source))) return;
        if (!(file instanceof File) || file.name !== name) throw new Error("Invalid input image");
        cached.file = file;
        if (deciding || !originCurrent(capturedTargets[0])) throw new Error("Editor context changed; choose the image again when ready");
        for (const rowId of cached.wanted) this.addImages(rowId, [uploadImage(file)]);
      } catch (error) { cached.error = `${name}: ${error.message}`; }
      finally { cached.pending = false; cached.wanted.clear(); notify(); }
    },
    catalogueFailure(error) { publish({ text: `Catalogue unavailable: ${error.message ?? error}. Your edits have been kept.`, ok: false, state: "unavailable" }); },
    invalidateClose,
    decision(value) { deciding = !!value; notify(); },
    edit(domain, id, name, value) {
      if (!alive || deciding) return false;
      write(domain, id, name, value);
      if (domain === "images" && name === "items") inspectItems(id);
      recipe.edited(); invalidateClose(); notify(); return true;
    },
    addImages(id, items, index) {
      const entry = row("images", id);
      if (!entry) throw new Error("Unknown image row");
      // Unlike immutable Files, a removed disk path may now contain new bytes.
      for (const item of items) if (item.kind === "server-path" && !entry.values.items.some(other => sameImage(item, other))) imageChecks.get(id)?.delete(imageIdentity(item));
      return this.edit("images", id, "items", mergeImages(entry.values.items, items, index));
    },
    dropImages(id, resources, accepts) {
      const result = classifyImageFiles(resources, accepts);
      if (result.images.length) { this.setEnabled(id, true); this.addImages(id, result.images.map(uploadImage)); }
      return result.status;
    },
    async addFolder(id, path) {
      if (!alive || deciding || running) throw new Error("Finish the current action before adding a folder");
      const target = capturedTargets[0];
      if (!originCurrent(target)) throw new Error("Source origin changed; your images were kept");
      const result = await services.listFolder(path);
      if (!alive || deciding || running || !originCurrent(target)) throw new Error("The editor changed while reading the folder. Add it again when ready.");
      if (!validImageSet(result?.items) || result.items.some(item => item.kind !== "server-path")) throw new Error("Invalid folder image listing");
      this.addImages(id, result.items);
      return { count: result.items.length };
    },
    removeImage(id, item) {
      return this.edit("images", id, "items", row("images", id).values.items.filter(other => !sameImage(item, other)));
    },
    toggleTargetImage(id) {
      const item = { kind: "target" };
      return row("images", id).values.items.some(other => sameImage(item, other)) ? this.removeImage(id, item) : this.addImages(id, [item]);
    },
    moveImage(id, item, index) {
      const items = row("images", id).values.items, ordered = moveRecipeImage(items, item, index);
      return ordered !== items && this.edit("images", id, "items", ordered);
    },
    inspectImages: () => Promise.all([...pendingInspections]),
    range(id, { min, max }) {
      if (!alive || deciding) return false;
      if (!validValue("string", min) || !validValue("string", max) || !row("numeric", id)) throw new Error("Invalid range edit");
      write("numeric", id, "min", min); write("numeric", id, "max", max);
      recipe.edited(); invalidateClose(); notify(); return true;
    },
    template(id, label, value) {
      if (!alive || deciding) return false;
      if (typeof label !== "string" || !label.length || typeof value !== "string" || !row("texts", id)) throw new Error("Invalid template edit");
      const entry = row("texts", id);
      write("texts", id, "tpl", { ...entry.values.tpl, [label]: value });
      recipe.edited(); invalidateClose(); notify(); return true;
    },
    installCatalogue(data) {
      if (!alive) return;
      const target = capturedTargets[0];
      if (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin)) {
        publish({ text: "Source-bound catalogue unavailable; your edits have been kept.", ok: false, state: "unavailable" }); return;
      }
      parameterIndex(allParameters(data)); parameterIndex(catalogueParams(data));
      catalogues.set(target.id, freeze(snapshotDraft(data)));
      const legacy = new Map([...["params", "stringParams", "enumParams", "textParams"].flatMap((key, index) => (data[key] ?? []).map(parameter => [parameter.id, ["numeric", "images", "enums", "texts"][index]]))]);
      const names = new Map();
      for (const parameter of allParameters(data)) { const name = `${parameter.title ?? parameter.type}.${parameter.key}`; names.set(name, (names.get(name) ?? 0) + 1); }
      locations = allParameters(data).map(parameter => {
        const domain = data.parameters ? editorDomain(parameter) : legacy.get(parameter.id), initialized = ROW_STRATEGIES[domain].initialize(parameter, batch);
        const name = `${parameter.title ?? parameter.type}.${parameter.key}`;
        seed(domain, parameter.id, { ...parameter, label: parameterLabel(parameter), displayName: names.get(name) > 1 ? `${name} #${parameter.nodeIds[0]}` : name, ...initialized.metadata }, initialized.defaults);
        return { id: parameter.id, domain };
      }).sort((a, b) => {
        const left = row(a.domain, a.id).metadata, right = row(b.domain, b.id).metadata;
        return Number(/clip\s*text\s*encode/i.test(left.type)) - Number(/clip\s*text\s*encode/i.test(right.type)) ||
          (left.title ?? left.type).localeCompare(right.title ?? right.type) || left.key.localeCompare(right.key);
      });
      catalogueReady = true; notify();
    },
    installInputs(data) {
      if (!alive || !sameOrigin(data?.origin, capturedTargets[0].origin) || !Array.isArray(data.files)) return;
      const files = data.files.map(file => typeof file === "string" ? file : file.name).filter(filename);
      const record = sourceRecord(inputCatalogues, data.origin, () => ({}));
      Object.assign(record, { files, loaded: true, pending: false, error: "" });
      for (const [id] of recipe.entries("images")) { seed("images", id, { files, filesReady: true }, {}); inspectItems(id); }
    },
    preview() {
      const unavailable = (status, message) => ({ n: null, display: "—", fullCount: message, perImage: 0,
        anyEnabled: false, exact: false, status, message, breakdown: "", axes: [], excluded: 0, naming: { example: "", complete: false } });
      if (!catalogueReady) return unavailable("reading", "Reading workflow…");
      const snapshot = captureRows(), first = catalogues.get(capturedTargets[0].id);
      for (const [id, entry] of Object.entries(snapshot.numeric)) if (entry.values.enabled && entry.values.mode === "range" && increment(entry) === null) {
        return unavailable("invalid", `${entry.metadata.label}: enter a valid positive Step. Your text is kept.`);
      }
      try {
        const compiled = compile(snapshot, null, true), payload = compiled.payload;
        for (const [id, axis] of Object.entries(payload.imageParams)) if (axis.enabled && !axis.values.length) {
           const entry = snapshot.images[id] ?? snapshot.enums[id] ?? snapshot.texts[id] ?? snapshot.candidates[id];
          return unavailable("invalid", `${entry.metadata.label}: ${snapshot.images[id] ? "add at least one image" : snapshot.enums[id] ? "choose at least one value" : "enter values for every template label"}.`);
        }
        const values = currentValues(first), ranges = batch ? resolveRelativeRanges(payload.ranges, values) : payload.ranges;
        const plan = permutationPlan(ranges, values, payload.imageParams);
        const axes = plan.axes.map(axis => {
          const entry = snapshot.numeric[axis.id] ?? snapshot.images[axis.id] ?? snapshot.enums[axis.id] ?? snapshot.texts[axis.id] ?? snapshot.candidates[axis.id];
          return { id: axis.id, count: axis.length, name: entry.metadata.key.replace(/_/g, " "),
            kind: snapshot.images[axis.id] ? "images" : "values", label: entry.metadata.label };
        });
        const selected = [...recipe.entries("images")].filter(([, entry]) => entry.values.enabled)
          .flatMap(([id, entry]) => entry.values.items.map(item => imageView(id, item, entry.metadata)));
        const pending = selected.some(item => item.pending), error = selected.find(item => item.error)?.error;
        const perImage = plan.total, n = perImage * capturedTargets.length, safe = Number.isSafeInteger(n);
        const exact = !batch && !pending && !error && safe;
        const excluded = plan.axes.length ? plan.axes.reduce((number, axis) => number * axis.matches, 1) : 0;
        // One representative non-current tuple from the kernel, without allocating
        // the Cartesian product. Numeric matches form a contiguous interval.
        const sample = Object.fromEntries(plan.axes.map(axis => [axis.id, axis.at(0)]));
        if (plan.total && plan.axes.every(axis => axis.isCurrent(sample[axis.id]))) {
          const axis = plan.axes.find(axis => axis.matches < axis.length);
          if (axis) {
            let index = axis.matches;
            if (axis.isCurrent(axis.at(index))) index = 0;
            while (axis.isCurrent(axis.at(index))) index++;
            sample[axis.id] = axis.at(index);
          }
        }
        // Pending upload names are not resolved receipts and are never displayed
        // as real names. No sample or count authorizes an upload/graph assignment.
        const parameters = namingParameters(first), aliases = parameterAliases(parameters);
        const basename = capturedTargets[0].filename.split("/").pop().replace(/\.[^.]+$/, "");
        const source = first.outputNaming ?? { directory: "", sourceStem: basename };
        const projection = variationOutputName(source, { ...payload, ranges }, sample, values, aliases, parameters);
        const naming = { complete: projection.complete,
          example: projection.value.replace(/\0pending-\d+/g, "[upload name pending]"),
          help: "Representative first output; upload collision names and ComfyUI's added counter may differ." };
        const factors = [...axes].sort((a, b) => (a.kind !== "images") - (b.kind !== "images")).map(axis =>
          `${axis.count.toLocaleString("en-US")} ${axis.kind === "images" ? `input image${axis.count === 1 ? "" : "s"}` : `${axis.name} value${axis.count === 1 ? "" : "s"}`}`);
        const breakdown = factors.join(" × ") + (excluded ? ` · ${excluded} unchanged combination${excluded === 1 ? "" : "s"} excluded` : "")
          + (batch && axes.length ? ` · first-image estimate × ${capturedTargets.length} target images` : "");
        const status = !naming.complete || error ? "invalid" : pending ? "checking" : "ready";
        const message = !naming.complete ? "Unresolved naming token: check Prefix and Suffix." : error ? `Image comparison failed: ${error}`
          : pending ? "Checking images…" : !n ? "Choose a different value or image to create variations."
          : !safe ? "Estimate exceeds safe integer precision; the full value is approximate."
          : batch ? "Estimated from the first image; each target is checked before submission."
          : n > 100 ? "Large sweep: this many jobs will be queued. The engine validates its existing per-run limit." : "";
        return { n, perImage, anyEnabled: axes.length > 0, exact: exact && naming.complete, status, message, axes, excluded, breakdown, naming,
          display: n >= 1e6 ? n < 1e15 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 }).format(n)
            : n.toExponential(2).replace("e+", " × 10^") : n.toLocaleString("en-US"),
          fullCount: `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}${exact ? " variations" : " variations (estimate)"}` };
      } catch (error) { return unavailable("invalid", error.message); }
    },
    async run() {
      if (!alive) return { status: "stale" };
      if (running || deciding) return { status: "busy" };
      if (!catalogueReady) { publish({ text: "Inspecting source context; your edits have been kept.", ok: false, state: "unavailable" }); return { status: "invalid" }; }
      invalidateClose();
      const ticket = Object.freeze({ runId: createRunId(), editRevision: recipe.revision(), closeGeneration, snapshot: freeze(captureRows()), targets: capturedTargets });
      // Retain the captured inspection handles while they settle. Removing and
      // readding a path may replace live evidence, never this Run's evidence.
      const inspections = [...pendingInspections];
      const capturedChecks = new Map([...imageChecks].map(([id, checks]) => [id, new Map(checks)]));
      const operation = { compiled: null };
      active = ticket;
      let submitted = 0, total = 0, countsComplete = true, uncertain = false;
      const failures = [], uploads = new Map();
      const effects = { uploads: [], targets: [] };
      running = true; result = null; notify();
      try {
        await Promise.all(inspections);
        const runChecks = new Map([...capturedChecks].map(([id, checks]) => [id,
          new Map([...checks].map(([identity, value]) => [identity, freeze(snapshotDraft(value))]))]));
        const runEvidence = (id, item) => runChecks.get(id)?.get(imageIdentity(item));
        for (const target of ticket.targets) check(ticket, target);
        operation.compiled = compile(ticket.snapshot, null, false, runEvidence);
        if (operation.compiled.uploads.length && new Set(ticket.targets.map(target => target.origin?.address)).size > 1) throw new Error("Local-file variations across different backends are unsupported. Your files and edits have been kept.");
        for (const target of ticket.targets) check(ticket, target);
        const prepared = new Map();
        for (const target of ticket.targets) {
          check(ticket, target);
          const data = target.id === capturedTargets[0].id ? catalogues.get(target.id) : await services.probe(target);
          check(ticket, target);
          if (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin)) throw new Error("Source-bound catalogue unavailable; your work has been kept.");
          parameterIndex(catalogueParams(data));
          // Predicted names are only placeholders for carrier admission here;
          // final target plans below require the actual upload receipts.
          targetRunPlan(compile(ticket.snapshot, null, true, runEvidence, target).payload, data);
          prepared.set(target.id, data);
        }
        const uploadTarget = ticket.targets[0];
        for (const item of operation.compiled.uploads) {
          check(ticket, uploadTarget);
          try {
            const identity = imageIdentity(item), hash = operation.compiled.uploadHashes.get(identity);
            let receipt;
            if (item.kind === "server-path") receipt = await services.uploadPath(uploadTarget.host, item.path, hash, uploadTarget.origin);
            else {
              const form = new FormData(); form.append("image", item.file, item.name);
              receipt = await services.uploadInput(uploadTarget.host, form, uploadTarget.origin);
            }
            if (!filename(receipt?.name) || !sameOrigin(receipt.origin, uploadTarget.origin)) throw new Error(`${item.name}: upload acknowledgement unavailable; your image was kept`);
            effects.uploads.push(snapshotDraft(receipt));
            check(ticket, uploadTarget);
            uploads.set(identity, freeze(snapshotDraft(receipt)));
            confirmedUploads.set(receipt.name, hash);
          } catch (error) {
            if (filename(error.uploaded?.name) && sameOrigin(error.uploaded?.origin, uploadTarget.origin)) effects.uploads.push(snapshotDraft(error.uploaded));
            check(ticket, uploadTarget); failures.push(error.message);
          }
        }
        const uploadFailure = failures.length > 0;
        if (uploadFailure) throw new Error(failures[0]);
        operation.compiled = compile(ticket.snapshot, uploads, false, runEvidence);
        // Capture every immutable target plan before dispatch, including explicit
        // heterogeneous relative-axis exclusions. No later live recipe reads.
        operation.targetPlans = freeze(ticket.targets.map(target => {
          const catalogue = prepared.get(target.id), plan = targetRunPlan(compile(ticket.snapshot, uploads, false, runEvidence, target).payload, catalogue);
          const request = { id: target.id, host: target.host, filename: target.filename, ...snapshotDraft(plan.payload), context: catalogue.context,
            acknowledgement: { version: 2, runId: ticket.runId, requestId: createRunId() } };
          return { target, operations: plan.operations, request, expectedTotal: count(request, catalogue) };
        }));
        const proofs = [];
        await Promise.all(operation.targetPlans.map(async ({ target, request, expectedTotal }) => {
          try {
            check(ticket, target);
            if ([...uploads.values()].some(receipt => !physicalMatch(receipt.origin, target.origin))) throw new Error("Upload resource origin changed; no follow-up was authorized");
            const context = request.context;
            let response;
            try { response = await services.run(request); }
            catch (error) {
              uncertain = true;
              effects.targets.push({ id: target.id, requestId: request.acknowledgement.requestId, outcome: "uncertain", error: error.message });
              throw error;
            }
            const data = response.data;
            effects.targets.push({ id: target.id, requestId: request.acknowledgement.requestId, status: response.status, data: snapshotDraft(data) });
            if (Number.isSafeInteger(data?.submitted) && data.submitted >= 0) submitted += data.submitted;
            if (Number.isSafeInteger(data?.total) && data.total >= 0) total += data.total;
            if (!response.ok || !Number.isSafeInteger(data?.submitted) || !Number.isSafeInteger(data?.total) || data.total <= 0 || data.submitted !== data.total ||
              !Array.isArray(data.errors ?? []) || data.errors?.length) countsComplete = false;
            check(ticket, target);
            if (!response.ok) { failures.push(`${target.filename}: ${data?.error ?? response.text ?? `error ${response.status}`}`); return; }
            const proof = acknowledgedFields(request, data);
            for (const error of Array.isArray(data?.errors) ? data.errors : []) failures.push(error?.error ?? String(error));
            if (!proof || data.total !== expectedTotal || !sameContext(context, data.acknowledgement?.context)) {
              uncertain ||= data.outcome === "uncertain-effects" || data.submitted === data.total && !data.errors?.length;
              failures.push("submission acknowledgement unavailable; your edits have been kept.");
            }
            else proofs.push(proof);
          } catch (error) { countsComplete = false; failures.push(`${target.filename}: ${error.message}`); }
        }));
        if (!owns(ticket)) return { status: "stale" };
        const complete = !uploadFailure && failures.length === 0 && proofs.length === ticket.targets.length;
        const eligible = complete && compatible(ticket);
        if (eligible) acceptedRevision = ticket.editRevision;
        const summary = batch ? `submitted ${submitted}/${total} across ${ticket.targets.length} images` : `submitted ${submitted}/${total}`;
        const reason = failures[0] ?? (!eligible ? deciding ? "leave decision pending; your edits have been kept" : recipe.revision() !== ticket.editRevision ? "newer edits have been kept" : "operation context changed; your edits have been kept"
          : "");
        publish({ text: submitted || total ? summary + (reason ? ` — ${reason}` : "") : reason || "nothing submitted", reason, ok: complete,
          state: eligible ? "adopted" : complete ? "kept" : "unavailable", submitted, total, adopted: eligible,
          effects: freeze(snapshotDraft(effects)), outcome: complete ? "accepted-plan" : !ticket.targets.every(originCurrent) ? "retired" : uncertain ? "uncertain-effects" : submitted ? "partial-effects" : "rejected" });
        if (canClose(ticket)) timer = setTimer(() => { timer = null; if (canClose(ticket)) close(); }, 3000);
        return { status: submitted > 0 && countsComplete && !uploadFailure ? "submitted" : "failed", submitted, total, adopted: eligible };
      } catch (error) {
        if (owns(ticket)) publish({ text: error.message, ok: false, state: error.stale ? "stale" : "invalid", outcome: error.stale ? "retired" : "rejected", submitted, total, adopted: false, effects: freeze(snapshotDraft(effects)) });
        return { status: owns(ticket) ? error.stale ? "stale" : "invalid" : "stale", submitted, total, adopted: false };
      } finally { if (owns(ticket)) { running = false; notify(); } }
    },
    dispose() { alive = false; invalidateClose(); active = null; sourceFiles.clear(); inputCatalogues.clear(); },
  };
}
