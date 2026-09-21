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
      <Show when={hasB() && d().mode === "one-up"}>
        <div id="diffPlay">
          <button
            class="dz-sidebtn" title="which side is showing (ArrowLeft/Right)"
            onClick={() => store.actions.diff.setCol(d().col === "feed" ? "right" : "feed")}
          >{d().col === "feed" ? "A" : "B"}</button>
          <button
            class="dz-playbtn" title="auto-play blink (Space)"
            onClick={() => store.actions.diff.togglePlay()}
            innerHTML={iconSvg(d().playing ? "player-pause" : "player-play", 14)}
          />
          <input
            type="number" class="dz-interval" title="blink interval, ms"
            value={d().intervalMs} min="50" step="50"
            onChange={(e) => store.actions.diff.setIntervalMs(parseInt(e.target.value, 10) || d().intervalMs)}
          />
        </div>
      </Show>
      <button
        id="diffKeysBtn" title="actions & keys (?)"
        onClick={() => store.actions.ui.toggleKeysPanel()}
        innerHTML={iconSvg("keyboard", 18)}
      />
    </>
  );
}
