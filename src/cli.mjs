// Native selection precedes the literal dynamic engine import. Help/settings/
// installation do not initialize Context/Store or evaluate the SQLite graph.
import { bootstrapNativeSqlite } from "./native-sqlite.mjs";
import { resolveRuntime } from "./runtime-config.mjs";
import { acquireInstance, matchingInstance, RUNTIME_PROTOCOL, RUNTIME_VERSION } from "./instance.mjs";
import { resolveStateDir } from "./state.mjs";
import { reportStartupError } from "./startup-error.mjs";

const provenancePath = new URL("../packaging/linux/resources/provenance.json", import.meta.url);
async function provenance() { return JSON.parse(await Deno.readTextFile(provenancePath)); }
export function parseCommand(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help" };
  if (args.length === 1 && args[0] === "--version") return { command: "version" };
  const command = args[0] ?? "app", rest = args.slice(1);
  if (["app", "serve"].includes(command)) {
    if (command === "serve" && rest.length || rest.length > 1 || rest.length && !rest[0].startsWith("--browser=")) throw new Error("Use app [--browser=/absolute/executable] or serve");
    return { command, ...(rest.length ? { browser: rest[0].slice("--browser=".length) } : {}) };
  }
  if (command === "install" && (!rest.length || rest.length === 1 && rest[0] === "--service")) return { command, service: rest.length === 1 };
  if (command === "uninstall" && !rest.length) return { command };
  if (command === "browser-settings" && rest.length === 1 && rest[0] === "firefox") return { command, provider: "firefox" };
  throw new Error("Unknown command/options; use --help");
}
export async function runCommand(args = Deno.args, env = Deno.env.toObject()) {
  const options = parseCommand(args);
  if (options.command === "help") {
    console.log("kosmozoo [app [--browser=/absolute/executable] | serve | install [--service] | uninstall | browser-settings firefox]\nApp defaults to loopback2084; serve/source/Docker to0.0.0.0:2084. Explicit KOZMOZOO_BIND/PORT win. Browser closure keeps submitted work running; stop the engine explicitly with SIGINT/SIGTERM or its managed user unit.");
    return;
  }
  const input = await provenance();
  if (options.command === "version") { console.log(`kosmozoo ${input.commit ?? input.kind} (input ${input.sourceInputSha256 ?? "working-source"}; Deno ${input.compiler}; ${input.target})`); return; }
  if (options.command === "browser-settings") { const { firefoxSettings } = await import("./desktop/launcher.mjs"); await firefoxSettings(env); return; }
  if (options.command === "install" || options.command === "uninstall") {
    const helper = await import("./desktop/install.mjs");
    if (options.command === "install") await helper.install({ env, service: options.service, provenance: input }); else await helper.uninstall(env);
    return;
  }
  const config = resolveRuntime(options.command, env);
  const lease = await acquireInstance(resolveStateDir(env));
  if (!lease.owner) {
    if (options.command !== "app") throw new Error("Another engine owns this state; use app to open its matching ready instance");
    const ready = await matchingInstance(lease, config);
    console.log(`Reusing ${ready.runtime.mode} engine at ${ready.runtime.binding.hostname}:${ready.runtime.binding.port}; browser: ${ready.browserURL}`);
    const { launchBrowser } = await import("./desktop/launcher.mjs");
    await launchBrowser(ready.browserURL, { env, browser: options.browser });
    return;
  }
  let engine;
  try {
    const sourceVersion = input.sourceInputSha256 ?? "source-development";
    await lease.publish({ protocol: RUNTIME_PROTOCOL, version: RUNTIME_VERSION, instance: lease.instance, sourceVersion,
      mode: options.command, status: "starting", binding: config.binding, configuredBind: config.binding.hostname });
    await bootstrapNativeSqlite(env);
    const { startEngine } = await import("./main.mjs");
    engine = await startEngine({ mode: options.command, env, lease, sourceVersion });
    if (options.command === "app") {
      const { launchBrowser } = await import("./desktop/launcher.mjs");
      await launchBrowser(engine.browserURL, { env, browser: options.browser });
    }
    await engine.finished;
  } finally { if (engine) await engine.shutdown(); else await lease.release(); }
}

if (import.meta.main) {
  try { await runCommand(); }
  catch (error) {
    reportStartupError(error);
    Deno.exitCode = 1;
  }
}
