// Readonly presentation only: every sidebar status shares one bounded slot.
import { problemPresentation } from "./problem-presentation.js";
import { problemText, effectMessage } from "/shared/features/variations/problems.mjs";
export function runStatus({ preview, result, unavailable, problems = [] }) {
  const items = [];
  if (unavailable) items.push({ text: unavailable, class: "vz-readiness-error" });
  const current = preview.problemMessage || ["invalid", "conflict", "failed", "blocked", "checking", "reading"].includes(preview.status);
  if (!result || current) {
    if (preview.message) items.push({ text: preview.message,
      class: preview.problemMessage || ["invalid", "conflict", "failed", "blocked"].includes(preview.status) ? "vz-readiness-error" : "vz-field-help" });
    if (!result && preview.uncheckedMessage) items.push({ text: preview.uncheckedMessage, class: "vz-field-help" });
  }
  for (const problem of problemPresentation(problems).problems) items.push({ text: problemText(problem), class: problem.severity === "error" ? "vz-readiness-error" : "vz-field-help" });
  if (result) {
    if (result.effectCounts) items.push({ text: effectMessage(result.effectCounts), class: result.ok ? "vz-queued vz-ok" : "vz-queued" });
    else if (Number.isSafeInteger(result.submitted) && result.total > 0) items.push({
      text: result.adopted || result.ok ? `Queued ${result.submitted} of ${result.total} jobs` : `${result.submitted} reported of ${result.total} jobs; complete acceptance is not confirmed.`, class: result.ok ? "vz-queued vz-ok" : "vz-queued" });
    items.push({ text: `${current ? "Previous Run: " : ""}${result.reason ?? result.text ?? ""}`, class: result.ok ? "vz-error vz-neutral" : "vz-error" });
  }
  return { items, retry: preview.status === "failed", fullText: items.map(item => item.text).filter(Boolean).join("\n") };
}
