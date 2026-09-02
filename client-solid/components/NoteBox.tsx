// client-solid/components/NoteBox.tsx — one notes box (neg or pos): a
// textarea that autosaves (debounced) and saves on blur, plus
// copy-from-neighbor. Unsaved text mirrors into the store's drafts map
// (session-only) so neighbors read it without DOM walks; the box owns its
// own editing; the parent supplies onSave(text) and getNeighborText(dir).

import { onCleanup, createEffect, untrack } from "solid-js";
import { useAppStore } from "../store/app-store.js";

export function NoteBox(props) {
  const store = useAppStore();
  let taEl;
  let timer = null;

  const key = () => `${props.noteId}:${props.sign}`;

  onCleanup(() => clearTimeout(timer));

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    store.actions.notes.clearDraft(props.noteId, props.sign);
    props.onSave(taEl?.value ?? "");
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const onInput = () => {
    store.actions.notes.setDraft(props.noteId, props.sign, taEl?.value ?? "");
    schedule();
  };
  const copyFrom = (dir) => {
    const text = props.getNeighborText(dir);
    if (text && taEl) {
      taEl.value = text;
      onInput();
    }
  };

  // initial value per image: unsaved draft first, then the judgment note.
  // Re-applies when the card slot retargets to a different image (virtual
  // reuse); untracked reads keep typing from being clobbered mid-edit.
  createEffect(() => {
    props.noteId;
    const v = untrack(() =>
      store.state.drafts[key()]
      ?? (typeof props.initialValue === "function" ? props.initialValue() : (props.initialValue ?? ""))
    );
    if (taEl && taEl.value !== v) taEl.value = v;
  });

  return (
    <div class="boxcol">
      <textarea
        class={props.sign}
        placeholder={props.placeholder}
        ref={taEl}
        onInput={onInput}
        onBlur={flush}
      />
      <div class="btnrow">
        <button onClick={() => copyFrom(1)}>copy from below</button>
        <button onClick={() => copyFrom(-1)}>copy from above</button>
      </div>
    </div>
  );
}
