// Readonly presentation only: every sidebar status shares one bounded slot.
export function runStatus({ preview, result, unavailable }) {
  const items = [];
  if (unavailable) items.push({ text: unavailable, class: "vz-readiness-error" });
  if (!result || preview.problemMessage) {
    if (preview.message) items.push({ text: preview.message,
      class: preview.problemMessage || ["invalid", "conflict", "failed", "blocked"].includes(preview.status) ? "vz-readiness-error" : "vz-field-help" });
    if (!result && preview.uncheckedMessage) items.push({ text: preview.uncheckedMessage, class: "vz-field-help" });
  }
  if (result) {
    if (Number.isSafeInteger(result.submitted) && result.total > 0) items.push({
      text: `Queued ${result.submitted} of ${result.total} jobs`, class: result.ok ? "vz-queued vz-ok" : "vz-queued" });
    items.push({ text: result.reason ?? result.text ?? "", class: result.ok ? "vz-error vz-neutral" : "vz-error" });
  }
  return { items, retry: preview.status === "failed", fullText: items.map(item => item.text).filter(Boolean).join("\n") };
}
