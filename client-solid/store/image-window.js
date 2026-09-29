// client-solid/store/image-window.js — the feed's image-src window.
//
// Which images load, and when:
//   - WHILE SCROLLING: nothing new fires. The window is frozen — sweeping
//     200 cards loads none of them; in-flight loads keep going (a started
//     src is never revoked mid-gesture or by the next settle).
//   - AT SETTLE / CURRENT CHANGE: the window ripples out from the current
//     card in priority order — C, C+1, C-1, C+2, C-2, … — one ring per
//     RIPPLE_MS until the stopped range ± WINDOW_PAD is covered, so the
//     current image's bytes arrive first.
//   - WHILE IDLE: cards that newly appear (size landings) are covered by a
//     range union, not a re-ripple.
//
// Membership is by ENTRY ID, never position: size landings insert into the
// known list and shift positions under a frozen window; ids don't move.
// (The store's TWO INDEX SPACES rule lives in app-store.js — the ripple's
// ring arithmetic is in feed positions and crosses via entryAt.) Error
// state is keyed by entry id too (a host switch reindexes the list) and
// cleared on switch; the retry timer is sizes.js's one scheduler.

import { createSignal } from "solid-js";
import { api } from "/js/api.mjs";
import { scheduleRetry } from "./sizes.js";

export const WINDOW_PAD = 10;
const RIPPLE_MS = 40;

// entryAt: (feedPos) => entry — the store's feedEntryAt, the one feed→entry
// crossing. count: () => known-list length, for ring clamping.
export function makeImageWindow({ entryAt, count, rippleMs = RIPPLE_MS }) {
  const members = new Set();      // entry ids with an assigned src
  const startedIds = new Set();   // ids assigned but not settled (loaded/errored)
  const errored = new Set();      // entry ids whose bytes failed
  const retryNonce = new Map();   // id -> cache-bust nonce

  // window changes bump one version signal; every src derivation reads it,
  // so a membership change re-evaluates exactly the bound srcs
  const [version, setVersion] = createSignal(0);
  const bump = () => setVersion((v) => v + 1);

  let rippleTimer = 0;

  // stop the ripple (scroll start, new settle); members stay as they are —
  // a started load is never aborted
  function freeze() {
    clearTimeout(rippleTimer);
    rippleTimer = 0;
  }

  const addPos = (set, pos) => {
    if (pos < 0 || pos >= count()) return;
    const e = entryAt(pos);
    if (e) set.add(e.id);
  };

  // The settle ripple: C, C+1, C-1, C+2, C-2, … until the stopped range
  // ± pad is covered. In-flight ids stay members throughout.
  function settle(anchor, coverFirst, coverLast) {
    freeze();
    members.clear();
    for (const id of startedIds) members.add(id);
    const lo = Math.max(0, coverFirst - WINDOW_PAD);
    const hi = Math.min(count() - 1, coverLast + WINDOW_PAD);
    let k = 0;
    const step = () => {
      rippleTimer = 0;
      let grew = false;
      const before = members.size;
      if (k === 0) addPos(members, anchor);
      else if (k % 2 === 1) addPos(members, anchor + (k + 1) / 2);
      else addPos(members, anchor - k / 2);
      grew = members.size > before;
      if (grew) bump();
      k++;
      const coveredLow = anchor - Math.floor((k - 1) / 2) <= lo;
      const coveredHigh = anchor + Math.ceil((k - 1) / 2) >= hi;
      if (coveredLow && coveredHigh) return;
      rippleTimer = setTimeout(step, rippleMs);
    };
    step();
  }

  // Idle-time union: cards that newly appear (landings) inside the visible
  // range get covered without re-rippling.
  function coverRange(first, last) {
    const before = members.size;
    for (const id of startedIds) members.add(id);
    for (let p = Math.max(0, first - WINDOW_PAD); p <= last + WINDOW_PAD; p++) addPos(members, p);
    if (members.size > before) bump();
  }

  // src for a feed card: member → bytes url, else null. Reactive: reads the
  // bump, so a membership change re-derives exactly the bound srcs. The
  // error state is by id. "Started" is reported by the card's loading phase
  // (markStarted) — a read is not a start.
  const getSrc = (pos, img) => {
    version();
    if (!members.has(img.id)) return null;
    const nonce = retryNonce.get(img.id);
    return api.entryBytesUrl(img.host, img.filename) + (nonce ? `?_r=${nonce}` : "");
  };

  const markStarted = (id) => { startedIds.add(id); };
  const markLoaded = (id) => { startedIds.delete(id); errored.delete(id); };
  const markError = (id) => {
    startedIds.delete(id);
    errored.add(id);
    scheduleRetry(requeueErrored);
  };

  function requeueErrored() {
    let any = false;
    for (const id of [...errored]) {
      retryNonce.set(id, Date.now());
      errored.delete(id);
      startedIds.add(id);
      members.add(id);
      any = true;
    }
    if (any) {
      bump();
      if (errored.size) scheduleRetry(requeueErrored);
    }
  }

  // manual retry (cache-bust — a partial cached response must not be reused)
  const retry = (id) => {
    retryNonce.set(id, Date.now());
    errored.delete(id);
    startedIds.add(id);
    members.add(id);
    bump();
  };

  // a host switch reindexes everything — the window and the error state die
  // with the list
  const clear = () => {
    freeze();
    members.clear();
    startedIds.clear();
    errored.clear();
    retryNonce.clear();
  };

  return { getSrc, markStarted, markLoaded, markError, retry, clear, settle, coverRange, freeze, recompute: bump };
}
