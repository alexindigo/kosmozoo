// client-solid/components/ConfirmDelete.tsx — the delete confirmation.
//
// store.state.confirmDelete = { image } (card) or { images } (bulk bar) opens
// it. The collection's capabilities.delete decides what the action means,
// and the shared delete-copy table (lib/delete-copy.js — the card and bulk
// bar buttons read the same one) says exactly what will happen:
//   trash  — assets_plus trash on the Comfy host (recoverable)
//   unlink — permanent removal from a folder host
//   hide   — the files stay on the host; the images are hidden from kosmozoo

import { createSignal, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { deleteCopy } from "../lib/delete-copy.js";
import { Modal } from "./Modal.js";

export function ConfirmDelete() {
  const store = useAppStore();
  const [busy, setBusy] = createSignal(false);
  const images = () => {
    const r = store.state.confirmDelete();
    return r ? (r.images ?? (r.image ? [r.image] : [])) : [];
  };
  const n = () => images().length;

  const close = () => {
    store.actions.confirm.close();
    setBusy(false);
  };

  // Esc comes from the Modal (capture phase — it outranks what's under it)

  const confirm = async () => {
    if (busy()) return;
    setBusy(true);
    const ok = await store.actions.images.delete(images());
    if (ok) close();
    else setBusy(false); // nothing succeeded — stay open
  };

  const mode = () => store.state.hosts[images()[0]?.host]?.capabilities?.delete ?? "hide";
  const copy = () => deleteCopy(mode());

  return (
    <Show when={n() > 0}>
      <Modal overlayId="confirmOverlay" panelId="confirmPanel" open onClose={close}>
        <div class="confirm-title">{copy().title}</div>
        <div class="confirm-body">{copy().body(n(), images()[0].filename, images()[0].host)}</div>
        <div class="confirm-actions">
          <button class="confirm-cancel" onClick={close} disabled={busy() || undefined}>Cancel</button>
          <button
            class={"confirm-ok " + copy().mode}
            onClick={confirm}
            disabled={busy() || undefined}
          >{busy() ? "Working…" : copy().confirm}</button>
        </div>
      </Modal>
    </Show>
  );
}
