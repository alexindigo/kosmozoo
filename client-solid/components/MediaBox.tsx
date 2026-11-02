// One native media/render lifecycle for feed, details and comparator layers.
// Geometry, zoom persistence, application actions and player arbitration enter
// as inputs; the box never imports its consumers or the application store.
import { createSignal, createMemo, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { makeZoomable } from "/js/zoomable.mjs";
import { zoomViewTransform, readZoomView, readyViewGeometry } from "/js/zoom-view.mjs";
import { MediaControls, MediaControlBoundary, mediaTime } from "./MediaControls.js";
import { IconButton } from "./IconButton.js";
import { mediaFailure } from "../store/media-failure.js";
import { mediaGeometry, AUDIO_SIZE } from "../store/media-geometry.js";
import { iconSvg } from "/js/icons.mjs";

export function MediaBox(props) {
  const [loaded, setLoaded] = createSignal(false), [error, setError] = createSignal(false);
  const [paused, setPaused] = createSignal(true), [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0), [muted, setMuted] = createSignal(false), [loop, setLoop] = createSignal(false);
  const [surface, setSurface] = createSignal(null);
  const [allocation, setAllocation] = createSignal({ width: 0, height: 0 });
  const [natural, setNatural] = createSignal(null);
  let block, box, registration;
  const playable = () => props.kind === "video" || props.kind === "audio";
  const word = () => props.kind === "audio" ? "audio file" : "video";
  // Focus before an ancestor's native pan listener can capture the pointer.
  onMount(() => {
    const measure = () => { const r = box.getBoundingClientRect(); setAllocation({ width: r.width, height: r.height }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    onCleanup(() => observer.disconnect());
    const focus = () => { if (playable()) box.focus({ preventScroll: true }); };
    box.addEventListener("pointerdown", focus, true);
    onCleanup(() => box.removeEventListener("pointerdown", focus, true));
  });
  const phase = createMemo(() => props.failed || error() ? "error" : props.src == null ? "empty" : loaded() ? "loaded" : "loading");
  const toggle = () => {
    const el = surface();
    if (!playable() || !el || props.src == null || props.active === false || phase() === "error") return false;
    if (!el.paused) { el.pause(); return true; }
    return el.play().catch(err => { if (err.name !== "AbortError") props.onPlaybackError?.(err); });
  };
  // The native lifetime follows source VALUE, not every invalidation of a
  // window/size getter that happens to return that same URL.
  const source = createMemo(() => props.failed ? null : props.src);
  const size = () => props.size ?? (props.kind === "audio" ? AUDIO_SIZE : natural()?.src === source() ? natural() : null);
  const geometry = createMemo(() => mediaGeometry({ ...allocation(), size: size(), surface: props.workbench ? "viewer" : "card" }));
  const viewGeometry = () => size()?.w > 0 && size()?.h > 0 && readyViewGeometry(geometry()) ? geometry() : null;
  const measureNatural = el => setNatural({ src: source(), w: el.videoWidth || el.naturalWidth, h: el.videoHeight || el.naturalHeight });
  const transform = createMemo(() => {
    const zoom = props.zoom, g = viewGeometry();
    return zoom && g ? zoomViewTransform(zoom.getView(zoom.key, g), g) : "";
  });
  createEffect(() => {
    const zoom = props.zoom, g = viewGeometry();
    if (zoom) zoom.onZoomChange?.(g ? readZoomView(zoom.getView(zoom.key, g), g).s > 1 : false);
  });
  createEffect(on(() => [surface(), source()], ([el, src]) => {
    setLoaded(false); setError(false); setCurrent(0); setDuration(0);
    if (!el) return;
    const isPlayer = el.tagName === "VIDEO" || el.tagName === "AUDIO";
    if (isPlayer) { el.pause(); setPaused(true); }
    // Native consumers are explicitly retired before a src window/side change.
    if (src == null) el.removeAttribute("src"); else el.setAttribute("src", src);
    if (isPlayer) el.load();
    onCleanup(() => {
      if (isPlayer) el.pause();
      el.removeAttribute("src");
      if (isPlayer) el.load();
    });
  }));
  createEffect(() => { if (props.active === false && playable()) surface()?.pause(); });
  createEffect(() => {
    const el = surface();
    if (!playable() || !el || !props.registerPlayer) return;
    const owner = props.registerPlayer({
      workbench: !!props.workbench,
      focused: () => props.focused?.() || block?.contains(document.activeElement) || props.controlsMount?.contains(document.activeElement),
      primary: () => !!props.primary,
      available: () => props.src != null && !props.failed && props.active !== false && phase() !== "error",
      toggle, pause: () => el.pause(),
    });
    registration = owner;
    onCleanup(() => { owner.dispose(); if (registration === owner) registration = null; });
  });
  createEffect(on(() => [surface(), props.zoom?.key], ([el, key]) => {
    const zoom = props.zoom;
    if (!el || !zoom || props.kind === "audio") return;
    const binding = makeZoomable(el, { key, getView: zoom.getView, setView: zoom.setView,
      geometry: viewGeometry });
    onCleanup(() => binding.dispose());
  }));
  createEffect(() => props.onPhase?.(phase()));
  const click = () => {
    if (phase() === "error") props.onErrorClick?.();
    else if (playable()) toggle();
    else props.onOpen?.();
  };
  const style = () => ({ transform: props.transform || transform() || undefined,
    width: `${geometry().mediaWidth}px`, height: `${geometry().mediaHeight}px` });
  const controls = () => <MediaControls kind={props.kind} docked={props.workbench} mount={props.controlsMount} label={props.controlLabel}
    paused={paused()} current={current()} duration={duration()} muted={muted()} loop={loop()}
    onToggle={toggle} onSeek={n => { surface().currentTime = n; }} onMute={() => setMuted(v => !v)}
    onLoop={() => setLoop(v => !v)} onOpen={props.workbench ? undefined : props.onOpen} />;
  const feedControls = () => <Show when={props.src != null && phase() !== "error"}>{controls()}</Show>;
  return <div ref={block} class={`media-block ${props.workbench ? "media-block-stage" : ""}`}>
    <div ref={box} tabIndex={playable() ? 0 : undefined}
    class={`media-box ${props.workbench ? "media-stage" : "imgwrap"} ic-${phase()}`}
    data-kind={props.kind ?? "image"} style={!props.workbench ? { height: `${geometry().height}px` } : undefined} onClick={click}>
    <Show when={playable()} fallback={<img ref={setSurface} class={props.workbench ? "dz-img" : undefined}
      alt={props.alt} style={style()} decoding={props.workbench ? undefined : "async"}
      fetchpriority={props.fetchPriority === "background" ? "low" : "auto"}
      onLoad={e => { measureNatural(e.currentTarget); setLoaded(true); }}
      onError={() => { if (props.src != null) setError("decode"); }} />}>
      <Dynamic component={props.kind} ref={setSurface} class={props.workbench ? "dz-img" : undefined} preload="metadata" playsinline
        aria-label={props.alt} style={style()} loop={loop()} muted={muted()}
        onLoadedData={() => setLoaded(true)} onLoadedMetadata={e => { measureNatural(e.currentTarget); setDuration(e.currentTarget.duration); }}
        onDurationChange={e => setDuration(e.currentTarget.duration)} onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => { registration?.started(); setPaused(false); }} onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)} onVolumeChange={e => setMuted(e.currentTarget.muted)}
        onError={e => { if (props.src != null) setError(e.currentTarget.error?.code || "unknown"); }} />
      <Show when={props.src != null && phase() !== "error"}>
        <Show when={(!props.workbench && paused()) || props.kind === "audio"}><div style={props.workbench || props.kind !== "audio" ? style() : undefined} class={`media-play-overlay ${props.kind === "audio" ? "media-audio-face" : ""}`}>
          <Show when={!props.workbench}><MediaControlBoundary class="media-play-boundary">
            <IconButton variant="play prominent media-play" title={`${paused() ? "play" : "pause"} ${word()}`}
              onAction={toggle} icon={iconSvg(paused() ? "player-play" : "player-pause", 28)} />
          </MediaControlBoundary></Show>
          <Show when={props.kind === "audio"}><span class="media-duration">{mediaTime(duration())}</span></Show>
        </div></Show>
        <Show when={props.workbench}>{controls()}</Show>
      </Show>
    </Show>
    <Show when={phase() === "error"}><div class="media-failure" role="status">
      <span class="media-failure-name">{props.alt}</span><span>{mediaFailure(props.kind ?? "image", props.failed ? props.failureCode : error())}</span>
      <span>Download it to open elsewhere.</span>
      <Show when={!props.failed && props.onErrorClick}><span>click to retry</span></Show>
    </div></Show>
    </div>
    <Show when={!props.workbench && playable()}>
      <Show when={props.controlsMount} fallback={<div class="media-controls-slot">{feedControls()}</div>}>
        {feedControls()}
      </Show>
    </Show>
  </div>;
}
