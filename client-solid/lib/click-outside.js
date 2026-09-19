// client-solid/lib/click-outside.js — ONE click-outside primitive :
// a document-level click with a structural containment check. The dropdown's
// own clicks are inside by construction — no stopPropagation shield needed.

import { onCleanup } from "solid-js";

export function useClickOutside(getEl, onOutside) {
  const onDocClick = (e) => {
    const el = getEl();
    if (el && !el.contains(e.target)) onOutside(e);
  };
  document.addEventListener("click", onDocClick);
  onCleanup(() => document.removeEventListener("click", onDocClick));
}
