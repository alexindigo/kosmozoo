// client-solid/features/variations/VariationsModal.tsx — the variations
// panel, declarative: the shared Modal portals it to the page level.
//
// Layout: title centered at top; left: parameter rows, LoadImage sweep rows
// first; enabled cards float to the top, the rest follow the info panel's
// own order (registry title, then input); vertical divider;
// right: variations count (big), prefix, suffix, Run.
//
// Slider rows are populated once the probe returns — the graph decides which
// parameters have a target node, and only those render. The label click
// inserts the per-graph placeholder key into whichever prefix/suffix input
// was last focused. Prefix/suffix WRAP the original filename basename in the
// submission (they don't replace it).

import { createSignal, createMemo, createEffect, createResource, onCleanup, For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { paramDef, defaultRange } from "./graph.mjs";
import { templateLabels } from "/shared/features/variations/shared.mjs";
import { sourceOrigin } from "/shared/source-origin.mjs";
import { useAppStore } from "../../store/app-store.js";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { SliderRow } from "./SliderRow.js";
import { Modal } from "../../components/Modal.js";
import { snapshotDraft, makeLeaveGuard, focusMemory } from "./draft.js";
import { makeVariationEditor } from "./editor.js";
import { VariationDiscardConfirmation } from "./VariationDiscardConfirmation.js";

export function VariationsModal() {
  const store = useAppStore();
  // A permitted replacement changes the scalar mount identity, even when the
  // store reconciles the descriptor. Targets are captured for this owner only.
  return (
    <Show
      when={store.state.variations.open ? store.state.variations.session : null}
      keyed
    >
      {(session) => {
        const images = [...store.state.variations.images].map(snapshotDraft);
        return <Modal class="vz-root" closeCommand="variations.close" closeArgs={{ session }}>
          <ModalBody session={session} images={images} />
        </Modal>;
      }}
    </Show>
  );
}

function ModalBody(props) {
  const store = useAppStore();
  const services = store.actions.variations.services;
  const image = props.images[0];
  // batch = more than one image: ranges become RELATIVE offsets from each
  // image's own current value (resolved by the plugin at run time), and the
  // count shows the total across the whole selection.
  const batch = props.images.length > 1;
  const [version, setVersion] = createSignal(0);
  const editor = makeVariationEditor({ targets: props.images, services,
    currentOrigin: host => sourceOrigin(host, store.state.hosts[host]),
    changed: () => setVersion(value => value + 1),
    close: () => store.handles.invoke("variations.close", { automatic: true, session: props.session }) });
  const read = getter => { version(); return getter(); };
  const rows = () => read(() => editor.rows("numeric"));
  const imgRows = () => read(() => editor.rows("images"));
  const enumRows = () => read(() => editor.rows("enums"));
  const textRows = () => read(() => editor.rows("texts"));
  const params = () => read(() => editor.ready() ? Object.values(rows()) : null);
  const strParams = () => Object.keys(imgRows());
  const enumList = () => Object.values(enumRows());
  const textList = () => Object.values(textRows());
  const running = () => read(editor.running);
  const result = () => read(editor.result);
  const prefix = () => read(() => editor.naming("prefix"));
  const suffix = () => read(() => editor.naming("suffix"));
  const [decision, setDecision] = createSignal(null);
  const children = new Set();
  const registerEditor = (capability) => { children.add(capability); return () => children.delete(capability); };
  let restoreFocus = () => {};
  const rememberFocus = (restore) => { restoreFocus = restore; };
  const focus = focusMemory(rememberFocus);
  const guard = makeLeaveGuard({ dirty: editor.dirty,
    suspend: () => { for (const child of children) child.suspend(); },
    restore: () => { for (const child of children) child.resume(); restoreFocus(); },
    decision: value => { setDecision(value); editor.decision(value); }, invalidate: editor.invalidateClose });
  onCleanup(store.actions.variations.registerOwner(props.session, { requestLeave: guard.request, requestRun: editor.run }));
  onCleanup(() => { editor.dispose(); guard.dispose(); });
  // refs exist solely to read the live selection and restore the caret
  // after a label-click insert
  let prefixEl, suffixEl;
  // the input a label click inserts into — ONE focus signal replaces the
  // four-listener tracking on each input ; the label's mousedown
  // preventDefault keeps the focus (and the selection) alive through the
  // click
  const [focused, setFocused] = createSignal(null); // "prefix" | "suffix"
  // a slider label click inserts its {placeholder} at the focused input's
  // selection. The live value+selection are read at click time — direct
  // programmatic sets bypass onInput, so the signal adopts the buffer here,
  // then the write goes through the signal (the only writer). Solid's
  // signal write is synchronous outside a batch, so the caret restores
  // right after it — no microtask hop.
  const onInsertPlaceholder = (key) => {
    const which = focused();
    if (!which) return;
    const el = which === "prefix" ? prefixEl : suffixEl;
    if (!el) return;
    const cur = el.value;
    const start = el.selectionStart ?? cur.length;
    const end = el.selectionEnd ?? cur.length;
    const placeholder = `{${key}}`;
    const next = cur.slice(0, start) + placeholder + cur.slice(end);
    const caret = start + placeholder.length;
    editor.edit("naming", "root", which, next);
    el.focus();
    el.setSelectionRange(caret, caret);
  };

  // probe + input list are RESOURCES : recency and cancellation come
  // from the primitive — no onMount promise chain, no swallowed errors.
  // The graph is the source of truth: only parameters whose target node
  // exists in this image's graph render (writeOnly params — widget-only
  // custom seed nodes etc. — are skipped for now).
  const [probe] = createResource(() => services.probe(image));

  let initializedProbe = false;
  createEffect(() => {
    if (probe.loading) return;
    if (initializedProbe) return;
    initializedProbe = true;
    if (probe.error) editor.catalogueFailure(probe.error);
    else editor.installCatalogue(probe());
  });

  const [inputFiles] = createResource(
    () => read(() => editor.ready() && strParams().length && image.host ? image.host : null),
    (hostName) => services.inputList(hostName, image.origin),
  );
  let initializedImages = false;
  createEffect(() => {
    const sp = strParams();
    if (!sp.length || inputFiles.loading) return;
    if (initializedImages) return;
    initializedImages = true;
    if (inputFiles.error) editor.catalogueFailure(inputFiles.error);
    else editor.installInputs(inputFiles());
  });

  const onToggle = (key, checked) => {
    editor.edit("numeric", key, "enabled", checked);
  };

  const onRange = (key, { min, max }) => {
    editor.range(key, { min, max });
  };

  const onIncrement = (key, rawIncrement) => {
    editor.edit("numeric", key, "rawIncrement", rawIncrement);
  };

  // LoadImage sweep: enabling auto-inserts the {LoadImage.image} token into
  // the suffix (the output name must encode WHICH input image produced it);
  // disabling removes it. Same grammar as the numeric placeholder tokens.
  const onImgToggle = (id, checked) => {
    editor.edit("images", id, "enabled", checked);
  };
  const onImgField = (id, field, value) => {
    editor.edit("images", id, field, value);
  };

  // enum sweep rows: the master checkbox arms the axis (its picks ride the
  // imageParams channel at run time); the option checkboxes pick the values.
  // The current value starts pre-checked — unchecking it is how the current
  // combo leaves the sweep.
  const onEnumToggle = (id, checked) => {
    editor.edit("enums", id, "enabled", checked);
  };
  const onEnumField = (id, field, value) => {
    editor.edit("enums", id, field, value);
  };
  const onEnumPick = (id, v, checked) => {
    const r = enumRows()[id];
    editor.edit("enums", id, "picks", checked ? [...r.picks, v] : r.picks.filter(value => value !== v));
  };

  // text sweep rows: the master checkbox arms the axis; the textarea holds
  // one literal template to expand (pre-filled with the current text)
  const onTextToggle = (id, checked) => {
    editor.edit("texts", id, "enabled", checked);
  };
  const onTextField = (id, field, value) => {
    editor.edit("texts", id, field, value);
  };
  const onTextTpl = (id, label, value) => {
    editor.template(id, label, value);
  };

  // Row order mirrors the info panel: registry title (fallback class_type),
  // then input name; per-instance rows of one type+input keep graph (probe)
  // order, and prompt (CLIPTextEncode) rows sink to the bottom — exactly the
  // info panel's group order. Enabled rows float to the top. Items are plain
  // strings ("num:"/"enum:"/"txt:" + id) so <For> keeps rows mounted.
  const enumById = createMemo(() => new Map(enumList().map((p) => [p.id, p])));
  const textById = createMemo(() => new Map(textList().map((p) => [p.id, p])));
  const orderedItems = createMemo(() => {
    const reg = store.state.nodesRegistry ?? {};
    const titleOf = (type) => reg[type]?.title || type;
    const sinkOf = (type) => +/clip\s*text\s*encode/i.test(type);
    const items = [];
    for (const [key, r] of Object.entries(rows())) {
      items.push({ id: "num:" + key, enabled: !!r.enabled, sort: [sinkOf(r.type), titleOf(r.type), r.input, 0] });
    }
    const erank = new Map(enumList().map((p, i) => [p.id, i]));
    for (const p of enumList()) {
      const r = enumRows()[p.id];
      if (!r) continue;
      items.push({ id: "enum:" + p.id, enabled: !!r.enabled, sort: [sinkOf(p.type), titleOf(p.type), p.key, erank.get(p.id) ?? 0] });
    }
    const trank = new Map(textList().map((p, i) => [p.id, i]));
    for (const p of textList()) {
      const r = textRows()[p.id];
      if (!r) continue;
      items.push({ id: "txt:" + p.id, enabled: !!r.enabled, sort: [sinkOf(p.type), titleOf(p.type), p.key, trank.get(p.id) ?? 0] });
    }
    return items
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const [sa, ta, ia, ra] = a.sort, [sb, tb, ib, rb] = b.sort;
        return sa - sb || ta.localeCompare(tb) || ia.localeCompare(ib) || ra - rb;
      })
      .map((it) => it.id);
  });

  const tally = createMemo(() => read(editor.preview));

  return (
    <div class="vz-panel" data-session={props.session}>
      <div class="vz-editor" inert={!!decision()}>
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
                {(id) => {
                  const r = () => imgRows()[id];
                  return (
                    <Show when={r()?.filesReady}>
                      <div class={"vz-imgrow" + (r().enabled ? " on" : "")}>
                        <label class="vz-imgrow-head">
                          <input
                            type="checkbox" class="vz-cb"
                            checked={r().enabled}
                            onChange={(e) => onImgToggle(id, e.target.checked)}
                          />
                          <span class="vz-imgrow-label">{`${r().label}.image`}</span>
                          <span class="vz-imgrow-cur" title={r().current}>{r().current}</span>
                        </label>
                        <Show when={r().enabled}>
                          <div class="vz-imgrow-body">
                            <select
                              {...focusMemory(rememberFocus)}
                              class="vz-imgmode" value={r().mode}
                              onChange={(e) => onImgField(id, "mode", e.target.value)}
                            >
                              <option value="new">new image…</option>
                              <option value="local">local directory…</option>
                              <option value="files">local files…</option>
                            </select>
                            <Show when={r().mode === "new"}>
                              <select
                                {...focusMemory(rememberFocus)}
                                class="vz-imgfile" value={r().file ?? ""}
                                onChange={(e) => onImgField(id, "file", e.target.value)}
                              >
                                <For each={r().files}>{(f) => <option value={f}>{f}</option>}</For>
                              </select>
                            </Show>
                            {/* local directory: whole picked folder; local files: a
 multi-picked subset. Both read into localFiles. */}
                            <Show when={r().mode === "local"}>
                              <FilePick
                                rememberFocus={rememberFocus}
                                inputAttrs={{ class: "vz-imgdirpick", webkitdirectory: true, multiple: true }}
                                label={() => (r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick a folder…")}
                                onPick={(fl) => onImgField(id, "localFiles", fl)}
                              />
                            </Show>
                            <Show when={r().mode === "files"}>
                              <FilePick
                                rememberFocus={rememberFocus}
                                inputAttrs={{ class: "vz-imgfilespick", multiple: true, accept: "image/*" }}
                                label={() => (r().localFiles?.length ? `${r().localFiles.length} files picked` : "pick files…")}
                                onPick={(fl) => onImgField(id, "localFiles", fl)}
                              />
                            </Show>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  );
                }}
              </For>
              {/* one merged parameter list: enabled cards float to the top,
 the rest follow the info panel's order (enum + numeric rows interleave) */}
              <Show
                when={params() !== null}
                fallback={<div class="vz-loading">inspecting graph…</div>}
              >
                <Show
                  when={orderedItems().length > 0}
                  fallback={<div class="vz-loading">this graph exposes no varyable parameters</div>}
                >
                  <For each={orderedItems()}>
                    {(itemId) => {
                      if (itemId.startsWith("enum:")) {
                        const id = itemId.slice(5);
                        const p = enumById().get(id);
                        return (
                          <Show when={p && enumRows()[id]}>
                            <EnumRow
                              p={p}
                              row={() => enumRows()[id]}
                              onToggle={onEnumToggle}
                              onPick={onEnumPick}
                              onField={onEnumField}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      if (itemId.startsWith("txt:")) {
                        const id = itemId.slice(4);
                        const p = textById().get(id);
                        return (
                          <Show when={p && textRows()[id]}>
                            <TextRow
                              p={p}
                              row={() => textRows()[id]}
                              onToggle={onTextToggle}
                              onField={onTextField}
                              onTpl={onTextTpl}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      const key = itemId.slice(4);
                      const row0 = rows()[key];
                      const p = paramDef(key, row0.current, row0.integer);
                      return (
                        <SliderRow
                          param={{ ...p, label: row0.label ? `${row0.label}.${row0.input}` : p.label }}
                          current={() => rows()[key]?.current ?? null}
                          defaults={batch ? { min: -p.spread, max: p.spread } : defaultRange(p, row0.current)}
                          enabled={() => !!rows()[key]?.enabled}
                          increment={() => rows()[key]?.increment}
                          rawIncrement={() => rows()[key]?.rawIncrement ?? ""}
                          placeholderKey={key}
                          relative={batch}
                          onToggle={onToggle}
                          onRange={onRange}
                          onIncrement={onIncrement}
                          onInsertPlaceholder={onInsertPlaceholder}
                          registerEditor={registerEditor} rememberFocus={rememberFocus}
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
              value={prefix()}
              title="click a slider label to insert its {placeholder}"
              {...focus} onFocus={(e) => { setFocused("prefix"); focus.onFocus(e); }}
              onInput={(e) => editor.edit("naming", "root", "prefix", e.currentTarget.value)}
            />
            <div class="vz-rlabel">suffix</div>
            <input
              type="text" class="vz-tinput vz-suffix" ref={suffixEl}
              value={suffix()}
              title="click a slider label to insert its {placeholder} (enabled sliders auto-append)"
              {...focus} onFocus={(e) => { setFocused("suffix"); focus.onFocus(e); }}
              onInput={(e) => editor.edit("naming", "root", "suffix", e.currentTarget.value)}
            />
            {/* spacer pushes the result + Run to the BOTTOM of the right
 column — the result message sits above the button, centered on it,
 and the button is the column's last element */}
            <div class="vz-rspacer" />
            <div class={"vz-error" + (result()?.ok ? " vz-ok" : "")}>{result()?.text ?? ""}</div>
            <button
              class="vz-run" disabled={running() || undefined} onClick={() => store.handles.invoke("variations.run")}
            >{running() ? "Running…" : "Run"}</button>
          </div>
        </div>
        <button
          class="vz-close" title="close (Esc)" onClick={() => store.handles.invoke("variations.close", { session: props.session })}
          innerHTML={iconSvg("x", 16)}
        />
      </div>
      <Show when={decision()}>
        <VariationDiscardConfirmation owner={props.session} running={running()} onCancel={guard.cancel} onDiscard={guard.discard} />
      </Show>
    </div>
  );
}

// one enum sweep row: master checkbox + label + the orange current value;
// enabled → the host's options as a filterable checkbox list (the current
// value pre-checked and orange-marked). Props convention mirrors SliderRow:
// p is stable per row, row is a GETTER, interactions report through the
// callbacks — the row never reaches into its parent.
function EnumRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const r = () => props.row();
  const filtered = () => {
    const f = r().filter.trim().toLowerCase();
    return f ? r().values.filter((v) => v.toLowerCase().includes(f)) : r().values;
  };
  return (
    <div class={"vz-imgrow vz-enumrow" + (r().enabled ? " on" : "")} data-enum-id={props.p.id}>
      <label class="vz-imgrow-head">
        <input
          type="checkbox" class="vz-cb"
          checked={r().enabled}
          onChange={(e) => props.onToggle(props.p.id, e.target.checked)}
        />
        <span class="vz-imgrow-label">{r().label}</span>
        <span class="vz-imgrow-cur vz-enum-cur" title={r().current}>{r().current}</span>
      </label>
      <Show when={r().enabled}>
        <div class="vz-imgrow-body vz-enum-body">
          <Show when={r().values.length > 10}>
            <input
              {...focus}
              type="text" class="vz-enum-filter" placeholder="filter…"
              value={r().filter}
              onInput={(e) => props.onField(props.p.id, "filter", e.currentTarget.value)}
            />
          </Show>
          <div class="vz-enum-list">
            <For each={filtered()}>
              {(v) => (
                <label class={"vz-enum-opt" + (v === r().current ? " vz-enum-current" : "")}>
                  <input
                    {...focus}
                    type="checkbox" class="vz-cb"
                    checked={r().picks.includes(v)}
                    onChange={(e) => props.onPick(props.p.id, v, e.target.checked)}
                  />
                  <span class="vz-enum-opt-name" title={v}>{v}</span>
                </label>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

// one text sweep row: master checkbox + label + the orange current value;
// enabled → a textarea holding one literal template (the
// current text pre-filled). Each {{label}} in the text spawns a substitution
// input below the textarea (semicolon-separated values, cartesian-expanded
// at tally/run time). Same props convention as EnumRow/SliderRow.
function TextRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const r = () => props.row();
  return (
    <div class={"vz-imgrow vz-textrow" + (r().enabled ? " on" : "")} data-text-id={props.p.id}>
      <label class="vz-imgrow-head">
        <input
          type="checkbox" class="vz-cb"
          checked={r().enabled}
          onChange={(e) => props.onToggle(props.p.id, e.target.checked)}
        />
        <span class="vz-imgrow-label">{r().label}</span>
        <span class="vz-imgrow-cur vz-enum-cur" title={r().current}>{r().current}</span>
      </label>
      <Show when={r().enabled}>
        <div class="vz-imgrow-body vz-enum-body">
          <textarea
            {...focus}
            class="vz-text-values" rows="4"
            placeholder="text template — {{label}} adds a substitution axis"
            value={r().text}
            onInput={(e) => props.onField(props.p.id, "text", e.currentTarget.value)}
          />
          <For each={templateLabels(r().text)}>
            {(lab) => (
              <div class="vz-tpl-row">
                <span class="vz-tpl-label" title={lab}>{lab}</span>
                <input
                  {...focus}
                  type="text" class="vz-tpl-input"
                  value={r().tpl?.[lab] ?? ""}
                  placeholder="values; separated; by; semicolons"
                  onInput={(e) => props.onTpl(props.p.id, lab, e.currentTarget.value)}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// one hidden file input + its trigger button : the directory and files
// pickers were copy-paste twins differing only in input attributes)
function FilePick(props) {
  let el;
  return (
    <span class="vz-imglocal">
      <input
        type="file" style="display:none" ref={el}
        {...props.inputAttrs}
        onChange={(e) => {
          props.onPick([...(e.target.files ?? [])].filter((f) => UPLOAD_IMG_EXT.test(f.name)));
        }}
      />
      <button class="vz-imgdirbtn" {...focusMemory(props.rememberFocus)} onClick={() => el?.click()}>{props.label()}</button>
    </span>
  );
}
