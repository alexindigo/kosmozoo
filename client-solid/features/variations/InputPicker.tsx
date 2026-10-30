import { createSignal, createMemo, createEffect, createUniqueId, onMount, onCleanup, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useClickOutside } from "../../lib/click-outside.js";
import { focusMemory } from "./draft.js";
import { useImageDisplay } from "../../lib/img-measure.js";

const TILE_SIZE = 96, GAP = 6, ROW_HEIGHT = TILE_SIZE + GAP;

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
      aria-expanded={open()} aria-haspopup="listbox" aria-controls={id} {...focusMemory(props.rememberFocus)} onClick={() => setOpen(!open())}>ComfyUI inputs ▾</button>
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
  const files = createMemo(() => props.files);
  const filtered = createMemo(() => files().filter(name => name.toLowerCase().includes(props.query().toLowerCase())));
  const rows = createMemo(() => Array.from({ length: Math.ceil(filtered().length / columns()) }, (_, row) =>
    filtered().slice(row * columns(), (row + 1) * columns())));
  const virtualizer = createVirtualizer({ get count() { return rows().length; }, getScrollElement: scroll,
    get getItemKey() { const groups = rows(); return index => groups[index][0]; }, estimateSize: () => ROW_HEIGHT, overscan: 0 });
  createEffect(() => { filtered(); setPendingFocus(null); setActive(0); virtualizer.scrollToOffset(0); });
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
    const measureColumns = () => setColumns(Number(getComputedStyle(panel).getPropertyValue("--vz-input-columns")));
    measureColumns();
    const observer = new ResizeObserver(measureColumns);
    observer.observe(panel); onCleanup(() => observer.disconnect());
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
    <div class="vz-input-list" id={`${props.id}-list`} ref={scrollElement} role="listbox" aria-label="ComfyUI inputs" aria-multiselectable="true">
      <div class="vz-input-window" style={{ height: `${Math.max(0, virtualizer.getTotalSize() - GAP)}px` }}>
        <For each={virtualizer.getVirtualItems()}>{virtual =>
          <div class="vz-input-row" role="presentation" style={{ transform: `translateY(${virtual.start}px)` }}>
            <For each={rows()[virtual.index]}>{(name, offset) => {
              const index = () => virtual.index * columns() + offset();
              const memory = focusMemory(props.rememberFocus);
              let thumb;
              const display = useImageDisplay(props.registerThumbnail, () => ({ id: props.thumbnail(name), src: props.thumbnail(name) }),
                () => thumb, { lazy: true });
              return <button type="button" role="option" tabindex="-1" id={`${props.id}-option-${index()}`}
                aria-label={name} title={name} aria-selected={props.selected(name)} data-input-name={name}
                class={"vz-input-option" + (active() === index() ? " vz-input-active" : "")}
                {...memory} onFocus={event => { setActive(index()); memory.onFocus(event); }}
                onClick={() => { setActive(index()); props.onToggle(name); search.focus(); }}>
                <img ref={thumb} src={display.read().src ?? undefined} alt="" onLoad={display.loaded} onError={display.loaded} />
                <Show when={name === props.current}><span class="vz-image-same" aria-hidden="true">Current</span></Show>
                <Show when={props.selected(name)}><span class="vz-input-selected" aria-hidden="true">✓</span></Show>
              </button>;
            }}</For>
          </div>
        }</For>
      </div>
      <Show when={!filtered().length}><p class="vz-image-empty">No matching inputs.</p></Show>
    </div>
  </div>;
}
