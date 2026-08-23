// tests/e2e/variations-thumb-zoom.cjs — close-up on the variations modal's
// sliders, verifying the drag thumbs sit ON the rail line.
//
// Structural claim being proven: the rangewrap's three flex lanes share
// ONE centerline by construction, so the rail, selected band, marker,
// and both thumbs are vertically centered identically within ~1px.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const fs = require("fs");

const OUT = process.env.DIAGNOSE_OUT || "/diagnose";
const URL = process.env.DIAGNOSE_URL || "http://127.0.0.1:2085";
const HOST = process.env.DIAGNOSE_HOST || "anton";
const FILE = process.env.DIAGNOSE_FILE || "exp_ComfyUI_v1_00002_.png";

async function main() {
  const cdp = await CDP.launch(9343);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    // Bypass ALL browser cache so we always see the current CSS/JS
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

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
    if (foundIdx < 0) { console.error("image not found:", FILE); return; }

    for (let i = 0; i < 40; i++) {
      const ok = await cdp.evaluate(`(() => {
        const col = document.querySelector('#candidatesCol');
        const cards = document.querySelectorAll('.card');
        const last = cards[cards.length - 1];
        if (last) col.scrollTop = col.scrollHeight;
        return !!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations');
      })()`);
      if (ok) break;
      await sleep(200);
    }
    await cdp.poll(`!!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations')`, 10000);
    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"]').scrollIntoView({ block: "center" })`);
    await sleep(800);

    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations').click()`);
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
    await sleep(800);

    // Report which CSS is actually applied: is the flex layout live?
    const styleCheck = await cdp.evaluate(`(() => {
      const wrap = document.querySelector('.vz-rangewrap');
      const lane = document.querySelector('.vz-lane-track');
      const thumb = document.querySelector('.vz-thumb');
      if (!wrap || !lane || !thumb) return { error: 'elements missing' };
      const cs = (el) => {
        const s = getComputedStyle(el);
        return {
          display: s.display,
          alignItems: s.alignItems,
          position: s.position,
          top: s.top,
          height: s.height,
          inset: s.inset,
        };
      };
      return {
        rangewrap: cs(wrap),
        laneTrack: cs(lane),
        thumb: cs(thumb),
      };
    })()`);
    console.log("styles:", JSON.stringify(styleCheck, null, 2));

    // Geometry probe
    const geom = await cdp.evaluate(`(() => {
      const row = document.querySelector('.vz-slider-row');
      const lane = row.querySelector('.vz-lane-track');
      const center = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top * 100) / 100, height: Math.round(r.height * 100) / 100, center: Math.round((r.top + r.height / 2) * 100) / 100 };
      };
      const laneRect = center(lane);
      const rail = center(row.querySelector('.vz-rail'));
      return {
        laneCenter: laneRect.center,
        railCenter: rail.center,
        thumbMin: center(row.querySelector('.vz-thumb-min')),
        thumbMax: center(row.querySelector('.vz-thumb-max')),
        trackBand: center(row.querySelector('.vz-track')),
        markerBand: center(row.querySelector('.vz-marker')),
      };
    })()`);
    console.log("geometry:", JSON.stringify(geom, null, 2));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT + "/variations-thumb-zoom.png", Buffer.from(shot.data, "base64"));
    console.log("screenshot written");
  } finally {
    await cdp.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
