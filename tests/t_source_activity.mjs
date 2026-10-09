import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import { Jobs, ProgressLog, operationProgress } from "../src/jobs.mjs";
import { comfyClient } from "../src/backings/comfy.mjs";
import { buildContext } from "../src/context.mjs";
import { mkStateRig } from "./helpers/rig.mjs";

const done = (id, outcome = "success") => ({ id, terminal: true, outcome });
const defer = () => { let resolve; const promise = new Promise((r) => resolve = r); return { promise, resolve }; };
function rig() {
  const hosts = { a: "one:8188", alias: "one:8188", folder: "folder:/tmp", b: "two:8188" };
  const calls = [], events = [], timers = new Map();
  let timerId = 0, incarnation = 0, now = 1;
  const data = Object.fromEntries(["one:8188", "two:8188"].map((address) => [address, {
    queue: { running: [], pending: [] }, history: [], logs: { entries: [], size: 0 }, failure: null,
  }]));
  const jobs = new Jobs({ hosts, clock: () => now, epoch: () => String(++incarnation),
    setTimer(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    onFinish(address, sources, snapshot) { events.push({ address, sources: [...sources], snapshot }); },
    client(address) {
      const d = data[address];
      return Object.fromEntries(["queue", "history", "logs"].map((method) => [method, async (options) => {
        calls.push({ address, method, options });
        if (d.failure && method !== "logs") throw new Error(d.failure);
        if (method === "history") return d.history.filter((e) => !options.promptId || options.promptId === e.id)
          .slice(options.maxItems === undefined ? 0 : -options.maxItems);
        if (typeof d[method] === "function") return d[method](options);
        return structuredClone(d[method]);
      }]));
    },
  });
  return { jobs, hosts, data, calls, events, timers, time: (t) => now = t };
}

Deno.test("activity: startup baseline, aliases and folders, between-poll finishes, outcome dedup", async () => {
  const r = rig(), d = r.data["one:8188"];
  d.history = [done("old")];
  d.queue = { running: ["external-client-job"], pending: ["next"] };
  assertEquals(r.jobs.snapshot("a").state, "unknown");
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 0);
  assertEquals(r.jobs.snapshot("alias"), r.jobs.snapshot("a"));
  assertEquals(r.jobs.snapshot("folder").supported, false);
  assertEquals(r.calls.filter((c) => c.method === "queue" && c.address === "one:8188").length, 2);
  assert(!r.calls.some((c) => c.address.startsWith("folder:")));
  d.history.push(done("external-client-job"), done("between", "error"), done("another", "interrupted"));
  d.queue = { running: ["next"], pending: ["later"] };
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 3);
  assertEquals(r.jobs.snapshot("a").runningPromptId, "next");
  assertEquals(r.events[0].sources, ["a", "alias"]);
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 3);
  assertEquals(r.events.length, 1);
  await r.jobs.stop();
});

Deno.test("activity: history expands beyond latest 64 to previous completion boundary", async () => {
  const r = rig(), d = r.data["one:8188"];
  d.history = [done("boundary")];
  await r.jobs.tick();
  d.history.push(...Array.from({ length: 270 }, (_, i) => done(`new-${i}`)));
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 270);
  assertEquals(r.calls.filter((c) => c.address === "one:8188" && c.method === "history").slice(-4).map((c) => c.options.maxItems), [64, 128, 256, 512]);
  assertEquals(r.jobs.snapshot("a").historyGap, false);
  await r.jobs.stop();
});

Deno.test("activity: an empty startup history still reconciles every finish in a burst larger than the first window", async () => {
  const r = rig(), d = r.data["one:8188"];
  await r.jobs.tick();
  d.history = Array.from({ length: 270 }, (_, i) => done(`first-${i}`));
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 270);
  assertEquals(r.jobs.snapshot("a").historyGap, false);
  await r.jobs.stop();
});

Deno.test("activity: unresolved disappearance retries targeted history, terminal beats stale queue", async () => {
  const r = rig(), d = r.data["one:8188"];
  d.queue.running = ["job"];
  await r.jobs.tick();
  d.queue.running = [];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 0);
  await r.jobs.tick();
  assertEquals(r.calls.filter((c) => c.options.promptId === "job").length, 2);
  d.history.push(done("job", "error"));
  d.queue.running = ["job"];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").state, "idle");
  assertEquals(r.jobs.snapshot("a").terminalRevision, 1);
  await r.jobs.stop();
});

Deno.test("activity: gaps/reconnect catch up without inventing finishes or replaying IDs", async () => {
  const r = rig(), d = r.data["one:8188"];
  d.history = [done("old")];
  await r.jobs.tick();
  d.failure = "offline";
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").state, "disconnected");
  assertEquals(r.jobs.snapshot("b").state, "idle");
  d.failure = null;
  d.history = [];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 0);
  assertEquals(r.jobs.snapshot("a").resyncRevision, 2);
  assertEquals(r.jobs.snapshot("a").historyGap, true);
  d.history = [done("old"), done("new")];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").terminalRevision, 1);
  await r.jobs.stop();
});

Deno.test("activity: start:false, independent backoff, removal/abort and fresh re-add generation", async () => {
  const r = rig();
  assertEquals(r.timers.size, 0);
  r.jobs.start();
  assertEquals(r.timers.size, 2);
  r.data["one:8188"].failure = "offline";
  for (let i = 0; i < 7; i++) await r.jobs.tick();
  assertEquals([...r.timers.values()].map((t) => t.delay).sort((a, b) => a - b), [5000, 30000]);
  r.data["one:8188"].failure = null;
  const pending = defer();
  let signal;
  r.data["one:8188"].queue = (o) => { signal = o.signal; return pending.promise; };
  const before = r.jobs.snapshot("a").epoch;
  const tick = r.jobs.tick("one:8188");
  for (let i = 0; i < 20 && !signal; i++) await Promise.resolve();
  assert(signal, "the owned primary queue request reached the backing before retirement");
  delete r.hosts.a;
  r.jobs.reconcile();
  assertEquals(signal.aborted, false, "remaining alias keeps the address owned");
  delete r.hosts.alias;
  r.jobs.reconcile();
  assertEquals(signal.aborted, true);
  r.hosts.a = "one:8188";
  r.jobs.reconcile();
  assert(r.jobs.snapshot("a").epoch !== before);
  pending.resolve({ running: ["late"], pending: [] });
  await tick;
  assertEquals(r.jobs.snapshot("a").state, "unknown", "late old incarnation cannot mutate the new one");
  await r.jobs.stop();
  assertEquals(r.timers.size, 0);
});

Deno.test("activity progress: ANSI/CR, fragments, overwrite, rollover, prompt fencing and slow steps", () => {
  assertEquals(operationProgress("\x1b[32m 25%|██ | 10/40 [02:04<04:00, 12.4s/it]\x1b[0m\r"), { value: 10, max: 40, fraction: .25 });
  assertEquals(operationProgress("download: 4/10 MB 4MB/s"), null);
  assertEquals(operationProgress(" 50%|██ | 512/1024 [00:01<00:01, 1.4MB/s]\r"), null);
  assertEquals(operationProgress("steps 10/40\rdownload 1/4 MB/s"), { value: 10, max: 40, fraction: .25 });
  assertEquals(operationProgress("download 1/4 MB/s\rsteps 2/40"), { value: 2, max: 40, fraction: .05 });
  assertEquals(operationProgress("1/0 -1/4 NaN/7"), null);
  assertEquals(operationProgress("101/100"), { value: 101, max: 100, fraction: 1 });
  const log = new ProgressLog();
  const buffer = (messages) => ({ entries: messages.map((m) => ({ t: 1, m })), size: messages.length });
  assertEquals(log.sample(buffer(["100%| 40/40\r"]), "A"), null);
  assertEquals(log.sample(buffer(["100%| 40/40\r", "steps 1/"]), "A"), null);
  assertEquals(log.sample(buffer(["100%| 40/40\r", "steps 1/", "40\r"]), "A"), { value: 1, max: 40, fraction: .025 });
  assertEquals(log.sample(buffer(["100%| 40/40\r", "steps 2/", "40\r"]), "A"), { value: 2, max: 40, fraction: .05 });
  assertEquals(log.sample(buffer(["steps 2/", "40\r", "stage 0/8\r"]), "A"), { value: 0, max: 8, fraction: 0 });
  assertEquals(log.sample(buffer(["steps 2/", "40\r", "stage 0/8\r"]), "A"), { value: 0, max: 8, fraction: 0 });
  assertEquals(log.sample(buffer(["unrelated buffer replaced 8/8"]), "A"), null);
  assertEquals(log.sample(buffer(["unrelated buffer replaced 8/8", "fresh 1/8"]), "A"), { value: 1, max: 8, fraction: .125 });
  assertEquals(log.sample(buffer(["unrelated buffer replaced 8/8", "fresh 1/8"]), "B"), null);
});

Deno.test("activity: bracketed counters remain through a 124s step and clear on prompt/idle/disconnect", async () => {
  const r = rig(), d = r.data["one:8188"];
  d.queue.running = ["A"];
  d.logs = { entries: [{ t: 1, m: "0/40\r" }], size: 1 };
  await r.jobs.tick();
  d.logs.entries.push({ t: 1, m: "1/40\r" });
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").progress.value, 1);
  r.time(124001);
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").progress.value, 1);
  d.queue.running = ["B"];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").progress, null);
  d.queue.running = ["B", "C"];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").progress, null);
  d.queue.running = [];
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").state, "idle");
  d.failure = "offline";
  await r.jobs.tick();
  assertEquals(r.jobs.snapshot("a").progress, null);
  await r.jobs.stop();
});

Deno.test("activity backing: validates GET shapes/status, strips graphs/client IDs and owner abort", async () => {
  let payload = { queue_running: [[1, "prompt", {}, { client_id: "external" }]], queue_pending: [] };
  const requests = [];
  const client = comfyClient("fake:8188", { fetcher(url, options) {
    requests.push({ url, options });
    return Promise.resolve(Response.json(payload));
  } });
  assertEquals(await client.queue(), { running: ["prompt"], pending: [] });
  assertEquals(requests[0].url, "http://fake:8188/api/queue");
  payload = { prompt: { prompt: [1, "prompt", { graph: true }], status: { completed: false, status_str: "error", messages: [["execution_interrupted", {}]] } } };
  assertEquals(await client.history({ maxItems: 64 }), [done("prompt", "interrupted")]);
  assert(requests.at(-1).url.endsWith("?max_items=64"));
  payload = null;
  await assertRejects(() => client.queue());
  await assertRejects(() => client.history());
  await assertRejects(() => client.logs());
  const owner = new AbortController();
  payload = { entries: [], size: 0 };
  await client.logs({ signal: owner.signal });
  owner.abort();
  assertEquals(requests.at(-1).options.signal.aborted, true);
  const failed = comfyClient("fake:8188", { fetcher: () => Promise.resolve(new Response("no", { status: 503 })) });
  await assertRejects(() => failed.queue());
});

Deno.test("activity context: constructed before router, start false and canonical relist preferences", async () => {
  const r = await mkStateRig("jobs-context");
  let starts = 0;
  const jobs = { start() { starts++; }, reconcile() {}, subscribe: () => () => {}, snapshot: () => ({ state: "unknown" }) };
  try {
    const { ctx, router } = await buildContext({ start: false, env: { HOME: r.dir }, fakes: {
      stateDir: r.dir, settings: r.settings, store: r.store, cache: r.cache, ingest: r.ingest,
      hosts: r.hosts, plugins: { list: () => [] }, features: [], prefetch: {}, jobs,
    } });
    assertEquals(ctx.jobs, jobs);
    assertEquals(router.ctx.jobs, jobs);
    assertEquals(starts, 0);
  } finally { await r.close(); }
});

Deno.test("activity context: each finish requests relist only for saved enabled aliases; runtime add/remove is reconciled", async () => {
  const r = await mkStateRig("jobs-relist");
  const history = {};
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/history") return Response.json(history);
    if (url.pathname === "/api/queue") return Response.json({ queue_running: [], queue_pending: [] });
    if (url.pathname === "/api/system_stats") return Response.json({});
    return new Response("no", { status: 404 });
  });
  const address = `127.0.0.1:${server.addr.port}`, hosts = { a: address, alias: address };
  const relists = [];
  let ctx;
  try {
    r.store.collectionAdd("a", address, { autoRefresh: true });
    r.store.collectionAdd("alias", address);
    const built = await buildContext({ start: false, env: { HOME: r.dir }, fakes: {
      stateDir: r.dir, settings: r.settings, store: r.store, cache: r.cache, ingest: r.ingest, hosts,
      plugins: { list: () => [] }, features: [], prefetch: { requestRelist: (id) => relists.push(id) },
    } });
    ctx = built.ctx;
    await ctx.jobs.tick();
    history.one = { status: { completed: true, status_str: "success", messages: [] } };
    await ctx.jobs.tick();
    assertEquals(relists, ["a"]);
    r.store.collectionPatch("a", { autoRefresh: false });
    r.store.collectionPatch("alias", { autoRefresh: true });
    history.two = { status: { completed: false, status_str: "error", messages: [["execution_error", {}]] } };
    await ctx.jobs.tick();
    assertEquals(relists, ["a", "alias"]);
    const post = await built.router.handle(new Request("http://x/api/collections", {
      method: "POST", body: JSON.stringify({ name: "late", address, autoRefresh: true }),
    }));
    assertEquals(post.status, 200);
    const epoch = ctx.jobs.snapshot("late").epoch;
    assertEquals(epoch, ctx.jobs.snapshot("a").epoch);
    history.three = { status: { completed: false, status_str: "error", messages: [["execution_interrupted", {}]] } };
    await ctx.jobs.tick();
    assertEquals(relists, ["a", "alias", "alias", "late"]);
    await built.router.handle(new Request("http://x/api/collections/late", { method: "DELETE" }));
    assertEquals(ctx.jobs.monitors.get(address).sources.has("late"), false);
  } finally { await ctx?.jobs.stop(); await server.shutdown(); await r.close(); }
});

Deno.test("activity stop: aborts a live queue request, awaits its settlement and leaves no scheduled work or late state", async () => {
  const r = rig();
  let owner;
  r.data["one:8188"].queue = ({ signal }) => new Promise((_resolve, reject) => {
    owner = signal;
    signal.addEventListener("abort", () => reject(new Error("owner stopped")), { once: true });
  });
  r.jobs.start();
  const snapshot = r.jobs.snapshot("a");
  const tick = r.jobs.tick("one:8188");
  for (let i = 0; i < 20 && !owner; i++) await Promise.resolve();
  assert(owner);
  await r.jobs.stop();
  await tick;
  assertEquals(owner.aborted, true);
  assertEquals(r.timers.size, 0);
  assertEquals(r.jobs.snapshot("a"), snapshot);
});
