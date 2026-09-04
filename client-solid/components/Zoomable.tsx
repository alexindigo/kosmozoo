// client-solid/components/Zoomable.tsx — the image box: imgwrap + img,
// with in-feed zoom and the load lifecycle.
//
// The unload→error artificial-broken class dies by construction: the img src
// is derived, and a null src renders NO src attribute, so removing it can
// never fire an error. The zoom behavior (js/zoomable.mjs) attaches once.
// The box never upscales: it caps at the image's natural width (meta width
// before decode, the decoded natural width after).

import { createSignal, createEffect, onMount } from "solid-js";
import { makeZoomable } from "/js/zoomable.mjs";

// Decompose "W / H" into the --ar-num/--ar-den/--ar custom properties.
function arStyle(ar) {
  if (!ar) return undefined;
  const parts = String(ar).split("/").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return `--ar-num:${parts[0]};--ar-den:${parts[1]};--ar:${parts[0]} / ${parts[1]}`;
}

export function Zoomable(props) {
  const [phase, setPhase] = createSignal(props.src == null ? "empty" : "loading");
  // the decoded natural width — refines the pre-decode cap (props.maxWidth)
  const [naturalW, setNaturalW] = createSignal(null);

  // src is the source of truth for the lifecycle phase; a slot retarget
  // (virtual reuse) drops the previous image's natural width
  createEffect(() => {
    props.src;
    setPhase(props.src == null ? "empty" : "loading");
    setNaturalW(null);
  });

  // never larger than natural: meta width pre-decode, natural width after
  const capW = () => props.maxWidth ?? naturalW();
  const styleStr = () => [
    arStyle(typeof props.ar === "function" ? props.ar() : props.ar),
    capW() != null ? `max-width: ${capW()}px` : null,
  ].filter(Boolean).join(";");

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
      style={styleStr()}
      onClick={() => { if (phase() === "error") props.onErrorClick?.(); else props.onOpen?.(); }}
    >
      <img
        ref={imgEl}
        alt={typeof props.alt === "function" ? props.alt() : props.alt}
        src={props.src == null ? undefined : props.src}
        onLoad={(e) => {
          const img = e.target;
          if (img.naturalWidth && img.naturalHeight) props.onLoaded?.(img.naturalWidth, img.naturalHeight);
          setNaturalW(img.naturalWidth);
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
