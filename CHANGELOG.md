# Changelog

## 0.2.0 — 2026-10-16

Kosmozoo 0.2.0 rewrites the Python v0.1.0 application with a Deno engine and
a Solid client for reviewing and curating ComfyUI image output.

See the [README](README.md) for installation options and features.

Judgments migrate one-way from v0.1.0's `feedback.json` into per-entry SQLite
records. The original is kept as `feedback.json.v1-backup-<ts>`; hash-based
judgments fan out to matching entries, and legacy `host:filename` judgments are
retained as unavailable entries. The export plugin and `deno task import-legacy`
are removed. State defaults to `$XDG_STATE_HOME/kosmozoo` (outside the source
tree); the cache uses extension-less content hashes, and `KOZMOZOO_DOWNLOADS`
is removed. API clients use `/api/collections/<id>/entries/*` in place of
`/api/images/*`, collection capabilities for supported operations, and
`/api/features/<name>/*` for feature routes.
