// plugins/difference/client.js — the difference composition mode.
//
// mix-blend-mode: difference blends the candidate against the anchor
// underlay. SPIKE NOTE (plan open question 3): the outgoing structure wraps
// the candidate in a clip-path element for split-wipe, and clip-path may
// establish a blend-isolation boundary — the mode must NOT be applied to an
// element that also carries a clip-path. Here the difference layer is the
// candidate image itself, so the isolation question is settled by placing
// the blend on the image element, not on a clip wrapper.

export function register(client) {
  client.composition("difference", {
    // Apply: candidate sits over the anchor with per-pixel difference.
    // Identical pair -> near-black (verified by the dogfood check).
    apply(candidateEl, anchorEl) {
      anchorEl.style.opacity = "1";
      candidateEl.style.opacity = "1";
      candidateEl.style.mixBlendMode = "difference";
      candidateEl.style.clipPath = "none"; // never blend through a clip boundary
    },
    clear(candidateEl, anchorEl) {
      candidateEl.style.mixBlendMode = "";
      anchorEl.style.opacity = "";
    },
    // Optional amplification of faint differences (follow-on).
    amplify(candidateEl, factor = 4) {
      candidateEl.style.filter = `brightness(${factor}) contrast(${factor})`;
    },
  });
}
