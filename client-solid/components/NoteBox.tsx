// client-solid/components/NoteBox.tsx — one notes box (neg or pos): a
// CONTROLLED textarea whose value is the store's draft mirror (session-only)
// falling back to the judgment note. Typing writes the draft; the store's
// notes.setDraft owns the debounced autosave ( — no component-owned
// timer); blur flushes. Copy-from-neighbor writes through the store like a
// typed edit — no DOM value writes, no hand-called onInput. The parent
// supplies onSave(text) (returning its promise) and getNeighborText(dir).

import { createEffect, createSignal, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { flash } from "../lib/flash.js";
import { TextField } from "./TextField.js";
import { NoteActions } from "./NoteActions.js";

export function NoteBox(props) {
  const store = useAppStore();

  const key = () => `${props.noteId}:${props.sign}`;
  // unsaved draft first, then the judgment note
  const text = () => store.state.drafts[key()] ?? props.initialValue ?? "";

  const [saved, setSaved] = createSignal(false);
  let alive = true, revision = 0;
  const flashSaved = flash(value => { if (alive) setSaved(value); });
  onCleanup(() => { alive = false; });
  const clearSaved = () => { revision++; setSaved(false); };
  createEffect(() => { key(); clearSaved(); });
  // This observes the injected save result only. Store still owns drafts,
  // autosave, blur flushing and persistence, including after this field retires.
  const save = () => {
    const id = props.noteId, sign = props.sign, version = revision, onSave = props.onSave;
    return (value, originId) => Promise.resolve(onSave(value, originId)).then(result => {
      if (result?.ok && alive && originId === id && props.noteId === id && props.sign === sign &&
          version === revision && text() === value) flashSaved();
      return result;
    });
  };
  const onInput = (e) => {
    clearSaved();
    store.actions.notes.setDraft(props.noteId, props.sign, e.target.value, save());
  };
  const onBlur = () =>
    store.actions.notes.flushDraft(props.noteId, props.sign, save());
  const copyFrom = (dir) => {
    clearSaved();
    const t = props.getNeighborText(dir);
    if (t) store.actions.notes.setDraft(props.noteId, props.sign, t, save());
  };

  return (
    <div class="boxcol">
      <TextField multiline tone={props.sign === "neg" ? "negative" : "positive"}
        class={props.sign}
        aria-label={props.sign === "neg" ? "Negative feedback" : "Positive feedback"}
        placeholder={props.placeholder}
        value={text()}
        onInput={onInput}
        onBlur={onBlur}
      />
      <NoteActions sign={props.sign} saved={saved()} onCopy={copyFrom} />
    </div>
  );
}
