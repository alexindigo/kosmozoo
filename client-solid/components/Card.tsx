// client-solid/components/Card.tsx — the CANDIDATE image card, declarative.
//
// Composes <Zoomable> (image box), the title row (filename + icon-button
// actions + save), and the notes pair (<NoteBox>). Full metadata lives in
// the details pane — the card carries no meta section. Judgment lives in
// the store's images tree (the source of truth); vote/favorite are
// path-level updates the card's bindings follow by construction.

import { createSignal, onMount, onCleanup } from "solid-js";
import { Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { flash } from "../lib/flash.js";
import { Zoomable } from "./Zoomable.js";
import { EntryActions } from "./EntryActions.js";
import { NoteBox } from "./NoteBox.js";
import { mediaKind } from "/shared/backings/mime.mjs";

export function Card(props) {
  const store = useAppStore();
  // the card knows its entry id; the index comes from the store's map — O(1)
  const imgIdx = () => store.state.imageIdxById().get(props.entryId);
  const image = () => store.state.images[imgIdx()];
  const meta = () => image()?.meta ?? null;
  const state = () => store.state.cardState(props.entryId);
  const word = () => mediaKind(image()?.filename) === "audio" ? "audio file" : mediaKind(image()?.filename) ?? "image";
  const playable = () => ["video", "audio"].includes(mediaKind(image()?.filename));
  const [controlsMount, setControlsMount] = createSignal(null);

  // the box's aspect is DATA — the store's resolved size (meta, else the
  // off-DOM loader's natural measurement), never the in-card img's load.
  // Pending entries stay out of the feed; terminal failures have the size
  // owner's fixed square box and keep the same normal card controls.
  const sizeInfo = () => store.state.cardSize(imgIdx());
  const src = () => {
    const img = image();
    if (!img || store.state.sizeFailed(props.entryId)) return null;
    // the card is only MOUNTED at known size — the img's src follows the
    // window's range membership, in FEED POSITIONS (the one index space the
    // window knows); broken bytes take the in-card error path
    return store.state.window.getSrc(store.state.feedPositionOf(props.entryId), img);
  };
  // Filename copy feedback is independent of each NoteBox's save confirmation.
  const [copiedOn, setCopiedOn] = createSignal(false);
  const flashCopied = flash(setCopiedOn, 800);

  onMount(() => {
    if (image()?.size == null) store.actions.images.fillSize(image().id);
  });

  const saveNote = (sign) => (text, id) =>
    store.handles.invoke("judgment.apply", { id, intent: { type: "note", sign, text } });

  // First neighbor WITH CONTENT in that direction; an unsaved draft wins
  // over the saved judgment note (it may hold newer edits).
  const neighborText = (cls) => (dir) => {
    const images = store.state.images;
    const ordering = store.state.folderView();
    for (let i = ordering.indexOf(imgIdx()) + dir; i >= 0 && i < ordering.length; i += dir) {
      const im = images[ordering[i]];
      const text = store.state.drafts[`${im?.id}:${cls}`] ?? im?.judgment?.notes?.[cls] ?? "";
      if (text) return text;
    }
    return "";
  };

  const copyName = (e) => {
    e.stopPropagation();
    store.handles.invoke("entry.copyReference", { id: props.entryId })
      ?.then(flashCopied)
      .catch(() => {});
  };

  const del = () => store.state.hosts[image()?.host]?.capabilities?.delete ?? null;

  return (
    <>
      <Zoomable
        src={src()}
        failed={store.state.sizeFailed(props.entryId)}
        resourceId={props.entryId}
        identity={image()?.hash}
        alt={image()?.filename}
        size={sizeInfo()}
        zoomKey={image()?.id}
        focused={props.focused}
        controlsMount={controlsMount()}
        registerExposure={input => store.actions.feed.expose(props.entryId, input)}
        onOpen={() => store.handles.invoke("workbench.openEntry", { id: props.entryId })}
        onErrorClick={() => store.state.window.retry(props.entryId)}
        onPhase={(p) => {
          if (p === "loading") store.state.window.markStarted(props.entryId);
          else if (p === "loaded") store.state.window.markLoaded(props.entryId);
          else if (p === "error" && !store.state.sizeFailed(props.entryId)) store.state.window.markError(props.entryId);
        }}
      />
      {/* One in-flow foot keeps playback and feedback together while a tall
          card scrolls. The playable row reserves the same measured height
          even when its native source is absent or failed. */}
      <div class="card-foot" ref={element => onCleanup(store.actions.feed.occluder(element))}>
        <Show when={playable()}><div class="media-controls-slot" ref={setControlsMount} /></Show>
        <div class="ctitle">
          <span class="ctitle-left">
            <input
              type="checkbox" class="selcb"
              checked={!!store.state.selected[image()?.id]}
              title="select for bulk actions"
              onClick={(e) => {
                e.stopPropagation();
                store.handles.invoke("selection.set", { id: props.entryId, value: e.target.checked });
              }}
            />
            <span class="copyable" classList={{ copied: copiedOn() }} title="Copy the image file name and folder path" onClick={copyName}>
              {image()?.filename}
            </span>
          </span>
          <span class="btnwrap">
            <EntryActions target={{ id: props.entryId }} judgmentType="toggle"
              active={state().active} word={word()} deleteCapability={del()} />
          </span>
        </div>
        <div class="pair">
          <NoteBox
            sign="neg" placeholder="negatives…" noteId={image()?.id}
            initialValue={image()?.judgment?.notes?.neg ?? ""}
            onSave={saveNote("neg")} getNeighborText={neighborText("neg")}
          />
          <NoteBox
            sign="pos" placeholder="positives…" noteId={image()?.id}
            initialValue={image()?.judgment?.notes?.pos ?? ""}
            onSave={saveNote("pos")} getNeighborText={neighborText("pos")}
          />
        </div>
      </div>
    </>
  );
}
