import { createEffect, createSignal, createMemo, onCleanup, For, Show } from "solid-js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { focusMemory } from "./draft.js";
import { imageIdentity, uploadImage } from "./image-set.js";
import { InputPicker } from "./InputPicker.js";
import { FolderImages } from "./FolderImages.js";
import { Thumbnail } from "./Thumbnail.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { ParameterRow } from "./ParameterRow.js";
import { useClickOutside } from "../../lib/click-outside.js";

export function ImageSetPanel(props) {
  let fileInput, content, addButton;
  const [adding, setAdding] = createSignal(false), [folder, setFolder] = createSignal(false), [ratio, setRatio] = createSignal(1);
  const row = () => props.row();
  const selected = name => row().items.some(item => item.kind === "input" && item.name === name);
  useClickOutside(() => content, event => { if (!event.target.closest?.('.vz-input-popover')) setAdding(false); });
  createEffect(() => { if (adding()) onCleanup(props.registerPopup(() => { setAdding(false); addButton.focus(); })); });
  return <ParameterRow class="vz-imgrow vz-image-set" row={row} enabled={() => row().enabled}
    attributes={{ "data-image-id": props.id }} onEnable={props.onEnable} onInsert={props.onInsert}
    summary={`${row().items.length} ${row().items.length === 1 ? "image" : "images"}`}>
    <div class="vz-image-content" ref={content} style={{ "--vz-image-ratio": ratio() }}>
      <div class="vz-image-ratio-source" aria-hidden="true" inert><Thumbnail src={props.currentThumbnail} register={props.registerThumbnail}
        onSize={(width, height) => { if (width > 0 && height > 0) setRatio(width / height); }} /></div>
      <Show when={!row().items.length}><p class="vz-image-empty">Add images to vary this input.</p></Show>
      <ImageGrid images={row().images} onMove={props.onMove} registerEditor={props.registerEditor}
        thumbnail={props.thumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail}
        rememberFocus={props.rememberFocus} onRemove={props.onRemove}>
        <button ref={addButton} type="button" class="vz-image-plus" aria-label="Add images" aria-expanded={adding()}
          {...focusMemory(props.rememberFocus)} onClick={() => setAdding(!adding())}>+</button>
      </ImageGrid>
      <div class="vz-image-add" hidden={!adding()}>
        <InputPicker files={row().files} current={row().fromOutput ? null : row().current} selected={selected} positionRevision={row().images} thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail}
          onToggle={name => selected(name) ? props.onRemove({ kind: "input", name }) : props.onAdd([{ kind: "input", name }])}
          registerPopup={props.registerPopup} registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
        <input type="file" ref={fileInput} class="vz-imgfilespick" hidden multiple accept="image/*" onChange={e =>
          props.onAdd([...e.currentTarget.files].filter(file => UPLOAD_IMG_EXT.test(file.name)).map(uploadImage))} />
        <button type="button" class="vz-image-action" title="Files from this browser" {...focusMemory(props.rememberFocus)} onClick={() => fileInput.click()}><SingleLineText value="Add files…" /></button>
        <button type="button" class="vz-image-action vz-folder-trigger" aria-expanded={folder()} {...focusMemory(props.rememberFocus)} onClick={() => setFolder(!folder())}>Add folder…</button>
        <div class="vz-image-folder" hidden={!folder()}>
        <FolderImages onAdd={props.onAddFolder} capability={props.folderCapability} onChoose={props.onChooseFolder}
          registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} />
        </div>
      </div>
    </div>
  </ParameterRow>;
}

// The grid owns tile geometry and transient gesture order. Only a drop (or a
// keyboard move) writes through the injected recipe intent; cancellation is inert.
function ImageGrid(props) {
  let grid, drag = null, frame = null;
  const refs = new Map(), animations = new Map();
  const [preview, setPreview] = createSignal(null), [lifted, setLifted] = createSignal(null);
  const order = () => preview() ?? props.images.map(imageIdentity);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stopAnimations = () => { for (const animation of animations.values()) animation.cancel(); animations.clear(); };
  const reorder = keys => {
    const before = new Map([...refs].map(([key, el]) => [key, el.getBoundingClientRect()]));
    stopAnimations(); setPreview(keys);
    if (!reduced()) for (const [key, el] of refs) {
      if (key === lifted()) continue;
      const first = before.get(key), last = el.getBoundingClientRect();
      if (first && (first.x !== last.x || first.y !== last.y)) animations.set(key,
        el.animate([{ transform: `translate(${first.x - last.x}px, ${first.y - last.y}px)` }, { transform: 'none' }], { duration: 150, easing: 'ease-out' }));
    }
  };
  const finish = commit => {
    if (!drag) return;
    const gesture = drag; drag = null;
    if (frame !== null) cancelAnimationFrame(frame); frame = null;
    gesture.element.style.transform = ''; setLifted(null);
    if (commit && preview()) props.onMove(gesture.item, order().indexOf(gesture.key));
    setPreview(null); stopAnimations();
    if (grid.hasPointerCapture(gesture.pointer)) grid.releasePointerCapture(gesture.pointer);
  };
  const tick = () => {
    if (!drag) return;
    if (drag.active) {
      const bounds = drag.scroll.getBoundingClientRect(), edge = 48;
      const delta = drag.y < bounds.top + edge ? -Math.min(14, (bounds.top + edge - drag.y) / 4)
        : drag.y > bounds.bottom - edge ? Math.min(14, (drag.y - bounds.bottom + edge) / 4) : 0;
      if (delta) drag.scroll.scrollTop += delta;
      // offset geometry excludes FLIP/lift transforms, so animations cannot
      // turn the destination's moving pixels into another reorder decision.
      const origin = grid.getBoundingClientRect();
      const nearest = [...refs].map(([key, el]) => ({ key, distance: Math.hypot(
        origin.left + el.offsetLeft + el.offsetWidth / 2 - drag.x,
        origin.top + el.offsetTop + el.offsetHeight / 2 - drag.y) }))
        .sort((a, b) => a.distance - b.distance)[0]?.key;
      const keys = order(), from = keys.indexOf(drag.key), to = keys.indexOf(nearest);
      if (to >= 0 && to !== from) { const next = [...keys]; next.splice(to, 0, ...next.splice(from, 1)); reorder(next); }
      drag.element.style.transform = `translate(${drag.x - origin.left - drag.element.offsetLeft - drag.offsetX}px, ${drag.y - origin.top - drag.element.offsetTop - drag.offsetY}px) scale(1.025)`;
    }
    frame = requestAnimationFrame(tick);
  };
  const start = (event, item) => {
    if (!event.isPrimary || event.button !== 0 || event.target.closest('button')) return;
    finish(false);
    const element = event.currentTarget, rect = element.getBoundingClientRect();
    let scroll = grid.parentElement;
    while (scroll.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
    drag = { item, key: imageIdentity(item), element, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, scroll, active: false };
    element.focus({ preventScroll: true }); grid.setPointerCapture(event.pointerId); frame = requestAnimationFrame(tick);
  };
  onCleanup(() => finish(false));
  onCleanup(props.registerEditor({ suspend() { finish(false); }, resume() {} }));
  createEffect(() => { props.images; if (drag) finish(false); });
  return <div class="vz-image-grid" ref={grid}
    onPointerMove={event => { if (!drag || drag.pointer !== event.pointerId) return; drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5) { drag.active = true; setLifted(drag.key); } }}
    onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}>
    <For each={order()}>{identity => {
      const item = () => props.images.find(image => imageIdentity(image) === identity);
      return <div ref={element => { refs.set(identity, element); onCleanup(() => refs.delete(identity)); }}
        class={`vz-image-tile${lifted() === identity ? ' vz-image-dragging' : ''}`} tabindex="0" role="group"
        aria-label={item()?.name} title={item()?.path || item()?.name} data-image-name={item()?.name}
        {...focusMemory(props.rememberFocus)} onPointerDown={event => start(event, item())}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault(); const index = order().indexOf(identity) + (event.key === 'ArrowLeft' ? -1 : 1);
            props.onMove(item(), index); event.currentTarget.focus({ preventScroll: true });
          } else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); props.onRemove(item()); }
        }}>
        <ImageTile item={item} thumbnail={props.thumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail}
          rememberFocus={props.rememberFocus} onRemove={() => props.onRemove(item())} />
      </div>;
    }}</For>
    {props.children}
  </div>;
}

function ImageTile(props) {
  const [url, setUrl] = createSignal("");
  const file = createMemo(() => props.item()?.file), name = createMemo(() => props.item()?.name), path = createMemo(() => props.item()?.path);
  createEffect(() => {
    if (!name()) return;
    if (!file()) { setUrl(path() ? props.pathThumbnail(path()) : props.thumbnail(name())); return; }
    const src = URL.createObjectURL(file()); setUrl(src); onCleanup(() => URL.revokeObjectURL(src));
  });
  // Local File previews are object URLs; engine thumbnails are admitted
  // displays, registered only while the tile is near the viewport.
  return <>
    <div class="vz-image-preview"><Thumbnail src={url()} name={name()} local={!!file()} lazy register={props.registerThumbnail} rememberFocus={props.rememberFocus} /></div>
    <Show when={props.item()?.sameCurrent}><span class="vz-image-same" aria-hidden="true" /></Show>
    <div class="vz-image-remove">
      <IconButton chrome variant="overlay" icon={iconSvg("x")} title={`Remove ${props.item()?.name}`} onAction={props.onRemove} />
    </div>
    <Show when={props.item()?.pending}><span class="vz-image-check" role="status" aria-label="Checking image…" /></Show>
    <Show when={props.item()?.error}><SingleLineText class="vz-image-error vz-image-inspection-error" role="status" value={props.item()?.error} /></Show>
  </>;
}
