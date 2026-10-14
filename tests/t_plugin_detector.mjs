// tests/t_plugin_detector.mjs — the detector plugin proves the
// external-dependency shape — absent when unconfigured.

import { assert, assertEquals } from "jsr:@std/assert";

Deno.test("detector: the plugin declares its config need and failure states", async () => {
  // register() must announce the face-anchored alignment with a declared
  // config need whose unmet reason names the setting.
  const caps = [];
  let url = null;
  const kz = {
    settings: { get: (k, fb) => k === "serviceUrl" ? url : fb, set: async () => {}, ns: () => ({}) },
    alignment: (id, def) => caps.push({ kind: "alignment", id, ...def }),
    route: () => {},
  };
  const mod = await import("../plugins/detector/plugin.mjs");
  mod.register(kz);
  const align = caps.find((c) => c.id === "face-anchored");
  assert(align, "face-anchored alignment contributed");
  // needs.ok is a FUNCTION, evaluated per request (F13) — never frozen
  const need = align.needs.find((n) => n.kind === "config");
  assertEquals(typeof need.ok, "function");
  assertEquals(need.ok(), false);          // unconfigured
  url = "http://127.0.0.1:8471";
  assertEquals(need.ok(), true);           // configured at runtime — no re-register
  assert(need.reason.includes("serviceUrl"));
  assertEquals(align.derives, ["eyeMidpoint", "interEyeDistance"]);
});
