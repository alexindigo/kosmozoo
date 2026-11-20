// Engine-host image acquisition, independent of the browser and source backing.
import { basename, resolve } from "node:path";
import { IMAGE_EXTENSIONS, mediaExtension, EXT_MIME } from "../../backings/mime.mjs";
import { variationProblem, problemError } from "./problems.mjs";

export const MAX_FOLDER_IMAGES = 500;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const problem = (code, context, status = 400) => Object.assign(problemError(variationProblem(code, { phase: "acquisition", ...context })), { status });
const statusOf = error => error instanceof Deno.errors.NotFound ? 404 : error instanceof Deno.errors.PermissionDenied ? 403 : error?.status ?? 400;
const reason = error => error instanceof Deno.errors.NotFound ? "not found" : error instanceof Deno.errors.PermissionDenied ? "permission denied" : String(error?.message ?? error);
const absolute = path => {
  if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) throw fail("Enter an absolute folder or image path on the engine host");
  return resolve(path);
};

export async function listImages(path, limit = MAX_FOLDER_IMAGES) {
  const requested = absolute(path);
  let root, info;
  try { root = await Deno.realPath(requested); info = await Deno.stat(root); }
  catch (error) { throw problem("folder-read", { path: requested, failed: requested, detail: reason(error) }, statusOf(error)); }
  if (!info.isDirectory) throw problem("folder-not-directory", { path: root });
  const items = [], directories = [root], skipped = { links: 0, other: 0 };
  while (directories.length) {
    const directory = directories.pop(), entries = [];
    // A failing nested directory names itself; the import stays all-or-nothing.
    try { for await (const entry of Deno.readDir(directory)) entries.push(entry); }
    catch (error) { throw problem("folder-read", { path: root, failed: directory, detail: reason(error) }, statusOf(error)); }
    for (const entry of entries) {
      if (entry.isSymlink) { skipped.links++; continue; }
      const path = `${directory === "/" ? "" : directory}/${entry.name}`;
      if (entry.isDirectory) directories.push(path);
      else if (entry.isFile && IMAGE_EXTENSIONS.has(mediaExtension(entry.name))) {
        items.push({ kind: "server-path", name: entry.name, path });
        if (items.length > limit) throw fail(`This folder contains more than ${limit} images. Choose a smaller folder.`, 413);
      } else skipped.other++;
    }
  }
  items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { path: root, items, limit, skipped };
}

export async function readImage(path) {
  const canonical = absolute(path), name = basename(canonical);
  if (!IMAGE_EXTENSIONS.has(mediaExtension(name))) throw problem("folder-image", { resource: canonical, detail: "The path must name an image; its extension is not a supported image type" });
  // Opening and inspecting the descriptor avoids a stat/read replacement race.
  let file;
  try { file = await Deno.open(canonical, { read: true }); }
  catch (error) { throw problem("folder-image", { resource: canonical, detail: `it cannot be opened (${reason(error)})` }, statusOf(error)); }
  try {
    if (!(await Deno.lstat(canonical)).isFile || !(await file.stat()).isFile) throw problem("folder-image", { resource: canonical, detail: "The image must be a regular file, not a link, folder or device" });
    return { name, bytes: new Uint8Array(await new Response(file.readable).arrayBuffer()), mime: EXT_MIME[mediaExtension(name)] };
  } finally { try { file.close(); } catch (error) { if (!(error instanceof Deno.errors.BadResource)) throw error; } }
}

export const folderError = error => Response.json({ error: error.message, ...(error.problem ? { problem: error.problem } : {}) }, { status: error.status ?? (error instanceof Deno.errors.NotFound ? 404 : error instanceof Deno.errors.PermissionDenied ? 403 : 400) });
