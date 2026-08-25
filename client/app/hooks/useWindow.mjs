// client/app/hooks/useWindow.mjs — the feed's image window, in ONE hook.
//
// Replaces the feed's two chunked IntersectionObservers + the manual
// load/unload pair. Visibility is observed here; the window is
// visible ∪ workbench-position ± WINDOW_PAD. A card's src is DERIVED from
// the window (in-window -> bytes url, out -> null), so there is no manual
// unload and no artificial error class — removing src simply renders no src.

import { useState, useEffect, useRef, useCallback } from "../../vendor/preact/vendor.mjs";
import { state } from "../../js/state.mjs";
import { api } from "../../js/api.mjs";

export const WINDOW_PAD = 10;
const ERROR_RETRY_MS = 8000;

// The workbench's left side, when it names the loaded feed host, keeps its
// card (and neighbors) in the window while browsing.
function workbenchFeedIdx() {
  const d = state.diff;
  if (!d.open || !d.left || d.left.source !== state.host) return -1;
  for (let i = 0; i < state.images.length; i++) {
    const f = state.images[i].filename;
    if (f === d.left.file || f === d.left.source + "#" + d.left.file) return i;
  }
  return -1;
}

export function useWindow() {
  const [, bump] = useState(0);
  const visible = useRef(new Set());
  const els = useRef(new Map());
  const observer = useRef(null);
  const errored = useRef(new Set());
  const retryNonce = useRef(new Map());
  const retryTimer = useRef(null);

  const scheduleRetry = useCallback(() => {
    if (retryTimer.current) return;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      let any = false;
      for (const idx of [...errored.current]) {
        // only retry cards still in the window
        const wbIdx = workbenchFeedIdx();
        if (visible.current.has(idx) || (wbIdx >= 0 && Math.abs(wbIdx - idx) <= WINDOW_PAD)) {
          retryNonce.current.set(idx, Date.now());
          errored.current.delete(idx);
          any = true;
        }
      }
      if (any) {
        bump((v) => v + 1);
        scheduleRetry();
      }
    }, ERROR_RETRY_MS);
  }, []);

  useEffect(() => {
    observer.current = new IntersectionObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const idx = Number(en.target.dataset.idx);
        if (en.isIntersecting) {
          if (!visible.current.has(idx)) { visible.current.add(idx); changed = true; }
        } else if (visible.current.delete(idx)) changed = true;
      }
      if (changed) {
        bump((v) => v + 1);
        scheduleRetry();
      }
    });
    const obs = observer.current;
    // observe any elements whose refs fired before the observer existed
    for (const el of els.current.values()) obs.observe(el);
    return () => { obs.disconnect(); clearTimeout(retryTimer.current); retryTimer.current = null; };
  }, [scheduleRetry]);

  // callback ref factory: register/unregister a card element with the observer.
  // Cached per index so the ref identity is stable across re-renders (no
  // observe/unobserve churn).
  const regCache = useRef(new Map());
  const register = useCallback((idx) => {
    let fn = regCache.current.get(idx);
    if (!fn) {
      fn = (el) => {
        const prev = els.current.get(idx);
        if (prev === el) return;
        if (prev && observer.current) observer.current.unobserve(prev);
        if (el) { els.current.set(idx, el); observer.current?.observe(el); }
        else els.current.delete(idx);
      };
      regCache.current.set(idx, fn);
    }
    return fn;
  }, []);

  // window bounds from visibility ∪ workbench position
  const base = [...visible.current];
  const wbIdx = workbenchFeedIdx();
  if (wbIdx >= 0) base.push(wbIdx);
  let lo = Infinity, hi = -Infinity;
  if (base.length) {
    lo = Math.min(...base) - WINDOW_PAD;
    hi = Math.max(...base) + WINDOW_PAD;
  }
  const inWindow = useCallback((idx) => base.length > 0 && idx >= lo && idx <= hi, [base.length, lo, hi]);

  const getSrc = useCallback((idx, imageId) => {
    if (!inWindow(idx)) return null;
    const nonce = retryNonce.current.get(idx);
    return api.imageBytesUrl(imageId) + (nonce ? `?_r=${nonce}` : "");
  }, [inWindow]);

  // a card finished loading -> it is no longer errored
  const markLoaded = useCallback((idx) => { errored.current.delete(idx); }, []);
  // a card failed -> schedule an auto-retry while it stays in the window
  const markError = useCallback((idx) => {
    errored.current.add(idx);
    scheduleRetry();
  }, [scheduleRetry]);

  // manual retry (cache-bust) — the feed's retryImage seam
  const retry = useCallback((idx) => {
    retryNonce.current.set(idx, Date.now());
    errored.current.delete(idx);
    bump((v) => v + 1);
  }, []);

  // force a window recompute (the workbench calls this after stepping)
  const recompute = useCallback(() => { bump((v) => v + 1); }, []);

  return { register, getSrc, inWindow, markLoaded, markError, retry, recompute };
}
