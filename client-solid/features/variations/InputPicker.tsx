import { createSignal, createMemo, createEffect, createUniqueId, onMount, onCleanup, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useClickOutside } from "../../lib/click-outside.js";
import { focusMemory } from "./draft.js";
import { Thumbnail } from "./Thumbnail.js";
import { ImageAction } from "./ImageAction.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { popoverPlacement } from "../../lib/popover-placement.js";
import { Chevron } from "../../components/Select.js";
import { IconButton } from "../../components/IconButton.js";
import { TextField } from "../../components/TextField.js";
import { Tabs } from "../../components/Tabs.js";
import { iconSvg } from "/js/icons.mjs";
import { sameOrigin } from "/shared/source-origin.mjs";
import { scrollSample, lookaheadBand, lookaheadRange, demandOrder, demandRank, VELOCITY_IDLE_MS } from "./lookahead.js";

const TILE_SIZE = 96, GAP = 6, ROW_HEIGHT = TILE_SIZE + GAP;

// Presentation only: catalogue, selection, thumbnail addresses, thumbnail
// display registration and popup scope registration are injected. The child owns focus, search and virtual geometry.
export function InputPicker(props) {
  const [open, setOpen] = createSignal(false), [query, setQuery] = createSignal("");
  const [activeSource, setActiveSource] = createSignal(props.sources[0].source);
  const [resourceRoot, setResourceRoot] = createSignal("input");
  const source = createMemo(() => props.sources.find(origin => origin.source === activeSource()) ?? props.sources[0]);
  createEffect(() => { if (open()) props.onSource(source(), resourceRoot()); });
  const [suspended, setSuspended] = createSignal(false);
  const id = `vz-image-input-${createUniqueId().replace(/[^\w-]/g, "")}`;
  let root, trigger, surface = null, requestPlacement = () => {};
  const close = () => { setOpen(false); trigger?.focus(); };
  useClickOutside(() => root, () => { if (!suspended()) setOpen(false); });
  const registerSurface = capability => {
    surface = capability;
    if (suspended()) capability.suspend();
    else requestPlacement();
    return () => { if (surface === capability) surface = null; };
  };
  onCleanup(props.registerEditor({
    suspend() { setSuspended(true); surface?.suspend(); },
    resume() { surface?.resume(); setSuspended(false); },
  }));
  createEffect(() => {
    if (!open() || suspended()) return;
    let frame = null, alive = true, previous = null;
    const update = () => {
      frame = null;
      if (!alive || !trigger.isConnected || !surface) return;
      const size = surface.measure();
      if (!size) return;
      const placed = popoverPlacement(trigger.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, size);
      if (!placed) { if (previous) surface.place(null); previous = null; return; }
      if (previous && Object.keys(placed).every(key => placed[key] === previous[key])) return;
      previous = placed; surface.place(placed);
    };
    const schedule = () => { if (alive && frame === null) frame = requestAnimationFrame(update); };
    requestPlacement = schedule;
    // Only the trigger is observed. Popover/list resizing cannot feed placement
    // back into itself, and a scroll inside the popup is not ancestor travel.
    const observer = new ResizeObserver(schedule); observer.observe(trigger);
    const onScroll = event => {
      if (event.target === window || event.target === document || event.target?.contains?.(trigger)) schedule();
    };
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    schedule();
    onCleanup(() => {
      alive = false; if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect(); window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
      if (requestPlacement === schedule) requestPlacement = () => {};
    });
  });
  // The caller supplies presentation invalidation as data, never a DOM node.
  createEffect(() => { props.positionRevision; requestPlacement(); });
  createEffect(() => { if (open()) onCleanup(props.registerPopup(close)); });
  return <div class="vz-input-picker" ref={root}>
    <ImageAction class="select-trigger control-size-md vz-input-trigger" ref={trigger}
      aria-expanded={open()} aria-haspopup="listbox" aria-controls={id} {...focusMemory(props.rememberFocus)} onClick={() => setOpen(!open())}><SingleLineText value="ComfyUI images" /><Chevron /></ImageAction>
    <Show when={open()}>
      <InputOptions id={id} query={query} onQuery={setQuery} files={props.sourceInputs(source(), resourceRoot()).files}
        context={JSON.stringify([source(), resourceRoot()])} resourceRoot={resourceRoot()} onRoot={setResourceRoot}
        onGeometry={() => requestPlacement()}
        catalogue={props.sourceInputs(source(), resourceRoot())} onRetrySource={() => props.onRetrySource(source(), resourceRoot())}
        sources={props.sources} source={source()} onSource={setActiveSource} registerTabKeys={props.registerTabKeys}
        state={name => props.inputState(source(), name, resourceRoot())}
        current={sameOrigin(source(), props.sources[0]) && resourceRoot() === props.currentRoot ? props.current : null}
        thumbnail={name => props.thumbnail(source(), name, resourceRoot())} registerThumbnail={props.registerThumbnail}
        onToggle={name => { props.onToggle(source(), name, resourceRoot()); requestPlacement(); }} rememberFocus={props.rememberFocus} registerSurface={registerSurface} />
    </Show>
  </div>;
}

function InputOptions(props) {
  let panel, search, scrollElement, summary, count, feeds, tabs;
  const feed = () => props.resourceRoot === "output" ? "generated" : "imported";
  const selected = name => props.state(name).selected;
  const [placement, setPlacement] = createSignal(null);
  const [placed, setPlaced] = createSignal(false);
  // Both first focus and the modal's retained caret restoration belong to this
  // surface. No focus callback may run until its visible placement is committed.
  let restoreFocus = () => search.focus({ preventScroll: true });
  const rememberFocus = restore => props.rememberFocus?.(() => {
    if (placed()) restore();
    else restoreFocus = restore;
  });
  createEffect(() => {
    if (!placed()) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive || !panel.isConnected || !panel.matches(":popover-open")) return;
      const restore = restoreFocus; restoreFocus = null; restore?.();
    });
    onCleanup(() => { alive = false; });
  });
  const [scroll, setScroll] = createSignal(null), [active, setActive] = createSignal(0), [columns, setColumns] = createSignal(3);
  const [pendingFocus, setPendingFocus] = createSignal(null);
  const files = createMemo(() => props.files);
  const filtered = createMemo(() => files().filter(name => name.toLowerCase().includes(props.query().toLowerCase())));
  const rows = createMemo(() => Array.from({ length: Math.ceil(filtered().length / columns()) }, (_, row) =>
    filtered().slice(row * columns(), (row + 1) * columns())));
  const [motion, setMotion] = createSignal(null);
  let sample = null, idle = null;
  const band = createMemo(() => lookaheadBand(motion(), motion()?.at ?? 0, ROW_HEIGHT, columns()));
  onCleanup(() => clearTimeout(idle));
  const virtualizer = createVirtualizer({ get count() { return rows().length; }, getScrollElement: scroll,
    onChange(instance) {
      const offset = instance.scrollOffset ?? 0;
      if (sample?.offset === offset) return;
      sample = scrollSample(sample, offset, performance.now());
      setMotion(sample); clearTimeout(idle);
      idle = setTimeout(() => { sample = null; setMotion(null); }, VELOCITY_IDLE_MS);
    },
    get getItemKey() { const groups = rows(), context = props.context; return index => JSON.stringify([context, groups[index][0]]); }, estimateSize: () => ROW_HEIGHT,
    // Keep preload and display on the SAME keyed native element: moving into
    // the mounted-ahead band must not abort/re-fetch a background image.
    get rangeExtractor() {
      const current = band(), width = columns();
      // Virtual geometry remains sorted/unique, separate from demand order.
      return range => lookaheadRange(range, current, width);
    } });
  const thumbnailRows = createMemo(() => {
    const mounted = virtualizer.getVirtualItems(), range = virtualizer.range;
    if (!range) return mounted;
    return [...mounted].sort((a, b) => demandOrder(a.index, b.index, range, band().direction));
  });
  createEffect(() => { props.context; filtered(); setPendingFocus(null); setActive(0); restoreFocus = () => search?.focus({ preventScroll: true }); virtualizer.scrollToOffset(0); });
  createEffect(() => { files().filter(selected).length; props.onGeometry(); });
  createEffect(() => {
    const index = pendingFocus(), context = props.context;
    if (!placed() || index == null || !virtualizer.getVirtualItems().some(row => row.index === Math.floor(index / columns()))) return;
    queueMicrotask(() => {
      if (!placed() || props.context !== context || pendingFocus() !== index || !panel?.isConnected) return;
      const option = panel.querySelector(`#${props.id}-option-${index}`);
      if (option) { option.focus({ preventScroll: true }); setPendingFocus(null); }
    });
  });
  // Template refs exist before their ownerDocument has a window. Admit the
  // visible scroll surface only after insertion/open, so the virtualizer can
  // attach its native resize/scroll observers to the real document.
  onMount(() => {
    panel.showPopover();
    const measure = () => {
      setColumns(Number(getComputedStyle(panel).getPropertyValue("--vz-input-columns")));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel); observer.observe(scrollElement); onCleanup(() => observer.disconnect());
    onCleanup(props.registerSurface({
      measure() {
        if (!panel.isConnected || !panel.matches(":popover-open")) return null;
        const style = getComputedStyle(panel), list = getComputedStyle(scrollElement);
        const horizontalChrome = ["paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth"].reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
        const floor = count.getBoundingClientRect().width + feeds.scrollWidth + (parseFloat(getComputedStyle(summary).columnGap) || 0) + horizontalChrome;
        const gridWidth = Number(style.getPropertyValue("--vz-input-columns")) * (TILE_SIZE + GAP) - GAP;
        const width = Math.max(gridWidth + horizontalChrome + scrollElement.offsetWidth - scrollElement.clientWidth, floor), listHeight = parseFloat(list.maxHeight);
        if (!Number.isFinite(width) || !Number.isFinite(listHeight)) return null;
        const chrome = search.getBoundingClientRect().height + summary.getBoundingClientRect().height + (tabs?.getBoundingClientRect().height ?? 0) + (parseFloat(style.rowGap) || 0) * (tabs ? 2 : 1) + ["paddingTop", "paddingBottom", "borderTopWidth", "borderBottomWidth", "rowGap"]
          .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
        return { width, height: chrome + listHeight, minHeight: chrome + TILE_SIZE };
      },
      place(value) { setPlacement(value); setPlaced(!!value); setScroll(value ? scrollElement : null); },
      // Retain intrinsic geometry/rows across the blocking decision. Readiness
      // gates interaction until the next placement frame, not widget identity.
      suspend() { setPlaced(false); if (panel.matches(":popover-open")) panel.hidePopover(); setScroll(null); },
      resume() { if (!panel.matches(":popover-open")) panel.showPopover(); },
    }));
  });
  const move = event => {
    if (event.target.closest?.('[role=tablist]')) return;
    if (event.target.closest?.(".vz-thumbnail-retry")) return;
    if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") { const name = filtered()[active()]; if (name) props.onToggle(name); }
    else {
      if (!filtered().length) return;
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: columns(), ArrowUp: -columns() }[event.key];
      const next = Math.max(0, Math.min(filtered().length - 1, active() + delta));
      // A scroll event may mount the destination on a later frame. Keep a
      // stable key target until that row exists, rather than focusing a retired tile.
      search.focus({ preventScroll: true });
      setActive(next); setPendingFocus(next);
      virtualizer.scrollToIndex(Math.floor(next / columns()), { align: "auto" });
    }
  };
  return <div ref={panel} id={props.id} popover="manual" class="vz-input-popover"
    classList={{ "is-placed": placed() }} inert={!placed()}
    data-side={placement()?.side}
    style={{ "--vz-input-tile-size": `${TILE_SIZE}px`, "--vz-input-gap": `${GAP}px`,
      left: `${placement()?.left ?? 0}px`, top: `${placement()?.top ?? 0}px`,
      width: placement() ? `${placement().width}px` : undefined,
      height: placement() ? `${placement().height}px` : undefined,
      "max-height": placement() ? `${placement().maxHeight}px` : undefined,
      "min-height": placement() ? `${placement().minHeight}px` : undefined }} onKeyDown={move}>
    <Show when={props.sources.length > 1}>
      <div ref={tabs} class="vz-input-tabs">
        <Tabs label="Image source" options={props.sources.map(origin => ({ value: origin.source, label: origin.source,
          id: `${props.id}-tab-${encodeURIComponent(origin.source)}` }))}
          value={props.source.source} panelId={`${props.id}-source-panel`} onChange={props.onSource}
          registerKeys={props.registerTabKeys} rememberFocus={rememberFocus} />
      </div>
    </Show>
    <TextField ref={search} type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${props.id}-list`}
      aria-activedescendant={placement() && filtered().length ? `${props.id}-option-${active()}` : undefined}
      class="vz-input-search" placeholder={`Search ${feed()} images...`} aria-label={`Search ${feed()} images`}
      {...focusMemory(rememberFocus)} value={props.query()} onInput={e => props.onQuery(e.currentTarget.value)}
      trailing={<Show when={props.query()}><IconButton chrome size="md" variant="plain vz-search-clear" title="Clear search"
        icon={iconSvg("x")} onAction={() => { props.onQuery(""); search.focus(); }} /></Show>} />
    <div class="vz-input-source-panel" id={`${props.id}-source-panel`} role="tabpanel"
      aria-labelledby={`${props.sources.length > 1 ? `${props.id}-tab-${encodeURIComponent(props.source.source)} ` : ""}${props.id}-feed-${props.resourceRoot}`}>
    <div class="vz-input-list" id={`${props.id}-list`} ref={scrollElement} role="listbox" aria-label={`${props.source.source} ${feed()} images`} aria-multiselectable="true">
      <div class="vz-input-window" style={{ height: `${Math.max(0, virtualizer.getTotalSize() - GAP)}px` }}>
        <For each={placement() ? thumbnailRows() : []}>{virtual =>
          <div class="vz-input-row" role="presentation" style={{ transform: `translateY(${virtual.start}px)` }}>
            <For each={rows()[virtual.index]}>{(name, offset) => {
              const index = () => virtual.index * columns() + offset();
              const memory = focusMemory(rememberFocus);
               // Queued demand follows visibility without replacing its keyed
               // native lifetime or aborting an already-started preload.
                const priority = () => {
                  const range = virtualizer.range;
                  return range && virtual.index >= range.startIndex && virtual.index <= range.endIndex ? "foreground" : "background";
                };
               return <Thumbnail class="vz-input-tile" name={name} src={props.thumbnail(name)} register={props.registerThumbnail}
                 order={() => demandRank(virtual.index, virtualizer.range, band().direction)}
                pending={props.state(name).pending} error={props.state(name).error} onRetry={() => props.onToggle(name)}
                priority={priority} rememberFocus={rememberFocus} surface={picture => <button type="button" role="option" tabindex="-1" id={`${props.id}-option-${index()}`}
                aria-label={name} title={name} aria-selected={selected(name)} data-input-name={name}
                class={"vz-input-option" + (active() === index() ? " vz-input-active" : "")}
                {...memory} onFocus={event => { setActive(index()); memory.onFocus(event); }}
                onClick={() => { setActive(index()); props.onToggle(name); search.focus(); }}>
                {picture}
                <Show when={name === props.current}><span class="vz-image-same" aria-hidden="true" /></Show>
                <Show when={selected(name)}><SingleLineText class="vz-input-selected" aria-hidden="true" value="✓" /></Show>
              </button>} />;
            }}</For>
          </div>
        }</For>
      </div>
      <Show when={props.catalogue.pending}><SingleLineText class="vz-input-status" role="status" value={`Reading ${props.source.source} ${feed()} images...`} /></Show>
      <div class="vz-input-status vz-input-failure" hidden={!props.catalogue.error}>
        <SingleLineText role="status" value={props.catalogue.error ? `Couldn't list ${props.source.source}'s ${feed()} images.` : ""} hint={props.catalogue.error} />
        <button type="button" class="vz-thumbnail-retry" onClick={props.onRetrySource}>Retry</button>
      </div>
      <Show when={!filtered().length && !props.catalogue.pending && !props.catalogue.error}><p class="vz-image-empty">{files().length ? `No ${feed()} images match "${props.query()}".` : `No ${feed()} images available.`}</p></Show>
    </div>
    </div>
    <div ref={summary} class="vz-input-summary">
      <span ref={count} role="status">{files().filter(selected).length} selected</span>
      <div ref={feeds} class="vz-input-feeds"><Tabs label="Image feed" options={[{ value: "input", label: "imported", id: `${props.id}-feed-input` }, { value: "output", label: "generated", id: `${props.id}-feed-output` }]}
        value={props.resourceRoot} panelId={`${props.id}-source-panel`} onChange={props.onRoot}
        registerKeys={capability => props.registerTabKeys(capability, "feed")} rememberFocus={rememberFocus} /></div>
    </div>
  </div>;
}
