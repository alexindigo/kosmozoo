// src/collections.mjs — collection capabilities.
//
// ONE function answers "what can this collection do" for every consumer
// (GET /api/collections, DELETE entry, the client's delete affordance) —
// the deleteMode double-derivation (audit E2) dies here.
//
// Derived from the backing kind (+ the assets-plus probe for comfy):
//   folder          → unlink (permanent)
//   comfy + trash   → trash (recoverable via the assets_plus extension)
//   comfy otherwise → hide (kosmozoo-side flag; ComfyUI has no delete API)

import { hostHasAssetsPlus, isFolderHost } from "./hosts.mjs";

export async function capabilities(collection, { online = true, useAssetsPlus = true } = {}) {
  const kind = collection.kind ?? (isFolderHost(collection.address) ? "folder" : "comfy");
  if (kind === "folder") {
    return { list: true, read: true, add: false, delete: "unlink", rename: false };
  }
  const trash = online && useAssetsPlus && await hostHasAssetsPlus(collection.address);
  return {
    list: true,
    read: true,
    add: true, // the upload endpoint exists (an offline host fails at POST time)
    delete: trash ? "trash" : "hide",
    rename: false,
  };
}
