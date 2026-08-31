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
import { Zoomable } from "./Zoomable.js";
import { IconButton } from "./IconButton.js";

function anchorSummary(meta) {
  if (!meta) return "";
  const bits = [];
  if (meta.seed != null) bits.push(`seed ${meta.seed}`);
  if (meta.steps != null) bits.push(`${meta.steps} steps`);
  if (meta.guidance != null) bits.push(`g ${meta.guidance}`);
  if (meta.model) bits.push(meta.model);
  return bits.join(" · ");
}

function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}

// name of the anchor currently being drag-reordered (module-level: it
// survives the reactive updates the reorder itself triggers)
let dragged = null;

function AnchorCard(props) {
  const store = useAppStore();
  const [zoomed, setZoomed] = createSignal(false);
  return (
    <div
      class="card anchor"
      data-name={props.anchor.name}
      draggable={!zoomed()}
      onDragStart={(e) => {
        dragged = props.anchor.name;
        e.dataTransfer.setData("text/x-anchor", "");
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => { dragged = null; }}
      onDragOver={(e) => {
        if (!dragged || dragged === props.anchor.name) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = e.currentTarget.getBoundingClientRect();
        store.actions.anchors.reorder(
          dragged, props.anchor.name, (e.clientY - rect.top) < rect.height / 2);
      }}
    >
      <Zoomable
        src={props.anchor.src}
        alt={props.anchor.name}
        ar={aspectFromMeta(props.anchor.meta)}
        stripText={anchorSummary(props.anchor.meta)}
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
  return (
    <>
      <div id="anchorList">
        <For each={store.state.anchors}>
          {(anchor, idx) => <AnchorCard anchor={anchor} idx={idx()} />}
        </For>
      </div>
      <div
        id="dropzone"
        onClick={() => fileEl?.click()}
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add("over"); }}
        onDragLeave={(e) => e.currentTarget.classList.remove("over")}
        onDrop={async (e) => {
          e.preventDefault();
          e.currentTarget.classList.remove("over");
          if (dragged) { dragged = null; return; } // was a reorder, not files
          if (e.dataTransfer?.files?.length) await store.actions.anchors.addFiles([...e.dataTransfer.files]);
        }}
      >Drop images here<br />(or click to browse)</div>
      <input
        type="file" id="fileInput" ref={fileEl} accept="image/*" multiple hidden
        onChange={async (e) => {
          if (e.target.files.length) await store.actions.anchors.addFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
    </>
  );
}
