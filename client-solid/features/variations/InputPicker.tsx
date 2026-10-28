import { createSignal, createMemo, createEffect, createUniqueId, onMount, onCleanup, For, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { useClickOutside } from "../../lib/click-outside.js";
import { focusMemory } from "./draft.js";
import { useImageDisplay } from "../../lib/img-measure.js";

const ROW_HEIGHT = 48;

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
  const [scroll, setScroll] = createSignal(null), [active, setActive] = createSignal(0);
  const files = createMemo(() => props.files);
  const filtered = createMemo(() => files().filter(name => name.toLowerCase().includes(props.query().toLowerCase())));
  const virtualizer = createVirtualizer({ get count() { return filtered().length; }, getScrollElement: scroll,
    get getItemKey() { const files = filtered(); return index => files[index]; }, estimateSize: () => ROW_HEIGHT, overscan: 0 });
  createEffect(() => { filtered(); setActive(0); virtualizer.scrollToOffset(0); });
  // Template refs exist before their ownerDocument has a window. Admit the
  // visible scroll surface only after insertion/open, so the virtualizer can
  // attach its native resize/scroll observers to the real document.
  onMount(() => {
    panel.showPopover(); setScroll(scrollElement);
    onCleanup(props.registerSurface({
      suspend() { if (panel.matches(":popover-open")) panel.hidePopover(); setScroll(null); },
      resume() { if (!panel.matches(":popover-open")) panel.showPopover(); setScroll(scrollElement); },
    }));
    search.focus();
  });
  const move = event => {
    if (!["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter") { const name = filtered()[active()]; if (name) props.onToggle(name); }
    else {
      const next = Math.max(0, Math.min(filtered().length - 1, active() + (event.key === "ArrowDown" ? 1 : -1)));
      setActive(next); virtualizer.scrollToIndex(next, { align: "auto" });
    }
  };
  return <div ref={panel} id={props.id} popover="manual" class="vz-input-popover" style={{ "position-anchor": props.anchor, "--vz-input-row-height": `${ROW_HEIGHT}px` }} onKeyDown={move}>
    <input ref={search} type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={`${props.id}-list`}
      aria-activedescendant={filtered().length ? `${props.id}-option-${active()}` : undefined}
      class="vz-input-search" placeholder="Search inputs…" aria-label="Search ComfyUI inputs"
      {...focusMemory(props.rememberFocus)} value={props.query()} onInput={e => props.onQuery(e.currentTarget.value)} />
    <div class="vz-input-list" id={`${props.id}-list`} ref={scrollElement} role="listbox" aria-label="ComfyUI inputs" aria-multiselectable="true">
      <div class="vz-input-window" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        <For each={virtualizer.getVirtualItems()}>{virtual => {
          const name = () => filtered()[virtual.index];
          let thumb;
          const display = useImageDisplay(props.registerThumbnail, () => ({ id: props.thumbnail(name()), src: props.thumbnail(name()) }),
            () => thumb, { lazy: true });
          return <button type="button" role="option" tabindex="-1" id={`${props.id}-option-${virtual.index}`} aria-selected={props.selected(name())} data-input-name={name()}
            class={"vz-input-option" + (active() === virtual.index ? " vz-input-active" : "")}
            style={{ transform: `translateY(${virtual.start}px)` }} onClick={() => { setActive(virtual.index); props.onToggle(name()); search.focus(); }}>
            <img ref={thumb} src={display.read().src ?? undefined} alt="" onLoad={display.loaded} onError={display.loaded} />
            <span class="vz-input-name" title={name()}>{name()}</span>
            <Show when={name() === props.current}><span class="vz-image-same">Current</span></Show>
            <span class="vz-input-selected" aria-hidden="true">{props.selected(name()) ? "✓" : ""}</span>
          </button>;
        }}</For>
      </div>
      <Show when={!filtered().length}><p class="vz-image-empty">No matching inputs.</p></Show>
    </div>
  </div>;
}
