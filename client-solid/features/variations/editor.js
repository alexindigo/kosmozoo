// Dialog-private Run owner over its raw recipe. Catalogue and image
// evidence are readonly context; compilation classifies every captured leaf.
import { snapshotDraft, createRunId } from "./draft.js";
import { editorDomain, choiceValues, numericDefaults, numericText, sliderNumber } from "./graph.mjs";
import { parseExactJson, stringifyExactJson, sameJsonValue, resourceReferenceValue, resourceReferenceProblem } from "/shared/parameters.mjs";
import { admitResourceTransfer } from "/shared/features/variations/compile.mjs";
import { compileRecipe, parseRecipeCandidate, recipeImageView, currentRoot } from "/shared/features/variations/recipe-compile.mjs";
import { acknowledgedHistoryFields, planHistoryOverlay, decodeHistoryRecipe } from "/shared/features/variations/history-codec.mjs";
import { permutationPlan,
  resolveRelativeRanges, acknowledgedFields, targetRunPlan, catalogueParams, parameterIndex, parameterCurrent, parameterLabel, parameterAliases,
   variationOutputName, uploadFamily } from "/shared/features/variations/shared.mjs";
import { validOrigin, sameOrigin, validContext, sameContext } from "/shared/source-origin.mjs";
import { validImageSet, mergeImages, sameImage, imageIdentity, imageReference, imageReferenceValue, uploadImage } from "./image-set.js";
import { classifyImageFiles } from "./image-drop.js";
import { connectionPresentation } from "./field-filter.js";
import { makeVariationRecipe, validRecipeValue as validValue, freezeRecipe as freeze, moveRecipeImage } from "./recipe.js";
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
  images: { initialize: p => ({ metadata: { files: [], filesReady: false },
    defaults: { enabled: false, items: [{ kind: "reference", value: parameterCurrent(p) }] } }) },
  enums: { initialize: p => ({ metadata: { values: choiceValues(p) }, defaults: { enabled: false, picks: [parameterCurrent(p)] } }) },
  texts: { initialize: p => ({ defaults: { enabled: false, text: parameterCurrent(p), tpl: {} } }) },
  candidates: { initialize: p => ({ metadata: { candidateKind: p.valueKind === "connection" ? "connection" : choiceValues(p)?.length ? "options" : typeof parameterCurrent(p) === "boolean" ? "boolean" : "json",
    options: choiceValues(p)?.length ? choiceValues(p) : typeof parameterCurrent(p) === "boolean" ? [true, false] : null },
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
  const sourceLifetimes = new Map();
  const sourceRecord = (map, origin, create, root = "input") => {
    if (sameOrigin(origin, currentOrigin(origin.source)) && !sameOrigin(sourceLifetimes.get(origin.source), origin)) {
      for (const records of [inputCatalogues, sourceFiles]) for (const [key, record] of records)
        if (record.origin.source === origin.source) records.delete(key);
      sourceLifetimes.set(origin.source, freeze(snapshotDraft(origin)));
    }
    const key = JSON.stringify([origin.source, root]), previous = map.get(key);
    if (previous && sameOrigin(previous.origin, origin)) return previous;
    if (!create) return null;
    const record = { origin: freeze(snapshotDraft(origin)), ...create() };
    map.set(key, record); return record;
  };
  const cachedInput = (origin, name, root) => sourceRecord(sourceFiles, origin, null, root)?.files.get(name);
  const reference = (name, root) => ({ kind: "reference", value: resourceReferenceValue(name, root) });
  const resourceName = name => typeof name === "string" && !resourceReferenceProblem(null, name);
  const batch = capturedTargets.length > 1;
  let alive = true, closeGeneration = 0, decisionGeneration = 0, deciding = false, active = null, timer = null;
  let result = null, running = false, catalogueReady = false, acceptedRevision = null, restoredWork = false;
  const heldRecords = new Map();
  const row = recipe.row;
  const evidence = (id, item) => imageChecks.get(id)?.get(imageIdentity(item));
  const imageView = (id, item, metadata, lookup = evidence) => recipeImageView(item, metadata, lookup(id, item), capturedTargets[0], batch);
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
  const dirty = () => acceptedRevision === null ? restoredWork || recipe.dirty() : recipe.revision() !== acceptedRevision;
  const parseCandidate = (parameter, raw) => parseRecipeCandidate(parameter, raw, catalogues.get(capturedTargets[0].id)?.nodes);
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
  // Byte/catalogue facts can outlive a choice. Only the row's current membership
  // ticket admits an async edit; ordinary recipe revisions and browsing do not.
  const membershipGenerations = new Map();
  const membershipTicket = id => ({ id, decision: decisionGeneration, row: membershipGenerations.get(id) });
  const admitsMembership = ticket => alive && !deciding && originCurrent(capturedTargets[0]) &&
    ticket.decision === decisionGeneration && ticket.row === membershipGenerations.get(ticket.id);
  const retireMembership = id => { membershipGenerations.set(id, (membershipGenerations.get(id) ?? 0) + 1); };
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
      if (item.kind === "target" || item.kind === "archive" || imageReference(item) || checks.has(imageIdentity(item))) continue;
      const check = { pending: true }, identity = imageIdentity(item); checks.set(identity, check);
      let finish;
      const pending = new Promise(resolve => { finish = resolve; }); pendingInspections.add(pending);
      inspectionQueue.push(async () => {
        try {
          if (!alive || !originCurrent(target)) throw new Error("Source origin changed; your images were kept");
          const inspect = item.kind === "server-path" ? services.inspectPath : services.inspectImage;
          const result = await inspect(target.host, item.kind === "server-path" ? item.path : item.file, entry.metadata.current, currentRoot(entry.metadata), target.origin, uploadFamily(item.name, entry.metadata.files));
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
  const compile = (snapshot, uploadReceipts = null, preview = false, lookup = evidence, target = capturedTargets[0]) =>
    compileRecipe(snapshot, { catalogue: catalogues.get(capturedTargets[0].id), target, batch, lookup, uploadReceipts, confirmedUploads, preview });
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
    revision: recipe.revision,
    async planRecall(saved) {
      const revision = recipe.revision();
      if (!alive || deciding || running) throw new Error("Finish the current action before recalling history");
      const cohort = [];
      for (const target of capturedTargets) {
        if (!originCurrent(target)) throw new Error("Source origin changed; reopen Variations before recalling");
        const data = catalogues.get(target.id) ?? await services.probe(target);
        if (!alive || deciding || running || recipe.revision() !== revision || !originCurrent(target)) throw new Error("Editor changed while reading history; choose it again");
        cohort.push(data);
      }
      const plan = planHistoryOverlay(saved, captureRows(), cohort, batch ? "bulk" : "single");
      return { ...plan, revision, id: saved.id, leaseId: saved.leaseId, record: saved };
    },
    applyRecall(plan) {
      if (!alive || deciding || running || plan.revision !== recipe.revision() || !capturedTargets.every(originCurrent)) return { status: "stale" };
      if (!plan.patch.length) return { status: "unchanged" };
      for (const id of new Set(plan.patch.filter(field => field.domain === "images" && field.name === "items").map(field => field.id))) retireMembership(id);
      for (const field of plan.patch) write(field.domain, field.id, field.name, field.value);
      heldRecords.set(plan.leaseId, plan.record);
      recipe.edited(); invalidateClose(); notify();
      return { status: "applied" };
    },
    restoreHistory(record) {
      if (!alive || catalogueReady || recipe.revision()) throw new Error("History requires a fresh editor");
      for (const target of record.targets) catalogues.set(target.id, freeze(snapshotDraft({ ...target.catalogue, context: target.context })));
      // Archived catalogues are readonly facts, not fresh authority. The explicit
      // opening's matched contexts fence Run independently, including offline use.
      this.installCatalogue({ ...record.targets[0].catalogue, context: record.targets[0].context }, true);
      recipe.restore(decodeHistoryRecipe(record));
      restoredWork = true; heldRecords.set(record.leaseId, record); notify();
    },
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
    connectionNodes: id => connectionPresentation(row("candidates", id).metadata, catalogues.get(capturedTargets[0].id)?.nodes ?? []),
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
    sourceInputs: (origin, root = "input") => sourceRecord(inputCatalogues, origin, null, root) ?? { files: [], pending: false, error: "" },
    async loadSourceInputs(origin, retry = false, root = "input") {
      if (!alive || !["input", "output"].includes(root) || !validOrigin(origin) || !sameOrigin(origin, currentOrigin(origin.source))) return;
      const record = sourceRecord(inputCatalogues, origin, () => ({ files: [], pending: false, error: "", loaded: false }), root);
      const ownsRecord = () => alive && sameOrigin(origin, currentOrigin(origin.source)) && sourceRecord(inputCatalogues, origin, null, root) === record;
      if (record.pending || record.loaded && !retry) return;
      record.pending = true; record.error = ""; notify();
      try {
        const data = await services.inputList(origin.source, origin, root);
        if (!ownsRecord()) return;
        if (!sameOrigin(data?.origin, origin) || data.root !== root || !Array.isArray(data.files)) throw new Error("Source-bound image catalogue unavailable");
        record.files = data.files.map(file => typeof file === "string" ? file : file.name).filter(resourceName);
        record.loaded = true;
        if (root === "input" && sameOrigin(origin, capturedTargets[0].origin)) this.installInputs(data);
      } catch (error) { if (ownsRecord()) record.error = `${origin.source}: ${error.message}`; }
      finally {
        if (!ownsRecord()) return;
        record.pending = false;
        if (root === "input" && sameOrigin(origin, capturedTargets[0].origin))
          for (const [id] of recipe.entries("images")) seed("images", id, { filesReady: true }, {});
        notify();
      }
    },
    sourceInputState(id, origin, name, root = "input") {
      const cached = cachedInput(origin, name, root), item = sameOrigin(origin, capturedTargets[0].origin)
        ? reference(name, root) : cached?.file ? uploadImage(cached.file) : null;
      return { selected: !!item && row("images", id).values.items.some(other => sameImage(item, other)),
        pending: !!cached?.pending && cached.wanted.has(id) && admitsMembership(cached.wanted.get(id)), error: cached?.error ?? "" };
    },
    async toggleSourceInput(id, origin, name, root = "input") {
      if (!alive || deciding || !["input", "output"].includes(root) || !resourceName(name) || !validOrigin(origin) || !originCurrent(capturedTargets[0]) ||
        !sameOrigin(origin, currentOrigin(origin.source))) return false;
      if (sameOrigin(origin, capturedTargets[0].origin)) {
        const item = reference(name, root);
        return this.sourceInputState(id, origin, name, root).selected ? this.removeImage(id, item) : this.addImages(id, [item]);
      }
      const source = sourceRecord(sourceFiles, origin, () => ({ files: new Map() }), root);
      const ownsRead = () => alive && sourceRecord(sourceFiles, origin, null, root) === source && sameOrigin(origin, currentOrigin(origin.source));
      if (!source.files.has(name)) source.files.set(name, { file: null, pending: false, error: "", wanted: new Map() });
      const cached = source.files.get(name);
      if (cached.file) {
        cached.error = "";
        const item = uploadImage(cached.file);
        return this.sourceInputState(id, origin, name, root).selected ? this.removeImage(id, item) : this.addImages(id, [item]);
      }
      if (cached.wanted.has(id) && admitsMembership(cached.wanted.get(id))) cached.wanted.delete(id);
      else cached.wanted.set(id, membershipTicket(id));
      if (cached.pending) { notify(); return; }
      cached.pending = true; cached.error = ""; notify();
      try {
        const resource = await services.readInput(origin, name, root);
        if (!ownsRead()) return;
        if (!(resource instanceof File) || resource.name !== name) throw new Error("Invalid input image");
        // The resource port retains its full raw name. Uploads have their own
        // flat namespace; the editor owns that leaf-named File, not the API.
        const file = name.includes("/") ? new File([resource], name.split("/").at(-1), { type: resource.type, lastModified: resource.lastModified }) : resource;
        cached.file = file;
        for (const [rowId, ticket] of [...cached.wanted]) {
          if (cached.wanted.get(rowId) !== ticket) continue;
          cached.wanted.delete(rowId);
          if (admitsMembership(ticket)) this.addImages(rowId, [uploadImage(file)]);
        }
      } catch (error) { if (ownsRead()) { cached.wanted.clear(); cached.error = `${name}: ${error.message}`; } }
      finally { if (ownsRead()) { cached.pending = false; notify(); } }
    },
    catalogueFailure(error) { publish({ text: `Catalogue unavailable: ${error.message ?? error}. Your edits have been kept.`, ok: false, state: "unavailable" }); },
    invalidateClose,
    decision(value) { deciding = !!value; if (deciding) decisionGeneration++; notify(); },
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
      const ticket = membershipTicket(id);
      const result = await services.listFolder(path);
      if (running || !admitsMembership(ticket)) throw new Error("The editor changed while reading the folder. Add it again when ready.");
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
    installCatalogue(data, archived = false) {
      if (!alive) return;
      const target = capturedTargets[0];
      if (!archived && (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin))) {
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
      if (!alive || data?.root && data.root !== "input" || !sameOrigin(data?.origin, capturedTargets[0].origin) || !Array.isArray(data.files)) return;
      const files = data.files.map(file => typeof file === "string" ? file : file.name).filter(resourceName);
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
        const compiled = compile(snapshot, null, true), payload = compiled.estimate;
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
        const saved = services.history ? await services.history.capture(ticket,
          new Map([...catalogues].map(([id, catalogue]) => [id, catalogue.context])), target => check(ticket, target)) : null;
        await Promise.all(inspections);
        const runChecks = new Map([...capturedChecks].map(([id, checks]) => [id,
          new Map([...checks].map(([identity, value]) => [identity, freeze(snapshotDraft(value))]))]));
        const runEvidence = (id, item) => runChecks.get(id)?.get(imageIdentity(item));
        for (const target of ticket.targets) check(ticket, target);
        let uploadFailure = false;
        if (saved) operation.targetPlans = freeze(await services.history.plans(ticket, saved, target => check(ticket, target)));
        else {
        // Explicit narrow legacy service rigs retain their old wire contract.
        // Application installation always supplies history and rejects unbound
        // Run requests; capture failures never enter this compatibility branch.
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
          // Every target admits the same plan before any transfer: carriers from
          // the count estimate, transfers by that target's own resource contract.
          // Final target plans below require the actual upload receipts.
          const planned = compile(ticket.snapshot, null, true, runEvidence, target), carriers = parameterIndex(allParameters(data));
          for (const id of Object.keys(planned.transfers)) if (carriers.has(id)) admitResourceTransfer(carriers.get(id));
          targetRunPlan(planned.estimate, data);
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
        uploadFailure = failures.length > 0;
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
        }
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
             const proof = request.history ? acknowledgedHistoryFields(request, data) : acknowledgedFields(request, data);
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
       } finally {
         if (services.history) {
           try { await services.history.finish(ticket.runId, result?.ok ? null : result?.reason ?? result?.text ?? null); }
           catch (error) { if (owns(ticket)) publish({ ...result, historyError: error.message, text: `${result?.text ?? "Run ended"}; history refresh failed: ${error.message}` }); }
         }
         if (owns(ticket)) { running = false; notify(); }
       }
    },
    dispose() {
      alive = false; invalidateClose(); active = null; sourceFiles.clear(); inputCatalogues.clear(); sourceLifetimes.clear();
      for (const record of heldRecords.values()) services.history?.release(record).catch(() => {});
      heldRecords.clear();
    },
  };
}
