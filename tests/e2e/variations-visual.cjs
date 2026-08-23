// tests/e2e/variations-visual.cjs — screenshot the variations modal
// on a specific image so layout claims can be verified visually.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const fs = require("fs");

const OUT = process.env.DIAGNOSE_OUT || "/diagnose";
const URL = process.env.DIAGNOSE_URL || "http://127.0.0.1:2085";
const HOST = process.env.DIAGNOSE_HOST || "anton";
const FILE = process.env.DIAGNOSE_FILE || "exp_ComfyUI_v1_00002_.png";

async function main() {
  const cdp = await CDP.launch(9340);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.goto(URL + "/");
    await cdp.poll(`window.kosmozoo && window.kosmozoo.state && window.kosmozoo.state.images.length > 0`, 20000);

    // Switch to the requested host
    await cdp.evaluate(`(async () => {
      document.getElementById('hostBtn').click();
      await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.hostpick')];
      const row = rows.find(r => r.textContent.includes(${JSON.stringify(HOST)}));
      if (row) row.click();
    })()`);
    await sleep(2000);
    await cdp.poll(`window.kosmozoo.state.host === ${JSON.stringify(HOST)}`, 5000);

    // Find the card matching the requested filename
    const foundIdx = await cdp.evaluate(`(() => {
      const idx = window.kosmozoo.state.images.findIndex(i => i.filename === ${JSON.stringify(FILE)});
      return idx;
    })()`);
    if (foundIdx < 0) {
      console.error("image not found:", FILE);
      return;
    }

    // Scroll to it so it's rendered and windowed in
    await cdp.evaluate(`(() => {
      const col = document.querySelector('#candidatesCol');
      // Each card is ~800px. Scroll to roughly the right place.
      col.scrollTop = ${foundIdx} * 800;
    })()`);
    await sleep(1500);
    await cdp.poll(`!!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations')`, 10000);

    // Screenshot BEFORE opening the modal, showing the metadata section
    const beforeInfo = await cdp.evaluate(`(() => {
      const card = document.querySelector('.card[data-idx="${foundIdx}"]');
      const props = card.querySelector('.props');
      // Scroll the card into viewport
      card.scrollIntoView({ block: 'center' });
      return {
        propsText: props ? props.innerText : null,
        filename: card.dataset.name,
      };
    })()`);
    console.log("card metadata:", JSON.stringify(beforeInfo, null, 2));
    await sleep(500);
    let shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT + "/variations-card.png", Buffer.from(shot.data, "base64"));

    // Now open the variations modal
    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations').click()`);
    // Wait for probe -> sliders
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0 || !!document.querySelector('.vz-loading')`, 5000);
    // Give probe up to 5s to complete
    await sleep(2000);
    const modalInfo = await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.vz-slider-row');
      return {
        rowCount: rows.length,
        labels: [...rows].map(r => r.querySelector('.vz-label')?.textContent),
        loadingShown: !!document.querySelector('.vz-loading'),
      };
    })()`);
    console.log("modal state:", JSON.stringify(modalInfo, null, 2));

    shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT + "/variations-modal.png", Buffer.from(shot.data, "base64"));
    console.log("screenshots written to", OUT);
  } finally {
    await cdp.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
