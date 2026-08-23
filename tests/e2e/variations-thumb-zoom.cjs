// tests/e2e/variations-thumb-zoom.cjs — close-up on the variations modal's
// sliders so we can verify the drag thumbs sit ON the rail line.
//
// The variations-modal screenshot at default zoom is too small to verify
// thumb-on-rail alignment. This zooms the browser viewport way in on the
// sliders before screenshotting, so the rail/thumb/marker geometry is
// readable.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const fs = require("fs");

const OUT = process.env.DIAGNOSE_OUT || "/diagnose";
const URL = process.env.DIAGNOSE_URL || "http://127.0.0.1:2085";
const HOST = process.env.DIAGNOSE_HOST || "anton";
const FILE = process.env.DIAGNOSE_FILE || "exp_ComfyUI_v1_00002_.png";

async function main() {
  const cdp = await CDP.launch(9342);
  try {
    // Big viewport so the modal has room, then we zoom with Emulation.
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
    await cdp.goto(URL + "/");
    await cdp.poll(`window.__kz && window.__kz.S && window.__kz.S.images.length > 0`, 20000);

    await cdp.evaluate(`(async () => {
      document.getElementById('hostBtn').click();
      await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.hostpick')];
      const row = rows.find(r => r.textContent.includes(${JSON.stringify(HOST)}));
      if (row) row.click();
    })()`);
    await sleep(2000);
    await cdp.poll(`window.__kz.S.host === ${JSON.stringify(HOST)}`, 5000);

    const foundIdx = await cdp.evaluate(`(() => {
      const idx = window.__kz.S.images.findIndex(i => i.filename === ${JSON.stringify(FILE)});
      return idx;
    })()`);
    if (foundIdx < 0) { console.error("image not found"); return; }

    // The chunked renderer needs to actually see the target index in the
    // window. Scroll repeatedly until the card with our data-idx exists.
    for (let i = 0; i < 40; i++) {
      const ok = await cdp.evaluate(`(() => {
        const col = document.querySelector('#candidatesCol');
        const cards = document.querySelectorAll('.card');
        const last = cards[cards.length - 1];
        // Keep scrolling to force more chunks to render
        if (last) col.scrollTop = col.scrollHeight;
        return !!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations');
      })()`);
      if (ok) break;
      await sleep(200);
    }
    await cdp.poll(`!!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations')`, 10000);
    // Center the card for a good screenshot
    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"]').scrollIntoView({ block: "center" })`);
    await sleep(800);
    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations').click()`);
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
    await sleep(800);

    // Geometric probe: read the bounding boxes of the rail line, the
    // selected band, the orange marker, and the two thumb inputs, then
    // report their vertical centers. The claim being proven is "they all
    // share the same vertical centerline within ~1px" — but this time
    // via flex structural centering, not arithmetic offsets.
    const geom = await cdp.evaluate(`(() => {
      const row = document.querySelector('.vz-slider-row');
      const lane = row.querySelector('.vz-lane-track');
      const center = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, height: r.height, center: r.top + r.height / 2 };
      };
      const laneRect = center(lane);
      // The grey rail is ::before on the lane, drawn at the lane's
      // vertical midpoint (top: 50%; translateY(-0.5px)). Its center
      // IS the lane center by construction.
      return {
        laneTop: laneRect.top, laneHeight: laneRect.height, laneCenter: laneRect.center,
        thumbMin: center(row.querySelector('.vz-thumb-min')),
        thumbMax: center(row.querySelector('.vz-thumb-max')),
        trackBand: center(row.querySelector('.vz-track')),
        markerBand: center(row.querySelector('.vz-marker')),
      };
    })()`);
    console.log("geometry:", JSON.stringify(geom, null, 2));

    // Screenshot — with 2x DPR the thumbs+rail are readable.
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT + "/variations-thumb-zoom.png", Buffer.from(shot.data, "base64"));
    console.log("screenshot written");
  } finally {
    await cdp.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
