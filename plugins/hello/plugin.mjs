// plugins/hello/plugin.mjs — the hello-world plugin: a no-op that proves the
// host loads a folder, calls register(kz), and surfaces it via /api/plugins.

export function register(kz) {
  kz.settings.get("loaded", false); // reads must not write (a plugin boot is not a state change)
  kz.route("GET", "/hello", () => Response.json({ hello: "kosmozoo" }));
}
