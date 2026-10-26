// One native media/render lifecycle for feed, details and comparator layers.
// Geometry, zoom persistence, application actions and player arbitration enter
// as inputs; the box never imports its consumers or the application store.
import { createSignal, createMemo, createEffect, on, onMount, onCleanup, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { makeZoomable } from "/js/zoomable.mjs";
import { MediaControls, MediaControlBoundary } from "./MediaControls.js";
import { iconSvg } from "/js/icons.mjs";

export function MediaBox(props) {
  const [loaded, setLoaded] = createSignal(false), [error, setError] = createSignal(false);
  const [paused, setPaused] = createSignal(true), [current, setCurrent] = createSignal(0);
  const [duration, setDuration] = createSignal(0), [muted, setMuted] = createSignal(false), [loop, setLoop] = createSignal(false);
  const [surface, setSurface] = createSignal(null), [transform, setTransform] = createSignal("");
  let box, registration;
  const playable = () => props.kind === "video" || props.kind === "audio";
  const word = () => props.kind === "audio" ? "audio file" : "video";
  // Focus before an ancestor's native pan listener can capture the pointer.
  onMount(() => {
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
      focused: () => props.focused?.() || box?.contains(document.activeElement),
      primary: () => !!props.primary,
      available: () => props.src != null && !props.failed && props.active !== false && phase() !== "error",
      toggle, pause: () => el.pause(),
    });
    registration = owner;
    onCleanup(() => { owner.dispose(); if (registration === owner) registration = null; });
  });
  createEffect(on(() => [surface(), props.zoom?.key], ([el, key]) => {
    const zoom = props.zoom;
    setTransform("");
    if (!el || !zoom || props.kind === "audio") return;
    const binding = makeZoomable(el, { key, getView: zoom.getView, setView: zoom.setView,
      onZoomChange: zoom.onZoomChange, onTransform: setTransform });
    onCleanup(() => binding.dispose());
  }));
  createEffect(() => props.onPhase?.(phase()));
  const click = () => {
    if (phase() === "error") props.onErrorClick?.();
    else if (playable()) toggle();
    else props.onOpen?.();
  };
  const style = () => ({ transform: props.transform || transform() || undefined });
  return <div ref={box} tabIndex={playable() ? 0 : undefined}
    class={`media-box ${props.workbench ? "media-stage" : "imgwrap"} ic-${phase()}`}
    data-kind={props.kind ?? "image"} style={props.boxStyle} onClick={click}>
    <Show when={playable()} fallback={<img ref={setSurface} class={props.workbench ? "dz-img" : undefined}
      alt={props.alt} style={style()} onLoad={() => setLoaded(true)}
      onError={() => { if (props.src != null) setError(true); }} />}>
      <Dynamic component={props.kind} ref={setSurface} class={props.workbench ? "dz-img" : undefined} preload="metadata" playsinline
        aria-label={props.alt} style={style()} loop={loop()} muted={muted()}
        onLoadedData={() => setLoaded(true)} onLoadedMetadata={e => setDuration(e.currentTarget.duration)}
        onDurationChange={e => setDuration(e.currentTarget.duration)} onTimeUpdate={e => setCurrent(e.currentTarget.currentTime)}
        onPlay={() => { registration?.started(); setPaused(false); }} onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)} onVolumeChange={e => setMuted(e.currentTarget.muted)}
        onError={() => { if (props.src != null) setError(true); }} />
      <Show when={props.src != null && phase() !== "error"}>
        <Show when={paused() || props.kind === "audio"}><div class={`media-play-overlay ${props.kind === "audio" ? "media-audio-face" : ""}`}>
          <Show when={props.kind === "audio"}><span class="media-audio-name">{props.alt}</span></Show>
          <Show when={paused()}><MediaControlBoundary class="media-play-boundary">
            <button type="button" class="media-play" title={`play ${word()}`} aria-label={`play ${word()}`} onClick={toggle} innerHTML={iconSvg("player-play", 28)} />
          </MediaControlBoundary></Show>
        </div></Show>
        <MediaControls kind={props.kind} paused={paused()} current={current()} duration={duration()} muted={muted()} loop={loop()}
          onToggle={toggle} onSeek={n => { surface().currentTime = n; }} onMute={() => setMuted(v => !v)}
          onLoop={() => setLoop(v => !v)} onOpen={props.onOpen} />
      </Show>
    </Show>
    <Show when={phase() === "error"}><div class="media-failure" role="status">
      <span class="media-failure-name">{props.alt}</span><span>can't display this file</span>
      <Show when={!props.failed && props.onErrorClick}><span>click to retry</span></Show>
    </div></Show>
  </div>;
}
