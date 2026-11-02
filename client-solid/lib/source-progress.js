// One presentation of the accepted source snapshot for the chip and instrument.
// Counts remain queue-owned; delivery/state gates also hide cached progress.
export function sourceProgress(name, activity, delivery) {
  const disconnected = ["connecting", "reconnecting", "suspended"].includes(delivery);
  const status = activity?.supported === false ? "idle" : disconnected ? "disconnected" : activity?.state ?? "unknown";
  const progress = status === "running" ? activity?.progress : null;
  const workflow = status === "running" ? activity?.workflow : null;
  const countsKnown = activity?.supported === true && ["idle", "running"].includes(status);
  const count = countsKnown ? activity.runningCount + activity.queuedCount : 0;
  const queue = count > 0 ? {
    text: count > 999 ? "999+" : String(count),
    label: `${count} in queue (${activity.runningCount} running, ${activity.queuedCount} waiting)`,
  } : null;
  let detail;
  if (activity?.supported === false) detail = activity.reason;
  else if (disconnected) detail = `activity delivery disconnected; cached upstream ${activity?.state ?? "unknown"}`;
  else if (status !== "running") detail = status;
  else {
    const whole = workflow ? `workflow about ${Math.floor(workflow.done)} of ${workflow.total} steps` :
      "running · workflow progress unavailable" + (activity?.workflowReason === "other-client" ? " (queued from another ComfyUI tab)" : "");
    const step = progress ? `current step ${progress.value}/${progress.max}` +
      (activity?.progressBasis === "exact" ? " (live)" : activity?.progressBasis === "log" ? " (from log)" : "") :
      "current step progress unavailable";
    detail = `${whole} · ${step}`;
  }
  return { status, progress, workflow, queue, label: `${name}: ${detail}${queue ? ` · ${queue.label}` : ""}` };
}
