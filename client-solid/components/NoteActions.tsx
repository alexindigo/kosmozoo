// The live note and sizing probe share the same intrinsic copy-row allocation.
export function NoteActions(props) {
  return (
    <div class="note-actions" classList={{ "is-saved": !!props.saved, negative: props.sign === "neg", positive: props.sign === "pos" }}>
      <div class="btnrow" aria-hidden={props.saved ? "true" : undefined}>
        <button type="button" tabindex={props.tabindex} onClick={() => props.onCopy?.(1)}>copy from below</button>
        <button type="button" tabindex={props.tabindex} onClick={() => props.onCopy?.(-1)}>copy from above</button>
      </div>
      <span class="note-save-status" role="status" aria-live="polite">{props.saved ? "Feedback saved" : ""}</span>
    </div>
  );
}
