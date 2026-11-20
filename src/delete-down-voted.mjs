// Engine-owned selection and sequential execution over the shared entry writer.
import { deleteEntry, entryDeleteCapability } from "./entry-delete.mjs";

const eligible = row => row?.vote === "down" && !row.favorite && !row.bookmark && row.state !== "gone" && !row.hidden;
export function downVotedNames(items, rows) {
  const byName = new Map(rows.map(row => [row.name, row]));
  return items.filter(item => eligible(byName.get(item.name))).map(item => item.name);
}

export async function deleteDownVoted(ctx, id, { preview = false, names = [] } = {}) {
  const token = ctx.inventory.capture(id);
  const current = () => !ctx.signal?.aborted && ctx.sourceActivity.acceptingChanges() && ctx.inventory.isCurrent(token);
  if (!current()) return { status: 503, body: { error: "Sources are stopping or source changed" } };
  const target = await entryDeleteCapability(ctx, id);
  if (!target) return { status: 404, body: { error: "unknown collection" } };
  let inventory;
  try { inventory = await ctx.inventory(id); }
  catch (error) { return { status: 502, body: { error: `collection unreachable: ${error.message}` } }; }
  if (!current()) return { status: 412, body: { error: "Source origin changed" } };
  inventory = ctx.inventory.accepted?.(token) ?? inventory;
  const selected = downVotedNames(inventory.items, ctx.store.entriesForCollection(id));
  if (preview) return { status: 200, body: { count: selected.length, names: selected, capability: target.capability } };
  const listed = new Set(selected), deleted = [], skipped = [], failed = [];
  for (const name of new Set(names)) {
    const guard = () => !current() ? "Source changed or stopped" :
      !listed.has(name) || !eligible(ctx.store.entryGet(id, name)) ? "No longer an unprotected down-voted entry" : null;
    const reason = guard();
    if (reason) { skipped.push({ name, reason }); continue; }
    try {
      const result = await deleteEntry(ctx, id, name, { guard, ownsSource: current });
      if (result.body.skipped) skipped.push({ name, reason: result.body.error });
      else if (result.status === 200) deleted.push(name);
      else failed.push({ name, error: result.body.error });
    } catch (error) { failed.push({ name, error: error.message }); }
  }
  return { status: 200, body: { deleted, skipped, failed } };
}
