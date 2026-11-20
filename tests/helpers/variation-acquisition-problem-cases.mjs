const base = { phase: "acquisition", target: { index: 0, source: "fake", name: "b.png" }, source: "other", root: "input", parameter: { id: "n.steps", label: "Image" }, resource: "picked.png" };
export const acquisitionProblemCases = [
  [190, "image-changed", {}, "picked.png for Image changed after comparison or lacks a verified comparison. It was not uploaded.", "field"],
  [191, "comparison-current", { current: "old.png", numbers: { status: 404 } }, "Cannot compare picked.png for Image: current image old.png on other/input is unavailable (HTTP 404).", "field"],
  [192, "comparison-existing", { current: "picked (1).png", numbers: { status: 503 } }, "Cannot verify picked.png: existing input picked (1).png on other could not be read (HTTP 503). No upload was authorized by this check.", "field"],
  [193, "comparison-request", { field: "current reference" }, "Cannot compare picked.png for Image: invalid current reference. No file was uploaded by comparison.", "field"],
  [194, "comparison-reply", { field: "hash/collision list" }, "picked.png, Image: comparison reply has no valid hash/collision list. Run cannot use unverified bytes.", "field"],
  [202, "source-list", { detail: "HTTP 502" }, "Cannot list other's imported images: HTTP 502. Previously loaded images remain.", "field"],
  [203, "source-list-shape", { root: "output", detail: "root mismatch" }, "Cannot use other's generated catalogue: root mismatch. Your chosen image set is unchanged.", "field"],
  [206, "acquisition-read", { detail: "HTTP 404" }, "Cannot add picked.png from other/input: HTTP 404. It was not added to Image.", "field"],
  [208, "preview-failed", { source: "saved archive" }, "Preview for picked.png could not load from saved archive. This alone does not prove the Run failed.", "field"],
  [211, "picker-selection", { numbers: { visible: 1, total: 4 } }, "1 selected in listing; 4 in image set.", "field"],
  [212, "drop-skipped", { names: ["bad.txt"], numbers: { added: 2, skipped: 1, folders: 1 } }, "Image: added 2 images; skipped 1 unsupported files (bad.txt); 1 folders were not imported. Supported: PNG, JPEG, WebP, GIF, AVIF, BMP.", "field"],
].map(([row, code, context, message, location]) => ({ row, code, context: { ...base, ...context }, message, location }));
