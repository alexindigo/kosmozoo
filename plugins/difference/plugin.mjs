// plugins/difference/plugin.mjs — declares the difference composition mode
// for /api/plugins. The SPA has no consumer for this capability today.

export function register(kz) {
  kz.mode("difference", {
    label: "Difference",
    // blink finds *where* something changed; difference confirms *what*.
    hint: "Overlay the candidate on the anchor with per-pixel difference",
  });
}
