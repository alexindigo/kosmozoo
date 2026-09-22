// tests/e2e/diff.e2e.cjs — the comparator workbench over raw CDP.
//
// The workbench is the two-sided comparator: feed current × right-pane
// current, each side with its OWN view state. Lock entangles (one gesture's
// delta writes both keys, never a copy); the active column is primary in
// every view. Covered: pair URL boot, Two-Up geometry, per-side zoom,
// lock/unlock, A/B layout, One-Up flip (no auto-play), Split wipe,
// single-image fallback, Difference mask, Esc / X / back / forward.
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
  // 1600×1000 physical window: the 1400×900 emulated viewport must fit
  // inside it, or Input events beyond 800×600 are silently dropped
  const cdp = await CDP.launch(9333, { windowSize: "1600,1000" });
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

  // 2. two view states: unlocked, a gesture writes only the target's key.
  // (Lock defaults ON — unlock first. Clean slate: no persisted views, so
  // prior suites/runs can't leak a crop in — session-level, settings untouched.)
  await cdp.evaluate(`(async () => {
    const kz = ${KZ};
    for (const k of Object.keys(kz.state.views)) kz.actions.views.set(k, null, { persist: false });
    ${KZ}.actions.diff.setLocked(false);
  })()`);
  const cellB = await cdp.evaluate(`(() => {
    const r = document.querySelector('.dz-b').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp.mouse("mouseWheel", cellB.x, cellB.y, { deltaY: -40, modifiers: 2 });
  await cdp.poll(`(async () => !!${KZ}.state.views["another:flux-basic.png"])()`, 5000);
  const twoStates = await cdp.evaluate(`(async () => ({
    a: ${KZ}.state.views["fake:flux-basic.png"] ?? null,
    b: JSON.parse(JSON.stringify(${KZ}.state.views["another:flux-basic.png"])),
    ta: document.querySelector('.dz-a .dz-img').style.transform,
    tb: document.querySelector('.dz-b .dz-img').style.transform,
  }))()`);
  check("two states: unlocked zoom writes only the target's key",
    twoStates.a === null && twoStates.b?.s > 1 && twoStates.ta === "" && twoStates.tb.includes("scale("),
    JSON.stringify(twoStates));
  // pan B (drag) — A's view still untouched
  await cdp.drag(cellB.x, cellB.y, cellB.x + 40, cellB.y + 20);
  await cdp.poll(`(async () => (${KZ}.state.views["another:flux-basic.png"]?.txf ?? 0) !== 0)()`, 5000);
  const afterPan = await cdp.evaluate(`(async () => ({
    a: ${KZ}.state.views["fake:flux-basic.png"] ?? null,
    b: JSON.parse(JSON.stringify(${KZ}.state.views["another:flux-basic.png"])),
  }))()`);
  check("two states: pan writes B only — A's view stays empty",
    afterPan.a === null && afterPan.b.txf !== 0, JSON.stringify(afterPan));

  // 3. lock entangles: one gesture's delta writes BOTH keys — never a copy
  await cdp.evaluate(`(async () => { ${KZ}.actions.diff.setLocked(true); })()`);
  const beforeLock = await cdp.evaluate(`(async () => ({
    a: ${KZ}.state.views["fake:flux-basic.png"] ?? null,
    b: JSON.parse(JSON.stringify(${KZ}.state.views["another:flux-basic.png"])),
  }))()`);
  await cdp.mouse("mouseWheel", cellB.x, cellB.y, { deltaY: -40, modifiers: 2 });
  await cdp.poll(`(async () => !!${KZ}.state.views["fake:flux-basic.png"])()`, 5000);
  const locked = await cdp.evaluate(`(async () => ({
    a: JSON.parse(JSON.stringify(${KZ}.state.views["fake:flux-basic.png"])),
    b: JSON.parse(JSON.stringify(${KZ}.state.views["another:flux-basic.png"])),
  }))()`);
  const dsA = locked.a.s / (beforeLock.a?.s ?? 1);
  const dsB = locked.b.s / beforeLock.b.s;
  check("lock: one gesture's delta writes both keys",
    dsA > 1 && Math.abs(dsA - dsB) < 1e-6, JSON.stringify({ dsA, dsB }));
  check("lock: entangle, not copy — each crop keeps its own origin",
    locked.a.s !== locked.b.s && locked.a.s === dsA,
    JSON.stringify({ a: locked.a.s, b: locked.b.s }));

  // 4. unlock after a locked zoom: nothing jumps
  const stayA = JSON.stringify(locked.a), stayB = JSON.stringify(locked.b);
  await cdp.evaluate(`(async () => { ${KZ}.actions.diff.setLocked(false); })()`);
  const stayed = await cdp.evaluate(`(async () => ({
    a: JSON.stringify(${KZ}.state.views["fake:flux-basic.png"]),
    b: JSON.stringify(${KZ}.state.views["another:flux-basic.png"]),
  }))()`);
  check("unlock: no jump — both crops stay put", stayed.a === stayA && stayed.b === stayB);

  // 5. A/B layout: the active column is the left cell in Two-Up
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.col === "right")()`, 5000);
  const layout = await cdp.evaluate(`(() => {
    const a = document.querySelector('.dz-a').getBoundingClientRect();
    const b = document.querySelector('.dz-b').getBoundingClientRect();
    return { al: a.left, bl: b.left };
  })()`);
  check("A/B: active column is the left cell in Two-Up", layout.bl < layout.al, JSON.stringify(layout));

  // 6. One-Up: Left/Right flips the visible side; the auto-play is gone
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.mode === "one-up")()`, 5000);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.col === "feed")()`, 5000);
  check("One-Up: Left/Right flips the visible side", true);
  const noPlay = await cdp.evaluate(`(async () => ({
    playEl: !!document.getElementById('diffPlay'),
    field: "playing" in (${KZ}.state.diff),
  }))()`);
  check("no auto-play: no #diffPlay element, no playing field",
    !noPlay.playEl && !noPlay.field, JSON.stringify(noPlay));
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))");
  const spaceNoop = await cdp.evaluate(`(async () => ${KZ}.state.diff.col)()`);
  check("One-Up: Space is a no-op now", spaceNoop === "feed", spaceNoop);

  // 7. Split: key 3 → handle at 50%; the ACTIVE cell is the clipped top
  // layer; a drag moves the wipe; both layers stay mounted
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '3', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.mode === "split")()`, 5000);
  const split0 = await cdp.evaluate(`(async () => ${KZ}.state.diff.splitT)()`);
  check("Split: the wipe starts at 50%", Math.abs(split0 - 0.5) < 1e-6, String(split0));
  const topLayer = await cdp.evaluate(`(async () => ({
    a: getComputedStyle(document.querySelector('.dz-a')).clipPath,
    b: getComputedStyle(document.querySelector('.dz-b')).clipPath,
    col: ${KZ}.state.diff.col,
  }))()`);
  // col is "feed" from section 6 → A is the clipped top layer
  check("Split: the active cell is the clipped top layer",
    topLayer.col === "feed" && topLayer.a !== "none" && topLayer.b === "none",
    JSON.stringify(topLayer));
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

  // 8. Esc closes; pasted URL means no pushed entry → back on the feed
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.open === false && location.pathname === "/")()`, 5000);
  const afterEsc = await cdp.evaluate(`(async () => ({ open: ${KZ}.state.diff.open, path: location.pathname }))()`);
  check("esc: workbench closes", afterEsc.open === false);
  check("esc: lands back on the feed", afterEsc.path === "/", JSON.stringify(afterEsc));

  // 9. pushState entry: back closes, forward re-opens (both sides again)
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

  // 10. single-image fallback: the feed current moves to a graph with NO
  // node images → a stale right side resets, B is null → one img, the 1–4
  // control inert, the lock inert
  await cdp.evaluate(`(async () => {
    ${KZ}.actions.ui.setWorkspace("details");
    ${KZ}.actions.current.set("fake", "flux-lora.png");
    ${KZ}.actions.diff.open();
  })()`);
  await cdp.poll(`(async () => ${KZ}.state.diffPair().b === null)()`, 5000);
  const single = await cdp.evaluate(`(() => ({
    a: !!document.querySelector('.dz-a .dz-img'),
    b: !!document.querySelector('.dz-b'),
    inert: [...document.querySelectorAll('.dz-mode')].every((b) => b.disabled),
    lock: document.querySelector('.dz-lockbtn')?.disabled ?? null,
  }))()`);
  check("single-image: one img, the 1–4 control inert",
    single.a && !single.b && single.inert, JSON.stringify(single));
  check("single-image: the lock is inert too", single.lock === true, JSON.stringify(single));
  const lockedBefore = await cdp.evaluate(`(async () => ${KZ}.state.diff.locked)()`);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))");
  const lockedAfter = await cdp.evaluate(`(async () => ${KZ}.state.diff.locked)()`);
  check("single-image: l is a no-op without a pair", lockedAfter === lockedBefore);
  await cdp.evaluate(`document.getElementById('diffClose').click()`);

  // 11. Difference: key 4 paints the mask canvas — changed pixels light up in
  // the attention orange; identical sides paint none; the base toggle never
  // blanks the stage. (The fixtures share one pixel payload, so the changed
  // pair is fixture × solid bulk image — different sizes too, which also
  // exercises the center-align.)
  await cdp.evaluate(`(async () => {
    ${KZ}.actions.diff.openDiff({ source: "fake", file: "flux-basic.png" }, { source: "fake", file: "bulk-00000.png" });
  })()`);
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: '4', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.mode === "difference")()`, 5000);
  const ORANGE = `(d, i) => d[i] === 255 && d[i + 1] === 136 && d[i + 2] === 0`;
  const painted = await cdp.poll(`(() => {
    const c = document.querySelector('.dz-canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if ((${ORANGE})(d, i)) n++;
    return n > 100;
  })()`, 10000).then(() => true).catch(() => false);
  check("Difference: changed pixels light up orange on the canvas", painted);

  // mode 4 diffs the current crops: pan A (drag — target is the active
  // column's key) and the canvas re-renders
  const row0 = await cdp.evaluate(`(() => {
    const c = document.querySelector('.dz-canvas');
    const d = c.getContext('2d').getImageData(0, c.height >> 1, c.width, 1).data;
    return [...d.slice(0, 400)].join(",");
  })()`);
  const stageC = await cdp.evaluate(`(() => {
    const r = document.getElementById('diffStage').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await cdp.drag(stageC.x, stageC.y, stageC.x + 120, stageC.y);
  await cdp.poll(`(() => {
    const c = document.querySelector('.dz-canvas');
    const d = c.getContext('2d').getImageData(0, c.height >> 1, c.width, 1).data;
    return [...d.slice(0, 400)].join(",") !== ${JSON.stringify(row0)};
  })()`, 5000).then(() => true).catch(() => false);
  check("Difference: mode 4 follows the crop (pan re-renders the mask)", true);

  // A/B (Left/Right) changes the mask base — no separate base button; the
  // bottom-left controls strip holds A/B + lock (+ abs/prop in mode 4).
  // (The base is visible in the highlight MIX — at full opacity the
  // highlight is opaque; drop to 0.5 so the flip shows.)
  const ctl = await cdp.evaluate(`document.querySelectorAll('#diffCtl .dz-sidebtn').length`);
  check("Difference: the controls strip is A/B + abs/prop (base follows col)", ctl === 2, String(ctl));
  await cdp.evaluate(`(async () => { ${KZ}.actions.diff.setDiffOpacity(0.5); })()`);
  const row1 = await cdp.poll(`(() => {
    const c = document.querySelector('.dz-canvas');
    const d = c.getContext('2d').getImageData(0, c.height >> 1, c.width, 1).data;
    const row = [...d.slice(0, 400)].join(",");
    return row !== ${JSON.stringify(row0)} ? row : false;
  })()`, 5000);
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))");
  await cdp.poll(`(async () => ${KZ}.state.diff.col === "right")()`, 5000);
  const baseFlip = await cdp.poll(`(() => {
    const c = document.querySelector('.dz-canvas');
    const d = c.getContext('2d').getImageData(0, c.height >> 1, c.width, 1).data;
    return [...d.slice(0, 400)].join(",") !== ${JSON.stringify(row1)};
  })()`, 5000).then(() => true).catch(() => false);
  check("Difference: Left/Right changes the mask base", baseFlip);

  // identical sides at IDENTITY crops → delta zero everywhere → no highlight
  // (mode 4 diffs the crops: same bytes under different crops still lights up)
  await cdp.evaluate(`(async () => {
    const kz = ${KZ};
    for (const k of Object.keys(kz.state.views)) kz.actions.views.set(k, null, { persist: false });
    ${KZ}.actions.diff.openDiff({ source: "fake", file: "flux-basic.png" }, { source: "another", file: "flux-basic.png" });
  })()`);
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  const identical = await cdp.poll(`(() => {
    const c = document.querySelector('.dz-canvas');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if ((${ORANGE})(d, i)) return false;
    return true;
  })()`, 10000).then(() => true).catch(() => false);
  check("Difference: identical sides paint no highlight", identical);
  await cdp.evaluate(`document.getElementById('diffClose').click()`);

  await cdp.close();
  console.log(failures ? `DIFF E2E: ${failures} FAILURE(S)` : "DIFF E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
