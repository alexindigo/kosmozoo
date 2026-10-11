import { assertEquals, assertThrows } from "jsr:@std/assert";
import { chromiumArguments } from "../src/desktop/launcher.mjs";
import { firefoxArguments, profilePreference, firefoxPackageRoot, firefoxRegistration } from "../src/desktop/firefox.mjs";
import { desktopPaths } from "../src/desktop/paths.mjs";
import { launchNotice, noticeURL } from "../client/js/launch-notice.mjs";

Deno.test("desktop adapters: persistent family-separated profiles and safe argv preserve spaces/percent/quotes", () => {
  const root = desktopPaths({ HOME: "/home/a space%\"", XDG_DATA_HOME: "/data/my space%" });
  assertEquals(root.data, "/data/my space%/kosmozoo");
  const profile = root.data + "/browser/chromium", url = "http://localhost:8123/";
  assertEquals(chromiumArguments(profile, url), [`--user-data-dir=${profile}`, `--app=${url}`, "--no-first-run", "--no-default-browser-check"]);
  assertEquals(chromiumArguments(profile, url, { WAYLAND_DISPLAY: "wayland-1" }).at(-1), "--ozone-platform=wayland");
  assertEquals(firefoxArguments(root.data + "/browser/firefox", url, "known-app"), ["-taskbar-tab", "known-app", "-new-window", url, "-profile", root.data + "/browser/firefox", "-container", "0"]);
});
Deno.test("Firefox preference detection: literal data only; absence is not unsupported, executable/unknown values never run", () => {
  assertEquals(profilePreference(null), { known: true, value: null });
  assertEquals(profilePreference('// user_pref("browser.taskbarTabs.enabled", false);\nuser_pref("browser.taskbarTabs.enabled", true);'), { known: true, value: true });
  assertEquals(profilePreference('user_pref("browser.taskbarTabs.enabled", globalThis.execute());'), { known: false, value: null });
});
Deno.test("Firefox installed-package resources: real symlink target and characterized literal Arch wrapper, never shell evaluation", async () => {
  const realPath = async path => path;
  assertEquals(await firefoxPackageRoot("/usr/lib/firefox/firefox", { realPath }), "/usr/lib/firefox");
  assertEquals(await firefoxPackageRoot("/usr/bin/firefox", { realPath, readText: async () => '#!/bin/sh\nexec /usr/lib/firefox/firefox "$@"\n' }), "/usr/lib/firefox");
  assertEquals(await firefoxPackageRoot("/usr/bin/firefox", { realPath, readText: async () => '#!/bin/sh\nexec $(find-package) "$@"\n' }), "/usr/bin");
});
Deno.test("desktop fallback: reason whitelist and chosen-port URL, no arbitrary query text or installation recommendations", () => {
  const url = noticeURL("http://localhost:8123/", "firefox-disabled");
  assertEquals(new URL(url).searchParams.get("launchReason"), "firefox-disabled");
  assertEquals(launchNotice("<script>alert(1)</script>", "http://localhost:8123/"), null);
  assertEquals(launchNotice("__proto__", "http://localhost:8123/"), null);
  assertThrows(() => noticeURL("http://localhost:8123/", "unknown"));
});
Deno.test("Firefox native registration: actual start URL owns reuse, not hostname-only matching or a saved arbitrary ID", () => {
  const id = "d2ed21f1-fcbf-4ef6-9649-96cd3e666161";
  const entry = { id, userContextId: 0, scopes: [{ hostname: "localhost" }], startUrl: "http://localhost:2084" };
  const text = JSON.stringify({ version: 1, taskbarTabs: [entry] });
  assertEquals(firefoxRegistration(text, "http://localhost:2084/"), { available: true, appId: id });
  assertEquals(firefoxRegistration(text, "http://localhost:2085/"), { available: false, reason: "firefox-origin-conflict" });
  assertEquals(firefoxRegistration(null, "http://localhost:2085/"), { available: true, appId: null });
  assertEquals(firefoxRegistration(JSON.stringify({ version: 1, taskbarTabs: [{ ...entry, userContextId: 1 }] }), "http://localhost:2085/"), { available: true, appId: null });
  assertEquals(firefoxRegistration(JSON.stringify({ version: 1, taskbarTabs: [{ ...entry, scopes: [{ hostname: "other.example" }] }] }), "http://localhost:2085/"), { available: true, appId: null });
  assertEquals(firefoxRegistration('{broken', "http://localhost:2085/"), { available: false, reason: "firefox-unknown" });
  assertEquals(firefoxRegistration(JSON.stringify({ version: 2, taskbarTabs: [] }), "http://localhost:2085/"), { available: false, reason: "firefox-unknown" });
  assertEquals(firefoxRegistration(JSON.stringify({ version: 1, taskbarTabs: [entry, entry] }), "http://localhost:2084/"), { available: false, reason: "firefox-unknown" });
  assertEquals(firefoxRegistration(JSON.stringify({ version: 1, taskbarTabs: [entry, { ...entry, id: "invalid" }] }), "http://localhost:2084/"), { available: false, reason: "firefox-unknown" });
});
