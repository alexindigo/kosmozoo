import { createEffect, createSignal, createMemo, onCleanup, For, Show } from "solid-js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { UPLOAD_IMG_EXT } from "../../store/fields.js";
import { focusMemory } from "./draft.js";
import { imageIdentity, uploadImage } from "./image-set.js";
import { InputPicker } from "./InputPicker.js";
import { FolderImages } from "./FolderImages.js";
import { Thumbnail } from "./Thumbnail.js";
import { ImageAction } from "./ImageAction.js";
import { SingleLineText } from "../../components/SingleLineText.js";
import { ParameterRow } from "./ParameterRow.js";
import { useClickOutside } from "../../lib/click-outside.js";
import { isFileDrag, droppedFiles, classifyImageFiles, nearestImageTile, imageInsertIndex } from "./image-drop.js";

const COMFY_ROOTS = [{ value: "input", label: "imported" }, { value: "output", label: "generated" }];

export function ImageSetPanel(props) {
  let fileInput, content, addButton;
  const [adding, setAdding] = createSignal(false), [folder, setFolder] = createSignal(false);
  const row = () => props.row();
  const [dropping, setDropping] = createSignal(false), [status, setStatus] = createSignal("");
  let dragDepth = 0;
  const clearDrop = () => { dragDepth = 0; setDropping(false); };
  const addFiles = (resources, index, enable = false) => {
    const result = classifyImageFiles(resources, name => UPLOAD_IMG_EXT.test(name));
    setStatus(result.status);
    if (!result.images.length) return;
    if (enable && !row().enabled) props.onEnable(true);
    props.onAdd(result.images.map(uploadImage), index);
  };
  onCleanup(props.registerEditor({ suspend: clearDrop, resume() {} }));
  useClickOutside(() => content, event => { if (!event.target.closest?.('.vz-input-popover')) setAdding(false); });
  createEffect(() => { if (adding()) onCleanup(props.registerPopup(() => { setAdding(false); addButton.focus(); })); });
  return <ParameterRow class={`vz-imgrow vz-image-set${dropping() ? " vz-image-dropping" : ""}`} row={row} enabled={() => row().enabled} filteredOut={props.filteredOut}
    attributes={{ "data-image-id": props.id,
      onDragEnter: event => { if (isFileDrag(event.dataTransfer)) { event.preventDefault(); dragDepth++; setDropping(true); } },
      onDragOver: event => { if (isFileDrag(event.dataTransfer)) { event.dataTransfer.dropEffect = "copy"; setDropping(true); } },
      onDragLeave: () => { if (--dragDepth <= 0) clearDrop(); },
      onDrop: event => { if (!isFileDrag(event.dataTransfer)) return; clearDrop(); addFiles(droppedFiles(event.dataTransfer), undefined, true); }
    }} onEnable={props.onEnable} onInsert={props.onInsert} registerFocus={props.registerFocus}
    status={<Show when={status()}><SingleLineText class="vz-image-drop-status" role="status" value={status()} /></Show>}
    summary={`${row().items.length} ${row().items.length === 1 ? "image" : "images"}`}>
    <div class="vz-image-content" ref={content}>
      <Show when={!row().items.length}><p class="vz-image-empty">Add images to vary this input.</p></Show>
      <ImageGrid images={row().images} onMove={props.onMove} registerEditor={props.registerEditor}
        dropping={dropping()} onFiles={(resources, index) => { clearDrop(); addFiles(resources, index, true); }}
        thumbnail={props.thumbnail} archiveThumbnail={props.archiveThumbnail} targetThumbnail={props.targetThumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail}
        rememberFocus={props.rememberFocus} onRemove={props.onRemove}>
        <button ref={addButton} type="button" class="vz-image-plus" aria-label="Add images" aria-expanded={adding()}
          {...focusMemory(props.rememberFocus)} onClick={() => setAdding(!adding())}>+</button>
      </ImageGrid>
      <div class="vz-image-add" hidden={!adding()}>
        <Show when={props.sources.length}><InputPicker label="ComfyUI images" roots={COMFY_ROOTS} noun={root => `${root === "output" ? "generated" : "imported"} images`}
          sources={props.sources} sourceInputs={props.sourceInputs} inputState={props.inputState}
          onSource={props.onSource} onRetrySource={props.onRetrySource} registerTabKeys={props.registerTabKeys}
          current={row().current} currentRoot={row().currentRoot ?? (row().fromOutput ? "output" : "input")} positionRevision={row().images} thumbnail={props.inputThumbnail} registerThumbnail={props.registerThumbnail}
          onToggle={props.onToggleInput}
          registerPopup={props.registerPopup} registerEditor={props.registerEditor} rememberFocus={props.rememberFocus} /></Show>
        <input type="file" ref={fileInput} class="vz-imgfilespick" hidden multiple accept="image/*" onChange={e => {
          addFiles({ files: [...e.currentTarget.files] }); e.currentTarget.value = "";
        }} />
        <ImageAction title="Files from this browser" {...focusMemory(props.rememberFocus)} onClick={() => fileInput.click()}><SingleLineText value="Add files…" /></ImageAction>
        <ImageAction class="vz-image-action vz-folder-trigger" aria-expanded={folder()} {...focusMemory(props.rememberFocus)} onClick={() => setFolder(!folder())}>Add folder…</ImageAction>
        <ImageAction class="vz-image-action vz-current-image" classList={{ "is-on": row().items.some(item => item.kind === "target") }}
          aria-pressed={row().items.some(item => item.kind === "target")} {...focusMemory(props.rememberFocus)} onClick={props.onToggleTarget}>
          Current image
        </ImageAction>
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
  const gap = Symbol("native-file-gap");
  let fileGeometry = null, fileIndex = null;
  const refs = new Map(), animations = new Map();
  const [preview, setPreview] = createSignal(null), [lifted, setLifted] = createSignal(null);
  // Readonly thumbnail/comparison updates replace view records, not the user's
  // ordered set. Only a real membership/order change can retire its held gesture.
  const identities = createMemo(() => props.images.map(imageIdentity), [], {
    equals: (before, after) => before.length === after.length && before.every((key, index) => key === after[index]),
  });
  const order = () => preview() ?? identities();
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
  const tileGeometry = () => identities().map(key => {
    const el = refs.get(key);
    return { x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
  });
  const clearFiles = () => { fileGeometry = null; fileIndex = null; if (!drag) { setPreview(null); stopAnimations(); } };
  createEffect(() => { if (!props.dropping) clearFiles(); });
  const overFiles = event => {
    if (!isFileDrag(event.dataTransfer)) return;
    finish(false);
    // Freeze the un-gapped layout for this drag: opening the slot cannot move
    // the hit-test boundary and oscillate the insertion point under the cursor.
    fileGeometry ??= tileGeometry();
    const origin = grid.getBoundingClientRect();
    const index = event.target.closest('.vz-image-plus') ? identities().length
      : imageInsertIndex(fileGeometry, event.clientX - origin.left, event.clientY - origin.top);
    if (index !== fileIndex) { fileIndex = index; const keys = [...identities()]; keys.splice(index, 0, gap); reorder(keys); }
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
      const nearest = identities()[nearestImageTile(tileGeometry(), drag.x - origin.left, drag.y - origin.top)];
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
  onCleanup(props.registerEditor({ suspend() { finish(false); clearFiles(); }, resume() {} }));
  createEffect(() => { identities(); if (drag) finish(false); clearFiles(); });
  return <div class="vz-image-grid" ref={grid}
    onDragOver={overFiles}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) clearFiles(); }}
    onDrop={event => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.stopPropagation(); const index = fileIndex ?? identities().length;
      clearFiles(); props.onFiles(droppedFiles(event.dataTransfer), index);
    }}
    onPointerMove={event => { if (!drag || drag.pointer !== event.pointerId) return; drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) > 5) { drag.active = true; setLifted(drag.key); } }}
    onPointerUp={() => finish(true)} onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}>
    <For each={order()}>{identity => {
      if (identity === gap) return <div class="vz-image-drop-gap" aria-hidden="true" />;
      const item = () => props.images.find(image => imageIdentity(image) === identity);
      return <div ref={element => { refs.set(identity, element); onCleanup(() => refs.delete(identity)); }}
        class={`vz-image-tile${lifted() === identity ? ' vz-image-dragging' : ''}`} tabindex="0" role="group"
        aria-label={item()?.kind === "target" ? "Current image - each selected image uses itself" : item()?.name}
        title={item()?.kind === "target" ? "Current image - each selected image uses itself" : item()?.path || item()?.name} data-image-name={item()?.name} data-image-kind={item()?.kind}
        {...focusMemory(props.rememberFocus)} onPointerDown={event => start(event, item())}
        onKeyDown={event => {
          if (event.target !== event.currentTarget) return;
          if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault(); const index = order().indexOf(identity) + (event.key === 'ArrowLeft' ? -1 : 1);
            props.onMove(item(), index); event.currentTarget.focus({ preventScroll: true });
          } else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); props.onRemove(item()); }
        }}>
        <ImageTile item={item} thumbnail={props.thumbnail} archiveThumbnail={props.archiveThumbnail} targetThumbnail={props.targetThumbnail} pathThumbnail={props.pathThumbnail} registerThumbnail={props.registerThumbnail}
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
    if (!file()) { setUrl(props.item()?.kind === "target" ? props.targetThumbnail() : props.item()?.kind === "archive" ? props.archiveThumbnail(props.item()) : path() ? props.pathThumbnail(path()) : props.thumbnail(name(), props.item()?.root)); return; }
    const src = URL.createObjectURL(file()); setUrl(src); onCleanup(() => URL.revokeObjectURL(src));
  });
  // Local File previews are object URLs; engine thumbnails are admitted
  // displays, registered only while the tile is near the viewport.
  return <>
    <div class="vz-image-preview"><Thumbnail src={url()} name={name()} local={!!file()} lazy register={props.registerThumbnail} rememberFocus={props.rememberFocus} /></div>
    <Show when={props.item()?.sameCurrent}><span class="vz-image-same" aria-hidden="true" /></Show>
    <Show when={props.item()?.each}><span class="vz-image-each">each</span></Show>
    <div class="vz-image-remove">
      <IconButton chrome variant="overlay" icon={iconSvg("x")} title={`Remove ${props.item()?.name}`} onAction={props.onRemove} />
    </div>
    <Show when={props.item()?.pending}><span class="vz-image-check" role="status" aria-label="Checking image…" /></Show>
    <Show when={props.item()?.error}><SingleLineText class="vz-image-error vz-image-inspection-error" role="status" value={props.item()?.error} /></Show>
  </>;
}
