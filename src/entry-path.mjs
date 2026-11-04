// Output-root-relative POSIX addresses shared by engine and browser. Never
// normalize an invalid address into another entry's identity or decode it here.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_ENTRY_PATH_CHARS = 4096;
const MAX_ENTRY_PATH_COMPONENTS = 128;
const MAX_INVENTORY_FOLDER_CHARS = 16 * 1024 * 1024;

export function isEntryPath(name) {
  return typeof name === "string" && name.length > 0 && name.length <= MAX_ENTRY_PATH_CHARS && !CONTROL.test(name) &&
    !name.includes("\\") && !/^[a-z]:\//i.test(name) &&
    validComponents(name);
}

function validComponents(name) {
  const parts = name.split("/");
  return parts.length <= MAX_ENTRY_PATH_COMPONENTS && parts.every(part => part !== "" && part !== "." && part !== "..");
}

export const isFolderPath = (folder) => folder === "" || isEntryPath(folder);

// The flat local backing retains its POSIX basename grammar. Backslashes and
// drive-looking text are ordinary local leaf characters, not Comfy paths.
export function isEntryName(kind, name) {
  return kind === "folder"
    ? typeof name === "string" && name.length > 0 && !name.includes("/") && !name.includes("..") && !name.includes("\0")
    : isEntryPath(name);
}

export function splitEntryPath(name) {
  if (!isEntryPath(name)) throw new TypeError("bad entry path");
  const slash = name.lastIndexOf("/");
  return { filename: name.slice(slash + 1), subfolder: slash < 0 ? "" : name.slice(0, slash) };
}

export function folderAncestors(name) {
  const { subfolder } = splitEntryPath(name);
  if (!subfolder) return [];
  const ancestors = [];
  for (let at = subfolder.indexOf("/"); at >= 0; at = subfolder.indexOf("/", at + 1)) ancestors.push(subfolder.slice(0, at));
  ancestors.push(subfolder);
  return ancestors;
}

export function inventoryFolders(items) {
  const folders = new Set([""]);
  let retained = 0;
  for (const { name } of items) for (const folder of folderAncestors(name)) {
    if (folders.has(folder)) continue;
    if (folder.length > MAX_INVENTORY_FOLDER_CHARS - retained) throw new RangeError("Inventory folder string budget exceeded");
    retained += folder.length;
    folders.add(folder);
  }
  return [...folders].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export const inFolder = (name, folder) => folder === "" || name.startsWith(folder + "/");
