# Folder-as-host: a local folder is just another host (design note)

## Decision

A folder registers as `name=folder:/absolute/path` in the hosts config and the
host-pickerr add row. The engine's host I/O (probe, list, bytes) routes
through a folder adapter in `src/hosts.mjs`; HTTP hosts are unchanged.
Chose this over a separate "local source mode" (duplicates the feed source
path) and a plugin (a core source kind belongs in core's host abstraction).

## Semantics

- **probe (online dot)**: the directory exists → online.
- **list**: files with a renderable extension (png, jpg, jpeg, webp, gif, svg,
  avif, bmp), dotfiles skipped, **newest first by mtime**, basename only —
  no subdirectories, no `..`.
- **bytes**: read from the folder; traversal-guarded.
- **history**: none — the engine's metadata comes from PNG text-chunk
  extraction anyway (the shared extractor), so ComfyUI outputs in a folder
  get the full pipeline (scrape → extract → live fields).

## Errors

- Folder missing or unreadable → probe returns false (offline dot; feed shows
  the empty/load-fail surface like any other host).
- Non-basename filename in a bytes request → 400.
- Picker add row rejects `folder:` with no path or a non-directory (400 with reason).

## Tests

- Adapter unit tests (list ordering, basename guard, traversal rejection).
- Route integration: `/api/images?host=` listing, `/api/images/<id>/bytes`
  read + guard.
- Scraper end-to-end: a ComfyUI PNG in a folder gets extracted metadata.
- e2e: switch to a folder host, feed shows its files; SVG renders (octet-stream
  mapping applies to folder bytes too).
