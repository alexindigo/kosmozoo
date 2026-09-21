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

    // --- enum sweep rows: the host's own options, per node ---------------------
    // flux-lora's two LoraLoader nodes each get a row listing the fake host's
    // lora_name options; the image's current value is pre-checked and orange.
    await attempt("enum rows list the host's options, current checked + orange", async () => {
      await cdp.evaluate(`(async () => {
        await fetch("/api/collections/fake/entries/flux-lora.png/bytes");
        return true;
      })()`);
      await cdp.evaluate(`
        document.querySelector('.card[data-name="flux-lora.png"] .votebtn.variations').click()
      `);
      await cdp.poll(`document.querySelectorAll('.vz-enumrow').length > 0`, 5000);
      const info = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.vz-enumrow')];
        return {
          ids: rows.map((r) => r.dataset.enumId),
          labels: rows.map((r) => r.querySelector('.vz-imgrow-label')?.textContent),
          curs: rows.map((r) => r.querySelector('.vz-enum-cur')?.textContent),
        };
      })()`);
      // info-panel order: class_type, then input; per-instance rows in graph
      // order (alphabetically: BasicScheduler < CLIPLoader < KSamplerSelect <
      // LoraLoader < UNETLoader < VAELoader)
      check("one enum row per node instance, info-panel order",
        info.ids.join("|") === [
          "BasicScheduler#9.scheduler",
          "CLIPLoader#3.clip_name", "CLIPLoader#3.type",
          "KSamplerSelect#8.sampler_name",
          "LoraLoader#20.lora_name", "LoraLoader#21.lora_name",
          "UNETLoader#1.unet_name", "UNETLoader#1.weight_dtype",
          "VAELoader#13.vae_name",
        ].join("|"),
        JSON.stringify(info));
      check("per-node current values in the row heads",
        info.curs.join("|") === [
          "simple", "t5xxl_fp16.safetensors", "flux", "euler",
          "detail.safetensors", "style.safetensors",
          "flux1-dev.safetensors", "default", "ae.safetensors",
        ].join("|"),
        JSON.stringify(info.curs));

      // enable node 20's row: the host's options render, current pre-checked
      await cdp.clickAt('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-imgrow-head .vz-cb');
      await cdp.poll(`document.querySelectorAll('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-enum-opt').length === 3`, 5000);
      // the enabled enum row floats to the top — right after the auto-enabled
      // denoise row; the disabled rows keep info-panel order below
      const order = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.vz-slider-row, .vz-enumrow')];
        return rows.map((r) => r.dataset.enumId ?? r.dataset.paramKey);
      })()`);
      check("enabled enum row floats to the top",
        order[0] === "BasicScheduler.denoise"
          && order[1] === "LoraLoader#20.lora_name"
          && order.indexOf("KSamplerSelect#8.sampler_name") > 1,
        JSON.stringify(order));
      const opts = await cdp.evaluate(`(() => {
        const row = document.querySelector('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"]');
        const probe = document.createElement('span');
        probe.style.color = 'var(--attention)';
        document.body.appendChild(probe);
        const orange = getComputedStyle(probe).color;
        probe.remove();
        return [...row.querySelectorAll('.vz-enum-opt')].map((o) => ({
          name: o.querySelector('.vz-enum-opt-name')?.textContent,
          checked: o.querySelector('input').checked,
          isCurrent: o.classList.contains('vz-enum-current'),
          color: getComputedStyle(o.querySelector('.vz-enum-opt-name')).color,
          orange,
        }));
      })()`);
      check("options are the host's own list, in order",
        opts.map((o) => o.name).join("|") === "detail.safetensors|style.safetensors|other.safetensors",
        JSON.stringify(opts.map((o) => o.name)));
      const cur = opts.find((o) => o.name === "detail.safetensors");
      check("current option pre-checked, orange-marked",
        cur?.checked === true && cur?.isCurrent === true && cur?.color === cur?.orange,
        JSON.stringify(cur));
      check("other options neither checked nor orange",
        opts.filter((o) => o.name !== "detail.safetensors")
          .every((o) => !o.checked && !o.isCurrent && o.color !== o.orange),
        JSON.stringify(opts));

      // pick a second value: 2 picks × the auto-enabled denoise range →
      // (denoise-only count + 1) × 2 − 1 (the current combo excluded once)
      const c0 = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      const idx = await cdp.evaluate(`(() => {
        const opts = [...document.querySelectorAll('.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-enum-opt')];
        return opts.findIndex((o) => o.querySelector('.vz-enum-opt-name')?.textContent === 'other.safetensors') + 1;
      })()`);
      await cdp.clickAt(`.vz-enumrow[data-enum-id="LoraLoader#20.lora_name"] .vz-enum-list .vz-enum-opt:nth-of-type(${idx}) .vz-cb`);
      const expected = (c0 + 1) * 2 - 1;
      await cdp.poll(`parseInt(document.querySelector('.vz-count')?.textContent, 10) === ${expected}`, 5000);
      const c1 = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      check("2 picks × numeric range → the right count",
        c1 === expected, `denoise-only=${c0} with-2-picks=${c1} expected=${expected}`);
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
      await cdp.poll(`!document.querySelector('.vz-root')`, 5000).catch(() => {});
    });

    // --- enum sweep run: picks enqueue on the right node ------------------------
    await attempt("enum sweep run enqueues the picks on the right node", async () => {
      const res = await cdp.evaluate(`(async () => {
        const r = await fetch("/api/features/variations/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "fake:flux-lora.png", host: "fake", filename: "flux-lora.png",
            ranges: {
              "LoraLoader.strength_model": { enabled: true, min: 0.5, max: 1.0, increment: 0.5 },
            },
            imageParams: {
              "LoraLoader#20.lora_name": { enabled: true, values: ["detail.safetensors", "other.safetensors"] },
            },
            prefix: "", suffix: "",
          }),
        });
        return { status: r.status, body: await r.json() };
      })()`);
      // strength 0.5/1.0 (current 0.8 excluded) × lora detail/other = 4; the
      // all-current combo isn't among them (0.8 is out of range) → 4 total
      const perms = (res.body.errors ?? []).map((e) => e.permutation);
      const loras = perms.map((p) => p?.["LoraLoader#20.lora_name"]);
      check("enum picks multiply the numeric range and enqueue",
        res.status === 200 && res.body.total === 4
          && loras.filter((v) => v === "detail.safetensors").length === 2
          && loras.filter((v) => v === "other.safetensors").length === 2,
        JSON.stringify(res.body).slice(0, 200));
    });

    // --- text sweep rows: prompts are user-valued axes ---------------------------
    // flux-basic's only free-text input is the CLIPTextEncode prompt — the
    // SaveImage prefix is the run's own machinery and gets no row.
    await attempt("text rows surface prompts, not the output prefix", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      const info = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.vz-textrow')];
        const all = [...document.querySelectorAll('.vz-slider-row, .vz-enumrow, .vz-textrow')];
        const last = all.at(-1);
        return {
          ids: rows.map((r) => r.dataset.textId),
          curs: rows.map((r) => r.querySelector('.vz-enum-cur')?.textContent),
          last: last?.dataset.textId ?? last?.dataset.enumId ?? last?.dataset.paramKey,
        };
      })()`);
      check("prompt text row present, output prefix absent",
        info.ids.join() === "CLIPTextEncode#2.text"
          && info.curs[0] === "a portrait, studio light",
        JSON.stringify(info));
      check("prompt row sinks to the bottom (info-panel order)",
        info.last === "CLIPTextEncode#2.text", info.last);

      // enable → textarea pre-filled with the current prompt; a second line
      // doubles the sweep (minus the current combo)
      await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-imgrow-head .vz-cb');
      await cdp.poll(`!!document.querySelector('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values')`, 5000);
      const pre = await cdp.evaluate(`document.querySelector('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values').value`);
      check("textarea pre-filled with the current text",
        pre === "a portrait, studio light", JSON.stringify(pre));
      const c0 = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      await cdp.evaluate(`(() => {
        const t = document.querySelector('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values');
        t.value = t.value + "\\na cyberpunk alley, rain";
        t.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const expected = (c0 + 1) * 2 - 1;
      await cdp.poll(`parseInt(document.querySelector('.vz-count')?.textContent, 10) === ${expected}`, 5000);
      check("2 text values × numeric range → the right count",
        parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10) === expected,
        `denoise-only=${c0} expected=${expected}`);
      // the enabled text row floats to the top (the prompt sink applies to
      // the disabled rows, not the enabled group)
      const order = await cdp.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.vz-slider-row, .vz-enumrow, .vz-textrow')];
        return rows.map((r) => r.dataset.textId ?? r.dataset.enumId ?? r.dataset.paramKey);
      })()`);
      check("enabled text row floats to the top",
        order[0] === "BasicScheduler.denoise" && order[1] === "CLIPTextEncode#2.text",
        JSON.stringify(order));
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
      await cdp.poll(`!document.querySelector('.vz-root')`, 5000).catch(() => {});
    });

    // --- text sweep run: picks enqueue verbatim ----------------------------------
    await attempt("text sweep run enqueues the picked prompts", async () => {
      const res = await cdp.evaluate(`(async () => {
        const r = await fetch("/api/features/variations/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "fake:flux-basic.png", host: "fake", filename: "flux-basic.png",
            ranges: {},
            imageParams: {
              "CLIPTextEncode#2.text": { enabled: true, values: ["a portrait, studio light", "a cyberpunk alley, rain"] },
            },
            prefix: "", suffix: "",
          }),
        });
        return { status: r.status, body: await r.json() };
      })()`);
      const texts = (res.body.errors ?? []).map((e) => e.permutation?.["CLIPTextEncode#2.text"]);
      check("text picks enqueue, current combo excluded",
        res.status === 200 && res.body.total === 1
          && texts.join() === "a cyberpunk alley, rain",
        JSON.stringify(res.body).slice(0, 160));
    });

    // --- template axes: {{label}} substitution inputs ------------------------------
    // Typing {{label}} into the textarea spawns a values input per label; the
    // picks are the cartesian expansion (empty values substitute with "").
    await attempt("template axes expand {{label}} substitutions cartesian-style", async () => {
      await cdp.evaluate(`
        document.querySelector('.card[data-idx="0"] .votebtn.variations').click()
      `);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length > 0`, 5000);
      await cdp.clickAt('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-imgrow-head .vz-cb');
      await cdp.poll(`!!document.querySelector('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values')`, 5000);
      // spy on the run payload — the expansion is client-side, the POST body
      // is the honest record of what would be enqueued
      await cdp.evaluate(`(() => {
        const orig = window.fetch;
        window.__runBodies = [];
        window.fetch = (...a) => {
          if (String(a[0]).includes('/features/variations/run')) window.__runBodies.push(a[1]?.body);
          return orig(...a);
        };
      })()`);
      // a two-label template spawns two substitution inputs, in order
      await cdp.evaluate(`(() => {
        const t = document.querySelector('.vz-textrow[data-text-id="CLIPTextEncode#2.text"] .vz-text-values');
        t.value = "a {{animal}}, {{style}} style";
        t.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await cdp.poll(`document.querySelectorAll('.vz-textrow .vz-tpl-row').length === 2`, 5000);
      const labels = await cdp.evaluate(`
        [...document.querySelectorAll('.vz-textrow .vz-tpl-label')].map((l) => l.textContent)
      `);
      check("one substitution input per label, first-appearance order",
        labels.join("|") === "animal|style", JSON.stringify(labels));
      const setTpl = async (i, v) => {
        await cdp.evaluate(`(() => {
          const inp = document.querySelectorAll('.vz-textrow .vz-tpl-input')[${i}];
          inp.value = ${JSON.stringify(v)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
      };
      // a label without values inerts the row — the count is denoise-only
      const c0 = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      await setTpl(0, "cat; dog");
      const cInert = parseInt(await cdp.evaluate(`document.querySelector('.vz-count')?.textContent`), 10);
      check("unconfigured label inerts the row", cInert === c0, `c0=${c0} got=${cInert}`);
      // both labels configured: 2×2 cartesian; the current text is NOT among
      // the picks (it has no placeholders), so no current-combo exclusion
      await setTpl(1, "oil; ink");
      const expected4 = (c0 + 1) * 4;
      await cdp.poll(`parseInt(document.querySelector('.vz-count')?.textContent, 10) === ${expected4}`, 5000);
      check("2×2 labels cartesian → the right count", true, `count=${expected4}`);
      // an empty segment is a real value (the token substitutes with "")
      await setTpl(1, "oil; ; ink");
      const expected6 = (c0 + 1) * 6;
      await cdp.poll(`parseInt(document.querySelector('.vz-count')?.textContent, 10) === ${expected6}`, 5000);
      check("empty value counts as a value", true, `count=${expected6}`);
      // Run: the captured payload carries the fully expanded texts
      await cdp.evaluate(`document.querySelector('.vz-run').click()`);
      await cdp.poll(`(document.querySelector('.vz-error')?.textContent ?? '').length > 0`, 10000);
      const values = await cdp.evaluate(`(() => {
        const body = JSON.parse(window.__runBodies[0] ?? "{}");
        return body.imageParams?.["CLIPTextEncode#2.text"]?.values ?? null;
      })()`);
      check("run payload carries the expanded texts (empty value included)",
        JSON.stringify(values) === JSON.stringify([
          "a cat, oil style", "a cat,  style", "a cat, ink style",
          "a dog, oil style", "a dog,  style", "a dog, ink style",
        ]),
        JSON.stringify(values));
      await cdp.evaluate(`document.querySelector('.vz-close')?.click()`);
      await cdp.poll(`!document.querySelector('.vz-root')`, 5000).catch(() => {});
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
