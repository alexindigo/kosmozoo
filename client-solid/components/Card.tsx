// client-solid/components/Card.tsx — the CANDIDATE image card, declarative.
//
// Composes <Zoomable> (image box), the title row (filename + icon-button
// actions + save), and the notes pair (<NoteBox>). Full metadata lives in
// the details pane — the card carries no meta section. Judgment lives in
// the store's images tree (the source of truth); vote/favorite are
// path-level updates the card's bindings follow by construction.

import { createSignal, createEffect, onMount } from "solid-js";
import { For, Show } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { Zoomable } from "./Zoomable.js";
import { IconButton } from "./IconButton.js";
import { NoteBox } from "./NoteBox.js";

export function Card(props) {
  const store = useAppStore();
  const image = () => store.state.images[props.imgIdx()];
  const meta = () => image()?.meta ?? null;
  const j = () => image()?.judgment ?? {};

  // the box's aspect is DATA — the store's resolved size (meta, else the
  // off-DOM loader's natural measurement), never the in-card img's load.
  // An unknown size renders the 16:9 floor placeholder; the img inserts
  // only once the size is known (off-card resolution keeps it out of view
  // until then)
  const sizeInfo = () => store.state.cardSize(props.imgIdx());
  const ar = () => {
    const s = sizeInfo();
    return s ? `${s.w} / ${s.h}` : null;
  };
  const src = () => {
    const img = image();
    if (!img) return null;
    // the card is only MOUNTED at known size (§3.5) — the img's src follows
    // the window's range membership; broken bytes take the in-card error path
    return store.state.window.getSrc(props.imgIdx(), img);
  };
  const [flash, setFlash] = createSignal(false);

  onMount(() => {
    if (image()?.size == null) store.actions.images.fillSize(image().id);
  });

  const flashSaved = () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 1200);
  };

  const saveNote = (cls) => (text) => {
    const notes = { ...(image()?.judgment?.notes ?? {}), [cls]: text };
    store.actions.judgments.saveNotes(image(), notes).then(() => flashSaved());
  };

  // First neighbor WITH CONTENT in that direction; an unsaved draft wins
  // over the saved judgment note (it may hold newer edits).
  const neighborText = (cls) => (dir) => {
    const images = store.state.images;
    for (let i = props.imgIdx() + dir; i >= 0 && i < images.length; i += dir) {
      const im = images[i];
      const text = store.state.drafts[`${im?.id}:${cls}`] ?? im?.judgment?.notes?.[cls] ?? "";
      if (text) return text;
    }
    return "";
  };

  const copyName = (e) => {
    e.stopPropagation();
    const el = e.currentTarget;
    const im = image();
    const pfx = im.host + "#";
    navigator.clipboard?.writeText(im.filename.startsWith(pfx) ? im.filename : pfx + im.filename)
      .then(() => {
        el.classList.add("copied");
        setTimeout(() => el.classList.remove("copied"), 800);
      })
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
        onOpen={() => store.actions.diff.openFromFeed(props.imgIdx())}
        onErrorClick={() => store.state.window.retry(props.imgIdx())}
        onPhase={(p) => {
          if (p === "loaded") store.state.window.markLoaded(props.imgIdx());
          else if (p === "error") store.state.window.markError(props.imgIdx());
        }}
      />
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
          <span class="copyable" title="click to copy host#filename" onClick={copyName}>
            {image()?.filename}
          </span>
        </span>
        <span class="btnwrap">
          <span class={"saved" + (flash() ? " show" : "")}>Feedback saved</span>
          <For each={store.state.featureCardActions(image())}>
            {(a) => <IconButton icon={a.icon} variant={a.variant} title={a.title} onAction={a.onAction} />}
          </For>
          <IconButton
            icon={iconSvg("thumb-down")} variant="down" active={j().vote === "down"}
            title="thumbs down — hides (Unhide up top restores)"
            onAction={() => store.actions.judgments.setVote(image(), "down")}
          />
          <IconButton
            icon={iconSvg("thumb-up")} variant="up" active={j().vote === "up"} title="thumbs up"
            onAction={() => store.actions.judgments.setVote(image(), j().vote === "up" ? null : "up")}
          />
          <IconButton
            icon={iconSvg("star")} variant="favorite" active={!!j().favorite}
            title="favorite — interesting in itself, not project fitness"
            onAction={() => store.actions.judgments.toggleFavorite(image())}
          />
          <button
            class="savebtn"
            title="download this image"
            onClick={(e) => { e.stopPropagation(); store.actions.images.download(image()?.id); }}
          >save</button>
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
          initialValue={() => image()?.judgment?.notes?.neg ?? ""}
          onSave={saveNote("neg")} getNeighborText={neighborText("neg")}
        />
        <NoteBox
          sign="pos" placeholder="positives…" noteId={image()?.id}
          initialValue={() => image()?.judgment?.notes?.pos ?? ""}
          onSave={saveNote("pos")} getNeighborText={neighborText("pos")}
        />
      </div>
    </>
  );
}
