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

Packaged runs include the [Linux x86_64 executable](docs/executable.md), with
installed-browser app windows and an optional user-local installer, and the
[production container image](docs/container.md), with built UI, cached engine
dependencies, native SQLite and persistent state/cache. Desktop mode defaults
to loopback2084; service/source/Docker mode to0.0.0.0:2084, with explicit
`KOZMOZOO_BIND`/`KOZMOZOO_PORT` overrides. The devcontainer is for contributing.

## Status

The Deno rewrite is functional: engine, feed, comparison workbench, and the
plugin/feature tiers are live. `docs/spec.md` is the binding contract;
`PLUGINS.md` covers the plugin surface.
