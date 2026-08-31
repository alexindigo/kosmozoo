// client-solid/components/StatusStack.tsx — the status chips, declarative.
//
// transient: one shared chip, auto-dismissed by the store after 6s. active:
// pinned chips keyed by slot, visible for the activity's duration. error:
// sticky. ALL chips dismiss on click.

import { For } from "solid-js";
import { useAppStore } from "../store/app-store.js";

export function StatusStack() {
  const store = useAppStore();
  return (
    <div id="statusStack">
      <For each={store.state.chips}>
        {(chip) => (
          <div
            class={"statuschip" + (chip.kind === "active" ? " active" : chip.kind === "error" ? " error" : "")}
            title="click to dismiss"
            onClick={() => store.actions.status.dismiss(chip.slot)}
          >{chip.msg}</div>
        )}
      </For>
    </div>
  );
}
