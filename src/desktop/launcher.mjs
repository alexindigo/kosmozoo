// Installed-browser process/profile concerns remain outside engine Context/Store.
import { basename, join, isAbsolute } from "node:path";
import { desktopPaths, ownedDirectory, privateDirectory, privateJson, textOrMissing } from "./paths.mjs";
import { inspectFirefox, firefoxArguments, firefoxLaunchTarget } from "./firefox.mjs";
import { launchNotice, noticeURL } from "../../client/js/launch-notice.mjs";

const providers = Object.freeze([
  { id: "chromium", names: ["chromium", "chromium-browser"], desktop: ["chromium.desktop", "chromium-browser.desktop"] },
  { id: "chrome", names: ["google-chrome", "google-chrome-stable"], desktop: ["google-chrome.desktop"] },
  { id: "brave", names: ["brave-browser", "brave-browser-stable", "brave"], desktop: ["brave-browser.desktop", "brave-browser-stable.desktop"] },
  { id: "firefox", names: ["firefox"], desktop: ["firefox.desktop"] },
]);
export function chromiumArguments(profile, browserURL, env = {}) {
  // Linux package build defaults can select X11 even in a Wayland-only
  // session. The adapter names the available native display explicitly.
  return [`--user-data-dir=${profile}`, `--app=${browserURL}`, "--no-first-run", "--no-default-browser-check",
    ...(env.WAYLAND_DISPLAY ? ["--ozone-platform=wayland"] : [])];
}

async function executable(path) {
  try { const info = await Deno.stat(path); return info.isFile && !!(info.mode & 0o111); }
  catch (error) { if (error instanceof Deno.errors.NotFound) return false; throw error; }
}
export async function findExecutable(names, env) {
  for (const name of names) for (const directory of (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    if (await executable(path)) return path;
  }
  return null;
}
async function choice(env, explicit, saved) {
  const preferred = explicit ?? saved?.browser;
  if (preferred !== undefined) {
    if (!isAbsolute(preferred) || !await executable(preferred)) throw new Error("Explicit/saved browser must be an installed absolute executable; the preference was kept");
    const provider = providers.find(provider => provider.names.includes(basename(preferred)));
    if (!provider) throw new Error("Explicit/saved browser has no characterized app-window adapter; the preference was kept");
    return { provider, executable: preferred };
  }
  let defaultDesktop = null;
  const settings = await findExecutable(["xdg-settings"], env);
  if (settings) {
    const output = await new Deno.Command(settings, { args: ["get", "default-web-browser"], stdout: "piped", stderr: "null" }).output();
    if (output.success) defaultDesktop = new TextDecoder().decode(output.stdout).trim();
  }
  const order = [...providers].sort((a, b) => Number(b.desktop.includes(defaultDesktop)) - Number(a.desktop.includes(defaultDesktop)));
  for (const provider of order) { const path = await findExecutable(provider.names, env); if (path) return { provider, executable: path }; }
  return null;
}

async function startProcess(path, args, onFailure) {
  const child = new Deno.Command(path, { args, stdin: "null", stdout: "inherit", stderr: "inherit" }).spawn();
  child.unref();
  child.status.then(status => { if (!status.success) onFailure?.(status); }).catch(error => onFailure?.({ error }));
  return child.pid;
}

export async function openFallback(browserURL, reason, env, detail = "") {
  const message = launchNotice(reason, browserURL);
  console.error(`kosmozoo: ${message}${detail ? ` ${detail}` : ""}`);
  const opener = await findExecutable(["xdg-open"], env);
  if (opener) await startProcess(opener, [noticeURL(browserURL, reason)], status => console.error(`kosmozoo: regular-browser opener failed: ${JSON.stringify(status)}; URL: ${browserURL}`));
  return { kind: "fallback-requested", reason, browserURL };
}

export async function launchBrowser(browserURL, { env = Deno.env.toObject(), browser = undefined } = {}) {
  const paths = desktopPaths(env);
  await ownedDirectory(paths.data);
  const preferences = join(paths.data, "launcher.json");
  const savedText = await textOrMissing(preferences);
  let saved;
  try { saved = savedText === null ? { version: 1, firefoxAppId: crypto.randomUUID() } : JSON.parse(savedText); }
  catch { return openFallback(browserURL, "browser-failed", env, "Saved launcher configuration is unreadable and was preserved."); }
  if (!saved || typeof saved !== "object" || Array.isArray(saved) || saved.version !== 1 || typeof saved.firefoxAppId !== "string") return openFallback(browserURL, "browser-failed", env, "Saved launcher configuration is unsupported and was preserved.");
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return openFallback(browserURL, "display-unavailable", env);
  let selected;
  try { selected = await choice(env, browser, saved); }
  catch (error) { return openFallback(browserURL, "browser-failed", env, error.message); }
  if (!selected) return openFallback(browserURL, "no-browser", env);
  // A valid explicit choice survives a temporarily unavailable app capability,
  // so enabling Firefox in its settings profile and relaunching honors it.
  if (savedText === null || browser !== undefined) {
    try { await privateJson(preferences, { ...saved, ...(browser === undefined ? {} : { browser }) }); }
    catch (error) { return openFallback(browserURL, "browser-failed", env, `Launcher preference could not be saved: ${error.message}`); }
  }
  const profile = join(paths.data, "browser", selected.provider.id);
  try { await privateDirectory(profile); }
  catch (error) { return openFallback(browserURL, "profile-busy", env, error.message); }
  let firefoxAppId;
  if (selected.provider.id === "firefox") {
    const capability = await inspectFirefox(selected.executable, profile);
    if (capability.state !== "enabled") return openFallback(browserURL, capability.reason, env, capability.detail);
    const target = await firefoxLaunchTarget(profile, browserURL);
    if (!target.available) return openFallback(browserURL, target.reason, env, target.detail);
    // Existing IDs come only from a matched native registration. An unknown
    // placeholder invokes the browser's own reconstruction for a new target;
    // a stale saved ID can never bypass the native URL-identity check.
    firefoxAppId = target.appId ?? crypto.randomUUID();
  }
  const args = selected.provider.id === "firefox" ? firefoxArguments(profile, browserURL, firefoxAppId) : chromiumArguments(profile, browserURL, env);
  try {
    const pid = await startProcess(selected.executable, args, () => { openFallback(browserURL, "browser-failed", env).catch(error => console.error(error)); });
    return { kind: "app-requested", provider: selected.provider.id, profile, pid, browserURL };
  } catch (error) { return openFallback(browserURL, "browser-failed", env, error.message); }
}

export async function firefoxSettings(env = Deno.env.toObject()) {
  const paths = desktopPaths(env), path = await findExecutable(["firefox"], env);
  if (!path) throw new Error("Installed Firefox was not found; no profile or preference was changed");
  await ownedDirectory(paths.data);
  const profile = await privateDirectory(join(paths.data, "browser/firefox"));
  await startProcess(path, ["-profile", profile, "-new-window", "about:config"], () => console.error("kosmozoo: dedicated Firefox settings window could not be opened"));
  console.log(`Firefox settings requested in dedicated profile ${profile}; no preference was written.`);
}
