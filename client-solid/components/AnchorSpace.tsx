// client-solid/components/AnchorSpace.tsx — the anchors feed.
//
// Anchor cards share the candidate card's anatomy minus judgment: same
// aspect-true <Zoomable> image box, name, metadata summary strip, ⓘ
// full-params overlay, × remove — the buttons are the shared <IconButton>.
// Click opens that anchor in the workbench. Reorder by drag; drop files to
// add.

import { createSignal, For } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { aspectFromMeta } from "../store/fields.js";
import { Zoomable } from "./Zoomable.js";
import { IconButton } from "./IconButton.js";

function AnchorCard(props) {
  const store = useAppStore();
  const [zoomed, setZoomed] = createSignal(false);
  return (
    <div
      class="card anchor"
      data-name={props.anchor.name}
      draggable={!zoomed()}
      onDragStart={(e) => {
        props.setDragged(props.anchor.name);
        // the dataTransfer carries the REAL payload (G20): the dropzone
        // tells a reorder from a file drop by the drag's own data
        e.dataTransfer.setData("text/x-anchor", props.anchor.name);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        props.setDragged(null);
        store.actions.anchors.persist(); // persistence waits for the drop (G5)
      }}
      onDragOver={(e) => {
        const d = props.dragged();
        if (!d || d === props.anchor.name) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        store.actions.anchors.reorder(
          d, props.anchor.name, (e.clientY - rect.top) < rect.height / 2);
      }}
    >
      <Zoomable
        src={props.anchor.src}
        alt={props.anchor.name}
        ar={aspectFromMeta(props.anchor.meta)}
        zoomKey={`anchor:${props.anchor.name}`}
        onZoomChange={setZoomed}
        onOpen={() => store.actions.diff.openFromAnchor(props.idx)}
      />
      <div class="ctitle">
        <span class="aname" title={props.anchor.name}>{props.anchor.name}</span>
        <span class="btnwrap">
          <IconButton
            icon={iconSvg("info-circle", 14)} variant="ainfo" title="embedded parameters"
            onAction={() => store.actions.anchors.showInfo(props.anchor.name, props.anchor.meta)}
          />
          <IconButton
            icon={iconSvg("trash", 13)} variant="rm" title="remove anchor"
            onAction={() => store.actions.anchors.remove(props.anchor.name)}
          />
        </span>
      </div>
    </div>
  );
}

export function AnchorSpace() {
  const store = useAppStore();
  let fileEl;
  // the drag-reorder state is component state, not a module global (G20)
  const [dragged, setDragged] = createSignal(null);
  // the dropzone's highlight is a signal-driven class, not classList pokes
  const [over, setOver] = createSignal(false);
  return (
    <>
      <div id="anchorList">
        <For each={store.state.anchors}>
          {(anchor, idx) => (
            <AnchorCard anchor={anchor} idx={idx()} dragged={dragged} setDragged={setDragged} />
          )}
        </For>
      </div>
      <div
        id="dropzone"
        classList={{ over: over() }}
        onClick={() => fileEl?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer?.getData("text/x-anchor")) return; // a reorder, not files
          if (e.dataTransfer?.files?.length) await store.actions.anchors.addFiles([...e.dataTransfer.files]);
        }}
      >Drop images here<br />(or click to browse)</div>
      <input
        type="file" ref={fileEl} accept="image/*" multiple hidden
        onChange={async (e) => {
          if (e.target.files.length) await store.actions.anchors.addFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
    </>
  );
}
