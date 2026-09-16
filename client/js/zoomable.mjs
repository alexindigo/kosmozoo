// client/js/zoomable.mjs — in-feed zoom for ANY image. One code path for
// candidate cards and anchor thumbs alike: same functionality, same code.
// Ctrl+wheel zooms toward the cursor; drag pans while zoomed. A drag
// suppresses its trailing click (a pan must not open the workbench). View
// persistence is caller-provided (getView/setView — the app store owns the
// views and their debounced save), so a crop made here carries into the
// workbench and back — and reloads restore it.
//
// The binding has a lifecycle: makeZoomable returns { dispose } — the
// component rebinds when its target key changes (G3: a retargeted box must
// not carry the previous image's transform or pan). Render state (the
// transform CSS, the zoomed flag) is emitted through onTransform and
// rendered by the component — the behavior never writes element style or
// classes itself.

export function makeZoomable(img, { key, getView, setView, onZoomChange, onTransform } = {}) {
  let scale = 1, txf = 0, tyf = 0, dragMoved = 0;

  // persist=false on restore: reading the stored view back is not a write —
  // a remount must not dirty the store into a settings PATCH
  const apply = (persist = true) => {
    if (scale <= 1.001) { scale = 1; txf = 0; tyf = 0; }
    const transform = scale === 1
      ? ""
      : `translate(${txf * img.offsetWidth}px, ${tyf * img.offsetHeight}px) scale(${scale})`;
    if (key && setView) {
      setView(key, scale > 1 || txf || tyf
        ? { s: scale, txf, tyf, fh: false, fv: false, rot: 0 }
        : null, { persist });
    }
    onZoomChange?.(scale > 1);
    onTransform?.(transform, scale > 1);
  };

  if (key && getView) {
    const stored = getView(key);
    if (stored) { scale = stored.s; txf = stored.txf; tyf = stored.tyf; apply(false); }
  }

  const onWheel = (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const next = Math.min(12, Math.max(1, scale * Math.exp(-e.deltaY * 0.012)));
    if (next === scale) return;
    // zoom toward the cursor
    const r = img.parentElement.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const k = 1 - next / scale;
    txf += k * ((e.clientX - ox) / r.width - txf);
    tyf += k * ((e.clientY - oy) / r.height - tyf);
    scale = next;
    apply();
  };

  const onDown = (e) => {
    dragMoved = 0;
    if (scale <= 1) return;
    e.preventDefault();
    e.stopPropagation();
    img.setPointerCapture(e.pointerId);
    let lx = e.clientX, ly = e.clientY;
    const move = (ev) => {
      dragMoved += Math.abs(ev.clientX - lx) + Math.abs(ev.clientY - ly);
      txf += (ev.clientX - lx) / (scale * img.offsetWidth);
      tyf += (ev.clientY - ly) / (scale * img.offsetHeight);
      lx = ev.clientX; ly = ev.clientY;
      apply();
    };
    const up = () => {
      img.removeEventListener("pointermove", move);
      img.removeEventListener("pointerup", up);
      img.removeEventListener("pointercancel", up);
    };
    img.addEventListener("pointermove", move);
    img.addEventListener("pointerup", up);
    img.addEventListener("pointercancel", up);
  };

  // swallow the click that ends a pan-drag (it must not open the workbench)
  const onClick = (e) => {
    if (dragMoved > 5) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = 0;
    }
  };

  img.addEventListener("wheel", onWheel, { passive: false });
  img.addEventListener("pointerdown", onDown);
  img.addEventListener("click", onClick, true);
  img.draggable = false;

  return {
    dispose() {
      img.removeEventListener("wheel", onWheel);
      img.removeEventListener("pointerdown", onDown);
      img.removeEventListener("click", onClick, true);
    },
  };
}
