// client/js/zoomable.mjs — in-feed zoom for any image (candidate cards and
// anchor thumbs alike). Ctrl+wheel zooms toward the cursor; drag pans while
// zoomed; double-click resets. A drag suppresses its trailing click (a pan
// must not open the lightbox). Views persist via views.mjs, so a crop made
// here carries into the lightbox.
//
// restore: candidates reload their stored crop in the feed; anchor thumbs
// never load zoomed (the crop is for the lightbox) — pass restore: false.

import { getView, setView } from "./views.mjs";

export function makeZoomable(img, { key, restore = true, onZoomChange } = {}) {
  let scale = 1, txf = 0, tyf = 0, dragMoved = 0;

  const apply = () => {
    if (scale <= 1.001) { scale = 1; txf = 0; tyf = 0; }
    if (scale === 1) {
      img.style.transform = "";
    } else {
      img.style.transform =
        `translate(${txf * img.offsetWidth}px, ${tyf * img.offsetHeight}px) scale(${scale})`;
    }
    img.classList.toggle("zoomed", scale > 1);
    if (key) {
      setView(key, scale > 1 || txf || tyf
        ? { s: scale, txf, tyf, fh: false, fv: false, rot: 0 }
        : null);
    }
    onZoomChange?.(scale > 1);
  };

  if (restore && key) {
    const stored = getView(key);
    if (stored) { scale = stored.s; txf = stored.txf; tyf = stored.tyf; apply(); }
  }

  img.addEventListener("wheel", (e) => {
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
  }, { passive: false });

  img.addEventListener("pointerdown", (e) => {
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
  });

  // swallow the click that ends a pan-drag (it must not open the lightbox)
  img.addEventListener("click", (e) => {
    if (dragMoved > 5) {
      e.stopImmediatePropagation();
      e.preventDefault();
      dragMoved = 0;
    }
  }, true);

  img.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    scale = 1; txf = 0; tyf = 0;
    apply();
  });
  img.draggable = false;
}
