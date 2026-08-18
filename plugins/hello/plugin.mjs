// plugins/hello/plugin.mjs — the hello-world plugin: a no-op that proves the
// host loads a folder, calls register(kz), and surfaces it via /api/plugins.

export function register(kz) {
  kz.settings.set("loaded", true);
  kz.route("GET", "/hello", () => Response.json({ hello: "kosmozoo" }));
}
