# Changelog (dev branch)

This branch is a fresh implementation on Deno; the Python implementation's
changelog is frozen with it on `main` (tag `python-final`).

Entries below follow the rewrite's phases. Each entry names the contract it
implements from `docs/spec.md`.

## 2026-09-05 → 2026-09-10 — variations plugin: lineage-filename bounds, breadth-first sweep, image dedup

**Why:** repeated `Errno 36: File name too long` on ComfyUI hosts whenever a
variation was re-varied (the lineage chain re-embedded the whole source
filename into SaveImage `filename_prefix`, exceeding NAME_MAX (255) after
~3 hops). Then queue floods and per-image duplicates surfaced alongside.

### Changes (`plugins/variations/plugin.mjs`)

- **`clampBasename(basename, max)`** (new export) — folds over-length
  lineage middles as `<head>~<tail>` at `MAX_BASENAME = 200`. Head 100
  chars + `~` + tail 99, so the pipeline identity (head) and the newest
  lineage (tail) both survive. (User directive 2026-09-05: fold the
  middle.)
- **`stripWideHostTag(basename, hostTag)`** (new export) — removes *every*
  re-occurrence of `<host>#` mid-name, not just the leading run that
  `dedupHostTag` already strips.
- **`clampBudget(pfx, sfx)`** + **`HEADROOM = 15`** (new) — computes how
  much of NAME_MAX remains after `<host-tag><pfx>` and `<sfx>` claim their
  share, minus the ComfyUI `"_NNNNN_.png"` counter suffix. Used by the
  fallback `wrapAllSaveImagePrefixes` path.
- **`NAME_MAX_WITHOUT_COUNTER = 200`** (new) — the hard cap applied to the
  *assembled* prefix `<pfx><basename><sfx>` in `narrowToOneSaveImage` via
  `clampBasename(pfx + basename + sfx, NAME_MAX_WITHOUT_COUNTER)`.
  (User directive 2026-09-10: 200 total, not just the middle.)
- **`breadthFirstSweep(arrays)`** (new export) — replaces column-major
  cartesianProduct in `generatePermutations`: index-major round-robin,
  image axes vary fastest (they're the UI panels' first-order selection).
  (User directive 2026-09-10: `A1 B1 C1 A2 B2…` panel order.)
- **Image-axis dedup** — `[...new Set(p.values)]` per sweep axis so a
  file listed twice (duplicate LoadImage nodes / re-picked file) doesn't
  submit the same image twice.

### Test coverage (`tests/t_variations.mjs`)

9 new cases: fold-middle semantics + head/tail balance, stripWideHostTag
(idempotent + non-idempotent), fallback-clamp, 200-cap exact bound,
short-value passthrough, breadthFirstSweep ordering, breadth-first
permutation emission, image-axis dedup, numeric × image dedup.

`deno test tests/t_variations.mjs` → **59 passed / 0 failed** as of
2026-09-10 (57 after the 200-cap fix + 2 for image-dedup).

### Behavioral notes

- Lineage provenance itself is untouched — `extra_pnginfo.kz` PNG metadata
  still carries full `source` + `params` chains. Only the *filename* is
  bounded.
- `kosmozoo.solid` intentionally NOT touched (Dev→Stable mirror; user
  manages sync).
- ark queue cleared twice (Sep 5: 725 doomed entries; Sep 10: 82) to stop
  GPU burn on guaranteed-Errno-36 prompts.

## Unreleased

- Empty the tree; devcontainer (Deno + git, capped runArgs); spec
  (`docs/spec.md`) and `~/Documents/kosmozoo/NORTH_STAR.md`.
