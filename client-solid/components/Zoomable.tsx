// client-solid/components/Zoomable.tsx — the image box: imgwrap + img,
// with in-feed zoom and the load lifecycle.
//
// The unload→error artificial-broken class dies by construction: the img src
// is derived, and a null src renders NO src attribute, so removing it can
// never fire an error. The zoom behavior (js/zoomable.mjs) binds PER KEY
// with teardown: a retargeted box rebinds and restores the new key's
// persisted view — no transform or pan leaks across images (G3). The box
// is full column width with a 16:9 floor on its aspect (taller
// for tall images); the image inside is scale-down + centered — never
// upscaled, never rendered in a corner.
//
// Props are VALUES (callers pass accessor calls: ar={ar()}) — no dual
// value/function contract (G12).

import { createSignal, createMemo, createEffect, on, onCleanup } from "solid-js";
import { makeZoomable } from "/js/zoomable.mjs";
import { useAppStore } from "../store/app-store.js";

// Decompose "W / H" into the --ar-num/--ar-den custom properties, clamped to
// the 16:9 floor: the box is never shorter than 16:9, taller for tall images
function arStyle(ar) {
  if (!ar) return undefined;
  const parts = String(ar).split("/").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  // clamp: the aspect never exceeds 16:9 (the floor); tall images use theirs
  const ratio = Math.min(parts[0] / parts[1], 16 / 9);
  return `--ar-num:${ratio};--ar-den:1`;
}

export function Zoomable(props) {
  const store = useAppStore();
  // the load lifecycle: phase is a memo over (src, loaded, errored) — src is
  // the source of truth; a src change restarts the lifecycle
  const [loaded, setLoaded] = createSignal(false);
  const [errored, setErrored] = createSignal(false);
  const phase = createMemo(() => {
    if (props.src == null) return "empty";
    if (errored()) return "error";
    return loaded() ? "loaded" : "loading";
  });
  createEffect(on(() => props.src, () => { setLoaded(false); setErrored(false); }));

  // the zoom's render state — the behavior emits it, JSX renders it
  const [transform, setTransform] = createSignal("");

  let imgEl;
  let binding = null;
  // bind per key: the old binding is disposed before the new one restores
  // its persisted view (G3)
  createEffect(on(() => props.zoomKey, () => {
    binding?.dispose();
    binding = null;
    setTransform("");
    if (!imgEl) return;
    binding = makeZoomable(imgEl, {
      key: props.zoomKey,
      getView: store.actions.views.get,
      setView: store.actions.views.set,
      onZoomChange: (z) => props.onZoomChange?.(z),
      onTransform: (t) => setTransform(t),
    });
  }));
  onCleanup(() => { binding?.dispose(); binding = null; });

  createEffect(() => props.onPhase?.(phase()));

  return (
    <div
      class={"imgwrap" + (phase() === "loaded" ? "" : ` ic-${phase()}`)}
      style={arStyle(props.ar)}
      onClick={() => { if (phase() === "error") props.onErrorClick?.(); else props.onOpen?.(); }}
    >
      <img
        ref={imgEl}
        alt={props.alt}
        src={props.src == null ? undefined : props.src}
        style={{ transform: transform() || undefined }}
        onLoad={(e) => {
          const img = e.target;
          if (img.naturalWidth && img.naturalHeight) props.onLoaded?.(img.naturalWidth, img.naturalHeight);
          // natural size is the box's aspect source; the image itself is
          // scale-down inside and never exceeds it (never upscaled)
          setLoaded(true);
        }}
        onError={() => {
          // a src removed between fetch and event must not read as an error
          if (props.src == null) return;
          setErrored(true);
        }}
      />
    </div>
  );
}
