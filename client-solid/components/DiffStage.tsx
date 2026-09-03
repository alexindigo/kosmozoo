// client-solid/components/DiffStage.tsx — the workbench surface.
//
// A single-image viewer of the store's current pointer. Renders the stage and
// owns the hidden flag from store.state.diff.open. The src is derived under a
// generation guard: a new image decodes off-screen first and the old one
// stays visible until it is ready — a stale load never clobbers a newer one.
// The image fits the stage via object-fit.

import { createSignal, createEffect } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { iconSvg } from "/js/icons.mjs";

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

  // Escape closes via the keys system (the "wb.close" binding registered at
  // boot — the keys panel's Escape outranks it by registration order, and
  // the delete confirmation's capture-phase listener beats both).

  return (
    <div id="diff" hidden={!store.state.diff.open}>
      <button
        id="diffClose" title="close (Esc)"
        onClick={() => store.actions.diff.close()}
        innerHTML={iconSvg("x", 16)}
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
