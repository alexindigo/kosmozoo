// Picked-image rotation. A rotation is a quarter-turn count over the ORIGINAL
// bytes, so turns compose without re-encoding an earlier result. Composition and
// naming are environment-pure; encoding uses the browser's decoder and canvas.
export const ROTATION_DIRECTIONS = Object.freeze(["cw", "ccw"]);

export function composeRotation(degrees, direction) {
  if (![0, 90, 180, 270].includes(degrees) || !ROTATION_DIRECTIONS.includes(direction)) throw new Error("Invalid rotation");
  return (degrees + (direction === "cw" ? 90 : 270)) % 360;
}

export function rotatedName(name, degrees) {
  if (![90, 180, 270].includes(degrees)) throw new Error("Invalid rotation");
  const leaf = String(name).split("/").at(-1), stem = leaf.replace(/\.[^.]*$/, "");
  return `${stem || leaf}_r${degrees}.png`;
}

// Exact integer matrices map every source pixel onto one destination pixel.
const MATRICES = { 90: (w, h) => [0, 1, -1, 0, h, 0], 180: (w, h) => [-1, 0, 0, -1, w, h], 270: (w) => [0, -1, 1, 0, 0, w] };

export async function rotateImageFile(blob, degrees, name) {
  if (!MATRICES[degrees]) throw new Error("Invalid rotation");
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  try {
    const { width, height } = bitmap, canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = degrees === 180 ? [width, height] : [height, width];
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = false;
    context.setTransform(...MATRICES[degrees](width, height));
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise((resolve, reject) =>
      canvas.toBlob(result => result ? resolve(result) : reject(new Error("PNG encoding failed")), "image/png"));
    return new File([png], name, { type: "image/png" });
  } finally { bitmap.close(); }
}
