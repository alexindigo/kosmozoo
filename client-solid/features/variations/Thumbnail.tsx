import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { useImageDisplay, imageRequestUrl } from "../../lib/img-measure.js";
import { focusMemory } from "./draft.js";
import { SingleLineText } from "../../components/SingleLineText.js";

// One thumbnail presentation/native lifetime for both contact sheets. The
// optional surface slot lets a consumer wrap the picture in its own action;
// Retry remains a sibling action, never a button nested in a selection button.
export function Thumbnail(props) {
  const [attempt, setAttempt] = createSignal(0);
  const [phase, setPhase] = createSignal("pending");
  const resource = createMemo(() => props.src ? { src: props.src, local: !!props.local, attempt: attempt() } : null);
  createEffect(() => { resource(); setPhase("pending"); });
  return <div class={`vz-thumbnail ${props.class ?? ""}`}>
    <Show when={resource()} keyed fallback={<span class="vz-thumbnail-pending">Loading preview…</span>}>
      {resource => <ThumbnailAttempt src={resource.local ? resource.src : imageRequestUrl(resource.src, "foreground", resource.attempt || null)}
        local={resource.local} priority={props.priority} order={props.order} lazy={props.lazy} register={props.register}
        surface={props.surface} phase={phase} onPhase={setPhase} />}
    </Show>
    {/* Keep the clicked action connected through document outside-click
        routing; only the native attempt is replaced on Retry. */}
    <Show when={props.pending}><span class="vz-thumbnail-pending vz-thumbnail-acquiring" role="status">Loading image…</span></Show>
    <div class="vz-thumbnail-failure" hidden={!props.error && (phase() !== "failed" || props.pending)}>
      <div class="vz-thumbnail-failed"><SingleLineText role="status" value={props.error ? `Couldn't load ${props.name}.` : "Preview failed"} hint={props.error} /></div>
      <button type="button" class="vz-thumbnail-retry" aria-label={`Retry ${props.error ? "image" : "preview"} for ${props.name}`}
        title={`Retry ${props.error ? "image" : "preview"} for ${props.name}`} {...focusMemory(props.rememberFocus)}
        onClick={() => props.error ? props.onRetry() : setAttempt(n => n + 1)}>Retry</button>
    </div>
  </div>;
}

function ThumbnailAttempt(props) {
  let image;
  const display = useImageDisplay(props.register, () => ({ id: props.local ? null : props.src, src: props.src, priority: props.priority, order: props.order }),
    () => image, { lazy: !!props.lazy });
  const settle = state => { if (display.read().src != null) { display.loaded(); props.onPhase(state); } };
  const picture = <>
    <img ref={image} src={display.read().src ?? undefined} alt="" decoding="async"
      classList={{ "vz-thumbnail-loaded": props.phase() === "loaded" }}
      fetchpriority={display.read().priority === "background" ? "low" : "auto"}
      draggable={false} onLoad={() => settle("loaded")} onError={() => settle("failed")} />
    <Show when={props.phase() === "pending"}><span class="vz-thumbnail-pending" role="status">Loading preview…</span></Show>
  </>;
  return props.surface ? props.surface(picture) : <div class="vz-thumbnail-surface">{picture}</div>;
}
