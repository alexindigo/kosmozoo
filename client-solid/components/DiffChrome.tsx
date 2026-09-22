// client-solid/components/DiffChrome.tsx — the workbench chrome: close (X),
// keys button, the 1–4 mode control (state display + clickable; greyed and
// inert without a pair), and per-view extras (One-Up: side indicator +
// play/pause + interval). The stage never reaches into this component, and
// this component never reaches into the stage — everything flows through
// the store's diff tree.

import { Show, For } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { iconSvg } from "/js/icons.mjs";

const MODES = [
  ["1", "two-up"],
  ["2", "one-up"],
  ["3", "split"],
  ["4", "difference"],
];

export function DiffChrome() {
  const store = useAppStore();
  const d = () => store.state.diff;
  const hasB = () => !!store.state.diffPair().b;

  return (
    <>
      <button
        id="diffClose" title="close (Esc)"
        onClick={() => store.actions.diff.close()}
        innerHTML={iconSvg("x", 16)}
      />
      {/* mode buttons — their own group, bottom-center */}
      <div id="diffModes">
        <For each={MODES}>
          {([key, m]) => (
            <button
              class={"dz-mode" + (d().mode === m ? " on" : "")}
              disabled={!hasB() || undefined}
              title={`${m} (${key})`}
              onClick={() => store.actions.diff.setMode(m)}
            >{key}</button>
          )}
        </For>
      </div>
      {/* the controls strip, bottom-left: A/B + lock always (with a pair),
 the mode-4 extras (abs/prop, opacity) join in Difference */}
      <div id="diffCtl">
        <button
          class="dz-sidebtn" title="active side — primary in every view (ArrowLeft/Right)"
          disabled={!hasB() || undefined}
          onClick={() => store.actions.diff.setCol(d().col === "feed" ? "right" : "feed")}
        >{d().col === "feed" ? "A" : "B"}</button>
        <button
          class={"dz-lockbtn" + (d().locked ? " on" : "")}
          title={d().locked ? "locked — gestures move both (l)" : "unlocked — gestures move the target (l)"}
          aria-pressed={d().locked}
          disabled={!hasB() || undefined}
          onClick={() => store.actions.diff.setLocked(!d().locked)}
          innerHTML={iconSvg(d().locked ? "lock" : "lock-open", 14)}
        />
        <Show when={hasB() && d().mode === "difference"}>
          <button
            class="dz-sidebtn" title="absolute / proportional highlight"
            onClick={() => store.actions.diff.setDiffAbs(!d().diffAbs)}
          >{d().diffAbs ? "abs" : "prop"}</button>
          <input
            type="range" class="dz-opacity" title="mask opacity"
            min="0" max="1" step="0.05" value={d().diffOpacity}
            onInput={(e) => store.actions.diff.setDiffOpacity(parseFloat(e.currentTarget.value))}
          />
        </Show>
      </div>
      <button
        id="diffKeysBtn" title="actions & keys (?)"
        onClick={() => store.actions.ui.toggleKeysPanel()}
        innerHTML={iconSvg("keyboard", 18)}
      />
    </>
  );
}
