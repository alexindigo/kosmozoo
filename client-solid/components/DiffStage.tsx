// client-solid/components/DiffStage.tsx — the workbench surface.
//
// A single-image viewer of the store's current pointer. Renders the stage and
// owns the hidden flag from store.state.diff.open. The src is a decode-guarded
// resource (G16): a new image decodes off-screen first and the last value
// stays visible until it is ready — a stale load never clobbers a newer one,
// and the resource's own recency replaces the hand-rolled generation counter.
// The image fits the stage via object-fit.

import { createResource } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { iconSvg } from "/js/icons.mjs";

export function DiffStage() {
  const store = useAppStore();

  // decode guard: the visible src swaps only once the new image decodes;
  // a failed decode RESOLVES to the last good src (never throws, never
  // blanks the stage), and closing the workbench idles the source
  let lastGood = null;
  const [decoded] = createResource(
    () => (store.state.diff.open
      ? (store.actions.diff.resolve(store.state.current())?.src ?? null)
      : null),
    async (url) => {
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
        lastGood = url;
        return url;
      } catch {
        return lastGood;
      }
    },
  );

  // Escape closes via the keys system (the "wb.close" binding registered at
  // boot) — an open modal's key layer outranks it, and a running key
  // capture outranks that.

  return (
    <div id="diff" hidden={!store.state.diff.open}>
      <button
        id="diffClose" title="close (Esc)"
        onClick={() => store.actions.diff.close()}
        innerHTML={iconSvg("x", 16)}
      />
      <div id="diffStage">
        <img id="diffImg" alt="" src={decoded() ?? undefined} />
      </div>
      <button
        id="diffKeysBtn" title="actions & keys (?)"
        onClick={() => store.actions.ui.toggleKeysPanel()}
        innerHTML={iconSvg("keyboard", 18)}
      />
    </div>
  );
}
