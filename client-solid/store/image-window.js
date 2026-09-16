// client-solid/store/image-window.js — the feed's image-src window.
//
// A card's src is DERIVED from the virtualizer's range: in window → bytes
// url, out → null. No per-card IntersectionObserver, no manual unload, no
// regCache, no index scan — the range membership IS the mechanism; the
// workbench pins its entry id explicitly. Size resolution lives in
// ./sizes.js; this module owns only src membership + the error-retry seam.
// Error state is keyed by ENTRY ID (a host switch reindexes the list; index
// keys would retarget another image) and cleared on host switch; the retry
// timer itself is sizes.js's one scheduler.

import { createSignal } from "solid-js";
import { api } from "/js/api.mjs";
import { scheduleRetry } from "./sizes.js";

export const WINDOW_PAD = 10;

// range: () => { first, last } in image indices — fed from the registered
// virtualizer's getVirtualItems().
export function makeImageWindow({ range }) {
  const errored = new Set();    // entry ids whose bytes failed
  const retryNonce = new Map(); // id -> cache-bust nonce

  // window changes bump one version signal; every src derivation reads it,
  // so a membership change re-evaluates exactly the bound srcs
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  function bounds() {
    const r = range();
    if (!r || r.last < r.first) return null;
    return [Math.max(0, r.first - WINDOW_PAD), r.last + WINDOW_PAD];
  }

  function requeueErrored() {
    let any = false;
    const b = bounds();
    for (const id of [...errored]) {
      retryNonce.set(id, Date.now());
      errored.delete(id);
      any = true;
    }
    if (any) {
      bump();
      // entries still failing land back in errored and the next window
      // re-queues them (one scheduler, in sizes.js)
      if (errored.size) scheduleRetry(requeueErrored);
    }
  }

  // src for a feed card: in-window → bytes url, else null. Reactive: reads
  // the range signal + the bump, so a range change re-derives exactly the
  // bound srcs. Membership is by position (idx); the error state is by id.
  const getSrc = (idx, img) => {
    version();
    const b = bounds();
    if (!b || idx < b[0] || idx > b[1]) return null;
    const nonce = retryNonce.get(img.id);
    return api.entryBytesUrl(img.host, img.filename) + (nonce ? `?_r=${nonce}` : "");
  };

  const markLoaded = (id) => { errored.delete(id); };
  const markError = (id) => {
    errored.add(id);
    scheduleRetry(requeueErrored);
  };

  // manual retry (cache-bust — a partial cached response must not be reused)
  const retry = (id) => {
    retryNonce.set(id, Date.now());
    errored.delete(id);
    bump();
  };

  // a host switch reindexes everything — the error state dies with the list
  const clear = () => {
    errored.clear();
    retryNonce.clear();
  };

  return { getSrc, markLoaded, markError, retry, clear, recompute: bump };
}
