// client/js/zoomable.mjs — in-feed zoom for ANY image. One code path for
// candidate cards, anchor thumbs, and the comparator stage alike.
// Ctrl+wheel zooms toward the cursor; drag pans while zoomed. A drag
// suppresses its trailing click (a pan must not open the workbench). View
// persistence is caller-provided (getView/setView — the app store owns the
// views and their debounced save). Viewer session crops have a distinct owner.
//
// The binding has a lifecycle: makeZoomable returns { dispose } — the
// component rebinds when its target key changes : a retargeted box must
// not carry the previous image's transform or pan).
//
// Views are read FRESH per gesture (never cached between events): a peer
// write can never go stale. `target(ev)` picks { key, box, geometry }
// (the comparator's Two-Up aims at the cell under the pointer; cards inject
// their explicit box and wheel surface independently of the pan element). `also(t)`
// supplies a peer { key, geometry }: the gesture's box-fraction delta is
// applied to that key's stored view too — entangle, never copy; one writer
// per gesture, so no recursion. Render state (the transform CSS, the zoomed
// flag) derives reactively from the shared image-space model in the renderer.
// The behavior never caches transforms or restores against binding-time DOM.

import { readZoomView, zoomViewPixels, readyViewGeometry, isIdentityView } from "./zoom-view.mjs";

const IDENTITY = { s: 1, txf: 0, tyf: 0 };

export function makeZoomable(el, { surface = el, box, key, geometry, target, also, panAlways = false, getView, setView, onActivate } = {}) {
  let dragMoved = 0;
  let pressedActivationKey = null, activationSequence = null;
  const activationKey = t => t.activationKey ?? t.key;
  let endDrag = () => {};

  const targetFor = (ev) => target ? target(ev) : { key, box, geometry };
  const frameFor = t => typeof t.geometry === "function" ? t.geometry() : t.geometry;
  const measuredFrame = t => {
    const g = frameFor(t), r = t.box?.getBoundingClientRect();
    // A cached fit cannot authorize a gesture during hidden/layout transitions.
    return readyViewGeometry(g) && r?.width > 0 && r?.height > 0
      && Math.abs(g.width-r.width) < 1 && Math.abs(g.height-r.height) < 1 ? g : null;
  };
  // SNAPSHOT the stored view: getView may hand back a live store proxy —
  // after the target's write lands, a proxy reads the NEW value and the
  // peer's delta would compute against it (ds = 1, the no-op entangle).
  // Non-finite fields are sanitized: a NaN that ever reached a persisted
  // view (a zero-box gesture) reads as identity, never as poison.
  const read = (t, g) => {
    const p = zoomViewPixels(t.key && getView ? getView(t.key, g) : null, g);
    return { s: p.s, txf: p.tx / g.width, tyf: p.ty / g.height };
  };

  const clampView = (v) => {
    const s = Math.min(12, Math.max(1, v.s));
    // zoom-out-to-1 recenters — unless pan is a first-class view state:
    // then a panned {s:1, txf, tyf} view is real and must survive
    if (!panAlways && s <= 1.001) return { ...IDENTITY };
    return { s, txf: v.txf, tyf: v.tyf };
  };
  const storeView = (t, v, g) => {
    if (!t.key || !setView) return;
    const crop = readZoomView(v, g);
    setView(t.key, isIdentityView(crop) ? null : crop);
  };

  // one writer per gesture: the target key gets the new view; the entangled
  // peer (when locked) gets the same DELTA against its own stored view —
  // never the target's absolute crop
  const write = (t, prev, next, g) => {
    next = clampView(next);
    // Snapshot the peer before either write (ports may return live proxies).
    const other = also?.(t), og = other && frameFor(other);
    const o = other?.key !== t.key && readyViewGeometry(og) && getView ? read(other, og) : null;
    storeView(t, next, g);
    if (o) {
      const ds = next.s / prev.s;
      storeView(other, clampView({
        s: o.s * ds,
        txf: o.txf + (next.txf - prev.txf),
        tyf: o.tyf + (next.tyf - prev.tyf),
      }), og);
    }
  };

  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const t = targetFor(e);
    // a zero-sized reference box is never a valid target (a hidden element
    // would divide by zero and poison the view with NaN)
    const g = measuredFrame(t);
    if (!g) return;
    if (t.interaction) {
      const r = t.box.getBoundingClientRect();
      t.interaction.zoom(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * .012));
      return;
    }
    const cur = read(t, g);
    const next = Math.min(12, Math.max(1, cur.s * Math.exp(-e.deltaY * 0.012)));
    if (next === cur.s) return;
    // zoom toward the cursor, in the target box's frame
    const r = t.box.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const k = 1 - next / cur.s;
    write(t, cur, {
      s: next,
      txf: cur.txf + k * ((e.clientX - ox) / r.width - cur.txf),
      tyf: cur.tyf + k * ((e.clientY - oy) / r.height - cur.tyf),
    }, g);
  };

  const onDown = (e) => {
    if (e.button > 0 || e.target?.closest?.("button,input,select,textarea,a,[data-gesture-boundary]")) return;
    dragMoved = 0;
    const t = targetFor(e);
    const g = measuredFrame(t);
    if (!g) return;
    const start = t.interaction ? { s: 1 } : read(t, g);
    pressedActivationKey = activationKey(t);
    // the drag pans at any zoom when panAlways — otherwise zoomed-only
    if (!panAlways && start.s <= 1) return;
    // a zero-sized reference box is never a valid target (see onWheel)
    endDrag();
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    const move = (ev) => {
      const g = measuredFrame(t);
      if (!g) return;
      if (t.interaction) {
        dragMoved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
        t.interaction.pan(ev.clientX - lx, ev.clientY - ly);
        lx = ev.clientX; ly = ev.clientY; return;
      }
      const cur = read(t, g);
      dragMoved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      const next = {
        s: cur.s,
        txf: cur.txf + (ev.clientX - lx) / (cur.s * g.width),
        tyf: cur.tyf + (ev.clientY - ly) / (cur.s * g.height),
      };
      write(t, cur, next, g);
      lx = ev.clientX; ly = ev.clientY;
    };
    const up = (event) => {
      if (event?.type === "pointercancel") activationSequence = null;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      endDrag = () => {};
    };
    endDrag = up;
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // swallow the click that ends a pan-drag (it must not open the workbench)
  const onClick = (e) => {
    if (onActivate) {
      const key = activationKey(targetFor(e));
      const eligible = dragMoved <= 5 && key === pressedActivationKey;
      activationSequence = { key, eligible: e.detail === 1 ? eligible
        : e.detail === 2 && eligible && activationSequence?.eligible && activationSequence.key === key };
    }
    if (dragMoved > 5) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = 0;
    }
  };
  const onDoubleClick = e => {
    if (!e.isTrusted || dragMoved > 5 || !activationSequence?.eligible ||
      activationSequence.key !== activationKey(targetFor(e)) || e.target?.closest?.("button,input,select,textarea,a")) return;
    onActivate?.(e);
  };

  surface.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("click", onClick, true);
  if (onActivate) el.addEventListener("dblclick", onDoubleClick);
  el.draggable = false;

  return {
    dispose() {
      activationSequence = null;
      endDrag();
      surface.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick, true);
      if (onActivate) el.removeEventListener("dblclick", onDoubleClick);
    },
  };
}
