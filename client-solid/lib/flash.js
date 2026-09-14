// client-solid/lib/flash.js — ONE flash idiom (G9): a signal-driven class
// window with owned timer cleanup. The caller keeps the signal and renders
// the class; flash(setter, ms) returns the fire function.

import { onCleanup } from "solid-js";

export function flash(setter, ms = 1200) {
  let t = null;
  onCleanup(() => clearTimeout(t));
  return () => {
    setter(true);
    clearTimeout(t);
    t = setTimeout(() => setter(false), ms);
  };
}
