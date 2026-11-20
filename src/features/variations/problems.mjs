// Environment-pure failure/evidence contract. Formatting is centralized here;
// transports and catches retain the problem rather than rebuilding its message.
const name = p => p.target?.name ?? "This image";
const label = p => p.parameter?.label ?? p.parameter?.id ?? "This parameter";
const facts = p => p.numbers ?? {};
const cause = p => p.detail || "the operation did not return usable data";
const formats = {
  operation: p => `${name(p)}: ${p.phase} failed: ${cause(p)}.`,
  "relative-absent": p => `${name(p)}: ${label(p)} is absent, so its relative sweep is not applied. ${facts(p).jobs} jobs use ${facts(p).applied} of ${facts(p).selected} selected parameters.`,
  "catalogue-install": p => `Cannot use the workflow catalogue for ${name(p)}: ${cause(p)}. Run is unavailable.`,
  "catalogue-destination": p => `The catalogue reply belongs to ${p.actual}, not selected ${p.expected}. Run remains unavailable.`,
  "no-destination": () => "No ComfyUI destination is configured for Run. Your setup is kept.",
  "connection-empty": p => `${label(p)}: no compatible known outputs among ${facts(p).nodes} nodes. This input needs ${p.expected ?? "a compatible output"}.`,
  "large-sweep": p => `This Run will queue ${facts(p).jobs} jobs across ${facts(p).images} images (${facts(p).maximum} maximum for one image; limit 500).`,
  "deduplicated": p => `${label(p)}: ${facts(p).selected} selections represent ${facts(p).distinct} distinct values/images; ${facts(p).duplicates} duplicates are counted once.`,
  "name-shortened": p => `${name(p)}: source-name/token text was shortened from ${facts(p).before} to ${facts(p).after} UTF-8 bytes to fit the ${facts(p).limit}-byte output-name budget; Prefix/Suffix remain intact.`,
  naming: p => `${name(p)}: Run unavailable: ${cause(p)}. Job count is not permission to run with an invalid output name.`,
  busy: p => `Run was not started: ${p.detail ?? "submission or confirmation"} is still in progress.`,
  "session-changed": () => "This Variations session changed; the requested action was not applied. Your current editor was kept.",
  "progress-unavailable": p => `Submission continues, but progress could not be read: ${cause(p)}. Last known progress ${facts(p).sent ?? "--"} / ${facts(p).total ?? "--"}.`,
  "history-refresh": p => `Run completed, but the history list could not refresh: ${cause(p)}. Your queued jobs are unchanged.`,
  "history-cleanup": p => `Cleanup for saved Run ${p.runId ?? "unknown"} is still pending: ${cause(p)}. Resources remain retained; jobs are unaffected.`,
  "recall-changed": p => `Saved Run ${p.runId} was not applied because the editor changed while it was loading. Your current edits are unchanged.`,
  "restore-failed": p => `Could not open saved Run ${p.runId}: ${cause(p)}. Saved values were not applied.`,
  "time-unavailable": p => `Time estimate unavailable for ${facts(p).missing} of ${facts(p).total} images (${p.names?.join(", ") || name(p)}): ${cause(p)}. Job count is unaffected.`,
  "folder-skipped": p => `Imported ${facts(p).images} images from ${p.path}; skipped ${facts(p).links} symbolic links and ${facts(p).other} unsupported/nonregular entries.`,
  "chooser-unavailable": p => `The engine's folder chooser is unavailable: ${cause(p)}.`,
  "listing-filtered": p => `Showing ${facts(p).visible} of ${facts(p).listed} ${p.root === "output" ? "generated" : "imported"} images from ${p.source}; ${facts(p).hidden} hidden by visibility preferences and ${facts(p).invalid} invalid paths omitted.`,
  "no-listing-source": () => "No configured ComfyUI source offers image listing.",
  "acquisition-retired": p => `${p.resource ?? "Image"} was not added to ${label(p)} because ${p.source ?? "the source/editor membership"} changed while loading. Your current set is unchanged.`,
  "preview-unavailable": p => `Preview unavailable for ${p.resource ?? name(p)}: no image address is available.`,
  "drop-unreadable": p => `Could not read ${facts(p).unreadable} dropped file items from the browser. No files were added for those items.`,
  "drop-skipped": p => `${label(p)}: added ${facts(p).added} images; skipped ${facts(p).skipped} unsupported files (${p.names?.join(", ") || "none"}); ${facts(p).folders} folders were not imported.`,
  "images-merged": p => `${label(p)}: added ${facts(p).added} of ${facts(p).listed} images; ${facts(p).duplicates} were already in the set. Nothing was replaced.`,
  "pexels-unavailable": p => `Could not load Pexels services: ${cause(p)}. Your image set is unchanged; existing service data may be stale.`,
  "no-pexels": () => "No Pexels services configured.",
  "photos-skipped": p => `${p.source}, page ${facts(p).page}: showing ${facts(p).shown} of ${facts(p).received} photos; skipped ${facts(p).invalid} invalid records and ${facts(p).duplicates} duplicate IDs.`,
  "edit-failed": p => `Could not apply your edit to ${label(p)}: ${cause(p)}. Current values are kept.`,
  "opening-unavailable": p => facts(p).selected === 0 ? "Select at least 1 image." : `Could not open Variations: ${facts(p).missing} of ${facts(p).selected} selected images are unavailable (${p.names?.join(", ")}).`,
  "last-target": p => `${name(p)} is the last remaining target. This editor requires at least 1 target.`,
  "schema-incomplete": p => `${name(p)}, ${label(p)}: declarations are incomplete (${cause(p)}). These inputs cannot be fully prechecked.`,
  "template-budget": p => `${label(p)}: labels ${p.names?.join(", ")} expand to ${facts(p).requested} text candidates, beyond the existing ${facts(p).limit}-visit planning limit.`,
  "run-retired": p => `Saved Run ${p.runId} continued or ended after the editor closed. Its effects are retained in history.`,
  "invalid-plan": p => `${name(p)}: ${cause(p).replace(/[.!]+$/, "")}.`,
  "work-budget": p => `${name(p)}: ${cause(p).replace(/[.!]+$/, "")}.`,
  "missing-class": p => `${name(p)}: ${cause(p).replace(/[.!]+$/, "")}.`,
  "no-work": p => `${name(p)}: ${cause(p).replace(/[.!]+$/, "")}.`,
  "too-many": p => `${name(p)}: ${facts(p).count} jobs for this image; the limit is 500 per image. Reduce the axes or increase the increment.`,
};
const actions = {
  operation: "Keep your setup, inspect the cause, and retry the failed operation, not an uncertain submission.",
  "relative-absent": "Remove this image or choose a shared parameter if all images must receive that edit.",
  "catalogue-install": "Retry; if repeated, update or report the incompatible catalogue.",
  "catalogue-destination": "Retry the destination check.",
  "no-destination": "Add or reconnect a ComfyUI source, then choose it in Run on.",
  "connection-empty": "Choose a compatible node, or inspect an unknown-port node using an explicit slot.",
  "large-sweep": "Check the count before running.",
  deduplicated: "Inspect the distinct values and unchanged exclusions in the count breakdown.",
  "name-shortened": "Inspect Example or use a shorter name.",
  naming: "Correct Prefix, Suffix or the selected output-name parameter.",
  busy: "Finish the current action first.", "session-changed": "Select the intended action again in the current editor.",
  "progress-unavailable": "Do not start another Run; wait for the final result or inspect history.",
  "history-refresh": "Retry loading history; do not resubmit.", "history-cleanup": "Retry retained-resource cleanup from history.",
  "recall-changed": "Choose the saved Run again when ready.", "restore-failed": "Refresh history or choose another compatible Run.",
  "time-unavailable": "Retry metadata or continue without a time estimate.",
  "folder-skipped": "Use real supported files if you intended to include them.",
  "chooser-unavailable": "Enter an absolute engine-computer path manually, or retry checking chooser availability.",
  "listing-filtered": "Adjust visibility preferences or choose another feed/source.",
  "no-listing-source": "Add or reconnect a listing-capable source, or use Add files or Add folder.",
  "acquisition-retired": "Select it again from the current source if still wanted.",
  "preview-unavailable": "Reopen or re-add the image, or inspect its saved archive.",
  "drop-unreadable": "Use Add files to select them again.", "drop-skipped": "Use supported images; use Add folder for an engine-computer folder.",
  "images-merged": "Inspect the set or choose different images.",
  "pexels-unavailable": "Retry loading services or open Pexels settings.",
  "no-pexels": "Add one in Settings to browse photos, or use ComfyUI images, files or folders.",
  "photos-skipped": "Refresh or inspect service data if expected photos are missing.",
  "edit-failed": "Reselect the field; reopen or report it if repeated.",
  "opening-unavailable": "Refresh or reselect the images and try again.",
  "last-target": "Close or replace the selection to remove it.",
  "schema-incomplete": "Repair or update that node, or inspect backend validation before Run.",
  "template-budget": "Reduce label values or axes before Run.",
  "run-retired": "Inspect saved effects and the backend queue before retrying.",
  "invalid-plan": "Correct the named input or choose a compatible image or destination.",
  "work-budget": "Reduce label values or axes, or increase Step before Run.",
  "missing-class": "Install the required nodes there or choose a compatible destination.",
  "no-work": "Choose another generation value, image or destination; naming alone does not create a variation.",
  "too-many": "Check each selected parameter before running again.",
};
export function variationProblem(code, context = {}) {
  if (!Object.hasOwn(formats, code)) throw new Error(`Unknown variation problem code: ${code}`);
  const problem = { code, severity: "error", phase: "preflight", ...context };
  problem.action = actions[code]; problem.message = formats[code](problem);
  return Object.freeze(problem);
}
export const problemText = problem => [problem?.message, problem?.action].filter(Boolean).join(" ");
export function problemFrom(error, context = {}) {
  const retained = error?.problem ?? (error?.code && error?.message && error?.action ? error : null);
  return retained ? variationProblem(retained.code, { ...context, ...retained }) : variationProblem(Object.hasOwn(formats, error?.code) ? error.code : "operation", { ...context,
    detail: error?.detail ?? error?.message ?? error?.error ?? String(error ?? "Unknown failure") });
}
export const problemError = problem => Object.assign(new Error(problem.message), { problem, code: problem.code });

// Durable per-permutation evidence, not target outcomes or optimistic counts.
export function effectCounts(jobs, total = null) {
  const confirmed = jobs.filter(job => job.state === "confirmed").length;
  const partial = jobs.filter(job => job.state === "partial").length;
  const unknown = jobs.filter(job => ["started", "uncertain", "unknown"].includes(job.state)).length;
  const sent = jobs.filter(job => job.sent === true || job.result?.sent === true).length;
  return { sent, confirmed, partial, unknown, unsent: Number.isSafeInteger(total) ? Math.max(0, total - jobs.filter(job => job.sent === true || job.result?.sent === true || ["confirmed", "partial", "uncertain", "started"].includes(job.state)).length) : null };
}
export const effectMessage = effects => `${effects.confirmed ?? "--"} confirmed, ${effects.partial ?? "--"} partial, ${effects.unknown ?? "--"} unknown, ${effects.unsent ?? "--"} unsent; ${effects.sent ?? "--"} sent.`;
