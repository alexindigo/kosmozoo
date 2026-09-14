// tests/e2e/feed.e2e.cjs — the §3.5 feed invariant as a spec: after a fling
// and a settle, every rendered card's height is EXACTLY cardHeight(size,
// colW) — estimateSize is the only geometry, nothing corrects it — and the
// current card's top does not move across a 5 s meta-poll window (meta
// patches never change geometry).
//
// Run via tests/e2e/run.sh (step 7; the dims pass has drained by then).

const { CDP, sleep } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";
const KZ = `(await import("/store/instance.js")).appStore`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}

// one audit: per-card height vs the ONE formula + the current card's top
const AUDIT = `(async () => {
  const kz = ${KZ};
  const { cardHeight } = await import("/store/sizes.js");
  const col = document.getElementById("candidatesCol");
  const colW = col.clientWidth;
  const cards = [...document.querySelectorAll(".card")];
  let maxDelta = 0, nullSize = 0;
  for (const el of cards) {
    const size = kz.state.cardSize(Number(el.dataset.idx));
    if (!size) { nullSize++; continue; }
    const d = Math.abs(el.getBoundingClientRect().height - cardHeight(size, colW));
    if (d > maxDelta) maxDelta = d;
  }
  const cur = document.querySelector(".card.current");
  return {
    cards: cards.length, nullSize, maxDelta,
    currentTop: cur ? cur.getBoundingClientRect().top : null,
    scrollTop: col.scrollTop,
  };
})()`;

(async () => {
  const page = await CDP.launch(9335);
  const pageErrors = [];
  await page.send("Runtime.enable");
  const orig = page.ws.onmessage;
  page.ws.onmessage = (ev) => {
    orig(ev);
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pageErrors.push(String(d.exception?.description ?? d.text).split("\n")[0]);
    }
  };

  await page.goto(ENGINE + "/");
  await page.poll("!!document.querySelector('.card')", 20000);

  // deterministic substrate: the fake collection, every entry dimmed
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    if (kz.state.host() !== "fake") await kz.actions.hosts.select("fake");
  })()`);
  await page.poll(`(async () => ${KZ}.state.images.length > 3000)()`, 20000);
  const dims = await page.evaluate(`(async () => (await (await fetch("/api/prefetch")).json()).dimsPending)()`);
  check("dims pass drained before the feed audit", dims === 0, `dimsPending=${dims}`);

  // fling deep into the list, then settle — settled means the scroll
  // position held still across a beat and the current card was assigned
  // (no fixed sleep)
  await page.evaluate(`(() => { document.getElementById("candidatesCol").scrollTop = 144000; })()`);
  await page.poll(`(async () => {
    const c = document.getElementById("candidatesCol");
    const a = c.scrollTop;
    await new Promise(r => setTimeout(r, 250));
    return a === c.scrollTop && !!document.querySelector(".card.current");
  })()`, 15000);

  const a1 = await page.evaluate(AUDIT);
  check("cards rendered after the fling", a1.cards > 0, `${a1.cards} cards @ scrollTop ${a1.scrollTop}`);
  check("every card height === cardHeight(size, colW)", a1.nullSize === 0 && a1.maxDelta === 0,
    `nullSize=${a1.nullSize} maxDelta=${a1.maxDelta}`);

  // meta patches land inside this window — geometry must not move. The
  // 5 s span IS the assertion (the poll interval is 5 s), not a settle
  // sleep: the audit runs again after it, unchanged.
  await sleep(5000);
  const a2 = await page.evaluate(AUDIT);
  check("heights still exact after the 5 s meta window", a2.nullSize === 0 && a2.maxDelta === 0,
    `nullSize=${a2.nullSize} maxDelta=${a2.maxDelta}`);
  check("current card's top did not move", a1.currentTop !== null && a2.currentTop === a1.currentTop,
    `${a1.currentTop} -> ${a2.currentTop}`);
  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nFEED E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
