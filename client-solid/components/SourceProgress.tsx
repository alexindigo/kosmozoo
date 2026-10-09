// One native sector, with independent static base/circumference. Operation
// progress is not a promise about the rest of the workflow.
import { Show } from "solid-js";

export function SourceProgress(props) {
  const status = () => props.activity?.supported === false ? "idle" :
    ["reconnecting", "suspended"].includes(props.delivery) ? "disconnected" : props.activity?.state ?? "unknown";
  const progress = () => status() === "running" ? props.activity?.progress : null;
  const label = () => {
    const p = progress();
    if (props.activity?.supported === false) return `${props.name}: ${props.activity.reason}`;
    if (["reconnecting", "suspended"].includes(props.delivery)) return `${props.name}: activity delivery disconnected; cached upstream ${props.activity?.state ?? "unknown"}`;
    return `${props.name}: ${p ? `current operation ${p.value}/${p.max}` :
      status() === "running" ? "running; operation progress unavailable" : status()}`;
  };
  const sector = () => {
    const fraction = Math.min(1, Math.max(0, progress()?.fraction ?? 0));
    const angle = fraction * Math.PI * 2;
    return `M12 12 L12 3 A9 9 0 ${fraction > .5 ? 1 : 0} 1 ${12 + 9 * Math.sin(angle)} ${12 - 9 * Math.cos(angle)} Z`;
  };
  return (
    <svg class={"source-progress " + status() + (status() === "running" && !progress() ? " indeterminate" : "")}
      viewBox="0 0 24 24" width="18" height="18" role="img" aria-label={label()} data-state={status()}
      data-fraction={progress()?.fraction ?? ""}>
      <title>{label()}</title>
      <circle class="source-progress-base" cx="12" cy="12" r="9" />
      <Show when={progress() && progress().fraction > 0}>
        <Show when={progress().fraction >= 1} fallback={<path class="source-progress-fill" d={sector()} />}>
          <circle class="source-progress-fill" cx="12" cy="12" r="9" />
        </Show>
      </Show>
      <circle class="source-progress-outline" cx="12" cy="12" r="9" />
      <Show when={status() === "unknown" || status() === "disconnected"}>
        <path class="source-progress-mark" d={status() === "disconnected" ? "M12 7v6 M12 16v1" : "M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 16v1"} />
      </Show>
    </svg>
  );
}
