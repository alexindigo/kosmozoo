# Kosmozoo

Efficiently compare a high volume of generated images against preset
anchors, and capture detailed feedback on what is wrong or right with each
one.

This is the **`dev`** branch: a fresh implementation on Deno + native ESM,
zero-build, with the engine exposed as a public API and downstream curation
(buckets, captions, reject-sets) moved behind a plugin boundary.

- **Product rationale:** `~/Documents/kosmozoo/NORTH_STAR.md`
- **Engine + client contract:** `docs/spec.md`
- **The outgoing Python implementation** is frozen on `main` and tagged
  `python-final`; it remains the daily driver and A/B reference while this
  branch is built.

## Status

The tree was emptied at the first `dev` commit and is being rebuilt phase by
phase. Non-functional until the comparison workbench lands (Phase 7); see
`docs/spec.md` for the contract being built against.
