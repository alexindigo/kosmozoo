// client-solid/components/NoteBox.tsx — one notes box (neg or pos): a
// textarea that autosaves (debounced) and saves on blur, plus
// copy-from-neighbor. The box owns its own editing; the parent supplies
// onSave(text) and getNeighborText(dir).

import { onCleanup } from "solid-js";

export function NoteBox(props) {
  let taEl;
  let timer = null;

  onCleanup(() => clearTimeout(timer));

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    props.onSave(taEl?.value ?? "");
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  };
  const copyFrom = (dir) => {
    const text = props.getNeighborText(dir);
    if (text && taEl) {
      taEl.value = text;
      schedule();
    }
  };

  return (
    <div class="boxcol">
      <textarea
        class={props.sign}
        placeholder={props.placeholder}
        ref={(el) => {
          taEl = el;
          el.value = typeof props.initialValue === "function" ? props.initialValue() : (props.initialValue ?? "");
        }}
        onInput={schedule}
        onBlur={flush}
      />
      <div class="btnrow">
        <button onClick={() => copyFrom(1)}>copy from below</button>
        <button onClick={() => copyFrom(-1)}>copy from above</button>
      </div>
    </div>
  );
}
