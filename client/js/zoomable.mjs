// client/js/zoomable.mjs — in-feed zoom for ANY image. One code path for
// candidate cards, anchor thumbs, and the comparator stage alike.
// Ctrl+wheel zooms toward the cursor; drag pans while zoomed. A drag
// suppresses its trailing click (a pan must not open the workbench). View
// persistence is caller-provided (getView/setView — the app store owns the
// views and their debounced save), so a crop made here carries into the
// workbench and back — and reloads restore it.
//
// The binding has a lifecycle: makeZoomable returns { dispose } — the
// component rebinds when its target key changes : a retargeted box must
// not carry the previous image's transform or pan).
//
// Views are read FRESH per gesture (never cached between events): a peer
// write can never go stale. `target(ev)` picks the gesture's { key, box }
// (the comparator's Two-Up aims at the cell under the pointer; the default
// is the bound element's own key + parent box — the card path). `also(t)`
// names an entangled peer key: the gesture's delta ({ds, dtxf, dtyf}) is
// applied to that key's stored view too — entangle, never copy; one writer
// per gesture, so no recursion. Render state (the transform CSS, the zoomed
// flag) is emitted through onTransform and rendered by the component — the
// behavior never writes element style or classes itself.

const IDENTITY = { s: 1, txf: 0, tyf: 0 };

export function makeZoomable(el, { key, target, also, panAlways = false, getView, setView, onZoomChange, onTransform } = {}) {
  let dragMoved = 0;

  const targetFor = (ev) => target ? target(ev) : { key, box: el.parentElement };
  // SNAPSHOT the stored view: getView may hand back a live store proxy —
  // after the target's write lands, a proxy reads the NEW value and the
  // peer's delta would compute against it (ds = 1, the no-op entangle)
  const read = (k) => {
    const v = k && getView ? getView(k) : null;
    return v ? { s: v.s, txf: v.txf, tyf: v.tyf } : { ...IDENTITY };
  };

  const clampView = (v) => {
    const s = Math.min(12, Math.max(1, v.s));
    // zoom-out-to-1 recenters — unless pan is a first-class view state:
    // then a panned {s:1, txf, tyf} view is real and must survive
    if (!panAlways && s <= 1.001) return { ...IDENTITY };
    return { s, txf: v.txf, tyf: v.tyf };
  };
  const storeView = (k, v) => {
    if (!k || !setView) return;
    setView(k, v.s > 1 || v.txf || v.tyf
      ? { s: v.s, txf: v.txf, tyf: v.tyf, fh: false, fv: false, rot: 0 }
      : null);
  };
  const transformFor = (v, box) => (v.s === 1 && !v.txf && !v.tyf)
    ? ""
    : `translate(${v.txf * box.offsetWidth}px, ${v.tyf * box.offsetHeight}px) scale(${v.s})`;

  // one writer per gesture: the target key gets the new view; the entangled
  // peer (when locked) gets the same DELTA against its own stored view —
  // never the target's absolute crop
  const write = (t, prev, next) => {
    next = clampView(next);
    storeView(t.key, next);
    const otherKey = also?.(t);
    if (otherKey && getView) {
      const ds = next.s / prev.s;
      const o = read(otherKey);
      storeView(otherKey, clampView({
        s: o.s * ds,
        txf: o.txf + (next.txf - prev.txf),
        tyf: o.tyf + (next.tyf - prev.tyf),
      }));
    }
    onZoomChange?.(next.s > 1);
    onTransform?.(transformFor(next, t.box), next.s > 1);
  };

  // restore-on-bind: the card path renders the stored view's transform
  // immediately (no write — a remount must not dirty the store)
  if (key && getView && setView) {
    const stored = getView(key);
    if (stored) {
      const v = clampView(stored);
      onZoomChange?.(v.s > 1);
      onTransform?.(transformFor(v, el.parentElement), v.s > 1);
    }
  }

  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const t = targetFor(e);
    const cur = read(t.key);
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
    });
  };

  const onDown = (e) => {
    dragMoved = 0;
    const t = targetFor(e);
    const start = read(t.key);
    // the drag pans at any zoom when panAlways — otherwise zoomed-only
    if (!panAlways && start.s <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    let cur = start;
    const move = (ev) => {
      dragMoved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      const next = {
        s: cur.s,
        txf: cur.txf + (ev.clientX - lx) / (cur.s * t.box.offsetWidth),
        tyf: cur.tyf + (ev.clientY - ly) / (cur.s * t.box.offsetHeight),
      };
      write(t, cur, next);
      cur = next;
      lx = ev.clientX; ly = ev.clientY;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // swallow the click that ends a pan-drag (it must not open the workbench)
  const onClick = (e) => {
    if (dragMoved > 5) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = 0;
    }
  };

  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerdown", onDown);
  el.addEventListener("click", onClick, true);
  el.draggable = false;

  return {
    dispose() {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("click", onClick, true);
    },
  };
}
