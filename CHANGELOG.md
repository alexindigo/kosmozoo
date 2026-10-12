# Changelog (dev branch)

This branch is a fresh implementation on Deno; the Python implementation's
changelog is frozen with it on `main` (tag `python-final`).

Entries below follow the rewrite's phases. Each entry names the contract it
implements from `docs/spec.md`.

## 0.2.0 — release preparation

- Ordinary Deno Linux x86_64 single executable with complete client, authenticated
  native inputs and source-traceable dependency/license material; installed-browser
  app launch and optional receipt-managed user installation preserve persistent data.
- Shared portable build/payload/global-resource contract for source and prebuilt
  packaging, retaining the developer wrapper's strict VM guard. The official
  executable checksum is recorded after the reviewed tagged artifact is frozen.

## Unreleased

- Empty the tree; devcontainer (Deno + git, capped runArgs); spec
  (`docs/spec.md`) and `~/Documents/kosmozoo/NORTH_STAR.md`.
- Schema v7: judgments moved from the hash-keyed `feedback.json` document to
  per-entry columns keyed `(collection, name)`. The migration is one-way:
  the legacy file is imported once (fan-out by hash; legacy `host:filename`
  keys become `state='gone'` entries so nothing is lost) and preserved as
  `feedback.json.v1-backup-<ts>`.
- API: `/api/images/*` → `/api/collections/<id>/entries/*`; collections
  answer one capabilities shape (`list`/`read`/`add`/`delete`/`rename`);
  feature modules mount at `/api/features/<name>/*`; the export plugin and
  `deno task import-legacy` are removed.
- Two-pass prefetch: a dims pass (ranged head reads → `entry.width/height`)
  runs ahead of full ingestion, so the feed renders every card at its exact
  size before the hash exists; listings and the `/meta` poll carry dims.
- Cache layout is extension-less (`<ab>/<hash>`, mime sniffed at serve);
  state defaults to `$XDG_STATE_HOME/kosmozoo` — the repo tree is never a
  state dir; `KOZMOZOO_DOWNLOADS` is gone.
- Client: one Solid store (views never fetch), size-before-render feed, one
  key dispatcher with modal layers, client feature registry mirroring the
  engine's; persistence is engine settings plus four localStorage keys
  (info groups, workspace pane, info layout, anchors).
