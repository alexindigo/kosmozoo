// The shared domain owner for deleting one output entry. HTTP and bulk
// callers receive the same capability, backing result and local effects.
import { backingFor as defaultBackingFor, isFolderHost } from "./backings/index.mjs";
import { capabilities } from "./collections.mjs";

export async function entryDeleteCapability(ctx, id) {
  const address = Object.hasOwn(ctx.hosts, id) ? ctx.hosts[id] : null;
  if (!address) return null;
  const backing = (ctx.backings?.backingFor ?? defaultBackingFor)(address);
  const collection = ctx.store.collectionGet(id) ?? { id, kind: isFolderHost(address) ? "folder" : "comfy", address };
  const caps = await capabilities(collection, {
    online: await backing.probe(address),
    useAssetsPlus: ctx.settings.get("core.delete", "useAssetsPlus", true),
    comfy: ctx.comfy?.(id) ?? null,
  });
  return { address, backing, capability: caps.delete };
}

export async function deleteEntry(ctx, id, name, { guard, ownsSource = () => true } = {}) {
  const target = await entryDeleteCapability(ctx, id);
  if (!target) return { status: 404, body: { error: "unknown collection" } };
  // Bulk admission rechecks live judgment/source ownership after the capability
  // probe, immediately before the first effect, not before an asynchronous gap.
  const reason = guard?.();
  if (reason) return { status: 409, body: { skipped: true, error: reason } };
  const { address, backing, capability } = target;
  if (capability === "unlink" || capability === "trash") {
    const result = await backing.remove(address, name);
    if (!result.ok) return { status: 409, body: { error: result.detail } };
    if (ownsSource()) ctx.store.arrivals.remove(id, name);
    return { status: 200, body: { deleted: true, mode: result.mode } };
  }
  ctx.store.entryHide(id, name);
  const historyCleared = (await backing.historyDelete?.(address, name)) ?? false;
  return { status: 200, body: { deleted: true, mode: "hide", historyCleared } };
}
