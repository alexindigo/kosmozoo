// client-solid/features/variations/VariationsModal.tsx — the variations
// panel, declarative: the shared Modal portals it to the page level.
//
// Three tracks: unadded catalogue, explicitly enabled editor cards, summary/Run.
// All rows start off; removing a card retains its private recipe buffers.
//
// Slider rows are populated once the probe returns — the graph decides which
// parameters have a target node, and only those render. Each parameter name
// inserts the per-graph placeholder key into whichever prefix/suffix input
// was last focused. Prefix/suffix WRAP the original filename basename in the
// submission (they don't replace it).

import { createSignal, createMemo, createEffect, createResource, onMount, onCleanup, For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { templateLabels, templateValue } from "/shared/features/variations/shared.mjs";
import { sourceOrigin, sameOrigin } from "/shared/source-origin.mjs";
import { useAppStore } from "../../store/app-store.js";
import { SliderRow } from "./SliderRow.js";
import { Modal } from "../../components/Modal.js";
import { snapshotDraft, makeLeaveGuard, focusMemory } from "./draft.js";
import { makeVariationEditor } from "./editor.js";
import { VariationDiscardConfirmation } from "./VariationDiscardConfirmation.js";
import { ImageSetPanel } from "./ImageSetPanel.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { Checkbox } from "../../components/Checkbox.js";
import { IconButton } from "../../components/IconButton.js";
import { TextField } from "../../components/TextField.js";
import { ParameterRow } from "./ParameterRow.js";
import { isFileDrag } from "./image-drop.js";
import { matchesFieldFilter, cataloguePresentation } from "./field-filter.js";
import { ParameterCatalogue } from "./ParameterCatalogue.js";
import { CandidateEditor } from "./CandidateEditor.js";
import { makeKeyboardReveal } from "./keyboard-reveal.js";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { HistoryDropdown } from "./HistoryDropdown.js";
import { historyCount, historyDate } from "./HistoryEntry.js";

export function VariationsModal() {
  const store = useAppStore();
  createEffect(() => {
    if (!store.state.variations.open) return;
    // One dialog-lifetime guard covers the entire page, including inert areas.
    const preventFileNavigation = event => { if (isFileDrag(event.dataTransfer)) event.preventDefault(); };
    window.addEventListener("dragover", preventFileNavigation, true);
    window.addEventListener("drop", preventFileNavigation, true);
    onCleanup(() => {
      window.removeEventListener("dragover", preventFileNavigation, true);
      window.removeEventListener("drop", preventFileNavigation, true);
    });
  });
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
          <ModalBody session={session} images={images} historyRef={snapshotDraft(store.state.variations.historyRef)} />
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
  onMount(() => { editor.loadGenerationTimes(); });
  const original = props.historyRef ? services.history.retained(props.historyRef.id, props.historyRef.leaseId) : null;
  if (original) editor.restoreHistory(original);
  const [historyCaption, setHistoryCaption] = createSignal(original ? `${historyCount(original)} | ${historyDate(original.createdAt)} | ${image.filename}` : "");
  const [recallWarnings, setRecallWarnings] = createSignal([]);
  const [recallStatus, setRecallStatus] = createSignal(null);
  const [recallNotice, setRecallNotice] = createSignal("");
  let alive = true, recalling = null;
  onCleanup(() => { alive = false; });
  const read = getter => { version(); return getter(); };
  const rows = () => read(() => editor.rows("numeric"));
  const imgRows = () => read(() => editor.rows("images"));
  const enumRows = () => read(() => editor.rows("enums"));
  const textRows = () => read(() => editor.rows("texts"));
  const candidateRows = () => read(() => editor.rows("candidates"));
  const catalogue = createMemo(() => read(editor.catalogue));
   const catalogueSections = createMemo(() => cataloguePresentation(catalogue()));
  const catalogueById = createMemo(() => new Map(catalogue().map(row => [row.id, row])));
  const catalogueFocus = new Map(), panelFocus = new Map();
  let pendingPanelFocus = null;
  const registerFocus = (ports, id, focus) => {
    ports.set(id, focus);
    if (ports === panelFocus && pendingPanelFocus === id) queueMicrotask(() => { if (pendingPanelFocus === id) { pendingPanelFocus = null; focus(); } });
    return () => { if (ports.get(id) === focus) ports.delete(id); };
  };
  const panelFocusPort = id => focus => registerFocus(panelFocus, id, focus);
  const setEnabled = (id, enabled) => {
    pendingPanelFocus = enabled ? id : null;
    editor.setEnabled(id, enabled);
    queueMicrotask(() => {
      if (enabled) panelFocus.get(id)?.();
      else if (fieldMatches(catalogueById().get(id))) catalogueFocus.get(id)?.();
      else filterInput?.focus();
    });
  };
  const params = () => read(() => editor.ready() ? Object.values(rows()) : null);
  const strParams = () => Object.keys(imgRows());
  const enumList = () => Object.values(enumRows());
  const textList = () => Object.values(textRows());
  const running = () => read(editor.running);
  const result = () => read(editor.result);
  const prefix = () => read(() => editor.naming("prefix"));
  const suffix = () => read(() => editor.naming("suffix"));
  const [decision, setDecision] = createSignal(null);
  let bodyScroll, editorSurface;
  const keyboardReveal = makeKeyboardReveal({ schedule: requestAnimationFrame, cancel: cancelAnimationFrame,
    read: target => {
      if (decision() || !target?.isConnected || !bodyScroll.contains(target) || !target.matches(":focus") || !target.getClientRects().length) return null;
      const targetBox = target.getBoundingClientRect(), surface = bodyScroll.getBoundingClientRect();
      if (!targetBox.width || !targetBox.height || getComputedStyle(target).visibility !== "visible") return null;
      return { target: targetBox, viewport: { left: surface.left + bodyScroll.clientLeft, right: surface.left + bodyScroll.clientLeft + bodyScroll.clientWidth },
        left: bodyScroll.scrollLeft, maximum: bodyScroll.scrollWidth - bodyScroll.clientWidth };
    }, write: left => { bodyScroll.scrollLeft = left; } });
  createEffect(() => { if (decision()) keyboardReveal.retire(); });
  onMount(() => {
    const key = event => {
      if (event.isTrusted && event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey && !decision() && editorSurface.contains(event.target)) keyboardReveal.tab(event.target);
      else keyboardReveal.retire();
    };
    const focus = event => { if (bodyScroll.contains(event.target)) keyboardReveal.focus(event.target); else keyboardReveal.retire(); };
    const retire = () => keyboardReveal.retire();
    document.addEventListener("keydown", key, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("pointerdown", retire, true);
    document.addEventListener("pointermove", retire, true);
    window.addEventListener("blur", retire);
    onCleanup(() => {
      keyboardReveal.dispose();
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("pointerdown", retire, true);
      document.removeEventListener("pointermove", retire, true);
      window.removeEventListener("blur", retire);
    });
  });
  const [fieldFilter, setFieldFilter] = createSignal("");
  let filterInput;
  const fieldMatches = row => matchesFieldFilter(row, fieldFilter());
  const hasMatchingFields = createMemo(() => catalogue().some(row => !row.enabled && fieldMatches(row)));
  const children = new Set();
  const registerEditor = (capability) => { children.add(capability); return () => children.delete(capability); };
  let restoreFocus = () => {};
  const rememberFocus = (restore) => { restoreFocus = restore; };
  const focus = focusMemory(rememberFocus);
  const guard = makeLeaveGuard({ dirty: intent => intent?.type === "apply-history" ? intent.overlap : editor.dirty(),
    suspend: () => { for (const child of children) child.suspend(); },
    restore: () => { for (const child of children) child.resume(); restoreFocus(); },
    decision: value => { setDecision(value); editor.decision(value); }, invalidate: editor.invalidateClose });
  onCleanup(store.actions.variations.registerOwner(props.session, { requestLeave: guard.request, requestRun: editor.run }));
  onCleanup(() => { editor.dispose(); guard.dispose(); });
  const settleRecall = promise => {
    if (recalling?.promise !== promise) return;
    recalling = null;
    if (alive) setRecallNotice("");
  };
  const recall = id => {
    if (!alive) return Promise.resolve({ status: "stale" });
    if (recalling) {
      if (recalling.id === id) return recalling.promise;
      setRecallNotice("Another recall is in progress. This selection was not applied.");
      return Promise.resolve({ status: "busy" });
    }
    setRecallNotice("");
    const revision = editor.revision();
    const promise = (async () => {
      const saved = await services.history.open(id);
      let transferred = false;
      try {
        if (!alive || guard.pending() || editor.revision() !== revision) return { status: "stale" };
        const plan = await editor.planRecall(saved);
        // Even a clean guard invalidates accepted close eligibility. An empty
        // overlay is a terminal selection, not an editor transition.
        const result = !plan.patch.length ? editor.applyRecall(plan) : await guard.request({ intent: { type: "apply-history", id, leaseId: saved.leaseId, revision, overlap: plan.overlap },
          cancel() {}, permit: () => editor.applyRecall(plan) });
        if (result.status === "applied") {
          transferred = true; setHistoryCaption(`${historyCount(saved)} | ${historyDate(saved.createdAt)}`);
        }
        if (result.status === "applied" || result.status === "unchanged") {
          setRecallWarnings(plan.warnings); setRecallStatus(result.status);
        }
        return result;
      } finally {
        // The transition has settled. Lease cleanup remains owned by the
        // history client and must not coalesce the next user action into this one.
        settleRecall(promise);
        if (!transferred) await services.history.release(saved);
      }
    })();
    recalling = { id, promise };
    promise.finally(() => settleRecall(promise)).catch(() => {});
    return promise;
  };
  // refs exist solely to read the live selection and restore the caret
  // after an explicit parameter insert.
  let prefixEl, suffixEl;
  // Remember the naming target while a parameter name is focused; each input
  // retains its own live caret selection.
  const [focused, setFocused] = createSignal(null); // "prefix" | "suffix"
  // The parameter action inserts its {placeholder} at the naming input's
  // selection. The live value+selection are read at click time — direct
  // programmatic sets bypass onInput, so the signal adopts the buffer here,
  // then the write goes through the signal (the only writer). Solid's
  // signal write is synchronous outside a batch, so the caret restores
  // right after it — no microtask hop.
  const onInsertPlaceholder = (key) => {
    const which = focused() ?? "suffix";
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

  // The complete recorded graph is the catalogue, independent of live schema.
  // Per-source input readiness settles separately from editable recipe work.
  const [probe] = createResource(() => original ? Promise.resolve(null) : services.probe(image));
  const [folderCapability] = createResource(() => services.folderCapability());

  let initializedProbe = false;
  createEffect(() => {
    if (original) return;
    if (probe.loading) return;
    if (initializedProbe) return;
    initializedProbe = true;
    if (probe.error) editor.catalogueFailure(probe.error);
    else editor.installCatalogue(probe());
  });

  const inputSources = createMemo(() => [image.origin, ...services.inputSources().filter(origin => origin.source !== image.host)].filter(Boolean));
  const targetThumbnail = () => original ? services.historyThumbnail({ runId: original.id, resourceId: "target-0", leaseId: original.leaseId }) : services.inputThumbnail(image.host, image.filename, image.origin, "output");
  const currentThumbnail = row => original ? services.historyThumbnail({ runId: original.id, resourceId: original.targets[0].graphResources[row.id], leaseId: original.leaseId }) : services.inputThumbnail(image.host, row.current, image.origin, row.currentRoot);
  const unavailable = () => original?.targets.find(target => target.unavailable)?.unavailable ?? (original && !props.images.every(target => sameOrigin(target.origin, sourceOrigin(target.host, store.state.hosts[target.host]))) ? "Original source unavailable or changed. Reopen this saved run after reconnecting." : null);
  let initializedImages = false;
  createEffect(() => {
    if (!read(editor.ready) || !strParams().length) return;
    if (initializedImages) return;
    initializedImages = true;
    editor.loadSourceInputs(image.origin);
  });

  const onToggle = (key, checked) => {
    setEnabled(key, checked);
  };

  const onRange = (key, { min, max }) => {
    editor.range(key, { min, max });
  };

  const onIncrement = (key, rawIncrement) => {
    editor.edit("numeric", key, "rawIncrement", rawIncrement);
  };

  // Enablement changes membership only; automatic names are a compile projection.
  const onImgToggle = (id, checked) => {
    setEnabled(id, checked);
  };
  const registerImagePopup = close => {
    const disown = store.handles.own("variations.images.close", close);
    const unlayer = store.actions.keys.pushLayer({ id: "variations-images", command: "variations.images.close", phase: "capture" });
    return () => { unlayer(); disown(); };
  };
  const registerTabKeys = (capability, group = "source") => {
    const command = group === "feed" ? "variations.feed-tabs.move" : "variations.tabs.move";
    const disown = store.handles.own(command, capability.move);
    const unlayer = store.actions.keys.pushLayer({ id: `variations-${group}-tabs`, command, phase: "capture",
      keys: { ArrowLeft: { step: -1 }, ArrowRight: { step: 1 }, Home: { step: "first" }, End: { step: "last" } },
      decline: event => !capability.contains(event.target) });
    return () => { unlayer(); disown(); };
  };

  // Catalogue Add and the shared remove action own axis membership; option
  // checkboxes pick values through the existing imageParams channel.
  // The current value starts pre-checked — unchecking it is how the current
  // combo leaves the sweep.
  const onEnumToggle = (id, checked) => {
    setEnabled(id, checked);
  };
  const onEnumPick = (id, v, checked) => {
    const r = enumRows()[id];
    editor.edit("enums", id, "picks", checked ? [...r.picks, v] : r.picks.filter(value => value !== v));
  };

  // Text sweep rows: explicit membership; the textarea holds
  // one literal template to expand (pre-filled with the current text)
  const onTextToggle = (id, checked) => {
    setEnabled(id, checked);
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
  // info panel's group order. Stable scalar keys retain active editor identity.
  const enumById = createMemo(() => new Map(enumList().map((p) => [p.id, p])));
  const textById = createMemo(() => new Map(textList().map((p) => [p.id, p])));
  const orderedItems = createMemo(() => catalogue().filter(row => row.domain !== "images").map(row =>
    ({ numeric: "num:", enums: "enum:", texts: "txt:", candidates: "candidate:" })[row.domain] + row.id));

  const tally = createMemo(() => read(editor.preview));
  const valueSummary = id => {
    const count = tally().axes.find(axis => axis.id === id)?.count ?? "—";
    return `${count} ${count === 1 ? "value" : "values"}`;
  };

  return (
    <div class="vz-panel" data-session={props.session}>
      <div ref={editorSurface} class="vz-editor" inert={!!decision()}>
        <SingleLineText class="vz-title" value={batch
            ? `Generate image variations · applying to ${props.images.length} images`
            : "Generate image variations"} />
        <HistoryDropdown history={services.history} state={services.historyState} thumbnail={services.historyThumbnail} registerThumbnail={services.registerThumbnail}
          registerPopup={registerImagePopup} registerEditor={registerEditor} rememberFocus={rememberFocus} bulk={batch}
          caption={historyCaption()} warnings={recallWarnings()} recallStatus={recallStatus()} notice={recallNotice()} onRecall={recall} />
        <div ref={bodyScroll} class="vz-body-scroll"><div class="vz-body">
          <div class="vz-catalogue">
            <div class="vz-filter-tools">
              <TextField controlClass="vz-field-filter" ref={filterInput} type="text" placeholder="Filter fields" aria-label="Filter fields"
                {...focus} value={fieldFilter()} onInput={event => setFieldFilter(event.currentTarget.value)}
                trailing={<Show when={fieldFilter()}><IconButton chrome size="md" variant="plain vz-filter-clear" title="Clear field filter" icon={iconSvg("x")}
                  onAction={() => { setFieldFilter(""); filterInput.focus(); }} /></Show>} />
            </div>
            <ParameterCatalogue sections={catalogueSections()} row={id => catalogueById().get(id)} matches={fieldMatches}
              registerPopup={registerImagePopup} registerEditor={registerEditor}
              previewActive={!decision() && sameOrigin(image.origin, sourceOrigin(image.host, store.state.hosts[image.host]))}
              thumbnail={currentThumbnail} registerThumbnail={services.registerThumbnail}
              ready={params() !== null} anyMatch={hasMatchingFields()} onAdd={id => setEnabled(id, true)}
              onFiles={(id, resources) => editor.dropImages(id, resources, name => UPLOAD_IMG_EXT.test(name))}
              registerFocus={(id, focus) => registerFocus(catalogueFocus, id, focus)} />
          </div>
          <div class="vz-left">
            <div class="vz-sliders">
              <Show when={params() !== null && !catalogue().some(row => row.enabled)}><SingleLineText class="vz-loading vz-editing-empty" value="Add a parameter from the left to edit it." /></Show>
              {/* One chosen set, independent of how each image was acquired. */}
              <For each={strParams()}>
                {(id) => {
                  const r = () => imgRows()[id];
                  return (
                    <Show when={r()?.enabled}>
                      <ImageSetPanel id={id} row={r} onEnable={checked => onImgToggle(id, checked)} registerFocus={panelFocusPort(id)}
                        onInsert={onInsertPlaceholder}
                        onAdd={(items, index) => editor.addImages(id, items, index)} onRemove={item => editor.removeImage(id, item)}
                        onMove={(item, index) => editor.moveImage(id, item, index)}
                        onToggleTarget={() => editor.toggleTargetImage(id)}
                        targetThumbnail={targetThumbnail} archiveThumbnail={services.historyThumbnail}
                        thumbnail={(name, root = "input") => services.inputThumbnail(image.host, name, image.origin, root)}
                        sources={inputSources()} sourceInputs={(origin, root) => read(() => editor.sourceInputs(origin, root))}
                        onSource={(origin, root) => editor.loadSourceInputs(origin, false, root)} onRetrySource={(origin, root) => editor.loadSourceInputs(origin, true, root)}
                        inputState={(origin, name, root) => read(() => editor.sourceInputState(id, origin, name, root))}
                        onToggleInput={(origin, name, root) => editor.toggleSourceInput(id, origin, name, root)}
                        inputThumbnail={(origin, name, root) => services.inputThumbnail(origin.source, name, origin, root)} registerTabKeys={registerTabKeys}
                        registerThumbnail={services.registerThumbnail}
                        pathThumbnail={services.pathThumbnail} onAddFolder={path => editor.addFolder(id, path)}
                        folderCapability={() => folderCapability.error ? null : folderCapability()} onChooseFolder={services.chooseFolder}
                        registerPopup={registerImagePopup} registerEditor={registerEditor} rememberFocus={rememberFocus} />
                    </Show>
                  );
                }}
              </For>
              {/* One ordered list; only explicitly enabled cards render here. */}
              <Show
                when={params() !== null}
                fallback={<SingleLineText class="vz-loading" value="Reading workflow…" />}
              >
                <Show
                  when={orderedItems().length > 0}
                  fallback={<Show when={!fieldFilter().trim()}><SingleLineText class="vz-loading" value="this graph exposes no varyable parameters" /></Show>}
                >
                  <For each={orderedItems()}>
                    {(itemId) => {
                      if (itemId.startsWith("candidate:")) {
                        const id = itemId.slice(10), row = () => candidateRows()[id];
                        return <Show when={row()?.enabled}><CandidateEditor row={row} summary={valueSummary(id)}
                          onEnable={enabled => setEnabled(id, enabled)} registerFocus={panelFocusPort(id)} rememberFocus={rememberFocus}
                          onInsert={onInsertPlaceholder} nodes={read(() => editor.connectionNodes(id))}
                          onCandidate={(index, raw) => editor.candidate(id, index, raw)} onAdd={() => editor.addCandidate(id)}
                          onRemove={index => editor.removeCandidate(id, index)} onMove={(from, to) => editor.moveCandidate(id, from, to)}
                          onPick={(raw, on) => editor.pickCandidate(id, raw, on)} onConnection={(index, node, slot) => editor.connection(id, index, node, slot)} /></Show>;
                      }
                      if (itemId.startsWith("enum:")) {
                        const id = itemId.slice(5);
                        const p = enumById().get(id);
                        return (
                           <Show when={p && enumRows()[id]?.enabled}>
                            <EnumRow
                              p={p}
                              row={() => enumRows()[id]}
                               registerFocus={panelFocusPort(id)}
                              onToggle={onEnumToggle}
                              onPick={onEnumPick}
                              onInsert={onInsertPlaceholder}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      if (itemId.startsWith("txt:")) {
                        const id = itemId.slice(4);
                        const p = textById().get(id);
                        return (
                           <Show when={p && textRows()[id]?.enabled}>
                            <TextRow
                              p={p}
                              row={() => textRows()[id]}
                               registerFocus={panelFocusPort(id)}
                              onToggle={onTextToggle}
                              onField={onTextField}
                              onTpl={onTextTpl}
                              onInsert={onInsertPlaceholder} summary={valueSummary(id)}
                              rememberFocus={rememberFocus}
                            />
                          </Show>
                        );
                      }
                      const key = itemId.slice(4);
                      const row0 = rows()[key];
                      const p = row0.tuning;
                      return (
                        <Show when={rows()[key]?.enabled}><SliderRow
                          row={() => rows()[key]}
                           registerFocus={panelFocusPort(key)}
                          param={{ ...p, key, label: row0.label }}
                          current={() => rows()[key]?.current ?? null}
                          enabled={() => !!rows()[key]?.enabled}
                          increment={() => rows()[key]?.increment}
                          rawIncrement={() => rows()[key]?.rawIncrement ?? ""}
                          placeholderKey={key}
                          relative={batch}
                          onToggle={onToggle}
                          onRange={onRange}
                          onIncrement={onIncrement}
                          onField={(key, name, value) => editor.edit("numeric", key, name, value)}
                          onInsert={onInsertPlaceholder} summary={valueSummary(key)}
                          registerEditor={registerEditor} rememberFocus={rememberFocus}
                         /></Show>
                      );
                    }}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
          <div class="vz-right">
            <div class="vz-sidebar-body">
            <div class="vz-count-group">
              <SingleLineText class="vz-rlabel" value={tally().exact ? "Variations" : tally().status === "invalid" ? "Check the recipe" : "Estimated variations"} />
              <span class="vz-rlabel vz-time-label">Estimated time:</span>
              <SingleLineText class={"vz-count" + (tally().n >= 1e15 ? " vz-count-large" : "") + (tally().n > 1000 ? " vz-count-hot" : tally().n > 100 ? " vz-count-warn" : "")}
                value={tally().status === "invalid" ? "—" : tally().display} hint={tally().fullCount} />
              <SingleLineText class="vz-time-value" value={tally().timeEstimate.display}
                hint="Based on original image generation times and the displayed job-count estimate. Edited settings can change speed; existing queues are not included. Independent backends may run concurrently." />
              <p class="vz-count-sub">{tally().breakdown}</p>
            </div>
            <div class="vz-naming-group">
              <span class="vz-rlabel">Output names</span>
              <label for={`prefix-${props.session}`}>Prefix</label>
              <TextField
                id={`prefix-${props.session}`} type="text" class="vz-tinput vz-prefix" ref={prefixEl}
                value={prefix()}
                title="Click a parameter name to insert its token at the caret"
                {...focus} onFocus={(e) => { setFocused("prefix"); focus.onFocus(e); }}
                onInput={(e) => editor.edit("naming", "root", "prefix", e.currentTarget.value)}
              />
              <label for={`suffix-${props.session}`}>Suffix</label>
              <TextField
                id={`suffix-${props.session}`} type="text" class="vz-tinput vz-suffix" ref={suffixEl}
                value={suffix()}
                title="Click a parameter name to insert its token at the caret"
                {...focus} onFocus={(e) => { setFocused("suffix"); focus.onFocus(e); }}
                onInput={(e) => editor.edit("naming", "root", "suffix", e.currentTarget.value)}
              />
              <Show when={tally().naming.example}>
                <div class="vz-output-preview">
                  <span>Example</span>
                  <SingleLineText class="vz-output-example" value={tally().naming.example} hint={tally().naming.help} />
                </div>
              </Show>
            </div>
            </div>
            <div class="vz-messages" role="status">
              <div class="vz-message-content">
                <Show when={tally().message && !result()}><p class={tally().status === "invalid" ? "vz-readiness-error" : "vz-field-help"}>{tally().message}</p></Show>
                <Show when={result()}>{value => <>
                  <Show when={Number.isSafeInteger(value().submitted) && value().total > 0}>
                    <p class={value().ok ? "vz-queued vz-ok" : "vz-queued"}>Queued {value().submitted} of {value().total} jobs</p>
                  </Show>
                </>}</Show>
                <p class={"vz-error" + (result()?.ok ? " vz-neutral" : "")}>{result()?.reason ?? result()?.text ?? ""}</p>
              </div>
            </div>
            <div class="vz-run-slot">
              <Show when={!unavailable()} fallback={<p class="vz-readiness-error" role="status">{unavailable()}</p>}><Show when={!running()} fallback={<SingleLineText class="vz-field-help" role="status" value="Queuing…" />}>
                <button class="vz-run" onClick={() => store.handles.invoke("variations.run")}><SingleLineText value="Run" /></button>
              </Show></Show>
            </div>
          </div>
        </div></div>
        <IconButton chrome variant="plain vz-close" title="Close"
          onAction={() => store.handles.invoke("variations.close", { session: props.session })}
          icon={iconSvg("x")} />
      </div>
      <Show when={decision()}>
        <VariationDiscardConfirmation owner={props.session} running={running()} applying={decision().type === "apply-history"} onCancel={guard.cancel} onDiscard={guard.discard} />
      </Show>
    </div>
  );
}

// One enum sweep row: shared heading and the host's filterable option list.
// The current option starts checked and retains its existing marker.
// Props convention mirrors SliderRow:
// p is stable per row, row is a GETTER, interactions report through the
// callbacks — the row never reaches into its parent.
function EnumRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const [filter, setFilter] = createSignal("");
  const r = () => props.row();
  return (
    <ParameterRow class="vz-imgrow vz-enumrow" row={r} enabled={() => r().enabled} filteredOut={props.filteredOut}
      attributes={{ "data-enum-id": props.p.id }} onEnable={checked => props.onToggle(props.p.id, checked)}
      registerFocus={props.registerFocus} onInsert={props.onInsert} summary={`${r().picks.length} ${r().picks.length === 1 ? "option" : "options"}`}>
        <div class="vz-imgrow-body vz-enum-body">
          <Show when={r().values.length > 10}>
            <div class="vz-enum-filter-line">
              <TextField
                {...focus}
                type="text" class="vz-enum-filter" placeholder="filter…"
                aria-label={`Filter ${r().label} options`}
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
              />
              <SingleLineText class="vz-enum-selected" value={`${r().picks.length} selected`} />
            </div>
          </Show>
          <EnumOptions row={r} filter={filter()} onPick={props.onPick} focus={focus} />
        </div>
    </ParameterRow>
  );
}

// Own the list's intrinsic sizing and native resize lifetime with its body.
// Selection never participates in ordering; the current item stays visible
// before the filtered catalogue, even when it doesn't match the query.
function EnumOptions(props) {
  const r = () => props.row();
  const compact = () => r().values.length <= 10;
  const filtered = createMemo(() => {
    const values = r().values, current = r().current;
    if (compact()) return values;
    const query = props.filter.trim().toLowerCase();
    return [...values.filter(value => value === current),
      ...values.filter(value => value !== current && value.toLowerCase().includes(query))];
  });
  let list, option, check;
  onMount(() => {
    if (!compact()) return;
    const context = document.createElement('canvas').getContext('2d');
    const measure = () => {
      if (!option) return;
      // Measure glyphs with the native label's font and our own checkbox slot.
      // Shared Checkbox/SingleLineText DOM remains private to those components.
      const style = getComputedStyle(option);
      context.font = style.font;
      const width = Math.max(...r().values.map(value => context.measureText(value).width))
        + check.getBoundingClientRect().width + parseFloat(style.columnGap);
      if (Number.isFinite(width)) list.style.setProperty('--vz-option-width', `${Math.ceil(width) + 1}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });
  return <div ref={list} class={"vz-enum-list" + (compact() ? " vz-enum-grid" : "")}>
    <For each={filtered()}>
      {(v) => (
        <label ref={option} class={"vz-enum-opt" + (v === r().current ? " vz-enum-current" : "")} classList={{ "vz-enum-picked": r().picks.includes(v) }}>
          <span ref={check} class="vz-enum-check">
            <Checkbox
              {...props.focus}
              size="option"
              checked={r().picks.includes(v)}
              onChange={checked => props.onPick(r().id, v, checked)}
            />
          </span>
          <SingleLineText class="vz-enum-opt-name" value={v} />
        </label>
      )}
    </For>
    <Show when={!filtered().length}><p class="vz-field-help">No options match “{props.filter}”.</p></Show>
  </div>;
}

// Native content/width measurements stay local to the textarea. CSS supplies
// the one-to-eight-line bounds; recipe changes and wrapping both resize it.
function AutoSizeTextArea(props) {
  let input;
  const resize = () => {
    input.style.height = 'auto';
    const style = getComputedStyle(input);
    input.style.height = `${input.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
  };
  createEffect(() => { props.value; resize(); });
  onMount(() => {
    let width;
    const observer = new ResizeObserver(() => {
      const next = input.clientWidth;
      if (next !== width) { width = next; resize(); }
    });
    observer.observe(input);
    onCleanup(() => observer.disconnect());
  });
  return <TextField multiline {...props} ref={input} rows="1" />;
}

// One text sweep row: shared heading and a textarea holding one literal template (the
// current text pre-filled). Each {{label}} in the text spawns a substitution
// input below the textarea (semicolon-separated values, cartesian-expanded
// at tally/run time). Same props convention as EnumRow/SliderRow.
function TextRow(props) {
  const focus = focusMemory(props.rememberFocus);
  const r = () => props.row();
  return (
    <ParameterRow class="vz-imgrow vz-textrow" row={r} enabled={() => r().enabled} filteredOut={props.filteredOut}
      attributes={{ "data-text-id": props.p.id }} onEnable={checked => props.onToggle(props.p.id, checked)}
      registerFocus={props.registerFocus} onInsert={props.onInsert} summary={props.summary}>
        <div class="vz-imgrow-body vz-enum-body">
          <AutoSizeTextArea
            {...focus}
            class="vz-text-values"
            aria-label={`${r().label} template`}
            placeholder="text template — {{label}} adds a substitution axis"
            value={r().text}
            onInput={(e) => props.onField(props.p.id, "text", e.currentTarget.value)}
          />
          <For each={templateLabels(r().text)}>
            {(lab) => (
              <div class="vz-tpl-row">
                <SingleLineText class="vz-tpl-label" value={lab} />
                <TextField
                  {...focus}
                   type="text" class="vz-tpl-input"
                  aria-label={`${r().label}: ${lab} alternatives`}
                  aria-invalid={!String(templateValue(r().tpl, lab) ?? "").trim()}
                  value={templateValue(r().tpl, lab) ?? ""}
                  placeholder="values; separated; by; semicolons"
                  onInput={(e) => props.onTpl(props.p.id, lab, e.currentTarget.value)}
                />
              </div>
            )}
          </For>
        </div>
    </ParameterRow>
  );
}
