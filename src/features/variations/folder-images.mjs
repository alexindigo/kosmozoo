// Engine-host image acquisition, independent of the browser and source backing.
import { basename, resolve } from "node:path";
import { IMAGE_EXTENSIONS, mediaExtension, EXT_MIME } from "../../backings/mime.mjs";

export const MAX_FOLDER_IMAGES = 500;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const absolute = path => {
  if (typeof path !== "string" || !path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) throw fail("Enter an absolute folder or image path on the engine host");
  return resolve(path);
};

export async function listImages(path, limit = MAX_FOLDER_IMAGES) {
  const root = await Deno.realPath(absolute(path));
  if (!(await Deno.stat(root)).isDirectory) throw fail("The path is not a folder");
  const items = [], directories = [root];
  while (directories.length) {
    const directory = directories.pop();
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isSymlink) continue;
      const path = `${directory === "/" ? "" : directory}/${entry.name}`;
      if (entry.isDirectory) directories.push(path);
      else if (entry.isFile && IMAGE_EXTENSIONS.has(mediaExtension(entry.name))) {
        items.push({ kind: "server-path", name: entry.name, path });
        if (items.length > limit) throw fail(`This folder contains more than ${limit} images. Choose a smaller folder.`, 413);
      }
    }
  }
  items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { path: root, items, limit };
}

export async function readImage(path) {
  const canonical = absolute(path), name = basename(canonical);
  if (!IMAGE_EXTENSIONS.has(mediaExtension(name))) throw fail("The path must name an image");
  // Opening and inspecting the descriptor avoids a stat/read replacement race.
  const file = await Deno.open(canonical, { read: true });
  try {
    if (!(await Deno.lstat(canonical)).isFile || !(await file.stat()).isFile) throw fail("The image must be a regular file");
    return { name, bytes: new Uint8Array(await new Response(file.readable).arrayBuffer()), mime: EXT_MIME[mediaExtension(name)] };
  } finally { try { file.close(); } catch (error) { if (!(error instanceof Deno.errors.BadResource)) throw error; } }
}

export const folderError = error => Response.json({ error: error.message }, { status: error.status ?? (error instanceof Deno.errors.NotFound ? 404 : error instanceof Deno.errors.PermissionDenied ? 403 : 400) });
