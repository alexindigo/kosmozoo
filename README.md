# Kosmozoo

Efficiently compare a high volume of generated images against preset
anchors, and capture detailed feedback on what is wrong or right with each
one.

This tree is the Deno engine + Solid client implementation. The engine runs
unbundled as native ESM; the Solid client compiles via
`build.mjs` into `client-solid-dist/` — with the engine exposed as a public
API and downstream curation (buckets, captions, reject-sets) moved behind a
plugin boundary.

- **Product rationale:** `~/Documents/kosmozoo/NORTH_STAR.md`
- **Engine + client contract:** `docs/spec.md`
- **The outgoing Python implementation** is tagged `python-final`.

The supported packaged run is the production container image: compiled UI,
cached engine dependencies and native SQLite, running non-root with persistent
state/cache volumes. See [docs/container.md](docs/container.md) for building,
configuration, source-data mounts and shutdown. The devcontainer is for contributing.

## Status

The Deno rewrite is functional: engine, feed, comparison workbench, and the
plugin/feature tiers are live. `docs/spec.md` is the binding contract;
`PLUGINS.md` covers the plugin surface.
