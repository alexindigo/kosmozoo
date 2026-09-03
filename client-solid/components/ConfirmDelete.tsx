// client-solid/components/ConfirmDelete.tsx — the delete confirmation.
//
// store.state.confirmDelete = { image } (card) or { images } (bulk bar) opens
// it. The host's deleteMode decides what the action means, and the wording
// says exactly what will happen:
//   trash  — assets_plus trash on the Comfy host (recoverable)
//   unlink — permanent removal from a folder host
//   hide   — the files stay on the host; the images are hidden from kosmozoo

import { createSignal, Show } from "solid-js";
import { useAppStore } from "../store/app-store.js";
import { Modal } from "./Modal.js";

const COPY = {
  trash: {
    title: () => "Move to trash",
    confirm: "Move to trash",
    body: (n, f, host) => n > 1
      ? `Move ${n} images to the trash on ${host}? Recoverable from the host's trash.`
      : `Move “${f}” to the trash on ${host}? Recoverable from the host's trash.`,
  },
  unlink: {
    title: () => "Delete file",
    confirm: "Delete forever",
    body: (n, f, host) => n > 1
      ? `Permanently delete ${n} images from ${host}? This cannot be undone.`
      : `Permanently delete “${f}” from ${host}? This cannot be undone.`,
  },
  hide: {
    title: () => "Hide image",
    confirm: "Hide",
    body: (n, f, host) => n > 1
      ? `${host} can't delete files. Hide ${n} images from kosmozoo and clear their Comfy history entries? The files themselves stay on ${host}.`
      : `${host} can't delete files. Hide “${f}” from kosmozoo and clear its Comfy history entry? The file itself stays on ${host}.`,
  },
};

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

  const mode = () => store.state.hosts[images()[0]?.host]?.deleteMode ?? "hide";
  const copy = () => COPY[mode()] ?? COPY.hide;

  return (
    <Show when={n() > 0}>
      <Modal overlayId="confirmOverlay" panelId="confirmPanel" open onClose={close}>
        <div class="confirm-title">{copy().title()}</div>
        <div class="confirm-body">{copy().body(n(), images()[0].filename, images()[0].host)}</div>
        <div class="confirm-actions">
          <button class="confirm-cancel" onClick={close} disabled={busy() || undefined}>Cancel</button>
          <button
            class={"confirm-ok " + mode()}
            onClick={confirm}
            disabled={busy() || undefined}
          >{busy() ? "Working…" : copy().confirm}</button>
        </div>
      </Modal>
    </Show>
  );
}
