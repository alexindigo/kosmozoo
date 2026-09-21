// client/js/no-page-zoom.mjs — the PAGE never zooms. Browser zoom (ctrl+wheel,
// ctrl +/-/0, trackpad pinch) is disabled app-wide; image zoom stays the app's
// own (js/zoomable.mjs on cards, info-panel images, the workbench stage).
//
// ctrl+wheel is BOTH the browser's zoom shortcut AND the app's image-zoom
// gesture (a trackpad pinch arrives as ctrl+wheel): preventing default at the
// window disables the browser half everywhere, while the image's own handler
// still runs — preventDefault is not stopPropagation — and zooms the image.

export function installNoPageZoom() {
  window.addEventListener("wheel", (e) => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false, capture: true });

  // keyboard zoom: ctrl/cmd with +/-/0 (+ arrives as "=" or shifted "+").
  // The app's keys dispatcher ignores modified keys, so nothing app-side
  // is shadowed.
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (["=", "-", "+", "0"].includes(e.key)) e.preventDefault();
  });

  // Safari's pinch gesture events
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
}
