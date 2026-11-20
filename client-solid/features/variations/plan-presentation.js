// Readonly workload and admission are distinct: rejected work still has a size.
// The summary and target tiles consume the same engine-owned problems.
export function planPresentation(plan, targets, { pending = false, error = "" } = {}) {
  const checking = pending || !plan && !error;
  const problems = plan?.filter(target => target.problem) ?? [];
  const admitted = plan?.filter(target => !target.problem && target.count > 0) ?? [];
  const n = checking || error ? null : plan.reduce((sum, target) => sum + target.count, 0);
  const overCount = problems.filter(target => target.problem.code === "too-many").length;
  const overLimit = overCount > 0;
  const problemMessage = problems.map(target => `${targets.length > 1 ? `${targets[target.index].filename}: ` : ""}${target.problem.message}`).join("\n");
  const message = error || (checking ? "Checking every image..." : problemMessage);
  return { n, overLimit, problemMessage, message, admitted,
    problems: new Map(problems.map(target => [targets[target.index].id, target.problem])),
    status: error ? "failed" : checking ? "checking" : problems.length && !admitted.length ? "blocked" : "ready",
    display: n === null ? "--" : n.toLocaleString("en-US"),
    fullCount: n === null ? message : `${n} variations${overLimit ? "; over the per-image limit" : ""}`,
    breakdown: n === null ? "" : overLimit ? `${n} jobs; over the limit for ${overCount} image${overCount === 1 ? "" : "s"}`
      : `${n} jobs for ${admitted.length} of ${targets.length} image${targets.length === 1 ? "" : "s"}`,
  };
}
