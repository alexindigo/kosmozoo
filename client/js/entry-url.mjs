// Raw collection/entry identities become request paths exactly once here.
// Listing/widget annotations belong to their ingress codecs, not this transport.
export const collectionEntriesUrl = collection => `/api/collections/${encodeURIComponent(collection)}/entries`;
export const entryUrl = (collection, name) => `${collectionEntriesUrl(collection)}/${encodeURIComponent(name)}`;
export function entryBytesUrl(collection, name, { kind = "output", origin } = {}) {
  const query = new URLSearchParams();
  if (kind !== "output") query.set("kind", kind);
  if (origin) query.set("origin", JSON.stringify(origin));
  return `${entryUrl(collection, name)}/bytes${query.size ? "?" + query : ""}`;
}
