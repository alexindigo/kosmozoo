# Kosmozoo spec

Engine + client contracts for the Deno + Solid tree (`solid-migration-split`
and forward). The product rationale lives in
`~/Documents/kosmozoo/NORTH_STAR.md`; this file is the binding contract for
what exists here. Statements marked **→ changes in cruft-cleanup §N** are
true today and change under that plan.

## 1. The three axes (design contract; plumbing dormant)

Comparison behaviour is designed as three independent axes, not a matrix of
toggles. Availability and reason derive from each mode's declared `needs`.

| Axis | Exclusive | Values | Shipped today |
|---|---|---|---|
| **Alignment** | yes | `independent` / `shared` / `face-anchored` | `detector` plugin registers `face-anchored` from its client half; the SPA does not load plugin client halves, so the axis is dormant |
| **Composition** | yes | `blend` / `split` / `difference` / `flicker` | `difference` plugin registers the mode from its client half; dormant for the same reason |
| **Attention (ROI)** | no | guides, region focus | not implemented |

What IS shipped: the feed (virtualized grid), the workbench (single-image
stage with a decode-guarded swap, notes/vote/favorite, anchor pane), the
variations feature (server route + modal), and the `/diff?l=<h>#<f>&r=…`
pair-URL grammar kept for the unfinished two-sided diff layer
(cruft-cleanup §9 Q1 — diff is the first *layer* over the feed).

Keys are the primary input; the keys panel (`?`) lists the live bindings.

## 2. Engine API (public)

Resource-shaped, documented, treated as public. Collections + entries are
the resources; a collection's `capabilities` answer what its backing can do.

| Route | Methods | Notes |
|---|---|---|
| `/api/collections` | GET | configured collections, online probe, `kind`, `capabilities` (`list`/`read`/`add`/`delete` ∈ `trash`/`unlink`/`hide`, `rename`) |
| `/api/collections` | POST | add a source-backed collection `{name, address}` |
| `/api/collections/<id>` | DELETE | remove; refuses the last collection |
| `/api/collections/<id>/entries` | GET | the feed listing: size, hash, state, meta, judgment, content dims. `?kind=input` lists the input dir instead |
| `/api/collections/<id>/entries/<name>` | GET | one entry |
| `/api/collections/<id>/entries` | POST | multipart upload into the input dir; **409 with the conflicting name, never an overwrite** |
| `/api/collections/<id>/entries/<name>` | DELETE | per capability: folder → unlink; comfy + assets_plus → trash; otherwise → hide + history cleanup |
| `/api/collections/<id>/entries/<name>/bytes` | GET | cache-first bytes (`?kind=input` for input-dir files); ETag is the content hash, `Cache-Control: no-cache` |
| `/api/collections/<id>/entries/<name>/bytes` | HEAD | 404 when the entry's bytes are unknown, else `content-length` |
| `/api/collections/<id>/entries/<name>/judgment` | PATCH | whitelisted fields (`vote`/`favorite`/`notes`/`plugins.<ns>.*`), defaults deep-pruned, one statement |
| `/api/collections/<id>/feedback.json` | GET | the collection's judgments as a portable v2 document, generated on demand |
| `/api/collections/<id>/meta` | GET | versioned meta poll `?since=<v>` → `{v, changed, items?, pending}` |
| `/api/collections/<id>/want` | POST | `{files}` — on-screen names jump the extraction queue |
| `/api/content/<hash>` | GET | the content record + `instances: [{collection, name}]` |
| `/api/content/<hash>/bytes` | GET | cache bytes by hash (plugins, workbench) |
| `/api/prefetch` | GET, POST | background ingestion: `enabled`/`paused` toggles + per-collection pending |
| `/api/settings/<ns>` | GET, PATCH | namespaced settings (`core.*`, `plugins.<name>.*`) |
| `/api/plugins` | GET | discovered plugins + their declared capabilities |
| `/api/nodes` | GET | `class_type` registry discovered from extracted graphs |
| `/api/features` | GET | feature modules (→ variations moves here §3.4) |

Entry identity on the wire is the plain name under a collection; the
`collection:name` string survives only inside the client as a derived
accessor. Underneath it, identity is the content hash (§6).

Feature routes mount under `/api/features/<name><path>`: `variations`
serves `GET /probe/<id>` + `POST /run` (a core feature module, not a plugin).

Plugin routes mount under `/api/plugins/<name><path>`:

| Plugin | Routes |
|---|---|
| `export` | `PUT /assign`, `POST /run`, `GET /assignments` (→ removed §3.4) |
| `detector` | `POST /detect`, `GET /status` |
| `critic` | `GET /status`, `POST /describe`, `POST /diff-describe`, `POST /caption` |
| `hello` | `GET /hello` |

Static surfaces: `/shared/<name>.mjs` serves any `src/*.mjs` module to the
browser today (→ allow-listed §3.3); `/plugins/<name>/client.js` serves a
plugin's client half; `/` and `/diff` serve the Solid app from
`client-solid-dist/`, with shared assets (`/css`, `/vendor`, `/js`, logos)
from `client/`.

## 3. Judgment model

| Concept | Meaning | Persistence |
|---|---|---|
| `vote` up/down | decision signal about project fitness | `entry` column, per (collection, name) |
| `favorite` | interesting in itself, independent of fit | same |
| `hidden` | delete fallback on hosts that can't delete | `entry` column, per (collection, name) |

- Down-vote **hides by default**; the coupling is the
  `core.judgment.downvoteHides` setting.
- "Show thumbed-down" is a temporary reveal, never a data deletion.
- Notes: `pos` / `neg` free text, debounced autosave; defaults are
  deep-pruned (a field set to its default is stored as absent).
- Core judgment record stays small: notes, vote, favorite. Plugin fields
  live in the entry's `plugin_fields` JSON, namespaced `plugins.<name>`.

## 4. Knowledge harvest (from the outgoing implementation)

Non-obvious behaviour the rewrite must not rediscover one bug at a time.
Rows marked ⚠ are **currently violated** — the plan item restores them.

| # | Lesson | Outgoing evidence |
|---|---|---|
| 1 | Navigation needs a load-generation guard | `index.html:2302`, `2312` |
| 2 | Outgoing view state must be written back before the incoming view is read | `index.html:2402` |
| 3 | Cover the swap: hold the outgoing frame until the incoming image loads | `index.html:2287–2300`, `2326` |
| 4 | Derived state must never persist over its source | charter invariant 1 |
| 5 | List progress needs three independent mechanisms (sentinel, scroll safety net, programmatic restore) | charter, list engine |
| 6 | Unload by `removeAttribute('src')` — aborts the fetch and releases decoded bytes | `index.html:1442` |
| 7 | Never cache a `null` detection — a transient failure would poison that image permanently | `index.html:2966–2971` |
| 8 ⚠ | Scraper politeness set: single-flight, 100 ms gaps, backoff capped 30 s, HTTP 404 ⇒ permanent, two-tier queue with on-screen priority, pause gate — **priority promotion and per-host backoff are broken today (audit E12–E14; → §3.2)** | `server.py:810–890` |
| 9 | Graph inputs arrive as arrays when they are links — scalar probes must filter | `server.py:493–501` |
| 10 | Prompt-text walk: ≤8 hops, `zeroout` on the path ⇒ empty string | `server.py:466–481` |
| 11 | PNG text chunks: stop at first `IDAT`, cap at 256 KB | `server.py:703–748` |
| 12 | Guides persist globally, not per-image | `kosmozoo.guides.v1` |
| 13 ⚠ | Judgment entries prune only when fully empty; a field set to its default is stored as absent — **the prune is shallow today (audit D5; → §3.2)** | `server.py:756–778` |
| 14 | Manual image retry must cache-bust, or a partial cached response is reused | `index.html:1427–1438` |
| 15 | ~20 ComfyUI `class_type` probes are empirical field data, not architecture — port them verbatim | `server.py:516–683` |

## 5. Boundaries

- The engine is native ESM on Deno; the only engine dependency is
  `jsr:@db/sqlite@0.13.0`.
- The client is **built**: Solid JSX compiled by
  `deno run --allow-all build.mjs` (Babel + `babel-preset-solid` from pinned
  esm.sh URLs, no Vite, no npm) from `client-solid/` into
  `client-solid-dist/`; framework-free modules stay in `client/js/`.
  Solid + the virtualizer are vendored dists with build-time path rewrites
  (`fetch-vendor-solid.sh`, checksummed — → §3.0/§3.5).
- Native sqlite3 library comes from the system:
  `DENO_SQLITE_PATH=/usr/lib/libsqlite3.so`.
- `feedback.json` is a portable judgment document, generated on demand per
  collection (`/api/collections/<id>/feedback.json`) — sqlite is canonical.
- Running kosmozoo stays one `deno run` away — the devcontainer is for
  contributing, never for running.
- No ML runtime, model weights, or Python anywhere in core. Specialized
  capabilities live behind a plugin/service boundary.
- Security deliberately deferred: no auth, no sandbox, no capability model.

## 6. Storage (hash identity + sqlite + JSON documents)

Identity is content hash (SHA-256). `host:filename` is an address, not an
identity (→ the address becomes `collection:name` §3.2).

### State location

State dir resolution: `KOZMOZOO_STATE` if set, else the repo root when
writable, else `$XDG_STATE_HOME/kosmozoo` — so a dev checkout carries
`metadata.db` / `settings.json` in the working tree
(untracked). (→ XDG-by-default §3.3.) Env overrides: `KOZMOZOO_PORT`
(default 2084), `KOZMOZOO_HOSTS`, `KOZMOZOO_STATE`, `KOZMOZOO_FEEDBACK`
(migration import only),
`KOZMOZOO_DOWNLOADS` (→ removed §3.2), `KOZMOZOO_PLUGINS`,
`KOZMOZOO_REVALIDATE_MS`.

### Schema (`metadata.db`, `PRAGMA user_version = 7`, ordered migrations)

Content is what the bytes are; a collection is a namespace of names backed
by a host or folder; an entry is one instance's state in one collection.

```sql
CREATE TABLE content (
  hash TEXT PRIMARY KEY,          -- sha256 of the bytes
  width INTEGER, height INTEGER,  -- dims, resolved at ingestion
  meta TEXT,                      -- extractor JSON (params, nodes)
  has_workflow INTEGER NOT NULL DEFAULT 0,
  ext INTEGER NOT NULL DEFAULT 0, -- extractor version (staleness lives here)
  bytes INTEGER,
  updated_at REAL NOT NULL
);
CREATE TABLE collection (
  id TEXT PRIMARY KEY,            -- user-facing name ("anton", "fixtures")
  kind TEXT NOT NULL,             -- 'comfy' | 'folder' | 'virtual'
  address TEXT,                   -- host:port | folder:/abs/path | null
  link TEXT,                      -- virtual → backing collection (future)
  created_at REAL NOT NULL
);
CREATE TABLE entry (
  collection TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'output',  -- 'output' | 'input' (comfy dirs)
  hash TEXT REFERENCES content(hash),   -- null until ingested
  stamp TEXT,                           -- opaque source stamp (revalidation)
  state TEXT NOT NULL DEFAULT 'seen',   -- seen | ingested | gone
  vote TEXT, favorite INTEGER, notes TEXT, hidden INTEGER,
  plugin_fields TEXT,                   -- JSON, namespaced plugins.<name>
  first_seen REAL NOT NULL, last_seen REAL NOT NULL,
  PRIMARY KEY (collection, name, kind)
);
CREATE INDEX entry_by_hash ON entry(hash);
CREATE TABLE node_registry (      -- class_type → {title, inputs}
  class_type TEXT PRIMARY KEY,
  title TEXT, inputs TEXT NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);   -- meta_version etc.
```

Migrations are ordered and idempotent. v6→v7 folds `metadata`/`files`/
`images`/`input_cache` into `content`+`entry`, the settings hosts map into
`collection`, the per-host hidden lists onto entries, and drops the old
tables. A separate one-shot import folds `feedback.json` v1 into entry
judgment columns (§Judgments below).

### Cache (`~/.local/share/kosmozoo/cache/`, override `KOZMOZOO_CACHE`)

Layout `<ab>/<hash>.png` regardless of real type (→ extension-less §3.3).
Atomic writes only (tmp → rename). Unbounded.

### Ingestion (read → hash → cache → content → entry)

`src/ingest.mjs` is the ONLY module that turns bytes into rows: read from
the backing → SHA-256 → cache (atomic) → content row (+ dims, + extractor
output when the row's `ext` is stale) → entry (`hash`, `stamp`,
`state='ingested'`). The prefetch walk is this path running ahead of the
user; the bytes routes are this path running on demand. Revalidation is an
`Ingest` method (stale-while-revalidate over every backing kind).

### Serve path (cache-first)

`GET /api/images/<id>/bytes`: hash → cache hit (serve + debounced
revalidation) → read-through ingestion → host proxy as last resort (with
background ingest). A busy ComfyUI host is not a read outage.

### Judgments

Judgments are columns on `entry` (`vote`, `favorite`, `notes`,
`plugin_fields`) — sqlite is canonical and they are per (collection, name),
so two instances of the same content carry independent judgments. Writes go
through `judgmentPatch` (whitelisted fields, defaults deep-pruned, one
statement). The old hash-keyed `feedback.json` is imported ONCE at first
boot (fanned out to every entry with the hash; missing entries created as
`gone`), backed up to `<path>.v1-backup-<ts>`, and never written again.
`KOZMOZOO_FEEDBACK` is honored for that import only.

### Legacy import

`deno task import-legacy` merges the frozen Python `metadata.db` into the
local store (idempotent). (→ removed §3.2: its rows are hash-less metas,
which the v7 model discards by design — a fresh scrape re-derives them)

## 7. Plugin surfaces

The `kz` object handed to `register(kz)`:

| Call | Kind | Purpose |
|---|---|---|
| `kz.mode(id, def)` | capability | a composition mode (no SPA consumer today) |
| `kz.alignment(id, def)` | capability | an alignment contribution; `needs[].ok` may be a function — evaluated per `/api/plugins` request |
| `kz.route(method, path, handler)` | route | server route under `/api/plugins/<name><path>` |
| `kz.exporter(def)` | capability | a training-export sink (kept while a plugin uses it) |
| `kz.settings.get/set(k, v)` / `.ns()` | persistence | namespaced `plugins.<name>.*` settings |
| `kz.store.getField/setField(collection, name, field, v)` | persistence | plugin fields on the entry's `plugin_fields` |
| `kz.content.bytes(hash)` / `.graph(hash)` / `.bytesForEntry(collection, name)` | data | engine-mediated cache/graph reads |
| `kz.judgments.get/set(...)` / `.all()` | data | the core judgment record (entry columns) |
| `kz.reason(status, error, reason)` | response | the shared `{error, reason}` failure shape |

Underscore accessors are gone: no plugin reaches engine internals. The
variations feature moved to `src/features/variations/` (core feature, not a
plugin); the export plugin was deleted (a generic export returns later on
the entries API). A plugin may also ship `client.js`, served at
`/plugins/<name>/client.js`; the SPA does not load these today (§1).
