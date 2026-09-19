// client/js/route-parse.mjs — the pure half of the URL grammar (no state, no
// api): parsing /#<remote>[#<image>] and /diff#..., building diff URLs, and
// the host-prefix stripping shared by hash mirror and feed matching. The
// stateful writers (setCurrent, mirrorCurrentHash, findByFile, resolveSide)
// live in the app store; this module is the pure grammar only.

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

export function stripHostPrefix(host, filename) {
  const pfx = host + "#";
  return filename.startsWith(pfx) ? filename.slice(pfx.length) : filename;
}

// deep links carry the stripped name; the feed may hold either form
export function matchesFile(image, host, file) {
  return image.filename === file || image.filename === host + "#" + file;
}

// Where the current pointer goes when the current image is deleted:
// 1. the previous current (stack top) — iff it sits NEXT TO the deleted
// one in the feed and survives the delete itself
// 2. else the nearest surviving image above the deleted one in the feed
// 3. else (the deleted image had nothing above it) the new topmost;
// nothing left at all → clear
// images is the PRE-delete list. Returns { kind: "pop" } | { kind: "set",
// image } | { kind: "clear" } | null (the current image was not deleted).
export function planDeleteCurrent(images, deletedFiles, host, current, prev) {
  if (!current || current.remote !== host) return null;
  const sameFile = (img, f) => matchesFile(img, host, f);
  const delIdx = images.findIndex((img) => sameFile(img, current.image));
  if (delIdx < 0 || !deletedFiles.has(images[delIdx].filename)) return null;
  if (prev && prev.remote === host) {
    const pIdx = images.findIndex((img) => sameFile(img, prev.image));
    if (pIdx >= 0 && !deletedFiles.has(images[pIdx].filename) && Math.abs(pIdx - delIdx) === 1) {
      return { kind: "pop" };
    }
  }
  for (let i = delIdx - 1; i >= 0; i--) {
    if (!deletedFiles.has(images[i].filename)) return { kind: "set", image: images[i].filename };
  }
  const top = images.find((img) => !deletedFiles.has(img.filename));
  return top ? { kind: "set", image: top.filename } : { kind: "clear" };
}
