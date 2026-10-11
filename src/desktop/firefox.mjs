import { dirname, join } from "node:path";
import { jarMember } from "./jar.mjs";
import { textOrMissing } from "./paths.mjs";

const preference = "browser.taskbarTabs.enabled";
export async function firefoxPackageRoot(executable, { readText = textOrMissing, realPath = path => Deno.realPath(path) } = {}) {
  const path = await realPath(executable);
  // Arch's packaged /usr/bin/firefox is this literal forwarding script, not
  // a symlink. Inspect the characterized forwarding form as data; never run or
  // shell-interpret a wrapper to discover its package's resource directory.
  if (path === "/usr/bin/firefox") {
    const wrapper = await readText(path);
    const match = wrapper?.match(/^#!\/bin\/sh\s*\nexec (\/usr\/lib(?:64)?\/firefox\/firefox) "\$@"\s*$/);
    if (match) return dirname(await realPath(match[1]));
  }
  return dirname(path);
}

export function profilePreference(text) {
  if (text === null) return { known: true, value: null };
  let value = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || !line.includes(preference)) continue;
    const match = line.match(/^(?:user_pref|pref)\(\s*["']browser\.taskbarTabs\.enabled["']\s*,\s*(true|false)\s*\);\s*(?:\/\/.*)?$/);
    if (!match) return { known: false, value: null };
    value = match[1] === "true";
  }
  return { known: true, value };
}

export async function inspectFirefox(executable, profile, { readText = textOrMissing, readBinary = path => Deno.readFile(path), realPath = path => Deno.realPath(path) } = {}) {
  try {
    const root = await firefoxPackageRoot(executable, { readText, realPath });
    const main = await readBinary(join(root, "omni.ja")), browser = await readBinary(join(root, "browser/omni.ja"));
    const constants = jarMember(main, "modules/AppConstants.sys.mjs")?.replace(/\/\/[^\n]*/g, "");
    const command = jarMember(browser, "modules/taskbartabs/TaskbarTabsCmd.sys.mjs");
    const pin = jarMember(browser, "modules/taskbartabs/TaskbarTabsPin.sys.mjs");
    if (!command || !pin) return { state: "unsupported", reason: "firefox-unsupported" };
    if (!/platform\s*:\s*["']linux["']/.test(constants ?? "") || !command.includes('handleFlagWithParam("taskbar-tab"') || !command.includes("findOrCreateTaskbarTab") || !pin.includes("createLinuxDesktopEntry")) {
      return { state: "unknown", reason: "firefox-unknown" };
    }
    const shipped = jarMember(browser, "defaults/preferences/firefox.js");
    const defaultValue = profilePreference(shipped);
    if (!defaultValue.known || defaultValue.value === null) return { state: "unknown", reason: "firefox-unknown" };
    let locked = null, policyDefault = null;
    for (const path of ["/etc/firefox/policies/policies.json", join(root, "distribution/policies.json")]) {
      const text = await readText(path);
      if (text === null) continue;
      const policies = JSON.parse(text)?.policies;
      const entry = policies?.Preferences?.[preference];
      if (entry === undefined) continue;
      if (!entry || typeof entry.Value !== "boolean" || !["locked", "default", "user"].includes(entry.Status)) return { state: "unknown", reason: "firefox-unknown" };
      if (entry.Status === "locked") locked = entry.Value; else policyDefault = entry.Value;
    }
    // AutoConfig is executable JS, never evaluated by this application.
    const autoConfig = await readText(join(root, "defaults/pref/autoconfig.js"));
    if (autoConfig?.includes("general.config.filename")) return { state: "unknown", reason: "firefox-unknown" };
    const saved = profilePreference(await readText(join(profile, "prefs.js")));
    const user = profilePreference(await readText(join(profile, "user.js")));
    if (!saved.known || !user.known) return { state: "unknown", reason: "firefox-unknown" };
    const enabled = locked ?? user.value ?? saved.value ?? policyDefault ?? defaultValue.value;
    return enabled ? { state: "enabled", reason: null } : { state: locked === false ? "blocked" : "disabled", reason: locked === false ? "firefox-unknown" : "firefox-disabled" };
  } catch (error) { return { state: "unknown", reason: "firefox-unknown", detail: error.message }; }
}

export function firefoxArguments(profile, browserURL, appId) {
  return ["-taskbar-tab", appId, "-new-window", browserURL, "-profile", profile, "-container", "0"];
}

// The characterized native registry matches hostname/container, not origin.
// Validate the actual registered start URL before letting its ID own a launch;
// otherwise the browser can ignore the requested port and show another engine.
export function firefoxRegistration(text, browserURL) {
  if (text === null) return { available: true, appId: null };
  try {
    const registry = JSON.parse(text), requested = new URL(browserURL);
    if (registry?.version !== 1 || !Array.isArray(registry.taskbarTabs)) throw new Error("Unknown native registration format");
    const hostname = requested.hostname.replace(/^\[|\]$/g, "");
    const ids = new Set();
    for (const entry of registry.taskbarTabs) {
      if (!entry || typeof entry.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.id) || ids.has(entry.id) ||
          !Number.isSafeInteger(entry.userContextId) || entry.userContextId < 0 ||
          typeof entry.startUrl !== "string" || !Array.isArray(entry.scopes)) throw new Error("Unknown native registration entry");
      ids.add(entry.id);
      new URL(entry.startUrl);
      for (const scope of entry.scopes) {
        if (!scope || typeof scope.hostname !== "string" || Object.hasOwn(scope, "prefix") && typeof scope.prefix !== "string") throw new Error("Unknown native registration scope");
      }
    }
    for (const entry of registry.taskbarTabs) {
      for (const scope of entry.scopes) {
        if (entry.userContextId !== 0 || scope.hostname !== hostname ||
            Object.hasOwn(scope, "prefix") && !requested.pathname.startsWith(scope.prefix)) continue;
        const registered = new URL(entry.startUrl);
        return registered.href === requested.href ? { available: true, appId: entry.id } :
          { available: false, reason: "firefox-origin-conflict" };
      }
    }
    return { available: true, appId: null };
  } catch { return { available: false, reason: "firefox-unknown" }; }
}

export async function firefoxLaunchTarget(profile, browserURL) {
  try { return firefoxRegistration(await textOrMissing(join(profile, "taskbartabs/taskbartabs.json")), browserURL); }
  catch (error) { return { available: false, reason: "firefox-unknown", detail: error.message }; }
}
