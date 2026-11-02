import { assert, assertEquals } from "jsr:@std/assert";
import { Store } from "../src/store.mjs";
import { Settings } from "../src/settings.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = performance.now() + 15000;
  while (performance.now() < end) { if (await check()) return; await sleep(20); }
  throw new Error("shutdown fixture did not become ready");
}

for (const { signal, stubborn = false } of [{ signal: "SIGTERM" }, { signal: "SIGINT" }, { signal: "SIGTERM", stubborn: true }]) Deno.test(`engine: ${signal} retires connected responses and upstream work${stubborn ? " (uncooperative owner deadline)" : ""}`, async () => {
  const dir = await Deno.makeTempDir({ prefix: "kz-shutdown-" });
  await Deno.mkdir(`${dir}/media`);
  await Deno.writeFile(`${dir}/media/large.webm`, new Uint8Array(16 * 1024 * 1024));
  if (stubborn) {
    await Deno.mkdir(`${dir}/plugins/stuck`, { recursive: true });
    await Deno.writeTextFile(`${dir}/plugins/stuck/plugin.mjs`, `export function register(kz) {
      kz.route("GET", "/hold", async () => { await kz.settings.set("entered", true); await new Promise(() => {}); });
    }`);
  }
  const stopFake = new AbortController(), requests = new Set(), clients = new AbortController();
  const fake = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: stopFake.signal, onListen() {} }, async req => {
    const url = new URL(req.url);
    requests.add(url.pathname === "/api/view" ? url.searchParams.get("filename") : url.pathname);
    if (url.pathname === "/api/queue") {
      await new Promise(resolve => req.signal.addEventListener("abort", resolve, { once: true }));
      return Response.json({ queue_running: [], queue_pending: [] });
    }
    if (url.pathname === "/api/view" && req.method !== "HEAD") {
      let timer;
      return new Response(new ReadableStream({
        start(c) { timer = setInterval(() => c.enqueue(new Uint8Array(1024)), 100); },
        cancel() { clearInterval(timer); },
      }));
    }
    if (url.pathname === "/api/history") return Response.json({});
    if (url.pathname === "/internal/files/output") return Response.json([]);
    return new Response(null, { status: 404 });
  });
  const reservation = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = reservation.addr.port; reservation.close();
  const binary = Deno.env.get("KZ_SHUTDOWN_BINARY");
  const child = new Deno.Command(binary ?? Deno.execPath(), {
    args: binary ? ["serve"] : ["run", "--frozen", "--cached-only", "--allow-all", "src/main.mjs"],
    env: { KOZMOZOO_BIND: "127.0.0.1", KOZMOZOO_PORT: String(port), KOZMOZOO_STATE: `${dir}/state`,
      KOZMOZOO_CACHE: `${dir}/cache`, KOZMOZOO_HOSTS: `fake=127.0.0.1:${fake.addr.port},media=folder:${dir}/media`,
      KOZMOZOO_FEEDBACK: `${dir}/absent.json`, KOZMOZOO_PLUGINS: `${dir}/plugins`, HOME: dir, TMPDIR: dir },
    stdout: "piped", stderr: "piped",
  }).spawn();
  const output = child.output();
  const origin = `http://127.0.0.1:${port}`;
  let exited = false;
  let slowClient;
  child.status.then(() => { exited = true; });
  try {
    await until(async () => { try { return (await fetch(`${origin}/api/runtime`)).ok; } catch { return false; } });
    assertEquals((await fetch(`${origin}/api/settings/core.shutdown-test`, { method: "PATCH", body: JSON.stringify({ intact: "saved" }) })).status, 200);
    assertEquals((await fetch(`${origin}/api/collections/fake/entries/saved.png/judgment`, { method: "PATCH", body: JSON.stringify({ bookmark: true }) })).status, 200);
    await (await fetch(`${origin}/api/collections/media/entries/large.webm/bytes`)).arrayBuffer();
    slowClient = await Deno.connect({ hostname: "127.0.0.1", port });
    await slowClient.write(new TextEncoder().encode("GET /api/collections/media/entries/large.webm/bytes HTTP/1.1\r\nHost: localhost\r\n\r\n"));
    const header = new Uint8Array(256);
    assert((await slowClient.read(header)) > 0, "slow media reader has an active response");
    const events = await fetch(`${origin}/api/events`, { signal: clients.signal });
    const reader = events.body.getReader();
    assert(!(await reader.read()).done);
    const pending = ["/api/collections/fake/entries/wait.png/meta", "/api/collections/fake/entries/movie.webm/bytes"]
      .map(path => fetch(origin + path, { signal: clients.signal }).then(r => r.arrayBuffer()).catch(() => null));
    if (stubborn) {
      pending.push(fetch(`${origin}/api/plugins/stuck/hold`, { signal: clients.signal }).catch(() => null));
      await until(async () => (await (await fetch(`${origin}/api/settings/plugins.stuck`)).json()).entered === true);
    }
    await until(() => requests.has("/api/queue") && requests.has("wait.png") && requests.has("movie.webm"));
    const started = performance.now();
    child.kill(signal);
    const bound = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5500);
    const result = await output;
    clearTimeout(bound);
    const elapsed = performance.now() - started;
    console.log(`${signal} exit=${result.code} elapsed=${elapsed.toFixed(1)}ms\n${new TextDecoder().decode(result.stderr)}`);
    assert(elapsed < 5000, `shutdown exceeded grace: ${elapsed.toFixed(1)}ms`);
    assertEquals(result.code, 0);
    if (stubborn) {
      assert(elapsed >= 3900, "the deadline, not an early crash, ended the uncooperative owner");
      assert(new TextDecoder().decode(result.stderr).includes("GET /api/plugins/stuck/hold handler"), "deadline names the remaining owner");
    }
    clients.abort(); await Promise.all(pending); await reader.cancel().catch(() => {});
    const settings = await Settings.open(`${dir}/state`);
    assertEquals(settings.get("core.shutdown-test", "intact"), "saved");
    const store = await Store.open(`${dir}/state`, { settings });
    try { assertEquals(store.judgmentGet("fake", "saved.png"), { bookmark: true }); }
    finally { store.close(); }
  } finally {
    slowClient?.close();
    clients.abort();
    if (!exited) { child.kill("SIGKILL"); await output; }
    stopFake.abort(); await fake.finished;
    await Deno.remove(dir, { recursive: true });
  }
});
