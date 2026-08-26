// tests/e2e/cache.e2e.cjs — stale-while-revalidate against the live engine:
// a folder-remote file rewritten in place is picked up without ever blocking
// a request, and the per-file debounce holds between checks. Pure HTTP — the
// browser is not involved. run.sh registers the `mut` folder host on the
// engine with KOZMOZOO_REVALIDATE_MS=1500 and mounts this worktree, so the
// rewrite here is visible to the engine immediately.
const ENGINE = process.env.E2E_ENGINE;
const FILE = "/work/tests/.tmp-mutable/flux-basic.png";
const ID = encodeURIComponent("mut:flux-basic.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log("  [ ok ] " + m);
const fail = (m) => { console.error("  [fail] " + m); process.exit(1); };

const getBytes = async () => {
  const r = await fetch(`${ENGINE}/api/images/${ID}/bytes`);
  if (r.status !== 200) fail(`bytes route returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const rewrite = async (tag) => {
  const { writeFile, utimes } = require("node:fs/promises");
  await writeFile(FILE, `MUTATED ${tag} — ${Date.now()}`);
  const t = new Date(Date.now() + 5000); // clearly newer mtime
  await utimes(FILE, t, t);
};

(async () => {
  // 1. first request ingests the fixture content
  const v1 = await getBytes();
  if (!v1.subarray(1, 4).equals(Buffer.from("PNG"))) fail("first serve is not the fixture PNG");
  ok("first request ingests and serves the source file");

  // 2. rewrite in place; the next request still serves the cache (stale),
  //    and fires the async check
  await rewrite("v2");
  const stale = await getBytes();
  if (!stale.equals(v1)) fail("request after change must still serve the cached bytes");
  ok("change #1: the triggering request is still served from cache");

  // 3. the background check remapped — the next request serves fresh bytes
  await sleep(700);
  const v2 = await getBytes();
  if (!v2.toString().startsWith("MUTATED v2")) fail(`fresh serve missing: ${v2.subarray(0, 24)}`);
  ok("change #1: the next request serves the new content");

  // 4. rewrite again INSIDE the debounce window of the check from step 2 —
  //    no new check may run, so the served bytes stay v2
  await rewrite("v3");
  const debounced = await getBytes();
  if (!debounced.equals(v2)) fail("debounce broken: bytes changed inside the window");
  await sleep(300);
  const stillDebounced = await getBytes();
  if (!stillDebounced.equals(v2)) fail("debounce broken: background remap inside the window");
  ok("change #2 inside the debounce window is not re-checked");

  // 5. after the window passes, the cycle repeats: stale serve + check, then fresh
  await sleep(1300);
  const stale2 = await getBytes(); // fires the check (window elapsed)
  if (!stale2.equals(v2)) fail("pre-check serve should still be v2");
  await sleep(700);
  const v3 = await getBytes();
  if (!v3.toString().startsWith("MUTATED v3")) fail(`second cycle stuck: ${v3.subarray(0, 24)}`);
  ok("change #2: after the window, the next request serves the new content");

  console.log("CACHE E2E: ALL PASS");
})().catch((e) => fail(e.message));
