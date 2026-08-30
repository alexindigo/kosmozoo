// client/app/components/VariationsModal.mjs — the variations panel: a real
// page-level modal for batch parameter sweeps.
//
// One modal at a time (page-level fixed overlay with backdrop), rendered
// into its own container on document.body — the modal is a page citizen,
// not a child of the app tree. Layout:
//   - Title centered at top
//   - Left: parameter rows (<SliderRow>), enabled cards float to the top
//   - Vertical divider
//   - Right: variations count (big), prefix, suffix, Run
//
// Slider rows are populated once the probe returns — the graph decides
// which parameters have a target node, and only those render. The label
// click inserts the per-graph placeholder key into whichever prefix/suffix
// input was last focused. Prefix/suffix WRAP the original filename basename
// in the submission (they don't replace it).

import { h, render as preactRender, useState, useEffect, useRef } from "../../vendor/preact/vendor.mjs";
import { iconSvg } from "../../js/icons.mjs";
import { paramDef, defaultRange, fallbackParams } from "../../js/variations.mjs";
import { SliderRow } from "./SliderRow.mjs";

export function VariationsModal({ images, onClose }) {
  const image = images[0];
  // batch = more than one image: ranges become RELATIVE offsets from each
  // image's own current value (resolved by the plugin at run time), and the
  // count shows the total across the whole selection.
  const batch = images.length > 1;
  const [params, setParams] = useState(null); // null = probing; [] = none
  const [strParams, setStrParams] = useState([]); // LoadImage sweep axes
  const [imgRows, setImgRows] = useState({});   // id -> { enabled, mode, file, files, current, label }
  const [rows, setRows] = useState({});       // key -> { enabled, min, max, increment, placeholderKey }
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null); // { text, ok }
  const prefixRef = useRef(null);
  const suffixRef = useRef(null);
  // Tracks last-focused prefix/suffix input so slider labels can insert
  // {key} placeholders at the cursor.
  const templateTarget = useRef({ input: null, start: 0, end: 0 });

  // callbacks are captured by the rows' mount-once slider effects, so they
  // read live state through a ref instead of a stale closure
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const imgRowsRef = useRef(imgRows);
  imgRowsRef.current = imgRows;

  useEffect(() => {
    const meta = image.meta ?? {};
    // The graph is the source of truth: only render sliders for parameters
    // whose target node exists in this image's graph. writeOnly params
    // (widget-only custom seed nodes etc.) are skipped for now — they need
    // a different UX and the user is deferring that.
    const resolve = (forGraph) => {
      const init = {};
      for (const { id, key, current, integer, type, title } of forGraph) {
        const p = paramDef(id, current, integer);
        // absolute: a value window around the current value; relative
        // (batch): signed offsets around it, default ±spread
        const def = batch ? { min: -p.spread, max: p.spread } : defaultRange(p, current);
        init[id] = {
          enabled: false, min: def.min, max: def.max, increment: p.defaultInc,
          placeholderKey: id,
          current, integer,
          label: title ?? type, // node display title else class_type
          input: key,
        };
      }
      setRows(init);
      setParams(forGraph);
      // Presentation nicety: auto-enable the denoise row when the graph has
      // one — the user lands on the most common single-axis sweep. Matches
      // any node type; "denoise" is the input name, not a node name.
      const denoiseKey = Object.keys(init).find((k) => init[k].input === "denoise");
      if (denoiseKey) {
        init[denoiseKey].enabled = true;
        if (suffixRef.current) suffixRef.current.value = `_{${denoiseKey}}`;
      }
    };
    console.log("[variations] fetching probe for", image.id);
    fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
      .then((r) => {
        console.log("[variations] probe status:", r.status);
        return r.ok ? r.json() : null;
      })
      .then((data) => {
        if (!data?.params) return resolve(fallbackParams(meta));
        resolve(data.params);
        // LoadImage sweep axes: one row per string param, files listed from
        // the host's input dir
        const sp = data.stringParams ?? [];
        setStrParams(sp);
        if (sp.length && image.host) {
          fetch(`/api/input-list/${encodeURIComponent(image.host)}`)
            .then((r) => (r.ok ? r.json() : []))
            .then((files) => {
              const init = {};
              for (const p of sp) {
                init[p.id] = {
                  enabled: false, mode: "new", file: files[0] ?? null,
                  files, current: p.current, label: p.title ?? p.type,
                  localFiles: null,   // File[] picked from a local directory
                };
              }
              setImgRows(init);
            })
            .catch(() => {});
        }
      })
      .catch((e) => {
        console.warn("[variations] probe failed:", e);
        resolve(fallbackParams(meta));
      });
  }, []);

  // Esc closes (capture phase: the modal outranks everything under it)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const onToggle = (key, checked) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], enabled: checked } }));
    // enabling auto-inserts the placeholder token into the suffix;
    // disabling removes it. No trailing underscore — ComfyUI's SaveImage
    // node adds its own separator before the counter.
    const ph = rowsRef.current[key]?.placeholderKey;
    const inp = suffixRef.current;
    if (!ph || !inp) return;
    const token = `_{${ph}}`;
    if (checked) {
      if (!inp.value.includes(token)) inp.value = inp.value + token;
    } else {
      if (inp.value.includes(token)) inp.value = inp.value.split(token).join("");
    }
  };

  const onRange = (key, { min, max }) => {
    setRows((rs) => (rs[key] ? { ...rs, [key]: { ...rs[key], min, max } } : rs));
  };

  // LoadImage sweep: enabling auto-inserts the {LoadImage.image} token into
  // the suffix (the output name must encode WHICH input image produced it);
  // disabling removes it. Same grammar as the numeric placeholder tokens.
  const onImgToggle = (id, checked) => {
    setImgRows((rs) => ({ ...rs, [id]: { ...rs[id], enabled: checked } }));
    const inp = suffixRef.current;
    if (!inp) return;
    const token = `_{${id}}`;
    if (checked) {
      if (!inp.value.includes(token)) inp.value = inp.value + token;
    } else {
      if (inp.value.includes(token)) inp.value = inp.value.split(token).join("");
    }
  };
  const onImgField = (id, field, value) => {
    setImgRows((rs) => ({ ...rs, [id]: { ...rs[id], [field]: value } }));
  };

  const onIncrement = (key, inc) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], increment: inc } }));
  };

  // last-focused template input remembers its selection for label clicks
  const remember = (e) => {
    const inp = e.target;
    templateTarget.current.input = inp;
    templateTarget.current.start = inp.selectionStart ?? inp.value.length;
    templateTarget.current.end = inp.selectionEnd ?? inp.value.length;
  };

  // enabled cards first, then by node label + input name
  const ordered = Object.keys(rows).sort((a, b) => {
    const ea = rows[a].enabled ? 0 : 1;
    const eb = rows[b].enabled ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const la = `${rows[a].label}.${rows[a].input}`;
    const lb = `${rows[b].label}.${rows[b].input}`;
    return la.localeCompare(lb);
  });

  // variations count: product of per-param steps. Absolute mode subtracts
  // the current combo; batch subtracts it only when every enabled range
  // actually contains the current value (offset 0).
  // variations count: product of per-param steps. The engine excludes the
  // exact current combo — subtract it ONLY when that combo is actually in
  // the product: every enabled range must contain its current value AND the
  // value must land on a step of the range's increment. (In batch mode the
  // "current" is offset 0, which is in a range only when it spans 0.)
  // variations count: product of per-param steps. The engine excludes the
  // exact current combo — subtract it ONLY when EVERY enabled axis sits at
  // its current value. A swept LoadImage axis whose values exclude the
  // current filename makes every numeric combo novel, so nothing is
  // subtracted then.
  let perImage = 1;
  let anyEnabled = false;
  let numericCurrentInRange = true;
  for (const [key, r] of Object.entries(rows)) {
    if (!r.enabled) continue;
    anyEnabled = true;
    const inc = r.increment || paramDef(key, r.current, r.integer)?.defaultInc || 1;
    perImage *= Math.max(Math.round((r.max - r.min) / inc) + 1, 1);
    if (batch) {
      // offsets around the image's own value: combo 0 is in the product iff
      // every enabled offset range spans 0 on a step boundary
      if (!(r.min <= 0 && r.max >= 0)) numericCurrentInRange = false;
      else {
        const steps = (0 - r.min) / inc;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) numericCurrentInRange = false;
      }
    } else {
      const cur = r.current;
      if (cur == null || cur < r.min || cur > r.max) numericCurrentInRange = false;
      else {
        const steps = (cur - r.min) / inc;
        if (Math.abs(steps - Math.round(steps)) > 1e-6) numericCurrentInRange = false;
      }
    }
  }
  // LoadImage sweep axes multiply the count; an enabled-but-empty row (a
  // local mode with nothing picked yet) is inert.
  let imagesAtCurrent = true;
  for (const r of Object.values(imgRows)) {
    if (!r.enabled) continue;
    const vals = r.mode === "new" ? (r.file ? [r.file] : []) : (r.localFiles ?? []);
    if (!vals.length) continue;
    anyEnabled = true;
    perImage *= vals.length;
    if (!(r.current && vals.includes(r.current))) imagesAtCurrent = false;
  }
  // subtract the current combo only when numeric axes are at current AND
  // every swept image axis includes the current filename
  const excludeCurrent = anyEnabled && numericCurrentInRange && imagesAtCurrent;
  if (excludeCurrent && perImage > 0) perImage -= 1;
  const n = anyEnabled ? perImage * images.length : 0;

  async function runVariations() {
    setResult(null);
    setRunning(true);
    try {
      const baseRanges = {};
      for (const [key, r] of Object.entries(rowsRef.current)) {
        baseRanges[key] = {
          enabled: r.enabled, min: r.min, max: r.max,
          increment: r.increment, placeholderKey: r.placeholderKey,
          // batch ranges are offsets; the plugin clamps them per image
          ...(batch ? { clamp: paramDef(key, r.current, r.integer)?.clamp } : {}),
        };
      }
      const prefix = prefixRef.current?.value ?? "";
      const suffix = suffixRef.current?.value ?? "";
      // LoadImage sweep axes: enabled rows become enum imageParams. A
      // "local directory" row uploads its picked files to the host's input
      // dir first (ComfyUI's LoadImage only reads that dir), then sweeps
      // over the uploaded names.
      const imageParams = {};
      const uploadErrors = [];
      for (const [id, r] of Object.entries(imgRowsRef.current)) {
        if (!r.enabled) continue;
        let values = [];
        if (r.mode === "new") {
          values = r.file ? [r.file] : [];
        } else {
          // local directory / local files: upload the picked files to the
          // host's input dir (ComfyUI's LoadImage only reads that dir),
          // then sweep over the names they land under
          for (const f of r.localFiles ?? []) {
            try {
              const form = new FormData();
              form.append("image", f, f.name);
              const res = await fetch(`/api/upload-input/${encodeURIComponent(image.host)}`, {
                method: "POST", body: form,
              });
              const d = res.ok ? await res.json() : null;
              if (d?.name) values.push(d.name);
              else uploadErrors.push(`${f.name}: upload failed`);
            } catch (e) {
              uploadErrors.push(`${f.name}: ${e.message}`);
            }
          }
        }
        if (values.length) imageParams[id] = { enabled: true, values };
      }
      let submitted = 0, totalJobs = 0;
      const failed = [];
      const engineErrors = uploadErrors.slice();
      const submit = async (img) => {
        const res = await fetch("/api/plugins/variations/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: img.id, host: img.host, filename: img.filename,
            ranges: structuredClone(baseRanges),
            prefix, suffix,
            ...(batch ? { relative: true } : {}),
            ...(Object.keys(imageParams).length ? { imageParams } : {}),
          }),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = null; }
        if (!res.ok) {
          failed.push(`${img.filename}: ${data?.error ?? text ?? `error ${res.status}`}`);
          return;
        }
        submitted += data.submitted ?? 0;
        totalJobs += data.total ?? 0;
        // the engine reports per-permutation failures inline — collect the
        // detail from the SAME response (a second POST would double-submit)
        for (const e of data.errors ?? []) {
          engineErrors.push(e?.error ?? String(e));
        }
      };
      await Promise.all(images.map(async (img) => {
        try {
          await submit(img);
        } catch (e) {
          failed.push(`${img.filename}: ${e.message}`);
        }
      }));
      const allFailed = submitted === 0 && totalJobs > 0;
      if ((submitted === 0 && totalJobs === 0) || allFailed) {
        const detail = failed[0] ?? engineErrors[0] ?? "nothing submitted";
        setResult({ text: detail, ok: false });
        return;
      }
      const summary = (batch
        ? `submitted ${submitted}/${totalJobs} across ${images.length} images`
        : `submitted ${submitted}/${totalJobs}`)
        + (failed.length ? ` (${failed.length} failed)` : "")
        + (engineErrors.length ? ` — ${engineErrors[0]}` : "");
      setResult({ text: summary, ok: !allFailed && submitted > 0 });
      setTimeout(onClose, 3000);
    } catch (e) {
      setResult({ text: `fetch failed: ${e.message}`, ok: false });
    } finally {
      setRunning(false);
    }
  }

  return h("div", { class: "vz-panel", onClick: (e) => e.stopPropagation() },
      h("div", { class: "vz-title" }, batch
        ? `Generate image variations · applying to ${images.length} images`
        : "Generate image variations"),
      h("div", { class: "vz-body" },
        h("div", { class: "vz-left" },
          h("div", { class: "vz-sliders" },
            // LoadImage sweep axes: pick a new image or the full input dir
            strParams.map((p) => {
              const r = imgRows[p.id];
              if (!r) return null;
              return h("div", { key: p.id, class: "vz-imgrow" + (r.enabled ? " on" : "") },
                h("label", { class: "vz-imgrow-head" },
                  h("input", {
                    type: "checkbox", class: "vz-cb", checked: r.enabled,
                    onChange: (e) => onImgToggle(p.id, e.target.checked),
                  }),
                  h("span", { class: "vz-imgrow-label" }, `${r.label}.image`),
                  h("span", { class: "vz-imgrow-cur", title: r.current }, r.current),
                ),
                r.enabled && h("div", { class: "vz-imgrow-body" },
                  h("select", {
                    class: "vz-imgmode", value: r.mode,
                    onChange: (e) => onImgField(p.id, "mode", e.target.value),
                  },
                    h("option", { value: "new" }, "new image…"),
                    h("option", { value: "local" }, "local directory…"),
                    h("option", { value: "files" }, "local files…"),
                  ),
                  r.mode === "new" && h("select", {
                    class: "vz-imgfile", value: r.file ?? "",
                    onChange: (e) => onImgField(p.id, "file", e.target.value),
                  },
                    r.files.map((f) => h("option", { key: f, value: f }, f)),
                  ),
                  // local directory: whole picked folder; local files: a
                  // multi-picked subset. Both read into r.localFiles.
                  r.mode === "local" && h("span", { class: "vz-imglocal" },
                    h("input", {
                      type: "file", class: "vz-imgdirpick", style: "display:none",
                      // @ts-ignore nonstandard but universal folder picker
                      webkitdirectory: "", multiple: true,
                      onChange: (e) => {
                        const fl = [...(e.target.files ?? [])].filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));
                        onImgField(p.id, "localFiles", fl);
                      },
                    }),
                    h("button", {
                      class: "vz-imgdirbtn",
                      onClick: (e) => e.currentTarget.parentElement.querySelector(".vz-imgdirpick").click(),
                    }, r.localFiles?.length ? `${r.localFiles.length} files picked` : "pick a folder…"),
                  ),
                  r.mode === "files" && h("span", { class: "vz-imglocal" },
                    h("input", {
                      type: "file", class: "vz-imgfilespick", style: "display:none",
                      multiple: true, accept: "image/*",
                      onChange: (e) => {
                        const fl = [...(e.target.files ?? [])].filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));
                        onImgField(p.id, "localFiles", fl);
                      },
                    }),
                    h("button", {
                      class: "vz-imgdirbtn",
                      onClick: (e) => e.currentTarget.parentElement.querySelector(".vz-imgfilespick").click(),
                    }, r.localFiles?.length ? `${r.localFiles.length} files picked` : "pick files…"),
                  ),
                ),
              );
            }),
            params === null
              ? h("div", { class: "vz-loading" }, "inspecting graph…")
              : params.length === 0
                ? h("div", { class: "vz-loading" }, "this graph exposes no varyable parameters")
                : ordered.map((key) => {
                    const r = rows[key];
                    const p = paramDef(key, r.current, r.integer);
                    const cur = r.current ?? null;
                    return h(SliderRow, {
                      key,
                      param: { ...p, label: r.label ? `${r.label}.${r.input}` : p.label },
                      current: cur,
                      defaults: batch ? { min: -p.spread, max: p.spread } : defaultRange(p, cur),
                      enabled: r.enabled,
                      increment: r.increment,
                      placeholderKey: r.placeholderKey,
                      relative: batch,
                      onToggle, onRange, onIncrement,
                      templateTarget: templateTarget.current,
                    });
                  }),
          ),
        ),
        h("div", { class: "vz-divider" }),
        h("div", { class: "vz-right" },
          h("div", { class: "vz-rlabel" }, "variations"),
          h("div", {
            class: "vz-count" + (n > 1000 ? " vz-count-hot" : n > 100 ? " vz-count-warn" : ""),
          }, String(n)),
          batch && anyEnabled ? h("div", { class: "vz-count-sub" },
            `${perImage} variants × ${images.length} images`) : null,
          h("div", { class: "vz-rlabel" }, "prefix"),
          h("input", {
            type: "text", class: "vz-tinput vz-prefix", ref: prefixRef,
            title: "click a slider label to insert its {placeholder}",
            onFocus: remember, onSelect: remember, onKeyUp: remember, onMouseUp: remember, onInput: remember,
          }),
          h("div", { class: "vz-rlabel" }, "suffix"),
          h("input", {
            type: "text", class: "vz-tinput vz-suffix", ref: suffixRef,
            title: "click a slider label to insert its {placeholder} (enabled sliders auto-append)",
            onFocus: remember, onSelect: remember, onKeyUp: remember, onMouseUp: remember, onInput: remember,
          }),
          // spacer pushes Run + error to the BOTTOM of the right column, so
          // the primary action sits opposite the tallest content on the left
          h("div", { class: "vz-rspacer" }),
          h("button", {
            class: "vz-run", disabled: running || undefined, onClick: runVariations,
          }, running ? "Running…" : "Run"),
          h("div", { class: "vz-error" + (result?.ok ? " vz-ok" : "") }, result?.text ?? ""),
        ),
      ),
      h("button", {
        class: "vz-close", title: "close (Esc)", onClick: onClose,
        dangerouslySetInnerHTML: { __html: iconSvg("x", 16) },
      }),
  );
}

// --- single-instance lifecycle on document.body ------------------------------
//
// The backdrop is a dedicated empty div appended to body; the component
// renders the panel inside it. (Rendering straight into body is forbidden:
// Preact recycles a container's pre-existing children as excess DOM and
// would eat #app.) The contract holds: .vz-root directly under BODY, gone
// on close.

let mounted = null; // { root, key }

function openModal(images, key) {
  closeAllVariations();
  const root = document.createElement("div");
  root.className = "vz-root";
  root.addEventListener("click", (e) => {
    if (e.target === root) closeAllVariations(); // backdrop closes
  });
  document.body.appendChild(root);
  preactRender(h(VariationsModal, { images, onClose: closeAllVariations }), root);
  mounted = { root, key };
}

// Single-image entry (the card's wand): absolute ranges around that image's
// current value.
export function toggleVariations(_cardEl, image) {
  if (mounted && mounted.key === image.id) {
    closeAllVariations();
    return;
  }
  openModal([image], image.id);
}

// Bulk entry (the bulk bar's wand): RELATIVE sweeps applied to every
// selected image around its own current value — even for a single image,
// since that's the batch affordance.
export function toggleVariationsBulk(images) {
  const key = "batch:" + images.map((i) => i.id).join("|");
  if (mounted && mounted.key === key) {
    closeAllVariations();
    return;
  }
  openModal(images, key);
}

export function closeAllVariations() {
  if (!mounted) return;
  preactRender(null, mounted.root); // unmounts the panel subtree (cleanups run)
  mounted.root.remove();
  mounted = null;
}
