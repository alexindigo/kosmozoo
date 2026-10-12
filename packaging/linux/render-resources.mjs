// Build-time global resources only. Never invokes the self-installer.
import { renderResources } from "../../src/desktop/resources.mjs";
import { join } from "node:path";

const [output] = Deno.args;
if (!output || Deno.args.length !== 1) throw new Error("Supply one fresh global resource output directory");
const source = new URL("../../", import.meta.url);
const text = name => Deno.readTextFile(new URL(name, source));
const { unit, desktop } = renderResources({
  unitTemplate: await text("packaging/linux/resources/kosmozoo-engine.service.in"),
  desktopTemplate: await text("packaging/linux/resources/kosmozoo.desktop.in"),
  executable: "/usr/bin/kosmozoo", icon: "/usr/share/icons/hicolor/256x256/apps/kosmozoo.png", userConfig: true,
});
await Deno.mkdir(output, { mode: 0o700 });
const files = {
  "usr/lib/systemd/user/kosmozoo-engine.service": new TextEncoder().encode(unit),
  "usr/share/applications/kosmozoo.desktop": new TextEncoder().encode(desktop),
};
for (const [from, to] of [
  ["client/logo-256.png", "usr/share/icons/hicolor/256x256/apps/kosmozoo.png"],
  ["LICENSE", "usr/share/licenses/kosmozoo/LICENSE"],
  ["LICENSE.GPL", "usr/share/licenses/kosmozoo/LICENSE.GPL"],
  ["packaging/linux/resources/THIRD_PARTY_NOTICES.txt", "usr/share/licenses/kosmozoo/THIRD_PARTY_NOTICES.txt"],
  ["packaging/linux/resources/NOTICE-SOURCES.json", "usr/share/licenses/kosmozoo/NOTICE-SOURCES.json"],
  ["docs/executable.md", "usr/share/doc/kosmozoo/executable.md"],
  ["packaging/linux/PUBLICATION.md", "usr/share/doc/kosmozoo/PUBLICATION.md"],
  ["packaging/linux/LICENSING.md", "usr/share/doc/kosmozoo/LICENSING.md"],
]) files[to] = await Deno.readFile(new URL(from, source));
for (const [path, bytes] of Object.entries(files)) {
  await Deno.mkdir(join(output, path, ".."), { recursive: true });
  await Deno.writeFile(join(output, path), bytes, { createNew: true, mode: 0o644 });
}
