// client-solid/components/StatusStack.tsx - the status chips, declarative.
//
// transient: one shared chip, auto-dismissed by the store after 6s. active:
// pinned chips keyed by slot, visible for the activity's duration. error:
// sticky. Ordinary chips dismiss on click; observed conditions clear at source.

import { For, Show, onCleanup } from "solid-js";
import { useAppStore } from "../store/app-store.js";

function StatusChip(props) {
  return (
    <div
      class="statuschip"
      ref={element => { const retire=props.registerOccluder?.(element); if(retire)onCleanup(retire); }}
      classList={{ active: props.kind === "active", error: props.kind === "error", warning: props.kind === "warning", "statuschip-static": !props.onDismiss }}
      title={props.onDismiss ? "click to dismiss" : undefined}
      onClick={props.onDismiss}
      role={props.role}
    >{props.msg}</div>
  );
}

export function StatusStack() {
  const store = useAppStore();
  return (
    <div id="statusStack">
      <For each={store.state.chips}>
        {(chip) => (
          <StatusChip kind={chip.kind} msg={chip.msg} onDismiss={() => store.actions.status.dismiss(chip.slot)} registerOccluder={store.actions.feed.occluder} />
        )}
      </For>
      <Show when={store.state.nativeMagnification()}>
        <StatusChip kind="warning" role="status" msg="Browser magnification active. Reset with Ctrl+L, Ctrl+0, Esc." registerOccluder={store.actions.feed.occluder} />
      </Show>
    </div>
  );
}
