// One engine owner for captured configurations, archive membership and durable
// outbound-effect claims. SQL and byte storage remain injected capabilities.
import { sha256 } from "../../cache.mjs";
import { metaFromBytes } from "../../extractor.mjs";
import { validEntryName } from "../../backings/index.mjs";
import { validOrigin, sameOrigin, sourceOrigin, validContext } from "../../source-origin.mjs";
import { cloneJsonValue, parseExactJson, stringifyExactJson, resourceReference, sameJsonValue, parameterCurrent, parameterLabel } from "../../parameters.mjs";
import { historyId, decodeHistoryRecipe } from "./history-codec.mjs";
import { imageIdentity, snapshotDraft, numericText } from "./recipe-model.mjs";
import { compileRecipe } from "./recipe-compile.mjs";
import { admitResourceTransfer } from "./compile.mjs";
import { targetRunPlan, parameterIndex, permutationPlan, resolveRelativeRanges } from "./shared.mjs";
import { inspectSource, projectInspection } from "./inspection.mjs";
import { readImage } from "./folder-images.mjs";

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
  const record = (id, leaseId = null) => {
    if (!historyId(id)) throw fail("Invalid history Run ID");
    const row = store.variationGet(id);
    if (!row || row.deleted_at !== null && !store.variationLease(id, leaseId)) throw fail("History entry unavailable", 410);
    if (row.format !== 1 || !row.recipe_json) throw fail("Unsupported or unavailable history entry", 410);
    return row;
  };
  const captured = row => data(row.recipe_json);
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
    if (!row) return;
    const summary = data(row.summary_json), effects = store.variationEffects(id), jobs = effects.filter(e => e.kind === "permutation");
    summary.submitted = jobs.filter(e => e.state === "confirmed" || e.state === "partial").length;
    const targets = effects.filter(e => e.kind === "target");
    const known = targets.map(e => data(e.request_json).expectedTotal);
    const expectedTargets = data(row.targets_json).length;
    summary.total = targets.length === expectedTargets ? known.reduce((a, b) => a + b, 0) : null;
    summary.plannedCount = summary.total;
    summary.error = error ?? summary.error;
    const uncertain = effects.some(e => ["started", "uncertain"].includes(e.state));
    const rejected = effects.some(e => ["rejected", "partial"].includes(e.state));
    const status = uncertain ? "uncertain" : targets.length === expectedTargets && targets.every(e => e.state === "confirmed") ? "submitted"
      : rejected || error ? summary.submitted ? "partial" : "rejected" : "preparing";
    store.variationOutcome(id, status, canonical(summary), { submitted: summary.submitted, total: summary.total, planned: summary.plannedCount });
    return { ...summary, outcome: status };
  };
  const receipt = (id, targetIndex, resourceId) => {
    const effect = store.variationEffects(id).find(e => e.effect_id === `upload-${targetIndex}-${resourceId}`);
    if (!effect || effect.state !== "confirmed" || !effect.result_json) throw fail(`Image ${resourceId} is not materialized`, 409);
    return data(effect.result_json);
  };
  const boundRecipe = (snapshot, catalogue) => {
    const recipe = snapshotDraft(snapshot.recipe), parameters = parameterIndex(catalogue.parameters);
    for (const rows of Object.values(recipe)) for (const [pid, entry] of Object.entries(rows)) {
      const p = parameters.get(pid);
      if (p) entry.metadata = { ...entry.metadata, ...p, label: parameterLabel(p) };
    }
    return recipe;
  };
  const preflight = snapshot => {
    for (const saved of snapshot.targets) {
      const recipe = boundRecipe(snapshot, saved.catalogue);
      for (const entry of Object.values(recipe.numeric)) if (entry.values.enabled && entry.values.mode === "range") {
        const step = numericText(entry.values.rawIncrement);
        if (step === null || step < entry.metadata.minIncrement) throw fail("Enter a valid positive increment; incomplete text has been kept.");
      }
      const compiled = compileRecipe(recipe, { catalogue: saved.catalogue, target: saved, batch: snapshot.cohortMode === "bulk", preview: true,
        lookup: (_id, item) => ({ hash: snapshot.resources.find(r => r.id === item.resourceId)?.hash, existing: [] }) });
      const plan = targetRunPlan(compiled.estimate, saved.catalogue), index = parameterIndex(saved.catalogue.parameters);
      for (const pid of Object.keys(compiled.transfers)) if (index.has(pid)) admitResourceTransfer(index.get(pid));
      // This is applicability/type preflight only. Predicted resource names in
      // the count estimate never enter a registered or dispatched graph.
      if (!plan) throw fail("Target configuration unavailable");
    }
  };
  const api = {
    begin(body) {
      if (!body || body.format !== 1 || !historyId(body.runId) || !["single", "bulk"].includes(body.cohortMode) ||
        !Array.isArray(body.targets) || !body.targets.length || body.cohortMode !== (body.targets.length > 1 ? "bulk" : "single") || !Array.isArray(body.resources)) throw fail("Invalid history capture");
      for (const key of Object.keys(body)) if (!["runId", "format", "cohortMode", "targets", "recipe", "resources"].includes(key)) throw fail("Unknown history capture field");
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
      const document = { format: 1, cohortMode: body.cohortMode, recipe, resources };
      return store.variationBegin({ id: body.runId, format: 1, recipeJson: canonical(document), targetsJson: canonical(targets),
        summaryJson: canonical(historySummary(recipe, targets, resources)), resources: resources.map(r => ({ id: r.id, descriptorJson: canonical(r) })) });
    },
    detail(id, leaseId = null) {
      const row = record(id, leaseId), raw = captured(row);
      return { id, format: 1, createdAt: row.created_at, captureState: row.capture_state, outcome: row.outcome,
        snapshotHash: row.snapshot_hash, summary: { ...data(row.summary_json), submitted: row.submitted_count, total: row.total_count, plannedCount: row.planned_count }, ...raw,
        effects: store.variationEffects(id).map(e => ({ id: e.effect_id, kind: e.kind, state: e.state, result: e.result_json ? data(e.result_json) : null })),
        targets: row.snapshot_json ? data(row.snapshot_json).targets : data(row.targets_json),
        resources: row.snapshot_json ? data(row.snapshot_json).resources : store.variationResources(id).map(r => ({ ...data(r.descriptor_json), hash: r.hash })) };
    },
    async uploadBytes(id, resourceId, bytes) {
      const row = record(id), ref = store.variationResource(id, resourceId);
      if (!ref || data(ref.descriptor_json).kind !== "upload") throw fail("Image upload is not part of this capture", 410);
      if (row.capture_state !== "preparing" && !ref.hash) throw fail("Capture is not preparing", 409);
      return attach(id, resourceId, bytes);
    },
    prepare(id) { return single(`prepare-${id}`, async () => {
      const row = record(id), raw = captured(row), targets = data(row.targets_json);
      if (row.snapshot_hash) {
        try { preflight(data(row.snapshot_json)); } catch (error) { throw fail(error.message, error.status ?? 400); }
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
          const catalogue = projectInspection(r, target.filename), targetResource = { id: `target-${index}`, kind: "target", name: target.filename, root: "output", host: target.host };
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
        try { preflight(snapshot); } catch (error) { throw fail(error.message, error.status ?? 400); }
        return api.detail(id);
      } catch (error) { outcome(id, error.message); throw error; }
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
    async bytes(id, resourceId, leaseId) { return app.archive.read(member(id, resourceId, leaseId).hash); },
    async release(id, leaseId) { store.variationLeaseRelease(id, leaseId); await collect(id); },
    async remove(id) {
      if (!historyId(id) || !store.variationGet(id)) throw fail("History entry unavailable", 410);
      store.variationTombstone(id); await collect(id);
    },
    materialize(id, targetIndex, resourceId, origin, snapshotHash) { return single(`upload-${id}-${targetIndex}-${resourceId}`, async () => {
      const { row, snapshot } = sealed(id), target = data(row.targets_json)[targetIndex];
      if (!target || !sameOrigin(target.origin, origin) || row.snapshot_hash !== snapshotHash) throw fail("Saved upload binding mismatch", 412);
      current(target);
      try { preflight(snapshot); } catch (error) { throw fail(error.message, error.status ?? 400); }
      const resource = snapshot.resources.find(r => r.id === resourceId);
      if (!resource) throw fail("Saved resource unavailable", 410);
      const saved = snapshot.targets[targetIndex], involved = new Set(Object.entries(saved.graphResources).filter(([, rid]) => rid === resourceId).map(([pid]) => pid));
      for (const [pid, entry] of Object.entries(snapshot.recipe.images)) if (entry.values.enabled && entry.values.items.some(item =>
        item.kind === "target" ? resourceId === `target-${targetIndex}` : item.resourceId === resourceId)) involved.add(pid);
      if (!involved.size) throw fail("This saved resource is not an active target requirement");
      const effectId = `upload-${targetIndex}-${resourceId}`, request = { resourceId, targetIndex, origin, snapshotHash };
      const effect = store.variationPrepareEffect(id, effectId, "upload", canonical(request), await digest(request));
      if (effect.state === "confirmed") return data(effect.result_json);
      if (effect.state !== "prepared") throw fail("Upload is pending or uncertain; do not automatically retry", 409);
      const bytes = await api.bytes(id, resourceId);
      let value = null;
      if (resource.root && resource.host === target.host) {
        const read = await app.ingest.ensure(target.host, resource.name, resource.root, { priority: "high", fresh: true });
        current(target);
        if (read.status === 200 && read.hash === resource.hash) value = resource.value ?? `${resource.name} [${resource.root}]`;
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
          if (new Set(data(row.targets_json).map(t => t.origin.address)).size > 1) throw fail("Local-file variations across different backends are unsupported");
          const { token } = current(target), backing = app.backings.backingFor(token.address);
          if (!backing.write) throw fail("This source cannot materialize saved images");
          outboundStarted = true;
          const write = await backing.write(token.address, resource.name.split("/").at(-1), bytes);
          if (!write.ok) throw fail(write.error, write.status ?? 502);
          result = { value: write.name, name: write.name, origin, hash: resource.hash, reused: false };
        }
        // Persist actual old-origin effects even if source retirement wins next.
        store.variationEffectResult(id, effectId, "confirmed", canonical(result));
        current(target);
        return result;
      } catch (error) {
        store.variationEffectResult(id, effectId, !outboundStarted || error.status && error.status < 500 ? "rejected" : "uncertain", canonical({ error: error.message }));
        outcome(id, error.message); throw error;
      } finally { await collect(id); }
    }, canonical({ origin, snapshotHash })); },
    prepareTarget(id, targetIndex, origin, snapshotHash) { return single(`plan-${id}-${targetIndex}`, async () => {
      const { row, snapshot } = sealed(id), target = data(row.targets_json)[targetIndex], saved = snapshot.targets[targetIndex];
      if (await digest(snapshot) !== row.snapshot_hash) throw fail("Saved snapshot integrity check failed", 409);
      if (!saved || !target || !sameOrigin(target.origin, origin) || snapshotHash !== row.snapshot_hash) throw fail("Saved target binding mismatch", 412);
      current(target);
      const prior = store.variationEffects(id).find(e => e.effect_id === `target-${targetIndex}`);
      if (prior) return data(prior.request_json);
      const graph = cloneJsonValue(saved.graph), oldParameters = parameterIndex(saved.catalogue.parameters);
      for (const [parameterId, resourceId] of Object.entries(saved.graphResources)) {
        const p = oldParameters.get(parameterId), resolved = receipt(id, targetIndex, resourceId);
        if (!sameOrigin(resolved.origin, origin)) throw fail("Materialized source changed", 412);
        graph[p.nodeIds[0]].inputs[p.key] = resolved.value;
      }
      const r = throwInspection(await inspectSource(app, target.host, target.filename, { origin, graphHash: saved.hash }, { graph, hash: saved.hash }));
      const catalogue = projectInspection(r, target.filename);
      const recipe = boundRecipe(snapshot, catalogue), resourceValues = new Map();
      for (const [domain, rows] of Object.entries(recipe)) for (const [pid, entry] of Object.entries(rows)) {
        if (domain === "images" && entry.values.enabled) for (const item of entry.values.items) {
          const resourceId = item.kind === "target" ? `target-${targetIndex}` : item.resourceId;
          const resolved = receipt(id, targetIndex, resourceId);
          if (!sameOrigin(resolved.origin, origin)) throw fail("Materialized source changed", 412);
          resourceValues.set(imageIdentity(item), resolved);
        }
      }
      const compiled = compileRecipe(recipe, { catalogue, target, batch: snapshot.cohortMode === "bulk", resourceValues });
      const plan = targetRunPlan(compiled.payload, catalogue), values = Object.fromEntries(catalogue.parameters.map(p => [p.id, parameterCurrent(p)]));
      const ranges = plan.payload.relative ? resolveRelativeRanges(plan.payload.ranges, values) : plan.payload.ranges;
      const expectedTotal = permutationPlan(ranges, values, plan.payload.imageParams).total;
      if (!Number.isSafeInteger(expectedTotal) || expectedTotal <= 0 || expectedTotal > 500) throw fail("Saved configuration has no valid human-scale permutations");
      const request = { id: target.id, host: target.host, filename: target.filename, ...plan.payload, context: r.context,
        acknowledgement: { version: 2, runId: id, requestId: crypto.randomUUID() } };
      const planHash = await digest({ request, graph });
      request.history = { id, snapshotHash, targetIndex, planHash };
      const prepared = { request, graph, expectedTotal, operations: plan.operations, planHash };
      store.variationPrepareEffect(id, `target-${targetIndex}`, "target", canonical(prepared), await digest(prepared));
      outcome(id);
      return prepared;
    }, canonical({ origin, snapshotHash })); },
    dispatch(body, execute) { return app.lifetime.run(`variation dispatch ${body.acknowledgement?.requestId}`, async () => {
      const binding = body.history;
      if (!binding || !historyId(binding.id) || !Number.isSafeInteger(binding.targetIndex)) throw fail("Invalid saved Run binding");
      const { row, snapshot } = sealed(binding.id), id = binding.id;
      if (await digest(snapshot) !== row.snapshot_hash) throw fail("Saved snapshot integrity check failed", 409);
      if (binding.snapshotHash !== row.snapshot_hash || body.acknowledgement?.runId !== id) throw fail("Saved snapshot binding mismatch", 409);
      const effect = store.variationEffects(id).find(e => e.effect_id === `target-${binding.targetIndex}`);
      if (!effect || !sameJsonValue(data(effect.request_json).request, body)) throw fail("Run is not the engine-prepared saved plan", 409);
      if (effect.state !== "prepared") {
        if (effect.result_json && ["confirmed", "rejected", "partial"].includes(effect.state)) return data(effect.result_json);
        throw fail("Submission is pending or uncertain; do not automatically retry", 409);
      }
      const prepared = data(effect.request_json), saved = snapshot.targets[binding.targetIndex];
      const r = throwInspection(await inspectSource(app, body.host, body.filename, body.context, { graph: prepared.graph, hash: saved.hash }));
      const leaseId = store.variationClaimExecution(id, effect.effect_id);
      if (!leaseId) throw fail("Submission was already admitted", 409);
      try {
        const response = await execute(r, { enqueue: async (job, index) => {
          const effectId = `job-${binding.targetIndex}-${index}`;
          store.variationPrepareEffect(id, effectId, "permutation", canonical(job), await digest(job));
          if (!store.variationClaimEffect(id, effectId)) throw fail("Permutation was already admitted", 409);
          const result = await r.backing.enqueue(job);
          store.variationEffectResult(id, effectId, result.ok && result.acceptance === "confirmed" ? "confirmed" : result.acceptance === "partial" ? "partial" : result.status && result.status < 500 ? "rejected" : "uncertain", canonical(result));
          return result;
        } });
        const result = { status: response.status, data: { ...parseExactJson(await response.text()), history: binding } };
        store.variationEffectResult(id, effect.effect_id, result.data.outcome === "accepted-plan" ? "confirmed" : result.data.outcome === "uncertain-effects" ? "uncertain" : result.data.submitted ? "partial" : "rejected", canonical(result));
        outcome(id, result.data.error ?? result.data.errors?.[0]?.error ?? null);
        return result;
      } catch (error) { outcome(id, error.message); throw error; }
      finally {
        // This request is finished regardless of sibling targets. Durable
        // unresolved-effect guards, not an abandoned request pin, retain bytes.
        await api.release(id, leaseId);
      }
    }); },
    finish(id, error = null) { record(id); return outcome(id, typeof error === "string" ? error : null); },
  };
  return api;
}
