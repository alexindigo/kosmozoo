// client-solid/components/Card.tsx — the CANDIDATE image card, declarative.
//
// Composes <Zoomable> (image box), the title row (filename + icon-button
// actions + save), and the notes pair (<NoteBox>). Full metadata lives in
// the details pane — the card carries no meta section. Judgment lives in
// the store's images tree (the source of truth); vote/favorite are
// path-level updates the card's bindings follow by construction.

import { createSignal, onMount } from "solid-js";
import { For, Show } from "solid-js";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { flash } from "../lib/flash.js";
import { Zoomable } from "./Zoomable.js";
import { IconButton } from "./IconButton.js";
import { NoteBox } from "./NoteBox.js";

export function Card(props) {
  const store = useAppStore();
  // the card knows its entry id; the index comes from the store's map — O(1)
  const imgIdx = () => store.state.imageIdxById().get(props.entryId);
  const image = () => store.state.images[imgIdx()];
  const meta = () => image()?.meta ?? null;
  const state = () => store.state.cardState(props.entryId);

  // the box's aspect is DATA — the store's resolved size (meta, else the
  // off-DOM loader's natural measurement), never the in-card img's load.
  // An unknown size renders the 16:9 floor placeholder; the img inserts
  // only once the size is known (off-card resolution keeps it out of view
  // until then)
  const sizeInfo = () => store.state.cardSize(imgIdx());
  const ar = () => {
    const s = sizeInfo();
    return s ? `${s.w} / ${s.h}` : null;
  };
  const src = () => {
    const img = image();
    if (!img) return null;
    // the card is only MOUNTED at known size — the img's src follows the
    // window's range membership, in FEED POSITIONS (the one index space the
    // window knows); broken bytes take the in-card error path
    return store.state.window.getSrc(store.state.feedPositionOf(props.entryId), img);
  };
  // the two flash windows are signals through the shared helper —
  // no classList pokes, no orphan timers
  const [savedOn, setSavedOn] = createSignal(false);
  const flashSaved = flash(setSavedOn);
  const [copiedOn, setCopiedOn] = createSignal(false);
  const flashCopied = flash(setCopiedOn, 800);

  onMount(() => {
    if (image()?.size == null) store.actions.images.fillSize(image().id);
  });

  const saveNote = (sign) => (text, id) => {
    return store.actions.judgments.dispatch(id, { type: "note", sign, text }).then((result) => {
      if (result.ok && props.entryId === id) flashSaved();
      return result;
    });
  };

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
    navigator.clipboard?.writeText(store.state.referenceName(image()))
      .then(flashCopied)
      .catch(() => {});
  };

  const del = () => store.state.hosts[image()?.host]?.capabilities?.delete ?? null;
  const delCopy = () => deleteCopy(del());

  return (
    <>
      <Zoomable
        src={src()}
        alt={image()?.filename}
        ar={ar()}
        zoomKey={image()?.id}
        onOpen={() => store.actions.diff.openFromFeed(imgIdx())}
        onErrorClick={() => store.state.window.retry(props.entryId)}
        onPhase={(p) => {
          if (p === "loading") store.state.window.markStarted(props.entryId);
          else if (p === "loaded") store.state.window.markLoaded(props.entryId);
          else if (p === "error") store.state.window.markError(props.entryId);
        }}
      />
      {/* the vote/comment foot: sticky to the viewport's bottom while a
          taller-than-viewport card scrolls — voting stays reachable
          without chasing the card's end (in-flow: no height added) */}
      <div class="card-foot">
        <div class="ctitle">
          <span class="ctitle-left">
            <input
              type="checkbox" class="selcb"
              checked={!!store.state.selected[image()?.id]}
              title="select for bulk actions"
              onClick={(e) => {
                e.stopPropagation();
                store.actions.selected.set(image()?.id, e.target.checked);
              }}
            />
            <span class="copyable" classList={{ copied: copiedOn() }} title={`${image()?.filename} — click to copy host#full-path`} onClick={copyName}>
              {image()?.filename}
            </span>
          </span>
          <span class="btnwrap">
            <span class={"saved" + (savedOn() ? " show" : "")}>Feedback saved</span>
            <For each={store.state.featureCardActions(image())}>
              {(a) => <IconButton icon={a.icon} variant={a.variant} title={a.title} onAction={a.onAction} />}
            </For>
            <IconButton
              icon={iconSvg("thumb-down")} variant="down" active={state().active.down}
              title="thumbs down — hides when down-vote hides is enabled"
              onAction={() => store.actions.judgments.dispatch(props.entryId, { type: "toggle", field: "vote", value: "down" })}
            />
            <IconButton
              icon={iconSvg("thumb-up")} variant="up" active={state().active.up} title="thumbs up"
              onAction={() => store.actions.judgments.dispatch(props.entryId, { type: "toggle", field: "vote", value: "up" })}
            />
            <IconButton
              icon={iconSvg("star")} variant="favorite" active={state().active.favorite}
              title="favorite — interesting in itself, not project fitness"
              onAction={() => store.actions.judgments.dispatch(props.entryId, { type: "toggle", field: "favorite" })}
            />
            <IconButton
              icon={iconSvg("bookmark")} variant="bookmark" active={state().active.bookmark}
              title="bookmark - return to this image later"
              onAction={() => store.actions.judgments.dispatch(props.entryId, { type: "toggle", field: "bookmark" })}
            />
            <IconButton
              icon={iconSvg("download")} variant="download"
              title="download this image"
              onAction={() => store.actions.images.download(image()?.id)}
            />
            <Show when={del()}>
              <IconButton
                icon={iconSvg(delCopy().icon, 16)}
                variant="delete"
                title={delCopy().cardTitle}
                onAction={() => store.actions.confirm.open({ image: image() })}
              />
            </Show>
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
