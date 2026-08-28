// client/js/route.mjs — the current image lives in state.current; the URL
// MIRRORS it.
//
//   state.current = { remote, image }
//     remote — a configured host/folder name, or "anchor"
//     image  — the filename (or anchor name)
//
// state.current is the single source of truth (the "current image" pointer).
// The URL hash mirrors it for shareable deep-links:
//   /#<remote>          current remote selection
//   /#<remote>#<image>  remote + current image
// Anchors are not feed URLs, so a current anchor is NOT mirrored to the hash.
// Files in the hash are stripped of any "<remote>#" save prefix (the hash
// already carries the remote — mirror of card.mjs hostPrefixed).

import { state } from "./state.mjs";
import { api } from "./api.mjs";

export function parseUrl() {
  if (typeof location === "undefined") return { view: "feed", host: null, file: null };
  if (location.pathname === "/diff") {
    return { view: "diff", ...parseDiffHash(location.hash.replace(/^#/, "")) };
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

// /diff#<srcL>#<fileL>:<srcR>#<fileR> — the pair view is gone (the workbench
// is a single-image viewer now), but the grammar is kept so /diff deep links
// still resolve (they open the workbench on the left side) and the pure
// parsers stay unit-testable.
export function parseDiffHash(h) {
  const [ls, rs] = h.split(":");
  return { left: parseSide(ls), right: parseSide(rs) };
}

function parseSide(side) {
  if (!side) return null;
  const i = side.indexOf("#");
  if (i < 0) return null;
  const source = side.slice(0, i);
  const file = decodeURIComponent(side.slice(i + 1));
  return source && file ? { source, file } : null;
}

export function diffUrl(left, right) {
  return "/diff#" + left.source + "#" + encodeURIComponent(left.file)
    + ":" + right.source + "#" + encodeURIComponent(right.file);
}

// one resolver for every source kind; new feeds plug in here. Accepts either
// a {source,file} side or a state.current {remote,image}.
export function resolveSide(side) {
  if (!side) return null;
  const source = side.source ?? side.remote;
  const file = side.file ?? side.image;
  if (source === "anchor") {
    const a = state.anchors.find((x) => x.name === file);
    return a ? { name: a.name, src: a.src, meta: a.meta ?? null } : null;
  }
  // input-dir images (node references from the info panel): remote carries
  // the source as "input:<host>"
  if (source.startsWith("input:")) {
    const host = source.slice("input:".length);
    if (!state.hosts[host]) return null;
    return {
      name: file,
      host,
      src: `/api/input-bytes/${encodeURIComponent(host)}/${encodeURIComponent(file)}`,
      meta: null,
    };
  }
  if (state.hosts[source]) {
    return {
      name: file,
      host: source,
      src: api.imageBytesUrl(`${source}:${file}`),
      meta: null,
    };
  }
  return null;
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

// Set the single "current image" pointer, then mirror it to the URL hash.
export function setCurrent(remote, image) {
  state.current = { remote, image };
  mirrorCurrentHash();
}

// Mirror state.current to the URL hash (replaceState → no hashchange loop).
// Anchors are not feed URLs, so they are not mirrored.
export function mirrorCurrentHash() {
  const c = state.current;
  if (!c || c.remote === "anchor") return;
  const file = c.image ? stripHostPrefix(c.remote, c.image) : null;
  const want = "#" + encodeURIComponent(c.remote)
    + (file ? "#" + encodeURIComponent(file) : "");
  if (location.hash !== want) history.replaceState(history.state, "", want);
}
