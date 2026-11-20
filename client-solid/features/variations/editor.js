// Dialog-private Run owner over its raw recipe. Catalogue and image
// evidence are readonly context; compilation classifies every captured leaf.
import { snapshotDraft, createRunId } from "./draft.js";
import { editorDomain, choiceValues, numericDefaults, numericText, sliderNumber } from "./graph.mjs";
import { parseExactJson, stringifyExactJson, sameJsonValue, resourceReferenceValue, resourceReferenceProblem } from "/shared/parameters.mjs";
import { admitResourceTransfer } from "/shared/features/variations/compile.mjs";
import { compileRecipe, compileNumericOperation, parseRecipeCandidate, recipeImageView, currentRoot } from "/shared/features/variations/recipe-compile.mjs";
import { acknowledgedHistoryFields, planHistoryOverlay, decodeHistoryRecipe, encodeHistoryRecipe } from "/shared/features/variations/history-codec.mjs";
import { permutationPlan,
  resolveRelativeRanges, acknowledgedFields, targetRunPlan, catalogueParams, parameterIndex, parameterCurrent, parameterLabel, parameterAliases,
   variationOutputName, uploadFamily, reproducesOriginal } from "/shared/features/variations/shared.mjs";
import { validOrigin, sameOrigin, validContext, sameContext } from "/shared/source-origin.mjs";
import { validImageSet, mergeImages, sameImage, imageIdentity, imageReference, imageReferenceValue, uploadImage } from "./image-set.js";
import { classifyImageFiles } from "./image-drop.js";
import { connectionPresentation, connectionProblem } from "./field-filter.js";
import { estimateGenerationTime, knownGenerationTime } from "./time-estimate.js";
import { observeSubmission } from "./submission-progress.js";
import { planPresentation } from "./plan-presentation.js";
import { variationProblem, problemFrom, problemText } from "/shared/features/variations/problems.mjs";
import { makeProblemOwner } from "./problem-presentation.js";
import { staleSource, sourceFailure } from "./source-message.js";
import { judgmentVisible } from "/js/image-visibility-model.mjs";
import { isEntryLeaf } from "/shared/entry-path.mjs";
import { makeVariationRecipe, validRecipeValue as validValue, freezeRecipe as freeze, moveRecipeImage, recipeField } from "./recipe.js";
export { RECIPE_FIELDS as EDITOR_FIELDS } from "./recipe.js";
const filename = isEntryLeaf;
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

export function makeVariationEditor({ targets, cohortMode, destination: initialDestination = null, services, currentOrigin, changed = () => {}, close = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const recipe = makeVariationRecipe();
  const problems = makeProblemOwner(changed);
  const parameter = id => ({ id, label: locations.find(location => location.id === id) ? row(locations.find(location => location.id === id).domain, id).metadata.label : id });
  const targetIdentity = target => ({ index: capturedTargets.indexOf(target), id: target.id, source: target.host, name: target.filename });
  const report = (key, code, context = {}) => problems.report(key, variationProblem(code, context));
  let submission = null, stopProgress = null;
  const capturedTargets = freeze(snapshotDraft(targets));
  // Opening facts and recipe basis stay stable; only the private Run cohort shrinks.
  let selectedTargets = capturedTargets;
  // Where the Run executes, chosen independently of the targets' sources. Its
  // catalogue's conflicts are readonly facts; until it is inspected Run waits.
  let destination = validOrigin(initialDestination) ? freeze(snapshotDraft(initialDestination)) : null;
  let conflicts = {}, unchecked = [], destinationPending = !!destination;
  // A failed catalogue request is a state with a way out, never a silent wait.
  let catalogueError = null;
  let validationCache = null;
  const catalogues = new Map();
  const generationTimes = new Map(capturedTargets.map(target => [target.id, knownGenerationTime(target.generationTimeMs) ? target.generationTimeMs : null]));
  const timingController = new AbortController();
  let timingTask = null;
  let locations = [];
  const imageChecks = new Map(), confirmedUploads = new Map();
  const inputCatalogues = new Map(), sourceFiles = new Map(), pexelsFiles = new Map();
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
  const fileRecord = (files, name) => {
    if (!files.has(name)) files.set(name, { file: null, pending: false, error: "", wanted: new Map() });
    return files.get(name);
  };
  // Remote bytes become one cached immutable File per resource. A toggle while
  // reading records/withdraws only that row's membership intent; the settled
  // File joins every row whose ticket is still admitted.
  const cachedFileState = (id, cached) => {
    const item = cached?.file ? uploadImage(cached.file) : null;
    return { selected: !!item && row("images", id).values.items.some(other => sameImage(item, other)),
      pending: !!cached?.pending && cached.wanted.has(id) && admitsMembership(cached.wanted.get(id)), error: cached?.error ?? "" };
  };
  const toggleCachedFile = async (editor, id, cached, label, read, owns) => {
    if (cached.file) {
      cached.error = "";
      const item = uploadImage(cached.file);
      return cachedFileState(id, cached).selected ? editor.removeImage(id, item) : editor.addImages(id, [item]);
    }
    if (cached.wanted.has(id) && admitsMembership(cached.wanted.get(id))) cached.wanted.delete(id);
    else cached.wanted.set(id, membershipTicket(id));
    // Recorded intent is an edit in progress: a post-Run countdown cannot close over it.
    invalidateClose();
    if (cached.pending) { notify(); return; }
    cached.pending = true; cached.error = ""; notify();
    try {
      const file = await read();
      if (!owns()) {
        if (alive) for (const [rowId] of cached.wanted) report(`acquire:${rowId}`, "acquisition-retired", { phase: "acquisition", parameter: parameter(rowId), resource: label });
        cached.wanted.clear(); return;
      }
      cached.file = file;
      for (const [rowId, ticket] of [...cached.wanted]) {
        if (cached.wanted.get(rowId) !== ticket) continue;
        cached.wanted.delete(rowId);
        if (admitsMembership(ticket)) editor.addImages(rowId, [uploadImage(file)]);
        else if (alive && ticket.decision === decisionGeneration && ticket.row === membershipGenerations.get(rowId)) report(`acquire:${rowId}`, "acquisition-retired", { phase: "acquisition", parameter: parameter(rowId), resource: label });
      }
    } catch (error) {
      if (owns()) { cached.wanted.clear(); cached.error = `${label}: ${error.message}`; }
      else {
        if (alive) for (const [rowId] of cached.wanted) report(`acquire:${rowId}`, "acquisition-retired", { phase: "acquisition", parameter: parameter(rowId), resource: label });
        cached.wanted.clear();
      }
    }
    finally { cached.pending = false; if (owns()) notify(); }
  };
  const reference = (name, root) => ({ kind: "reference", value: resourceReferenceValue(name, root) });
  const resourceName = name => typeof name === "string" && !resourceReferenceProblem(null, name);
  const batch = cohortMode === "bulk" || capturedTargets.length > 1;
  let alive = true, closeGeneration = 0, decisionGeneration = 0, deciding = false, active = null, timer = null;
  let result = null, running = false, catalogueReady = false, acceptedRevision = null, restoredWork = false;
  let enginePlan = null, enginePlanPending = false, enginePlanError = "", planKey = null, planGeneration = 0, planTimer = null, planController = null;
  const previewId = createRunId(), runProblems = new Map(), runOutcomes = new Map();
  let queuedCohort = null;
  const heldRecords = new Map();
  const row = recipe.row;
  const evidence = (id, item) => imageChecks.get(id)?.get(imageIdentity(item));
  const imageView = (id, item, metadata, lookup = evidence) => recipeImageView(item, metadata, lookup(id, item), capturedTargets[0], batch);
  const restoreQueuedCohort = () => {
    if (selectedTargets.length || !queuedCohort) return;
    selectedTargets = queuedCohort.targets;
    for (const [id, outcome] of queuedCohort.outcomes) runOutcomes.set(id, outcome);
    planKey = null;
  };
  const notify = () => {
    if (!alive) return;
    validationCache = null;
    // The successful close countdown is still an editable session. A new raw
    // revision must retain the last issued subjects, not become targetless work.
    if (!running && queuedCohort && recipe.revision() !== queuedCohort.revision) restoreQueuedCohort();
    reconcilePlan(); changed();
  };
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
         ...(domain === "candidates" ? { connectionProblem: entry.metadata.candidateKind === "connection" ? connectionProblem(entry.metadata, catalogues.get(capturedTargets[0].id)?.nodes ?? []) : null, choices: candidateChoices(entry), candidateViews: entry.values.candidates.map((raw, index) => {
          let value = null, error = "";
          try { value = parseExactJson(raw); parseCandidate(entry.metadata, raw); } catch (problem) { error = problem.message; }
          return { raw, index, error, label: raw,
            node: value?.node ?? "", slot: value?.slot ?? "" };
        }) } : {}),
       ...(domain === "images" ? { images: entry.values.items.map(item => imageView(id, item, entry.metadata)) } : {}),
         problems: problems.project(validationProblems()).fields.get(id) ?? [], conflict: conflictFor(id) })])));
  const conflictFor = id => {
    const conflict = conflicts[id];
    if (!conflict) return null;
    if (conflict.kind === "value") {
      const location = locations.find(entry => entry.id === id), entry = location && row(location.domain, id);
      const values = !entry?.values.enabled ? null : location.domain === "enums" ? entry.values.picks
        : location.domain === "candidates" ? entry.values.candidates.map(raw => { try { return parseExactJson(raw); } catch { return undefined; } }) : null;
      if (values?.length && values.every(value => conflict.choices.some(choice => sameJsonValue(choice, value)))) return null;
    }
    return { ...conflict, host: destination?.source ?? "", parameter: parameter(id), target: targetIdentity(capturedTargets[0]) };
  };
  const unresolvedConflicts = () => locations.filter(entry => conflictFor(entry.id)).length;
  const catalogueProblem = () => catalogueError;
  const conflictMessage = count => problemText(variationProblem("destination-conflicts", { phase: "destination", target: targetIdentity(capturedTargets[0]), destination: destination?.source, numbers: { conflicts: count }, names: locations.filter(entry => conflictFor(entry.id)).map(entry => parameter(entry.id).label) }));
  const destinationMessage = () => unchecked.length ? problemText(variationProblem("destination-unchecked", { severity: "warning", phase: "destination", target: targetIdentity(capturedTargets[0]), destination: destination?.source, names: unchecked.map(id => parameter(id).label) })) : "";
  const dirty = () => acceptedRevision === null ? restoredWork || selectedTargets.length !== capturedTargets.length || recipe.dirty() : recipe.revision() !== acceptedRevision;
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
    if (ticket.destination && !sameOrigin(ticket.destination, currentOrigin(ticket.destination.source))) throw Object.assign(new Error(staleSource(ticket.destination.source)), { stale: true });
    if (!originCurrent(target)) throw Object.assign(new Error(staleSource(target.host)), { stale: true });
  };
  const physicalMatch = (a, b) => validOrigin(a) && validOrigin(b) && a.address === b.address && a.kind === b.kind && a.incarnation === b.incarnation;
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
          if (!alive || !originCurrent(target)) throw new Error(staleSource(target.host));
          const inspect = item.kind === "server-path" ? services.inspectPath : services.inspectImage;
          const result = await inspect(target.host, item.kind === "server-path" ? item.path : item.file, entry.metadata.current, currentRoot(entry.metadata), target.origin, uploadFamily(item.name, entry.metadata.files));
          if (!alive || !originCurrent(target) || !sameOrigin(result?.origin, target.origin)) throw new Error(staleSource(target.host));
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
  const validationProblems = () => {
    if (validationCache) return validationCache;
    const found = (enginePlan ?? []).flatMap(target => [target.problem, ...(target.notices ?? [])]).filter(problem => problem?.action);
    if (!catalogueReady) return found;
    for (const id of unchecked) found.push(variationProblem("destination-unchecked", { severity: "warning", phase: "destination", target: targetIdentity(capturedTargets[0]), parameter: parameter(id), destination: destination?.source, names: [parameter(id).label] }));
    for (const [id, entry] of recipe.entries("images")) if (entry.values.enabled) {
      const states = entry.values.items.map(item => imageView(id, item, entry.metadata)), pending = states.filter(item => item.pending);
      if (pending.length) found.push(variationProblem("images-checking", { severity: "warning", phase: "comparison", parameter: parameter(id), resource: pending[0].name, numbers: { pending: pending.length, selected: states.length } }));
    }
    try {
      const snapshot = captureRows();
      for (const entry of Object.values(snapshot.numeric)) if (entry.values.enabled) compileNumericOperation(entry.values, entry.metadata, { batch });
      compile(snapshot, null, true);
    } catch (error) { if (error.problem) found.push(problemFrom(error, { target: targetIdentity(capturedTargets[0]) })); }
    return validationCache = found;
  };
  // A request names both hosts: the image's own and the one it runs on.
  const count = (request, catalogue) => {
    const values = currentValues(catalogue);
    return permutationPlan(batch ? resolveRelativeRanges(request.ranges, values) : request.ranges, values, request.imageParams,
      { sameHost: reproducesOriginal(request.host, request.context?.origin?.source) }).total;
  };
  const compatible = ticket => owns(ticket) && ticket.editRevision === recipe.revision() && !deciding && ticket.targets.every(originCurrent);
  const canClose = ticket => compatible(ticket) && ticket.closeGeneration === closeGeneration && acceptedRevision === ticket.editRevision;
  const publish = value => { result = Object.freeze(value); notify(); };

  const planInput = () => {
    const encoded = encodeHistoryRecipe(captureRows(), previewId);
    const resources = encoded.resources.map(resource => {
      const file = encoded.files.get(resource.id);
      const check = [...recipe.entries("images")].flatMap(([id, entry]) => entry.values.items.map(item => ({ item, check: evidence(id, item) })))
        .find(record => file ? record.item.file === file : resource.kind === "server-path" && record.item.path === resource.path)?.check;
      return check?.hash ? { ...resource, hash: check.hash } : resource;
    });
    const targets = selectedTargets.map(target => ({ id: target.id, host: target.host, filename: target.filename, origin: target.origin,
      ...(catalogues.get(target.id)?.context ?? target.context ? { context: catalogues.get(target.id)?.context ?? target.context } : {}),
      ...(target.historyRef ? { historyRef: target.historyRef } : {}) }));
    return { targets, cohortMode: batch ? "bulk" : "single", recipe: encoded.recipe, resources, ...(destination ? { destination } : {}) };
  };
  function reconcilePlan() {
    if (!services.plan || !catalogueReady || destinationPending || catalogueError !== null || running) return;
    if (!selectedTargets.length) { enginePlan = []; enginePlanPending = false; return; }
    const selectedImages = [...recipe.entries("images")].filter(([, entry]) => entry.values.enabled)
      .flatMap(([id, entry]) => entry.values.items.map(item => imageView(id, item, entry.metadata)));
    if (selectedImages.some(item => item.pending || item.error)) {
      planGeneration++; planKey = null; planController?.abort(); if (planTimer !== null) clearTimer(planTimer);
      planTimer = null; enginePlan = null; enginePlanError = selectedImages.find(item => item.error)?.error ?? ""; enginePlanPending = !enginePlanError;
      return;
    }
    let input, key;
    try { input = planInput(); key = stringifyExactJson(input); }
    catch (error) { enginePlanError = problemText(problemFrom(error, { code: "plan-input", phase: "plan", numbers: { images: selectedTargets.length } })); enginePlanPending = false; return; }
    if (key === planKey) return;
    planKey = key; const generation = ++planGeneration;
    planController?.abort(); if (planTimer !== null) clearTimer(planTimer);
    enginePlanPending = true; enginePlanError = ""; enginePlan = null;
    planController = new AbortController();
    planTimer = setTimer(async () => {
      planTimer = null;
      try {
        const planned = await services.plan(input, planController.signal);
        if (!alive || generation !== planGeneration) return;
        if (!Array.isArray(planned) || planned.length !== input.targets.length || planned.some((target, index) => !target || target.index !== index ||
          !Number.isSafeInteger(target.count) || target.count < 0 || (target.problem ?
           typeof target.problem.message !== "string" || !target.problem.message.trim() || target.count !== 0 && target.problem.code !== "too-many" : target.count <= 0))) throw Object.assign(new Error("target length, index, count or problem shape mismatch"), { code: "plan-invalid-reply" });
        enginePlan = freeze(snapshotDraft(planned));
      } catch (error) { if (alive && generation === planGeneration) enginePlanError = problemText(variationProblem(error.code === "plan-invalid-reply" ? error.code : "plan-failed", { phase: "plan", detail: error.message, numbers: { images: input.targets.length } })); }
      finally { if (alive && generation === planGeneration) { enginePlanPending = false; validationCache = null; changed(); } }
    }, 150);
  }
  const cohortPresentation = () => planPresentation(enginePlan, selectedTargets, { pending: enginePlanPending, error: enginePlanError });
  const withCohort = preview => {
    if (!services.plan) return preview;
    const presentation = cohortPresentation(), { n } = presentation;
    const blocked = unresolvedConflicts();
    if (preview.status === "invalid") {
      Object.assign(presentation, { status: "invalid", message: preview.message, problemMessage: preview.message });
    } else if (preview.status === "checking" && preview.message?.startsWith("Checking bytes")) {
      presentation.message = preview.message;
    } else if (blocked) {
      const message = conflictMessage(blocked);
      Object.assign(presentation, { status: "conflict", message, problemMessage: message });
    }
    const times = presentation.admitted.map(target => {
      const duration = generationTimes.get(selectedTargets[target.index]?.id);
      return knownGenerationTime(duration) ? duration * target.count : null;
    });
    const missingTimes = presentation.admitted.filter((_, index) => !knownGenerationTime(times[index]));
    if (missingTimes.length && !enginePlanPending && !problems.read().some(problem => problem.code === "time-unavailable")) presentation.notices.push(variationProblem("time-unavailable", { severity: "warning", phase: "metadata",
      names: missingTimes.map(target => selectedTargets[target.index]?.filename), numbers: { missing: missingTimes.length, total: presentation.admitted.length }, detail: "missing metadata or unsupported computed duration" }));
    // The shown count is settled unless the debounced engine plan is still due.
    return { ...preview, ...presentation, exact: n !== null, busy: preview.status !== "invalid" && (presentation.pending || !!preview.busy),
      timeEstimate: estimateGenerationTime(n > 0 ? 1 : null, times) };
  };
  const canRun = () => (!services.plan || catalogueReady && catalogueError === null && !destinationPending && !enginePlanPending && !enginePlanError && enginePlan?.some(target => !target.problem && target.count > 0)) &&
    !["invalid", "failed", "conflict"].includes(editor.preview().status);

  seed("naming", "root", {}, { prefix: "", suffix: "" });
  const editor = {
    rows: view,
    revision: recipe.revision,
    targets: () => selectedTargets,
    targetProblem(id) {
      const unavailable = selectedTargets.find(target => target.id === id && target.unavailable);
      if (unavailable) return variationProblem("saved-unavailable", { phase: "history", target: targetIdentity(unavailable), numbers: { unavailable: 1, total: 1 }, names: [`${unavailable.filename}: ${unavailable.unavailable}`] });
      const retained = runProblems.get(id);
      return retained?.revision === recipe.revision() ? retained.problem : cohortPresentation().problems.get(id) ??
        problems.read().find(problem => problem.target?.id === id) ?? (enginePlan ?? []).find(target => selectedTargets[target.index]?.id === id)?.notices?.[0] ?? null;
    },
    targetOutcome: id => runOutcomes.get(id) ?? null,
    // The destination summary already names every unchecked input once; cards
    // keep their own one-input projection without repeating it in the status.
    problems: () => [...problems.read(), ...validationProblems().filter(problem => problem.code !== "destination-unchecked")],
    reportProblem: (key, problem) => problems.report(key, problem),
    clearProblem: key => problems.clear(key),
    canRun,
    destination: () => destination,
    setDestination(origin) {
      if (!alive || deciding || running || !validOrigin(origin) || origin.kind !== "comfy") return false;
      if (sameOrigin(origin, destination)) return false;
      restoreQueuedCohort();
      destination = freeze(snapshotDraft(origin)); conflicts = {}; unchecked = []; destinationPending = true; catalogueError = null;
      problems.clear("catalogue"); problems.clearPrefix("schema:");
      planGeneration++; planKey = null; enginePlan = null; enginePlanPending = true; planController?.abort(); runProblems.clear(); runOutcomes.clear();
      invalidateClose(); notify(); return true;
    },
    resolveConflict(id, value) {
      const conflict = conflicts[id], location = locations.find(entry => entry.id === id);
      if (conflict?.kind !== "value" || !location || !conflict.choices.some(choice => sameJsonValue(choice, value))) return false;
      if (location.domain === "enums") { this.setEnabled(id, true); return this.edit("enums", id, "picks", [value]); }
      if (location.domain === "candidates") { this.setEnabled(id, true); return this.edit("candidates", id, "candidates", [stringifyExactJson(value)]); }
      return false;
    },
    generationTime: id => selectedTargets.some(target => target.id === id && originCurrent(target)) ? generationTimes.get(id) ?? null : null,
    removeTarget(id) {
      if (!alive || deciding || running || !selectedTargets.some(target => target.id === id)) return false;
      if (selectedTargets.length <= 1) { report("last-target", "last-target", { phase: "selection", target: targetIdentity(selectedTargets[0]) }); return false; }
      selectedTargets = freeze(selectedTargets.filter(target => target.id !== id));
      problems.clear("timing");
      recipe.edited(); invalidateClose(); notify(); return true;
    },
    loadGenerationTimes() {
      if (!alive) return Promise.resolve();
      if (timingTask) return timingTask;
      timingTask = Promise.allSettled(capturedTargets.map(async target => {
        if (knownGenerationTime(generationTimes.get(target.id)) || !services.generationTime || !originCurrent(target) || target.historyRef && !target.hash) return;
        const record = await services.generationTime(target, { signal: timingController.signal });
        if (!alive || !selectedTargets.includes(target) || !originCurrent(target)) return;
        if (record?.name !== target.filename || !/^[a-f0-9]{64}$/.test(record.hash ?? "") || target.hash && record.hash !== target.hash || !knownGenerationTime(record.generationTimeMs)) return "missing";
        generationTimes.set(target.id, record.generationTimeMs); notify();
      })).then(results => {
        if (!alive) return;
        const eligible = capturedTargets.filter((target, index) => selectedTargets.includes(target) && originCurrent(target) && results[index].status === "rejected" ||
          selectedTargets.includes(target) && originCurrent(target) && results[index].status === "fulfilled" && results[index].value === "missing");
        const missing = eligible.filter(target => !knownGenerationTime(generationTimes.get(target.id)));
        if (missing.length) report("timing", "time-unavailable", { severity: "warning", phase: "metadata",
          numbers: { missing: missing.length, total: selectedTargets.length }, names: missing.map(target => target.filename),
          detail: results.find(result => result.status === "rejected")?.reason?.message ?? "missing or unsupported duration metadata" });
        else problems.clear("timing");
      });
      return timingTask;
    },
    async planRecall(saved) {
      const revision = recipe.revision();
      if (!alive || deciding || running) throw new Error("Finish the current action before recalling history");
      const cohort = [];
      for (const target of selectedTargets.length ? selectedTargets : queuedCohort?.targets ?? selectedTargets) {
        if (!originCurrent(target)) throw new Error(staleSource(target.host));
        const data = catalogues.get(target.id) ?? await services.probe(target);
        if (!originCurrent(target)) throw new Error(staleSource(target.host));
        if (!alive || deciding || running || recipe.revision() !== revision) throw new Error("Editor changed while reading history; choose it again");
        cohort.push(data);
      }
      const plan = planHistoryOverlay(saved, captureRows(), cohort, batch ? "bulk" : "single");
      return { ...plan, revision, id: saved.id, leaseId: saved.leaseId, record: saved };
    },
    applyRecall(plan) {
      if (!alive || deciding || running || plan.revision !== recipe.revision() || !selectedTargets.every(originCurrent)) return { status: "stale" };
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
      this.installCatalogue({ ...record.targets[0].catalogue, context: record.targets[0].context }, true, true);
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
    submission: () => submission,
    result: () => {
      if (!result?.adopted || !dirty()) return result;
      return { ...result, state: "kept", reason: "Newer edits have been kept.", text: `submitted ${result.submitted}/${result.total} — newer edits have been kept` };
    },
    ready: () => catalogueReady,
    sourceProblem() { const target = selectedTargets.find(target => !originCurrent(target)); return target ? staleSource(target.host) : null; },
    sourceInputs(origin, root = "input") {
      const record = sourceRecord(inputCatalogues, origin, null, root);
      if (!record) return { files: [], pending: false, error: "" };
      // Readonly discovery reprojects retained facts through the live injected
      // authority. It never edits the recipe or the independent input evidence.
      let files = record.files;
      if (root === "output") {
        const eligible = record.entries.filter(entry => services.outputVisible
          ? services.outputVisible(origin, entry) : judgmentVisible(entry.judgment)).map(entry => entry.name);
        // Unrelated recipe/status changes must not reset search/virtual focus.
        if (!record.eligible || record.eligible.length !== eligible.length || eligible.some((name, i) => record.eligible[i] !== name))
          record.eligible = Object.freeze(eligible);
        files = record.eligible;
      }
      const listed = record.listed ?? files.length, invalid = record.invalid ?? 0, hidden = Math.max(0, listed - invalid - files.length);
      const notices = hidden || invalid ? [variationProblem("listing-filtered", { severity: "warning", phase: "acquisition", source: origin.source, root,
        numbers: { visible: files.length, listed, hidden, invalid } })] : [];
      return { files, pending: record.pending, error: record.error, loaded: record.loaded, notices };
    },
    async loadSourceInputs(origin, retry = false, root = "input") {
      if (!alive || !["input", "output"].includes(root) || !validOrigin(origin) || !sameOrigin(origin, currentOrigin(origin.source))) return;
      const record = sourceRecord(inputCatalogues, origin, () => ({ files: [], entries: [], pending: false, error: "", loaded: false }), root);
      const ownsRecord = () => alive && sameOrigin(origin, currentOrigin(origin.source)) && sourceRecord(inputCatalogues, origin, null, root) === record;
      if (record.pending || record.loaded && !retry) return;
      record.pending = true; record.error = ""; notify();
      try {
        const data = await services.inputList(origin.source, origin, root);
        if (!ownsRecord()) return;
        if (!sameOrigin(data?.origin, origin)) throw new Error(staleSource(origin.source));
        if (data.root !== root || !Array.isArray(data.files)) throw new Error("Source-bound image catalogue unavailable");
        if (root === "output") record.entries = freeze(data.files.map(file => typeof file === "string" ? { name: file, judgment: null }
          : { name: file.name, judgment: snapshotDraft(file.judgment ?? null) }).filter(entry => resourceName(entry.name)));
        else record.files = data.files.map(file => typeof file === "string" ? file : file.name).filter(resourceName);
        record.listed = data.files.length; record.invalid = data.files.length - (root === "output" ? record.entries.length : record.files.length);
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
      const cached = cachedInput(origin, name, root);
      if (!sameOrigin(origin, capturedTargets[0].origin)) return cachedFileState(id, cached);
      const item = reference(name, root);
      return { selected: row("images", id).values.items.some(other => sameImage(item, other)), pending: false, error: cached?.error ?? "" };
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
      return toggleCachedFile(this, id, fileRecord(source.files, name), name, async () => {
        const resource = await services.readInput(origin, name, root);
        if (!(resource instanceof File) || resource.name !== name) throw new Error("Invalid input image");
        // The resource port retains its full raw name. Uploads have their own
        // flat namespace; the editor owns that leaf-named File, not the API.
        return name.includes("/") ? new File([resource], name.split("/").at(-1), { type: resource.type, lastModified: resource.lastModified }) : resource;
      }, ownsRead);
    },
    // A service whose configuration changed retires its cached Files and any
    // read still in flight; images already in a set keep their own File.
    retirePexelsService(service) {
      for (const [photo, cached] of pexelsFiles.get(service) ?? []) for (const [id] of cached.wanted)
        report(`acquire:${id}`, "acquisition-retired", { phase: "acquisition", parameter: parameter(id), resource: `Photo ${photo}`, source: service });
      if (pexelsFiles.delete(service)) notify();
    },
    pexelsState(id, service, photo) { return cachedFileState(id, pexelsFiles.get(service)?.get(photo)); },
    // A chosen Pexels photo is an ordinary uploaded image once its bytes arrive.
    togglePexels(id, service, photo, url) {
      if (!alive || deciding || typeof service !== "string" || typeof photo !== "string" || typeof url !== "string" || !row("images", id) || !originCurrent(capturedTargets[0])) return false;
      if (!pexelsFiles.has(service)) pexelsFiles.set(service, new Map());
      const files = pexelsFiles.get(service);
      return toggleCachedFile(this, id, fileRecord(files, photo), `Photo ${photo}`, async () => {
        const file = await services.readPexelsPhoto(service, photo, url);
        if (!(file instanceof File) || !file.size) throw new Error("Invalid photo");
        return file;
      }, () => alive && pexelsFiles.get(service) === files);
    },
    // The server's own reason when it gave one; never the request path.
    catalogueFailure(error) {
      if (!alive) return;
      const context = { phase: "catalogue", target: targetIdentity(capturedTargets[0]), destination: destination?.source ?? capturedTargets[0].host };
      const problem = error?.problem ? problemFrom(error, context) : variationProblem("catalogue-read", { ...context, detail: String(error?.detail || (error?.status ? `HTTP ${error.status}` : error?.message ?? error)) });
      problems.report("catalogue", problem);
      catalogueError = problemText(problem); result = null; notify();
    },
    // Ask the same source again after a failed catalogue request.
    retryCatalogue() {
      if (!alive || running || catalogueError === null && !enginePlanError) return false;
      catalogueError = null; result = null; if (destination) destinationPending = true;
      problems.clear("catalogue");
      enginePlanError = ""; planKey = null;
      notify(); return true;
    },
    invalidateClose,
    decision(value) { deciding = !!value; if (deciding) decisionGeneration++; notify(); },
    edit(domain, id, name, value) {
      if (!alive || deciding) return false;
      write(domain, id, name, value);
      problems.clear(`edit:${id}`); problems.clear(`acquire:${id}`); problems.clear("last-target");
      if (domain === "images" && name === "items") inspectItems(id);
      recipe.edited(); invalidateClose(); notify(); return true;
    },
    addImages(id, items, index) {
      const entry = row("images", id);
      if (!entry) throw new Error("Unknown image row");
      // Unlike immutable Files, a removed disk path may now contain new bytes.
      for (const item of items) if (item.kind === "server-path" && !entry.values.items.some(other => sameImage(item, other))) imageChecks.get(id)?.delete(imageIdentity(item));
      const merged = mergeImages(entry.values.items, items, index), added = merged.length - entry.values.items.length;
      const result = this.edit("images", id, "items", merged);
      if (items.length > added) report(`merge:${id}`, "images-merged", { severity: "warning", phase: "acquisition", parameter: parameter(id),
        numbers: { added, listed: items.length, duplicates: items.length - added } });
      else problems.clear(`merge:${id}`);
      return result;
    },
    dropImages(id, resources, accepts, index) {
      const result = classifyImageFiles(resources, accepts);
      if (result.images.length) { this.setEnabled(id, true); this.addImages(id, result.images.map(uploadImage), index); }
      if (result.skipped || result.folders) report(`drop:${id}`, "drop-skipped", { severity: "warning", phase: "acquisition", parameter: parameter(id),
        numbers: { added: result.images.length, skipped: result.skipped, folders: result.folders }, names: result.names });
      if (result.unreadable) report(`drop-unreadable:${id}`, "drop-unreadable", { severity: "warning", phase: "acquisition", parameter: parameter(id), numbers: { unreadable: result.unreadable } });
      return result.status;
    },
    async addFolder(id, path) {
      if (!alive || deciding || running) throw new Error("Finish the current action before adding a folder");
      const target = capturedTargets[0];
      if (!originCurrent(target)) throw new Error(staleSource(target.host));
      const ticket = membershipTicket(id);
      const result = await services.listFolder(path);
      if (!originCurrent(target)) throw new Error(staleSource(target.host));
      if (running || !admitsMembership(ticket)) throw new Error("The editor changed while reading the folder. Add it again when ready.");
      if (!validImageSet(result?.items) || result.items.some(item => item.kind !== "server-path")) throw new Error("Invalid folder image listing");
      const before = row("images", id).values.items.length;
      this.addImages(id, result.items);
      const added = row("images", id).values.items.length - before;
      if (result.skipped?.links || result.skipped?.other) report(`folder:${id}`, "folder-skipped", { severity: "warning", phase: "acquisition", parameter: parameter(id), path,
        numbers: { images: added, ...result.skipped } });
      return { count: added, listed: result.items.length, skipped: result.skipped };
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
    installCatalogue(data, archived = false, restoring = false) {
      if (!alive) return;
      const target = capturedTargets[0];
      if (!archived && (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin))) {
        const problem = report("catalogue", "catalogue-stale", { phase: "catalogue", target: targetIdentity(target), source: target.host });
        catalogueError = problemText(problem); notify(); return;
      }
      if (!restoring && data.destination && !sameOrigin(data.destination.origin, destination)) {
        const problem = report("catalogue", "catalogue-destination", { phase: "catalogue", actual: data.destination.origin?.source ?? "unknown destination", expected: destination?.source ?? "none" });
        catalogueError = problemText(problem); notify(); return;
      }
      parameterIndex(allParameters(data)); parameterIndex(catalogueParams(data));
      // Validate the whole incoming catalogue before publishing any defaults.
      for (const p of allParameters(data)) {
        const domain = data.parameters ? editorDomain(p) : ["numeric", "images", "enums", "texts"][["params", "stringParams", "enumParams", "textParams"].findIndex(key => data[key]?.some(other => other.id === p.id))];
        if (!ROW_STRATEGIES[domain]) throw new Error(`Unsupported parameter editor: ${p.id}`);
        const initialized = ROW_STRATEGIES[domain].initialize(p, batch);
        freeze(snapshotDraft({ ...p, ...initialized.metadata }));
        for (const [name, value] of Object.entries(initialized.defaults)) if (!validValue(recipeField(domain, name).type, value)) throw new Error(`Invalid default: ${domain}.${name}`);
      }
      catalogues.set(target.id, freeze(snapshotDraft({ ...data, context: data.context ?? catalogues.get(target.id)?.context ?? null })));
      if (data.destination && (!archived || sameOrigin(data.destination.origin, destination))) {
        conflicts = snapshotDraft(data.destination.conflicts ?? {}); unchecked = [...(data.destination.unchecked ?? [])]; destinationPending = restoring && !!destination;
      }
      catalogueError = null; problems.clear("catalogue");
      problems.clearPrefix("schema:");
       for (const problem of data.problems ?? []) problems.report(`schema:${problem.parameter?.id}`, problem);
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
      const unavailable = (status, message) => ({ n: null, display: "—", fullCount: message, perImage: 0, busy: status === "reading",
        anyEnabled: false, exact: false, status, message, breakdown: "", axes: [], excluded: 0, naming: { example: "", complete: false }, timeEstimate: estimateGenerationTime(null, []) });
      if (services.runDestinations && !services.runDestinations().some(origin => origin.source === (destination?.source ?? capturedTargets[0].host))) return unavailable("failed", problemText(variationProblem("no-destination", { phase: "destination" })));
      if (catalogueError !== null) return unavailable("failed", catalogueProblem());
      if (!catalogueReady) return unavailable("reading", problemText(variationProblem("workflow-pending", { phase: "catalogue", target: targetIdentity(capturedTargets[0]) })));
      if (destinationPending) return unavailable("reading", problemText(variationProblem("destination-pending", { phase: "destination", destination: destination.source, numbers: { images: selectedTargets.length } })));
      const snapshot = captureRows(), first = catalogues.get(capturedTargets[0].id);
      for (const [id, entry] of Object.entries(snapshot.numeric)) if (entry.values.enabled && entry.values.mode === "range" && increment(entry) === null) {
        return unavailable("invalid", problemText(variationProblem("numeric-step", { phase: "compile", target: targetIdentity(capturedTargets[0]), parameter: parameter(id), field: "Step", value: entry.values.rawIncrement, numbers: { minimum: entry.metadata.minIncrement } })));
      }
      try {
        const compiled = compile(snapshot, null, true), payload = compiled.estimate;
        for (const [id, axis] of Object.entries(payload.imageParams)) if (axis.enabled && !axis.values.length) {
           const entry = snapshot.images[id] ?? snapshot.enums[id] ?? snapshot.texts[id] ?? snapshot.candidates[id];
          return unavailable("invalid", `${entry.metadata.label}: ${snapshot.images[id] ? "add at least one image" : snapshot.enums[id] ? "choose at least one value" : "enter values for every template label"}.`);
        }
        const values = currentValues(first), ranges = batch ? resolveRelativeRanges(payload.ranges, values) : payload.ranges;
        // The opening image's host is compared with the Run destination.
        const sameHost = reproducesOriginal(capturedTargets[0].host, destination?.source);
        const plan = permutationPlan(ranges, values, payload.imageParams, { sameHost });
        const axes = plan.axes.map(axis => {
          const entry = snapshot.numeric[axis.id] ?? snapshot.images[axis.id] ?? snapshot.enums[axis.id] ?? snapshot.texts[axis.id] ?? snapshot.candidates[axis.id];
          return { id: axis.id, count: axis.length, name: entry.metadata.key.replace(/_/g, " "),
            kind: snapshot.images[axis.id] ? "images" : "values", label: entry.metadata.label };
        });
        const selected = [...recipe.entries("images")].filter(([, entry]) => entry.values.enabled)
          .flatMap(([id, entry]) => entry.values.items.map(item => imageView(id, item, entry.metadata)));
        const pending = selected.some(item => item.pending), error = selected.find(item => item.error)?.error;
        const perImage = plan.total, n = perImage * selectedTargets.length, safe = Number.isSafeInteger(n);
        const exact = !batch && !pending && !error && safe;
        const excluded = plan.excluded;
        // One representative non-current tuple from the kernel, without allocating
        // the Cartesian product. Numeric matches form a contiguous interval.
        const sample = Object.fromEntries(plan.axes.map(axis => [axis.id, axis.at(0)]));
        if (plan.total && plan.excluded && plan.axes.every(axis => axis.isCurrent(sample[axis.id]))) {
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
        const projection = variationOutputName(source, { ...payload, ranges }, sample, values, aliases, parameters, { sameHost });
         const naming = { complete: projection.complete,
           notices: projection.notices.map(problem => problemFrom({ problem }, { target: targetIdentity(capturedTargets[0]), parameter: { id: "root", label: "Output names" } })),
           problems: !projection.complete ? [variationProblem("naming", { phase: "naming", target: targetIdentity(capturedTargets[0]), parameter: { id: "root", label: "Prefix/Suffix" }, detail: "Unresolved naming token: check Prefix and Suffix" })] : [],
          example: projection.value.replace(/\0pending-\d+/g, "[upload name pending]"),
          help: "Representative first output; upload collision names and ComfyUI's added counter may differ." };
        const factors = [...axes].sort((a, b) => (a.kind !== "images") - (b.kind !== "images")).map(axis =>
          `${axis.count.toLocaleString("en-US")} ${axis.kind === "images" ? `input image${axis.count === 1 ? "" : "s"}` : `${axis.name} value${axis.count === 1 ? "" : "s"}`}`);
        const breakdown = (factors.join(" × ") || (!sameHost ? `Unchanged workflow on ${destination.source}` : "Unchanged workflow"))
          + (excluded ? ` · ${excluded} unchanged combination${excluded === 1 ? "" : "s"} excluded` : "")
          + (batch ? ` · workflow estimate × ${selectedTargets.length} target image${selectedTargets.length === 1 ? "" : "s"}` : "");
        let status = !naming.complete || error ? "invalid" : pending ? "checking" : "ready";
        let message = !naming.complete ? "Unresolved naming token: check Prefix and Suffix." : error ? `Image comparison failed: ${error}`
          : pending ? problemText(validationProblems().find(problem => problem.code === "images-checking")) : !n ? "Choose a different value, image or destination to create variations."
          : !safe ? problemText(variationProblem("estimate-unsafe", { phase: "plan", numbers: { count: n } }))
          : batch ? "Estimated from the opening workflow; each remaining target is checked before submission."
          : n > 100 ? "Large sweep: this many jobs will be queued. The engine validates its existing per-run limit." : "";
        const blocked = unresolvedConflicts();
        if (blocked && status !== "invalid") { status = "conflict"; message = conflictMessage(blocked); }
        const timeEstimate = estimateGenerationTime(status === "invalid" ? null : perImage,
          selectedTargets.map(target => originCurrent(target) ? generationTimes.get(target.id) : null));
        return withCohort({ n, perImage, anyEnabled: axes.length > 0 || !sameHost, exact: exact && naming.complete, status, message, busy: pending && status !== "invalid",
          unchecked: [...unchecked], uncheckedMessage: destinationMessage(), axes, excluded, breakdown, naming, timeEstimate,
          display: n >= 1e6 ? n < 1e15 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 4 }).format(n)
            : n.toExponential(2).replace("e+", " × 10^") : n.toLocaleString("en-US"),
          fullCount: `${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}${exact ? " variations" : " variations (estimate)"}` });
      } catch (error) {
        // A value the destination lacks is a conflict, not a recipe mistake.
        const blocked = unresolvedConflicts();
        return withCohort({ ...unavailable(blocked ? "conflict" : "invalid", blocked ? conflictMessage(blocked) : problemText(problemFrom(error, { target: targetIdentity(capturedTargets[0]) }))),
          unchecked: [...unchecked], uncheckedMessage: destinationMessage() });
      }
    },
    async run() {
      if (!alive) return { status: "stale" };
      if (running || deciding) { report("busy", "busy", { phase: "run", detail: running ? "submission" : "confirmation" }); return { status: "busy" }; }
      problems.clear("busy");
      if (catalogueError !== null) { publish({ text: `${catalogueProblem()} Nothing was sent.`, ok: false, state: "unavailable" }); return { status: "invalid" }; }
      if (!catalogueReady) { publish({ text: "Inspecting source context; your edits have been kept.", ok: false, state: "unavailable" }); return { status: "invalid" }; }
      if (destinationPending) { publish({ text: `Still checking ${destination.source}; nothing was sent.`, ok: false, state: "unavailable" }); return { status: "invalid" }; }
      if (services.plan ? !canRun() : unresolvedConflicts()) { publish({ text: `${services.plan ? withCohort({}).message || "No image has work to submit." : conflictMessage(unresolvedConflicts())} Nothing was sent.`, ok: false, state: "invalid" }); return { status: "invalid" }; }
      invalidateClose();
      const ticket = Object.freeze({ runId: createRunId(), editRevision: recipe.revision(), closeGeneration, snapshot: freeze(captureRows()), targets: selectedTargets, cohortMode: batch ? "bulk" : "single", destination });
      // Retain the captured inspection handles while they settle. Removing and
      // readding a path may replace live evidence, never this Run's evidence.
      const inspections = [...pendingInspections];
      const capturedChecks = new Map([...imageChecks].map(([id, checks]) => [id, new Map(checks)]));
      const operation = { compiled: null };
      active = ticket;
      let submitted = 0, total = 0, countsComplete = true, uncertain = false;
      const failures = [], uploads = new Map(), leftovers = new Map();
      const effects = { uploads: [], targets: [] };
      // A Run ends in one transition: its outcome is shown together with the
      // end of running, after the saved-run record is finished.
      let outcome = null, show = false, closable = false;
      running = true; submission = null; result = null; queuedCohort = null; runOutcomes.clear(); notify();
      try {
        const saved = services.history ? await services.history.capture(ticket,
          new Map([...catalogues].map(([id, catalogue]) => [id, catalogue.context])), target => check(ticket, target)) : null;
        if (saved && owns(ticket) && services.history.progress) {
          submission = saved.submission ?? { sent: 0, total: saved.summary?.total ?? null };
          stopProgress = observeSubmission({ read: signal => services.history.progress(ticket.runId, signal), setTimer, clearTimer,
            failure: (error, value) => { if (owns(ticket)) report("progress", "progress-unavailable", { severity: "warning", phase: "submission", detail: error.message, numbers: value ?? {} }); },
            publish: value => {
              if (!owns(ticket)) return;
              submission = value && Number.isSafeInteger(value.sent) && value.sent >= 0 && Number.isSafeInteger(value.total) && value.total >= value.sent ? value : null;
              if (submission) problems.clear("progress");
              notify();
            } });
          notify();
        }
        await Promise.all(inspections);
        const runChecks = new Map([...capturedChecks].map(([id, checks]) => [id,
          new Map([...checks].map(([identity, value]) => [identity, freeze(snapshotDraft(value))]))]));
        const runEvidence = (id, item) => runChecks.get(id)?.get(imageIdentity(item));
        for (const target of ticket.targets) check(ticket, target);
        let uploadFailure = false;
        if (saved) {
          const planned = await services.history.plans(ticket, saved, target => check(ticket, target));
          // Narrow service rigs retain their old array contract; the installed
          // history owner always returns explicit plans and leftovers.
          operation.targetPlans = freeze(Array.isArray(planned) ? planned : planned.plans);
          operation.cohort = !Array.isArray(planned);
          for (const leftover of planned.leftovers ?? []) leftovers.set(leftover.target.id, leftover);
        }
        else {
        if (ticket.destination && ticket.targets.some(target => !sameOrigin(ticket.destination, target.origin))) throw new Error("Running on another ComfyUI requires saved-run history; nothing was sent.");
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
          if (!validContext(data?.context) || !sameOrigin(data.context.origin, target.origin)) throw new Error(staleSource(target.host));
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
            if (!sameOrigin(receipt?.origin, uploadTarget.origin)) throw new Error(staleSource(uploadTarget.host));
            if (!filename(receipt?.name)) throw new Error(`${item.name}: upload acknowledgement unavailable; your image was kept`);
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
        for (const { target, request, expectedTotal } of operation.targetPlans) {
          try {
            check(ticket, target);
            if ([...uploads.values()].some(receipt => !physicalMatch(receipt.origin, target.origin))) throw new Error(staleSource(target.host));
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
             if (!response.ok) { throw new Error(sourceFailure(response.status, data?.error ?? response.text ?? `error ${response.status}`, ticket.destination?.source ?? target.host)); }
             const proof = request.history ? acknowledgedHistoryFields(request, data) : acknowledgedFields(request, data);
            for (const error of Array.isArray(data?.errors) ? data.errors : []) failures.push(error?.error ?? String(error));
            if (!proof || data.total !== expectedTotal || !sameContext(context, data.acknowledgement?.context)) {
              uncertain ||= data.outcome === "uncertain-effects" || data.submitted === data.total && !data.errors?.length;
              failures.push("submission acknowledgement unavailable; your edits have been kept.");
            }
             else proofs.push({ target, proof, count: expectedTotal });
             if (!proof || data.total !== expectedTotal) leftovers.set(target.id, { target, problem: { code: data.outcome ?? "unconfirmed", message: failures.at(-1) ?? "Submission was not fully confirmed; inspect the result before running again." } });
          } catch (error) { countsComplete = false; failures.push(`${target.filename}: ${error.message}`); leftovers.set(target.id, { target, problem: { code: "submission-failed", message: error.message } }); }
        }
        if (!owns(ticket)) return { status: "stale" };
        const complete = !uploadFailure && failures.length === 0 && proofs.length === operation.targetPlans.length && proofs.length > 0;
        const eligible = complete && !leftovers.size && compatible(ticket);
        if (eligible) acceptedRevision = ticket.editRevision;
        if (saved && operation.cohort) {
          const newerEdits = recipe.revision() !== ticket.editRevision;
          if (newerEdits) {
            // These outcomes describe the captured setup, not the newer raw
            // recipe. Keep its whole cohort so unsent edits still have targets.
            for (const { target, count } of proofs) runOutcomes.set(target.id, freeze({ state: "queued", message: `Queued ${count} job${count === 1 ? "" : "s"}` }));
            for (const leftover of leftovers.values()) runOutcomes.set(leftover.target.id, freeze({ state: "issue", message: leftover.problem.message }));
          } else {
            const queued = new Set(proofs.map(({ target }) => target.id));
            if (complete && !leftovers.size) queuedCohort = {
              targets: ticket.targets, revision: ticket.editRevision,
              outcomes: proofs.map(({ target, count }) => [target.id, freeze({ state: "queued", message: `Queued ${count} job${count === 1 ? "" : "s"}` })]),
            };
            selectedTargets = freeze(selectedTargets.filter(target => !queued.has(target.id)));
            for (const leftover of leftovers.values()) runProblems.set(leftover.target.id, { revision: ticket.editRevision, problem: leftover.problem });
          }
          planKey = null;
        }
        const summary = batch ? `submitted ${submitted}/${total} across ${ticket.targets.length} images` : `submitted ${submitted}/${total}`;
        const newerEdits = recipe.revision() !== ticket.editRevision;
        const reason = failures[0] ?? (newerEdits ? "newer edits have been kept with all captured images; target outcomes describe the captured setup."
          : leftovers.size ? `${leftovers.size} image${leftovers.size === 1 ? " needs" : "s need"} attention. Adjust the remaining images and Run again.` : !eligible ? deciding ? "leave decision pending; your edits have been kept" : "operation context changed; your edits have been kept"
          : "");
        show = true;
        outcome = ({ text: submitted || total ? summary + (reason ? ` — ${reason}` : "") : reason || "nothing submitted", reason, ok: complete,
          state: eligible ? "adopted" : complete ? "kept" : "unavailable", submitted, total, adopted: eligible,
          effects: freeze(snapshotDraft(effects)), outcome: complete ? "accepted-plan" : !ticket.targets.every(originCurrent) ? "retired" : uncertain ? "uncertain-effects" : submitted ? "partial-effects" : "rejected" });
        // Only a complete, eligible run may close itself; failures stay on screen.
        closable = eligible;
        return { status: submitted > 0 && countsComplete && !uploadFailure ? "submitted" : "failed", submitted, total, adopted: eligible };
      } catch (error) {
        show = owns(ticket);
        if (show && recipe.revision() !== ticket.editRevision) for (const target of ticket.targets) runOutcomes.set(target.id, freeze({ state: "issue", message: error.message }));
        outcome = { text: error.message, ok: false, state: error.stale ? "stale" : "invalid", outcome: error.stale ? "retired" : "rejected", submitted, total, adopted: false, effects: freeze(snapshotDraft(effects)) };
        return { status: owns(ticket) ? error.stale ? "stale" : "invalid" : "stale", submitted, total, adopted: false };
       } finally {
          const stop = stopProgress; stopProgress = null;
          if (stop) await stop();
         if (services.history) {
            try {
              const finished = await services.history.finish(ticket.runId, outcome?.ok ? null : outcome?.reason ?? outcome?.text ?? null);
              if (finished?.summary?.effects || finished?.effects) outcome = { ...outcome, effectCounts: finished.summary?.effects ?? finished.effects };
              if (finished?.refreshProblem && owns(ticket)) { problems.report("history-refresh", finished.refreshProblem); closable = false; }
            }
           catch (error) {
             // The result line shows `reason` when present: the failure must appear there too.
             closable = false;
             if (owns(ticket)) { show = true; const failed = `history refresh failed: ${error.message}`;
               outcome = { ...outcome, historyError: error.message, reason: `${outcome?.reason || outcome?.text || "Run ended"}; ${failed}`, text: `${outcome?.text ?? "Run ended"}; ${failed}` }; }
           }
         }
          if (!owns(ticket)) services.history?.notice?.(ticket.runId, variationProblem("run-retired", { severity: "warning", phase: "submission", runId: ticket.runId }));
          if (show) result = Object.freeze(outcome);
         if (owns(ticket)) running = false;
         // The automatic close starts only once the run has fully ended.
         if (closable && canClose(ticket)) timer = setTimer(() => { timer = null; if (canClose(ticket)) close(); }, 3000);
         notify();
       }
    },
    dispose() {
      alive = false; invalidateClose(); active = null; sourceFiles.clear(); pexelsFiles.clear(); inputCatalogues.clear(); sourceLifetimes.clear();
      stopProgress?.(); stopProgress = null;
      planGeneration++; planController?.abort(); if (planTimer !== null) clearTimer(planTimer);
      timingController.abort(); generationTimes.clear();
      for (const record of heldRecords.values()) services.history?.release(record).catch(() => {});
      heldRecords.clear();
    },
  };
  // One public intent boundary: malformed/stale edits and catalogue construction
  // cannot escape to a global handler or strand the readiness state.
  for (const method of ["installCatalogue", "setEnabled", "candidate", "addCandidate", "removeCandidate", "moveCandidate", "pickCandidate", "connection", "edit", "range", "template", "addImages", "dropImages", "removeImage", "toggleTargetImage", "moveImage"]) {
    const invoke = editor[method];
    editor[method] = function (...args) {
      try { return invoke.apply(editor, args); }
      catch (error) {
        if (!alive) return false;
        const id = method === "edit" ? args[1] : typeof args[0] === "string" ? args[0] : null;
        const context = { phase: method === "installCatalogue" ? "catalogue" : "edit", target: targetIdentity(capturedTargets[0]), ...(id ? { parameter: parameter(id) } : {}), detail: error.message };
        const problem = error.catalogueIssue ? problemFrom(error, context) : variationProblem(method === "installCatalogue" ? "catalogue-install" : "edit-failed", context);
        if (method === "installCatalogue") catalogueError = problemText(problem);
        problems.report(method === "installCatalogue" ? "catalogue" : `edit:${id}`, problem); changed(); return false;
      }
    };
  }
  return editor;
}

// Validate with the actual recipe/strategy owner before the broker replaces a
// live draft. This temporary owner has no IO, timers, history or publication port.
export function validateHistoryOpening(record) {
  const editor = makeVariationEditor({ targets: record.targets, cohortMode: record.cohortMode, destination: record.destination,
    services: {}, currentOrigin: source => record.targets.find(target => target.host === source)?.origin });
  try {
    editor.restoreHistory(record);
    const problem = editor.problems().find(problem => problem.severity === "error");
    if (problem) throw Object.assign(new Error(problem.message), { problem });
  } finally { editor.dispose(); }
}
