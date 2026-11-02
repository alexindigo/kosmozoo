// One concentric instrument: current-step sector inside, derived workflow arc
// outside. Both consume the same engine-owned activity projection.
import { Show } from "solid-js";

export function SourceProgress(props) {
  const status = () => props.presentation.status;
  const progress = () => props.presentation.progress;
  const workflow = () => props.presentation.workflow;
  const label = () => props.presentation.label;
  const sector = () => {
    const fraction = Math.min(1, Math.max(0, progress()?.fraction ?? 0));
    const angle = fraction * Math.PI * 2;
    return `M16 16 L16 7 A9 9 0 ${fraction > .5 ? 1 : 0} 1 ${16 + 9 * Math.sin(angle)} ${16 - 9 * Math.cos(angle)} Z`;
  };
  return (
    <>
    <Show when={props.presentation.queue}>
      <span class="source-queue-count" aria-hidden="true"><span>{props.presentation.queue?.text}</span></span>
    </Show>
    <svg class={"source-progress " + status() + (status() === "running" && !progress() ? " indeterminate" : "")}
      viewBox="0 0 32 32" width="24" height="24" role="img" aria-label={label()} data-state={status()}
      data-fraction={progress()?.fraction ?? ""} data-workflow-fraction={workflow()?.fraction ?? ""}>
      <title>{label()}</title>
      <Show when={status() === "running"}>
        <circle class="source-progress-track" cx="16" cy="16" r="14" />
        <circle class={"source-progress-workflow" + (workflow() ? "" : " unavailable")}
          cx="16" cy="16" r="14" pathLength="1" transform="rotate(-90 16 16)"
          stroke-dasharray={`${workflow()?.fraction ?? .5} 1`} />
      </Show>
      <circle class="source-progress-base" cx="16" cy="16" r="9" />
      <Show when={progress() && progress().fraction > 0}>
        <Show when={progress().fraction >= 1} fallback={<path class="source-progress-fill" d={sector()} />}>
          <circle class="source-progress-fill" cx="16" cy="16" r="9" />
        </Show>
      </Show>
      <circle class="source-progress-outline" cx="16" cy="16" r="9" />
      <Show when={status() === "unknown" || status() === "disconnected"}>
        <path class="source-progress-mark" d={status() === "disconnected" ? "M16 11v6 M16 20v1" : "M13 13a3 3 0 0 1 6 0c0 2-3 2-3 4 M16 20v1"} />
      </Show>
    </svg>
    </>
  );
}
