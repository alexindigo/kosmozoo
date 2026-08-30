// client-solid/components/DiffStage.tsx — the workbench surface.
//
// A single-image viewer of the store's current pointer. Renders the stage and
// owns the hidden flag from store.state.diff.open. The src is derived under a
// generation guard: a new image decodes off-screen first and the old one
// stays visible until it is ready — a stale load never clobbers a newer one.
// The image fits the stage via object-fit.

import { createSignal, createEffect, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";

const CLOSE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M18 6l-12 12" /><path d="M6 6l12 12" /></svg>';

const KEYS_BTN_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>';

export function DiffStage() {
  const store = useAppStore();
  const [src, setSrc] = createSignal(null);
  let gen = 0;

  // decode guard: swap the visible src only once the new image is ready and
  // the load wasn't superseded by a newer one (or closed mid-load)
  createEffect(() => {
    if (!store.state.diff.open) return;
    const r = store.actions.diff.resolve(store.state.current());
    if (!r) { setSrc(null); return; }
    const g = ++gen;
    const img = new Image();
    img.src = r.src;
    img.decode()
      .then(() => { if (g === gen && store.state.diff.open) setSrc(r.src); })
      .catch(() => { /* failed decode keeps whatever is on screen */ });
  });

  // Escape closes. Capture-outranking listeners (the delete confirmation)
  // stop propagation before this bubble handler sees the key; the keys panel
  // (phase 6) will outrank it too.
  const onKey = (e) => {
    if (e.key === "Escape" && store.state.diff.open && !store.state.keysPanelOpen()) {
      store.actions.diff.close();
    }
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div id="diff" hidden={!store.state.diff.open}>
      <button
        id="diffClose" title="close (Esc)"
        onClick={() => store.actions.diff.close()}
        innerHTML={CLOSE_SVG}
      />
      <div id="diffStage">
        <img id="diffImg" alt="" src={src() ?? undefined} />
      </div>
      <button
        id="diffKeysBtn" title="actions & keys (?)"
        onClick={(e) => { e.stopPropagation(); store.actions.ui.toggleKeysPanel(); }}
        innerHTML={KEYS_BTN_SVG}
      />
    </div>
  );
}
