import { assertEquals, assertThrows } from "jsr:@std/assert";
import { desktopArgument, systemdArgument } from "../src/desktop/install.mjs";

Deno.test("installer argument formats: absolute executable paths use distinct systemd and desktop escaping", () => {
  assertEquals(systemdArgument('/home/a space%/"quote"/$literal'), '"/home/a space%%/\\"quote\\"/$literal"');
  assertEquals(desktopArgument('/home/a space%/$literal'), '"/home/a space%%/\\\\$literal"');
  assertThrows(() => systemdArgument("relative/path"));
  assertThrows(() => desktopArgument("/path\ncommand"));
  assertThrows(() => desktopArgument("/path=not-allowed-by-spec"));
});
