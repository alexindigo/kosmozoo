// client-solid/lib/alt-key.js — ONE page-wide Alt/Option observation, shared by
// every consumer. Passive window listeners are added with the first consumer and
// removed with the last; they only observe and never consume or route input.
import { createSignal, onCleanup } from "solid-js";

const [held, setHeld] = createSignal(false);
const EVENTS = ["keydown", "keyup", "pointerdown", "pointermove"];
const observe = event => setHeld(!!event.altKey);
const release = () => setHeld(false);
let consumers = 0;

export function useAltKey() {
  if (consumers++ === 0) {
    for (const type of EVENTS) window.addEventListener(type, observe, { capture: true, passive: true });
    window.addEventListener("blur", release);
  }
  onCleanup(() => {
    if (--consumers > 0) return;
    for (const type of EVENTS) window.removeEventListener(type, observe, { capture: true });
    window.removeEventListener("blur", release);
    release();
  });
  return held;
}
