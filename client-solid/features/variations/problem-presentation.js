// One readonly projection for summaries, targets, parameters and saved evidence.
// Producers retain scoped problems; views render these records, not catch strings.
import { problemFrom, problemText, effectMessage, variationProblem } from "/shared/features/variations/problems.mjs";
export function problemPresentation(problems = []) {
  const targets = new Map(), fields = new Map(), unique = new Map();
  for (const value of problems.filter(Boolean)) {
    const problem = value.action ? value : problemFrom(value);
    const key = JSON.stringify([problem.code, problem.target, problem.parameter, problem.message]);
    if (unique.has(key)) continue;
    unique.set(key, problem);
    for (const [map, id] of [[targets, problem.target?.index ?? problem.target?.id], [fields, problem.parameter?.id]]) {
      if (id === undefined) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(problem);
    }
  }
  const ordered = [...unique.values()].sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
  return { problems: ordered, targets, fields, text: ordered.map(problemText).join("\n"), blocking: ordered.some(p => p.severity === "error") };
}
export function makeProblemOwner(changed = () => {}) {
  const problems = new Map();
  return {
    report(key, problem) { problems.set(key, problem); changed(); return problem; },
    clear(key) { if (problems.delete(key)) changed(); },
    clearPrefix(prefix) {
      let removed = false;
      for (const key of problems.keys()) if (key.startsWith(prefix)) { problems.delete(key); removed = true; }
      if (removed) changed();
    },
    read: () => [...problems.values()],
    project: (extra = []) => problemPresentation([...problems.values(), ...extra]),
  };
}
export function historyPresentation(entry) {
  const summary = entry.summary ?? {}, effects = summary.effects;
  const issues = [...(summary.problems ?? []), ...(summary.leftovers ?? []).map(leftover => leftover.problem)];
  if (summary.error && !issues.some(problem => problem.message?.includes(summary.error))) issues.push(problemFrom(new Error(summary.error), { phase: "saved Run" }));
  return { counts: effects ? effectMessage(effects) : "Confirmed effect counts unavailable for this saved Run.",
    state: `Archive: ${entry.captureState ?? "unknown"}; Run: ${entry.outcome ?? "unknown"}; ${(summary.leftovers ?? []).length} images left.`,
    details: (entry.effects ?? []).map(effect => ({ id: effect.id, caption: `${effect.kind} ${effect.id}: ${effect.state}${effect.result?.name ? ` (${effect.result.name})` : ""}`,
      problems: effect.result?.error || Object.keys(effect.result?.nodeErrors ?? {}).length ? [problemFrom(new Error(effect.result.error ?? JSON.stringify(effect.result.nodeErrors)), { phase: effect.kind,
        target: { name: summary.targets?.[Number(/^job-(\d+)-/.exec(effect.id)?.[1])] ?? effect.id } })] : [] })),
    ...problemPresentation(issues) };
}
export const acquisitionProblems = ({ sources = [], pexels, chooserError } = {}) => [
  ...(!sources.length ? [variationProblem("no-listing-source", { severity: "warning", phase: "acquisition" })] : []),
  ...(pexels?.error ? [variationProblem("pexels-unavailable", { severity: "warning", phase: "acquisition", detail: pexels.error })]
    : pexels?.loaded && !pexels.services.length ? [variationProblem("no-pexels", { severity: "warning", phase: "acquisition" })] : []),
  ...(chooserError ? [variationProblem("chooser-unavailable", { severity: "warning", phase: "acquisition", detail: chooserError.message ?? String(chooserError) })] : []),
];
