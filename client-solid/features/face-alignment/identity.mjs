// A named resource and its immutable content are separate identities. Equal
// bytes at different addresses/kinds never share face choices.
export const faceAddress = resource => JSON.stringify([resource.source, resource.collection,
  resource.kind, resource.name, resource.stamp, resource.source === "anchor" ? resource.src : null]);
export const faceContent = (resource, hash) => JSON.stringify([faceAddress(resource), hash ?? null]);
