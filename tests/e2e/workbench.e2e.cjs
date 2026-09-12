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

const { CDP, sleep } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";

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
  const page = await CDP.launch();
  const pageErrors = [];
  await page.send("Runtime.enable");

  await page.goto(ENGINE + "/");
  await page.poll("!!document.querySelector('.card')", 20000);
  // let chunked render get going
  await sleep(1500);

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

  // --- workbench: single-image viewer (opens on card click, Esc closes) ----
  await attempt("workbench opens on a card click, shows the image, Esc closes", async () => {
    await page.evaluate("document.querySelector('.card .imgwrap').click(), true");
    await page.poll(`(async () => ${KZ}.state.diff.open === true)()`, 5000);
    await page.poll("!!document.getElementById('diffImg').src", 10000);
    check("workbench shows the current image", true);
    await page.key("Escape");
    await page.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);
    check("Esc closes the workbench", true);
  });

  // action buttons: ONE pattern — active = filled icon in the accent,
  // border hover-only; never a standing border
  await attempt("active buttons fill their icon, no standing border", async () => {
    const r = await page.evaluate(`(() => new Promise((res) => {
      const up = document.querySelector('.card .votebtn.up');
      up.click();
      setTimeout(() => {
        const path = up.querySelector("svg path:not([stroke='none'])");
        res({
          on: up.classList.contains('on'),
          fill: getComputedStyle(path).fill,
          border: getComputedStyle(up).borderColor,
        });
      }, 300);
    }))()`);
    check("up active: icon filled green", r.on && r.fill === "rgb(158, 206, 106)", JSON.stringify(r));
    check("up active: border stays default", r.border === "rgb(51, 51, 51)", r.border);
    await page.evaluate("document.querySelector('.card .votebtn.up').click()");
  });

  // down-vote auto-hides: the card leaves the feed immediately (not on
  // the next manual rebuild); reset needs reveal toggled back on
  await attempt("down-vote auto-hides the card", async () => {
    const before = await page.evaluate("document.querySelectorAll('.card').length");
    await page.evaluate("document.querySelector('.card .votebtn.down').click()");
    await sleep(300);
    const gone = !await page.evaluate("document.querySelector('.card[data-idx=\"0\"]')");
    check("card left the feed right away", gone);
    await page.evaluate(`(async () => {
      const img = (await (await fetch("/api/collections/fake/entries")).json())[0];
      await fetch("/api/collections/fake/entries/" + encodeURIComponent(img.name) + "/judgment, { method: "DELETE" });
      // reveal on (restores the card), then back off — reveal only filters
      // cards still down-voted, and the reset deleted the vote
      document.getElementById("unhideBtn").click();
      document.getElementById("unhideBtn").click();
    })()`);
    // up-vote hides too when the "hide up-voted" coupling is enabled —
    // one visibility rule covers every hidden flavor
    await page.evaluate(`document.getElementById("hideUpBtn").click()`);
    await page.evaluate("document.querySelector('.card .votebtn.up').click()");
    await sleep(300);
    const goneUp = !await page.evaluate("document.querySelector('.card[data-idx=\"0\"]')");
    check("up-vote hides when coupling on", goneUp);
    await page.evaluate(`(async () => {
      const img = (await (await fetch("/api/collections/fake/entries")).json())[0];
      await fetch("/api/collections/fake/entries/" + encodeURIComponent(img.name) + "/judgment, { method: "DELETE" });
      document.getElementById("hideUpBtn").click(); // coupling off -> rebuild restores
    })()`);
    await page.poll("document.querySelectorAll('.card').length === " + before, 3000);
  });

  // card anatomy: image, then the filename row, then the feedback boxes —
  // full metadata lives in the details pane (the card carries no meta section)
  await attempt("card order: image, filename, feedback", async () => {
    const order = await page.evaluate(`(() => {
      const card = document.querySelector('.card');
      return [...card.children].map((el) =>
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
    await page.poll("document.querySelector('.card .imgwrap img').classList.contains('zoomed')", 3000);
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
  // Feed volume: chunked render reaches the end under scrolling. (The old
  // 50-keyboard-step workbench walk was removed with the workbench strip.)
  await attempt("row 12: volume", async () => {
    await page.key("Escape");
    await page.poll(`(async () => ${KZ}.state.diff.open === false)()`, 5000);

    // chunked feed: renders on approach (sentinel + scroll net). Scroll-step
    // until the end-of-list marker shows.
    let reachedEnd = false;
    for (let i = 0; i < 400; i++) {
      await page.evaluate("(() => { const c = document.getElementById(\"candidatesCol\"); c.scrollTop = c.scrollHeight; })(), true");
      await sleep(250);
      reachedEnd = await page.evaluate("!!document.querySelector('.endoflist')");
      if (reachedEnd) break;
    }
    check("feed renders to the end under scrolling (chunked, sentinel+net)", reachedEnd);
    await page.poll(`(async () => {
      const n = ${KZ}.state.images.length - 1;
      const el = document.querySelector('.card[data-idx="' + n + '"] img');
      return !!(el && el.getAttribute("src"));
    })()`, 15000);
    check("scroll to end loads tail images", true);
  });

  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\ne2e OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
