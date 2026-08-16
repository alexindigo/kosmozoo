<p align="center"><img src="logo-512.png" width="200" alt="kosmozoo logo"></p>

# kosmozoo

A local, zero-build review & curation tool for ComfyUI image output. A
Python-stdlib server proxies one or more ComfyUI hosts and serves a
single-page app; every judgment you make (notes, thumbs, buckets, tags)
lands in one canonical `feedback.json` that downstream tooling (training
digests, curation scripts) can consume directly.

No npm, no bundler, no framework: `server.py` (stdlib `http.server`) +
`index.html` (inline CSS/JS). Binds `0.0.0.0` by default (reachable on the
LAN — there is no auth; set `KOZMOZOO_BIND=127.0.0.1` to keep it
localhost-only).

## Features

### Candidate grid
- Newest-first cards from a ComfyUI host's output folder, rendered in
  chunks of 20 with a scroll sentinel, windowed image loading
  (viewport ±10 cards get pixels; the rest are placeholders), and
  scroll-snap to card tops.
- Per card: image, filename, metadata line (seed / steps / cfg / denoise /
  sampler / scheduler / LoRA name+strength / dimensions), prompt excerpt,
  negative (red) + positive (green) note boxes with 500 ms debounce +
  blur-flush autosave and a "Feedback saved" tick.
- Per card actions: thumbs up/down (down hides; "Unhide 👎" in the header
  restores), session-only "Hide 👍" filter, `save` (greys out when the file
  already exists in your downloads dir), copy-from-above/below note buttons
  (walk to the nearest neighbor with content, including hidden cards).
- Host dropdown with live online/offline probing.

### Anchors (right pane)
- Drop reference images in (browser-local; nothing uploads); drag to
  reorder; sticky while scrolling; persisted in localStorage; the pane is
  resizable by the divider (width persisted).
- Dropped PNGs get their embedded ComfyUI workflow parsed back out
  (seed/steps/sampler/LoRA/prompt shown under the anchor).

### Lightbox (click any image)
- Pinch/ctrl-wheel or `-`/`+` zoom (1 px steps; Shift = 10 px), drag or
  Shift+arrows to pan (1 px steps), plain scroll does nothing.
- `H`/`V` flip, Alt+drag rotates freely with snap-to-level at 0°.
- Arrow-key navigation: Left/Right hop between the candidate and anchor
  columns (each column remembers its position), Up/Down walk within a
  column. Per-image zoom/pan/flip/rotation state is persisted; pair
  switches in overlay mode share the view (no jump).
- Guides: drag from the top/left edge to spawn ruler lines (persisted,
  double-click or drag-off-edge removes; toggleable).
- Comparison stack ("overlay" toggle, on by default): current anchor
  rendered underneath, opacity slider, and a split-wipe line (off by
  default; its toggle starts the line at the image edge; Alt+←/→ nudges).
- Click the image to close; Esc too; the outgoing image stays visible until
  the incoming one has loaded (no flicker).

### Face detection (opt-in)
- Toggle in the ☰ menu (persisted), model picker:
  - `anime (local)` — [hysts/anime-face-detector](https://github.com/hysts/anime-face-detector)
    (MIT) running server-side in a project venv (torch CPU). Best for
    stylized faces; 28 landmarks; results cached on disk
    (`faceboxes_cache.json`), once per image ever. Detection input is the
    image bytes the browser already has — ComfyUI hosts are never re-hit.
  - `mediapipe` — BlazeFace (client-side WASM, vendored) for photo faces.
- Draws the detected face box + eye dots in the lightbox ("facebox"
  toggle), and "match facebox" frames the candidate so its face matches the
  current anchor's face position and size (eye-midpoint + inter-eye
  distance), re-applied on every navigation. Linked pan: with match on (or
  Shift held), dragging pans both images together.

### Advanced mode (☰ menu toggle)
Gates the extra UI; default off:
- Full prompt click-to-expand on cards (+ negative prompt when present).
- "Group by prompt" view: collapsible sections per identical prompt,
  counts per group.
- Per-card **bucket** select (curation routing) and **tag** select
  (note type: character/scene/style), stored on the feedback entry.

### Data durability
- `feedback.json` is the canonical store (lives outside the repo by
  default); atomic writes; entries prune only when fully empty.
- `metadata.db` (sqlite) is the durable per-image metadata store. It is fed
  from two sources: live ComfyUI `/api/history` merges (fast path for fresh
  generations) and **PNG chunk parsing** — ComfyUI embeds the executed
  graph (`prompt`) and the editable `workflow` as tEXt chunks, so a
  background scraper reads just the first ~16KB of each image and extracts
  metadata even for files whose history is long gone. The scraper is
  toggleable from the ☰ menu (persisted in `config.json`) with a pause
  button; images you actually scroll to always jump the queue regardless.
  A legacy `metadata_cache.json` is imported once and renamed `.imported`.
- `faceboxes_cache.json` — detections, computed once per image.

## Files / layout

```
server.py            # the whole backend (stdlib)
index.html           # the whole frontend (inline CSS/JS)
fetch_vendor.sh      # vendors MediaPipe tasks-vision (+BlazeFace) for the
                     #  "mediapipe" model option (pinned; output gitignored)
setup_facedetect.sh  # project venv + torch CPU + anime-face-detector
                     #  (weights cached in ~/.cache/huggingface, offline after)
detect_worker.py     # long-lived JSON-lines detection worker (spawned on demand)
config.json          # local machine config (gitignored): feedbackPath, buckets
```

## Configuration

Environment variables:

| Var | Default | Meaning |
|---|---|---|
| `KOZMOZOO_PORT` | `2084` | listen port |
| `KOZMOZOO_BIND` | `0.0.0.0` | bind address (`127.0.0.1` = localhost-only) |
| `KOZMOZOO_DOWNLOADS` | `~/Downloads` | dir the card "save" button checks |
| `KOZMOZOO_FEEDBACK` | `~/Documents/kosmozoo_feedback.json` | default feedback.json path |
| `KOZMOZOO_METADATA` | `./metadata.db` | sqlite metadata store path |
| `KOZMOZOO_BUCKETS` | generic list | comma-separated curation bucket names |
| `KOZMOZOO_HOSTS` | `local=127.0.0.1:8188` | comma-separated `name=host:port` pairs |
| `KOZMOZOO_STATE` | app dir, or `$XDG_STATE_HOME/kosmozoo` | writable state dir (config.json, metadata.db, faceboxes_cache.json) |
| `KOZMOZOO_VENV` | `./.venv` | face-detection venv (see `setup_facedetect.sh`) |

`config.json` (written by the ☰ menu) overrides env for `feedbackPath`,
`buckets`, `hosts`, and `scraperEnabled`. Hosts are also settable via
`KOZMOZOO_HOSTS` (`"name=host:port,name2=host2:port2"`). Default: a single
local ComfyUI at `127.0.0.1:8188`.

State files live next to the app in a repo checkout; when the app
directory is read-only (packaged install under `/usr/lib`), state falls
back to `$XDG_STATE_HOME/kosmozoo` (`~/.local/state/kosmozoo`).

### feedback.json entry shape

```json
"ms-01:IMG_0001.png": {
  "neg": "what's wrong",        // red box
  "pos": "what's right",        // green box
  "vote": "up",                 // thumbs; "down" hides the card
  "bucket": "good",             // curation routing (Advanced)
  "tag": "scene"                // note type; "character" = default = absent
}
```

## Server API (all local)

| Endpoint | Purpose |
|---|---|
| `GET /` | the SPA |
| `GET /api/hosts` | configured hosts + online status |
| `GET /api/files?host=X` | proxied ComfyUI output file list |
| `GET /api/image?host=X&file=Y` | proxied image bytes (cached headers) |
| `GET /api/metadata?host=X` | `{items, pending, v}` — filename → metadata (sqlite store ∪ live history), extraction backlog, store version |
| `POST /api/meta-want` | `{host, files}` — prioritize filenames for PNG extraction (scroll-driven) |
| `GET/POST /api/scraper` | background scan toggle (persisted) + pause/resume |
| `GET/POST /api/comments` | feedback read / partial-update upsert |
| `GET /api/feedback` | download the exact feedback.json bytes |
| `GET/POST /api/config` | feedback path + bucket list |
| `POST /api/downloads-check` | per-name exists check (no listing; basenames only) |
| `GET /api/facebox-warmup` · `POST /api/facebox-bytes?key=K` | local face detection |
| `GET /vendor/...` | vendored MediaPipe assets |

## Deployment

### Quickest (current machine)

```bash
python3 server.py          # serves http://127.0.0.1:2084
```

Face detection is off until enabled in the ☰ menu; the `mediapipe` model
needs `./fetch_vendor.sh` once, the `anime` model needs
`./setup_facedetect.sh` once (python3 + venv + ~250 MB of torch CPU wheels
+ model weights from Hugging Face on first run, offline afterwards).

### Fresh machine

```bash
git clone git@github.com:alexindigo/kosmozoo.git
cd kosmozoo
./fetch_vendor.sh          # only if you want the mediapipe model option
./setup_facedetect.sh      # only if you want anime face detection
python3 server.py
```

Then point it at your ComfyUI host(s) — either `KOZMOZOO_HOSTS` or
`"hosts"` in `config.json` (`{"host-a": "myhost:8188", ...}`).

### systemd --user (autostart)

The AUR package (`kosmozoo-git`) ships this unit at
`/usr/lib/systemd/user/kosmozoo.service` pointing at the packaged install —
just `systemctl --user enable --now kosmozoo`. For a repo checkout, use:

```ini
# ~/.config/systemd/user/kosmozoo.service
[Unit]
Description=kosmozoo review server
After=network.target

[Service]
WorkingDirectory=%h/Projects/kosmozoo
ExecStart=/usr/bin/python3 -u %h/Projects/kosmozoo/server.py
Restart=always
RestartSec=2
# Environment=KOZMOZOO_PORT=2084

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now kosmozoo.service
```

### Custom port / paths without touching code

```bash
KOZMOZOO_PORT=9000 KOZMOZOO_DOWNLOADS=/data/incoming python3 server.py
```

or set them permanently in the systemd unit's `Environment=` lines.

## Development notes

- No build step; the page reloads from disk on refresh (`no-store`).
- Server changes need a restart (no autoreload).
- Smoke-tested via a Node DOM-shim harness driving the real page JS against
  the live server (harness lives outside the repo; see git history for the
  test-driven fixes it caught).

## License

LGPL-3.0 — see `LICENSE`.
