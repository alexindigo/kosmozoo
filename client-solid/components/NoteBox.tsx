// client-solid/components/NoteBox.tsx — one notes box (neg or pos): a
// CONTROLLED textarea whose value is the store's draft mirror (session-only)
// falling back to the judgment note. Typing writes the draft; the store's
// notes.setDraft owns the debounced autosave (G11 — no component-owned
// timer); blur flushes. Copy-from-neighbor writes through the store like a
// typed edit — no DOM value writes, no hand-called onInput. The parent
// supplies onSave(text) (returning its promise) and getNeighborText(dir).

import { useAppStore } from "../store/app-store.js";

export function NoteBox(props) {
  const store = useAppStore();

  const key = () => `${props.noteId}:${props.sign}`;
  // unsaved draft first, then the judgment note
  const text = () => store.state.drafts[key()] ?? props.initialValue ?? "";

  const onInput = (e) =>
    store.actions.notes.setDraft(props.noteId, props.sign, e.target.value, props.onSave);
  const onBlur = () =>
    store.actions.notes.flushDraft(props.noteId, props.sign, props.onSave);
  const copyFrom = (dir) => {
    const t = props.getNeighborText(dir);
    if (t) store.actions.notes.setDraft(props.noteId, props.sign, t, props.onSave);
  };

  return (
    <div class="boxcol">
      <textarea
        class={props.sign}
        placeholder={props.placeholder}
        value={text()}
        onInput={onInput}
        onBlur={onBlur}
      />
      <div class="btnrow">
        <button onClick={() => copyFrom(1)}>copy from below</button>
        <button onClick={() => copyFrom(-1)}>copy from above</button>
      </div>
    </div>
  );
}
