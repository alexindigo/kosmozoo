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
  const labels = await cdp.evaluate("[...document.querySelectorAll('.difflabel')].map(e => e.textContent)");
  check("boot: both sides render decoded images", true);
  check("boot: labels name their sources", labels.join("|") === "fake#flux-basic.png|another#flux-basic.png", labels.join("|"));

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

  await cdp.close();
  console.log(failures ? `DIFF E2E: ${failures} FAILURE(S)` : "DIFF E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
