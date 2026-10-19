// Package-owned files only: callers supply install/staging paths, never HOME/XDG.
import { isAbsolute, join } from "node:path";
import { renderResources } from "./resources.mjs";

export async function writePackageResources({ prefix, destdir, read = name => Deno.readFile(new URL(`../../${name}`, import.meta.url)) }) {
  for (const [name, path] of Object.entries({ prefix, destdir })) {
    if (typeof path !== "string" || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
      throw new Error(`${name} must be an absolute path with no control characters`);
    }
  }
  const text = async name => new TextDecoder().decode(await read(name));
  const { unit, desktop } = renderResources({
    unitTemplate: await text("packaging/linux/resources/kosmozoo-engine.service.in"),
    desktopTemplate: await text("packaging/linux/resources/kosmozoo.desktop.in"),
    executable: join(prefix, "bin/kosmozoo"), icon: join(prefix, "share/icons/hicolor/256x256/apps/kosmozoo.png"), userConfig: true,
  });
  const files = {
    "lib/systemd/user/kosmozoo-engine.service": new TextEncoder().encode(unit),
    "share/applications/kosmozoo.desktop": new TextEncoder().encode(desktop),
  };
  for (const [from, to] of [
    ["client/logo-256.png", "share/icons/hicolor/256x256/apps/kosmozoo.png"],
    ["LICENSE", "share/licenses/kosmozoo/LICENSE"],
    ["LICENSE.GPL", "share/licenses/kosmozoo/LICENSE.GPL"],
    ["packaging/linux/resources/THIRD_PARTY_NOTICES.txt", "share/licenses/kosmozoo/THIRD_PARTY_NOTICES.txt"],
    ["packaging/linux/resources/NOTICE-SOURCES.json", "share/licenses/kosmozoo/NOTICE-SOURCES.json"],
    ["docs/executable.md", "share/doc/kosmozoo/executable.md"],
    ["packaging/linux/PUBLICATION.md", "share/doc/kosmozoo/PUBLICATION.md"],
    ["packaging/linux/LICENSING.md", "share/doc/kosmozoo/LICENSING.md"],
  ]) files[to] = await read(from);
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(destdir, prefix, path);
    await Deno.mkdir(join(target, ".."), { recursive: true });
    await Deno.writeFile(target, bytes, { createNew: true, mode: 0o644 });
  }
}
