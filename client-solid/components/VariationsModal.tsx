// client-solid/components/VariationsModal.tsx — the variations panel,
// declarative: one <Portal> citizen on document.body, no mounted-tracker.
//
// Layout: title centered at top; left: parameter rows (<SliderRow>), enabled
// cards float to the top, LoadImage sweep rows above them; vertical divider;
// right: variations count (big), prefix, suffix, Run.
//
// Slider rows are populated once the probe returns — the graph decides which
// parameters have a target node, and only those render. The label click
// inserts the per-graph placeholder key into whichever prefix/suffix input
// was last focused. Prefix/suffix WRAP the original filename basename in the
// submission (they don't replace it).

import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { render } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { paramDef, defaultRange, fallbackParams } from "/js/variations.mjs";
import { useAppStore } from "../store/app-store.js";
import { SliderRow } from "./SliderRow.js";

export function VariationsModal() {
  const store = useAppStore();
  // keyed on the session object: switching the wand to another image (or
  // the bulk bar's batch) rebuilds the session from scratch
  return (
    <Show
      when={store.state.variations.open ? store.state.variations : null}
      keyed
    >
      {(v) => <BodyPortal images={[...v.images]} onClose={() => store.actions.variations.close()} />}
    </Show>
  );
}

// The modal is a page citizen: .vz-root sits DIRECTLY under document.body
// (the e2e asserts the parent). Solid's <Portal> wraps its content in a
// container div, and render()-into-body would let the dispose wipe the whole
// body — so the session renders into a dedicated body-appended .vz-root,
// exactly the outgoing structure. Still declarative from the app tree's
// side: the session lives and dies with the Show above, no mounted-tracker.
function BodyPortal(props) {
  let host;
  let dispose;
  onMount(() => {
    host = document.createElement("div");
    host.className = "vz-root";
    // backdrop click closes (the panel stops propagation)
    host.addEventListener("click", (e) => {
      if (e.target === host) props.onClose();
    });
    document.body.appendChild(host);
    dispose = render(() => <ModalBody images={props.images} onClose={props.onClose} />, host);
  });
  onCleanup(() => {
    dispose?.();
    host?.remove();
  });
  return null;
}

function ModalBody(props) {
  const image = props.images[0];
  // batch = more than one image: ranges become RELATIVE offsets from each
  // image's own current value (resolved by the plugin at run time), and the
  // count shows the total across the whole selection. (The bulk bar's entry
  // lands in phase 6; the machinery is live already.)
  const batch = props.images.length > 1;
  const [params, setParams] = createSignal(null); // null = probing; [] = none
  const [strParams, setStrParams] = createSignal([]); // LoadImage sweep axes
  const [imgRows, setImgRows] = createSignal({}); // id -> { enabled, mode, file, files, current, label, localFiles }
  const [rows, setRows] = createSignal({}); // key -> { enabled, min, max, increment, placeholderKey, ... }
  const [running, setRunning] = createSignal(false);
  const [result, setResult] = createSignal(null); // { text, ok }
  let prefixEl, suffixEl;
  // last-focused prefix/suffix input remembers its selection for label clicks
  const templateTarget = { input: null, start: 0, end: 0 };

  onMount(() => {
    const meta = image.meta ?? {};
    // The graph is the source of truth: only render sliders for parameters
    // whose target node exists in this image's graph. writeOnly params
    // (widget-only custom seed nodes etc.) are skipped for now.
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
      // Presentation nicety: auto-enable the denoise row when the graph has
      // one — the user lands on the most common single-axis sweep. Matches
      // any node type; "denoise" is the input name, not a node name.
      const denoiseKey = Object.keys(init).find((k) => init[k].input === "denoise");
      if (denoiseKey) {
        init[denoiseKey].enabled = true;
        if (suffixEl) suffixEl.value = `_{${denoiseKey}}`;
      }
      setRows(init);
      setParams(forGraph);
    };
    fetch(`/api/plugins/variations/probe/${encodeURIComponent(image.id)}`)
      .then((r) => (r.ok ? r.json() : null))
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
                  localFiles: null, // File[] picked from a local directory
                };
              }
              setImgRows(init);
            })
            .catch(() => {});
        }
      })
      .catch(() => resolve(fallbackParams(meta)));
  });

  // Esc closes (capture phase: the modal outranks everything under it)
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
  };
  document.addEventListener("keydown", onKey, true);
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  const onToggle = (key, checked) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], enabled: checked } }));
    // enabling auto-inserts the placeholder token into the suffix;
    // disabling removes it. No trailing underscore — ComfyUI's SaveImage
    // node adds its own separator before the counter.
    const ph = rows()[key]?.placeholderKey;
    const inp = suffixEl;
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

  const onIncrement = (key, inc) => {
    setRows((rs) => ({ ...rs, [key]: { ...rs[key], increment: inc } }));
  };

  // LoadImage sweep: enabling auto-inserts the {LoadImage.image} token into
  // the suffix (the output name must encode WHICH input image produced it);
  // disabling removes it. Same grammar as the numeric placeholder tokens.
  const onImgToggle = (id, checked) => {
    setImgRows((rs) => ({ ...rs, [id]: { ...rs[id], enabled: checked } }));
    const inp = suffixEl;
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

  const remember = (e) => {
    const inp = e.target;
    templateTarget.input = inp;
    templateTarget.start = inp.selectionStart ?? inp.value.length;
    templateTarget.end = inp.selectionEnd ?? inp.value.length;
  };

  // enabled cards first, then by node label + input name
  const ordered = () => Object.keys(rows()).sort((a, b) => {
    const rs = rows();
    const ea = rs[a].enabled ? 0 : 1;
    const eb = rs[b].enabled ? 0 : 1;
    if (ea !== eb) return ea - eb;
    const la = `${rs[a].label}.${rs[a].input}`;
    const lb = `${rs[b].label}.${rs[b].input}`;
    return la.localeCompare(lb);
  });

  // variations count: product of per-param steps. The engine excludes the
  // exact current combo — subtract it ONLY when EVERY enabled axis sits at
  // its current value. A swept LoadImage axis whose values exclude the
  // current filename makes every numeric combo novel, so nothing is
  // subtracted then.
  const tally = () => {
    let perImage = 1;
    let anyEnabled = false;
    let numericCurrentInRange = true;
    for (const [key, r] of Object.entries(rows())) {
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
    for (const r of Object.values(imgRows())) {
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
    return { n: anyEnabled ? perImage * props.images.length : 0, anyEnabled, perImage };
  };

  async function runVariations() {
    setResult(null);
    setRunning(true);
    try {
      const baseRanges = {};
      for (const [key, r] of Object.entries(rows())) {
        baseRanges[key] = {
          enabled: r.enabled, min: r.min, max: r.max,
          increment: r.increment, placeholderKey: r.placeholderKey,
          // batch ranges are offsets; the plugin clamps them per image
          ...(batch ? { clamp: paramDef(key, r.current, r.integer)?.clamp } : {}),
        };
      }
      const prefix = prefixEl?.value ?? "";
      const suffix = suffixEl?.value ?? "";
      // LoadImage sweep axes: enabled rows become enum imageParams. A
      // "local directory" row uploads its picked files to the host's input
      // dir first (ComfyUI's LoadImage only reads that dir), then sweeps
      // over the uploaded names.
      const imageParams = {};
      const uploadErrors = [];
      for (const [id, r] of Object.entries(imgRows())) {
        if (!r.enabled) continue;
        let values = [];
        if (r.mode === "new") {
          values = r.file ? [r.file] : [];
        } else {
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
      await Promise.all(props.images.map(async (img) => {
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
        ? `submitted ${submitted}/${totalJobs} across ${props.images.length} images`
        : `submitted ${submitted}/${totalJobs}`)
        + (failed.length ? ` (${failed.length} failed)` : "")
        + (engineErrors.length ? ` — ${engineErrors[0]}` : "");
      setResult({ text: summary, ok: !allFailed && submitted > 0 });
      setTimeout(props.onClose, 3000);
    } catch (e) {
      setResult({ text: `fetch failed: ${e.message}`, ok: false });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div class="vz-panel" onClick={(e) => e.stopPropagation()}>
        <div class="vz-title">
          {batch
            ? `Generate image variations · applying to ${props.images.length} images`
            : "Generate image variations"}
        </div>
        <div class="vz-body">
          <div class="vz-left">
            <div class="vz-sliders">
              {/* LoadImage sweep axes: pick a new image or the full input dir */}
              <For each={strParams()}>
                {(p) => {
                  const r = () => imgRows()[p.id];
                  return (
                    <Show when={r()}>
                      <div class={"vz-imgrow" + (r().enabled ? " on" : "")}>
                        <label class="vz-imgrow-head">
                          <input
                            type="checkbox" class="vz-cb"
                            checked={r().enabled}
                            onChange={(e) => onImgToggle(p.id, e.target.checked)}
                          />
                          <span class="vz-imgrow-label">{`${r().label}.image`}</span>
                          <span class="vz-imgrow-cur" title={r().current}>{r().current}</span>
                        </label>
                        <Show when={r().enabled}>
                          <div class="vz-imgrow-body">
                            <select
                              class="vz-imgmode" value={r().mode}
                              onChange={(e) => onImgField(p.id, "mode", e.target.value)}
                            >
                              <option value="new">new image…</option>
                              <option value="local">local directory…</option>
                              <option value="files">local files…</option>
                            </select>
                            <Show when={r().mode === "new"}>
                              <select
                                class="vz-imgfile" value={r().file ?? ""}
                                onChange={(e) => onImgField(p.id, "file", e.target.value)}
                              >
                                <For each={r().files}>{(f) => <option value={f}>{f}</option>}</For>
                              </select>
                            </Show>
                            {/* local directory: whole picked folder; local files: a
                                multi-picked subset. Both read into localFiles. */}
                            <Show when={r().mode === "local"}>
                              <span class="vz-imglocal">
                                <input
                                  type="file" class="vz-imgdirpick" style="display:none"
                                  webkitdirectory multiple
                                  onChange={(e) => {
                                    const fl = [...(e.target.files ?? [])].filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));
                                    onImgField(p.id, "localFiles", fl);
                                  }}
                                />
                                <button
                                  class="vz-imgdirbtn"
                                  onClick={(e) => e.currentTarget.parentElement.querySelector(".vz-imgdirpick").click()}
                                >{r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick a folder…"}</button>
                              </span>
                            </Show>
                            <Show when={r().mode === "files"}>
                              <span class="vz-imglocal">
                                <input
                                  type="file" class="vz-imgfilespick" style="display:none"
                                  multiple accept="image/*"
                                  onChange={(e) => {
                                    const fl = [...(e.target.files ?? [])].filter((f) => /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));
                                    onImgField(p.id, "localFiles", fl);
                                  }}
                                />
                                <button
                                  class="vz-imgdirbtn"
                                  onClick={(e) => e.currentTarget.parentElement.querySelector(".vz-imgfilespick").click()}
                                >{r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick files…"}</button>
                              </span>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  );
                }}
              </For>
              <Show
                when={params() !== null}
                fallback={<div class="vz-loading">inspecting graph…</div>}
              >
                <Show
                  when={params().length > 0}
                  fallback={<div class="vz-loading">this graph exposes no varyable parameters</div>}
                >
                  <For each={ordered()}>
                    {(key) => {
                      const row0 = rows()[key];
                      const p = paramDef(key, row0.current, row0.integer);
                      return (
                        <SliderRow
                          param={{ ...p, label: row0.label ? `${row0.label}.${row0.input}` : p.label }}
                          current={() => rows()[key]?.current ?? null}
                          defaults={batch ? { min: -p.spread, max: p.spread } : defaultRange(p, row0.current)}
                          enabled={() => !!rows()[key]?.enabled}
                          increment={() => rows()[key]?.increment}
                          placeholderKey={key}
                          relative={batch}
                          onToggle={onToggle}
                          onRange={onRange}
                          onIncrement={onIncrement}
                          templateTarget={templateTarget}
                        />
                      );
                    }}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
          <div class="vz-divider" />
          <div class="vz-right">
            <div class="vz-rlabel">variations</div>
            <div class={"vz-count" + (tally().n > 1000 ? " vz-count-hot" : tally().n > 100 ? " vz-count-warn" : "")}>{() => String(tally().n)}</div>
            <Show when={batch && tally().anyEnabled}>
              <div class="vz-count-sub">{`${tally().perImage} variants × ${props.images.length} images`}</div>
            </Show>
            <div class="vz-rlabel">prefix</div>
            <input
              type="text" class="vz-tinput vz-prefix" ref={prefixEl}
              title="click a slider label to insert its {placeholder}"
              onFocus={remember} onSelect={remember} onKeyUp={remember} onMouseUp={remember} onInput={remember}
            />
            <div class="vz-rlabel">suffix</div>
            <input
              type="text" class="vz-tinput vz-suffix" ref={suffixEl}
              title="click a slider label to insert its {placeholder} (enabled sliders auto-append)"
              onFocus={remember} onSelect={remember} onKeyUp={remember} onMouseUp={remember} onInput={remember}
            />
            {/* spacer pushes Run + error to the BOTTOM of the right column, so
                the primary action sits opposite the tallest content on the left */}
            <div class="vz-rspacer" />
            <button
              class="vz-run" disabled={running() || undefined} onClick={runVariations}
            >{running() ? "Running…" : "Run"}</button>
            <div class={"vz-error" + (result()?.ok ? " vz-ok" : "")}>{result()?.text ?? ""}</div>
          </div>
        </div>
        <button
          class="vz-close" title="close (Esc)" onClick={props.onClose}
          innerHTML={iconSvg("x", 16)}
        />
    </div>
  );
}
