import { validEntryName } from "../../backings/index.mjs";
import { uploadFamily } from "./shared.mjs";
import { sha256 } from "../../cache.mjs";
import { isResourceRoot } from "../../parameters.mjs";

// Both native browser Files and engine-host files use the same input-cache/hash
// owner and collision-family contract. No comparison uploads to the source.
export async function inspectImage(app, token, host, { name, bytes, current, kind, names = [] }, origin) {
  if (!validEntryName(token.address, current) || !isResourceRoot(kind) || !Array.isArray(names) ||
      names.some(name => typeof name !== "string" || !validEntryName(token.address, name))) return Response.json({ error: "Invalid current image or input names" }, { status: 400 });
  const stale = () => !app.backings.isCurrent(token);
  const retired = () => Response.json({ error: "Source origin changed" }, { status: 412 });
  if (stale()) return retired();
  const currentBytes = await app.ingest.ensure(host, current, kind, { priority: "high" });
  if (currentBytes.status !== 200) return Response.json({ error: "Current image bytes unavailable; cannot compare" }, { status: 422 });
  const hash = await sha256(bytes), existing = [];
  for (const candidateName of new Set(uploadFamily(name, names))) {
    if (stale()) return retired();
    const candidate = candidateName === current && kind === "input" ? currentBytes : await app.ingest.ensure(host, candidateName, "input", { priority: "high" });
    if (candidate.status === 200) existing.push({ name: candidateName, hash: candidate.hash });
    else if (candidate.status !== 404) return Response.json({ error: "Existing input bytes unavailable; cannot compare" }, { status: 422 });
  }
  if (stale()) return retired();
  return Response.json({ hash, currentHash: currentBytes.hash, existing, origin });
}
