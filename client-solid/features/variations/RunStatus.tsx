import { createMemo, For, Show } from "solid-js";
import { runStatus } from "./run-status.js";

export function RunStatus(props) {
  const status = createMemo(() => runStatus(props));
  return <div class="vz-messages" role="status" aria-live="polite" aria-atomic="true" title={status().fullText}>
    <div class="vz-message-content">
      <For each={status().items}>{(item, index) => <>{index() ? "\n" : ""}<p class={item.class}>{item.text}</p></>}</For>
    </div>
    <Show when={status().retry}>
      <button type="button" class="vz-thumbnail-retry vz-catalogue-retry" onClick={props.onRetry}>Retry</button>
    </Show>
  </div>;
}
