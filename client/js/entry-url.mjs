import { RESOURCE_ROOTS, isResourceRoot } from "/shared/parameters.mjs";
// Raw collection/entry identities become request paths exactly once here.
// Listing/widget annotations belong to their ingress codecs, not this transport.
export const collectionEntriesUrl = collection => `/api/collections/${encodeURIComponent(collection)}/entries`;
// Viewer side sources: "<collection>" (output root), "input:<collection>" or
// "temp:<collection>" (referenced roots), or "anchor". This codec alone builds
// and reads that grammar; existing output/input spellings and URLs are unchanged.
export const resourceSource = (collection, root = "output") => {
  if (!isResourceRoot(root)) throw new TypeError(`unknown resource root: ${root}`);
  return root === "output" ? collection : `${root}:${collection}`;
};
export function parseResourceSource(source) {
  if (typeof source !== "string" || !source) return null;
  if (source === "anchor") return { collection: null, root: null, anchor: true };
  for (const root of RESOURCE_ROOTS) if (root !== "output" && source.startsWith(root + ":")) return { collection: source.slice(root.length + 1), root, anchor: false };
  return { collection: source, root: "output", anchor: false };
}
export const entryUrl = (collection, name) => `${collectionEntriesUrl(collection)}/${encodeURIComponent(name)}`;
export function entryBytesUrl(collection, name, { kind = "output", origin } = {}) {
  if (!isResourceRoot(kind)) throw new TypeError(`unknown resource root: ${kind}`);
  const query = new URLSearchParams();
  if (kind !== "output") query.set("kind", kind);
  if (origin) query.set("origin", JSON.stringify(origin));
  return `${entryUrl(collection, name)}/bytes${query.size ? "?" + query : ""}`;
}
