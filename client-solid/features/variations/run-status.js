// Readonly presentation only: every sidebar status shares one bounded slot.
import { problemPresentation, problemTier, byPrecedence } from "./problem-presentation.js";
import { problemText, effectMessage } from "/shared/features/variations/problems.mjs";
const previewTier = preview => ["invalid", "conflict", "failed"].includes(preview.status) ? "blocking"
  : preview.problemMessage || preview.status === "blocked" ? [...(preview.problems?.values() ?? [])].some(problem => problemTier(problem) === "blocking") ? "blocking" : "explanation"
  : ["checking", "reading"].includes(preview.status) ? "progress" : preview.n === 0 ? "explanation" : "ready";
const tone = tier => ["blocking", "explanation"].includes(tier) ? "vz-readiness-error" : "vz-field-help";
export function runStatus({ preview, result, unavailable, problems = [] }) {
  const current = [];
  if (unavailable) current.push({ text: unavailable, tier: "blocking" });
  const active = preview.problemMessage || ["invalid", "conflict", "failed", "blocked", "checking", "reading"].includes(preview.status);
  if (!result || active) {
    if (preview.message) current.push({ text: preview.message, tier: previewTier(preview) });
    if (!result && preview.uncheckedMessage) current.push({ text: preview.uncheckedMessage, tier: "warning" });
  }
  for (const problem of problemPresentation(problems).problems) current.push({ text: problemText(problem), tier: problemTier(problem) });
  const items = byPrecedence(current, item => item.tier).map(({ text, tier }) => ({ text, class: tone(tier) }));
  if (result) {
    if (result.effectCounts) items.push({ text: effectMessage(result.effectCounts), class: result.ok ? "vz-queued vz-ok" : "vz-queued" });
    else if (Number.isSafeInteger(result.submitted) && result.total > 0) items.push({
      text: result.adopted || result.ok ? `Queued ${result.submitted} of ${result.total} jobs` : `${result.submitted} reported of ${result.total} jobs; complete acceptance is not confirmed.`, class: result.ok ? "vz-queued vz-ok" : "vz-queued" });
    items.push({ text: `${active ? "Previous Run: " : ""}${result.reason ?? result.text ?? ""}`, class: result.ok ? "vz-error vz-neutral" : "vz-error" });
  }
  return { items, retry: preview.status === "failed", fullText: items.map(item => item.text).filter(Boolean).join("\n") };
}
