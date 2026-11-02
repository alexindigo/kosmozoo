// client-solid/lib/click-outside.js — ONE click-outside primitive :
// a document-level click with structural containment for the whole interaction.
// Moving/unmounting content between press and release cannot turn an inside
// gesture into an outside click. Keyboard/programmatic clicks use their target.

import { onCleanup } from "solid-js";

export function useClickOutside(getEl, onOutside) {
  let press = null;
  const onPointerDown = (e) => { press = { id: e.pointerId, inside: !!getEl()?.contains(e.target) }; };
  const onPointerCancel = (e) => { if (press?.id === e.pointerId) press = null; };
  const onDocClick = (e) => {
    const startedInside = !!press && e.detail !== 0 && press.id === e.pointerId && press.inside;
    press = null;
    if (e.cancelBubble) return; // Solid delegates handlers to this same document.
    const el = getEl();
    if (el && !startedInside && !el.contains(e.target)) onOutside(e);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onDocClick);
  onCleanup(() => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("click", onDocClick);
  });
}
