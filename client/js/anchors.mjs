// client/js/anchors.mjs — the anchors pane: local drops, never uploaded.
//
// Anchors are local files dropped by the user. Bytes stay in the browser as
// blob URLs — never uploaded except to a detector plugin the user configured
// (Phase 13; absent by default). Metadata is extracted in-browser by the
// SHARED extractor module (the mirror is dead).

import { S, render } from "./state.mjs";
import { metaFromPngBytes } from "/shared/extractor.mjs";

export async function addAnchorFiles(files) {
  for (const file of files) {
    const src = URL.createObjectURL(file);
    let meta = null;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      [meta] = await metaFromPngBytes(buf);
    } catch { /* unreadable PNG — anchor still usable visually */ }
    S.anchors.push({ name: file.name, src, meta });
  }
  render();
}

export function removeAnchor(name) {
  const i = S.anchors.findIndex((a) => a.name === name);
  if (i >= 0) {
    URL.revokeObjectURL(S.anchors[i].src);
    S.anchors.splice(i, 1);
    render();
  }
}
