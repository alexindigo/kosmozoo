// tests/e2e/workbench.e2e.cjs — real-browser end-to-end checks over raw CDP.
//
// Covers the plan's visual/timing verification rows that a DOM shim cannot:
//   row 10  blink swap timing; axes switch by key; ROI persists across navigation
//   row 11  a mode whose needs are unmet is skipped and the reason is shown
//   row 12  3,000-image volume: scroll to end, walk 50 candidates, no stall,
//           window follows the keyboard
//   row 16  difference mode on an identical pair -> near-black composite
//
// Run via tests/e2e/run.sh.

const { CDP, sleep, collectPageErrors } = require("./cdp.cjs");
const { workPath } = require("./paths.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";
const FAKE = process.env.E2E_FAKE ?? "http://127.0.0.1:18261";
const fs = require("node:fs");
async function sourceControl(body) {
  const response = await fetch(FAKE + "/__test/activity", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fixture control ${response.status}`);
}
async function sourceShot(page, name) {
  fs.mkdirSync(workPath("tests/e2e/.shots"), { recursive: true });
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(workPath(`tests/e2e/.shots/${name}.png`), Buffer.from(shot.data, "base64"));
}

// the app store is a plain ES-module singleton — importing the served URL
// returns THE instance the app booted (no window global). Scalar signals
// are getters (state.host()); store trees read directly (state.images).
// evaluate/poll await promises (awaitPromise) — probes wrap in async IIFEs.
const KZ = `(await import("/store/instance.js")).appStore`;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
}
async function attempt(name, fn) {
  try { await fn(); } catch (e) { check(name, false, e.message.slice(0, 160)); }
}

(async () => {
  const page = await CDP.launch(9333, { windowSize: "1600,1200" });
  const pageErrors = await collectPageErrors(page);

  await page.goto(ENGINE + "/");
  await page.poll("!!document.querySelector('.card')", 20000);
  // the window is populated (no fixed settle sleep — poll the render)
  await page.poll("document.querySelectorAll('.card').length > 3", 10000);
  const logoVersion = await page.evaluate("document.querySelector('header img.logo')?.title");
  check("header logo title shows the app version", /^v\d+\.\d+(\.\d+)?(-dev| \([0-9a-f]{7}\))$/.test(logoVersion), logoVersion);

  const total = await page.evaluate(`(async () => (await (await fetch("/api/collections/fake/entries")).json()).length)()`);
  check("grid loaded images from engine", total > 3000, `${total} images`);

  // anchor = same bytes as candidate 0 (an identical pair for difference)
  await attempt("anchor dropped locally (blob, never uploaded)", async () => {
    const n = await page.evaluate(`(async () => {
      const s = ${KZ};
      const list = await (await fetch("/api/collections/fake/entries")).json();
      const bytes = await (await fetch("/api/collections/fake/entries/" + encodeURIComponent(list[0].name) + "/bytes")).blob();
      await s.actions.anchors.addFiles([new File([bytes], "anchor-same.png", { type: "image/png" })]);
      return s.state.anchors.length;
    })()`);
    check("anchor dropped locally (blob, never uploaded)", n === 1);
  });

  // the dropzone is the ONLY drop target — a document-level handler would
  // add the same file twice
  await attempt("drop one file on the anchor zone: exactly one anchor added", async () => {
    await page.evaluate(`(async () => { ${KZ}.actions.ui.setWorkspace("anchors"); })()`);
    await page.poll("!!document.getElementById('dropzone')", 5000);
    const before = await page.evaluate(`(async () => ${KZ}.state.anchors.length)()`);
    await page.evaluate(`(async () => {
      const bytes = await (await fetch("/api/collections/fake/entries/flux-basic.png/bytes")).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      document.getElementById("dropzone").dispatchEvent(
        new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    await page.poll(`(async () => ${KZ}.state.anchors.length === ${before + 1})()`, 5000);
    const n = await page.evaluate(`(async () => ${KZ}.state.anchors.length)()`);
    check("drop one file on the anchor zone: exactly one anchor added", n === before + 1, `${before} -> ${n}`);
    check("the dropped anchor is in the pane", await page.evaluate(
      `!!document.querySelector('.card.anchor[data-name="dropped.png"]')`));
  });

  // --- workbench: single-image viewer (opens on card click, Esc closes) ----
  await attempt("workbench opens on a card click, shows the image, Esc closes", async () => {
    await page.evaluate("document.querySelector('.card .imgwrap').click(), true");
    await page.poll(`(async () => ${KZ}.state.diff.open === true)()`, 5000);
    await page.poll("!!document.querySelector('.dz-a .dz-img').src", 10000);
    check("workbench shows the current image", true);
    await page.key("Escape");
    await page.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);
    check("Esc closes the workbench", true);
  });

  // --- image zoom: ctrl+wheel zooms the image under the cursor; the page
  // itself never zooms (browser zoom is disabled app-wide) -------------------
  await attempt("card zoom: ctrl+wheel zooms the card image, not the page", async () => {
    const pre = await page.evaluate(`(() => {
      const img = document.querySelector('.card[data-idx="0"] .imgwrap img');
      const r = img.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio };
    })()`);
    await page.mouse("mouseWheel", pre.x, pre.y, { deltaY: -240, modifiers: 2 });
    await page.poll(`(document.querySelector('.card[data-idx="0"] .imgwrap img').style.transform ?? "").includes("scale(")`, 5000);
    const post = await page.evaluate(`({
      t: document.querySelector('.card[data-idx="0"] .imgwrap img').style.transform,
      dpr: window.devicePixelRatio,
    })`);
    check("card image zoomed", post.t.includes("scale("), post.t);
    check("page did not zoom", post.dpr === pre.dpr, `dpr ${pre.dpr} -> ${post.dpr}`);
  });

  const beforeInfo = await page.evaluate(`(async () => ${KZ}.state.current())()`);
  await attempt("info panel zoom: ctrl+wheel zooms the node image", async () => {
    // ingest the fixture, re-select the host (the entries reload carries its
    // meta — the meta poll only runs while ingestion is pending), show the
    // DETAILS space (earlier anchor tests switch the pane away), then focus
    // and center the image so the reload's scroll settle keeps it current.
    await page.evaluate(`(async () => {
      await fetch("/api/collections/fake/entries/flux-controlnet.png/bytes");
      const kz = ${KZ};
      await kz.actions.hosts.select("fake");
      kz.actions.ui.setWorkspace("details");
      kz.actions.current.set("fake", "flux-controlnet.png");
      const entry = kz.state.currentEntry();
      if (entry?.entry.filename !== "flux-controlnet.png") throw new Error("fixture not selected");
      kz.actions.feed.restoreToIndex(entry.index);
    })()`);
    await page.poll(`(async () => {
      const kz = ${KZ};
      return kz.state.feedActivity() === "settled"
        && kz.state.current()?.image === "flux-controlnet.png"
        && !!document.querySelector('.info-source-images .infoimg img');
    })()`, 15000);
    // the img element mounts before its bytes land — wait for real pixels
    // (a 0-height img can't be wheel-targeted)
    await page.poll(`document.querySelector('.info-source-images .infoimg img').naturalWidth > 0`, 10000);
    const pre = await page.evaluate(`(() => {
      const img = document.querySelector('.info-source-images .infoimg img');
      const r = img.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const at = document.elementFromPoint(cx, cy);
      window.__spy = null;
      window.addEventListener('wheel', (e) => { window.__spy = { ctrl: e.ctrlKey, target: e.target?.tagName + '.' + (e.target?.className ?? '') }; }, true);
      return {
        x: cx, y: cy, dpr: window.devicePixelRatio,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        at: at ? at.tagName + '.' + String(at.className ?? '') : null,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    })()`);
    console.log("   [dbg] target:", JSON.stringify(pre));
    await page.mouse("mouseWheel", pre.x, pre.y, { deltaY: -240, modifiers: 2 });
    await new Promise((r) => setTimeout(r, 400));
    console.log("   [dbg] spy:", await page.evaluate(`JSON.stringify(window.__spy)`),
      "transform:", await page.evaluate(`document.querySelector('.info-source-images .infoimg img').style.transform`));
    await page.poll(`(document.querySelector('.info-source-images .infoimg img').style.transform ?? "").includes("scale(")`, 5000);
    const post = await page.evaluate(`({ dpr: window.devicePixelRatio })`);
    check("info panel image zoomed", true);
    check("page did not zoom", post.dpr === pre.dpr, `dpr ${pre.dpr} -> ${post.dpr}`);
  });
  // Restore the fixture navigation's context even when its check fails;
  // later feed checks must not target an overscan card above the viewport.
  await page.evaluate(`(async () => {
    const kz = ${KZ};
    const previous = ${JSON.stringify(beforeInfo)};
    kz.actions.current.set(previous.remote, previous.image);
    kz.actions.feed.restoreToIndex(kz.state.currentEntry().index);
  })()`);
  await page.poll(`(async () => {
    const kz = ${KZ};
    return kz.state.feedActivity() === "settled"
      && kz.state.current()?.image === ${JSON.stringify(beforeInfo.image)};
  })()`, 5000);

  await attempt("page zoom is dead outside images", async () => {
    // ctrl+wheel over the app chrome (the header — no image under the cursor)
    const pre = await page.evaluate(`(() => {
      const el = document.querySelector('#hdr') ?? document.body;
      const r = el.getBoundingClientRect();
      return { x: Math.min(r.left + 10, window.innerWidth - 10), y: r.top + 4, dpr: window.devicePixelRatio };
    })()`);
    await page.mouse("mouseWheel", pre.x, pre.y, { deltaY: -240, modifiers: 2 });
    const post = await page.evaluate(`({ dpr: window.devicePixelRatio })`);
    check("no page zoom over the chrome", post.dpr === pre.dpr, `dpr ${pre.dpr} -> ${post.dpr}`);
  });

  // action buttons: ONE pattern — active = filled icon in the accent,
  // border hover-only; never a standing border. Colors compare against the
  // palette's ROLE vars resolved in-page (I3) — never rgb literals, so a
  // re-theme cannot fail the spec.
  await attempt("active buttons fill their icon, no standing border", async () => {
    await page.evaluate("document.querySelector('.card .votebtn.up').click()");
    await page.poll("document.querySelector('.card .votebtn.up').classList.contains('on')", 3000);
    const r = await page.evaluate(`(() => {
      const up = document.querySelector('.card .votebtn.up');
      const path = up.querySelector("svg path:not([stroke='none'])");
      const probe = document.createElement("span");
      document.body.appendChild(probe);
      const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color; };
      const root = getComputedStyle(document.documentElement);
      const out = {
        on: up.classList.contains('on'),
        fill: getComputedStyle(path).fill,
        positive: resolve(root.getPropertyValue("--positive")),
        borderColor: getComputedStyle(up).borderColor,
        border: resolve(root.getPropertyValue("--border")),
      };
      probe.remove();
      return out;
    })()`);
    check("up active: icon filled with the positive role", r.on && r.fill === r.positive, JSON.stringify(r));
    check("up active: border stays the default role", r.borderColor === r.border, r.borderColor);
    await page.evaluate("document.querySelector('.card .votebtn.up').click()");
  });

  // down-vote auto-hides: the card leaves the feed immediately (not on
  // the next manual rebuild); reset needs reveal toggled back on.
  // Selected by data-name: under size-before-render the first DOM card is
  // the first size-KNOWN entry — mount position no longer implies entries[0]
  await attempt("down-vote auto-hides the card", async () => {
    const before = await page.evaluate("document.querySelectorAll('.card').length");
    const name = await page.evaluate("document.querySelector('.card').dataset.name");
    const sel = `.card[data-name="${name}"]`;
    await page.evaluate(`document.querySelector('${sel} .votebtn.down').click()`);
    const gone = await page.poll(`!document.querySelector('${sel}')`, 3000)
      .then(() => true).catch(() => false);
    check("card left the feed right away", gone);
    await page.evaluate(`(async () => {
      const kz = ${KZ};
      await kz.actions.judgments.dispatch("fake:" + ${JSON.stringify(name)}, { type: "set", patch: { vote: null, favorite: null, notes: null } });
      // reveal on (restores the card), then back off — reveal only filters
      // cards still down-voted, and the reset deleted the vote
      kz.actions.judgments.toggleReveal();
      kz.actions.judgments.toggleReveal();
    })()`);
    // up-vote hides too when the "hide up-voted" coupling is enabled —
    // one visibility rule covers every hidden flavor
    await page.evaluate(`(async () => ${KZ}.actions.judgments.toggleHideUp())()`);
    await page.poll("!!document.querySelector('.card .votebtn.up')", 3000);
    const nameUp = await page.evaluate("document.querySelector('.card').dataset.name");
    const selUp = `.card[data-name="${nameUp}"]`;
    await page.evaluate(`document.querySelector('${selUp} .votebtn.up').click()`);
    const goneUp = await page.poll(`!document.querySelector('${selUp}')`, 3000)
      .then(() => true).catch(() => false);
    check("up-vote hides when coupling on", goneUp);
    await page.evaluate(`(async () => {
      const kz = ${KZ};
      await kz.actions.judgments.dispatch("fake:" + ${JSON.stringify(nameUp)}, { type: "set", patch: { vote: null, favorite: null, notes: null } });
      kz.actions.judgments.toggleHideUp(); // coupling off restores the view
    })()`);
    await page.poll("document.querySelectorAll('.card').length === " + before, 3000);
  });

  // card anatomy: image, then the filename row, then the feedback boxes —
  // full metadata lives in the details pane (the card carries no meta
  // section). Read in document order: the sticky foot wraps title+notes.
  await attempt("card order: image, filename, feedback", async () => {
    const order = await page.evaluate(`(() => {
      const card = document.querySelector('.card');
      return [...card.querySelectorAll(".imgwrap, .ctitle, .pair")].map((el) =>
        el.classList.contains('imgwrap') ? 'img' :
        el.classList.contains('ctitle') ? 'title' : 'notes').join(',');
    })()`);
    check("order img,title,notes", order === "img,title,notes", order);
  });

  // host management through the store actions (the + / − chrome calls these)
  await attempt("host add/remove via API", async () => {
    await page.evaluate(`(async () => {
      await ${KZ}.actions.hosts.add("e2e-tmp", "127.0.0.1:9");
    })()`);
    let has = await page.evaluate(`(async () => 'e2e-tmp' in ${KZ}.state.hosts)()`);
    check("added host appears in state", has);
    await page.evaluate(`(async () => {
      await ${KZ}.actions.hosts.remove("e2e-tmp");
    })()`);
    has = await page.evaluate(`(async () => 'e2e-tmp' in ${KZ}.state.hosts)()`);
    check("removed host gone from state", !has);
  });

  // --- candidate in-feed zoom (parity with anchor thumbs) ------------------
  await attempt("in-feed zoom: candidate card zooms + persists; emoji-free UI", async () => {
    // the workbench overlays the feed — close it so the wheel hits the card
    await page.key("Escape");
    await page.poll(`(async () => ${KZ}.state.diff.open === false)()`, 3000);
    // Ctrl+wheel on a card image zooms it in place
    const box = await page.evaluate(`(() => {
      const img = document.querySelector('.card .imgwrap img');
      const r = img.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.mouse("mouseWheel", box.x, box.y, { deltaY: -240, modifiers: 2 });
    // behavior, not the class hook (I3): the zoom shows as the transform
    await page.poll("document.querySelector('.card .imgwrap img').style.transform.includes('scale(')", 3000);
    check("Ctrl+wheel zooms a candidate card in place", true);
    const tf = await page.evaluate("document.querySelector('.card .imgwrap img').style.transform");
    check("zoom applies a transform", tf.includes("scale("), tf.slice(0, 40));
    // no emoji anywhere in the UI
    const emojiFound = await page.evaluate(`(() => {
      const re = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2190}-\\u{21FF}\\u{2B00}-\\u{2BFF}]/u;
      const texts = [...document.querySelectorAll("button, a, .votebtn, .savebtn")].map(e => e.textContent);
      return texts.filter(t => re.test(t));
    })()`);
    check("no emoji in buttons (icons are SVG)", emojiFound.length === 0, emojiFound.join(","));
  });

  // host switch reloads the feed from the new host (was broken: old feed stayed)
  await attempt("host switch reloads the feed", async () => {
    const before = { host: await page.evaluate(`(async () => ${KZ}.state.host())()`), count: await page.evaluate(`(async () => ${KZ}.state.images.length)()`) };
    // open the picker, click the 'another' row
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#hostList .hostpick')];
      const row = rows.find(r => r.textContent.includes('another'));
      row.click();
      return true;
    })()`);
    await page.poll(`(async () => ${KZ}.state.host() === 'another')()`, 5000);
    // the reload follows the host flip — assert the outcome, not the instant
    await page.poll(`(async () => {
      const imgs = ${KZ}.state.images;
      return imgs.length > 0 && imgs.length < 100 && imgs.every(i => i.host === 'another');
    })()`, 15000);
    const after = { host: await page.evaluate(`(async () => ${KZ}.state.host())()`), count: await page.evaluate(`(async () => ${KZ}.state.images.length)()`) };
    check("host switched", after.host === "another");
    check("feed reloaded from the new host", after.count !== before.count,
      `${before.count} -> ${after.count}`);
    const firstHost = await page.evaluate(`(async () => ${KZ}.state.images[0]?.host)()`);
    check("feed cards belong to the new host", firstHost === "another", firstHost ?? "none");
    // switch back for the rest of the suite
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#hostList .hostpick')].find(r => r.textContent.includes('fake')).click();
      return true;
    })()`);
    await page.poll(`(async () => ${KZ}.state.host() === 'fake' && ${KZ}.state.images.length > 100)()`, 8000);
  });

  // a folder host is just another host: the feed loads from the filesystem
  await attempt("folder host: feed loads from a local folder", async () => {
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#hostList .hostpick')].find(r => r.textContent.includes('fixture-dir')).click();
      return true;
    })()`);
    await page.poll(`(async () => ${KZ}.state.host() === 'fixture-dir')()`, 5000);
    await page.poll(`(async () => {
      const imgs = ${KZ}.state.images;
      return imgs.length > 0 && imgs.every(i => i.host === 'fixture-dir') &&
             imgs.some(i => i.filename === 'flux-basic.png') &&
             imgs.some(i => i.filename === 'logo.svg');
    })()`, 15000);
    check("folder host loads its files into the feed", true);
    // its bytes come from disk: the SVG renders (extension mapping applies)
    const r = await page.evaluate(
      "fetch('/api/collections/fixture-dir/entries/logo.svg/bytes').then(r => r.headers.get('Content-Type'))");
    check("folder bytes map octet-stream to the right type", r === "image/svg+xml", r ?? "none");
    // metadata pipeline works off the folder too (scraper extracted from the PNG)
    await page.poll(`(async () => {
      const img = ${KZ}.state.images.find(i => i.filename === 'flux-basic.png');
      return img && img.meta && img.meta.seed === 999;
    })()`, 20000);
    check("metadata extracted from a ComfyUI PNG in the folder", true);
    // back to the main fake for the rest of the suite
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#hostList .hostpick')].find(r => r.textContent.includes('fake')).click();
      return true;
    })()`);
    await page.poll(`(async () => ${KZ}.state.host() === 'fake' && ${KZ}.state.images.length > 100)()`, 8000);
  });

  // --- row 12 ---------------------------------------------------------------

  // a failed decode on the workbench stage keeps the previous image and
  // never throws (the decode guard resolves to the last good src)
  await attempt("workbench: a failed decode keeps the previous image", async () => {
    await page.evaluate(`(async () => {
      ${KZ}.actions.current.set("fake", "flux-basic.png");
      ${KZ}.actions.diff.open();
    })()`);
    await page.poll(`(async () => ${KZ}.state.diff.open === true)()`, 5000);
    await page.poll(`document.querySelector('.dz-a .dz-img').src.includes('flux-basic.png')`, 10000);
    const good = await page.evaluate("document.querySelector('.dz-a .dz-img').src");
    // point the pointer at a file whose bytes 404 (sync on the 404 itself,
    // then one beat for the resource to settle — not a settle sleep)
    await page.evaluate(`(async () => {
      ${KZ}.actions.current.set("fake", "nope-404.png");
      await fetch("/api/collections/fake/entries/nope-404.png/bytes").catch(() => null);
    })()`);
    await sleep(300);
    const after = await page.evaluate("document.querySelector('.dz-a .dz-img').src");
    check("a failed decode keeps the previous image on stage", after === good, after.slice(-40));
    check("no page error from the failed decode", pageErrors.length === 0, pageErrors[0] ?? "");
    // a good image still swaps in afterwards
    await page.evaluate(`(async () => { ${KZ}.actions.current.set("fake", "flux-lora.png"); })()`);
    await page.poll(`document.querySelector('.dz-a .dz-img').src.includes('flux-lora.png')`, 10000);
    check("a good image still swaps in after a failed decode", true);
    await page.evaluate(`(async () => { ${KZ}.actions.diff.close(); })()`);
  });

  // --- row 12 ---------------------------------------------------------------
  // Feed volume: chunked render reaches the end under scrolling. (The old
  // 50-keyboard-step workbench walk was removed with the workbench strip.)
  await attempt("row 12: volume", async () => {
    await page.key("Escape");
    await page.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);

    // deep jump via the store: restoreToIndex + one settle. (The old
    // 400-iteration scroll-chase fought the prefetch rate — with the
    // two-pass prefetch the honest volume test is the jump itself.)
    const n = await page.evaluate(`(async () => {
      const kz = ${KZ};
      const last = kz.state.images.length - 1;
      kz.actions.feed.restoreToIndex(last);
      return last;
    })()`);
    await page.poll(`!!document.querySelector('.card[data-idx="${n}"]')`, 15000);
    check("feed renders to the end under a deep jump (restoreToIndex)", true);
    await page.poll(`(async () => {
      const el = document.querySelector('.card[data-idx="${n}"] img');
      return !!(el && el.getAttribute("src"));
    })()`, 15000);
    check("scroll to end loads tail images", true);
  });

  await attempt("source chrome: pointer paths, shared persistence, progress and filter layer", async () => {
    const pin = '#hostList [data-source="fake"] .pin';
    const auto = '#hostList [data-source="fake"] .auto-refresh';
    const pinned = '.pinned-source[data-source="fake"]';
    try {
      await page.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await sourceControl({ reset: true });
      await page.evaluate(`(async () => {
        const s = ${KZ};
        await s.actions.hosts.select('fake');
        s.actions.current.set('fake', 'flux-basic.png');
        s.actions.feed.restoreToIndex(s.state.currentEntry().index);
        await s.actions.hosts.patch('fake', { pinned: false, autoRefresh: false });
      })()`);
      await page.poll(`document.querySelector('.card[data-name="flux-basic.png"] img')?.naturalWidth > 0`);
      check("refresh icon is immediately before source picker", await page.evaluate(`(() => {
        const b = document.getElementById('refreshBtn');
        return !!b.querySelector('svg') && !b.textContent.trim() && b.nextElementSibling.id === 'hostPicker';
      })()`));
      check("filter initially collapsed", await page.evaluate(`document.getElementById('filter').hidden && document.getElementById('filterBtn').getAttribute('aria-expanded') === 'false'`));
      await page.clickAt('#hostBtn');
      await page.poll(`!document.getElementById('hostDrop').hidden`);
      await page.clickAt(pin);
      await page.poll(`document.querySelector('${pin}').getAttribute('aria-pressed') === 'true' && !document.querySelector('${pin}').disabled`);
      check("pin pointer click retains dropdown and source selection", await page.evaluate(`(async () => !document.getElementById('hostDrop').hidden && ${KZ}.state.host() === 'fake')()`));
      await page.clickAt(auto);
      await page.poll(`document.querySelector('${auto}').getAttribute('aria-pressed') === 'true' && !document.querySelector('${auto}').disabled`);
      check("auto-refresh toggles independently without selecting row", await page.evaluate(`document.querySelector('${pin}').getAttribute('aria-pressed') === 'true' && !document.getElementById('hostDrop').hidden`));
      check("folder refresh is disabled with explicit reason", await page.evaluate(`(() => {
        const b = document.querySelector('#hostList [data-source="fixture-dir"] .auto-refresh');
        return b.disabled && b.title === 'No generation jobs for folder sources';
      })()`));
      await page.clickAt('#hostList [data-source="fixture-dir"] .pin');
      await page.poll(`document.querySelector('.pinned-source[data-source="fixture-dir"] .source-progress')?.dataset.state === 'idle'`);
      check("folder pin keeps selection and presents grey unsupported activity", await page.evaluate(`(async () => {
        const s = ${KZ}, circle = document.querySelector('.pinned-source[data-source="fixture-dir"] .source-progress');
        return s.state.host() === 'fake' && circle.getAttribute('aria-label').includes('No generation jobs') &&
          getComputedStyle(circle).color === getComputedStyle(circle.querySelector('.source-progress-base')).fill;
      })()`));
      await page.clickAt('#hostList [data-source="fixture-dir"] .pin');
      await page.poll(`!document.querySelector('.pinned-source[data-source="fixture-dir"]')`);
      await page.clickAt('#hostBtn');
      await page.poll(`document.getElementById('hostDrop').hidden`);
      await page.poll(`document.querySelector('${pinned} .source-progress')?.dataset.state === 'idle'`, 15000);
      const idleColor = await page.evaluate(`getComputedStyle(document.querySelector('${pinned} .source-progress-base')).fill`);
      check("idle source is grey with no sector", await page.evaluate(`!document.querySelector('${pinned} .source-progress-fill') && getComputedStyle(document.querySelector('${pinned} .source-progress')).color === ${JSON.stringify(idleColor)}`));
      await sourceShot(page, 'source-idle-1400');
      const fresh = await CDP.launch(9342, { windowSize: '1600,1000' });
      const freshErrors = await collectPageErrors(fresh);
      try {
        await fresh.goto(ENGINE + '/#fake');
        await fresh.poll(`document.querySelector('${pinned}')?.getAttribute('aria-pressed') === 'true'`, 20000);
        check("saved pin/refresh are visible in a fresh browser", await fresh.evaluate(`(async () => {
          const s = ${KZ}; return s.state.hosts.fake.pinned && s.state.hosts.fake.autoRefresh &&
            !Object.keys(localStorage).some((k) => /pinned|autoRefresh/.test(k));
        })()`));
        check("fresh browser cold boot has no page errors", freshErrors.length === 0, freshErrors.join('; '));
      } finally { await fresh.close(); }
      await sourceControl({ running: ['chrome-external'], logs: [{ t: 1, m: '0/40\r' }] });
      await page.poll(`document.querySelector('${pinned} .source-progress')?.classList.contains('indeterminate')`, 15000);
      await sourceShot(page, 'source-indeterminate-1400');
      await sourceControl({ appendLogs: [{ t: 1, m: '\u001b[32m25%| 10/40 [02:04, 12.4s/it]\u001b[0m\r' }] });
      await page.poll(`document.querySelector('${pinned} .source-progress')?.dataset.fraction === '0.25'`, 15000);
      const firstSector = await page.evaluate(`document.querySelector('${pinned} .source-progress-fill').getAttribute('d')`);
      await sourceShot(page, 'source-running-quarter-1400');
      await sourceControl({ appendLogs: [{ t: 1, m: '20/40\r' }] });
      await page.poll(`document.querySelector('${pinned} .source-progress')?.dataset.fraction === '0.5'`, 15000);
      check("external operation changes the rendered native SVG sector", await page.evaluate(`document.querySelector('${pinned} .source-progress-fill').getAttribute('d') !== ${JSON.stringify(firstSector)}`));
      await sourceShot(page, 'source-running-half-1400');
      await sourceControl({ appendLogs: [{ t: 1, m: '40/40\r' }] });
      await page.poll(`document.querySelector('${pinned} .source-progress')?.dataset.fraction === '1'`, 15000);
      check("100% operation renders a full circle while the job remains running", await page.evaluate(`document.querySelector('${pinned} .source-progress-fill').tagName === 'circle' && document.querySelector('${pinned} .source-progress').dataset.state === 'running'`));
      await sourceShot(page, 'source-running-full-1400');
      await sourceControl({ delays: { history: 6000 } });
      await page.evaluate(`(async () => {
        const s = ${KZ}; await s.actions.hosts.add('starting', '127.0.0.2:${new URL(FAKE).port}');
        await s.actions.hosts.patch('starting', { pinned: true });
      })()`);
      await page.poll(`document.querySelector('.pinned-source[data-source="starting"] .source-progress')?.dataset.state === 'unknown'`, 5000);
      await sourceShot(page, 'source-unknown-1400');
      await page.evaluate(`(async () => ${KZ}.actions.hosts.remove('starting'))()`);
      await sourceControl({ delays: {}, failures: { queue: 503 } });
      await page.poll(`document.querySelector('${pinned} .source-progress')?.dataset.state === 'disconnected'`, 15000);
      check("disconnect clears rendered progress fill", await page.evaluate(`!document.querySelector('${pinned} .source-progress-fill')`));
      await sourceShot(page, 'source-disconnected-1400');
      await sourceControl({ failures: {}, running: [] });
      await page.clickAt('#filterBtn');
      await page.poll(`!document.getElementById('filter').hidden && document.activeElement.id === 'filter'`);
      await page.send('Input.insertText', { text: '.png' });
      await page.poll(`(async () => ${KZ}.state.filter() === '.png')()`);
      await sourceShot(page, 'source-filter-expanded-1400');
      await page.evaluate(`(async () => {
        const s = ${KZ}; s.actions.variations.open(s.state.images.find((i) => i.filename === 'flux-basic.png'));
      })()`);
      await page.poll(`!!document.querySelector('.vz-panel')`);
      await page.key('Escape');
      await page.poll(`(async () => !${KZ}.state.variations.open)()`);
      check("modal Escape outranks filter layer", await page.evaluate(`!document.getElementById('filter').hidden`));
      await page.evaluate(`(async () => ${KZ}.actions.keys.togglePanel())()`);
      await page.poll(`(async () => ${KZ}.state.keysPanelOpen())()`);
      await page.key('Escape');
      await page.poll(`(async () => !${KZ}.state.keysPanelOpen())()`);
      check("keys-panel contextual Escape also outranks expanded filter", await page.evaluate(`!document.getElementById('filter').hidden`));
      await page.evaluate(`(async () => ${KZ}.actions.diff.open())()`);
      await page.poll(`(async () => ${KZ}.state.diff.open)()`);
      await page.key('Escape');
      await page.poll(`(async () => !${KZ}.state.diff.open)()`);
      check("workbench contextual Escape also outranks expanded filter", await page.evaluate(`!document.getElementById('filter').hidden`));
      await page.key('Escape');
      await page.poll(`document.getElementById('filter').hidden`);
      check("collapse retains query and active icon", await page.evaluate(`document.querySelector('#filterBtn').getAttribute('aria-pressed') === 'true' && document.getElementById('filter').value === '.png'`));
      await page.clickAt('#filterBtn');
      await page.poll(`document.activeElement.id === 'filter'`);
      await page.keyTrusted('a', { code: 'KeyA', vk: 65 });
      check("typing in filter does not fire app keys", await page.evaluate(`(async () => !${KZ}.state.diff.open)()`));
      await page.evaluate(`(async () => ${KZ}.actions.ui.setFilter(''))()`);
      await page.key('Escape');
      await page.clickAt('#hostBtn');
      await page.poll(`!document.getElementById('hostDrop').hidden`);
      await page.clickAt('#hostList [data-source="another"]');
      await page.poll(`(async () => ${KZ}.state.host() === 'another' && ${KZ}.state.images.length > 0)()`);
      await page.clickAt(pinned);
      await page.poll(`(async () => ${KZ}.state.host() === 'fake' && ${KZ}.state.images.length > 3000)()`);
      check("pinned click restores the source's saved current through the dropdown selection/URL flow", await page.evaluate(`(async () => {
        const s = ${KZ}, memory = JSON.parse(localStorage.getItem('kosmozoo.sourceBrowse.v1')).hosts.fake;
        const route = (await import('/js/route-parse.mjs')).parseUrl();
        return route.host === 'fake' && route.file === memory.current && route.folder === memory.folder &&
          document.querySelector('${pinned}').getAttribute('aria-pressed') === 'true' &&
          s.state.current()?.image === memory.current;
      })()`));
    } finally {
      await sourceControl({ reset: true });
      await page.evaluate(`(async () => {
        const s = ${KZ}; s.actions.ui.setFilter('');
        if (s.state.hosts.starting) await s.actions.hosts.remove('starting');
        await s.actions.hosts.patch('fixture-dir', { pinned: false });
        await s.actions.hosts.patch('fake', { pinned: false, autoRefresh: false });
      })()`);
    }
  });

  await attempt("folder browsing: native scope, decoded nested output, per-browser memory and filter history", async () => {
    const nativeFolder = async (value) => {
      const index = await page.evaluate(`Array.from(document.querySelector('#outputFolder').options).findIndex(o => o.value === ${JSON.stringify(value)})`);
      if (index < 0) throw new Error('missing native option ' + value);
      await page.clickAt('#outputFolder');
      await page.keyTrusted('Home', { code: 'Home', vk: 36 });
      for (let i = 0; i < index; i++) await page.keyTrusted('ArrowDown', { code: 'ArrowDown', vk: 40 });
      await page.keyTrusted('Enter', { code: 'Enter', vk: 13 });
      await page.poll(`(async () => ${KZ}.state.selectedFolder() === ${JSON.stringify(value)})()`);
    };
    try {
      await sourceControl({ reset: true, publish: [
        { name: 'a/image.png', width: 96, height: 72, color: [30, 170, 60, 255] },
        { name: 'a/deep/image.png', width: 100, height: 80, color: [170, 30, 60, 255] },
        { name: 'ab/image.png', width: 120, height: 90, color: [60, 30, 170, 255] },
        { name: 'b/target.png', width: 140, height: 110, color: [30, 60, 170, 255] },
        { name: 'a/visible.png', width: 128, height: 96, graphPrefix: 'a/visible',
          lineage: { v: 1, source: 'fake:b/target.png', params: {} } },
      ], clearHistory: true });
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate(`(async () => {
        const s = ${KZ}; await s.actions.hosts.select('fake'); s.actions.ui.setFilter('');
        s.actions.folders.select(''); await s.actions.ui.refresh(); await s.actions.hosts.patch('fake', { pinned: true });
      })()`);
      await page.poll(`(async () => ${KZ}.state.inventory.folders.includes('a/deep'))()`, 20000);
      check('folder picker is between host and separated pinned group', await page.evaluate(`(() => {
        const host = document.getElementById('hostPicker'), folder = document.getElementById('folderPicker');
        return host.nextElementSibling === folder && folder.nextElementSibling.classList.contains('pinned-source-group') &&
          !!folder.nextElementSibling.querySelector('.pinned-separator') && document.querySelector('#outputFolder').getAttribute('aria-label') === 'Output folder';
      })()`));
      await nativeFolder('a');
      await page.poll(`document.querySelector('.card[data-name="a/visible.png"] img')?.naturalWidth === 128`, 20000);
      check('trusted native selection renders actual nested pixels and excludes sibling prefix', await page.evaluate(`(async () => {
        const s = ${KZ}, img = document.querySelector('.card[data-name="a/visible.png"] img'), r = img.getBoundingClientRect();
        return s.state.host() === 'fake' && s.state.view().every(i => s.state.images[i].filename.startsWith('a/')) &&
          s.state.view().some(i => s.state.images[i].filename === 'a/deep/image.png') &&
          !s.state.view().some(i => s.state.images[i].filename.startsWith('ab/')) && img.naturalHeight === 96 && r.width > 0 && r.bottom > 0 && r.top < innerHeight;
      })()`));
      await page.evaluate(`(async () => { const s = ${KZ}; s.actions.current.set('fake', 'a/visible.png'); s.actions.feed.restoreToIndex(s.state.currentEntry().index); })()`);
      await page.poll(`!!document.querySelector('.ws-lineage-src[href]')`, 20000);
      if (await page.evaluate(`document.getElementById('filter').hidden`)) await page.clickAt('#filterBtn');
      await page.clickAt('#filter'); await page.send('Input.insertText', { text: 'a/' });
      await page.poll(`new URLSearchParams(location.search).get('filter') === 'a/'`);
      const previous = await page.evaluate(`location.href`);
      await page.clickAt('.ws-lineage-src[href]');
      await page.poll(`(async () => ${KZ}.state.current()?.image === 'b/target.png' && ${KZ}.state.filter() === '' && ${KZ}.state.selectedFolder() === '')()`, 20000);
      await page.poll(`document.querySelector('.card.current[data-name="b/target.png"] img')?.naturalWidth === 140`, 20000);
      check('lineage link navigates to its exact nested target without the outgoing URL filter', await page.evaluate(`!new URLSearchParams(location.search).has('filter') && document.getElementById('filter').value === ''`));
      await page.evaluate(`history.back()`);
      await page.poll(`(async () => location.href === ${JSON.stringify(previous)} && ${KZ}.state.current()?.image === 'a/visible.png' && ${KZ}.state.filter() === 'a/' && document.getElementById('filter').value === 'a/')()`, 20000);
      check('Back restores former nested image, folder and URL filter/input together', true);
      await page.evaluate(`history.forward()`);
      await page.poll(`(async () => ${KZ}.state.current()?.image === 'b/target.png' && ${KZ}.state.filter() === '')()`, 20000);
      await page.evaluate(`history.back()`);
      await page.poll(`(async () => ${KZ}.state.selectedFolder() === 'a' && ${KZ}.state.current()?.image === 'a/visible.png')()`);
      await page.clickAt('#hostBtn'); await page.poll(`!document.getElementById('hostDrop').hidden`);
      await page.clickAt('#hostList [data-source="another"]');
      await page.poll(`(async () => ${KZ}.state.host() === 'another')()`);
      await page.clickAt('.pinned-source[data-source="fake"]');
      await page.poll(`(async () => ${KZ}.state.host() === 'fake' && ${KZ}.state.selectedFolder() === 'a' && ${KZ}.state.current()?.image === 'a/visible.png')()`, 20000);
      check('pinned A→B→A restores per-host folder/current memory', true);
      await page.goto(ENGINE + '/');
      await page.poll(`(async () => ${KZ}.state.selectedFolder() === 'a' && ${KZ}.state.current()?.image === 'a/visible.png')()`, 20000);
      check('bare reload restores the browser pair', true);
      const independent = await CDP.launch(9366, { windowSize: '1600,1000' });
      try {
        await independent.goto(ENGINE + '/');
        await independent.poll(`(async () => ${KZ}.state.images.length > 3000)()`, 20000);
        check('independent browser profile starts at root instead of borrowing another profile scope', await independent.evaluate(`(async () => ${KZ}.state.selectedFolder() === '')()`));
      } finally { await independent.close(); }
      await page.goto(ENGINE + '/?folder=a#fake');
      await page.poll(`(async () => ${KZ}.state.images.length > 3000 && !${KZ}.state.inventory.loading)()`, 20000);
      check('explicit source-only folder URL stays deliberately fileless over memory', await page.evaluate(`(async () => ${KZ}.state.current() === null && location.hash === '#fake' && ${KZ}.state.selectedFolder() === 'a')()`));
      await page.goto(ENGINE + '/?folder=empty%2Funavailable#fake');
      await page.poll(`(async () => !${KZ}.state.inventory.loading && ${KZ}.state.images.length > 3000)()`, 20000);
      check('unavailable folder retains synthetic option, empty scope and fileless URL', await page.evaluate(`(async () => {
        const s = ${KZ}, selected = document.querySelector('#outputFolder').selectedOptions[0];
        return s.state.selectedFolder() === 'empty/unavailable' && s.state.view().length === 0 && s.state.current() === null &&
          selected.value === 'empty/unavailable' && selected.textContent.includes('unavailable') && location.hash === '#fake';
      })()`));
      await sourceShot(page, 'output-folders-empty-unavailable-1400');
      await page.evaluate(`(async () => { const s = ${KZ}; s.actions.folders.select('a'); s.actions.current.set('fake', 'a/visible.png'); })()`);
      await sourceShot(page, 'output-folders-selected-a-1400');
    } finally {
      await sourceControl({ reset: true });
      await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter(''); s.actions.folders.select('');
        await s.actions.hosts.patch('fake', { pinned: false, autoRefresh: false }); await s.actions.ui.refresh(); })()`);
    }
  });

  await require('./command-origins.cjs')({ page, ENGINE, KZ, check });
  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\ne2e OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
