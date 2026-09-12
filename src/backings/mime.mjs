// src/backings/mime.mjs — image extension registries shared by the backings.
// RENDERABLE: what the feed lists. EXT_MIME: extension → Content-Type for
// serving (upstream octet-stream is remapped to these).

export const RENDERABLE = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"]);

export const EXT_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp",
};
