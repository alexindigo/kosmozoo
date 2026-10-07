// Coherent transport fixture for existing client tests whose controlled entry
// producers predate the additive inventory API. Delays/judgments stay owned by
// those producers; this adapter supplies the new wire envelope only.
import { inventoryFolders } from "../../src/entry-path.mjs";

export function clientInventory(entries, { coverage = "root-only", folders = coverage === "recursive" ? inventoryFolders(entries) : [""], revision = "fixture:1" } = {}) {
  return { revision, coverage, folders, entries,
    subfolders: { supported: coverage === "recursive", reason: coverage === "recursive" ? null : "Flat fixture inventory" } };
}
