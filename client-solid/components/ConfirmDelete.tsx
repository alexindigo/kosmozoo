// client-solid/components/ConfirmDelete.tsx — the delete confirmation.
//
// store.state.confirmDelete = { image } (card) or { images } (bulk bar) opens
// it. The collection's capabilities.delete decides what the action means,
// and the shared delete-copy table (lib/delete-copy.js — the card and bulk
// bar buttons read the same one) says exactly what will happen:
// trash — assets_plus trash on the Comfy host (recoverable)
// unlink — permanent removal from a folder host
// hide — the files stay on the host; the images are hidden from kosmozoo

import { createSignal, createEffect, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { Modal } from "./Modal.js";
import { SingleLineText } from "./SingleLineText.js";

export function ConfirmDelete() {
  const store = useAppStore();
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const images = () => {
    const r = store.state.confirmDelete();
    return r ? (r.images ?? (r.image ? [r.image] : [])) : [];
  };
  const n = () => images().length;

  const close = () => {
    store.handles.invoke("image.delete.cancel");
    setBusy(false);
  };

  const confirm = async () => {
    if (busy()) return;
    setBusy(true);
    setMessage("");
    const ok = await store.handles.invoke("image.delete.confirm");
    if (ok) close();
    else { setMessage("Could not delete the images. Try again."); setBusy(false); }
  };

  // the loaded collection's record answers the mode — never the first
  // image's host (a mixed-host bulk selection would mislabel the action)
  const mode = () => store.state.currentCollection()?.capabilities?.delete ?? "hide";
  const copy = () => deleteCopy(mode());
  createEffect(() => { if (!store.state.confirmDelete()) { setBusy(false); setMessage(""); } });

  return (
    <Show when={n() > 0}>
      <Modal overlayId="confirmOverlay" panelId="confirmPanel" closeCommand="image.delete.cancel">
        <div class="confirm-title">{copy().title}</div>
        <div class="confirm-body">{copy().body(n(), images()[0].filename, images()[0].host)}</div>
        <div class="confirm-actions">
          <Show when={!busy()} fallback={<SingleLineText role="status" value={`Deleting ${n()} ${n() === 1 ? "image" : "images"}…`} />}>
          <button class="confirm-cancel" onClick={close}>Cancel</button>
          <button
            class={"confirm-ok " + copy().mode}
            onClick={confirm}
          >{copy().confirm}</button>
          </Show>
        </div>
        <Show when={message()}><p class="confirm-error" role="status">{message()}</p></Show>
      </Modal>
    </Show>
  );
}
