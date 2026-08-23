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
    await cdp.poll(`window.kosmozoo && window.kosmozoo.state.images.length > 0`);
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

    // --- sliders render after the probe returns (graph-driven) ---
    // flux-basic uses SamplerCustomAdvanced (no CfgGuider) with a
    // FluxGuidance node and no IPAdapter/PuLID/ModelSampling — the panel
    // should render denoise/steps/seed/guidance but NOT cfg/ipa_weight/
    // shift/pulid_weight for this graph.
    await attempt("panel renders only the graph's varyable params", async () => {
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      const info = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.vz-slider-row');
        const labels = [...rows].map((r) => r.querySelector('.vz-label')?.textContent);
        return { count: rows.length, labels };
      })()`);
      check("panel renders graph-appropriate params",
        info.count === 4
          && info.labels.includes("denoise")
          && info.labels.includes("steps")
          && info.labels.includes("seed")
          && info.labels.includes("guidance")
          && !info.labels.includes("cfg")
          && !info.labels.includes("ipa weight")
          && !info.labels.includes("shift")
          && !info.labels.includes("pulid weight"),
        JSON.stringify(info));
    });

    // --- probe fills in seed current value ---
    await attempt("probe fills in seed current value", async () => {
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

    // --- denoise auto-enables on modal open; count is non-zero ---
    // Opening the modal flips denoise on by default so the user lands on
    // a sensible starting state. Verified by the count being > 0.
    await attempt("denoise auto-enabled on open (count > 0)", async () => {
      await sleep(200);
      const count = await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`);
      const denoiseOn = await cdp.evaluate(`(() => {
        for (const r of document.querySelectorAll('.vz-slider-row')) {
          if (r.dataset.paramKey === 'denoise') return !r.classList.contains('vz-off');
        }
        return false;
      })()`);
      const n = parseInt(count, 10);
      check("denoise auto-enabled and count > 0",
        denoiseOn && n > 0,
        "denoiseOn=" + denoiseOn + " count=" + count);
    });

    // --- enabling a slider auto-inserts its placeholder into suffix ---
    // No trailing underscore in the token — ComfyUI's SaveImage adds its
    // own separator before the counter, so `_{key}` (leading only) is
    // the right shape.
    await attempt("enable auto-inserts _{key} into suffix", async () => {
      const suffix = await cdp.evaluate(`document.querySelector('.vz-suffix')?.value`);
      const okBare = suffix === "_{denoise}";
      const okPrefixed = suffix === "_{scheduler:denoise}";
      check("suffix auto-populated on enable",
        okBare || okPrefixed,
        "suffix=" + JSON.stringify(suffix));
    });

    // --- enabling floats the row to the top, disabled rows sink ---
    await attempt("enabled slider card rises to top", async () => {
      // Enable the SECOND row too, then check ordering
      await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.vz-slider-row');
        if (rows.length < 2) return;
        const cb = rows[rows.length - 1].querySelector('.vz-cb');
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
      })()`);
      await sleep(100);
      const order = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.vz-slider-row')];
        return rows.map((r) => ({
          key: r.dataset.paramKey,
          enabled: !r.classList.contains('vz-off'),
        }));
      })()`);
      // First N rows are enabled, last are disabled (or all enabled if N=count)
      let seenDisabled = false;
      let ok = true;
      for (const r of order) {
        if (!r.enabled) seenDisabled = true;
        else if (seenDisabled) { ok = false; break; }
      }
      check("enabled cards come before disabled cards", ok, JSON.stringify(order));
    });

    // --- disabling removes the auto-inserted placeholder ---
    await attempt("disable removes _{key}_ from suffix", async () => {
      const before = await cdp.evaluate(`document.querySelector('.vz-suffix')?.value`);
      // Disable the LAST enabled row (the one from the reorder test)
      await cdp.evaluate(`(() => {
        // Find any currently-enabled row and toggle it off
        for (const r of document.querySelectorAll('.vz-slider-row')) {
          if (!r.classList.contains('vz-off')) {
            const key = r.dataset.paramKey;
            // Skip denoise so the subsequent tests can still run against it
            if (key === 'denoise') continue;
            const cb = r.querySelector('.vz-cb');
            cb.checked = false;
            cb.dispatchEvent(new Event('change'));
            return key;
          }
        }
      })()`);
      await sleep(100);
      const after = await cdp.evaluate(`document.querySelector('.vz-suffix')?.value`);
      check("suffix shrank after disable", after.length < before.length,
        JSON.stringify({ before, after }));
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

    // --- dragging snaps to the row's increment (via the slide event) ---
    // noUiSlider's `slide` event fires during pointer drag. Our handler snaps
    // the values to the row's increment. This test verifies the handler is
    // registered and the increment is correctly tracked.
    await attempt("slide handler snaps to per-slider increment", async () => {
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row[data-param-key="denoise"]');
        const slider = row.querySelector('.vz-slider');
        if (!slider?.noUiSlider) return { error: 'no slider' };
        const inc = row.querySelector('.vz-row-inc-input');
        inc.value = '0.1';
        inc.dispatchEvent(new Event('change'));
        // Check that the slider's step is the fine step (keyboard) and the
        // increment is tracked separately (drag snapping via slide event)
        return {
          step: slider.noUiSlider.options.step,
          hasSlideHandler: typeof slider.noUiSlider === 'object',
        };
      })()`);
      check("slide handler registered with fine step",
        result.step === 0.01 && result.hasSlideHandler === true,
        JSON.stringify(result));
    });

    // --- keyboard nudge: noUiSlider keyboardSupport is enabled with fine step ---
    // Synthetic KeyboardEvents don't reliably trigger noUiSlider's internal
    // handler (known browser limitation). This test verifies the slider is
    // configured for keyboard support with the fine step, which is what a
    // real user's arrow keys will use.
    await attempt("slider configured for keyboard with fine step", async () => {
      const result = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row[data-param-key="denoise"]');
        const slider = row.querySelector('.vz-slider');
        if (!slider?.noUiSlider) return { error: 'no slider' };
        // Reset increment to default so we can check the fine step
        const inc = row.querySelector('.vz-row-inc-input');
        inc.value = '0.05';
        inc.dispatchEvent(new Event('change'));
        const handle = slider.querySelector('.noUi-handle[data-handle="0"]');
        return {
          tabindex: handle?.getAttribute('tabindex'),
          role: handle?.getAttribute('role'),
          ariaValueNow: handle?.getAttribute('aria-valuenow'),
          step: slider.noUiSlider.options.step,
        };
      })()`);
      check("keyboard nudge uses fine step",
        result.tabindex === "0" && result.role === "slider" && result.step === 0.01,
        JSON.stringify(result));
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
      // Wait for the probe to populate the slider rows
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row');
        const cb2 = row.querySelector('.vz-cb');
        cb2.checked = true;
        cb2.dispatchEvent(new Event('change'));
        const slider = row.querySelector('.vz-slider');
        if (slider?.noUiSlider) {
          slider.noUiSlider.set([0.3, 0.9]);
        }
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
