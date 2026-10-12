// Optional user-local installation. Activation is one current-code symlink;
// launcher/unit/menu/icon links all refer through it. Previous code is retained.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getuid } from "node:process";
import { desktopPaths, ownedDirectory, privateDirectory, privateJson, textOrMissing } from "./paths.mjs";
import { resolveStateDir } from "../state.mjs";
import { acquireInstance, matchingInstance, peekInstance } from "../instance.mjs";
import { resolveRuntime } from "../runtime-config.mjs";
import { renderResources } from "./resources.mjs";
export { desktopArgument, systemdArgument, systemdPath } from "./resources.mjs";

const UNIT = "kosmozoo-engine.service";
const bytes = text => new TextEncoder().encode(text);
const digest = async data => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
const resource = name => Deno.readTextFile(new URL(`../../packaging/linux/resources/${name}`, import.meta.url));

async function info(path) {
  try { return await Deno.lstat(path); }
  catch (error) { if (error instanceof Deno.errors.NotFound) return null; throw error; }
}
async function managedLink(path, target, missing = false) {
  const value = await info(path);
  if (!value && missing) return;
  if (!value?.isSymlink || value.uid !== getuid() || await Deno.readLink(path) !== target) throw new Error(`Unmanaged or changed installation conflict: ${path}`);
}
async function command(args, allowFailure = false) {
  const output = await new Deno.Command("systemctl", { args: ["--user", ...args], stdin: "null", stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(output.stdout), error = new TextDecoder().decode(output.stderr);
  if (!output.success && !allowFailure) throw new Error(`systemctl --user ${args.join(" ")}: ${error || text}`);
  return { success: output.success, text, error };
}
async function unitState() {
  const output = await command(["show", UNIT, "--property=LoadState,ActiveState,MainPID,Result,FragmentPath,ExecMainStatus"], true);
  return Object.fromEntries(output.text.trim().split("\n").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
async function stopUnit() {
  const before = await unitState();
  // A failed/invalid unit can have no process at all. Retire live processes,
  // not a nonexistent load job; verified managed links still need recovery or
  // removal even when systemd rejected the unit before exec.
  if (["inactive", "failed"].includes(before.ActiveState) && !(Number(before.MainPID) > 0)) return before;
  await command(["stop", UNIT]);
  const after = await unitState();
  if (!["inactive", "failed"].includes(after.ActiveState) || Number(after.MainPID) > 0) throw new Error("Managed engine remains active; preserve installation and inspect its unit");
  return after;
}
async function processEnvironment(pid) {
  const content = await Deno.readTextFile(`/proc/${pid}/environ`);
  return Object.fromEntries(content.split("\0").filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
async function readyUnit() {
  const deadline = performance.now() + 10000;
  for (;;) {
    const state = await unitState();
    if (state.ActiveState === "failed" || state.Result && !["success", ""].includes(state.Result)) throw new Error(`Managed engine failed: ${state.Result}; inspect its journal and preserve state/quarantine`);
    if (Number(state.MainPID) > 0) {
      const env = await processEnvironment(Number(state.MainPID));
      const selectedState = resolveStateDir(env);
      const published = await peekInstance(selectedState, Number(state.MainPID));
      if (published?.status === "ready") {
        const lease = await acquireInstance(selectedState);
        try {
          if (!lease.owner) {
            const result = await matchingInstance(lease, resolveRuntime("serve", env));
            if (result.runtime.mode !== "serve") throw new Error("Managed unit is not an engine-only service");
            return result;
          }
        } finally { await lease.release(); }
      }
    }
    if (performance.now() >= deadline) throw new Error("Managed unit did not publish matching readiness; no restart loop was configured");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function activate(root, target) {
  const temporary = join(root, "current.tmp." + crypto.randomUUID());
  await Deno.symlink(target, temporary);
  await Deno.rename(temporary, join(root, "current"));
}
async function existingInstallation(root) {
  const current = join(root, "current"), value = await info(current);
  if (!value) return null;
  if (!value.isSymlink || value.uid !== getuid()) throw new Error(`Unmanaged application activation conflict: ${current}`);
  const target = await Deno.readLink(current);
  if (!/^versions\/[0-9a-f]{64}$/.test(target)) throw new Error("Unmanaged application version target");
  const receipt = JSON.parse(await Deno.readTextFile(join(root, target, "receipt.json")));
  if (receipt.version !== 1 || receipt.root !== root || !Array.isArray(receipt.links)) throw new Error("Managed installation receipt is invalid; files were preserved");
  for (const link of receipt.links) await managedLink(link.path, link.target);
  for (const [name, expected] of Object.entries(receipt.files)) {
    const file = join(root, target, name), stat = await Deno.lstat(file);
    if (!stat.isFile || stat.isSymlink || stat.uid !== getuid() || await digest(await Deno.readFile(file)) !== expected) throw new Error(`Managed application file was changed: ${file}`);
  }
  return { target, receipt };
}

export async function install({ env = Deno.env.toObject(), service = false, provenance } = {}) {
  if (!provenance || !provenance.kind.startsWith("compiled-")) throw new Error("Installation requires the packaged executable, not the Deno source interpreter");
  const paths = desktopPaths(env), root = join(paths.data, "application");
  await ownedDirectory(paths.data); await privateDirectory(root);
  const old = await existingInstallation(root);
  const launcher = join(paths.bin, "kosmozoo"), icon = join(paths.icons, "kosmozoo.png");
  const links = [{ path: launcher, target: join(root, "current/kosmozoo") },
    { path: join(paths.units, UNIT), target: join(root, "current/" + UNIT) },
    { path: join(paths.applications, "kosmozoo.desktop"), target: join(root, "current/kosmozoo.desktop") },
    { path: icon, target: join(root, "current/icon.png") }];
  if (old && JSON.stringify(old.receipt.links) !== JSON.stringify(links)) throw new Error("Installation locations differ from the managed receipt; reconcile the previous installation first");
  if (!old) for (const link of links) if (await info(link.path)) throw new Error(`Unmanaged file/unit/symlink conflict: ${link.path}`);
  const loaded = await unitState();
  if (loaded.LoadState && loaded.LoadState !== "not-found" && !old) throw new Error("An unmanaged kosmozoo-engine.service is already loaded");
  const binary = await Deno.readFile(Deno.execPath());
  const executableSha256 = await digest(binary);
  const { unit, desktop } = renderResources({ unitTemplate: await resource(UNIT + ".in"), desktopTemplate: await resource("kosmozoo.desktop.in"),
    executable: launcher, icon, environmentFile: join(paths.config, "engine.env") });
  const image = await Deno.readFile(new URL("../../client/logo-256.png", import.meta.url));
  const files = { kosmozoo: binary, [UNIT]: bytes(unit), "kosmozoo.desktop": bytes(desktop), "icon.png": image,
    "THIRD_PARTY_NOTICES.txt": bytes(await resource("THIRD_PARTY_NOTICES.txt")), "NOTICE-SOURCES.json": bytes(await resource("NOTICE-SOURCES.json")) };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, data]) => [name, await digest(data)])));
  const version = await digest(bytes(JSON.stringify({ hashes, links }))), target = "versions/" + version;
  const receipt = { version: 1, root, executableSha256, provenance, links, files: hashes };
  await privateDirectory(join(root, "versions"));
  const directory = join(root, target);
  if (!await info(directory)) {
    const staged = join(root, "versions/staged-" + crypto.randomUUID());
    await privateDirectory(staged);
    for (const [name, data] of Object.entries(files)) await Deno.writeFile(join(staged, name), data, { createNew: true, mode: name === "kosmozoo" ? 0o755 : 0o644 });
    await privateJson(join(staged, "receipt.json"), receipt);
    await Deno.rename(staged, directory);
  } else {
    const prior = JSON.parse(await Deno.readTextFile(join(directory, "receipt.json")));
    if (JSON.stringify(prior) !== JSON.stringify(receipt)) throw new Error("Existing staged-version receipt differs; preserve it for reconciliation");
    for (const [name, expected] of Object.entries(hashes)) if (await digest(await Deno.readFile(join(directory, name))) !== expected) throw new Error("Existing staged-version contents differ");
  }
  if (old?.target === target) {
    if (service) { await command(["enable", "--now", UNIT]); const ready = await readyUnit(); console.log(`Managed engine ready: ${ready.browserURL}`); }
    console.log(`Kosmozoo installation already matches ${executableSha256}`); return receipt;
  }
  const created = [];
  let activated = false, stopped = false;
  const active = old && loaded.ActiveState === "active";
  try {
    if (active) { const state = await stopUnit(); stopped = true; if (state.ExecMainStatus !== "0") throw new Error("Managed engine did not stop cleanly; update was not activated"); }
    if (!old) {
      for (const path of [paths.bin, paths.units, paths.applications, paths.icons]) await ownedDirectory(path);
      for (const link of links) { await Deno.symlink(link.target, link.path); created.push(link); }
    }
    await activate(root, target); activated = true;
    for (const link of links) await managedLink(link.path, link.target);
    await command(["daemon-reload"]);
    if (active || service) {
      if (service) await command(["enable", UNIT]);
      await command(["start", UNIT]);
      const ready = await readyUnit(); console.log(`Managed engine ready: ${ready.browserURL}`);
    }
    console.log(`Installed Kosmozoo at ${launcher}; menu/icon/unit managed by ${join(directory, "receipt.json")}. State/cache/plugins/browser profiles are retained.`);
    return receipt;
  } catch (error) {
    const failures = [error];
    // Stop only this managed candidate. Never restart old code automatically:
    // a failed startup may have quarantined or changed state outside this tree.
    if (activated) {
      try { await stopUnit(); } catch (cleanupError) { failures.push(cleanupError); }
      try {
        if (old) await activate(root, old.target);
        else { await managedLink(join(root, "current"), target); await Deno.remove(join(root, "current")); }
      } catch (cleanupError) { failures.push(cleanupError); }
    }
    for (const link of created) {
      try { await managedLink(link.path, link.target, true); if (await info(link.path)) await Deno.remove(link.path); }
      catch (cleanupError) { failures.push(cleanupError); }
    }
    try { await command(["daemon-reload"]); } catch (cleanupError) { failures.push(cleanupError); }
    console.error(`Installation failed; candidate ${directory} and previous code were retained. ${stopped || activated ? "The managed engine is left stopped; inspect preserved state/quarantine before an explicit restart." : "Activation was not completed."}`);
    throw failures.length === 1 ? error : new AggregateError(failures, "Installation failed with recovery errors", { cause: error });
  }
}

export async function uninstall(env = Deno.env.toObject()) {
  const paths = desktopPaths(env), root = join(paths.data, "application"), old = await existingInstallation(root);
  if (!old) throw new Error("No matching managed installation was found; no files were removed");
  await stopUnit();
  await command(["disable", UNIT]);
  for (const link of old.receipt.links) { await managedLink(link.path, link.target, true); if (await info(link.path)) await Deno.remove(link.path); }
  await managedLink(join(root, "current"), old.target); await Deno.remove(join(root, "current"));
  await command(["daemon-reload"]);
  console.log("Removed matching managed launcher/menu/icon/unit links. State, cache, plugins, browser profiles and previous application versions were retained.");
}
