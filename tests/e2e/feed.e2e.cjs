// tests/e2e/feed.e2e.cjs — the §3.5 feed invariant as a spec: after a fling
// and a settle, every rendered card's height is EXACTLY cardHeight(size,
// colW) — estimateSize is the only geometry, nothing corrects it — and the
// current card's top does not move across a 5 s meta-poll window (meta
// patches never change geometry).
//
// Run via tests/e2e/run.sh (step 7; the dims pass has drained by then).

const { CDP, sleep, collectPageErrors } = require("./cdp.cjs");

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
  const pageErrors = await collectPageErrors(page);

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

  // Card actions use the disposable folder collection, never a real host.
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    await kz.actions.hosts.select("fixture-dir");
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    await kz.actions.judgments.dispatch(im.id, { type: "set", patch: { vote: null, favorite: null, bookmark: null } });
    kz.actions.current.set("fixture-dir", im.filename);
    kz.actions.feed.restoreToIndex(kz.state.imageIdxById().get(im.id));
  })()`);
  const card = '.card[data-name="flux-basic.png"]';
  await page.poll(`!!document.querySelector('${card}')`, 20000);
  const controls = await page.evaluate(`(() => {
    const el = document.querySelector('${card}');
    const buttons = [...el.querySelectorAll('.btnwrap button')];
    return {
      order: buttons.map((b) => b.className.split(' ')[1]),
      iconOnly: buttons.filter((b) => b.matches('.bookmark,.download')).every((b) => b.querySelector('svg') && !b.textContent.trim() && b.getAttribute('aria-label')),
      height: el.getBoundingClientRect().height,
      bookmark: !!el.querySelector('.bookmark'), download: !!el.querySelector('.download'),
    };
  })()`);
  const starAt = controls.order.indexOf("favorite");
  check("card actions: bookmark between star and icon-only download",
    controls.bookmark && controls.download && controls.iconOnly
      && controls.order[starAt + 1] === "bookmark" && controls.order[starAt + 2] === "download", JSON.stringify(controls));

  if (controls.bookmark && controls.download) {
    await page.clickAt(card + ' .bookmark');
    await page.poll(`(async () => {
      const el = document.querySelector('${card} .bookmark');
      const r = await fetch('/api/collections/fixture-dir/entries/flux-basic.png');
      return el?.getAttribute('aria-pressed') === 'true' && (await r.json()).judgment?.bookmark === true;
    })()`, 10000);
    const independent = await page.evaluate(`(() => {
      const el = document.querySelector('${card}');
      return { star: el.querySelector('.favorite').getAttribute('aria-pressed'), color: getComputedStyle(el.querySelector('.bookmark')).color, height: el.getBoundingClientRect().height };
    })()`);
    check("bookmark: blue, immediate independent toggle without geometry change",
      independent.star === "false" && independent.color === "rgb(56, 189, 248)"
        && independent.height === controls.height, JSON.stringify(independent));
    await page.goto(ENGINE + '/#fixture-dir#flux-basic.png');
    await page.poll(`document.querySelector('${card} .bookmark')?.getAttribute('aria-pressed') === 'true'`, 20000);
    check("bookmark: persisted state reaches the reloaded card", true);
    await page.clickAt(card + ' .favorite');
    await page.poll(`document.querySelector('${card} .favorite')?.getAttribute('aria-pressed') === 'true'`, 10000);
    check("favorite: toggling star leaves bookmark enabled",
      await page.evaluate(`document.querySelector('${card} .bookmark').getAttribute('aria-pressed') === 'true'`));
    await page.clickAt(card + ' .bookmark');
    await page.poll(`(async () => !(await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment?.bookmark)()`, 10000);
    check("bookmark: clearing it leaves favorite enabled",
      await page.evaluate(`document.querySelector('${card} .favorite').getAttribute('aria-pressed') === 'true'`));

    const fs = require('fs');
    const dir = fs.mkdtempSync('/tmp/kz-card-download-');
    try {
      await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
      await page.clickAt(card + ' .download');
      for (let i = 0; i < 100 && !fs.readdirSync(dir).some((n) => n.endsWith('.png')); i++) await sleep(50);
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.png'));
      check("download icon: click produces image bytes", files.length === 1 && fs.statSync(dir + '/' + files[0]).size > 100);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // Each state retains its border treatment when current, and changes
  // decoration only (including the rail's corresponding color).
  for (const [mode, token] of [["plain", "--foreground-bright"], ["up", "--positive-dim"], ["down", "--negative"], ["bookmark", "--primary"], ["favorite", "--attention"], ["favorite-bookmark", "--attention"]]) {
    const appearance = await page.evaluate(`(async () => {
      const kz = ${KZ};
      const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
      if (!kz.state.judgmentPrefs.revealThumbedDown) kz.actions.judgments.toggleReveal();
      await kz.actions.judgments.dispatch(im.id, { type: "set", patch: {
        favorite: ${JSON.stringify(mode.startsWith("favorite"))},
        bookmark: ${JSON.stringify(mode.includes("bookmark"))},
        vote: ${JSON.stringify(mode === "up" || mode === "down" ? mode : null)},
      } });
      kz.actions.current.set("fixture-dir", im.filename);
      const el = document.querySelector('${card}');
      const cs = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.style.color = 'var(${token})'; document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      const shadowProbe = document.createElement('span');
      shadowProbe.style.boxShadow = 'inset 0 0 12px color-mix(in srgb, var(${token}) 35%, transparent)';
      document.body.appendChild(shadowProbe);
      const expectedGlow = getComputedStyle(shadowProbe).boxShadow; shadowProbe.remove();
      const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === im.id);
      const state = kz.state.cardState(im.id);
      return { border: cs.borderColor, expected, glow: cs.boxShadow, expectedGlow, height: el.getBoundingClientRect().height,
        rail: tick ? getComputedStyle(tick).backgroundColor : null,
        treatment: state.treatment, cardTreatment: el.dataset.treatment, tickTreatment: tick?.dataset.treatment,
        favorite: el.querySelector('.favorite').getAttribute('aria-pressed'),
        bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed'),
      };
    })()`);
    check("current " + mode + ": matching border, inward glow and rail; height unchanged",
      appearance.border === appearance.expected && appearance.glow === appearance.expectedGlow
        && appearance.height === controls.height && appearance.rail === appearance.expected
        && appearance.treatment === appearance.cardTreatment && appearance.treatment === appearance.tickTreatment
        && appearance.favorite === String(mode.startsWith("favorite"))
        && appearance.bookmark === String(mode.includes("bookmark")), JSON.stringify(appearance));
  }

  const origins = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    const id = im.id;
    const snapshot = () => {
      const el = document.querySelector('${card}');
      const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === id);
      return { bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed'),
        border: getComputedStyle(el).borderColor, tick: getComputedStyle(tick).backgroundColor,
        treatment: el.dataset.treatment };
    };
    await kz.actions.judgments.dispatch(id, { type: "set", patch: { favorite: null, vote: null, bookmark: null } });
    kz.actions.current.set("fixture-dir", im.filename);
    await kz.actions.judgments.dispatch(id, { type: "toggle", field: "bookmark" });
    const programmatic = snapshot();
    kz.actions.keys.register("test.bookmark.intent", "Alt+Shift+F8", () =>
      kz.actions.judgments.dispatch(id, { type: "toggle", field: "bookmark" }));
    return { programmatic };
  })()`);
  check("programmatic intent: bookmark drives both border and tick blue",
    origins.programmatic.bookmark === 'true' && origins.programmatic.border === 'rgb(56, 189, 248)'
      && origins.programmatic.tick === origins.programmatic.border, JSON.stringify(origins));
  await page.key("F8", { alt: true, shift: true });
  await page.poll(`(async () => {
    const j = (await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment;
    return !j?.bookmark && document.querySelector('${card} .bookmark')?.getAttribute('aria-pressed') === 'false';
  })()`, 10000);
  check("keyboard intent: same handler clears bookmark, control and treatment", true);
  const fromApi = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const r = await fetch('/api/collections/fixture-dir/entries/flux-basic.png/judgment', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true, bookmark: true })
    });
    if (!r.ok) throw new Error('fixture judgment failed');
    await kz.actions.ui.refresh();
    const el = document.querySelector('${card}');
    const id = kz.state.images.find((i) => i.filename === 'flux-basic.png').id;
    kz.actions.current.set('fixture-dir', 'flux-basic.png');
    const tick = [...document.querySelectorAll('#feedRail .fr-tick')].find((t) => t.dataset.entryId === id);
    const cs = getComputedStyle(el);
    return { border: cs.borderColor, tick: getComputedStyle(tick).backgroundColor, glow: cs.boxShadow,
      star: el.querySelector('.favorite').getAttribute('aria-pressed'), bookmark: el.querySelector('.bookmark').getAttribute('aria-pressed') };
  })()`);
  check("API/refresh state: mixed favorite/bookmark controls active, orange border/glow/tick",
    fromApi.star === 'true' && fromApi.bookmark === 'true' && fromApi.border === 'rgb(255, 136, 0)'
      && fromApi.tick === fromApi.border && fromApi.glow.includes('inset'), JSON.stringify(fromApi));
  const fixedGlow = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const el = document.querySelector('${card}');
    const before = getComputedStyle(el).boxShadow;
    const height = el.getBoundingClientRect().height;
    kz.actions.current.set('fixture-dir', 'flux-lora.png');
    const after = getComputedStyle(el).boxShadow;
    const probe = document.createElement('span');
    probe.style.boxShadow = 'inset 0 0 12px color-mix(in srgb, var(--focused-background) 35%, transparent)';
    document.body.appendChild(probe);
    const expectedAfter = getComputedStyle(probe).boxShadow; probe.remove();
    return { before, after, expectedAfter, heightUnchanged: el.getBoundingClientRect().height === height,
      border: getComputedStyle(el).borderColor };
  })()`);
  check("current moves: shadow remains drawn with fixed geometry, only color changes",
    fixedGlow.before.includes('0px 0px 12px 0px inset') && fixedGlow.after.includes('0px 0px 12px 0px inset')
      && fixedGlow.before !== fixedGlow.after && fixedGlow.heightUnchanged
      && fixedGlow.after === fixedGlow.expectedAfter
      && fixedGlow.border === 'rgb(255, 136, 0)', JSON.stringify(fixedGlow));
  await page.evaluate(`(async () => ${KZ}.actions.current.set('fixture-dir', 'flux-basic.png'))()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.poll(`(async () => {
    const audit = await ${AUDIT};
    return audit.cards > 0 && audit.maxDelta === 0;
  })()`, 10000);
  const narrow = await page.evaluate(AUDIT);
  check("narrow viewport: icon controls preserve exact card geometry", narrow.cards > 0 && narrow.nullSize === 0 && narrow.maxDelta === 0, JSON.stringify(narrow));
  const containment = await page.evaluate(`(() => {
    const el = document.querySelector('${card}');
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll('.btnwrap button')].every((b) => {
      const r = b.getBoundingClientRect();
      return r.left >= bounds.left && r.right <= bounds.right;
    });
  })()`);
  check("narrow viewport: every card action remains inside its card", containment);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 1, mobile: false });
  const compressedWidth = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const previous = kz.state.anchorPaneWidth();
    kz.actions.anchors.setPaneWidth(560);
    return previous;
  })()`);
  await page.poll(`(async () => {
    const audit = await ${AUDIT};
    return audit.cards > 0 && audit.maxDelta === 0;
  })()`, 10000);
  await page.poll(`(() => {
    const el = document.querySelector('${card}');
    const bounds = el.getBoundingClientRect();
    return [...el.querySelectorAll('.btnwrap button')].every((b) => {
      const r = b.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right;
    });
  })()`, 10000);
  const compressed = await page.evaluate(AUDIT);
  check("resized workspace: narrow feed actions fit with exact geometry on desktop", compressed.cards > 0 && compressed.nullSize === 0 && compressed.maxDelta === 0, JSON.stringify(compressed));
  await page.evaluate(`(async () => ${KZ}.actions.anchors.setPaneWidth(${compressedWidth}))()`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  const reordered = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const { api } = await import('/js/api.mjs');
    const { cardHeight, gridGapPx } = await import('/store/sizes.js');
    const original = api.entries;
    const rows = await original('fixture-dir');
    api.entries = async (id) => id === 'fixture-dir' ? [...rows].reverse() : original(id);
    try {
      await kz.actions.ui.refresh();
      const list = kz.state.entriesWithKnownSize();
      const expected = new Map(); let start = 0;
      for (const idx of list) {
        const im = kz.state.images[idx];
        const size = cardHeight(kz.state.cardSize(idx), kz.state.feedScrollEl().clientWidth) + gridGapPx();
        expected.set(im.id, { start, size }); start += size;
      }
      return kz.state.feedVirtualizer().getVirtualItems().every((it) => {
        const im = kz.state.feedEntryAt(it.index);
        const rect = expected.get(im.id);
        return it.key === im.id && it.start === rect.start && it.size === rect.size;
      });
    } finally {
      api.entries = original;
      await kz.actions.ui.refresh();
    }
  })()`);
  check("same-count reorder: virtual keys, offsets and sizes match the identity-keyed feed", reordered);
  const smallLanding = await page.evaluate(`(async () => {
    const kz = ${KZ};
    const { api } = await import('/js/api.mjs');
    const original = api.entries;
    const rows = await original('fixture-dir');
    const withheld = rows.find((e) => e.name === 'flux-controlnet.png');
    const base = rows.filter((e) => e !== withheld);
    api.entries = async (id) => id === 'fixture-dir' ? base : original(id);
    try {
      kz.actions.current.set('fixture-dir', base[0].name);
      await kz.actions.hosts.select('fixture-dir');
      const vz = kz.state.feedVirtualizer(), col = kz.state.feedScrollEl();
      const anchorName = base[2].name;
      const index = kz.state.images.findIndex((im) => im.filename === anchorName);
      const pos = kz.state.feedPositionOf(kz.state.images[index].id);
      col.scrollTop = vz.getVirtualItems().find((it) => it.index === pos).start + 20;
      col.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const el = () => [...document.querySelectorAll('.card')].find((e) => e.dataset.name === anchorName);
      const before = el().getBoundingClientRect().top;
      api.entries = async (id) => id === 'fixture-dir' ? [base[0], withheld, ...base.slice(1)] : original(id);
      await kz.actions.ui.refresh();
      return { before, after: el().getBoundingClientRect().top };
    } finally {
      api.entries = original;
      await kz.actions.ui.refresh();
    }
  })()`);
  check("small feed scroll: inserts before the actual viewport anchor do not move its card",
    // The browser rounds scroll offsets to physical pixels; card layout
    // remains fractional. Bound that rounding, not a card-sized movement.
    Math.abs(smallLanding.before - smallLanding.after) < 1, JSON.stringify(smallLanding));
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    const im = kz.state.images.find((i) => i.filename === "flux-basic.png");
    await kz.actions.judgments.dispatch(im.id, { type: "set", patch: { vote: null, favorite: null, bookmark: null } });
    if (kz.state.judgmentPrefs.revealThumbedDown) kz.actions.judgments.toggleReveal();
    await kz.actions.hosts.select("fake");
  })()`);
  await page.poll(`(async () => ${KZ}.state.images.length > 3000)()`, 20000);

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
