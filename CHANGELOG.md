# Changelog

## 2026-08-16

### Feature

Header gains a filename filter input: type a substring (case-insensitive,
debounced) to work with a specific set of images; the status line shows
"N of M matching", Esc in the box clears the filter, and a new set scrolls
back to the top. Lightbox pair coupling is now an explicit always-visible
"linked" toggle (default off) instead of being implied by Shift-drag or
face-match alignment.

- Filename filter input in the header (`9eb2cc8`)
- Lightbox: explicit 'linked' toggle for pair coupling, default off (`489e624`)

### Fix

Lightbox toggles no longer hide when inapplicable — they grey out instead
(disabled styling, clicks inert), so the toolbar layout stays stable while
browsing. Toggling split-wipe before the new image's dimensions are known
now waits for the dimensions and starts the line at the image's left edge
rather than briefly parking at viewport center.

- Lightbox: toggles always visible, greyed when inapplicable; split
  edge-start waits for dims (`7b86782`)

### Refactor

The lightbox was rebuilt as a single-state module: one state object, one
`render()` that is the only DOM writer, and view state (zoom, pan, flips,
rotation) expressed in box-fraction units so it survives image switches,
flips, and rotations. No user-visible change by itself, but it enabled the
linked toggle and made every later fix cheap.

- Refactor lightbox into single-state module, fraction-unit view state (`5a94f5f`)

## 2026-08-15

### Feature

Advanced mode (hamburger menu) landed: a metadata cache with prompt/seed
badges on cards, expandable prompts, group-by-prompt view, and bucket/tag
triage controls whose values are persisted to feedback.json alongside
neg/pos/vote. The lightbox gained H/V flips, Alt+drag rotation with snap
to 0°, a split-wipe compare line, an overlay toggle, and flip buttons in
the chrome synced with the keys. Deployment is friendlier: port 2084 by
default with `KOZMOZOO_*` env overrides, `0.0.0.0` bind by default, hosts
config-driven via `config.json` with add/remove from the menu, and a
privacy-preserving batched downloads-check endpoint (no directory listing).

- Advanced mode: metadata cache, prompt expand, group-by-prompt,
  bucket/tag, ark (`2b18fbc`)
- Lightbox: H/V flips, Alt+drag rotation, split-wipe, overlay toggle (`615251c`)
- Lightbox: rotation snap to 0°, wider guide/split grab areas (`ac9dbd4`)
- Port 2084 default; `KOZMOZOO_PORT`/`DOWNLOADS`/`FEEDBACK` env overrides (`aed8bfa`)
- Add/remove hosts from the menu UI (`d334521`)
- Default bind `0.0.0.0` (`c9555a4`)
- Downloads: batched existence check, no directory listing (`6aaff3f`)
- Flip buttons in the lightbox chrome, synced with H/V keys (`321499a`)
- Flip buttons sit just above the opacity slider (`6bfbd95`)
- Lightbox: ANCHOR tag at the slider spot when viewing an anchor (`0b40df8`)

### Fix

Face detection was hardened: chunk-safe POSTs and never caching failed
detections removed the stale-box poisoning that made faceboxes vanish or
stick to wrong images, and detection now always uploads cached bytes to
the detector instead of asking it to re-read ComfyUI outputs — it works
even when ComfyUI's API is busy generating. Pair-switch view sharing was
restricted to split-wipe mode only, with the underlay tracking pan/zoom
live, and align-no-face falls back to an image recall instead of a
no-op failure.

- Fix facebox poisoning: chunk-safe POSTs, never cache failed detections (`cc74de2`)
- Detection never touches ComfyUI: candidates upload cached bytes like
  anchors (`6b4f566`)
- Pair-switch shares the view only in split-wipe mode; underlay tracks
  live (`d25cbfb`)
- Face toggles visible when detection enabled; align no-face falls back
  to recall (`79ae852`)

### Refactor

Feedback data moved to a configurable path (menu setting, `/api/config`,
default `~/Documents/kosmozoo_feedback.json`) outside the repo, bucket
names became config-driven, and internal tooling and dead gitignore
entries were dropped from the tree. No user-visible workflow change;
existing feedback files keep working via the configured path.

- Configurable feedback.json path, menu setting, `/api/config` (`325ad91`)
- Default feedback path: `~/Documents/kosmozoo_feedback.json` (`68d8690`)
- Scrub project-name refs from code; buckets now config-driven (`aed8bfa`)
- Hosts config-driven via `config.json`/`KOZMOZOO_HOSTS` (`8d20f59`)
- Drop internal tooling from the repo (`d05ba7a`)
- Drop dead gitignore entry (`2c31283`)

### Docs

The project went public-ready: LGPL-3.0-only license, a detailed README
with deployment options (direct, systemd, network), the downloads-check
endpoint documented, and a logo with favicon and social card wired into
the README and the app header.

- Add LGPL-3.0 license; gitignore `.envrc` (`db45203`)
- Detailed README with deployment options (`3d4fb7b`)
- Add project logo, social card, app favicon (`fce7070`)
- Logo size set (64/256/512): README, app header, favicon (`553fbb7`)
- README: downloads-check endpoint (no listing) (`d54e2fa`)

## 2026-08-14

### Feature

First working version: a zero-build single-page app served by a Python
stdlib server that reviews ComfyUI outputs side-by-side — chunked,
windowed candidate grid with a stable anchors pane (persisted, reorderable,
resizable), a draggable resizable splitter, keyboard-driven lightbox
navigation, thumbs/hide flows, neg/pos feedback boxes persisted to
feedback.json, save-to-downloads buttons, and copy-from-above/below to
reuse neighbor prompts. Opt-in face detection (browser model or a local
server-side anime-face worker with 28 landmarks) adds facebox overlays and
"match facebox" lightbox alignment by eye keypoints, a candidate-over-anchor
opacity slider, and linked pan. The day ended with the feedback file
downloading as an exact feedback.json, debounced saving with a visible
"saved" tick, and the app renamed to kosmozoo.

- Initial commit: image review app (`f35300b`)
- Rename app to kosmozoo (`e049eda`)
- Add opt-in face detection with lightbox facebox alignment (`bd68b93`)
- Feedback boxes: 500ms debounce + blur save, saved tick in label row (`f9b1035`)
- Replace copy/download buttons with exact feedback.json download (`9cfbf01`)
- Align faces by eye keypoints; draw box + eye dots (`5684a3b`)
- Add local anime face-detection model, server-side worker (`e1c504f`)
- Lightbox: facebox visibility toggle + candidate-over-anchor opacity
  slider (`08e4b17`)
- Lightbox: linked pan when face-matched or Shift-dragged (`9420ba8`)

### Fix

Lightbox image switching stopped visibly resetting pan/zoom (stale image
dimensions) and flickering: the incoming image is preloaded and the
outgoing one is covered during the swap. Plain scroll-wheel no longer
pans when zoomed out. Copy-from-above/below now walks to the first
neighbor that actually has feedback content, including hidden ones that
still have stored feedback.

- Fix lightbox switch resetting pan (stale img dims); scroll no longer
  pans (`f75eae4`)
- Lightbox: preload before switching images (no load flicker) (`b97fdbc`)
- Copy from above/below: hidden neighbors contribute stored feedback (`77a7cfa`)
- Lightbox: cover outgoing image during swap, kill switch blink (`0de79e8`)
- Copy from above/below walks to first neighbor with content (`8249e90`)

### Refactor

feedback.json moved out of the repository to a Documents path so curation
data stops polluting the source tree. No user-visible change beyond the
new default location.

- Move feedback.json out of the repo (`2d52eb2`)
