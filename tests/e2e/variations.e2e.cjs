// tests/e2e/variations.e2e.cjs — e2e coverage for the variations feature
// module (the engine's /api/features/variations/* + the client modal).
//
// Runs against the live engine (started by run.sh) with the fake ComfyUI
// host. The panel is a page-level modal opened by the wand button on each
// card. Assertions are behavioral: trusted clicks/keys/drags through the
// Input domain, the widget's public aria contract, and the row's own
// labels — never the slider library's internals (I3/I7).

const { CDP } = require("./cdp.cjs");

const ENGINE = process.env.E2E_ENGINE ?? "http://127.0.0.1:18260";
const FAKE = process.env.E2E_FAKE ?? "http://127.0.0.1:18261";

// the app store is a plain ES-module singleton — importing the served URL
// returns THE instance the app booted (no window global)
const KZ = `(await import("/store/instance.js")).appStore`;

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
    await cdp.poll(`(async () => ${KZ}.state.images.length > 0)()`);
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
      const opened = await cdp.poll(`!!document.querySelector('.vz-root .vz-panel')`, 5000)
        .then(() => true).catch(() => false);
      check("wand click opens variations modal", opened);
    });

    // --- modal is a page-level fixed overlay (not clipped by any card) ---
    // behavior, not implementation: the backdrop is fixed, covers the
    // viewport, and contains the panel (the portal parent tag is an
    // implementation detail)
    await attempt("modal is a page-level fixed overlay", async () => {
      const info = await cdp.evaluate(`(() => {
        const root = document.querySelector('.vz-root');
        const panel = document.querySelector('.vz-panel');
        if (!root || !panel) return { error: 'not open' };
        const r = root.getBoundingClientRect();
        return {
          rootPosition: getComputedStyle(root).position,
          coversViewport: r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1,
          panelInRoot: root.contains(panel),
          panelPosition: getComputedStyle(panel).position,
        };
      })()`);
      check("modal is a page-level fixed overlay (not clipped by a card)",
        info.rootPosition === "fixed" && info.coversViewport && info.panelInRoot,
        JSON.stringify(info));
    });

    // --- sliders render after the probe returns (graph-driven) ---
    // flux-basic (SamplerCustomAdvanced): the panel now lists every numeric
    // input of every node. Assert the graph-appropriate params are present —
    // exact-set assertions died with the hardcoded probe table.
    await attempt("panel renders only the graph's varyable params", async () => {
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      const info = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.vz-slider-row');
        const labels = [...rows].map((r) => r.querySelector('.vz-label')?.textContent);
        return { count: rows.length, labels };
      })()`);
      check("panel renders graph-appropriate params",
        info.count >= 4
          && info.labels.some((l) => l.endsWith("denoise"))
          && info.labels.some((l) => l.endsWith("steps"))
          && info.labels.some((l) => l.endsWith("seed") || l.endsWith("noise_seed"))
          && info.labels.some((l) => l.endsWith("guidance")),
        JSON.stringify(info));
    });

    // --- probe fills in seed current value ---
    await attempt("probe fills in seed current value", async () => {
      const cur = await cdp.evaluate(`(() => {
        for (const r of document.querySelectorAll('.vz-slider-row')) {
          if (/seed$/.test(r.querySelector('.vz-label')?.textContent ?? "")) {
            return r.querySelector('.vz-current')?.textContent;
          }
        }
        return null;
      })()`);
      check("seed row shows a current value from the graph",
        cur != null && cur !== "",
        "current=" + cur);
    });
    await attempt("denoise auto-enabled on open (count > 0)", async () => {
      const denoiseOn = await cdp.poll(`(() => {
        const r = document.querySelector('.vz-slider-row[data-param-key$="denoise"]');
        return !!r && !r.classList.contains('vz-off');
      })()`, 5000).then(() => true).catch(() => false);
      const count = await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`);
      const n = parseInt(count, 10);
      check("denoise auto-enabled and count > 0",
        denoiseOn && n > 0,
        "denoiseOn=" + denoiseOn + " count=" + count);
    });

    // --- enabling a slider auto-inserts its placeholder into suffix ---
    // No trailing underscore in the token — ComfyUI's SaveImage adds its
    // own separator before the counter, so `_{key}` (leading only) is
    // the right shape. The key is the full field id (ClassType.input).
    await attempt("enable auto-inserts _{key} into suffix", async () => {
      const suffix = await cdp.evaluate(`document.querySelector('.vz-suffix')?.value`);
      check("suffix auto-populated on enable",
        /^_\{[\w.]*denoise\}$/.test(suffix ?? ""),
        "suffix=" + JSON.stringify(suffix));
    });

    // --- enabling floats the row to the top, disabled rows sink ---
    await attempt("enabled slider card rises to top", async () => {
      // enable the LAST row too — through a trusted click (I7), then poll
      // the reorder instead of sleeping
      const lastKey = await cdp.evaluate(`(() => {
        const rows = document.querySelectorAll('.vz-slider-row');
        return rows.length > 1 ? rows[rows.length - 1].dataset.paramKey : null;
      })()`);
      await cdp.clickAt(`.vz-slider-row[data-param-key="${lastKey}"] .vz-cb`);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row:not(.vz-off)').length >= 2`, 5000);
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
      // toggle off any enabled non-denoise row (denoise stays for later
      // specs) — trusted click, then poll the suffix shrink
      const key = await cdp.evaluate(`(() => {
        for (const r of document.querySelectorAll('.vz-slider-row')) {
          if (!r.classList.contains('vz-off')) {
            const k = r.dataset.paramKey;
            if (k?.endsWith('denoise')) continue;
            return k;
          }
        }
        return null;
      })()`);
      if (!key) {
        check("suffix shrank after disable", false, "no enabled non-denoise row to disable");
        return;
      }
      await cdp.clickAt(`.vz-slider-row[data-param-key="${key}"] .vz-cb`);
      await cdp.poll(`document.querySelector('.vz-suffix').value.length < ${JSON.stringify(before ?? "").length}`, 5000);
      const after = await cdp.evaluate(`document.querySelector('.vz-suffix')?.value`);
      check("suffix shrank after disable", after.length < before.length,
        JSON.stringify({ before, after }));
    });

    // --- per-slider increment updates count ---
    await attempt("per-slider increment change updates count", async () => {
      const before = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      // type the new increment like a user: focus, select-all, trusted
      // insertText, blur (the change event commits)
      await cdp.evaluate(`(() => {
        const inc = document.querySelector('.vz-slider-row .vz-row-inc-input');
        inc.focus(); inc.select();
      })()`);
      await cdp.send("Input.insertText", { text: "0.025" });
      await cdp.evaluate(`document.querySelector('.vz-slider-row .vz-row-inc-input').blur()`);
      await cdp.poll(`parseInt(document.querySelector('.vz-count').textContent, 10) !== ${before}`, 5000);
      const after = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      check("per-slider increment change updates count", before !== after, before + " → " + after);
    });

    // --- dragging snaps to the row's increment ---
    // Behavior, not library internals (I3): a trusted thumb drag lands the
    // value on a multiple of the row's increment, observed through the
    // row's own max label.
    await attempt("drag snaps to the per-slider increment", async () => {
      const rowSel = '.vz-slider-row[data-param-key$="denoise"]';
      await cdp.evaluate(`(() => {
        const inc = document.querySelector('${rowSel} .vz-row-inc-input');
        inc.focus(); inc.select();
      })()`);
      await cdp.send("Input.insertText", { text: "0.1" });
      await cdp.evaluate(`document.querySelector('${rowSel} .vz-row-inc-input').blur()`);
      await cdp.poll(`document.querySelector('${rowSel} .vz-row-inc-input').value === "0.1"`, 5000);
      const before = await cdp.evaluate(`document.querySelector('${rowSel} .vz-max-lbl')?.textContent ?? ""`);
      const h1 = await cdp.evaluate(`(() => {
        const r = document.querySelector('${rowSel} .noUi-handle[data-handle="1"]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await cdp.drag(h1.x, h1.y, h1.x - 37, h1.y); // left: the value decreases
      await cdp.poll(`(document.querySelector('${rowSel} .vz-max-lbl')?.textContent ?? "") !== ${JSON.stringify(before)}`, 5000);
      const after = await cdp.evaluate(`document.querySelector('${rowSel} .vz-max-lbl')?.textContent`);
      const v = parseFloat(after);
      const snapped = Math.abs(v / 0.1 - Math.round(v / 0.1)) < 1e-6;
      check("drag lands on an increment multiple", snapped, `${before} -> ${after}`);
    });

    // --- keyboard nudge moves the thumb by the fine step ---
    // Trusted keys through the Input domain (synthetic KeyboardEvents don't
    // reach noUiSlider's internal handler) — the nudge is observed on the
    // thumb's public aria contract, not the library's options (I3).
    await attempt("keyboard nudge moves the thumb by the fine step", async () => {
      const h0 = '.vz-slider-row[data-param-key$="denoise"] .noUi-handle[data-handle="0"]';
      // the row's own min label carries the full-precision value (the aria
      // valuenow is one-decimal — a 0.01 nudge would be invisible there)
      const lbl = '.vz-slider-row[data-param-key$="denoise"] .vz-min-lbl';
      await cdp.evaluate(`document.querySelector('${h0}').focus()`);
      const before = parseFloat(await cdp.evaluate(`document.querySelector('${lbl}').textContent`));
      await cdp.keyTrusted("ArrowUp", { vk: 38 });
      await cdp.poll(`parseFloat(document.querySelector('${lbl}').textContent) !== ${before}`, 5000);
      const after = parseFloat(await cdp.evaluate(`document.querySelector('${lbl}').textContent`));
      const step = Math.round((after - before) * 1000) / 1000;
      check("arrow key nudges by the fine step (0.01)", step === 0.01, `${before} -> ${after}`);
      const a = await cdp.evaluate(`(() => {
        const h = document.querySelector('${h0}');
        return { role: h.getAttribute('role'), tabindex: h.getAttribute('tabindex') };
      })()`);
      check("thumb exposes the slider a11y contract",
        a.role === "slider" && a.tabindex === "0", JSON.stringify(a));
    });

    // --- track rail spans the thumb-travel span; everything shares a centerline ---
    await attempt("rail spans the thumb-travel span; rail/connect/thumbs/marker share a centerline", async () => {
      const g = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-slider-row[data-param-key$="denoise"]');
        const c = (el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, h: r.height, w: r.width, center: r.top + r.height / 2 };
        };
        const lane = c(row.querySelector('.vz-lane-track'));
        const rail = c(row.querySelector('.vz-rail'));
        const connect = c(row.querySelector('.noUi-connect'));
        const h0 = c(row.querySelector('.noUi-handle[data-handle="0"]'));
        const h1 = c(row.querySelector('.noUi-handle[data-handle="1"]'));
        const marker = c(row.querySelector('.vz-marker'));
        return { lane, rail, connect, h0, h1, marker };
      })()`);
      const near = (a, b) => Math.abs(a - b) < 0.75;
      // the rail is inset by half the thumb width on each side — that's the
      // span thumb centers travel, and the thumbs' outer edges attach to the
      // rail ends at min/max
      check("rail is inset by half the thumb width on each side",
        near(g.rail.w, g.lane.w - 14), `rail=${g.rail.w} lane=${g.lane.w}`);
      check("rail centered on the lane", near(g.rail.center, g.lane.center), `rail=${g.rail.center} lane=${g.lane.center}`);
      check("connect band on the rail centerline", near(g.connect.center, g.rail.center), `connect=${g.connect.center} rail=${g.rail.center}`);
      check("both thumbs on the rail centerline",
        near(g.h0.center, g.rail.center) && near(g.h1.center, g.rail.center),
        `h0=${g.h0.center} h1=${g.h1.center} rail=${g.rail.center}`);
      check("current-value marker on the rail centerline", near(g.marker.center, g.rail.center), `marker=${g.marker.center} rail=${g.rail.center}`);
    });

    // --- thumbs attach to the rail ends at min/max ---
    // Driven through the widget's own keyboard contract (Home/End), not the
    // library API (I3); the tap transition settles by position stability.
    await attempt("thumbs attach to the rail ends at min/max", async () => {
      const rowSel = '.vz-slider-row[data-param-key$="denoise"]';
      await cdp.evaluate(`document.querySelector('${rowSel} .noUi-handle[data-handle="0"]').focus()`);
      await cdp.keyTrusted("Home", { vk: 36 });
      await cdp.evaluate(`document.querySelector('${rowSel} .noUi-handle[data-handle="1"]').focus()`);
      await cdp.keyTrusted("End", { vk: 35 });
      await cdp.poll(`(async () => {
        const hs = document.querySelectorAll('${rowSel} .noUi-handle');
        const read = () => [...hs].map((h) => h.getBoundingClientRect().left).join(",");
        const a = read();
        await new Promise(r => setTimeout(r, 200));
        return a === read();
      })()`, 8000);
      const v = await cdp.evaluate(`(() => {
        const row = document.querySelector('${rowSel}');
        const rail = row.querySelector('.vz-rail').getBoundingClientRect();
        const h0 = row.querySelector('.noUi-handle[data-handle="0"]').getBoundingClientRect();
        const h1 = row.querySelector('.noUi-handle[data-handle="1"]').getBoundingClientRect();
        return { railL: rail.left, railR: rail.right, h0l: h0.left, h0r: h0.right, h1l: h1.left, h1r: h1.right };
      })()`);
      const near = (a, b) => Math.abs(a - b) < 1.2;
      check("min thumb attaches to the rail's left end",
        near(v.h0l, v.railL), `thumbLeft=${v.h0l} railLeft=${v.railL}`);
      check("max thumb attaches to the rail's right end",
        near(v.h1r, v.railR), `thumbRight=${v.h1r} railRight=${v.railR}`);
    });

    // --- disabled rows keep rail + marker (context for the current value) ---
    await attempt("disabled row shows rail and marker, hides slider", async () => {
      const v = await cdp.evaluate(`(() => {
        const row = [...document.querySelectorAll('.vz-slider-row')].find(r => r.classList.contains('vz-off'));
        if (!row) return { error: 'no off row' };
        const vis = (el) => el && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
        return {
          rail: vis(row.querySelector('.vz-rail')),
          marker: vis(row.querySelector('.vz-marker')),
          sliderHidden: !vis(row.querySelector('.vz-slider')),
        };
      })()`);
      check("off row: rail+marker visible, slider hidden",
        v.rail === true && v.marker === true && v.sliderHidden === true, JSON.stringify(v));
    });

    // --- label click inserts {key} into focused suffix ---
    await attempt("slider label click inserts {key} at cursor", async () => {
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
      // the label click inserts the row's own placeholder — the auto-enabled
      // denoise row floats to the top, so the first row's key ends in denoise
      const ok = /^pre_\{[\w.]*denoise\}_post$/.test(result.value);
      check("suffix contains graph-appropriate {denoise} at cursor",
        ok,
        JSON.stringify(result));
    });

    // --- Esc closes the modal ---
    await attempt("Esc closes the modal", async () => {
      await cdp.key("Escape");
      const closed = await cdp.poll(`!document.querySelector('.vz-root')`, 5000)
        .then(() => true).catch(() => false);
      check("Esc closes modal", closed);
    });

    // --- backdrop click closes the modal ---
    await attempt("backdrop click closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`!!document.querySelector('.vz-root .vz-panel')`, 5000);
      await cdp.evaluate(`(() => {
        const root = document.querySelector('.vz-root');
        // click DIRECTLY on the root (backdrop), not on the panel
        root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      })()`);
      const closed = await cdp.poll(`!document.querySelector('.vz-root')`, 5000)
        .then(() => true).catch(() => false);
      check("backdrop click closes modal", closed);
    });

    // --- wand re-click closes the modal ---
    await attempt("wand re-click closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`!!document.querySelector('.vz-root .vz-panel')`, 5000);
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      const closed = await cdp.poll(`!document.querySelector('.vz-root')`, 5000)
        .then(() => true).catch(() => false);
      check("wand re-click closes modal", closed);
    });

    // --- × button closes the modal ---
    await attempt("× button closes modal", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`!!document.querySelector('.vz-root .vz-panel')`, 5000);
      await cdp.evaluate(`document.querySelector('.vz-close').click()`);
      const closed = await cdp.poll(`!document.querySelector('.vz-root')`, 5000)
        .then(() => true).catch(() => false);
      check("× button closes modal", closed);
    });

    // --- Run submits and produces a result message ---
    // The auto-enabled denoise row carries a default range — Run goes
    // straight through the UI, and the result message is polled (no
    // library-API setup, no fixed sleeps).
    await attempt("Run produces a result message", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row:not(.vz-off)').length > 0`, 5000);
      await cdp.evaluate(`document.querySelector('.vz-run').click()`);
      const hasResult = await cdp.poll(`(document.querySelector('.vz-error')?.textContent ?? '').length > 0`, 10000)
        .then(() => true).catch(() => false);
      const errText = await cdp.evaluate(`
        document.querySelector('.vz-error')?.textContent ?? ''
      `);
      check("Run produces a result message", hasResult, errText);
      // cleanup: close any lingering modal
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
      await cdp.poll(`!document.querySelector('.vz-root')`, 5000).catch(() => {});
    });

    // --- relative ranges (batch mode) ----------------------------------------
    // Offsets resolve against each image's own current value at run time;
    // params the graph lacks drop out instead of erroring.
    await attempt("relative run resolves offsets per image", async () => {
      const res = await cdp.evaluate(`(async () => {
        const r = await fetch("/api/features/variations/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "fake:flux-basic.png", host: "fake", filename: "flux-basic.png",
            relative: true,
            ranges: {
              "BasicScheduler.steps": { enabled: true, min: -5, max: 5, increment: 1, clamp: [1, 150] },
              "FluxGuidance.guidance": { enabled: true, min: -1, max: 1, increment: 0.5, clamp: [0, 30] },
              "CFGGuider.cfg": { enabled: true, min: -1, max: 1, increment: 0.5, clamp: [0, 30] },
            },
            prefix: "", suffix: "",
          }),
        });
        return { status: r.status, body: await r.json() };
      })()`);
      // flux-basic graph: steps=20, guidance=3.5, no cfg node (SamplerCustom
      // Advanced, no CfgGuider). steps 20±5 → 11 values; guidance 3.5±1 →
      // 5 values; cartesian 55 minus the current combo → 54. cfg drops out
      // silently — had it stayed in, the total would differ.
      check("relative run resolves offsets per image",
        res.status === 200 && res.body.total === 54,
        JSON.stringify(res.body).slice(0, 140));
    });

    // --- lora strength rows ----------------------------------------------------
    // flux-lora.png carries two LoraLoader nodes (model 0.8/clip 0.8 and
    // model 0.5/clip 0.5): the panel must surface both strength params with
    // the first carrier's current values.
    await attempt("lora strength rows surface on a lora graph", async () => {
      // make sure the fixture's bytes (and embedded graph) are ingested —
      // AWAITED: the probe right below needs the graph in the cache
      await cdp.evaluate(`(async () => {
        await fetch("/api/collections/fake/entries/flux-lora.png/bytes");
        return true;
      })()`);
      await cdp.evaluate(`
        document.querySelector('.card[data-name="flux-lora.png"] .votebtn.variations').click()
      `);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      const info = await cdp.evaluate(`(() => {
        const out = {};
        for (const r of document.querySelectorAll('.vz-slider-row')) {
          const label = r.querySelector('.vz-label')?.textContent;
          out[label] = r.querySelector('.vz-current')?.textContent ?? null;
        }
        return out;
      })()`);
      check("lora strength row with first-carrier current",
        info["LoraLoader.strength_model"] != null && parseFloat(info["LoraLoader.strength_model"]) === 0.8,
        JSON.stringify(info));
      check("lora clip strength row with first-carrier current",
        info["LoraLoader.strength_clip"] != null && parseFloat(info["LoraLoader.strength_clip"]) === 0.8,
        JSON.stringify(info));
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
      await cdp.poll(`!document.querySelector('.vz-root')`, 5000).catch(() => {});
    });

    // --- lora strength run mutates both carriers -------------------------------
    // Both LoraLoader nodes get the swept strength_model; the filename suffix
    // resolves {lora_strength} from the permutation.
    await attempt("lora strength sweep hits every loader", async () => {
      const res = await cdp.evaluate(`(async () => {
        const r = await fetch("/api/features/variations/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "fake:flux-lora.png", host: "fake", filename: "flux-lora.png",
            ranges: {
              "LoraLoader.strength_model": { enabled: true, min: 0.5, max: 1.0, increment: 0.5 },
            },
            prefix: "", suffix: "_{LoraLoader.strength_model}",
          }),
        });
        return { status: r.status, body: await r.json() };
      })()`);
      // 0.5..1.0 step 0.5 → 0.5, 1.0 (current 0.8 excluded) → 2 permutations;
      // the fake host 404s each /api/prompt, but the permutation list must
      // carry the swept id with the swept values.
      const perms = (res.body.errors ?? []).map((e) => e.permutation?.["LoraLoader.strength_model"]);
      check("lora strength sweep produces the swept permutations",
        res.status === 200 && res.body.total === 2
          && perms.includes(0.5) && perms.includes(1.0),
        JSON.stringify(res.body).slice(0, 160));
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
