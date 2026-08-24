// client/app/components/NoteBox.mjs — one notes box (neg or pos): a textarea
// that autosaves (debounced) and saves on blur, plus copy-from-neighbor.
// The box owns its own editing; the parent supplies onSave(text) and
// getNeighborText(dir).

import { h } from "../../vendor/preact/vendor.mjs";
import { useRef, useEffect } from "../../vendor/preact/vendor.mjs";

export function NoteBox({ sign, placeholder, initialValue, onSave, getNeighborText }) {
  const taRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flush = () => {
    clearTimeout(timerRef.current);
    timerRef.current = null;
    onSave(taRef.current?.value ?? "");
  };
  const schedule = () => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 500);
  };
  const copyFrom = (dir) => {
    const text = getNeighborText(dir);
    if (text && taRef.current) {
      taRef.current.value = text;
      schedule();
    }
  };

  return h("div", { class: "boxcol" },
    h("textarea", {
      class: sign,
      placeholder,
      defaultValue: initialValue,
      ref: taRef,
      onInput: schedule,
      onBlur: flush,
    }),
    h("div", { class: "btnrow" },
      h("button", { onClick: () => copyFrom(1) }, "copy from below"),
      h("button", { onClick: () => copyFrom(-1) }, "copy from above"),
    ),
  );
}
