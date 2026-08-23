// tests/e2e/variations.e2e.cjs — e2e coverage for the variations modal.
//
// Runs against the live engine (started by run.sh) with the fake ComfyUI host.
// The variations panel is a real page-level modal (backdrop + centered panel),
// opened by the wand button on each card.

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
    await cdp.poll(`!!document.querySelector('.card[data-idx="0"]')`);

    // --- wand button appears on cards ---
    await attempt("wand button exists on first card", async () => {
      const has = await cdp.evaluate(`
        !!document.querySelector('.card[data-idx="0"] .votebtn.variations')
      `);
      check("wand button exists on first card", has);
    });

    // --- wand click opens the modal ---
    await attempt("wand click opens variations modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      const has = await cdp.evaluate(`!!document.querySelector('.vz-root .vz-panel')`);
      check("wand click opens variations modal", has);
    });

    // --- modal is a page-level fixed overlay (not clipped by any card) ---
    await attempt("modal is a page-level fixed overlay", async () => {
      const info = await cdp.evaluate(`(() => {
        const root = document.querySelector('.vz-root');
        const panel = document.querySelector('.vz-panel');
        if (!root || !panel) return { error: 'not open' };
        return {
          rootParent: root.parentElement?.tagName,
          rootPosition: getComputedStyle(root).position,
          panelPosition: getComputedStyle(panel).position,
        };
      })()`);
      check("modal is fixed to body, not clipped by card",
        info.rootParent === "BODY" && info.rootPosition === "fixed",
        JSON.stringify(info));
    });

    // --- 5 sliders (denoise, ipa weight, steps, cfg, seed) ---
    await attempt("panel shows 5 parameter sliders (incl. seed)", async () => {
      const info = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.vz-slider-row');
        const labels = [...rows].map((r) => r.querySelector('.vz-label')?.textContent);
        return { count: rows.length, labels };
      })()`);
      check("panel shows 5 parameter sliders",
        info.count === 5 && info.labels.includes("seed"),
        JSON.stringify(info));
    });

    // --- probe refines current values from the graph ---
    await attempt("probe fills in seed current value", async () => {
      await sleep(300);
      const cur = await cdp.evaluate(`(() => {
        for (const r of document.querySelectorAll('.vz-slider-row')) {
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

    // --- enabling a slider updates variations count ---
    await attempt("enabling denoise updates variations count", async () => {
      await cdp.evaluate(`(() => {
        const cb1 = document.querySelector('.vz-slider-row .vz-cb');
        cb1.checked = true;
        cb1.dispatchEvent(new Event('change'));
      })()`);
      await sleep(100);
      const count = await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`);
      const n = parseInt(count, 10);
      check("enabling denoise updates count", n > 0, "count=" + count);
    });

    // --- per-slider increment updates count ---
    await attempt("per-slider increment change updates count", async () => {
      const before = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      await cdp.evaluate(`(() => {
        const inc = document.querySelector('.vz-slider-row .vz-row-inc-input');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('change'));
      })()`);
      await sleep(100);
      const after = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      check("per-slider increment change updates count", before !== after, before + " → " + after);
    });

    // --- dragging a thumb snaps to that row's increment ---
    await attempt("thumb drag snaps to per-slider increment", async () => {
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row');
        const inc = row.querySelector('.vz-row-inc-input');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('change'));
        const minThumb = row.querySelector('.vz-thumb-min');
        // Simulate a drag: pointerdown sets dragging=true, then input
        minThumb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        minThumb.value = '0.37';
        minThumb.dispatchEvent(new Event('input'));
        const snapped = minThumb.value;
        // release
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
        return snapped;
      })()`);
      // 0.37 snapped to nearest 0.1 = 0.4
      check("drag snaps to increment (0.37 -> 0.4)", result === "0.4", "got=" + result);
    });

    // --- keyboard nudge uses the native fine step, NOT the increment ---
    await attempt("keyboard nudge uses fine step, not increment", async () => {
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row');
        const inc = row.querySelector('.vz-row-inc-input');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('change'));
        const minThumb = row.querySelector('.vz-thumb-min');
        // Set to something NOT on the increment grid; keyboard should keep it fine
        // (no pointerdown => not "dragging")
        minThumb.value = '0.23';
        minThumb.dispatchEvent(new Event('input'));
        return minThumb.value;
      })()`);
      // Should stay at 0.23 (or wherever the input event lands it), not snapped to 0.2
      check("keyboard-mode value is not snapped", result === "0.23", "got=" + result);
    });

    // --- label click inserts {key} into focused suffix ---
    await attempt("slider label click inserts {key} at cursor", async () => {
      await sleep(300); // let probe refine label
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row');
        const suffix = document.querySelector('.vz-suffix');
        suffix.value = "pre__post";
        suffix.focus();
        suffix.setSelectionRange(4, 4);
        suffix.dispatchEvent(new Event('focus'));
        suffix.dispatchEvent(new Event('mouseup'));
        const label = row.querySelector('.vz-label');
        label.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        return { value: suffix.value };
      })()`);
      const okBare = result.value === "pre_{denoise}_post";
      const okPrefixed = result.value === "pre_{scheduler:denoise}_post";
      check("suffix contains graph-appropriate {denoise} at cursor",
        okBare || okPrefixed,
        JSON.stringify(result));
    });

    // --- Esc closes the modal ---
    await attempt("Esc closes the modal", async () => {
      await cdp.key("Escape");
      await sleep(200);
      const still = await cdp.evaluate(`!!document.querySelector('.vz-root')`);
      check("Esc closes modal", !still);
    });

    // --- backdrop click closes the modal ---
    await attempt("backdrop click closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      await cdp.evaluate(`(() => {
        const root = document.querySelector('.vz-root');
        // click DIRECTLY on the root (backdrop), not on the panel
        root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      await sleep(200);
      const still = await cdp.evaluate(`!!document.querySelector('.vz-root')`);
      check("backdrop click closes modal", !still);
    });

    // --- wand re-click closes the modal ---
    await attempt("wand re-click closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      const still = await cdp.evaluate(`!!document.querySelector('.vz-root')`);
      check("wand re-click closes modal", !still);
    });

    // --- × button closes the modal ---
    await attempt("× button closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      await cdp.evaluate(`document.querySelector('.vz-close').click()`);
      await sleep(200);
      const still = await cdp.evaluate(`!!document.querySelector('.vz-root')`);
      check("× button closes modal", !still);
    });

    // --- Run submits and produces a result message ---
    await attempt("Run produces a result message", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await sleep(200);
      await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row');
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
      await cdp.evaluate(`document.querySelector('.vz-run').click()`);
      await sleep(2000);
      const errText = await cdp.evaluate(`
        document.querySelector('.vz-error')?.textContent ?? ''
      `);
      const hasResult = errText.length > 0;
      check("Run produces a result message", hasResult, errText);
      // cleanup: close any lingering modal
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
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
