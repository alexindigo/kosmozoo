// client/js/route.mjs — the URL hash is the source of truth for the
// current image; S.currentFile is its in-memory mirror, never the reverse.
//
//   /#<host>            current host selection
//   /#<host>#<filename> host + current image (filename stripped of any
//                       "<host>#" save prefix — the hash carries the host)
//
// One reader (parseHash, applied at boot / hashchange / after refetch) and
// one writer (syncRoute). Internal events (refresh, votes, reloads) never
// invent a current image: they re-center from what the URL already says.

import { S } from "./state.mjs";

export function parseHash() {
  const h = (typeof location === "undefined" ? "" : location.hash).replace(/^#/, "");
  if (!h) return null;
  const [host, file] = h.split("#");
  return {
    host: host ? decodeURIComponent(host) : null,
    filename: file ? decodeURIComponent(file) : null,
  };
}

// saves may land as "<host>#<name>" — the hash already carries the host,
// so never write host#host#name (mirror of card.mjs hostPrefixed)
export function stripHostPrefix(host, filename) {
  const pfx = host + "#";
  return filename.startsWith(pfx) ? filename.slice(pfx.length) : filename;
}

// deep links carry the stripped name; the feed may hold either form
export function matchesFile(image, host, file) {
  return image.filename === file || image.filename === host + "#" + file;
}

export function findByFile(file) {
  if (!file) return -1;
  return S.images.findIndex((i) => matchesFile(i, S.host, file));
}

// the image the details space shows: lightbox image while open, else the
// URL's current file resolved against the list (hidden images included —
// the URL outranks visibility)
export function detailsImage() {
  if (S.lightbox.open) {
    if (S.lightbox.col === "candidate") return S.images[S.lightbox.index] ?? null;
    return S.anchors[S.lightbox.anchorIndex ?? 0] ?? null;
  }
  const idx = findByFile(S.currentFile);
  return idx >= 0 ? S.images[idx] : null;
}

// the only hash writer. Reflects user-driven state (scroll, lightbox nav);
// never called to "fix up" the URL after internal events.
export function syncRoute() {
  if (typeof location === "undefined" || !S.host) return;
  let file = S.currentFile;
  if (S.lightbox.open) {
    // anchors have no host#filename address; candidates follow the nav
    const img = S.lightbox.col === "candidate" ? S.images[S.lightbox.index] : null;
    file = img ? stripHostPrefix(S.host, img.filename) : null;
  }
  const want = "#" + encodeURIComponent(S.host)
    + (file ? "#" + encodeURIComponent(file) : "");
  if (location.hash !== want) history.replaceState(null, "", want);
}

// user-driven change of the current image (scroll, deep link): mirror + URL
export function setCurrentFile(file) {
  if (file === S.currentFile) return;
  S.currentFile = file;
  syncRoute();
}
