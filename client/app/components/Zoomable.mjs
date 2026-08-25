// client/app/components/Zoomable.mjs — the image box: imgwrap + img + strip,
// with in-feed zoom and the load lifecycle.
//
// The unload→error artificial-broken class dies by construction here: the img
// src is a prop, and a null src renders NO src attribute, so removing it can
// never fire an error — no state flag, no getAttribute guard.

import { h } from "../../vendor/preact/vendor.mjs";
import { useState, useEffect, useRef } from "../../vendor/preact/vendor.mjs";
import { makeZoomable } from "../../js/zoomable.mjs";

// Decompose "W / H" into the --ar-num/--ar-den/--ar custom properties.
function arStyle(ar) {
  if (!ar) return undefined;
  const parts = String(ar).split("/").map((s) => parseFloat(s.trim()));
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  return { "--ar-num": String(parts[0]), "--ar-den": String(parts[1]), "--ar": `${parts[0]} / ${parts[1]}` };
}

export function Zoomable({ src, alt, ar, stripText, zoomKey, onZoomChange, onLoaded, onOpen, onErrorClick, onPhase }) {
  const [phase, setPhase] = useState(src == null ? "empty" : "loading");
  const imgRef = useRef(null);

  // src is the source of truth for the lifecycle phase.
  useEffect(() => {
    setPhase(src == null ? "empty" : "loading");
  }, [src]);

  // zoom behavior attaches once to the img element.
  useEffect(() => {
    if (imgRef.current) makeZoomable(imgRef.current, { key: zoomKey, onZoomChange });
  }, [zoomKey]);

  useEffect(() => { onPhase?.(phase); }, [phase]);

  const ic = phase === "loaded" ? "" : ` ic-${phase}`;
  return h("div", {
    class: "imgwrap" + ic,
    style: arStyle(ar),
    onClick: () => { if (phase === "error") onErrorClick?.(); else onOpen?.(); },
  },
    h("img", {
      ref: imgRef,
      alt,
      src: src == null ? undefined : src,
      onLoad: (e) => {
        const img = e.target;
        if (img.naturalWidth && img.naturalHeight) onLoaded?.(img.naturalWidth, img.naturalHeight);
        setPhase("loaded");
      },
      onError: () => {
        // a src removed between fetch and event must not read as an error
        if (!imgRef.current?.getAttribute("src")) return;
        setPhase("error");
      },
    }),
    h("div", { class: "mstrip", style: { display: stripText ? "block" : "none" } }, stripText ?? ""),
  );
}

// helper for callers: aspect string from extracted metadata
export function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}
