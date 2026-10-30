import { createSignal, createMemo, createEffect, createUniqueId, onMount, onCleanup, For, Show } from "solid-js";
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual";
import { useClickOutside } from "../../lib/click-outside.js";
import { focusMemory } from "./draft.js";
import { useImageDisplay } from "../../lib/img-measure.js";
import { SingleLineText } from "../../components/SingleLineText.js";

const TILE_SIZE = 96, GAP = 6, ROW_HEIGHT = TILE_SIZE + GAP, OVERSCAN_ROWS = 3;

// Presentation only: catalogue, selection, thumbnail addresses, thumbnail
// display registration and popup scope registration are injected. The child owns focus, search and virtual geometry.
export function InputPicker(props) {
  const [open, setOpen] = createSignal(false), [query, setQuery] = createSignal("");
  const id = `vz-image-input-${createUniqueId().replace(/[^\w-]/g, "")}`, anchor = `--${id}`;
  let root, trigger, surface = null, suspended = false;
  const close = () => { setOpen(false); trigger?.focus(); };
  useClickOutside(() => root, () => { if (!suspended) setOpen(false); });
  const registerSurface = capability => {
    surface = capability;
    if (suspended) capability.suspend();
    return () => { if (surface === capability) surface = null; };
  };
  onCleanup(props.registerEditor({
    suspend() { suspended = true; surface?.suspend(); },
    resume() { suspended = false; surface?.resume(); },
  }));
  createEffect(() => { if (open()) onCleanup(props.registerPopup(close)); });
  return <div class="vz-input-picker" ref={root}>
    <button type="button" class="vz-image-action vz-input-trigger" ref={trigger} style={{ "anchor-name": anchor }}
      aria-expanded={open()} aria-haspopup="listbox" aria-controls={id} {...focusMemory(props.rememberFocus)} onClick={() => setOpen(!open())}><SingleLineText value="ComfyUI inputs ▾" /></button>
    <Show when={open()}>
      <InputOptions id={id} anchor={anchor} query={query} onQuery={setQuery} files={props.files} selected={props.selected}
        current={props.current} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail} onToggle={props.onToggle} rememberFocus={props.rememberFocus} registerSurface={registerSurface} />
    </Show>
  </div>;
}

function InputOptions(props) {
  let panel, search, scrollElement;
  const [scroll, setScroll] = createSignal(null), [active, setActive] = createSignal(0), [columns, setColumns] = createSignal(3);
  const [pendingFocus, setPendingFocus] = createSignal(null);
  const [direction, setDirection] = createSignal(1), [aheadRows, setAheadRows] = createSignal(0);
  let lastOffset = 0;
  const files = createMemo(() => props.files);
  const filtered = createMemo(() => files().filter(name => name.toLowerCase().includes(props.query().toLowerCase())));
  const rows = createMemo(() => Array.from({ length: Math.ceil(filtered().length / columns()) }, (_, row) =>
    filtered().slice(row * columns(), (row + 1) * columns())));
  const virtualizer = createVirtualizer({ get count() { return rows().length; }, getScrollElement: scroll,
    get getItemKey() { const groups = rows(); return index => groups[index][0]; }, estimateSize: () => ROW_HEIGHT, overscan: OVERSCAN_ROWS,
    // Keep preload and display on the SAME keyed native element: moving into
    // the mounted-ahead band must not abort/re-fetch a background image.
    get rangeExtractor() {
      const ahead = aheadRows(), forward = direction() > 0;
      return range => {
        const mounted = defaultRangeExtractor(range);
        const start = forward ? mounted[mounted.length - 1] + 1 : Math.max(0, mounted[0] - ahead);
        const end = forward ? Math.min(range.count, start + ahead) : mounted[0];
        const extra = Array.from({ length: end - start }, (_, i) => start + i);
        return forward ? [...mounted, ...extra] : [...extra, ...mounted];
      };
    } });
  createEffect(() => { filtered(); setPendingFocus(null); setActive(0); lastOffset = 0; setDirection(1); virtualizer.scrollToOffset(0); });
  createEffect(() => {
    const index = pendingFocus();
    if (index == null || !virtualizer.getVirtualItems().some(row => row.index === Math.floor(index / columns()))) return;
    queueMicrotask(() => {
      if (pendingFocus() !== index || !panel?.isConnected) return;
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
      setAheadRows(Math.ceil(scrollElement.clientHeight / ROW_HEIGHT));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel); observer.observe(scrollElement); onCleanup(() => observer.disconnect());
    setScroll(scrollElement);
    onCleanup(props.registerSurface({
      suspend() { if (panel.matches(":popover-open")) panel.hidePopover(); setScroll(null); },
      resume() { if (!panel.matches(":popover-open")) panel.showPopover(); setScroll(scrollElement); },
    }));
    search.focus();
  });
  const move = event => {
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
    style={{ "position-anchor": props.anchor, "--vz-input-tile-size": `${TILE_SIZE}px`, "--vz-input-gap": `${GAP}px` }} onKeyDown={move}>
    <input ref={search} type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${props.id}-list`}
      aria-activedescendant={filtered().length ? `${props.id}-option-${active()}` : undefined}
      class="vz-input-search" placeholder="Search inputs…" aria-label="Search ComfyUI inputs"
      {...focusMemory(props.rememberFocus)} value={props.query()} onInput={e => props.onQuery(e.currentTarget.value)} />
    <div class="vz-input-list" id={`${props.id}-list`} ref={scrollElement} role="listbox" aria-label="ComfyUI inputs" aria-multiselectable="true"
      onScroll={event => {
        const offset = event.currentTarget.scrollTop;
        if (offset !== lastOffset) setDirection(offset > lastOffset ? 1 : -1);
        lastOffset = offset;
      }}>
      <div class="vz-input-window" style={{ height: `${Math.max(0, virtualizer.getTotalSize() - GAP)}px` }}>
        <For each={virtualizer.getVirtualItems()}>{virtual =>
          <div class="vz-input-row" role="presentation" style={{ transform: `translateY(${virtual.start}px)` }}>
            <For each={rows()[virtual.index]}>{(name, offset) => {
              const index = () => virtual.index * columns() + offset();
              const memory = focusMemory(props.rememberFocus);
              return <button type="button" role="option" tabindex="-1" id={`${props.id}-option-${index()}`}
                aria-label={name} title={name} aria-selected={props.selected(name)} data-input-name={name}
                class={"vz-input-option" + (active() === index() ? " vz-input-active" : "")}
                {...memory} onFocus={event => { setActive(index()); memory.onFocus(event); }}
                onClick={() => { setActive(index()); props.onToggle(name); search.focus(); }}>
                <InputThumbnail name={name} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
                  background={virtual.index < virtualizer.range.startIndex - OVERSCAN_ROWS || virtual.index > virtualizer.range.endIndex + OVERSCAN_ROWS} />
                <Show when={name === props.current}><SingleLineText class="vz-image-same" aria-hidden="true" value="Current" /></Show>
                <Show when={props.selected(name)}><SingleLineText class="vz-input-selected" aria-hidden="true" value="✓" /></Show>
              </button>;
            }}</For>
          </div>
        }</For>
      </div>
      <Show when={!filtered().length}><p class="vz-image-empty">No matching inputs.</p></Show>
    </div>
  </div>;
}

function InputThumbnail(props) {
  let thumb;
  // Admission class belongs to this native lifetime. A background image
  // finishes there even as scrolling brings its tile into view.
  const priority = props.background ? "background" : "foreground";
  const display = useImageDisplay(props.registerThumbnail, () => ({ id: props.thumbnail(props.name), src: props.thumbnail(props.name),
    priority }), () => thumb);
  return <img ref={thumb} src={display.read().src ?? undefined} alt="" decoding="async"
    fetchpriority={display.read().priority === "background" ? "low" : "auto"} onLoad={display.loaded} onError={display.loaded} />;
}
