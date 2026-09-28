// tests/e2e/feed-diagnose.cjs — capture the feed's actual visual state so
// css/layout claims can be verified before shipping.
//
// Writes to /diagnose (mounted from host /tmp/kz-diagnose):
//   viewport-<W>x<H>-scroll-<top>.png — screenshot at each combo
//   layout-<W>x<H>-scroll-<top>.json  — bounding rects + card visibility
//
// Read the PNGs, don't just eyeball assertions. See rules 2 and 6 of the
// headless-browser-e2e skill.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const { writeFileSync, mkdirSync } = require("node:fs");

const OUT = process.env.DIAGNOSE_OUT || "/diagnose";
const BASE = process.env.DIAGNOSE_URL || "http://127.0.0.1:2085";

// Viewport sizes to sweep — the small ones expose "cards taller than the
// viewport" issues; the large one shows what a desktop user sees.
const VIEWPORTS = [
  { w: 1400, h: 900 },
  { w: 1200, h: 700 },
  { w: 900,  h: 600 },
];

// Scroll positions (in pixels from top of the feed column) to sample per
// viewport. Includes 0 (top of feed) so we always see the first cards.
const SCROLLS = [0, 400, 900, 1500];

mkdirSync(OUT, { recursive: true });

async function shot(page, name) {
  const r = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
}

// Snapshot: bounding rects of the feed column, viewport, and every rendered
// card (idx, top, bottom, height, aspect variables, image dimensions,
// whether image src is set, whether image is fully in-viewport).
const LAYOUT_JS = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             left: Math.round(r.left), right: Math.round(r.right),
             w: Math.round(r.width), h: Math.round(r.height) };
  };
  const col = document.querySelector("#candidatesCol");
  const inViewport = (r) =>
    r && r.bottom >= 0 && r.top <= window.innerHeight
      && r.right >= 0 && r.left <= window.innerWidth;
  const fullyInViewport = (r) =>
    r && r.top >= 0 && r.bottom <= window.innerHeight
      && r.left >= 0 && r.right <= window.innerWidth;
  const cards = [...document.querySelectorAll(".card")].map((c) => {
    const wrap = c.querySelector(".imgwrap");
    const img = wrap && wrap.querySelector("img");
    return {
      idx: c.dataset.idx,
      cardRect: rect(c),
      wrapRect: rect(wrap),
      cardH: c.getBoundingClientRect().height,
      wrapH: wrap ? wrap.getBoundingClientRect().height : null,
      wrapW: wrap ? wrap.getBoundingClientRect().width : null,
      arNum: wrap && wrap.style.getPropertyValue("--ar-num") || null,
      arDen: wrap && wrap.style.getPropertyValue("--ar-den") || null,
      arCssComputed: wrap ? getComputedStyle(wrap).aspectRatio : null,
      maxHeightCss: wrap ? getComputedStyle(wrap).maxHeight : null,
      maxWidthCss: wrap ? getComputedStyle(wrap).maxWidth : null,
      imgSrcSet: !!(img && img.getAttribute("src")),
      imgLoaded: !!(img && img.complete && img.naturalWidth > 0),
      imgNat: img && img.naturalWidth ? img.naturalWidth + "x" + img.naturalHeight : null,
      inViewport: inViewport(rect(c)),
      fullyInViewport: fullyInViewport(rect(c)),
    };
  });
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    colRect: rect(col),
    scrollTop: col ? col.scrollTop : null,
    scrollHeight: col ? col.scrollHeight : null,
    imagesInState: window.kosmozoo && window.kosmozoo.state ? window.kosmozoo.state.images.length : null,
    cards,
  };
})()`;

(async () => {
  const page = await CDP.launch(9338);
  try {
    for (const vp of VIEWPORTS) {
      await page.send("Emulation.setDeviceMetricsOverride",
        { width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: false });
      await page.goto(BASE + "/");
      await page.poll("window.kosmozoo && window.kosmozoo.state && window.kosmozoo.state.images.length > 0", 30000);
      await page.poll("!!document.querySelector('.card[data-idx=\"0\"]')", 15000);
      // let images load
      await sleep(2500);

      for (const s of SCROLLS) {
        await page.evaluate(
          `(() => { const c = document.querySelector('#candidatesCol'); if (c) c.scrollTop = ${s}; })()`
        );
        await sleep(400);
        const tag = `${vp.w}x${vp.h}-scroll-${s}`;
        const layout = await page.evaluate(LAYOUT_JS);
        writeFileSync(`${OUT}/layout-${tag}.json`, JSON.stringify(layout, null, 2));
        await shot(page, `viewport-${tag}`);
        // Also write a compact summary
        const visible = layout.cards.filter((c) => c.inViewport);
        const summary = {
          viewport: layout.viewport,
          scrollTop: layout.scrollTop,
          visibleCardCount: visible.length,
          visibleCards: visible.map((c) => ({
            idx: c.idx,
            top: c.cardRect && c.cardRect.top,
            bottom: c.cardRect && c.cardRect.bottom,
            cardH: Math.round(c.cardH),
            wrapH: c.wrapH ? Math.round(c.wrapH) : null,
            wrapW: c.wrapW ? Math.round(c.wrapW) : null,
            imgNat: c.imgNat,
            fullyInViewport: c.fullyInViewport,
          })),
        };
        writeFileSync(`${OUT}/summary-${tag}.json`, JSON.stringify(summary, null, 2));
        console.log(`shot: viewport-${tag}.png  visible=${visible.length}`);
      }
    }
  } finally {
    await page.close();
  }
  console.log("diagnose done");
})().catch((e) => { console.error("diagnose fail:", e); process.exit(1); });
