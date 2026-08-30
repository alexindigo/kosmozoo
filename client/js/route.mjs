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
import {
  parseUrl,
  parseDiffHash,
  diffUrl,
  stripHostPrefix,
  matchesFile,
} from "./route-parse.mjs";

// pure parsers live in route-parse.mjs (state-free; the Solid store imports
// them there) — re-exported so existing import sites stay unchanged
export { parseUrl, parseDiffHash, diffUrl, stripHostPrefix, matchesFile };

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
