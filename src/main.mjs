// One engine operation for compiled CLI, source development and the Deno image.
import { resolveStateDir } from "./state.mjs";
import { buildContext } from "./context.mjs";
import { serveStatic } from "./static.mjs";
import { resolveRuntime, browserOrigin } from "./runtime-config.mjs";
import { acquireInstance, RUNTIME_PROTOCOL, RUNTIME_VERSION } from "./instance.mjs";
import { reportStartupError } from "./startup-error.mjs";
export { reportStartupError } from "./startup-error.mjs";

export async function startEngine({ mode = "source", env = Deno.env.toObject(), lease = null, sourceVersion = "source-development" } = {}) {
  const config = resolveRuntime(mode, env);
  const ownership = lease ?? await acquireInstance(resolveStateDir(env));
  if (!ownership.owner) throw new Error("Another engine owns the selected state; use app mode to open its matching ready instance");
  let server, context, handler, settleHandler, shutdownTask, runtime;
  let httpFinished = false;
  const handlerReady = new Promise(resolve => { settleHandler = resolve; });
  const signals = [];
  const drainHttp = async () => { if (server && !httpFinished) await server.shutdown(); };
  const shutdown = () => {
    if (shutdownTask) return shutdownTask;
    if (runtime) runtime = Object.freeze({ ...runtime, status: "stopping" });
    // Context owns its children and fences source admission synchronously.
    const drainage = context ? context.close({ drainHttp }) : drainHttp();
    shutdownTask = (async () => {
      const failures = [];
      try {
        if (runtime) await ownership.publish(runtime);
      } catch (error) { failures.push(error); }
      try { await drainage; } catch (error) { failures.push(error); }
      for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
      try { await ownership.release(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Engine shutdown failed");
    })();
    return shutdownTask;
  };
  const onSignal = () => { shutdown().catch(error => { reportStartupError(error); Deno.exitCode = 1; }); };
  try {
    // Reserve the requested port before Store/worker construction. A legacy or
    // unrelated listener fails without first-boot seeding or a replacement writer.
    server = Deno.serve({ ...config.binding, onListen() {} }, req => handler ? handler(req) : handlerReady.then(ready => ready(req)));
    server.finished.then(() => { httpFinished = true; });
    runtime = Object.freeze({ protocol: RUNTIME_PROTOCOL, version: RUNTIME_VERSION, instance: ownership.instance,
      sourceVersion, mode, status: "starting", binding: { hostname: server.addr.hostname, port: server.addr.port }, configuredBind: config.binding.hostname });
    await ownership.publish(runtime);
    context = await buildContext({ env, runtime: () => runtime });
    handler = async req => {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return serveStatic(url.pathname);
      try { return await context.router.handle(req); }
      catch (error) { return Response.json({ error: String(error.message ?? error) }, { status: 500 }); }
    };
    runtime = Object.freeze({ ...runtime, status: "ready" });
    await ownership.publish(runtime);
    settleHandler(handler);
    for (const signal of ["SIGINT", "SIGTERM"]) { Deno.addSignalListener(signal, onSignal); signals.push(signal); }
    const browserURL = browserOrigin(runtime.binding);
    const host = runtime.binding.hostname.includes(":") ? `[${runtime.binding.hostname}]` : runtime.binding.hostname;
    console.log(`kosmozoo engine listening on ${host}:${runtime.binding.port}; browser: ${browserURL} (state: ${context.ctx.paths.state})`);
    console.log(`collections: ${Object.keys(context.ctx.hosts).join(", ")}`);
    if (context.discovered.length) console.log(`plugins: ${context.discovered.map(plugin => plugin.name).join(", ")}`);
    const finished = server.finished.then(() => shutdown());
    return Object.freeze({ server, browserURL, runtime: () => runtime, shutdown, finished });
  } catch (error) {
    handler = () => Response.json({ error: "Engine startup failed" }, { status: 503 });
    settleHandler(handler);
    try { await shutdown(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Engine initialization and cleanup failed", { cause: error }); }
    throw error;
  }
}

if (import.meta.main) {
  try { const engine = await startEngine(); await engine.finished; }
  catch (error) { reportStartupError(error); Deno.exitCode = 1; }
}
