import { assertEquals, assertThrows } from "jsr:@std/assert";
import { desktopArgument, systemdArgument } from "../src/desktop/install.mjs";
import { renderResources } from "../src/desktop/resources.mjs";

Deno.test("installer argument formats: absolute executable paths use distinct systemd and desktop escaping", () => {
  assertEquals(systemdArgument('/home/a space%/"quote"/$literal'), '"/home/a space%%/\\"quote\\"/$literal"');
  assertEquals(desktopArgument('/home/a space%/$literal'), '"/home/a space%%/\\\\$literal"');
  assertThrows(() => systemdArgument("relative/path"));
  assertThrows(() => desktopArgument("/path\ncommand"));
  assertThrows(() => desktopArgument("/path=not-allowed-by-spec"));
});

Deno.test("installation resources: local rendering preserves exact templates and global config belongs to actual user", async () => {
  const unitTemplate = await Deno.readTextFile(new URL("../packaging/linux/resources/kosmozoo-engine.service.in", import.meta.url));
  const desktopTemplate = await Deno.readTextFile(new URL("../packaging/linux/resources/kosmozoo.desktop.in", import.meta.url));
  const executable = '/home/a space%/"quote"/kosmozoo', icon = "/home/a space%/icon.png", environmentFile = "/home/a space%/engine.env";
  const local = renderResources({ unitTemplate, desktopTemplate, executable, icon, environmentFile });
  assertEquals(local.unit, unitTemplate.replace("{{EXECUTABLE}}", systemdArgument(executable)).replace("{{ENVIRONMENT_FILE}}", "/home/a space%%/engine.env"));
  assertEquals(local.desktop, desktopTemplate.replaceAll("{{EXECUTABLE}}", desktopArgument(executable)).replace("{{ICON}}", icon));
  const global = renderResources({ unitTemplate, desktopTemplate, executable: "/usr/bin/kosmozoo", icon: "/usr/share/icons/hicolor/256x256/apps/kosmozoo.png", userConfig: true });
  assertEquals(global.unit.includes('ExecStart=:/usr/bin/env -- "/usr/bin/kosmozoo" serve\nEnvironmentFile=-%E/kosmozoo/engine.env\nRestart=no'), true);
  assertEquals(global.desktop.includes('Exec=/usr/bin/env -- "/usr/bin/kosmozoo" browser-settings firefox'), true);
  assertThrows(() => renderResources({ unitTemplate: "{{UNKNOWN}}", desktopTemplate, executable, icon, environmentFile }));
});

Deno.test("installation resources: injected literal paths are never reinterpreted as template syntax", async () => {
  const unitTemplate = await Deno.readTextFile(new URL("../packaging/linux/resources/kosmozoo-engine.service.in", import.meta.url));
  const desktopTemplate = await Deno.readTextFile(new URL("../packaging/linux/resources/kosmozoo.desktop.in", import.meta.url));
  const executable = "/home/{{ICON}}/$&/kosmozoo", icon = "/home/{{EXECUTABLE}}/$&/icon.png", environmentFile = "/home/{{LITERAL}}/$&/engine.env";
  for (const userConfig of [false, true]) {
    const result = renderResources({ unitTemplate, desktopTemplate, executable, icon, environmentFile, userConfig });
    assertEquals(result.unit.includes(systemdArgument(executable)), true);
    assertEquals(result.unit.includes(userConfig ? "EnvironmentFile=-%E/kosmozoo/engine.env" : "EnvironmentFile=-" + environmentFile), true);
    assertEquals(result.desktop.split(desktopArgument(executable)).length - 1, 2);
    assertEquals(result.desktop.includes("Icon=" + icon), true);
  }
});
