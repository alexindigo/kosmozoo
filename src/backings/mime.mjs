// One media registry, shared by engine and browser. Classification is separate
// from feed admission: a kind joins RENDERABLE only when its UI is available.
export const MEDIA = Object.freeze(Object.fromEntries(Object.entries({
  png: ["image/png", "image"], jpg: ["image/jpeg", "image"], jpeg: ["image/jpeg", "image"],
  webp: ["image/webp", "image"], gif: ["image/gif", "image"], svg: ["image/svg+xml", "image"],
  avif: ["image/avif", "image"], bmp: ["image/bmp", "image"],
  mp4: ["video/mp4", "video"], mov: ["video/quicktime", "video"], webm: ["video/webm", "video"],
  flac: ["audio/flac", "audio"], mp3: ["audio/mpeg", "audio"],
  opus: ["audio/ogg", "audio"], wav: ["audio/wav", "audio"],
}).map(([ext, [mime, kind]]) => [ext, Object.freeze({ mime, kind })])));

export const mediaExtension = name => String(name ?? "").split(".").pop().toLowerCase();
export const mediaKind = name => Object.hasOwn(MEDIA, mediaExtension(name)) ? MEDIA[mediaExtension(name)].kind : null;
export const IMAGE_EXTENSIONS = new Set(Object.keys(MEDIA).filter(ext => MEDIA[ext].kind === "image"));
export const RENDERABLE = new Set(Object.keys(MEDIA).filter(ext => MEDIA[ext].kind !== "audio"));

export const EXT_MIME = Object.freeze(Object.fromEntries(Object.entries(MEDIA).map(([ext, { mime }]) => [ext, mime])));
