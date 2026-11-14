// client-solid/lib/click-outside.js — ONE click-outside primitive :
// a document-level click with structural containment for the whole interaction.
// Moving/unmounting content between press and release cannot turn an inside
// gesture into an outside click. Keyboard/programmatic clicks use their target
// as it was when the click was dispatched: a handler that replaces its own
// button (Remove, Keep, Cancel) cannot turn that click into an outside one.

import { onCleanup } from "solid-js";

export function useClickOutside(getEl, onOutside) {
  let press = null, dispatched = null;
  const onClickCapture = (e) => { dispatched = { event: e, inside: !!getEl()?.contains(e.target) }; };
  const onPointerDown = (e) => { press = { id: e.pointerId, inside: !!getEl()?.contains(e.target) }; };
  const onPointerCancel = (e) => { if (press?.id === e.pointerId) press = null; };
  const onDocClick = (e) => {
    const startedInside = !!press && e.detail !== 0 && press.id === e.pointerId && press.inside;
    const dispatchedInside = dispatched?.event === e && dispatched.inside;
    press = null; dispatched = null;
    if (e.cancelBubble) return; // Solid delegates handlers to this same document.
    const el = getEl();
    if (el && !startedInside && !dispatchedInside && !el.contains(e.target)) onOutside(e);
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointercancel", onPointerCancel, true);
  document.addEventListener("click", onClickCapture, true);
  document.addEventListener("click", onDocClick);
  onCleanup(() => {
    document.removeEventListener("click", onClickCapture, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointercancel", onPointerCancel, true);
    document.removeEventListener("click", onDocClick);
  });
}
