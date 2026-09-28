// tests/e2e/variations-enabled-visual.cjs — screenshot the modal after
// enabling a slider so the reorder + auto-insert can be verified visually.

const { CDP, sleep } = require("/work/tests/e2e/cdp.cjs");
const fs = require("fs");

const OUT = process.env.DIAGNOSE_OUT || "/diagnose";
const URL = process.env.DIAGNOSE_URL || "http://127.0.0.1:2085";
const HOST = process.env.DIAGNOSE_HOST || "anton";
const FILE = process.env.DIAGNOSE_FILE || "exp_ComfyUI_v1_00002_.png";

async function main() {
  const cdp = await CDP.launch(9341);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp.goto(URL + "/");
    await cdp.poll(`window.kosmozoo && window.kosmozoo.state && window.kosmozoo.state.images.length > 0`, 20000);

    await cdp.evaluate(`(async () => {
      document.getElementById('hostBtn').click();
      await new Promise(r => setTimeout(r, 200));
      const rows = [...document.querySelectorAll('.hostpick')];
      const row = rows.find(r => r.textContent.includes(${JSON.stringify(HOST)}));
      if (row) row.click();
    })()`);
    await sleep(2000);

    const foundIdx = await cdp.evaluate(`(() => {
      const idx = window.kosmozoo.state.images.findIndex(i => i.filename === ${JSON.stringify(FILE)});
      return idx;
    })()`);
    if (foundIdx < 0) { console.error("image not found"); return; }

    await cdp.evaluate(`document.querySelector('#candidatesCol').scrollTop = ${foundIdx} * 800`);
    await sleep(1500);
    await cdp.poll(`!!document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations')`, 10000);

    await cdp.evaluate(`document.querySelector('.card[data-idx="${foundIdx}"] .votebtn.variations').click()`);
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
    await sleep(500);

    // Enable the SECOND row (steps or whatever comes second) to demonstrate reorder
    await cdp.evaluate(`(() => {
      const rows = document.querySelectorAll('.vz-slider-row');
      // enable the second one
      if (rows[1]) {
        const cb = rows[1].querySelector('.vz-cb');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      }
    })()`);
    await sleep(500);

    const info = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.vz-slider-row')];
      return {
        order: rows.map(r => ({ key: r.dataset.paramKey, enabled: !r.classList.contains('vz-off') })),
        suffix: document.querySelector('.vz-suffix')?.value,
        count: document.querySelector('.vz-count')?.textContent,
      };
    })()`);
    console.log(JSON.stringify(info, null, 2));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(OUT + "/variations-enabled.png", Buffer.from(shot.data, "base64"));
  } finally {
    await cdp.close();
  }
}
main().catch(e => { console.error(e); process.exit(1); });
