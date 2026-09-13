// client-solid/store/image-window.js — the feed's image-src window.
//
// A card's src is DERIVED from the virtualizer's range (§3.5): in window →
// bytes url, out → null. No per-card IntersectionObserver, no manual
// unload, no regCache, no workbenchFeedIdx scan (B12's window half) — the
// range membership IS the mechanism; the workbench pins its entry id
// explicitly. Size resolution lives in ./sizes.js; this module owns only
// src membership + the error-retry seam.

import { createSignal } from "solid-js";
import { api } from "/js/api.mjs";

export const WINDOW_PAD = 10;
const ERROR_RETRY_MS = 8000;

// range: () => { first, last } in image indices — fed from the registered
// virtualizer's getVirtualItems().
export function makeImageWindow({ range }) {
  const errored = new Set();
  const retryNonce = new Map();
  let retryTimer = null;

  // window changes bump one version signal; every src derivation reads it,
  // so a membership change re-evaluates exactly the bound srcs
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  function bounds() {
    const r = range();
    if (!r || r.last < r.first) return null;
    return [Math.max(0, r.first - WINDOW_PAD), r.last + WINDOW_PAD];
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      let any = false;
      const b = bounds();
      for (const idx of [...errored]) {
        if (b && idx >= b[0] && idx <= b[1]) {
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

  // src for a feed card: in-window → bytes url, else null. Reactive: reads
  // the range signal + the bump, so a range change re-derives exactly the
  // bound srcs.
  const getSrc = (idx, img) => {
    version();
    const b = bounds();
    if (!b || idx < b[0] || idx > b[1]) return null;
    const nonce = retryNonce.get(idx);
    return api.entryBytesUrl(img.host, img.filename) + (nonce ? `?_r=${nonce}` : "");
  };

  const markLoaded = (idx) => { errored.delete(idx); };
  const markError = (idx) => {
    errored.add(idx);
    scheduleRetry();
  };

  // manual retry (cache-bust — a partial cached response must not be reused)
  const retry = (idx) => {
    retryNonce.set(idx, Date.now());
    errored.delete(idx);
    bump();
  };

  return { getSrc, markLoaded, markError, retry, recompute: bump };
}
