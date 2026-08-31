// tests/e2e/diff.e2e.cjs — the /diff URL over raw CDP.
//
// The pair view was removed with the workbench strip; /diff now opens the
// single-image workbench on the left side (kept for deep links). What stays:
//   pasted /diff URL boots the workbench on the left image
//   Esc closes and lands back on the feed URL
//   pushState entry: browser back closes, forward re-opens
//
// Run via tests/e2e/run.sh.

const { CDP, sleep } = require("./cdp.cjs");

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

  // 1. pasted diff URL boots the workbench on the left image
  await cdp.goto(ENGINE + "/diff#fake#flux-basic.png:another#flux-basic.png");
  await cdp.poll(`(async () => !!${KZ}.state.diff.open)()`, 20000);
  await cdp.poll("document.getElementById('diffImg').src && document.getElementById('diffImg').naturalWidth > 0", 10000);
  check("boot: /diff URL opens the workbench on the left image", true);

  // 2. Esc closes; pasted URL means no pushed entry → back on the feed
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(300);
  const afterEsc = await cdp.evaluate(`(async () => ({ open: ${KZ}.state.diff.open, path: location.pathname }))()`);
  check("esc: workbench closes", afterEsc.open === false);
  check("esc: lands back on the feed", afterEsc.path === "/", JSON.stringify(afterEsc));

  // 3. pushState entry: back closes, forward re-opens
  await cdp.evaluate(`(async () => { ${KZ}.actions.diff.openDiff({ source: 'fake', file: 'flux-basic.png' }, { source: 'another', file: 'flux-basic.png' }, { push: true }); })()`);
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  await cdp.evaluate("history.back()");
  await cdp.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);
  check("back: closes the workbench", true);
  await cdp.evaluate("history.forward()");
  await cdp.poll(`(async () => ${KZ}.state.diff.open)()`, 5000);
  check("forward: re-opens the workbench", true);

  await cdp.close();
  console.log(failures ? `DIFF E2E: ${failures} FAILURE(S)` : "DIFF E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
