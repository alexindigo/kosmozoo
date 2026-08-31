// client/js/feedview.mjs — the feed's view walk, framework-free.
//
// viewStep: direction-aware stepping within the view (image-indexed). The
// caller owns the scroll side effect (the store centers the feed on the
// returned index). prefetchFrom: direction-aware bytes prefetch for the
// workbench's neighbors, bounded at the edges, fetch-seam injectable.

import { api } from "./api.mjs";

export function viewStep(view, imgIdx, dir) {
  if (!view.length) return imgIdx;
  const pos = view.indexOf(imgIdx);
  let n;
  if (pos >= 0) {
    n = pos + dir;
  } else {
    // current image not in the view (filtered/hidden): it sits AT the
    // insertion point — a forward step lands on the next entry as-is
    const ins = view.findIndex((v) => v > imgIdx);
    const at = ins < 0 ? view.length : ins;
    n = at + (dir > 0 ? 0 : -1);
  }
  if (n < 0 || n >= view.length) return imgIdx;
  return view[n];
}

export function prefetchFrom(images, imgIdx, dir, fetcher = globalThis.fetch) {
  for (let i = 1; i <= 4; i++) {
    const idx = imgIdx + dir * i;
    if (idx < 0 || idx >= images.length) break;
    fetcher(api.imageBytesUrl(images[idx].id)).then((r) => r.arrayBuffer()).catch(() => {});
  }
}
