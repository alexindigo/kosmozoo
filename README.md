# Kosmozoo

Efficiently compare a high volume of generated images against preset
anchors, and capture detailed feedback on what is wrong or right with each
one.

This is the **`cruft-cleanup`** branch: a fresh implementation on Deno +
native ESM — the engine runs unbundled; the Solid client compiles via
`build.mjs` into `client-solid-dist/` — with the engine exposed as a public
API and downstream curation (buckets, captions, reject-sets) moved behind a
plugin boundary.

- **Product rationale:** `~/Documents/kosmozoo/NORTH_STAR.md`
- **Engine + client contract:** `docs/spec.md`
- **The outgoing Python implementation** is frozen on `main` and tagged
  `python-final`. The live install runs the Deno v6/preact line from
  `~/Projects/kosmozoo.dev`; this branch is its replacement.

## Status

The Deno rewrite is functional: engine, feed, comparison workbench, and the
plugin/feature tiers are live. `docs/spec.md` is the binding contract;
`PLUGINS.md` covers the plugin surface.
