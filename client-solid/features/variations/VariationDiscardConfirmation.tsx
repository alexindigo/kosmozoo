import { onMount, onCleanup } from "solid-js";
import { useAppStore } from "../../store/app-store.js";
import { SingleLineText } from "../../components/SingleLineText.js";

// Contained in the still-mounted panel, outside its inert editor subtree.
export function VariationDiscardConfirmation(props) {
  const store = useAppStore();
  let keep, discard;
  onCleanup(store.handles.own("variations.discard.cancel", props.onCancel));
  onCleanup(store.actions.keys.pushLayer({ id: "variations-discard", command: "variations.discard.cancel", blocking: true, owner: props.owner }));
  onMount(() => keep.focus());
  return <div class="vz-discard-overlay" onClick={event => event.stopPropagation()}>
    <div class="vz-discard" role="alertdialog" aria-modal="true" aria-labelledby="vz-discard-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (event.target === keep) discard.focus(); else keep.focus();
      }}>
      <h2 id="vz-discard-title"><SingleLineText value="Discard your changes?" /></h2>
      <p>{props.running ? "Already-submitted jobs will continue. Discarding stops unsent follow-ups." : "Your edits will be discarded."}</p>
      <div class="vz-discard-actions">
        <button ref={keep} class="vz-keep" onClick={props.onCancel}><SingleLineText value="Keep editing" /></button>
        <button ref={discard} class="vz-discard-confirm" onClick={props.onDiscard}><SingleLineText value="Discard changes" /></button>
      </div>
    </div>
  </div>;
}
