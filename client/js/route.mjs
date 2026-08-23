// client/js/route.mjs — the URL is the store for the current image.
//
//   /#<host>            current host selection
//   /#<host>#<file>     host + current image
//
// location is the single source of truth: parseUrl() is the only reader,
// the writers below the only writers. Nothing else caches the current
// image — a second representation would be a drift surface.
//
// Files in the hash are stripped of any "<host>#" save prefix (the hash
// already carries the host — mirror of card.mjs hostPrefixed).

import { state } from "./state.mjs";

export function parseUrl() {
  if (typeof location === "undefined") return { view: "feed", host: null, file: null };
  if (location.pathname === "/diff") {
    // v1: the diff view parses its pair in commit 3's diff.mjs; the feed
    // reader only needs to know it isn't the feed
    return { view: "diff", hash: location.hash.replace(/^#/, "") };
  }
  const h = location.hash.replace(/^#/, "");
  if (!h) return { view: "feed", host: null, file: null };
  const [host, file] = h.split("#");
  return {
    view: "feed",
    host: host ? decodeURIComponent(host) : null,
    file: file ? decodeURIComponent(file) : null,
  };
}

export function stripHostPrefix(host, filename) {
  const pfx = host + "#";
  return filename.startsWith(pfx) ? filename.slice(pfx.length) : filename;
}

// deep links carry the stripped name; the feed may hold either form
export function matchesFile(image, host, file) {
  return image.filename === file || image.filename === host + "#" + file;
}

// the URL's current file resolved against the list; hidden images count —
// the URL outranks visibility
export function findByFile(file) {
  if (!file) return -1;
  return state.images.findIndex((i) => matchesFile(i, state.host, file));
}

// --- writers -------------------------------------------------------------

// feed view: #host[#file]
export function writeFeedHash(file) {
  const want = "#" + encodeURIComponent(state.host)
    + (file ? "#" + encodeURIComponent(file) : "");
  if (location.hash !== want) history.replaceState(history.state, "", want);
}

// user-driven change of the current image while browsing the feed
export function browseToFile(file) {
  if (parseUrl().file === file) return;
  writeFeedHash(file);
}
