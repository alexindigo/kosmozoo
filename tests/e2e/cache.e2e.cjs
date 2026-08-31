// tests/e2e/cache.e2e.cjs — stale-while-revalidate against the live engine:
// a file rewritten in place under the SAME filename is picked up without
// ever blocking a request, and the per-file debounce holds between checks.
// Pure HTTP — the browser is not involved. Two remotes, two stamp kinds:
// the `mut` folder host (mtime stamp) and the `fake` ComfyUI host serving
// one mutable file with an aiohttp-style ETag. run.sh wires both with
// KOZMOZOO_REVALIDATE_MS=1500 and mounts this worktree, so the rewrites
// here are visible to the engine immediately.
const ENGINE = process.env.E2E_ENGINE;
const FILE = "/work/tests/.tmp-mutable/flux-basic.png";
const ID = encodeURIComponent("mut:flux-basic.png");
const CFILE = "/work/tests/.tmp-comfy/mut.png";
const CID = encodeURIComponent("fake:mut.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (m) => console.log("  [ ok ] " + m);
const fail = (m) => { console.error("  [fail] " + m); process.exit(1); };

const getBytes = async (id) => {
  const r = await fetch(`${ENGINE}/api/images/${id}/bytes`);
  if (r.status !== 200) fail(`bytes route returned ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
};
const rewrite = async (file, tag) => {
  const { writeFile, utimes } = require("node:fs/promises");
  await writeFile(file, `MUTATED ${tag} — ${Date.now()}`);
  const t = new Date(Date.now() + 5000); // clearly newer mtime → new stamp
  await utimes(file, t, t);
};

(async () => {
  // === folder host (mtime stamp) ===========================================

  // 1. first request ingests the fixture content
  const v1 = await getBytes(ID);
  if (!v1.subarray(1, 4).equals(Buffer.from("PNG"))) fail("first serve is not the fixture PNG");
  ok("first request ingests and serves the source file");

  // 2. rewrite in place; the next request still serves the cache (stale),
  //    and fires the async check
  await rewrite(FILE, "v2");
  const stale = await getBytes(ID);
  if (!stale.equals(v1)) fail("request after change must still serve the cached bytes");
  ok("change #1: the triggering request is still served from cache");

  // 3. the background check remapped — the next request serves fresh bytes
  await sleep(700);
  const v2 = await getBytes(ID);
  if (!v2.toString().startsWith("MUTATED v2")) fail(`fresh serve missing: ${v2.subarray(0, 24)}`);
  ok("change #1: the next request serves the new content");

  // 4. rewrite again INSIDE the debounce window of the check from step 2 —
  //    no new check may run, so the served bytes stay v2
  await rewrite(FILE, "v3");
  const debounced = await getBytes(ID);
  if (!debounced.equals(v2)) fail("debounce broken: bytes changed inside the window");
  await sleep(300);
  const stillDebounced = await getBytes(ID);
  if (!stillDebounced.equals(v2)) fail("debounce broken: background remap inside the window");
  ok("change #2 inside the debounce window is not re-checked");

  // 5. after the window passes, the cycle repeats: stale serve + check, then fresh
  await sleep(1300);
  const stale2 = await getBytes(ID); // fires the check (window elapsed)
  if (!stale2.equals(v2)) fail("pre-check serve should still be v2");
  await sleep(700);
  const v3 = await getBytes(ID);
  if (!v3.toString().startsWith("MUTATED v3")) fail(`second cycle stuck: ${v3.subarray(0, 24)}`);
  ok("change #2: after the window, the next request serves the new content");

  // === ComfyUI host (ETag stamp) — the reused-filename case ================

  // 6. first request ingests the mutable file through the fake ComfyUI
  await rewrite(CFILE, "c1");
  const c1 = await getBytes(CID);
  if (!c1.toString().startsWith("MUTATED c1")) fail(`comfy first serve wrong: ${c1.subarray(0, 24)}`);
  ok("comfy: first request ingests and serves the source file");

  // 7. same filename, new content → new ETag; the triggering request is
  //    stale, the next one is fresh
  await rewrite(CFILE, "c2");
  const cStale = await getBytes(CID);
  if (!cStale.equals(c1)) fail("comfy: request after change must still serve the cached bytes");
  ok("comfy: the triggering request is still served from cache");
  await sleep(700);
  const c2 = await getBytes(CID);
  if (!c2.toString().startsWith("MUTATED c2")) fail(`comfy fresh serve missing: ${c2.subarray(0, 24)}`);
  ok("comfy: the next request serves the new content (ETag changed)");

  // 8. debounce holds for the comfy stamp too
  await rewrite(CFILE, "c3");
  const cDebounced = await getBytes(CID);
  if (!cDebounced.equals(c2)) fail("comfy debounce broken: bytes changed inside the window");
  ok("comfy: a change inside the debounce window is not re-checked");

  console.log("CACHE E2E: ALL PASS");
})().catch((e) => fail(e.message));
