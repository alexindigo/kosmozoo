// client-solid/store/image-window.tsx — the feed's image-src window.
//
// Port of useWindow: visibility is observed here; the window is
// visible ∪ workbench-position ± WINDOW_PAD. A card's src is DERIVED from
// the window (in-window -> bytes url, out -> null), so there is no manual
// unload and no artificial error class — removing src simply renders no src.
// One window per store; views reach it via store.state.window.

import { createSignal } from "solid-js";
import { api } from "/js/api.mjs";

export const WINDOW_PAD = 10;
const ERROR_RETRY_MS = 8000;

export function makeImageWindow(store) {
  const visible = new Set();
  const els = new Map();
  const errored = new Set();
  const retryNonce = new Map();
  const regCache = new Map();
  let retryTimer = null;

  // window changes bump one version signal; every src derivation reads it,
  // so a membership change re-evaluates exactly the bound srcs
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  // headless (unit tests): a no-op observer when there's no DOM
  const IO = typeof IntersectionObserver !== "undefined"
    ? IntersectionObserver
    : class { observe() {} unobserve() {} disconnect() {} };
  const observer = new IO((entries) => {
    let changed = false;
    for (const en of entries) {
      const idx = Number(en.target.dataset.idx);
      if (en.isIntersecting) {
        if (!visible.has(idx)) { visible.add(idx); changed = true; }
      } else if (visible.delete(idx)) changed = true;
    }
    if (changed) {
      bump();
      scheduleRetry();
    }
  });

  // The workbench side, when it names the loaded feed host, keeps its card
  // (and neighbors) in the window while browsing (phase 4 exercises this).
  function workbenchFeedIdx() {
    const d = store.state.diff;
    if (!d.open || !d.left || d.left.source !== store.state.host()) return -1;
    const images = store.state.images;
    for (let i = 0; i < images.length; i++) {
      const f = images[i].filename;
      if (f === d.left.file || f === d.left.source + "#" + d.left.file) return i;
    }
    return -1;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      let any = false;
      for (const idx of [...errored]) {
        // only retry cards still in the window
        const wbIdx = workbenchFeedIdx();
        if (visible.has(idx) || (wbIdx >= 0 && Math.abs(wbIdx - idx) <= WINDOW_PAD)) {
          retryNonce.set(idx, Date.now());
          errored.delete(idx);
          any = true;
        }
      }
      if (any) {
        bump();
        scheduleRetry();
      }
    }, ERROR_RETRY_MS);
  }

  // callback ref factory: register/unregister a card element with the
  // observer. Cached per index so the ref identity is stable (no
  // observe/unobserve churn).
  const register = (idx) => {
    let fn = regCache.get(idx);
    if (!fn) {
      fn = (el) => {
        const prev = els.get(idx);
        if (prev === el) return;
        if (prev) observer.unobserve(prev);
        if (el) { els.set(idx, el); observer.observe(el); }
        else els.delete(idx);
      };
      regCache.set(idx, fn);
    }
    return fn;
  };

  function bounds() {
    const base = [...visible];
    const wbIdx = workbenchFeedIdx();
    if (wbIdx >= 0) base.push(wbIdx);
    if (!base.length) return null;
    return [Math.min(...base) - WINDOW_PAD, Math.max(...base) + WINDOW_PAD];
  }

  const getSrc = (idx, imageId) => {
    version(); // reactive: window membership changes re-derive srcs
    const b = bounds();
    if (!b || idx < b[0] || idx > b[1]) return null;
    const nonce = retryNonce.get(idx);
    return api.imageBytesUrl(imageId) + (nonce ? `?_r=${nonce}` : "");
  };

  // a card finished loading -> it is no longer errored
  const markLoaded = (idx) => { errored.delete(idx); };
  // a card failed -> schedule an auto-retry while it stays in the window
  const markError = (idx) => {
    errored.add(idx);
    scheduleRetry();
  };

  // manual retry (cache-bust)
  const retry = (idx) => {
    retryNonce.set(idx, Date.now());
    errored.delete(idx);
    bump();
  };

  return { register, getSrc, markLoaded, markError, retry, recompute: bump };
}
