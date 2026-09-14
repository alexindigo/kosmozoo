# Kosmozoo

Efficiently compare a high volume of generated images against preset
anchors, and capture detailed feedback on what is wrong or right with each
one.

This is the **`dev`** branch: a fresh implementation on Deno + native ESM —
the engine runs unbundled; the Solid client compiles via `build.mjs` into
`client-solid-dist/` — with the engine exposed as a public API and
downstream curation (buckets, captions, reject-sets) moved behind a plugin
boundary.

- **Product rationale:** `~/Documents/kosmozoo/NORTH_STAR.md`
- **Engine + client contract:** `docs/spec.md`
- **The outgoing Python implementation** is frozen on `main` and tagged
  `python-final`; it remains the daily driver and A/B reference while this
  branch is built.

## Status

The Deno rewrite is functional: engine, feed, comparison workbench, and the
plugin/feature tiers are live. `docs/spec.md` is the binding contract;
`PLUGINS.md` covers the plugin surface.
