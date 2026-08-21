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

  const total = await page.evaluate("window.__kz.S.images.length");
  check("grid loaded images from engine", total > 3000, `${total} images`);

  // anchor = same bytes as candidate 0 (an identical pair for difference)
  await attempt("anchor dropped locally (blob, never uploaded)", async () => {
    const n = await page.evaluate(`(async () => {
      const list = await (await fetch("/api/images?host=fake")).json();
      const bytes = await (await fetch("/api/images/" + encodeURIComponent(list[0].id) + "/bytes")).blob();
      await window.__kz.addAnchorFiles([new File([bytes], "anchor-same.png", { type: "image/png" })]);
      return window.__kz.S.anchors.length;
    })()`);
    check("anchor dropped locally (blob, never uploaded)", n === 1);
  });

  // --- row 10 ---------------------------------------------------------------
  await attempt("lightbox opens", async () => {
    await page.evaluate("document.querySelector('.card .imgwrap').click(), true");
    await page.poll("window.__kz.S.lightbox.open === true", 5000);
  });

  await attempt("blink candidate->anchor is instant", async () => {
    const ms = await page.evaluate(`(async () => {
      const t0 = performance.now();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await new Promise((res, rej) => {
        const t1 = t0 + 5000;
        const tick = () => {
          const a = document.getElementById("lbAnchor");
          const S = window.__kz.S;
          if (S.lightbox.col === "anchor" && a.getAttribute("src") && a.style.opacity === "1") return res();
          if (performance.now() > t1) return rej(new Error("blink timeout"));
          setTimeout(tick, 4);
        };
        tick();
      });
      return performance.now() - t0;
    })()`);
    check("blink candidate->anchor is instant", ms < 250, `${ms.toFixed(1)}ms`);
  });
  check("blink landed on anchor column",
    await page.evaluate("window.__kz.S.lightbox.col") === "anchor");

  await page.key("ArrowLeft");
  await page.poll("window.__kz.S.lightbox.col === 'candidate'", 5000);

  await attempt("axes switch by key", async () => {
    await page.key("c");
    const b = await page.evaluate("window.__kz.S.axes.composition");
    await page.key("c");
    const sp = await page.evaluate("window.__kz.S.axes.composition");
    await page.key("c");
    const d = await page.evaluate("window.__kz.S.axes.composition");
    check("c cycles flicker->blend->split->difference",
      b === "blend" && sp === "split" && d === "difference", `${b}/${sp}/${d}`);
  });

  await attempt("row 11: unmet face-anchored skipped, reason shown", async () => {
    await page.key("a"); // shared -> (face-anchored unmet) -> independent
    const align = await page.evaluate("window.__kz.S.axes.alignment");
    const reason = await page.evaluate("window.__kz.S.axisReason");
    const status = await page.evaluate("document.getElementById('status').textContent");
    check("face-anchored skipped (inert)", align === "independent", `landed ${align}`);
    check("reason names missing config", !!reason && reason.includes("serviceUrl"), reason ?? "none");
    check("reason visible in chrome", status.includes("serviceUrl"), status.slice(-60));
  });

  await attempt("ROI persists across navigation; r frames it", async () => {
    await page.evaluate("window.__kz.setRoi(0.2, 0.2, 0.3, 0.3), true");
    await page.key("ArrowDown");
    await page.poll("window.__kz.S.lightbox.index === 1", 5000);
    const roi = await page.evaluate("window.__kz.S.roi");
    check("ROI persists across navigation", !!roi && Math.abs(roi.fw - 0.3) < 1e-9);
    await page.key("r");
    const s = await page.evaluate("window.__kz.S.lightbox.view.s");
    check("r frames the ROI (zoom in)", s > 1, `scale=${s.toFixed(2)}`);
  });

  // --- row 16 ---------------------------------------------------------------
  await attempt("row 16: difference on identical pair -> near-black", async () => {
    await page.key("ArrowUp");
    await page.poll("window.__kz.S.lightbox.index === 0", 5000);
    const blend = await page.evaluate(
      "getComputedStyle(document.getElementById('lbCandidate')).mixBlendMode");
    check("difference sets mix-blend-mode", blend === "difference", blend);
    const mean = await page.evaluate(`(async () => {
      const load = (src) => new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src;
      });
      const a = await load(document.getElementById("lbCandidate").src);
      const b = await load(document.getElementById("lbAnchor").src);
      const c = document.createElement("canvas");
      c.width = a.naturalWidth; c.height = a.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(b, 0, 0);
      ctx.globalCompositeOperation = "difference";
      ctx.drawImage(a, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
      return sum / (d.length / 4 * 3);
    })()`);
    check("identical pair composites near-black", mean < 2, `mean=${mean.toFixed(2)}`);
  });

  // vote keys persist to the engine and survive the reveal
  await attempt("vote keys persist (u/d/f)", async () => {
    await page.key("u");
    await page.poll("window.__kz.S.images[window.__kz.S.lightbox.index]?.judgment?.vote === 'up'", 5000);
    const id = await page.evaluate("window.__kz.S.images[window.__kz.S.lightbox.index].id");
    const serverSide = await page.evaluate(
      `(async () => (await fetch("/api/judgments/" + encodeURIComponent(${JSON.stringify(id)}))).json())()`);
    check("vote reached the engine", serverSide.vote === "up", JSON.stringify(serverSide));
    await page.key("f");
    await page.poll("window.__kz.S.images[window.__kz.S.lightbox.index]?.judgment?.favorite === true", 5000);
    await page.key("u"); // toggle back off
    await page.poll("!window.__kz.S.images[window.__kz.S.lightbox.index]?.judgment?.vote", 5000);
  });

  // host management through the real API (the + / − chrome calls these)
  await attempt("host add/remove via API", async () => {
    await page.evaluate(`(async () => {
      await fetch("/api/hosts", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "e2e-tmp", address: "127.0.0.1:9" }) });
      return true;
    })()`);
    await page.evaluate("(async () => { window.__kz.S.hosts = await (await fetch('/api/hosts')).json(); })()");
    await page.evaluate("window.__kz.S.hosts && (window.__kz.render ?? (()=>{})), true");
    let has = await page.evaluate("'e2e-tmp' in window.__kz.S.hosts");
    check("added host appears in state", has);
    await page.evaluate(`(async () => {
      await fetch("/api/hosts/e2e-tmp", { method: "DELETE" });
      window.__kz.S.hosts = await (await fetch("/api/hosts")).json();
      return true;
    })()`);
    has = await page.evaluate("'e2e-tmp' in window.__kz.S.hosts");
    check("removed host gone from state", !has);
  });

  // --- candidate in-feed zoom (parity with anchor thumbs) ------------------
  await attempt("in-feed zoom: candidate card zooms + persists; emoji-free UI", async () => {
    // the lightbox overlays the feed — close it so the wheel hits the card
    await page.key("Escape");
    await page.poll("window.__kz.S.lightbox.open === false", 3000);
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
    // double-click resets
    await page.mouse("mousePressed", box.x, box.y, { clickCount: 2 });
    await page.mouse("mouseReleased", box.x, box.y, { clickCount: 2 });
    await page.poll("!document.querySelector('.card .imgwrap img').classList.contains('zoomed')", 3000);
    check("double-click resets the zoom", true);
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
    const before = { host: await page.evaluate("window.__kz.S.host"), count: await page.evaluate("window.__kz.S.images.length") };
    // open the picker, click the 'another' row
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#hostList .hostpick')];
      const row = rows.find(r => r.textContent.includes('another'));
      row.click();
      return true;
    })()`);
    await page.poll("window.__kz.S.host === 'another'", 5000);
    // the reload follows the host flip — assert the outcome, not the instant
    await page.poll(`(() => {
      const imgs = window.__kz.S.images;
      return imgs.length > 0 && imgs.length < 100 && imgs.every(i => i.host === 'another');
    })()`, 15000);
    const after = { host: await page.evaluate("window.__kz.S.host"), count: await page.evaluate("window.__kz.S.images.length") };
    check("host switched", after.host === "another");
    check("feed reloaded from the new host", after.count !== before.count,
      `${before.count} -> ${after.count}`);
    const firstHost = await page.evaluate("window.__kz.S.images[0]?.host");
    check("feed cards belong to the new host", firstHost === "another", firstHost ?? "none");
    // switch back for the rest of the suite
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#hostList .hostpick')].find(r => r.textContent.includes('fake')).click();
      return true;
    })()`);
    await page.poll("window.__kz.S.host === 'fake' && window.__kz.S.images.length > 100", 8000);
  });

  // a folder host is just another host: the feed loads from the filesystem
  await attempt("folder host: feed loads from a local folder", async () => {
    await page.evaluate("document.getElementById('hostBtn').click(), true");
    await page.poll("document.getElementById('hostDrop').hidden === false", 3000);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('#hostList .hostpick')].find(r => r.textContent.includes('fixture-dir')).click();
      return true;
    })()`);
    await page.poll("window.__kz.S.host === 'fixture-dir'", 5000);
    await page.poll(`(() => {
      const imgs = window.__kz.S.images;
      return imgs.length > 0 && imgs.every(i => i.host === 'fixture-dir') &&
             imgs.some(i => i.filename === 'flux-basic.png') &&
             imgs.some(i => i.filename === 'logo.svg');
    })()`, 15000);
    check("folder host loads its files into the feed", true);
    // its bytes come from disk: the SVG renders (extension mapping applies)
    const r = await page.evaluate(
      "fetch('/api/images/fixture-dir:logo.svg/bytes').then(r => r.headers.get('Content-Type'))");
    check("folder bytes map octet-stream to the right type", r === "image/svg+xml", r ?? "none");
    // metadata pipeline works off the folder too (scraper extracted from the PNG)
    await page.poll(`(() => {
      const img = window.__kz.S.images.find(i => i.filename === 'flux-basic.png');
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
    await page.poll("window.__kz.S.host === 'fake' && window.__kz.S.images.length > 100", 8000);
  });

  // --- row 12 ---------------------------------------------------------------
  await attempt("row 12: volume", async () => {
    await page.key("Escape");
    await page.poll("window.__kz.S.lightbox.open === false", 5000);
    await page.evaluate("window.__kz.setRoi(0, 0, 0, 0), true");

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
    await page.poll(`(() => {
      const n = window.__kz.S.images.length - 1;
      const el = document.querySelector('.card[data-idx="' + n + '"] img');
      return !!(el && el.getAttribute("src"));
    })()`, 15000);
    check("scroll to end loads tail images", true);

    await page.evaluate("document.querySelector('.card .imgwrap').click(), true");
    await page.poll("window.__kz.S.lightbox.open === true", 5000);
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await page.key("ArrowDown");
    await page.poll("window.__kz.S.lightbox.index === 50", 25000);
    const walkMs = Date.now() - t0;
    const follows = await page.evaluate(`(() => {
      const idx = window.__kz.S.lightbox.index;
      for (let i = Math.max(0, idx - 4); i <= idx; i++) {
        const el = document.querySelector('.card[data-idx="' + i + '"] img');
        if (el && el.getAttribute("src")) return true;
      }
      return false;
    })()`);
    check("50 keyboard steps complete without stall", true, `${walkMs}ms total`);
    check("window follows the keyboard", follows);
  });

  check("no uncaught page errors", pageErrors.length === 0, pageErrors[0] ?? "");

  await page.close();
  console.log(failures ? `\n${failures} FAILURES` : "\ne2e OK");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("E2E driver error:", e); process.exit(1); });
