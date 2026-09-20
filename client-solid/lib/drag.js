// client-solid/lib/drag.js — ONE pointer-drag primitive: pointerdown on
// the handle, then window-level pointermove/pointerup (works at 0 px and
// while the pointer roams free of the strip). Movement is projected onto an
// axis as a 0..1 fraction (ctx.frac); onStart can attach extra context —
// including overriding ctx.box, the box the fraction is measured against
// (default: the handle's parent element; override it when the sized
// element's edge is not the container's edge, e.g. a pane with siblings
// after it). The handle's .dragging class is toggled here; the body-level
// cursor class is NOT this module's business — the store's `resizing`
// signal owns it, rendered once in App.
//
// The axis is an ANCHOR EDGE, not a screen direction: the sized column's
// outer edge, and the fraction measures from it.
//   "x"  — the column is anchored LEFT  (frac from the left edge)
//   "x-" — anchored RIGHT (frac from the right edge — e.g. a rev layout,
//          where row-reverse puts the column on the right)
//   "y"  — anchored TOP,    "y-" — anchored BOTTOM
// Direction is declared once by the layout model; a consumer never writes
// raw clientX-minus-rect math.
//
// The handle attaches through the returned JSX ref, so conditional branches
// re-attach it whenever the element renders (the listener lives and dies
// with the element).

import { createSignal, onCleanup } from "solid-js";

// the fraction math, pure (unit-tested without a DOM)
export function fracFor(box, ev, axis) {
  switch (axis) {
    case "y": return (ev.clientY - box.top) / (box.height || 1);
    case "y-": return (box.bottom - ev.clientY) / (box.height || 1);
    case "x-": return (box.right - ev.clientX) / (box.width || 1);
    default: return (ev.clientX - box.left) / (box.width || 1);
  }
}

export function useDrag({ onDrag, onStart, axis = () => "x" } = {}) {
  const [dragging, setDragging] = createSignal(false);
  let handle = null;
  let ctx = null;

  const move = (ev) => {
    if (!ctx) return;
    if (ctx.box) {
      ctx.frac = fracFor(ctx.box, ev, axis());
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
