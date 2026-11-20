// One engine owner for captured configurations, archive membership and durable
// outbound-effect claims. SQL and byte storage remain injected capabilities.
import { sha256 } from "../../cache.mjs";
import { metaFromBytes } from "../../extractor.mjs";
import { validEntryName } from "../../backings/index.mjs";
import { validOrigin, sameOrigin, sourceOrigin, validContext } from "../../source-origin.mjs";
import { cloneJsonValue, parseExactJson, stringifyExactJson, resourceReference, sameJsonValue, parameterCurrent } from "../../parameters.mjs";
import { historyId, decodeHistoryRecipe } from "./history-codec.mjs";
import { imageIdentity, snapshotDraft } from "./recipe-model.mjs";
import { admitResourceTransfer } from "./compile.mjs";
import { parameterIndex } from "./shared.mjs";
import { planCohort, planTarget, countingTarget, bindCohortRecipe } from "./cohort-plan.mjs";
import { inspectSource, projectInspection } from "./inspection.mjs";
import { inspectDestination, destinationMissing } from "./destination.mjs";
import { readImage } from "./folder-images.mjs";
import { submitPrompt } from "../../backings/comfy-submission.mjs";
import { effectCounts, problemFrom } from "./problems.mjs";
import { problemEnvelope } from "./problem-transport.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const data = value => parseExactJson(value);
const canonical = value => stringifyExactJson(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  return value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
}
const digest = value => sha256(new TextEncoder().encode(canonical(value)));
const throwInspection = r => { if (r.error) throw fail(r.error, r.status); return r; };

export function historySummary(recipe, targets, resources = []) {
  const byId = new Map(resources.map(r => [r.id, r]));
  const parameters = [];
  for (const [domain, rows] of Object.entries(recipe)) for (const [id, entry] of Object.entries(rows)) {
    const v = entry.values;
    if (domain === "naming") {
      for (const field of ["prefix", "suffix"]) if (v[field] !== entry.baseline[field]) parameters.push({ id: field, label: field === "prefix" ? "Prefix" : "Suffix", kind: "value", value: v[field] });
    } else if (v.enabled) {
      const p = { id, label: entry.metadata.label ?? id, kind: domain };
      if (domain === "numeric") p.value = v.mode === "value" ? v.value : `${v.min} to ${v.max}, step ${v.rawIncrement}`;
      else if (domain === "images") {
        p.count = v.items.length;
        p.images = v.items.slice(0, 4).map(item => item.kind === "target" ? { kind: "target", name: "Current image" }
          : { resourceId: item.resourceId, name: byId.get(item.resourceId)?.name ?? item.name });
      } else p.value = domain === "texts" ? v.text : (domain === "enums" ? v.picks : v.candidates).join("; ");
      parameters.push(p);
    }
  }
  return { targets: targets.map(t => t.filename), parameters, plannedCount: null, submitted: 0, total: null, error: null };
}

export function makeVariationHistory(app) {
  const store = app.store, pending = new Map();
  const current = target => {
    const token = app.backings.capture(target.host), origin = sourceOrigin(target.host, app.backings.source(target.host));
    if (!app.backings.accepting() || !token || !validOrigin(target.origin) || !sameOrigin(target.origin, origin) || !app.backings.isCurrent(token)) throw fail("Source origin changed; work was kept", 412);
    return { token, origin };
  };
  // The Run destination: explicit at capture, else (older captures) the target's own source.
  const destinationOf = (row, targetIndex) => captured(row).destination ?? data(row.targets_json)[targetIndex]?.origin;
  const currentDestination = destination => {
    const token = app.backings.capture(destination?.source), origin = sourceOrigin(destination?.source, app.backings.source(destination?.source));
    if (!app.backings.accepting() || !token || !sameOrigin(destination, origin) || !app.backings.isCurrent(token)) throw fail("Run destination changed; work was kept", 412);
    return { token, origin };
  };
  // Before any outbound effect: the destination must have every node class.
  const missingAt = async (destination, target, graph, hash, inspected) => {
    const origin = sourceOrigin(target.host, app.backings.source(target.host));
    const originContext = sameOrigin(origin, target.origin) ? { origin, graphHash: hash } : null;
    return destinationMissing(app, { graph, hash, name: target.filename, originContext, inspected });
  };
  const destinationReady = async (destination, saved, target) => {
    if (sameOrigin(destination, target.origin)) return;
    const r = throwInspection(await inspectSource(app, destination.source, saved.filename, { origin: destination, graphHash: saved.hash }, { graph: saved.graph, hash: saved.hash }));
    const missing = await missingAt(destination, target, saved.graph, saved.hash, r);
    if (missing.length) throw fail(`Not installed on ${destination.source}: ${missing.join(", ")}; no jobs were submitted`, 409);
  };
  const record = (id, leaseId = null) => {
    if (!historyId(id)) throw fail("Invalid history Run ID");
    const row = store.variationGet(id);
    if (!row || row.deleted_at !== null && !store.variationLease(id, leaseId)) throw fail("History entry unavailable", 410);
    if (row.format !== 1 || !row.recipe_json) throw fail("Unsupported or unavailable history entry", 410);
    return row;
  };
  const captured = row => data(row.recipe_json);
  // Summary metadata is stored, but effect truth belongs to the live journal,
  // including body-written requests awaiting replies and restart recovery.
  const summaryOf = (row, effects = store.variationEffects(row.id)) => ({ ...data(row.summary_json),
    submitted: row.submitted_count, total: row.total_count, plannedCount: row.planned_count,
    effects: effectCounts(effects.filter(effect => effect.kind === "permutation")
      .map(effect => ({ ...effect, result: effect.result_json ? data(effect.result_json) : null })), row.total_count) });
  const sealed = (id, leaseId = null) => {
    const row = record(id, leaseId);
    if (!row.snapshot_json || row.capture_state !== "complete") throw fail("The saved archive is incomplete; missing resources remain listed", 409);
    return { row, snapshot: data(row.snapshot_json) };
  };
  const member = (id, resourceId, leaseId = null) => {
    record(id, leaseId);
    const ref = store.variationResource(id, resourceId);
    if (!ref?.hash) throw fail("Saved image bytes unavailable", 410);
    return ref;
  };
  const single = (key, operation, identity = key) => {
    if (pending.has(key)) {
      const previous = pending.get(key);
      if (previous.identity !== identity) return Promise.reject(fail("History operation conflict", 409));
      return previous.task;
    }
    const task = app.lifetime.run(`variation history ${key}`, operation);
    const record = { identity, task }; pending.set(key, record);
    task.then(() => { if (pending.get(key) === record) pending.delete(key); }, () => { if (pending.get(key) === record) pending.delete(key); });
    return task;
  };
  const attach = async (id, resourceId, bytes) => app.archive.retain(bytes, result => store.variationAttach(id, resourceId, result), {
    hasReferences: hash => store.variationAssetRefs(hash) > 0, forget: hash => store.variationForgetAsset(hash),
  });
  const reserve = (id, descriptor) => store.variationReserve(id, descriptor.id, canonical(descriptor));
  const collect = async id => {
    const hashes = store.variationRetire(id);
    for (const hash of hashes) await app.archive.collect(hash, () => store.variationAssetRefs(hash) > 0, () => store.variationForgetAsset(hash));
  };
  const outcome = (id, error = null) => {
    const row = store.variationGet(id);
    if (!row || row.targets_json === null) return;
    const summary = data(row.summary_json), effects = store.variationEffects(id), jobs = effects.filter(e => e.kind === "permutation");
    summary.submitted = jobs.filter(e => e.state === "confirmed" || e.state === "partial").length;
    const targets = effects.filter(e => e.kind === "target");
    const admission = effects.find(e => e.kind === "admission" && e.state === "confirmed");
    const cohort = admission ? data(admission.result_json).targets : null;
    const admitted = cohort?.filter(target => !target.problem && target.count > 0);
    const known = targets.map(e => data(e.request_json).expectedTotal);
    const expectedTargets = admitted?.length ?? data(row.targets_json).length;
    summary.total = admitted ? admitted.reduce((sum, target) => sum + target.count, 0) : targets.length === expectedTargets ? known.reduce((a, b) => a + b, 0) : null;
    summary.plannedCount = summary.total;
    summary.effects = effectCounts(jobs.map(job => ({ ...job, result: job.result_json ? data(job.result_json) : null })), summary.total);
    summary.leftovers = (cohort ?? []).filter(target => target.problem).map(target => ({ index: target.index, problem: target.problem }));
    for (const effect of effects.filter(effect => effect.kind === "leftover" && effect.state === "confirmed")) {
      const leftover = data(effect.result_json);
      if (!summary.leftovers.some(target => target.index === leftover.index)) summary.leftovers.push(leftover);
    }
    for (const target of targets.filter(effect => ["rejected", "partial", "uncertain"].includes(effect.state))) {
      const prepared = data(target.request_json), result = target.result_json ? data(target.result_json) : null;
      const index = prepared.request.history.targetIndex;
      if (!summary.leftovers.some(target => target.index === index)) summary.leftovers.push({ index, problem: result?.data?.problem ?? result?.data?.errors?.[0]?.problem ?? { code: target.state,
        message: result?.data?.error ?? result?.data?.errors?.[0]?.error ?? "Submission was not fully confirmed; inspect the result before running again." } });
    }
    summary.error = error ? typeof error === "string" ? error : error.message : summary.error;
    summary.problems = summary.leftovers.map(leftover => problemFrom(leftover.problem, { phase: "saved Run", target: {
      index: leftover.index, name: data(row.targets_json)[leftover.index]?.filename, source: data(row.targets_json)[leftover.index]?.host } }));
    if (error) summary.problems.push(problemFrom(typeof error === "string" ? new Error(error) : error, { phase: "saved Run" }));
    const uncertain = effects.some(e => ["started", "uncertain"].includes(e.state));
    const rejected = effects.some(e => e.kind !== "admission" && ["rejected", "partial"].includes(e.state));
    const status = uncertain ? "uncertain" : expectedTargets > 0 && targets.length === expectedTargets && targets.every(e => e.state === "confirmed") ? "submitted"
      : admitted?.length === 0 || rejected || error ? summary.submitted ? "partial" : "rejected" : "preparing";
    store.variationOutcome(id, status, canonical(summary), { submitted: summary.submitted, total: summary.total, planned: summary.plannedCount });
    return { ...summary, outcome: status };
  };
  const receipt = (id, targetIndex, resourceId) => {
    const effect = store.variationEffects(id).find(e => e.effect_id === `upload-${targetIndex}-${resourceId}`);
    if (!effect || effect.state !== "confirmed" || !effect.result_json) throw fail(`Image ${resourceId} is not materialized`, 409);
    return data(effect.result_json);
  };
  const preflight = (snapshot, destination) => {
    const targets = snapshot.targets.map((target, index) => {
      try { return countingTarget(target, snapshot.recipe, snapshot.resources, destination, index); }
      catch (error) { return { ...target, problem: { code: "invalid-resource", message: error.message } }; }
    });
    return planCohort({ ...snapshot, targets, destination });
  };
  const admit = async (id, row, snapshot) => {
    const prior = store.variationEffects(id).find(effect => effect.effect_id === "admission");
    if (prior) {
      if (prior.state !== "confirmed") throw fail("Saved admission is interrupted; start a new Run", 409);
      return data(prior.result_json);
    }
    const admission = { snapshotHash: row.snapshot_hash, targets: preflight(snapshot, captured(row).destination) };
    store.variationPrepareEffect(id, "admission", "admission", canonical(admission), await digest(admission));
    if (!store.variationClaimEffect(id, "admission")) throw fail("Saved admission unavailable", 409);
    store.variationEffectResult(id, "admission", "confirmed", canonical(admission));
    outcome(id);
    return admission;
  };
  const admittedTarget = (id, row, index) => {
    const effect = store.variationEffects(id).find(effect => effect.effect_id === "admission" && effect.kind === "admission");
    const admission = effect?.state === "confirmed" && data(effect.result_json);
    const target = admission?.snapshotHash === row.snapshot_hash && admission.targets[index];
    if (!target || target.problem || !Number.isSafeInteger(target.count) || target.count <= 0) throw fail(target?.problem?.message ?? "Target has no saved admission; start a new Run", 409);
    return target;
  };
  const targetProblem = async (id, index, origin, snapshotHash, error) => {
    const row = store.variationGet(id);
    if (!row || row.deleted_at !== null || !row.recipe_json || snapshotHash !== row.snapshot_hash || !sameOrigin(destinationOf(row, index), origin)) return;
    const effects = store.variationEffects(id), effect = effects.find(effect => effect.kind === "admission" && effect.state === "confirmed");
    const admission = effect && data(effect.result_json).targets[index];
    if (!admission || admission.problem || effects.some(effect => effect.effect_id === `leftover-${index}`)) return;
    const target = data(row.targets_json)[index];
    const leftover = { index, problem: problemFrom(error, { phase: "preparation", target: { index, source: target?.host, name: target?.filename } }) };
    store.variationPrepareEffect(id, `leftover-${index}`, "leftover", canonical(leftover), await digest(leftover));
    if (store.variationClaimEffect(id, `leftover-${index}`)) store.variationEffectResult(id, `leftover-${index}`, "confirmed", canonical(leftover));
    outcome(id, error.message);
  };
  const api = {
    // Read-only preview uses the same inspection and resource owners as capture,
    // but never reserves archive membership, history rows or upstream effects.
    async plan(body) {
      if (!body || !["single", "bulk"].includes(body.cohortMode) || !Array.isArray(body.targets) || !body.targets.length ||
          body.cohortMode === "single" && body.targets.length !== 1 || !Array.isArray(body.resources)) throw fail("Invalid cohort plan");
      if (body.destination && (!validOrigin(body.destination) || body.destination.kind !== "comfy")) throw fail("Invalid Run destination");
      const recipe = decodeHistoryRecipe({ format: 1, recipe: body.recipe });
      const resources = await Promise.all(body.resources.map(async descriptor => {
        if (descriptor.kind === "upload") return { ...descriptor, hash: /^[a-f0-9]{64}$/.test(descriptor.hash) ? descriptor.hash : null };
        if (descriptor.kind === "archive") return { ...descriptor, hash: member(descriptor.runId, descriptor.resourceId, descriptor.leaseId).hash };
        if (descriptor.kind === "server-path") return { ...descriptor, hash: await sha256((await readImage(descriptor.path)).bytes) };
        if (!["input", "reference"].includes(descriptor.kind) || !resourceReference(descriptor.value)) throw fail("Invalid image resource");
        const target = body.targets[0]; current(target);
        const ref = resourceReference(descriptor.value), read = await app.ingest.ensure(target.host, ref.name, ref.root, { priority: "high" });
        current(target);
        if (read.status !== 200) throw fail(`${ref.name}: image resource unavailable`, read.status);
        return { ...descriptor, ...ref, host: target.host, hash: read.hash };
      }));
      const targets = await Promise.all(body.targets.map(async (target, index) => {
        try {
          current(target);
          let archived = null;
          if (target.historyRef) {
            const previous = sealed(target.historyRef.runId, target.historyRef.leaseId).snapshot;
            const saved = previous.targets[target.historyRef.targetIndex];
            if (!saved || saved.host !== target.host || saved.filename !== target.filename || saved.source.address !== target.origin.address) throw fail("Saved target/source mismatch", 412);
            archived = { graph: saved.graph, hash: saved.hash };
          }
          if (!archived) {
            const read = await app.ingest.ensure(target.host, target.filename, "output", { priority: "high" });
            if (read.status !== 200) throw fail(`${target.filename}: original target unavailable`, read.status);
            current(target);
          }
          const r = throwInspection(await inspectSource(app, target.host, target.filename, target.context ?? { origin: target.origin }, archived));
          const catalogue = await inspectDestination(app, { graph: r.graph, hash: r.context.graphHash, name: target.filename,
            original: projectInspection(r, target.filename), originContext: r.context, destination: body.destination });
          throwInspection(catalogue);
          const graphResources = {}, targetResources = [...resources, { id: `target-${index}`, host: target.host, root: "output", name: target.filename, hash: r.context.graphHash }];
          for (const parameter of catalogue.parameters.filter(p => p.kind === "image")) {
            const value = parameterCurrent(parameter), ref = resourceReference(value);
            if (!ref) throw fail(`${parameter.id}: original image reference unavailable`, 409);
            const resourceId = `graph-${index}-${Object.keys(graphResources).length}`;
            let hash;
            if (target.historyRef) {
              const saved = sealed(target.historyRef.runId, target.historyRef.leaseId).snapshot.targets[target.historyRef.targetIndex];
              hash = member(target.historyRef.runId, saved.graphResources[parameter.id], target.historyRef.leaseId).hash;
            } else {
              const read = await app.ingest.ensure(target.host, ref.name, ref.root, { priority: "high" });
              if (read.status !== 200) throw fail(`${ref.name}: declared graph input unavailable`, read.status);
              hash = read.hash;
            }
            targetResources.push({ id: resourceId, ...ref, value, host: target.host, hash }); graphResources[parameter.id] = resourceId;
          }
          current(target); if (body.destination) currentDestination(body.destination);
          return countingTarget({ ...target, graph: r.graph, catalogue, graphResources }, recipe, targetResources, body.destination, index);
        } catch (error) { return { ...target, problem: { code: "unavailable", message: error.message } }; }
      }));
      return planCohort({ targets, cohortMode: body.cohortMode, recipe, destination: body.destination });
    },
    begin(body) {
      if (!body || body.format !== 1 || !historyId(body.runId) || !["single", "bulk"].includes(body.cohortMode) ||
        !Array.isArray(body.targets) || !body.targets.length || body.cohortMode === "single" && body.targets.length !== 1 || !Array.isArray(body.resources)) throw fail("Invalid history capture");
      for (const key of Object.keys(body)) if (!["runId", "format", "cohortMode", "targets", "recipe", "resources", "destination"].includes(key)) throw fail("Unknown history capture field");
      if (body.destination !== undefined && (!validOrigin(body.destination) || body.destination.kind !== "comfy")) throw fail("Run destination must be a ComfyUI source");
      const recipe = decodeHistoryRecipe({ format: 1, recipe: body.recipe });
      const resources = cloneJsonValue(body.resources), ids = new Set();
      for (const r of resources) {
        if (!/^image-\d+$/.test(r.id) || ids.has(r.id) || !["upload", "input", "reference", "server-path", "archive"].includes(r.kind) || typeof r.name !== "string" || !r.name) throw fail("Invalid saved resource descriptor");
        ids.add(r.id);
        if (["input", "reference"].includes(r.kind) && !resourceReference(r.value)) throw fail("Invalid saved image reference");
        if (r.kind === "archive") member(r.runId, r.resourceId, r.leaseId);
      }
      for (const entry of Object.values(recipe.images)) for (const values of [entry.values, entry.baseline]) for (const item of values.items) {
        if (item.kind !== "target" && (item.kind !== "archive" || item.runId !== body.runId || !ids.has(item.resourceId))) throw fail("Saved image is outside this capture");
      }
      const targets = cloneJsonValue(body.targets);
      for (const target of targets) {
        if (target.id !== `${target.host}:${target.filename}` || !validOrigin(target.origin) || target.origin.source !== target.host || !validEntryName(target.origin.address, target.filename)) throw fail("Invalid captured target");
        if (target.context && (!validContext(target.context) || !sameOrigin(target.context.origin, target.origin))) throw fail("Invalid captured target context");
        if (target.historyRef) sealed(target.historyRef.runId, target.historyRef.leaseId);
      }
      const document = { format: 1, cohortMode: body.cohortMode, recipe, resources, ...(body.destination ? { destination: cloneJsonValue(body.destination) } : {}) };
      return store.variationBegin({ id: body.runId, format: 1, recipeJson: canonical(document), targetsJson: canonical(targets),
        summaryJson: canonical(historySummary(recipe, targets, resources)), resources: resources.map(r => ({ id: r.id, descriptorJson: canonical(r) })) });
    },
    detail(id, leaseId = null) {
      const row = record(id, leaseId), raw = captured(row), effects = store.variationEffects(id);
      return { id, format: 1, createdAt: row.created_at, captureState: row.capture_state, outcome: row.outcome,
        submission: { sent: effects.filter(e => e.kind === "permutation" && e.result_json && data(e.result_json).sent === true).length, total: row.total_count },
        snapshotHash: row.snapshot_hash, summary: summaryOf(row, effects), ...raw,
        effects: store.variationEffects(id).map(e => ({ id: e.effect_id, kind: e.kind, state: e.state, result: e.result_json ? data(e.result_json) : null })),
        admission: store.variationEffects(id).find(e => e.kind === "admission" && e.state === "confirmed")?.result_json
          ? data(store.variationEffects(id).find(e => e.kind === "admission").result_json).targets : null,
        targets: row.snapshot_json ? data(row.snapshot_json).targets : data(row.targets_json),
        resources: row.snapshot_json ? data(row.snapshot_json).resources : store.variationResources(id).map(r => ({ ...data(r.descriptor_json), hash: r.hash })) };
    },
    summary: row => summaryOf(row),
    async uploadBytes(id, resourceId, bytes) {
      const row = record(id), ref = store.variationResource(id, resourceId);
      if (!ref || data(ref.descriptor_json).kind !== "upload") throw fail("Image upload is not part of this capture", 410);
      if (row.capture_state !== "preparing" && !ref.hash) throw fail("Capture is not preparing", 409);
      return attach(id, resourceId, bytes);
    },
    prepare(id) { return single(`prepare-${id}`, async () => {
      const row = record(id), raw = captured(row), targets = data(row.targets_json);
      if (row.snapshot_hash) {
        await admit(id, row, data(row.snapshot_json));
        return api.detail(id);
      }
      if (row.capture_state !== "preparing") throw fail("Interrupted capture cannot be resumed automatically", 409);
      try {
        const prepared = [], resources = [];
        for (const [index, target] of targets.entries()) {
          current(target);
          let bytes, graph, hash;
          if (target.historyRef) {
            const old = sealed(target.historyRef.runId, target.historyRef.leaseId).snapshot.targets[target.historyRef.targetIndex];
            if (!old || old.host !== target.host || old.filename !== target.filename || old.source.address !== target.origin.address || old.source.kind !== target.origin.kind) throw fail("Saved target/source mismatch", 412);
            bytes = await app.archive.read(member(target.historyRef.runId, `target-${target.historyRef.targetIndex}`, target.historyRef.leaseId).hash);
            graph = old.graph; hash = old.hash;
          } else {
            const read = await app.ingest.ensure(target.host, target.filename, "output", { priority: "high", fresh: true });
            if (read.status !== 200) throw fail(`${target.filename}: original target unavailable`, read.status);
            ({ bytes, hash } = read);
            if (target.context?.graphHash && target.context.graphHash !== hash) throw fail("Captured target changed", 412);
            graph = (await metaFromBytes(bytes, target.filename))[2];
          }
          current(target);
          const r = throwInspection(await inspectSource(app, target.host, target.filename, { origin: target.origin, graphHash: hash }, { graph, hash }));
          let catalogue = projectInspection(r, target.filename);
          // The snapshot records the workflow as its Run destination declares it.
          const destination = raw.destination;
          if (destination && !sameOrigin(destination, target.origin)) {
            currentDestination(destination);
            const { context: _context, ...facts } = await inspectDestination(app, { graph, hash, name: target.filename, original: catalogue, originContext: r.context, destination })
              .then(result => { if (result.error) throw fail(result.error, result.status); return result; });
            catalogue = { ...facts, context: r.context };
          }
          const targetResource = { id: `target-${index}`, kind: "target", name: target.filename, root: "output", host: target.host };
          reserve(id, targetResource); await attach(id, targetResource.id, bytes); resources.push({ ...targetResource, hash });
          const graphResources = {};
          for (const p of catalogue.parameters.filter(p => p.kind === "image")) {
            const reference = resourceReference(parameterCurrent(p));
            if (!reference) throw fail(`${p.id}: original image reference unavailable`, 409);
            const descriptor = { id: `graph-${index}-${Object.keys(graphResources).length}`, kind: "reference", ...reference, value: parameterCurrent(p), host: target.host };
            reserve(id, descriptor);
            let original;
            if (target.historyRef) {
              const previous = sealed(target.historyRef.runId, target.historyRef.leaseId).snapshot.targets[target.historyRef.targetIndex];
              const ref = member(target.historyRef.runId, previous.graphResources[p.id], target.historyRef.leaseId);
              original = await app.archive.read(ref.hash);
            } else {
              const read = await app.ingest.ensure(target.host, reference.name, reference.root, { priority: "high", fresh: true });
              if (read.status !== 200) throw fail(`${reference.name}: declared graph input unavailable`, 409);
              original = read.bytes;
            }
            const archived = await attach(id, descriptor.id, original); resources.push({ ...descriptor, hash: archived.hash }); graphResources[p.id] = descriptor.id;
          }
          const { context: _context, ...facts } = catalogue;
          prepared.push({ id: target.id, host: target.host, filename: target.filename, source: { address: target.origin.address, kind: target.origin.kind },
            hash, graph, catalogue: facts, graphResources });
        }
        for (const descriptor of raw.resources) {
          const ref = store.variationResource(id, descriptor.id);
          let bytes, provenance = descriptor;
          if (ref.hash) { resources.push({ ...descriptor, hash: ref.hash }); continue; }
          if (descriptor.kind === "upload") throw fail(`${descriptor.name}: browser bytes not archived`, 409);
          if (descriptor.kind === "archive") {
            const old = sealed(descriptor.runId, descriptor.leaseId).snapshot.resources.find(r => r.id === descriptor.resourceId);
            if (!old) throw fail("Saved image membership unavailable", 410);
            bytes = await app.archive.read(member(descriptor.runId, descriptor.resourceId, descriptor.leaseId).hash);
            provenance = { ...old, id: descriptor.id };
          } else if (descriptor.kind === "server-path") bytes = (await readImage(descriptor.path)).bytes;
          else {
            const read = await app.ingest.ensure(targets[0].host, descriptor.name, descriptor.root, { priority: "high", fresh: true });
            if (read.status !== 200) throw fail(`${descriptor.name}: saved input unavailable`, 409);
            bytes = read.bytes; provenance = { ...descriptor, host: targets[0].host };
          }
          const archived = await attach(id, descriptor.id, bytes); resources.push({ ...provenance, hash: archived.hash });
        }
        for (const target of targets) current(target);
        const snapshot = { format: 1, cohortMode: raw.cohortMode, recipe: raw.recipe, targets: prepared, resources };
        const snapshotHash = await digest(snapshot);
        store.variationSeal(id, canonical(snapshot), snapshotHash, canonical(historySummary(raw.recipe, prepared, resources)));
        await admit(id, record(id), snapshot);
        return api.detail(id);
      } catch (error) { outcome(id, error); throw error; }
    }); },
    async open(id) {
      const { row, snapshot } = sealed(id), leaseId = crypto.randomUUID();
      if (await digest(snapshot) !== row.snapshot_hash) throw fail("Saved snapshot integrity check failed", 409);
      store.variationLeaseAcquire(id, "editor", leaseId);
      const targets = [];
      for (const [targetIndex, target] of snapshot.targets.entries()) {
        const origin = sourceOrigin(target.host, app.backings.source(target.host));
        const matching = origin?.address === target.source.address && origin?.kind === target.source.kind;
        let unavailable = matching ? null : "The original source is missing or its address changed. Saved values remain inspectable.";
        if (matching) {
          try {
            const inspected = await inspectSource(app, target.host, target.filename, { origin, graphHash: target.hash }, { graph: target.graph, hash: target.hash });
            if (inspected.error || !inspected.outputClasses) unavailable = inspected.error ?? inspected.schemaError ?? "The original backend is unavailable";
          } catch (error) { unavailable = error.message; }
        }
        targets.push({ ...target, origin: matching ? origin : null, unavailable, historyRef: { runId: id, targetIndex, leaseId },
          context: matching ? { origin, graphHash: target.hash } : null });
      }
      const detail = api.detail(id, leaseId), recipe = snapshotDraft(detail.recipe);
      for (const entry of Object.values(recipe.images)) for (const values of [entry.values, entry.baseline]) for (const item of values.items) {
        if (item.kind !== "archive") continue;
        item.leaseId = leaseId;
        item.hash = snapshot.resources.find(r => r.id === item.resourceId)?.hash;
      }
      return { ...detail, recipe, leaseId, snapshotHash: row.snapshot_hash, targets };
    },
    // A held saved run as a chosen destination sees it; readonly, no effects.
    async catalogue(id, leaseId, targetIndex, destination) {
      const { snapshot } = sealed(id, leaseId), saved = snapshot.targets[targetIndex];
      if (!saved) throw fail("Saved target unavailable", 410);
      const origin = sourceOrigin(saved.host, app.backings.source(saved.host));
      const originContext = origin?.address === saved.source.address && origin?.kind === saved.source.kind ? { origin, graphHash: saved.hash } : null;
      const result = await inspectDestination(app, { graph: saved.graph, hash: saved.hash, name: saved.filename, original: saved.catalogue, originContext, destination });
      if (result.error) throw fail(result.error, result.status);
      return result;
    },
    async bytes(id, resourceId, leaseId) { return app.archive.read(member(id, resourceId, leaseId).hash); },
    async release(id, leaseId) { store.variationLeaseRelease(id, leaseId); await collect(id); },
    async remove(id) {
      if (!historyId(id) || !store.variationGet(id)) throw fail("History entry unavailable", 410);
      store.variationTombstone(id); await collect(id);
    },
    materialize(id, targetIndex, resourceId, origin, snapshotHash) { return single(`upload-${id}-${targetIndex}-${resourceId}`, async () => {
      const { row, snapshot } = sealed(id), target = data(row.targets_json)[targetIndex], destination = destinationOf(row, targetIndex);
      if (!target || !sameOrigin(destination, origin) || row.snapshot_hash !== snapshotHash) throw fail("Saved upload binding mismatch", 412);
      admittedTarget(id, row, targetIndex);
      currentDestination(destination);
      const resource = snapshot.resources.find(r => r.id === resourceId);
      if (!resource) throw fail("Saved resource unavailable", 410);
      const saved = snapshot.targets[targetIndex];
      if (!store.variationEffects(id).some(e => e.effect_id === `upload-${targetIndex}-${resourceId}`)) await destinationReady(destination, saved, target);
      const involved = new Set(Object.entries(saved.graphResources).filter(([, rid]) => rid === resourceId).map(([pid]) => pid));
      for (const [pid, entry] of Object.entries(snapshot.recipe.images)) if (entry.values.enabled && entry.values.items.some(item =>
        item.kind === "target" ? resourceId === `target-${targetIndex}` : item.resourceId === resourceId)) involved.add(pid);
      if (!involved.size) throw fail("This saved resource is not an active target requirement");
      const effectId = `upload-${targetIndex}-${resourceId}`, request = { resourceId, targetIndex, origin, snapshotHash };
      const effect = store.variationPrepareEffect(id, effectId, "upload", canonical(request), await digest(request));
      if (effect.state === "confirmed") return data(effect.result_json);
      if (effect.state !== "prepared") throw fail("Upload is pending or uncertain; do not automatically retry", 409);
      const bytes = await api.bytes(id, resourceId);
      let value = null;
      if (resource.root && resource.host === destination.source) {
        const read = await app.ingest.ensure(destination.source, resource.name, resource.root, { priority: "high", fresh: true });
        currentDestination(destination);
        if (read.status === 200 && read.hash === resource.hash) value = resource.value ?? `${resource.name} [${resource.root}]`;
      }
      // One destination per Run: identical bytes already delivered there for
      // another target are reused, never uploaded twice.
      if (value === null) {
        const twins = new Set(snapshot.resources.filter(r => r.hash === resource.hash).map(r => r.id));
        for (const prior of store.variationEffects(id)) {
          const match = /^upload-\d+-(.+)$/.exec(prior.effect_id);
          if (prior.effect_id === effectId || prior.state !== "confirmed" || !match || !twins.has(match[1]) || !prior.result_json) continue;
          const delivered = data(prior.result_json);
          if (sameOrigin(delivered.origin, origin)) { value = delivered.value; break; }
        }
      }
      if (!store.variationClaimEffect(id, effectId)) throw fail("Upload was already admitted", 409);
      let outboundStarted = false;
      try {
        let result;
        if (value !== null) result = { value, name: resource.name, origin, hash: resource.hash, reused: true };
        else {
          const parameters = parameterIndex(saved.catalogue.parameters);
          for (const pid of involved) {
            const p = parameters.get(pid);
            if (!p) throw fail(`Saved image parameter ${pid} is unavailable`);
            admitResourceTransfer(p);
          }
          const { token } = currentDestination(destination), backing = app.backings.backingFor(token.address);
          if (!backing.write) throw fail("This source cannot materialize saved images");
          outboundStarted = true;
          const write = await backing.write(token.address, resource.name.split("/").at(-1), bytes);
          if (!write.ok) throw fail(write.error, write.status ?? 502);
          result = { value: write.name, name: write.name, origin, hash: resource.hash, reused: false };
        }
        // Persist actual old-origin effects even if source retirement wins next.
        store.variationEffectResult(id, effectId, "confirmed", canonical(result));
        currentDestination(destination);
        return result;
      } catch (error) {
        store.variationEffectResult(id, effectId, !outboundStarted || error.status && error.status < 500 ? "rejected" : "uncertain", canonical({ error: error.message }));
        outcome(id, error); throw error;
      } finally { await collect(id); }
    }, canonical({ origin, snapshotHash })).catch(async error => {
      await targetProblem(id, targetIndex, origin, snapshotHash, error);
      throw error;
    }); },
    prepareTarget(id, targetIndex, origin, snapshotHash) { return single(`plan-${id}-${targetIndex}`, async () => {
      const { row, snapshot } = sealed(id), target = data(row.targets_json)[targetIndex], saved = snapshot.targets[targetIndex], destination = destinationOf(row, targetIndex);
      if (await digest(snapshot) !== row.snapshot_hash) throw fail("Saved snapshot integrity check failed", 409);
      if (!saved || !target || !sameOrigin(destination, origin) || snapshotHash !== row.snapshot_hash) throw fail("Saved target binding mismatch", 412);
      const admitted = admittedTarget(id, row, targetIndex);
      currentDestination(destination);
      const prior = store.variationEffects(id).find(e => e.effect_id === `target-${targetIndex}`);
      if (prior) return data(prior.request_json);
      const graph = cloneJsonValue(saved.graph), oldParameters = parameterIndex(saved.catalogue.parameters);
      for (const [parameterId, resourceId] of Object.entries(saved.graphResources)) {
        const p = oldParameters.get(parameterId), resolved = receipt(id, targetIndex, resourceId);
        if (!sameOrigin(resolved.origin, origin)) throw fail("Materialized source changed", 412);
        graph[p.nodeIds[0]].inputs[p.key] = resolved.value;
      }
      const r = throwInspection(await inspectSource(app, destination.source, target.filename, { origin, graphHash: saved.hash }, { graph, hash: saved.hash }));
      if (!sameOrigin(destination, target.origin)) {
        const missing = await missingAt(destination, target, saved.graph, saved.hash, r);
        if (missing.length) throw fail(`Not installed on ${destination.source}: ${missing.join(", ")}; no jobs were submitted`, 409);
      }
      const catalogue = projectInspection(r, target.filename);
      const recipe = bindCohortRecipe(snapshot.recipe, catalogue), resourceValues = new Map();
      for (const [domain, rows] of Object.entries(recipe)) for (const [pid, entry] of Object.entries(rows)) {
        if (domain === "images" && entry.values.enabled) for (const item of entry.values.items) {
          const resourceId = item.kind === "target" ? `target-${targetIndex}` : item.resourceId;
          const resolved = receipt(id, targetIndex, resourceId);
          if (!sameOrigin(resolved.origin, origin)) throw fail("Materialized source changed", 412);
          resourceValues.set(imageIdentity(item), resolved);
        }
      }
      const { plan, count: expectedTotal } = planTarget({ target: { ...target, catalogue }, cohortMode: snapshot.cohortMode, recipe, destination, resourceValues });
      if (expectedTotal !== admitted.count) throw fail("Receipt-backed count changed from the saved admission; work was kept. Start a new Run.", 409);
      const request = { id: target.id, host: target.host, filename: target.filename, ...plan.payload, context: r.context,
        acknowledgement: { version: 2, runId: id, requestId: crypto.randomUUID() } };
      const planHash = await digest({ request, graph });
      request.history = { id, snapshotHash, targetIndex, planHash };
      const prepared = { request, graph, expectedTotal, operations: plan.operations, planHash };
      store.variationPrepareEffect(id, `target-${targetIndex}`, "target", canonical(prepared), await digest(prepared));
      outcome(id);
      return prepared;
    }, canonical({ origin, snapshotHash })).catch(async error => {
      await targetProblem(id, targetIndex, origin, snapshotHash, error);
      throw error;
    }); },
    dispatch(body, execute) { return app.lifetime.run(`variation dispatch ${body.acknowledgement?.requestId}`, async () => {
      const binding = body.history;
      if (!binding || !historyId(binding.id) || !Number.isSafeInteger(binding.targetIndex)) throw fail("Invalid saved Run binding");
      const { row, snapshot } = sealed(binding.id), id = binding.id;
      if (await digest(snapshot) !== row.snapshot_hash) throw fail("Saved snapshot integrity check failed", 409);
      if (binding.snapshotHash !== row.snapshot_hash || body.acknowledgement?.runId !== id) throw fail("Saved snapshot binding mismatch", 409);
      admittedTarget(id, row, binding.targetIndex);
      const effect = store.variationEffects(id).find(e => e.effect_id === `target-${binding.targetIndex}`);
      if (!effect || !sameJsonValue(data(effect.request_json).request, body)) throw fail("Run is not the engine-prepared saved plan", 409);
      if (effect.state !== "prepared") {
        if (effect.result_json && ["confirmed", "rejected", "partial"].includes(effect.state)) return data(effect.result_json);
        throw fail("Submission is pending or uncertain; do not automatically retry", 409);
      }
      const prepared = data(effect.request_json), saved = snapshot.targets[binding.targetIndex];
      const r = throwInspection(await inspectSource(app, body.context.origin.source, body.filename, body.context, { graph: prepared.graph, hash: saved.hash }));
      const leaseId = store.variationClaimExecution(id, effect.effect_id);
      if (!leaseId) throw fail("Submission was already admitted", 409);
      try {
        const response = await execute(r, { submit: (job, index) => {
          const effectId = `job-${binding.targetIndex}-${index}`;
          const request = submitPrompt(r.backing, job, {
            isCurrent: () => app.backings.isCurrent(r.token),
            beforeSend: async () => {
              store.variationPrepareEffect(id, effectId, "permutation", canonical(job), await digest(job));
              if (!store.variationClaimEffect(id, effectId)) throw fail("Permutation was already admitted", 409);
            },
            onSent: () => store.variationEffectSent(id, effectId),
          });
          return { sent: request.sent, result: request.result.then(result => {
            store.variationEffectResult(id, effectId, result.ok && result.acceptance === "confirmed" ? "confirmed" : result.acceptance === "partial" ? "partial"
              : result.acceptance === "uncertain" ? "uncertain" : result.status && result.status < 500 ? "rejected" : "uncertain", canonical(result));
            return result;
          }) };
        } });
        const result = { status: response.status, data: problemEnvelope({ ...parseExactJson(await response.text()), history: binding }, {
          phase: "submission", target: { index: binding.targetIndex, source: body.host, name: body.filename } }) };
        result.data.effectCounts = effectCounts(store.variationEffects(id).filter(job => job.kind === "permutation" && job.effect_id.startsWith(`job-${binding.targetIndex}-`))
          .map(job => ({ ...job, result: job.result_json ? data(job.result_json) : null })), prepared.expectedTotal);
        store.variationEffectResult(id, effect.effect_id, result.data.outcome === "accepted-plan" ? "confirmed" : result.data.outcome === "uncertain-effects" ? "uncertain" : result.data.submitted ? "partial" : "rejected", canonical(result));
        outcome(id, result.data.problem ?? result.data.errors?.[0]?.problem ?? result.data.error ?? result.data.errors?.[0]?.error ?? null);
        return result;
      } catch (error) {
        outcome(id, problemFrom(error, { phase: "submission", target: { index: binding.targetIndex, source: body.host, name: body.filename } }));
        throw error;
      } finally {
        // This request is finished regardless of sibling targets. Durable
        // unresolved-effect guards, not an abandoned request pin, retain bytes.
        await api.release(id, leaseId);
      }
    }); },
    finish(id, error = null) { record(id); return outcome(id, typeof error === "string" ? error : null); },
  };
  return api;
}
