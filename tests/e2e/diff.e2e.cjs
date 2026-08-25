// tests/e2e/diff.e2e.cjs — the /diff comparison view over raw CDP.
//
//   pasted /diff URL boots the pair (host-vs-host sources)
//   Esc closes and lands back on the feed URL
//   pushState entry: browser back closes, forward re-opens
//
// Run via tests/e2e/run.sh.

const { CDP, sleep } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  [ ok ] " : "  [FAIL] "}${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

(async () => {
  const cdp = await CDP.launch();
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1. pasted diff URL boots straight into the pair
  await cdp.goto(ENGINE + "/diff#fake#flux-basic.png:another#flux-basic.png");
  await cdp.poll("window.kosmozoo && window.kosmozoo.state.diff.open", 20000);
  await cdp.poll("document.querySelectorAll('#diff img').length === 2 && [...document.querySelectorAll('#diff img')].every(i => i.naturalWidth > 0)", 10000);
  const labels = await cdp.evaluate(`(() => ({
    l: document.getElementById("diffLblL").textContent,
    r: document.getElementById("diffLblR").textContent,
  }))()`);
  check("boot: both sides render decoded images", true);
  check("boot: labels name their sources",
    labels.l === "fake#flux-basic.png" && labels.r === "another#flux-basic.png",
    JSON.stringify(labels));

  // 2. Esc closes; pasted URL means no pushed entry → replaceState to feed
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(300);
  const afterEsc = await cdp.evaluate("({ open: window.kosmozoo.state.diff.open, path: location.pathname, hash: location.hash })");
  check("esc: diff closes", afterEsc.open === false);
  check("esc: lands on the feed URL of the left side", afterEsc.path === "/" && afterEsc.hash === "#fake#flux-basic.png", JSON.stringify(afterEsc));

  // 3. pushState entry: back closes, forward re-opens
  await cdp.evaluate("window.kosmozoo.openDiff({ source: 'fake', file: 'flux-basic.png' }, { source: 'another', file: 'flux-basic.png' }, { push: true })");
  await cdp.poll("location.pathname === '/diff'", 5000);
  await cdp.evaluate("history.back()");
  await cdp.poll("window.kosmozoo.state.diff.open === false", 5000);
  const backPath = await cdp.evaluate("location.pathname");
  check("back: closes the diff", backPath === "/");
  await cdp.evaluate("history.forward()");
  await cdp.poll("window.kosmozoo.state.diff.open", 5000);
  check("forward: re-opens the diff", true);

  const key = (k, shift = false) => cdp.evaluate(
    `document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true, cancelable: true }))`);

  // --- composition cycle: flicker -> blend -> split -> difference -> side ---
  await cdp.poll("window.kosmozoo.state.diff.leftList !== null", 5000);
  await key("c");
  const blend = await cdp.evaluate(`(() => ({
    mode: document.getElementById("diffStage").dataset.mode,
    sliderShown: !document.getElementById("diffBlend").hidden,
    topOpacity: getComputedStyle(document.getElementById("diffL")).opacity,
  }))()`);
  check("c: blend mode shows opacity slider", blend.mode === "blend" && blend.sliderShown, JSON.stringify(blend));
  await key("c");
  const split = await cdp.evaluate(`(() => ({
    mode: document.getElementById("diffStage").dataset.mode,
    lineShown: !document.getElementById("diffSplitLine").hidden,
    clip: getComputedStyle(document.getElementById("diffL")).clipPath,
  }))()`);
  check("c: split mode shows draggable wipe", split.mode === "split" && split.lineShown && split.clip !== "none", JSON.stringify(split));
  await key("c");
  const diffm = await cdp.evaluate("getComputedStyle(document.getElementById('diffL')).mixBlendMode");
  check("c: difference sets mix-blend-mode", diffm === "difference", diffm);
  await key("c");
  const side = await cdp.evaluate(`(() => {
    const l = document.getElementById("diffFL").getBoundingClientRect();
    const r = document.getElementById("diffFR").getBoundingClientRect();
    const st = document.getElementById("diffStage").getBoundingClientRect();
    return { mode: document.getElementById("diffStage").dataset.mode, lw: l.width, rw: r.width, sw: st.width };
  })()`);
  check("c: side mode lays two half-width figures", side.mode === "side" && side.lw < side.sw * 0.6 && side.rw < side.sw * 0.6, JSON.stringify(side));
  await key("c"); // back to flicker

  // --- blink: Left/Right swap which side is visible in flicker ---
  const blink1 = await cdp.evaluate("[getComputedStyle(document.getElementById('diffL')).opacity, getComputedStyle(document.getElementById('diffR')).opacity].join(',')");
  await key("ArrowRight");
  const blink2 = await cdp.evaluate("[getComputedStyle(document.getElementById('diffL')).opacity, getComputedStyle(document.getElementById('diffR')).opacity].join(',')");
  check("blink: arrows swap the visible side", blink1 === "1,0" && blink2 === "0,1", `${blink1} -> ${blink2}`);
  await key("ArrowLeft");

  // --- wheel: pinch (ctrl+wheel) zooms, plain scroll pans; dblclick resets ---
  await cdp.evaluate(`(() => {
    const st = document.getElementById("diffStage").getBoundingClientRect();
    document.getElementById("diffStage").dispatchEvent(new WheelEvent("wheel", { clientX: st.x + st.width / 2, clientY: st.y + st.height / 2, deltaY: -240, ctrlKey: true, bubbles: true, cancelable: true }));
  })()`);
  const zoomed = await cdp.evaluate("({ s: window.kosmozoo.state.diff.view.s, t: document.getElementById('diffL').style.transform })");
  check("pinch (ctrl+wheel): zooms the shared view", zoomed.s > 1 && zoomed.t !== "", JSON.stringify(zoomed));
  await cdp.evaluate("document.getElementById('diffStage').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  const reset = await cdp.evaluate("window.kosmozoo.state.diff.view.s");
  check("dblclick: resets the view", reset === 1, `s=${reset}`);
  await cdp.evaluate(`(() => {
    const st = document.getElementById("diffStage").getBoundingClientRect();
    document.getElementById("diffStage").dispatchEvent(new WheelEvent("wheel", { clientX: st.x + st.width / 2, clientY: st.y + st.height / 2, deltaY: -120, bubbles: true, cancelable: true }));
  })()`);
  const panned = await cdp.evaluate("({ s: window.kosmozoo.state.diff.view.s, tyf: window.kosmozoo.state.diff.view.tyf })");
  check("plain scroll: pans without zooming", panned.s === 1 && panned.tyf !== 0, JSON.stringify(panned));
  await cdp.evaluate("document.getElementById('diffStage').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");

  // --- stepping: Up/Down moves the left side (URL follows), Shift moves right ---
  const before = await cdp.evaluate("location.hash");
  await key("ArrowDown");
  await sleep(400);
  const afterL = await cdp.evaluate("({ hash: location.hash, left: window.kosmozoo.state.diff.left.file, lbl: document.getElementById('diffLblL').textContent })");
  check("down: steps the left side and rewrites the URL", afterL.hash !== before && afterL.hash.includes(encodeURIComponent(afterL.left)), JSON.stringify(afterL));
  const rightBefore = await cdp.evaluate("window.kosmozoo.state.diff.right.file");
  await key("ArrowDown", true);
  await sleep(400);
  const afterR = await cdp.evaluate(`(() => ({
    rightSide: location.hash.split(":")[1] ?? "",
    right: window.kosmozoo.state.diff.right.file,
    source: window.kosmozoo.state.diff.right.source,
  }))()`);
  check("shift+down: steps the right side",
    afterR.right !== rightBefore &&
    afterR.rightSide === afterR.source + "#" + encodeURIComponent(afterR.right),
    JSON.stringify(afterR));

  // --- u judges the left image while left is still the feed host ---
  // deterministic: clear any stored judgment first, then press, then poll
  await cdp.evaluate(`(() => {
    const d = window.kosmozoo.state.diff;
    return fetch("/api/judgments/" + encodeURIComponent(d.left.source + ":" + d.left.file), { method: "DELETE" });
  })()`);
  await cdp.evaluate(`(() => {
    const d = window.kosmozoo.state.diff;
    const img = window.kosmozoo.state.images.find(i => i.host === d.left.source &&
      (i.filename === d.left.file || i.filename === d.left.source + "#" + d.left.file));
    if (img?.judgment) delete img.judgment.vote;
  })()`);
  await key("u");
  await cdp.poll(`(() => {
    const d = window.kosmozoo.state.diff;
    const img = window.kosmozoo.state.images.find(i => i.host === d.left.source &&
      (i.filename === d.left.file || i.filename === d.left.source + "#" + d.left.file));
    return img?.judgment?.vote === "up";
  })()`, 5000).catch(() => {});
  const vote = await cdp.evaluate(`(() => {
    const d = window.kosmozoo.state.diff;
    const img = window.kosmozoo.state.images.find(i => i.host === d.left.source &&
      (i.filename === d.left.file || i.filename === d.left.source + "#" + d.left.file));
    return img?.judgment?.vote ?? null;
  })()`);
  check("u: votes the left image up", vote === "up", `vote=${vote}`);
  await cdp.evaluate(`(() => {
    const d = window.kosmozoo.state.diff;
    return fetch("/api/judgments/" + encodeURIComponent(d.left.source + ":" + d.left.file), { method: "DELETE" });
  })()`);

  // --- x swaps the sides ---
  const preSwap = await cdp.evaluate("[window.kosmozoo.state.diff.left.source, window.kosmozoo.state.diff.right.source].join('>')");
  await key("x");
  await sleep(400);
  const postSwap = await cdp.evaluate("[window.kosmozoo.state.diff.left.source, window.kosmozoo.state.diff.right.source].join('>')");
  check("x: swaps the sides", preSwap.split(">").reverse().join(">") === postSwap, `${preSwap} -> ${postSwap}`);

  // --- save both downloads one file per side, host#file names ---
  await cdp.evaluate(`(() => {
    window.__dl = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__dl.push(this.download);
      return orig.apply(this, arguments);
    };
  })()`);
  await cdp.evaluate("document.getElementById('diffSave').click()");
  await sleep(300);
  const dls = await cdp.evaluate(`(() => {
    const d = window.kosmozoo.state.diff;
    return { got: window.__dl, want: [d.left, d.right].map(s => s.source + "#" + s.file) };
  })()`);
  check("save both: one download per side, host#file names",
    JSON.stringify(dls.got) === JSON.stringify(dls.want), JSON.stringify(dls));

  await cdp.close();
  console.log(failures ? `DIFF E2E: ${failures} FAILURE(S)` : "DIFF E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
