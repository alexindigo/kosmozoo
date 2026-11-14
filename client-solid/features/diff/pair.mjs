// client-solid/features/diff/pair.mjs — the comparator's pair derivation,
// pure. The pair is always FEED CURRENT × RIGHT-PANE CURRENT; the right
// side follows the active workspace space (anchors, or the info panel's
// node images). No B (info pane showing, no node images) → single-image.
//
// side: { source, file } — resolveSide's grammar (entry-url.mjs's
// resourceSource codec: "anchor", "input:<host>", "temp:<host>" or a host name). Resolution to { src, … } is the store's job; this module
// only decides WHICH sides the pair has.

import { resourceSource } from "/js/api.mjs";

// A node image's side source: its explicit root (fromOutput is the legacy facade).
const imageSource = (im, host) => im.source ?? resourceSource(host, im.root ?? (im.fromOutput ? "output" : "input"));

export function pairSides({ current, workspace, anchors, anchorName, nodeImages, infoFile, infoSource, host }) {
  const a = current?.image ? { source: current.remote, file: current.image } : null;
  let b = null;
  if (workspace === "anchors") {
    const pick = anchorName ?? anchors?.[0]?.name ?? null;
    if (pick) b = { source: "anchor", file: pick };
  } else if (workspace === "details") {
    const imgs = nodeImages ?? [];
    if (infoFile) {
      // A node image of the current graph is addressed by root + file: a
      // same-named input/output/temp image is a different resource. A legacy
      // selection without a source keeps the first same-name image.
      const hit = imgs.find((im) => im.file === infoFile && (infoSource == null || imageSource(im, host) === infoSource));
      // not a node image — a /diff-URL right side; its source rode along
      b = hit ? { source: imageSource(hit, host), file: infoFile } : { source: infoSource ?? resourceSource(host, "input"), file: infoFile };
    } else if (imgs[0]) {
      b = { source: imageSource(imgs[0], host), file: imgs[0].file };
    }
  }
  return { a, b };
}
