// Effect-free, engine-owned admission. Every target supplies its own inspected
// catalogue and resource identities. No result here is a graph/upload receipt.
import { parameterCurrent, parameterContract } from "../../parameters.mjs";
import { snapshotDraft, numericText, imageIdentity } from "./recipe-model.mjs";
import { compileRecipe, compileNumericOperation } from "./recipe-compile.mjs";
import { admitResourceTransfer } from "./compile.mjs";
import { variationProblem, problemFrom, problemError } from "./problems.mjs";
import { MAX_JOBS_PER_IMAGE } from "./limits.mjs";
import { targetRunPlan, parameterIndex, catalogueParams, parameterLabel, permutationPlan,
  generatePermutations, resolveRelativeRanges, reproducesOriginal, variationOutputName, parameterAliases, templateReplaceWithProof } from "./shared.mjs";

export function bindCohortRecipe(recipe, catalogue) {
  const bound = snapshotDraft(recipe), parameters = parameterIndex(catalogue.parameters ?? catalogueParams(catalogue));
  for (const [domain, rows] of Object.entries(bound)) for (const [id, entry] of Object.entries(rows)) {
    const p = parameters.get(id);
    if (!p) continue; // targetRunPlan owns absent-relative-numeric applicability.
    entry.metadata = { ...entry.metadata, ...p, label: parameterLabel(p) };
    if (domain === "numeric") {
      const constraints = parameterContract(p).constraints;
      entry.metadata.clamp = [...entry.metadata.clamp];
      if (constraints.min !== undefined) entry.metadata.clamp[0] = constraints.min;
      if (constraints.max !== undefined) entry.metadata.clamp[1] = constraints.max;
    }
  }
  return bound;
}

// Materialization visits graph resources, then selected resources in recipe
// order. Local references keep their value; transfers reuse the first confirmed
// same-byte identity. Never substitute a guessed collision filename.
export function countingTarget(target, recipe, resources, destination, index) {
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const resolved = new Map(), byHash = new Map();
  const identity = resource => {
    if (!resource) throw new Error("Image resource identity unavailable");
    if (resolved.has(resource.id)) return resolved.get(resource.id);
    const local = resource.host === (destination?.source ?? target.host) && resource.root;
    const value = local ? resource.value ?? `${resource.name} [${resource.root}]`
      : resource.hash && byHash.has(resource.hash) ? byHash.get(resource.hash) : { resource: resource.hash ?? resource.id };
    resolved.set(resource.id, value);
    if (resource.hash && !byHash.has(resource.hash)) byHash.set(resource.hash, value);
    return value;
  };
  const currentIdentities = Object.fromEntries(Object.entries(target.graphResources ?? {}).map(([id, rid]) => [id, identity(byId.get(rid))]));
  const resourceIdentities = new Map();
  for (const entry of Object.values(recipe.images)) if (entry.values.enabled) for (const item of entry.values.items) {
    resourceIdentities.set(imageIdentity(item), identity(byId.get(item.kind === "target" ? `target-${index}` : item.resourceId)));
  }
  const parameters = parameterIndex(target.catalogue.parameters ?? catalogueParams(target.catalogue));
  for (const [id, value] of Object.entries(currentIdentities)) if (typeof value !== "string") {
    const parameter = parameters.get(id);
    if (!parameter) throw new Error(`${id}: image carrier is missing from this target`);
    admitResourceTransfer(parameter);
  }
  return { ...target, resourceIdentities, currentIdentities };
}

// Shared by admission and receipt-backed preparation. Traversal is checked with
// the actual kernel, after the cap, so count and generation cannot diverge.
export function planTarget({ target, cohortMode, recipe, destination, resourceValues, resourceIdentities }) {
  const catalogue = target.catalogue, bound = bindCohortRecipe(recipe, catalogue);
  for (const entry of Object.values(bound.numeric)) if (entry.values.enabled && entry.values.mode === "range") {
    const step = numericText(entry.values.rawIncrement);
    if (step === null || step <= 0 || step < entry.metadata.minIncrement) compileNumericOperation(entry.values, entry.metadata, { batch: cohortMode === "bulk" });
  }
  const compiled = compileRecipe(bound, { catalogue, target, batch: cohortMode === "bulk", resourceValues, resourceIdentities, preview: !!resourceIdentities });
  const plan = targetRunPlan(resourceIdentities ? compiled.estimate : compiled.payload, catalogue);
  const values = Object.fromEntries([...parameterIndex(catalogue.parameters ?? catalogueParams(catalogue)).values()].map(p => [p.id, parameterCurrent(p)]));
  // Current graph resources have identities too, but only in the counting model.
  Object.assign(values, target.currentIdentities ?? {});
  const ranges = plan.payload.relative ? resolveRelativeRanges(plan.payload.ranges, values) : plan.payload.ranges;
  for (const id of Object.keys(plan.payload.ranges)) if (plan.payload.ranges[id].enabled && !Object.hasOwn(ranges, id)) throw problemError(variationProblem("range-clamp", { phase: "plan", parameter: { id, label: recipe.numeric[id]?.metadata.label ?? id } }));
  const options = { sameHost: reproducesOriginal(target.host, destination?.source) };
  const kernel = permutationPlan(ranges, values, plan.payload.imageParams, options), count = kernel.total;
  const enabled = Object.values(recipe).flatMap(rows => Object.entries(rows)).filter(([, entry]) => entry.values.enabled);
  const absent = plan.operations.filter(op => op.channel === "ranges" && op.disposition === "absent-relative-numeric");
  const notices = absent.map(op => variationProblem("relative-absent", { severity: "warning", phase: "plan",
    parameter: { id: op.parameter, label: recipe.numeric[op.parameter]?.metadata.label ?? op.parameter },
    numbers: { jobs: count, applied: enabled.length - absent.length, selected: enabled.length } }));
  const counts = { requested: enabled.length, applicable: enabled.length - absent.length,
    distinct: kernel.axes.reduce((n, axis) => n * axis.length, 1), excluded: kernel.excluded, admitted: count };
  for (const [id, entry] of enabled) {
    const selected = entry.values.items?.length ?? entry.values.picks?.length ?? entry.values.candidates?.length;
    const distinct = kernel.axes.find(axis => axis.id === id)?.length;
    if (selected > distinct) notices.push(variationProblem("deduplicated", { severity: "warning", phase: "plan",
      parameter: { id, label: entry.metadata.label ?? id }, numbers: { selected, distinct, duplicates: selected - distinct } }));
  }
  if (!Number.isSafeInteger(count) || count > MAX_JOBS_PER_IMAGE) throw Object.assign(new Error(`${count} jobs for this image; the limit is ${MAX_JOBS_PER_IMAGE} per image. Reduce the axes or increase the increment.`), {
    code: "too-many", count: Number.isSafeInteger(count) ? count : 0, counts: { ...counts, admitted: 0 }, notices,
  });
  if (plan.payload.relative) for (const [id, range] of Object.entries(ranges)) {
    const requested = plan.payload.ranges[id];
    if (!requested.enabled || requested.absolute || !requested.clamp) continue;
    if (range.min === range.max && range.min == values[id]) notices.push(variationProblem("relative-clamped", { severity: "warning", phase: "plan", parameter: { id, label: recipe.numeric[id]?.metadata.label ?? id }, numbers: { from: String(requested.min), to: String(requested.max), current: String(values[id]), lo: String(range.min), hi: String(range.max), min: String(requested.clamp[0]), max: String(requested.clamp[1]), jobs: count } }));
  }
  if (count <= 0) throw Object.assign(problemError(variationProblem("no-work", { phase: "plan", destination: destination?.source ?? target.host, names: kernel.axes.map(axis => recipe.numeric[axis.id]?.metadata.label ?? Object.values(recipe).map(rows => rows[axis.id]?.metadata.label).find(Boolean) ?? axis.id), numbers: { excluded: kernel.excluded } })), { counts, notices });
  const permutations = generatePermutations(ranges, values, plan.payload.imageParams, options);
  // Count admission also checks every final name whose inputs are known. Transfer
  // identities remain count-only; receipt-backed planning repeats this check.
  const parameters = catalogue.parameters ?? catalogueParams(catalogue), aliases = parameterAliases(parameters);
  const naming = catalogue.outputNaming;
  const pendingNames = Object.keys(bound.images).some(id => plan.payload.imageParams[id]?.enabled && plan.payload.imageParams[id].values.some(value => typeof value !== "string"));
  if (naming) for (const permutation of permutations) {
    const request = { ...plan.payload, ranges };
    try {
      const projection = pendingNames ? { complete: [request.prefix, request.suffix].every(text => templateReplaceWithProof(String(text ?? ""), permutation, values, aliases, parameters).complete), notices: [] }
        : variationOutputName(naming, request, permutation, values, aliases, parameters, options);
      if (!projection.complete) throw Object.assign(new Error("Unresolved naming token: check Prefix and Suffix."), { problem: variationProblem("naming", { phase: "naming", parameter: { id: "root", label: "Prefix/Suffix" }, detail: "Unresolved naming token: check Prefix and Suffix" }) });
      notices.push(...projection.notices);
    } catch (error) {
      error.problem = problemFrom(error, { phase: "naming", parameter: { id: "root", label: "Prefix/Suffix" }, numbers: { jobs: count } });
      throw Object.assign(error, { counts: { ...counts, admitted: 0 }, notices });
    }
  }
  return { count, plan, compiled, notices, counts };
}

export function planCohort({ targets, cohortMode, recipe, destination }) {
  return targets.map((target, index) => {
    try {
      if (target.problem) throw Object.assign(new Error(target.problem.message), { code: target.problem.code, problem: target.problem.action ? target.problem : undefined });
      const missing = target.catalogue.destination?.missing ?? [];
      if (missing.length) throw Object.assign(new Error(`Not installed on ${destination?.source ?? "destination"}: ${missing.join(", ")}.`), { code: "missing-class" });
      // Unchanged closed-choice conflicts are not repaired by merely selecting a
      // destination. Ordinary enabled edits must supply a compatible value.
      const bound = bindCohortRecipe(recipe, target.catalogue);
      for (const [id, conflict] of Object.entries(target.catalogue.destination?.conflicts ?? {})) {
        if (conflict.kind === "node") continue; // covered by missing classes
        const entry = Object.values(bound).map(rows => rows[id]).find(Boolean);
        if (!entry?.values.enabled) throw new Error(`${id}: choose a value available on ${destination?.source ?? "destination"}.`);
      }
      const { count, counts, notices } = planTarget({ target, cohortMode, recipe, destination, resourceIdentities: target.resourceIdentities });
      const identity = { index, source: target.host, name: target.filename };
      return { index, count, problem: null, counts, notices: notices.map(problem => problemFrom({ problem }, { target: identity })) };
    } catch (error) {
      const problem = problemFrom(Object.assign(error, { code: error.problem?.code ?? error.code ?? (/work budget/.test(error.message) ? "work-budget" : "invalid-plan") }), {
        phase: "plan", destination: destination?.source ?? target.host, target: { index, source: target.host, name: target.filename }, ...(error.count !== undefined ? { numbers: { count: error.count } } : {}) });
      return { index, count: error.count ?? 0, problem, ...(error.counts ? { counts: error.counts } : {}),
        ...(error.notices?.length ? { notices: error.notices.map(problem => problemFrom({ problem }, { target: { index, source: target.host, name: target.filename } })) } : {}) };
    }
  });
}
