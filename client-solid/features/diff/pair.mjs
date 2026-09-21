// client-solid/features/diff/pair.mjs — the comparator's pair derivation,
// pure. The pair is always FEED CURRENT × RIGHT-PANE CURRENT; the right
// side follows the active workspace space (anchors, or the info panel's
// node images). No B (info pane showing, no node images) → single-image.
//
// side: { source, file } — resolveSide's grammar ("anchor", "input:<host>",
// or a host name). Resolution to { src, … } is the store's job; this module
// only decides WHICH sides the pair has.

export function pairSides({ current, workspace, anchors, anchorName, nodeImages, infoFile, infoSource, host }) {
  const a = current?.image ? { source: current.remote, file: current.image } : null;
  let b = null;
  if (workspace === "anchors") {
    const pick = anchorName ?? anchors?.[0]?.name ?? null;
    if (pick) b = { source: "anchor", file: pick };
  } else {
    const imgs = nodeImages ?? [];
    if (infoFile) {
      const hit = imgs.find((im) => im.file === infoFile);
      if (hit) {
        // a node image of the current graph: input-dir bytes, or output
        // bytes when the graph pulled it from the output dir
        b = { source: hit.fromOutput ? host : `input:${host}`, file: infoFile };
      } else {
        // not a node image — a /diff-URL right side; its source rode along
        b = { source: infoSource ?? `input:${host}`, file: infoFile };
      }
    } else if (imgs[0]) {
      b = { source: imgs[0].fromOutput ? host : `input:${host}`, file: imgs[0].file };
    }
  }
  return { a, b };
}
