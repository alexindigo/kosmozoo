// client-solid/lib/delete-copy.js — the ONE delete-copy table : the
// card's delete button, the bulk bar's, and the confirmation modal all say
// what the collection's delete capability does, in the same words. `mode` is
// capabilities.delete: "trash" | "unlink" | "hide" (anything else reads as
// hide — a host that can't delete only hides).

export function deleteCopy(mode) {
  switch (mode) {
    case "trash":
      return {
        mode: "trash",
        icon: "trash",
        cardTitle: "move to trash on the host (recoverable)",
        bulkTitle: "move all selected to trash on the host (recoverable)",
        title: "Move to trash",
        confirm: "Move to trash",
        body: (n, f, host) => n > 1
          ? `Move ${n} images to the trash on ${host}? Recoverable from the host's trash.`
          : `Move “${f}” to the trash on ${host}? Recoverable from the host's trash.`,
      };
    case "unlink":
      return {
        mode: "unlink",
        icon: "trash",
        cardTitle: "delete the file from the host folder (permanent)",
        bulkTitle: "delete all selected files from the host folder (permanent)",
        title: "Delete file",
        confirm: "Delete forever",
        body: (n, f, host) => n > 1
          ? `Permanently delete ${n} images from ${host}? This cannot be undone.`
          : `Permanently delete “${f}” from ${host}? This cannot be undone.`,
      };
    default:
      return {
        mode: "hide",
        icon: "eye-off",
        cardTitle: "hide from kosmozoo (this host can't delete files)",
        bulkTitle: "hide all selected from kosmozoo (this host can't delete files)",
        title: "Hide image",
        confirm: "Hide",
        body: (n, f, host) => n > 1
          ? `${host} can't delete files. Hide ${n} images from kosmozoo and clear their Comfy history entries? The files themselves stay on ${host}.`
          : `${host} can't delete files. Hide “${f}” from kosmozoo and clear its Comfy history entry? The file itself stays on ${host}.`,
      };
  }
}
