// plugins/difference/plugin.mjs — server half of the difference plugin.
// Client-only in behaviour (the blending is CSS in the browser); the server
// half only announces the composition mode so /api/plugins advertises it and
// the client host loads the client half.

export function register(kz) {
  kz.mode("difference", {
    label: "Difference",
    // blink finds *where* something changed; difference confirms *what*.
    hint: "Overlay the candidate on the anchor with per-pixel difference",
  });
}
