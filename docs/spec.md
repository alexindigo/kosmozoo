# Kosmozoo spec (dev branch)

Engine + client contracts for the Deno rewrite. The product rationale lives
in `~/Documents/kosmozoo/NORTH_STAR.md`; this file is the binding contract
for what gets built here.

## 1. The three axes

Comparison behaviour is three independent axes, not a matrix of toggles.
Availability **and reason** derive from each mode's declared `needs`, so
"why won't this engage" is always answerable.

| Axis | Exclusive | Values | Notes |
|---|---|---|---|
| **Alignment** | yes | `independent` / `shared` / `face-anchored` | facebox is this axis's visual feedback, not a separate annotation |
| **Composition** | yes | `blend` (opacity) / `split` / `difference` / `flicker` | difference arrives as a plugin (proves the client-only plugin shape) |
| **Attention (ROI)** | no | guides (persistent), region focus | **manual-first**; detection contributes optional presets only |

Because exclusive axes are exclusive, **keys are the primary input**: one key
cycles composition, one cycles alignment, one frames the ROI. Grouped
controls display state; they are not the input path.

**ROI is manual-first, detection-assisted.** View state is unit-free
box-fractions, so an ROI in box-fractions applies to *both* images
automatically once the pair is registered. A missing or failing detector
therefore never blocks the workflow.

## 2. Engine API (public)

Resource-shaped, documented, treated as public. A different UI must be
buildable on it.

| Resource | Methods | Notes |
|---|---|---|
| `/api/hosts` | GET | configured ComfyUI hosts + online probe |
| `/api/images` | GET | paginated list; `?host=&cursor=` |
| `/api/images/<id>` | GET | one image: metadata + judgment + plugin fields |
| `/api/images/<id>/bytes` | GET | proxied image bytes (engine proxies ComfyUI) |
| `/api/judgments/<id>` | GET, PUT, DELETE | notes/vote/favorite; plugin fields namespaced |
| `/api/settings/<ns>` | GET, PATCH | namespaced: `core.*`, `plugins.<name>.*` |
| `/api/plugins` | GET | discovered plugins + their declared capabilities |
| `/api/plugins/<name>/<route>` | * | plugin-registered routes (server-side plugins) |

Image identity is `host:filename` — multi-host is a core capability.

## 3. Judgment model

| Concept | Meaning | Persistence |
|---|---|---|
| `vote` up/down | decision signal about project fitness | persisted; never altered by a filter |
| `favorite` | interesting in itself, independent of project fit | persisted |
| `hidden` | view filter | session |

- Down-vote **hides by default**; the coupling is a `core.judgment` setting.
- "Show thumbed-down" is a **temporary reveal**, never a data deletion.
- Notes: `pos` / `neg` free text, debounced autosave, prune-when-empty.
- Core judgment record stays small: notes, vote, favorite. Plugin fields
  live under `plugins.<name>` in the same record.

## 4. Knowledge harvest (from the outgoing implementation)

Non-obvious behaviour the rewrite must not rediscover one bug at a time.

| # | Lesson | Outgoing evidence |
|---|---|---|
| 1 | Navigation needs a **load-generation guard** — `gen = ++lbLoadGen`, then `if (gen !== lbLoadGen) return` | `index.html:2302`, `2312` |
| 2 | Outgoing view state must be written back **before** the incoming view is read | `index.html:2402` |
| 3 | Cover the swap: hold the outgoing frame until the incoming image loads | `index.html:2287–2300`, `2326` |
| 4 | **Derived state must never persist over its source** — writing the face-aligned view back compounded zoom on every switch | charter invariant 1 |
| 5 | List progress needs **three independent mechanisms** (sentinel, scroll safety net, programmatic restore) — restore-overshoot strands the sentinel above the viewport and any single mechanism stalls | charter, list engine |
| 6 | Unload by `removeAttribute('src')` — aborts the fetch *and* releases decoded bytes | `index.html:1442` |
| 7 | Never cache a `null` detection — a transient failure would poison that image permanently | `index.html:2966–2971` |
| 8 | Scraper politeness set: single-flight, 100 ms gaps, backoff capped 30 s, **HTTP 404 ⇒ permanent**, two-tier queue with on-screen priority, pause gate | `server.py:810–890` |
| 9 | Graph inputs arrive as arrays when they are links — scalar probes must filter | `server.py:493–501` |
| 10 | Prompt-text walk: ≤8 hops, `zeroout` on the path ⇒ empty string | `server.py:466–481` |
| 11 | PNG text chunks: stop at first `IDAT`, cap at 256 KB | `server.py:703–748` |
| 12 | **Guides persist globally, not per-image** — which is why they work as a persistent ROI marker | `kosmozoo.guides.v1` |
| 13 | Judgment entries prune only when fully empty; a field set to its default is stored as absent | `server.py:756–778` |
| 14 | Manual image retry must cache-bust, or a partial cached response is reused | `index.html:1427–1438` |
| 15 | ~20 ComfyUI `class_type` probes are **empirical field data**, not architecture — port them verbatim | `server.py:516–683` |

## 5. Boundaries

- Zero-build: native TS/ESM, no bundler, no npm, no framework.
- Core has one pinned dependency: `jsr:@db/sqlite@0.13.0`.
- Native sqlite3 library comes from the system (pacman model) —
  `DENO_SQLITE_PATH=/usr/lib/libsqlite3.so`.
- `feedback.json` stays a portable JSON document outside the repo.
- Running kosmozoo stays one `deno run` away — the devcontainer is for
  contributing, never for running.
- No ML runtime, model weights, or Python anywhere in core. Specialized
  capabilities live behind a plugin/service boundary.
- Security deliberately deferred: no auth, no sandbox, no capability model.

## 6. Storage (hash identity + sqlite + cache)

Identity is content hash (SHA-256).  `host:filename` is an address, not an
identity; the same image on two hosts or in a download folder is the same
thing.

### Schema (`metadata.db`, `PRAGMA user_version = 2`, ordered migrations)

```
CREATE TABLE files (
  host     TEXT NOT NULL,
  filename TEXT NOT NULL,
  hash     TEXT,                -- sha256; null until ingested
  size     INTEGER,
  PRIMARY KEY (host, filename)
);
CREATE INDEX files_by_hash ON files(hash);

CREATE TABLE images (
  hash         TEXT PRIMARY KEY,
  meta         TEXT,            -- extractor JSON blob
  source       TEXT,            -- 'history' | 'png'
  has_workflow INTEGER NOT NULL DEFAULT 0,
  nopng        INTEGER NOT NULL DEFAULT 0,
  ext          INTEGER NOT NULL DEFAULT 0,
  updated_at   REAL NOT NULL
);

CREATE TABLE metadata (        -- legacy (v1), still used for unhashed rows
  host         TEXT NOT NULL,
  filename     TEXT NOT NULL,
  meta         TEXT,
  source       TEXT,
  has_workflow INTEGER NOT NULL DEFAULT 0,
  nopng        INTEGER NOT NULL DEFAULT 0,
  ext          INTEGER NOT NULL DEFAULT 0,
  updated_at   REAL NOT NULL,
  PRIMARY KEY (host, filename)
);
```

Migrations are ordered (`user_version` 0→1→2) and idempotent.

### Cache (`~/.local/share/kosmozoo/cache/`)

Layout: `<ab>/<hash>.png`.  Atomic writes only (tmp → rename) — a corrupt
write never poisons an image.  Unbounded (LRU when disk pressure warrants).
Override: `KOZMOZOO_CACHE`.

### Ingestion (read → hash → cache → index)

Every image the engine touches flows through ingestion.  There is no "miss"
path — bytes enter the cache and the store is indexed before anything else
sees them.

1. Read bytes from host (HTTP proxy or folder read).
2. Compute SHA-256 hash.
3. Write to cache (atomic).
4. Update `files.hash` + `files.size`.
5. Move metadata from `metadata` → `images` table.

### Serve path (cache-first)

`GET /api/images/<id>/bytes`:
1. Resolve `host:filename` → hash via `files`.
2. Serve from cache.
3. If not cached: read through ingestion (hash → cache → index), then serve.
4. Ingestion failure: proxy from host as last resort (background-ingest for
   next time).

A ComfyUI host busy training is no longer a read outage — cached bytes serve
offline.

### Judgments

Judgment entries in `feedback.json` are keyed by content hash, with a
human-readable `ref: "<host>:<filename>"` per entry.  Legacy
`host:filename` keys are migrated lazily on first write; a startup migration
re-keys any remaining legacy entries whose files have been hashed.  Orphan
entries (files gone) keep their old keys.

### Legacy import

`deno task import-legacy` opens the frozen Python `metadata.db` read-only and
merges its rows into the local store.  Idempotent (skips already-present
rows).
