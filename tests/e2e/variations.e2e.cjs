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

    // --- panel overlays the image, contained within the card's imgwrap ---
    await attempt("panel overlays image, contained in imgwrap", async () => {
      const info = await cdp.evaluate(`(() => {
        const card = document.querySelector('.card[data-idx="0"]');
        const imgwrap = card.querySelector('.imgwrap');
        const panel = card.querySelector('.vz-panel');
        if (!panel) return { error: 'no panel' };
        const wr = imgwrap.getBoundingClientRect();
        const pr = panel.getBoundingClientRect();
        return {
          panelParent: panel.parentElement?.className,
          panelPosition: getComputedStyle(panel).position,
          wrapPosition: getComputedStyle(imgwrap).position,
          contained: pr.x >= wr.x && pr.y >= wr.y && pr.right <= wr.right && pr.bottom <= wr.bottom,
          sameSize: pr.width === wr.width && pr.height === wr.height,
        };
      })()`);
      check("panel overlays image, contained in imgwrap",
        info.contained === true && info.sameSize === true,
        JSON.stringify(info));
    });

    // --- panel has sliders ---
    await attempt("panel shows 5 parameter sliders (incl. seed)", async () => {
      const info = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.card[data-idx="0"] .vz-slider-row');
        const labels = [...rows].map((r) => r.querySelector('.vz-label')?.textContent);
        return { count: rows.length, labels };
      })()`);
      check("panel shows 5 parameter sliders",
        info.count === 5 && info.labels.includes("seed"),
        JSON.stringify(info));
    });

    // --- probe refines current values from the graph ---
    await attempt("probe fills in seed current value", async () => {
      await sleep(300); // wait for probe
      const cur = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.card[data-idx="0"] .vz-slider-row');
        for (const r of rows) {
          if (r.querySelector('.vz-label')?.textContent === 'seed') {
            return r.querySelector('.vz-current')?.textContent;
          }
        }
        return null;
      })()`);
      check("seed row shows a current value from the graph",
        cur != null && cur !== "",
        "current=" + cur);
    });

    // --- variations count updates on enable ---
    await attempt("enabling denoise slider updates variations count", async () => {
      await cdp.evaluate(`(() => {
        const cb1 = document.querySelector('.card[data-idx="0"] .vz-slider-row .vz-cb');
        cb1.checked = true;
        cb1.dispatchEvent(new Event('change'));
      })()`);
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
      await cdp.evaluate(`(() => {
        const inc = document.querySelector('.card[data-idx="0"] .vz-inc');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('input'));
      })()`);
      await sleep(100);
      const after = parseInt(await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .vz-count')?.textContent
      `), 10);
      check("increment change updates count", before !== after, before + " → " + after);
    });

    // --- dual-thumb slider updates range ---
    await attempt("dual-thumb slider updates min/max labels", async () => {
      const labels = await cdp.evaluate(`(() => {
        const row = document.querySelector('.card[data-idx="0"] .vz-slider-row');
        const minThumb = row.querySelector('.vz-thumb-min');
        const maxThumb = row.querySelector('.vz-thumb-max');
        minThumb.value = '0.3';
        minThumb.dispatchEvent(new Event('input'));
        maxThumb.value = '0.9';
        maxThumb.dispatchEvent(new Event('input'));
        return {
          min: row.querySelector('.vz-min-lbl')?.textContent,
          max: row.querySelector('.vz-max-lbl')?.textContent,
        };
      })()`);
      check("dual-thumb updates labels", labels.min === "0.3" && labels.max === "0.9",
        JSON.stringify(labels));
    });

    // --- clicking a slider label inserts {key} into focused prefix/suffix ---
    // The placeholder key is the graph-specific label (e.g. "scheduler:denoise"
    // for SamplerCustomAdvanced graphs; "denoise" for KSampler graphs).
    await attempt("slider label click inserts {key} at cursor", async () => {
      // Wait for the async probe to refine the placeholder key
      await sleep(300);
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.card[data-idx="0"] .vz-slider-row');
        const suffix = document.querySelector('.card[data-idx="0"] .vz-suffix');
        suffix.value = "pre__post";
        suffix.focus();
        suffix.setSelectionRange(4, 4);
        suffix.dispatchEvent(new Event('focus'));
        suffix.dispatchEvent(new Event('mouseup'));
        const label = row.querySelector('.vz-label');
        label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return { value: suffix.value, caret: suffix.selectionStart };
      })()`);
      // Accept either bare "denoise" (KSampler) or "scheduler:denoise" (SamplerCustomAdvanced)
      const okBare = result.value === "pre_{denoise}_post";
      const okPrefixed = result.value === "pre_{scheduler:denoise}_post";
      check("suffix contains graph-appropriate {denoise} at cursor",
        okBare || okPrefixed,
        JSON.stringify(result));
    });

    // --- panel blocks click-through to the image below ---
    await attempt("clicking panel does not open lightbox", async () => {
      await cdp.evaluate(`(() => {
        const panel = document.querySelector('.card[data-idx="0"] .vz-panel');
        panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await sleep(200);
      const lbOpen = await cdp.evaluate(`window.__kz.S.lightbox.open`);
      check("clicking panel does not open lightbox", lbOpen === false);
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

      // Enable denoise slider and set range via dual-thumb inputs
      await cdp.evaluate(`(() => {
        const row = document.querySelector('.card[data-idx="0"] .vz-slider-row');
        const cb2 = row.querySelector('.vz-cb');
        cb2.checked = true;
        cb2.dispatchEvent(new Event('change'));
        const mn = row.querySelector('.vz-thumb-min');
        const mx = row.querySelector('.vz-thumb-max');
        mn.value = '0.3';
        mn.dispatchEvent(new Event('input'));
        mx.value = '0.9';
        mx.dispatchEvent(new Event('input'));
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
