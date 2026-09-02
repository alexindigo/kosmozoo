// client-solid/components/Card.tsx — the CANDIDATE image card, declarative.
//
// Composes <Zoomable> (image box), the title row (filename + icon-button
// actions + save), the notes pair (<NoteBox>), and the <MetaBar>. Judgment
// lives in the store's images tree (the source of truth); vote/favorite are
// path-level updates the card's bindings follow by construction.

import { createSignal, createEffect, onMount } from "solid-js";
import { Show } from "solid-js/web";
import { iconSvg } from "/js/icons.mjs";
import { useAppStore } from "../store/app-store.js";
import { metaStripText } from "../store/fields.js";
import { Zoomable } from "./Zoomable.js";
import { IconButton } from "./IconButton.js";
import { MetaBar } from "./MetaBar.js";
import { NoteBox } from "./NoteBox.js";

function aspectFromMeta(meta) {
  return meta?.width && meta?.height ? `${meta.width} / ${meta.height}` : null;
}

export function Card(props) {
  const store = useAppStore();
  const image = () => store.state.images[props.imgIdx()];
  const meta = () => image()?.meta ?? null;
  const j = () => image()?.judgment ?? {};

  // aspect: metadata until the image itself reports its natural size
  const [loadedAr, setLoadedAr] = createSignal(null);
  const ar = () => loadedAr() ?? aspectFromMeta(meta());
  const [expanded, setExpanded] = createSignal(false);
  const [flash, setFlash] = createSignal(false);

  onMount(() => {
    if (image()?.size == null) store.actions.images.fillSize(image().id);
  });

  const stripText = () => meta()
    ? metaStripText(meta(), { list: store.state.fieldsList(), cfg: store.state.fieldsCfg() })
    : "";

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

  const saved = () => {
    const im = image();
    if (!im) return false;
    const pfx = im.host + "#";
    const prefixed = im.filename.startsWith(pfx) ? im.filename : pfx + im.filename;
    return !!(store.state.saved[im.filename] || store.state.saved[prefixed]);
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

  const deleteMode = () => store.state.hosts[image()?.host]?.deleteMode;

  return (
    <>
      <Zoomable
        src={store.state.window.getSrc(props.imgIdx(), image()?.id)}
        alt={image()?.filename}
        ar={ar}
        stripText={stripText()}
        zoomKey={image()?.id}
        onLoaded={(w, hp) => setLoadedAr(`${w} / ${hp}`)}
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
          <IconButton
            icon={iconSvg("wand", 16)} variant="variations" title="generate variations"
            onAction={() => store.actions.variations.open(image())}
          />
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
            title={saved() ? "already in ~/Downloads (click to download again)" : "download this image"}
            onClick={(e) => { e.stopPropagation(); store.actions.images.download(image()?.id); }}
          >{saved() ? "saved" : "save"}</button>
          <Show when={deleteMode()}>
            <IconButton
              icon={iconSvg(deleteMode() === "hide" ? "eye-off" : "trash", 16)}
              variant="delete"
              title={deleteMode() === "trash"
                ? "move to trash on the host (recoverable)"
                : deleteMode() === "unlink"
                  ? "delete the file from the host folder (permanent)"
                  : "hide from kosmozoo (this host can't delete files)"}
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
      <MetaBar
        facts={{ w: meta()?.width ?? null, h: meta()?.height ?? null, bytes: image()?.size ?? null }}
        meta={image()?.meta ?? null}
        expanded={expanded()}
        onToggle={() => setExpanded(!expanded())}
      />
    </>
  );
}
