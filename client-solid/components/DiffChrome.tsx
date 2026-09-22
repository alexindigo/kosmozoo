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
  ["1", "two-up", "Two-Up", "view-two-up"],
  ["2", "one-up", "One-Up", "view-one-up"],
  ["3", "split", "Split", "view-split"],
  ["4", "difference", "Difference", "view-difference"],
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
      {/* ONE bottom panel holding all the buttons: controls at the left,
 the 1–4 modes centered, the keys button at the right */}
      <div id="diffBar">
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
          <input
            type="range" class="dz-opacity dz-active-op" title="active image opacity"
            min="0" max="1" step="0.05" value={d().activeOpacity}
            disabled={!hasB() || undefined}
            onInput={(e) => store.actions.diff.setActiveOpacity(parseFloat(e.currentTarget.value))}
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
        <div id="diffModes" class="dz-seg">
          <For each={MODES}>
            {([key, m, label, icon]) => (
              <button
                class={"dz-segbtn" + (d().mode === m ? " on" : "")}
                disabled={!hasB() || undefined}
                title={`${label} (${key})`}
                onClick={() => store.actions.diff.setMode(m)}
              >
                <span class="dz-segicon" innerHTML={iconSvg(icon, 14)} />
                {label}
              </button>
            )}
          </For>
        </div>
        <button
          id="diffKeysBtn" title="actions & keys (?)"
          onClick={() => store.actions.ui.toggleKeysPanel()}
          innerHTML={iconSvg("keyboard", 18)}
        />
      </div>
    </>
  );
}
