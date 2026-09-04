// client-solid/components/Zoomable.tsx — the image box: imgwrap + img,
// with in-feed zoom and the load lifecycle.
//
// The unload→error artificial-broken class dies by construction: the img src
// is derived, and a null src renders NO src attribute, so removing it can
// never fire an error. The zoom behavior (js/zoomable.mjs) attaches once.
// The box is full column width with a 16:9 floor on its aspect (taller for
// tall images); the image inside is scale-down + centered — never upscaled,
// never rendered in a corner.

import { createSignal, createEffect, onMount } from "solid-js";
import { makeZoomable } from "/js/zoomable.mjs";

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
  const [phase, setPhase] = createSignal(props.src == null ? "empty" : "loading");

  // src is the source of truth for the lifecycle phase
  createEffect(() => setPhase(props.src == null ? "empty" : "loading"));

  let imgEl;
  onMount(() => {
    if (imgEl) makeZoomable(imgEl, {
      key: typeof props.zoomKey === "function" ? props.zoomKey() : props.zoomKey,
      onZoomChange: props.onZoomChange,
    });
  });

  createEffect(() => props.onPhase?.(phase()));

  return (
    <div
      class={"imgwrap" + (phase() === "loaded" ? "" : ` ic-${phase()}`)}
      style={arStyle(typeof props.ar === "function" ? props.ar() : props.ar)}
      onClick={() => { if (phase() === "error") props.onErrorClick?.(); else props.onOpen?.(); }}
    >
      <img
        ref={imgEl}
        alt={typeof props.alt === "function" ? props.alt() : props.alt}
        src={props.src == null ? undefined : props.src}
        onLoad={(e) => {
          const img = e.target;
          if (img.naturalWidth && img.naturalHeight) props.onLoaded?.(img.naturalWidth, img.naturalHeight);
          // natural size is the box's aspect source; the image itself is
          // scale-down inside and never exceeds it (never upscaled)
          setPhase("loaded");
        }}
        onError={() => {
          // a src removed between fetch and event must not read as an error
          if (!imgEl?.getAttribute("src")) return;
          setPhase("error");
        }}
      />
    </div>
  );
}
