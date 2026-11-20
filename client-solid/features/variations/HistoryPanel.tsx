import { onMount, onCleanup, For, Show } from "solid-js";
import { HistoryEntry } from "./HistoryEntry.js";
import { ProblemFeedback } from "./ProblemFeedback.js";

export function HistoryList(props) {
  return <>
    <For each={props.state().items}>{entry => <HistoryEntry entry={entry} compact={props.compact} targets={props.targets}
      thumbnail={props.thumbnail} registerThumbnail={props.registerThumbnail} registerPopup={props.registerPopup} registerEditor={props.registerEditor}
      onRecall={() => props.onRecall(entry.id)} onInspect={() => props.history.detail(entry.id)}
      onDelete={props.deletable ? () => props.history.remove(entry.id) : null} deleting={props.state().deleting.has(entry.id)} />}</For>
    <Show when={props.state().pending}><p class="vh-status" role="status">Reading history...</p></Show>
    <Show when={props.state().error}><p class="vh-error" role="status">{props.state().error} <Show when={props.state().listError}><button onClick={() => props.history.refresh()}>Retry</button></Show></p></Show>
    <ProblemFeedback problems={(props.state().problems ?? []).filter(problem => problem.code !== "history-cleanup")} />
    <Show when={props.state().pendingCleanup}><button class="vh-more" onClick={() => props.history.retryCleanup()}>Retry resource cleanup</button></Show>
    <Show when={props.state().loaded && !props.state().items.length && !props.state().pending}><p class="vh-status">No runs yet. Each Run is saved automatically.</p></Show>
    <Show when={props.state().more && !props.state().pending}><button class="vh-more" onClick={() => props.history.more()}>More runs</button></Show>
  </>;
}
export function HistoryPanel(props) {
  onMount(() => onCleanup(props.ports.history.interest()));
  return <section class="vh-panel"><h2>Variations history</h2>
    <HistoryList history={props.ports.history} state={props.ports.state} targets deletable
      thumbnail={props.ports.thumbnail} registerThumbnail={props.ports.registerThumbnail} onRecall={props.ports.recall} />
  </section>;
}
