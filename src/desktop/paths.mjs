import { join, isAbsolute } from "node:path";
import { getuid } from "node:process";

export function desktopPaths(env) {
  if (!env.HOME || !isAbsolute(env.HOME)) throw new Error("User-local launch/install requires an absolute HOME");
  const data = env.XDG_DATA_HOME ?? join(env.HOME, ".local/share");
  const config = env.XDG_CONFIG_HOME ?? join(env.HOME, ".config");
  if (!isAbsolute(data) || !isAbsolute(config)) throw new Error("XDG data/config paths must be absolute");
  return Object.freeze({ home: env.HOME, data: join(data, "kosmozoo"), config: join(config, "kosmozoo"),
    bin: join(env.HOME, ".local/bin"), applications: join(data, "applications"), units: join(config, "systemd/user"),
    icons: join(data, "icons/hicolor/256x256/apps") });
}

export async function ownedDirectory(path) {
  await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || info.uid !== getuid()) throw new Error(`User-local directory must be owned and real: ${path}`);
  return path;
}

export async function privateDirectory(path) {
  await ownedDirectory(path);
  if ((await Deno.lstat(path)).mode & 0o077) throw new Error(`Dedicated profile/application directory must be private: ${path}`);
  return path;
}

export async function textOrMissing(path) {
  try { return await Deno.readTextFile(path); }
  catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
}

export async function privateJson(path, value) {
  const temporary = path + ".tmp." + crypto.randomUUID();
  await Deno.writeTextFile(temporary, JSON.stringify(value, null, 2), { createNew: true, mode: 0o600 });
  await Deno.rename(temporary, path);
}
