// client-solid/lib/drag.js — ONE pointer-drag primitive (G8): pointerdown on
// the handle, then window-level pointermove/pointerup (works at 0 px and
// while the pointer roams free of the strip). Movement is projected onto an
// axis as a 0..1 fraction of the handle's parent box (ctx.frac); onStart can
// attach extra context (a fixed edge, a snapshot rect). The handle's
// .dragging class is toggled here; the body-level cursor class is NOT this
// module's business — the store's `resizing` signal owns it, rendered once
// in App.
//
// The handle attaches through the returned JSX ref, so conditional branches
// re-attach it whenever the element renders (the listener lives and dies
// with the element).

import { createSignal, onCleanup } from "solid-js";

export function useDrag({ onDrag, onStart, axis = () => "x" } = {}) {
  const [dragging, setDragging] = createSignal(false);
  let handle = null;
  let ctx = null;

  const move = (ev) => {
    if (!ctx) return;
    if (ctx.box) {
      ctx.frac = axis() === "y"
        ? (ev.clientY - ctx.box.top) / (ctx.box.height || 1)
        : (ev.clientX - ctx.box.left) / (ctx.box.width || 1);
    }
    onDrag(ev, ctx);
  };
  const up = () => {
    setDragging(false);
    handle?.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    ctx = null;
  };
  const down = (e) => {
    e.preventDefault();
    ctx = {
      box: handle?.parentElement?.getBoundingClientRect() ?? null,
      start: e,
      ...(onStart?.(e) ?? {}),
    };
    setDragging(true);
    handle?.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const ref = (el) => {
    handle = el;
    if (el) el.addEventListener("pointerdown", down);
  };
  onCleanup(() => {
    handle?.removeEventListener("pointerdown", down);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  });

  return { dragging, ref };
}
