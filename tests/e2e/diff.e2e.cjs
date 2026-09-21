// tests/e2e/diff.e2e.cjs — the comparator workbench over raw CDP.
//
// The workbench is the two-sided comparator: feed current × right-pane
// current. Covered here: pair URL boot (both sides), Two-Up geometry,
// One-Up blink (decode-guarded, view-stable), Split wipe, single-image
// fallback (no B → inert mode control), shared zoom (never page zoom),
// Esc / X / back / forward close paths.
//
// Run via tests/e2e/run.sh.

const { CDP } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";

// the app store is a plain ES-module singleton — importing the served URL
// returns THE instance the app booted (no window global). evaluate/poll
// await the returned promise (awaitPromise), so each probe wraps in an
// async IIFE.
const KZ = `(await import("/store/instance.js")).appStore`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  [ ok ] " : "  [FAIL] "}${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

(async () => {
  const cdp = await CDP.launch();
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1. pasted pair URL boots the comparator with BOTH sides — left is the
  // feed current, right the right-pane current; Two-Up is the default view
  await cdp.goto(ENGINE + "/diff#fake#flux-basic.png:another#flux-basic.png");
  await cdp.poll(`(async () => !!${KZ}.state.diff.open)()`, 20000);
  await cdp.poll(`document.querySelector('.dz-a .dz-img')?.src.includes('/fake/')`, 10000);
  await cdp.poll(`document.querySelector('.dz-b .dz-img')?.src.includes('/another/')`, 10000);
  check("boot: pair URL opens with both sides", true);
  const bootMode = await cdp.evaluate(`(async () => ${KZ}.state.diff.mode)()`);
  check("boot: Two-Up is the default view", bootMode === "two-up", bootMode);

  // 1b. Two-Up geometry: two cells on a shared horizontal midline, A left
  const twoUpGeom = await cdp.evaluate(`(() => {
    const a = document.querySelector('.dz-a').getBoundingClientRect();
    const b = document.querySelector('.dz-b').getBoundingClientRect();
    return { acy: a.top + a.height / 2, bcy: b.top + b.height / 2, left: a.left < b.left };
  })()`);
  check("Two-Up: cells share the horizontal midline, A left of B",
    Math.abs(twoUpGeom.acy - twoUpGeom.bcy) < 1 && twoUpGeom.left,
    JSON.stringify(twoUpGeom));

  // 2. shared zoom: ctrl+wheel over the stage zooms the LAYERS (one view
  // state), never the page; the view persists under the feed side's key
  const pre = await cdp.evaluate(`(() => {
    const img = document.querySelector('.dz-a .dz-img');
    const r = img.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio };
  })()`);
  await cdp.mouse("mouseWheel", pre.x, pre.y, { deltaY: -240, modifiers: 2 });
  await cdp.poll(`(document.querySelector('.dz-a .dz-img').style.transform ?? "").includes("scale(")`, 5000);
  const zoomed = await cdp.evaluate(`({
    ta: document.querySelector('.dz-a .dz-img').style.transform,
    tb: document.querySelector('.dz-b .dz-img').style.transform,
    dpr: window.devicePixelRatio,
  })`);
  check("zoom: both layers get the shared transform",
    zoomed.ta.includes("scale(") && zoomed.ta === zoomed.tb, JSON.stringify(zoomed));
  check("zoom: page did NOT zoom", zoomed.dpr === pre.dpr, `dpr ${pre.dpr} -> ${zoomed.dpr}`);
  await cdp.poll(`(async () => !!${KZ}.state.views["fake:flux-basic.png"])()`, 5000);
  check("zoom: view persisted under the feed side's key", true);

  // 3. One-Up blink: key 2 → one side; Space plays; after an interval the
  // visible column flips — the view transform is unchanged across the swap
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.mode === "one-up")()`, 5000);
  const t0 = await cdp.evaluate(`document.querySelector('.dz-a .dz-img').style.transform`);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.playing === true)()`, 5000);
  await cdp.poll(`(async () => ${KZ}.state.diff.col === "right")()`, 5000);
  const oneUp = await cdp.evaluate(`(async () => ({
    col: ${KZ}.state.diff.col,
    t: document.querySelector('.dz-a .dz-img').style.transform,
  }))()`);
  check("One-Up: play flips the visible column after an interval",
    oneUp.col === "right", JSON.stringify(oneUp));
  check("One-Up: the view transform is unchanged across the swap",
    oneUp.t === t0, `${t0} -> ${oneUp.t}`);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.playing === false)()`, 5000);
  check("One-Up: Space pauses the blink", true);

  // 4. Split: key 3 → handle at 50%; a drag moves the wipe (in stage
  // fraction); both layers stay mounted
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.mode === "split")()`, 5000);
  const split0 = await cdp.evaluate(`(async () => ${KZ}.state.diff.splitT)()`);
  check("Split: the wipe starts at 50%", Math.abs(split0 - 0.5) < 1e-6, String(split0));
  const wipe = await cdp.evaluate(`(() => {
    const r = document.querySelector('.dz-wipe').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: window.innerWidth };
  })()`);
  await cdp.drag(wipe.x, wipe.y, wipe.x + wipe.w * 0.2, wipe.y);
  await cdp.poll(`(async () => Math.abs(${KZ}.state.diff.splitT - 0.5) > 0.1)()`, 5000);
  const splitState = await cdp.evaluate(`(async () => ({
    t: ${KZ}.state.diff.splitT,
    mounted: !!document.querySelector('.dz-a .dz-img') && !!document.querySelector('.dz-b .dz-img'),
  }))()`);
  check("Split: the drag moves the wipe in stage fraction",
    splitState.t > 0.6 && splitState.t < 0.8, JSON.stringify(splitState));
  check("Split: both layers stay mounted", splitState.mounted);

  // 5. Esc closes; pasted URL means no pushed entry → back on the feed
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.open === false && location.pathname === "/")()`, 5000);
  const afterEsc = await cdp.evaluate(`(async () => ({ open: ${KZ}.state.diff.open, path: location.pathname }))()`);
  check("esc: workbench closes", afterEsc.open === false);
  check("esc: lands back on the feed", afterEsc.path === "/", JSON.stringify(afterEsc));

  // 6. pushState entry: back closes, forward re-opens (both sides again)
  await cdp.evaluate(`(async () => { ${KZ}.actions.diff.openDiff({ source: 'fake', file: 'flux-basic.png' }, { source: 'another', file: 'flux-basic.png' }, { push: true }); })()`);
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  await cdp.evaluate("history.back()");
  await cdp.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);
  check("back: closes the workbench", true);
  await cdp.evaluate("history.forward()");
  await cdp.poll(`(async () => ${KZ}.state.diff.open && !!document.querySelector('.dz-b .dz-img'))()`, 5000);
  check("forward: re-opens the workbench with both sides", true);
  // X closes too
  await cdp.evaluate(`document.getElementById('diffClose').click()`);
  await cdp.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);
  check("x: closes the workbench", true);

  // 7. single-image fallback: the feed current moves to a graph with NO
  // node images → a stale right side resets, B is null → one img, the 1–4
  // control inert
  await cdp.evaluate(`(async () => {
    ${KZ}.actions.ui.setWorkspace("details");
    ${KZ}.actions.current.set("fake", "flux-lora.png");
    ${KZ}.actions.diff.open();
  })()`);
  await cdp.poll(`(async () => ${KZ}.state.diffPair().b === null)()`, 5000);
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  const single = await cdp.evaluate(`(() => ({
    a: !!document.querySelector('.dz-a .dz-img'),
    b: !!document.querySelector('.dz-b'),
    inert: [...document.querySelectorAll('.dz-mode')].every((b) => b.disabled),
  }))()`);
  check("single-image: one img, the 1–4 control inert",
    single.a && !single.b && single.inert, JSON.stringify(single));
  await cdp.evaluate(`document.getElementById('diffClose').click()`);

  await cdp.close();
  console.log(failures ? `DIFF E2E: ${failures} FAILURE(S)` : "DIFF E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
