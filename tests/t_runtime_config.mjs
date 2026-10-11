import { assertEquals, assertThrows } from "jsr:@std/assert";
import { resolveRuntime, browserOrigin } from "../src/runtime-config.mjs";

Deno.test("runtime binding: desktop loopback and headless/source wildcard share port2084 and localhost origin", () => {
  assertEquals(resolveRuntime("app", {}).binding, { hostname: "127.0.0.1", port: 2084 });
  for (const mode of ["serve", "source"]) assertEquals(resolveRuntime(mode, {}).binding, { hostname: "0.0.0.0", port: 2084 });
  for (const mode of ["app", "serve", "source"]) assertEquals(resolveRuntime(mode, {}).browserURL, "http://localhost:2084/");
});
Deno.test("runtime overrides: full valid port and selected interface win without truncation or fallback", () => {
  assertEquals(resolveRuntime("app", { KOZMOZOO_BIND: "192.168.1.2", KOZMOZOO_PORT: "65535" }).browserURL, "http://192.168.1.2:65535/");
  assertEquals(resolveRuntime("serve", { KOZMOZOO_BIND: "::1", KOZMOZOO_PORT: "1" }).browserURL, "http://localhost:1/");
  assertEquals(browserOrigin({ hostname: "2001:db8::1", port: 2084 }), "http://[2001:db8::1]:2084/");
  for (const value of ["", "0", "65536", "2084junk", "2084.5", "-1", " 2084", "2084 ", "1e3", "0x824", undefined, 2084]) {
    assertThrows(() => resolveRuntime("app", { KOZMOZOO_PORT: value }), Error, "KOZMOZOO_PORT");
  }
  for (const value of ["", " ", "http://localhost", "localhost:2084", "[::1]", "bad/name", undefined]) {
    assertThrows(() => resolveRuntime("serve", { KOZMOZOO_BIND: value }), Error, "KOZMOZOO_BIND");
  }
});
