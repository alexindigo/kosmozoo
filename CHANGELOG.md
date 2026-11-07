# Changelog

## 0.4.0 - 2026-11-07

Still-image comparisons can detect faces, select which boxes to show and choose
an alignment face on each image. Independent, Shared and Face-anchored alignment
share one selector; `a` cycles alignment and `l` retains shared movement. Face
anchors align eye midpoints and scale with a shared camera, without rotation or
identity recognition. Multiple faces require an explicit anchor choice.

Detection is optional, requires an externally configured detector service and
starts OFF on every page load. Its separate toggle retains choices while off;
choosing Face-anchored does not enable detection. Detection and displayed pixels
stay bound to the accepted image content, including delayed or failed swaps.

Viewer opacity controls appear only for eligible comparisons. Full, unpaired
and audio views stay opaque while retaining the chosen comparison opacity;
Difference keeps separate base and highlight controls.

Official `kosmozoo-linux-x86_64` SHA-256: `8d60550a14a4c40a755acfa89abf723621d3cd03cfafdd9bf4e9a2109d4277b9`.

## 0.3.1 - 2026-11-05

Native browser magnification now shows a recovery hint that clears when normal
scale returns. The shared status corner follows the visible viewport while
magnified, keeping its messages reachable during zoom and pan.

Official `kosmozoo-linux-x86_64` SHA-256: `c65a3e5a2676e843a80e182e6215202cda5ef287ca6fb49c2378e6b1b455aae1`.

## 0.3.0 - 2026-11-04

Variations has a compact parameter editor with field-name filtering, independent
node controls, range or single-value inputs, and clearer counts and output-name
previews. Each opening starts a fresh draft; closing with unsent changes asks
before discarding them. Successful runs close after confirmation, while partial
or failed runs keep the draft available. Naming preserves prefixes and suffixes
while keeping long output names within the filename limit.

Build an ordered image set from ComfyUI inputs, any source's outputs, local files
or folders on the engine computer. Drop images onto the panel, drag square tiles
to reorder them, or use each target's current image as its own input. The image
picker has source tabs, searchable thumbnails and scroll-speed-aware lookahead;
failed previews offer an explicit retry.

Play MP4, WebM and MOV videos and FLAC, MP3, Opus and WAV audio in the feed and
viewer, with manual playback, seek, mute and looping. Embedded workflows provide
metadata and Variations for supported media. The viewer opens on the clicked
item in Full view, with video comparison modes and consistent A/B placement.
Zoom stays anchored to the image across navigation and resizing.

The feed filter combines filename, folder, judgments, feedback and parameter
conditions with AND or OR. Scroll the rail with the wheel, follow its alternating
20-tick bands, and hover for image or video-frame previews. New arrivals flash
once, source indicators show unseen images, workflow progress and queue counts,
and incoming items keep the current cards in place. Pinch zoom takes priority
over feed scrolling; media and card controls stay aligned and reachable.

A boot splash and source-loading glimmer provide feedback while content loads.
Shared text fields, buttons, mode switches and action rows bring consistent
focus, hover and active states, with unavailable actions omitted. Copied and
downloaded filenames can optionally include the source name.

Foreground media and metadata take priority over background loading, and the
shown entry gets its metadata independently of collection-wide updates. Byte
ranges support media seeking, failed measurements no longer hide entries, and
large PNG metadata is retained. Source addresses accept an omitted HTTP port,
Variations preserves graph identity and dependencies, and the engine shuts down
promptly with clients connected.

Security hardening validates cache digests, rejects cross-site mutation requests
and serves user media as sandboxed documents. Resource budgets limit metadata
processing and uploads, while packaging checks validate executable inputs.

Official `kosmozoo-linux-x86_64` SHA-256: `ff2486bfd42f0c50c0e48eb08a52ac9ec8eee826f873629e6e4cad90d0179d34`.

## 0.2.2 — 2026-10-19

Fresh installs start with no sources instead of assuming a local ComfyUI server.
The empty feed offers a link to add a ComfyUI host or folder through the source
picker. Explicit `KOZMOZOO_HOSTS` seeds and existing collections keep their behavior.

Unreachable sources show as offline with one error per outage. Retries continue
quietly, and a successful refresh clears the error and restores online status.
The engine's user service now restarts the engine after a crash.

Official `kosmozoo-linux-x86_64` SHA-256: `2a1470029a9b50a492a9c59885f0746ca8c95e3c386fe9c72414793aa139a804`.

## 0.2.1 — 2026-10-18

The README now shows the image feed and comparison workbench in five screenshots.

`kosmozoo package-resources --prefix=/usr --destdir=/absolute/package-root`
generates desktop, icon, user-service, license, notice and documentation files
for packages without starting services or opening a browser.

Arch users can choose `kosmozoo`, `kosmozoo-bin` or `kosmozoo-git` from the AUR.
Release downloads now contain only the executable and its `SHA256SUMS`;
project and dependency source links are documented in the licensing guide.

Official `kosmozoo-linux-x86_64` SHA-256: `87b5f399598c61988f66c016327e189997432c3c4ad6a5102e227d32ca2b55d2`.

## 0.2.0 — 2026-10-16

Kosmozoo 0.2.0 rewrites the Python v0.1.0 application with a Deno engine and
a Solid client for reviewing and curating ComfyUI image output.

See the [README](README.md) for installation options and features.
Official `kosmozoo-linux-x86_64` SHA-256: `f8d0b95f104d75d4cb08565b3aab8dcdcc2e69c88b520f7ede162d751fa58f60`.

Judgments migrate one-way from v0.1.0's `feedback.json` into per-entry SQLite
records. The original is kept as `feedback.json.v1-backup-<ts>`; hash-based
judgments fan out to matching entries, and legacy `host:filename` judgments are
retained as unavailable entries. The export plugin and `deno task import-legacy`
are removed. State defaults to `$XDG_STATE_HOME/kosmozoo` (outside the source
tree); the cache uses extension-less content hashes, and `KOZMOZOO_DOWNLOADS`
is removed. API clients use `/api/collections/<id>/entries/*` in place of
`/api/images/*`, collection capabilities for supported operations, and
`/api/features/<name>/*` for feature routes.
