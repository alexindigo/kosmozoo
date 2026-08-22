// tests/e2e/variations.e2e.cjs — e2e coverage for the variations panel.
//
// Runs against the live engine (started by run.sh) with the fake ComfyUI host.
// Verifies: wand button presence, panel open/close, slider state, variations
// count, and the Run submission path.

const { CDP, sleep } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";
const FAKE = process.env.E2E_FAKE ?? "http://127.0.0.1:18261";

let failures = 0;
function check(name, ok, detail) {
  const tag = ok ? " ok " : "FAIL";
  console.log(`  [${tag}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}
async function attempt(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e?.message ?? e));
  }
}

async function main() {
  const cdp = await CDP.launch(9334);
  try {
    await cdp.goto(ENGINE);
    await cdp.poll(`window.__kz && window.__kz.S.images.length > 0`);
    // Wait for at least one card to render in the DOM
    await cdp.poll(`!!document.querySelector('.card[data-idx="0"]')`);

    // --- wand button appears on cards ---
    await attempt("wand button exists on first card", async () => {
      const has = await cdp.evaluate(`
        !!document.querySelector('.card[data-idx="0"] .votebtn.variations')
      `);
      check("wand button exists on first card", has);
    });

    // --- wand button opens the panel ---
    await attempt("wand click opens variations panel", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      const hasPanel = await cdp.evaluate(`
        !!document.querySelector('.card[data-idx="0"] .vz-panel')
      `);
      check("wand click opens variations panel", hasPanel);
    });

    // --- panel has sliders ---
    await attempt("panel shows 4 parameter sliders", async () => {
      const rows = await cdp.evaluate(`
        document.querySelectorAll('.card[data-idx="0"] .vz-slider-row').length
      `);
      check("panel shows 4 parameter sliders", rows === 4, "rows=" + rows);
    });

    // --- variations count updates on enable ---
    await attempt("enabling denoise slider updates variations count", async () => {
      // Enable the denoise checkbox (first slider)
      await cdp.evaluate(`
        const cb = document.querySelector('.card[data-idx="0"] .vz-slider-row .vz-cb');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      `);
      await sleep(100);
      const count = await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-count')?.textContent
      `);
      const n = parseInt(count, 10);
      check("enabling denoise updates count", n > 0, "count=" + count);
    });

    // --- variations count updates on increment change ---
    await attempt("changing increment updates variations count", async () => {
      const before = parseInt(await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-count')?.textContent
      `), 10);
      await cdp.evaluate(`
        const inc = document.querySelector('.card[data-idx="0"] .vz-inc');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('input'));
      `);
      await sleep(100);
      const after = parseInt(await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-count')?.textContent
      `), 10);
      check("increment change updates count", before !== after, before + " → " + after);
    });

    // --- panel closes on wand re-click ---
    await attempt("wand re-click closes panel", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      const hasPanel = await cdp.evaluate(`
        !!document.querySelector('.card[data-idx="0"] .vz-panel')
      `);
      check("wand re-click closes panel", !hasPanel);
    });

    // --- panel closes on × button ---
    await attempt("× button closes panel", async () => {
      // reopen
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-close')?.click()
      `);
      await sleep(200);
      const hasPanel = await cdp.evaluate(`
        !!document.querySelector('.card[data-idx="0"] .vz-panel')
      `);
      check("× button closes panel", !hasPanel);
    });

    // --- Run button produces a result message ---
    await attempt("Run produces a result message", async () => {
      // Open panel on first card
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);

      // Enable denoise slider and set range via IIFE to avoid redeclaration
      await cdp.evaluate(`(() => {
        const cb2 = document.querySelector('.card[data-idx="0"] .vz-slider-row .vz-cb');
        cb2.checked = true;
        cb2.dispatchEvent(new Event('change'));
        const row = document.querySelector('.card[data-idx="0"] .vz-slider-row');
        const mn = row.querySelector('.vz-min');
        const mx = row.querySelector('.vz-max');
        if (mn) { mn.value = '0.3'; mn.disabled = false; mn.dispatchEvent(new Event('input')); }
        if (mx) { mx.value = '0.9'; mx.disabled = false; mx.dispatchEvent(new Event('input')); }
      })()`);
      await sleep(200);

      // Click Run — the fake host IS reachable, so this should succeed
      // if the image has been ingested (has a hash). If not, we get a 404.
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-run').click()
      `);
      await sleep(2000);

      const errText = await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-error')?.textContent ?? ''
      `);
      // Either "submitted N/M" or an error about not ingested
      const hasResult = errText.length > 0;
      check("Run produces a result message", hasResult, errText);

      // Clean up
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-close')?.click()
      `);
    });

  } finally {
    await cdp.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
