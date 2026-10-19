# Changelog

## 0.2.1 — 2026-10-18

The README now shows the image feed and comparison workbench in five screenshots.

`kosmozoo package-resources --prefix=/usr --destdir=/absolute/package-root`
generates desktop, icon, user-service, license, notice and documentation files
for packages without starting services or opening a browser.

Arch users can choose `kosmozoo`, `kosmozoo-bin` or `kosmozoo-git` from the AUR.
Release downloads now contain only the executable and its `SHA256SUMS`;
project and dependency source links are documented in the licensing guide.

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
