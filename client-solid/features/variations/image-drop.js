// Native drag resources stay opaque. Classification is shared with Add files;
// directories are reported, never enumerated or treated as zero-byte images.
export const isFileDrag = transfer => !!transfer && ([...transfer.types].includes("Files") ||
  [...(transfer.items ?? [])].some(item => item.kind === "file"));

export function droppedFiles(transfer) {
  const files = []; let folders = 0;
  const items = [...(transfer.items ?? [])].filter(item => item.kind === "file");
  if (!items.length) return { files: [...(transfer.files ?? [])], folders };
  for (const item of items) {
    if (item.webkitGetAsEntry?.()?.isDirectory) { folders++; continue; }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { files, folders };
}

export function classifyImageFiles({ files, folders = 0 }, accepts) {
  const images = files.filter(file => accepts(file.name)), skipped = files.length - images.length;
  return { images, status: [skipped ? `${skipped} ${skipped === 1 ? "file" : "files"} skipped — not images` : "",
    folders ? "Folders: use Add folder" : ""].filter(Boolean).join(" · ") };
}

// Both pointer reorder and native insertion use untransformed tile centres.
export function nearestImageTile(tiles, x, y) {
  let nearest = -1, distance = Infinity;
  tiles.forEach((tile, index) => {
    const next = Math.hypot(tile.x + tile.width / 2 - x, tile.y + tile.height / 2 - y);
    if (next < distance) { nearest = index; distance = next; }
  });
  return nearest;
}

export function imageInsertIndex(tiles, x, y) {
  const nearest = nearestImageTile(tiles, x, y);
  if (nearest < 0) return 0;
  const tile = tiles[nearest], last = tiles.at(-1);
  if (y >= last.y + last.height || y >= last.y && x >= last.x + last.width) return tiles.length;
  return nearest + (x >= tile.x + tile.width / 2 ? 1 : 0);
}
