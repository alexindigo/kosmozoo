// Environment-pure failure/evidence contract. Formatting is centralized here;
// transports and catches retain the problem rather than rebuilding its message.
import { MAX_JOBS_PER_IMAGE } from "./limits.mjs";
const name = p => p.target?.name ?? "This image";
const label = p => p.parameter?.label ?? p.parameter?.id ?? "This parameter";
const facts = p => p.numbers ?? {};
const cause = p => p.detail || "the operation did not return usable data";
const value = v => typeof v === "bigint" ? String(v) : typeof v === "string" ? JSON.stringify(v) : String(v);
const field = p => `${name(p)}, ${label(p)}${p.field ? `, ${p.field}` : ""}`;
const formats = {
  "exact-json": () => "This browser cannot preserve exact JSON numbers required by Variations. Your text is kept and numbers will not be rounded.",
  "recipe-internal": p => `Cannot prepare ${name(p)}'s recipe: internal field ${p.path} has incompatible data (${cause(p)}). Your edits remain.`,
  "plan-binding": p => `${name(p)}: Run has an invalid source/plan binding for ${p.parameter ? label(p) : p.field ?? "the request"}: ${cause(p)}. No jobs were admitted by this request.`,
  "plan-scope": p => facts(p).admitted ? `Run will submit ${facts(p).jobs} jobs for ${facts(p).admitted} of ${facts(p).images} images. ${facts(p).blocked} images will remain; see each image's reason below.` : `0 of ${facts(p).images} images can run; 0 jobs.`,
  "value-encoding": p => `${field(p)}: value ${value(p.value)} cannot be preserved as ${p.expected ?? "a valid workflow value"}: ${cause(p)}. Your text is kept.`,
  "numeric-text": p => `${field(p)}: Enter a number for ${p.field}; ${value(p.value)} is not a complete finite number${p.expected === "INT" ? " or exact integer" : ""}. Your text is kept.`,
  "numeric-step": p => `${field(p)}: enter a valid positive Step of at least ${value(facts(p).minimum)}; received ${value(p.value)}. Your text is kept.`,
  "numeric-order": p => `${field(p)}: Minimum exceeds maximum: From ${value(facts(p).from)} exceeds To ${value(facts(p).to)}. Both values are kept for correction.`,
  "value-type": p => `${field(p)}${facts(p).candidate ? `, candidate ${facts(p).candidate}` : ""}: ${p.expected} requires ${p.expected === "INT" ? "an exact integer" : p.expected === "FLOAT" ? "a finite number" : p.expected === "BOOLEAN" ? "true or false" : "text"}; received ${value(p.value)} (${p.actual}). Your text is kept.`,
  "value-choice": p => `${field(p)}: value is not a declared option: ${value(p.value)} is not one of ${facts(p).options} options${p.destination ? ` on ${p.destination}` : ""}.`,
  "value-bound": p => `${field(p)}: value is ${p.side === "min" ? "below the declared minimum" : "above the declared maximum"}: ${value(p.value)} ${p.side === "min" ? "<" : ">"} ${value(facts(p).bound)}. Allowed range: ${value(facts(p).min ?? "unbounded")} to ${value(facts(p).max ?? "unbounded")}.`,
  "resource-reference": p => `${field(p)}: ${value(p.value)} has no valid relative filename (${cause(p)}).`,
  "parameter-missing": p => `${name(p)}: ${label(p)} parameter is missing from this target; no matching workflow input exists.`,
  "transfer-unsupported": p => `${field(p)}: ${p.resource ?? "selected file"} cannot be uploaded; this input ${cause(p)}.`,
  "template-empty": p => `${field(p)}: enter values for every template label; ${p.names.join(", ")} have 0 values, so this sweep produces 0 jobs.`,
  "candidate-connection": p => `${field(p)}${facts(p).candidate ? `, candidate ${facts(p).candidate}` : ""}: choose an existing node and nonnegative output slot; node ${value(p.node)}, slot ${value(p.slot)} is invalid.`,
  "graph-link": p => `${field(p)}: ${cause(p)}. ${p.node !== undefined ? `Node ${p.node}, slot ${p.slot ?? "unknown"}; ` : ""}${facts(p).outputs !== undefined ? `${facts(p).outputs} outputs available (slots 0 to ${facts(p).outputs - 1}).` : p.expected ? `Expected ${p.expected}; received ${p.actual}.` : ""}`,
  "range-integer": p => `${field(p)}: ${p.relative ? "Exact relative integer ranges require integer offsets and bounds" : "Exact integer ranges require integer bounds/increment"}; ${p.field ?? "value"} is ${value(p.value)}.`,
  "range-step": p => `${field(p)}: every enabled range needs a positive increment; Step ${value(p.value)} must be finite and > 0.`,
  "range-bounds": p => `${field(p)}: range bounds must be finite; ${p.field} is ${value(p.value)}.`,
  "range-size": p => `${field(p)}: range is too large: ${value(facts(p).from)} to ${value(facts(p).to)} by ${value(facts(p).step)} contains ${facts(p).count} values, beyond supported exact count ${facts(p).limit}.`,
  "range-clamp": p => `${field(p)}: the destination did not provide clamp bounds for this relative sweep.`,
  "axis-budget": p => `${name(p)}: permutation axis work budget exceeded: ${facts(p).axes} enabled axes exceed the ${facts(p).limit}-axis planning limit; remove at least ${facts(p).axes - facts(p).limit} axes.`,
  "visit-budget": p => `${name(p)}: permutation work budget exceeded: this sweep requires at least ${facts(p).visits} planning visits, above ${facts(p).limit}. Largest axes: ${p.names.join(", ")}.`,
  "relative-clamped": p => `${field(p)}: offsets ${value(facts(p).from)} to ${value(facts(p).to)} from ${value(facts(p).current)} clamp to ${value(facts(p).lo)} to ${value(facts(p).hi)} within ${value(facts(p).min)} to ${value(facts(p).max)}; ${facts(p).jobs} new jobs.`,
  "plan-no-work": p => `${name(p)}: 0 jobs after excluding ${facts(p).excluded} unchanged combinations on ${p.destination}. ${p.names.length ? `${p.names.join(", ")} match the original.` : "No generation parameter differs from the original; Prefix/Suffix alone do not create a variation."}`,
  "plan-pending": p => `Checking ${facts(p).images} images before Run; job count is not available yet. No jobs are being submitted.`,
  "plan-failed": p => `Could not calculate jobs for ${facts(p).images} images: ${cause(p)}. Your setup is kept; Run is unavailable until this check succeeds.`,
  "plan-invalid-reply": p => `The engine returned an invalid job plan for ${facts(p).images} images (${cause(p)}). No jobs were sent by this check.`,
  "plan-input": p => `Cannot prepare the job-count request for ${facts(p).images} images: ${cause(p)}. Your setup is kept.`,
  "estimate-unsafe": p => `The local estimate ${facts(p).count} exceeds exact counting precision; waiting for the engine's per-image validation. Run is unavailable until an exact admitted plan is known.`,
  "images-checking": p => `Checking bytes for ${facts(p).pending} of ${facts(p).selected} images in ${label(p)}, including ${p.resource}. Nothing is queued by this check.`,
  operation: p => `${name(p)}: ${p.phase} failed: ${cause(p)}.`,
  "relative-absent": p => `${name(p)}: ${label(p)} is absent, so its relative sweep is not applied. ${facts(p).jobs} jobs use ${facts(p).applied} of ${facts(p).selected} selected parameters.`,
  "catalogue-install": p => `Cannot use the workflow catalogue for ${name(p)}: ${cause(p)}. Run is unavailable.`,
  "catalogue-destination": p => `The catalogue reply belongs to ${p.actual}, not selected ${p.expected}. Run remains unavailable.`,
  "no-destination": () => "No ComfyUI destination is configured for Run. Your setup is kept.",
  "connection-empty": p => `${label(p)}: no compatible known outputs among ${facts(p).nodes} nodes. This input needs ${p.expected ?? "a compatible output"}.`,
  "large-sweep": p => `This Run will queue ${facts(p).jobs} jobs across ${facts(p).images} images (${facts(p).maximum} maximum for one image; limit ${MAX_JOBS_PER_IMAGE}).`,
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
  "no-work": p => Array.isArray(p.names) ? formats["plan-no-work"](p) : `${name(p)}: ${cause(p).replace(/[.!]+$/, "")}.`,
  "too-many": p => `${name(p)}: ${facts(p).count} jobs for this image; the limit is ${MAX_JOBS_PER_IMAGE} per image. Reduce the axes or increase the increment.`,
};
const actions = {
  "exact-json": "Update Chrome, Firefox or Safari before continuing.",
  "recipe-internal": "Reopen or update the client, or report this field; do not guess an internal binding fix.",
  "plan-binding": "Recheck the workflow and start a new Run; do not guess or replay this request.",
  "plan-scope": "Fix the reasons shown on each image or change the selection/destination.",
  "value-encoding": "Correct this candidate without rounding, or repair the recorded value.",
  "numeric-text": "Enter a finite number (a whole exact integer for INT); your text will not be rounded.",
  "numeric-step": "Enter a positive increment at or above the minimum.",
  "numeric-order": "Set From <= To.",
  "value-type": "Correct this candidate without rounding; your text is kept.",
  "value-choice": "Choose an available option in this field, or choose another destination.",
  "value-bound": "Enter a value within the declared bounds.",
  "resource-reference": "Choose a valid image reference from the source/feed or upload a supported file.",
  "parameter-missing": "Remove this parameter for the selection, remove the image, or choose compatible targets.",
  "transfer-unsupported": "Choose a declared existing value or an input that accepts file uploads.",
  "template-empty": "Enter at least 1 semicolon-separated value for each missing label.",
  "candidate-connection": "Choose an existing node and a whole output slot >= 0.",
  "graph-link": "Choose an existing compatible node/output or repair the recorded workflow; no jobs for this invalid plan were submitted.",
  "range-integer": "Enter whole offsets, bounds and Step without rounding.",
  "range-step": "Enter a finite positive Step.", "range-bounds": "Enter finite From and To bounds.",
  "range-size": "Narrow the range or increase Step.",
  "range-clamp": "Choose a fixed Value, another compatible parameter, or a destination with that declaration.",
  "axis-budget": "Remove enabled axes before Run.", "visit-budget": "Increase Step or reduce the largest axes.",
  "relative-clamped": "Change the offsets or another parameter to create different jobs.",
  "plan-no-work": "Choose another generation value, image or destination.",
  "plan-pending": "Wait for the check to finish.", "plan-failed": "Retry the check.",
  "plan-invalid-reply": "Retry; if repeated, reload or update the client and engine together.",
  "plan-input": "Correct the named field, or reopen/update the client if the internal data is incompatible.",
  "estimate-unsafe": "Wait for the engine's exact plan.", "images-checking": "Wait for comparison to finish.",
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
const data = value => typeof value === "bigint" || typeof value === "number" && !Number.isFinite(value) ? String(value)
  : Array.isArray(value) ? value.map(item => data(item) ?? null)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, data(item)])) : value;
export function variationProblem(code, context = {}) {
  if (!Object.hasOwn(formats, code)) throw new Error(`Unknown variation problem code: ${code}`);
  const problem = { ...data(context), code, severity: context.severity ?? "error", phase: context.phase ?? "preflight" };
  problem.action = actions[code]; problem.message = formats[code](problem);
  return Object.freeze(problem);
}
export const problemText = problem => [problem?.message, problem?.action].filter(Boolean).join(" ");
export function problemFrom(error, context = {}) {
  const retained = error?.problem ?? (error?.code && error?.message && error?.action ? error : null);
  return retained ? variationProblem(retained.code, { ...context, ...retained,
    ...(context.numbers || retained.numbers ? { numbers: { ...context.numbers, ...retained.numbers } } : {}),
    ...(context.parameter || retained.parameter ? { parameter: { ...context.parameter, ...retained.parameter } } : {}) }) : variationProblem(Object.hasOwn(formats, error?.code) ? error.code : context.code ?? "operation", { ...context,
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
