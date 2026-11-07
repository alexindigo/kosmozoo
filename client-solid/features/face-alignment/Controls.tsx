import { For, Show } from "solid-js";
import { TextField } from "../../components/TextField.js";
import { IconButton } from "../../components/IconButton.js";
import { iconSvg } from "/js/icons.mjs";
import { keyHint } from "../../lib/key-hint.js";

export function SettingsRow(props) {
  const p = props.ports;
  return <Show when={props.matches("face detection detector service alignment")}>
    <form class="menurow face-settings" onSubmit={e => { e.preventDefault(); props.handles.invoke("faces.settings.save"); }}>
      <label for="faceServiceUrl">Face detector service</label>
      <TextField id="faceServiceUrl" type="url" value={p.settings().draft} placeholder="http://host:port"
        onInput={e => props.handles.invoke("faces.settings.edit", { value: e.currentTarget.value })} />
      <Show when={!p.settings().pending}><button class="btn" type="submit">Save</button></Show>
      <span role="status">{p.settings().message}</span>
    </form>
  </Show>;
}

export function Controls(props) {
  const p = props.ports;
  return <Show when={p.eligible()}><div class="face-controls-slot">
        <IconButton viewer id="faceDetection" active={p.enabled()} icon={iconSvg("face-scan", 18)}
          title={keyHint(p.bindings(), `Face detection: ${p.enabled() ? "on" : "off"}`, "faces.detection.toggle")}
          onAction={() => props.handles.invoke("faces.detection.toggle")} />
        <Show when={p.enabled()}>
        <span class="face-status" role="status" data-phase={p.status().phase}>{p.status().message}</span>
        <Show when={p.status().phase === "error" || p.status().retry}><button class="btn" onClick={() => props.handles.invoke("faces.retry")}>Retry detection</button></Show>
        <For each={["a", "b"]}>{side => <Show when={p.acceptedRecord(side)}>{record =>
          <span class="face-choices viewer-group" aria-label={`Image ${side.toUpperCase()} faces`}>
            <For each={record().faces}>{(face, index) => <button class="viewer-btn face-choice"
              classList={{ "is-anchor": record().anchor === face.id }} aria-pressed={record().anchor === face.id}
              title={`Use face ${index() + 1} on image ${side.toUpperCase()} for alignment`}
              onClick={() => props.handles.invoke("faces.use", { side, record: record().id, face: face.id })}>
              {side.toUpperCase()}{index() + 1}
            </button>}</For>
          </span>
        }</Show>}</For>
        </Show>
  </div></Show>;
}
