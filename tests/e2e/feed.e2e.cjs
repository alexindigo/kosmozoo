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

  // --- above-fold landings: a size landing behind the fold inserts a card
  // above the viewport; the feed compensates, so the list does not shift ---
  const prefetchCtl = (kv) => page.evaluate(`(async () => {
    await fetch("/api/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(${JSON.stringify(kv)}) });
  })()`);
  try {
    const FAKE = process.env.E2E_FAKE ?? "http://127.0.0.1:18261";
    const fakeAddr = FAKE.replace(/^https?:\/\//, "");
    // an "undimmed" collection: a fresh id on the same fake host with the
    // walk DISABLED (walk lanes frozen, prio lanes drain), so only wanted
    // files ever carry dims. Both flags are set explicitly — the engine's
    // settings persist across suite runs. The dims prio lane shares one
    // event loop with every collection's worker, so the case waits for the
    // boot backlog to drain first (a no-op late in the suite).
    await page.poll(`(async () => {
      const pf = await (await fetch("/api/prefetch")).json();
      return pf.ingestPending === 0 && pf.dimsPending === 0;
    })()`, 300000);
    await prefetchCtl({ enabled: false, paused: false });
    await page.evaluate(`(async () => {
      await fetch("/api/collections/undim", { method: "DELETE" }).catch(() => null); // residue from an earlier run
      const r = await fetch("/api/collections", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "undim", address: "${fakeAddr}" }) });
      return r.status;
    })()`);
    const names = await page.evaluate(`(async () =>
      (await (await fetch("/api/collections/undim/entries")).json()).map((e) => e.name))()`);
    check("undim collection listed", names.length > 2000, `${names.length} entries`);
    // dims for [0..1599] except the 50-name window [1400..1449] — the
    // behind window that must resolve before anything below it
    const wanted = names.filter((_, i) => i < 1600 && !(i >= 1400 && i < 1450));
    await page.evaluate(`(async () => {
      const r = await fetch("/api/collections/undim/want", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: ${JSON.stringify(wanted)} }),
      });
      if (!r.ok) throw new Error("want failed: " + r.status + " " + (await r.text()));
    })()`);
    // engine-side first: the wanted 1550 carry dims (the prio lane drains
    // at ~20/s while the walk stays frozen); then the client's meta poll
    // merges them into the known list within a poll cycle
    await page.poll(`(async () =>
      (await (await fetch("/api/collections/undim/entries")).json())
        .filter((e) => e.width != null).length >= 1550)()`, 180000);
    await page.evaluate(`(async () => { ${KZ}.actions.hosts.select("undim"); })()`);
    await page.poll(`(async () => ${KZ}.state.entriesWithKnownSize().length >= 1550)()`, 30000);

    // scrub-jump deep into the list, settle, audit
    await page.evaluate(`(async () => {
      const kz = ${KZ};
      kz.actions.feed.restoreToIndex(kz.state.entriesWithKnownSize()[1500]);
    })()`);
    await page.poll(`(async () => {
      const c = document.getElementById("candidatesCol");
      const a = c.scrollTop;
      await new Promise(r => setTimeout(r, 250));
      return a === c.scrollTop && !!document.querySelector(".card.current");
    })()`, 15000);
    const b1 = await page.evaluate(AUDIT);

    // the behind window lands above the fold — poll its two ends in
    await page.poll(`(async () => {
      const kz = ${KZ};
      const known = new Set(kz.state.entriesWithKnownSize());
      const imgs = kz.state.images;
      return known.has(imgs.findIndex((i) => i.filename === ${JSON.stringify(names[1400])}))
          && known.has(imgs.findIndex((i) => i.filename === ${JSON.stringify(names[1449])}));
    })()`, 60000);
    check("behind window landed above the fold", true);
    const b2 = await page.evaluate(AUDIT);
    check("current card's top did not move across the landings",
      b1.currentTop !== null && b2.currentTop === b1.currentTop, `${b1.currentTop} -> ${b2.currentTop}`);
    check("heights still exact after the landings", b2.nullSize === 0 && b2.maxDelta === 0,
      `nullSize=${b2.nullSize} maxDelta=${b2.maxDelta}`);
  } catch (e) {
    check("above-fold landings case", false, e.message.slice(0, 200));
  } finally {
    // leave the engine as found: walk resumed, scratch collection gone
    try {
      await page.evaluate(`(async () => {
        await fetch("/api/prefetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, paused: false }) });
        await fetch("/api/collections/undim", { method: "DELETE" }).catch(() => null);
      })()`);
    } catch { /* engine teardown handles it */ }
  }

  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\nFEED E2E: ALL PASS");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
