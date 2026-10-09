// Source identity is operation ownership, not attributes or authentication.
const keys = ["source", "address", "kind", "epoch", "incarnation"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function validOrigin(value) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) &&
    ["source", "address", "epoch", "incarnation"].every(key => typeof value[key] === "string" && value[key].length > 0) &&
    ["folder", "comfy"].includes(value.kind);
}
export function sourceOrigin(source, record) {
  const value = { source, address: record?.address, kind: record?.kind,
    epoch: record?.sourceVersion?.epoch, incarnation: record?.incarnation };
  return validOrigin(value) && record.sourceVersion.incarnation === value.incarnation ? Object.freeze(value) : null;
}
export function sameOrigin(a, b) {
  return validOrigin(a) && validOrigin(b) && keys.every(key => a[key] === b[key]);
}
export function validContext(value) {
  return object(value) && Object.keys(value).length === 2 && validOrigin(value.origin) &&
    typeof value.graphHash === "string" && /^[0-9a-f]{64}$/.test(value.graphHash);
}
export function sameContext(a, b) {
  return validContext(a) && validContext(b) && sameOrigin(a.origin, b.origin) && a.graphHash === b.graphHash;
}
export function expectedOrigin(request) {
  const raw = request.headers.get("X-Kosmozoo-Origin");
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid expected source origin"); }
  if (!validOrigin(value)) throw new Error("Invalid expected source origin");
  return value;
}
