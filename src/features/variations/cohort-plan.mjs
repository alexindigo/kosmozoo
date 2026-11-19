// Effect-free, engine-owned admission. Every target supplies its own inspected
// catalogue and resource identities. No result here is a graph/upload receipt.
import { parameterCurrent, parameterContract } from "../../parameters.mjs";
import { snapshotDraft, numericText, imageIdentity } from "./recipe-model.mjs";
import { compileRecipe } from "./recipe-compile.mjs";
import { targetRunPlan, parameterIndex, catalogueParams, parameterLabel, permutationPlan,
  generatePermutations, resolveRelativeRanges, reproducesOriginal } from "./shared.mjs";

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

// Materialization reuses a local reference first, then a confirmed same-byte
// graph resource, then transfers bytes once. Model that identity, not a guessed
// collision filename. Receipt-backed compilation never consumes these objects.
export function countingTarget(target, recipe, resources, destination, index) {
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const graphResources = Object.values(target.graphResources ?? {}).map(id => byId.get(id)).filter(Boolean);
  const identity = resource => {
    if (!resource) throw new Error("Image resource identity unavailable");
    const local = resource.host === (destination?.source ?? target.host) && resource.root;
    if (local) return resource.value ?? `${resource.name} [${resource.root}]`;
    const twin = graphResources.find(other => other.hash && other.hash === resource.hash && other.root && other.host === (destination?.source ?? target.host));
    return twin ? twin.value ?? `${twin.name} [${twin.root}]` : { resource: resource.hash ?? resource.id };
  };
  const resourceIdentities = new Map();
  for (const entry of Object.values(recipe.images)) if (entry.values.enabled) for (const item of entry.values.items) {
    resourceIdentities.set(imageIdentity(item), identity(byId.get(item.kind === "target" ? `target-${index}` : item.resourceId)));
  }
  const currentIdentities = Object.fromEntries(Object.entries(target.graphResources ?? {}).map(([id, rid]) => [id, identity(byId.get(rid))]));
  return { ...target, resourceIdentities, currentIdentities };
}

// Shared by admission and receipt-backed preparation. Traversal is checked with
// the actual kernel, after the cap, so count and generation cannot diverge.
export function planTarget({ target, cohortMode, recipe, destination, resourceValues, resourceIdentities }) {
  const catalogue = target.catalogue, bound = bindCohortRecipe(recipe, catalogue);
  for (const entry of Object.values(bound.numeric)) if (entry.values.enabled && entry.values.mode === "range") {
    const step = numericText(entry.values.rawIncrement);
    if (step === null || step < entry.metadata.minIncrement) throw new Error("Enter a valid positive increment; incomplete text has been kept.");
  }
  const compiled = compileRecipe(bound, { catalogue, target, batch: cohortMode === "bulk", resourceValues, resourceIdentities, preview: !!resourceIdentities });
  const plan = targetRunPlan(resourceIdentities ? compiled.estimate : compiled.payload, catalogue);
  const values = Object.fromEntries([...parameterIndex(catalogue.parameters ?? catalogueParams(catalogue)).values()].map(p => [p.id, parameterCurrent(p)]));
  // Current graph resources have identities too, but only in the counting model.
  Object.assign(values, target.currentIdentities ?? {});
  const ranges = plan.payload.relative ? resolveRelativeRanges(plan.payload.ranges, values) : plan.payload.ranges;
  if (Object.keys(plan.payload.ranges).some(id => plan.payload.ranges[id].enabled && !Object.hasOwn(ranges, id))) throw new Error("Every applicable relative range needs clamp bounds");
  const options = { sameHost: reproducesOriginal(target.host, destination?.source) };
  const count = permutationPlan(ranges, values, plan.payload.imageParams, options).total;
  if (!Number.isSafeInteger(count) || count > 500) throw Object.assign(new Error(`Too many permutations (${count} > 500); reduce the axes or increase the increment.`), { code: "too-many" });
  if (count <= 0) throw Object.assign(new Error("No work for this image; choose a different value, image or destination."), { code: "no-work" });
  generatePermutations(ranges, values, plan.payload.imageParams, options);
  return { count, plan, compiled };
}

export function planCohort({ targets, cohortMode, recipe, destination }) {
  return targets.map((target, index) => {
    try {
      if (target.problem) throw Object.assign(new Error(target.problem.message), { code: target.problem.code });
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
      const { count } = planTarget({ target, cohortMode, recipe, destination, resourceIdentities: target.resourceIdentities });
      return { index, count, problem: null };
    } catch (error) { return { index, count: 0, problem: { code: error.code ?? (/work budget/.test(error.message) ? "work-budget" : "invalid-plan"), message: error.message } }; }
  });
}
