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

Resource-shaped, documented, treated as public. **→ the host-shaped routes
are replaced by collections/entries in cruft-cleanup §3.2.**

| Route | Methods | Notes |
|---|---|---|
| `/api/hosts` | GET | configured hosts (ComfyUI `host:port` + `folder:<path>`), online probe, `deleteMode` (`hide`/`trash`/`unlink`) |
| `/api/hosts` | POST | add a host `{name, address}`; persists `core.hosts.map` |
| `/api/hosts/<name>` | DELETE | remove; refuses the last host |
| `/api/images?host=<name>` | GET | full listing for one host: id, size, meta, extraction state, judgment. Feeds the background walk as a side effect (→ §3.3) |
| `/api/images/<id>` | GET | one image: meta + judgment |
| `/api/images/<id>` | DELETE | folder → unlink; ComfyUI + assets_plus (toggle permitting) → trash; otherwise → hide (persisted, §3) + best-effort history cleanup |
| `/api/images/<id>/bytes` | GET | cache-first bytes; ETag is the content hash, `Cache-Control: no-cache`; falls back to proxy + background ingest |
| `/api/images/<id>/bytes` | HEAD | size probe: 200 when the host is known, `content-length` when the size is known |
| `/api/input-list/<host>` | GET | ComfyUI input-dir listing (folder host: the directory itself); `[]` on host error |
| `/api/upload-input/<host>` | POST | multipart forward into a ComfyUI input dir; **overwrites on name clash today** (→ §3.1) |
| `/api/input-bytes/<host>/<filename>` | GET | input-dir bytes via the hash cache: folder stamps inline, ComfyUI stale-while-revalidate |
| `/api/judgments/<id>` | GET, PUT, DELETE | notes/vote/favorite + namespaced plugin fields; PUT has no field whitelist today (→ §3.3) |
| `/api/settings/<ns>` | GET, PATCH | namespaced settings (`core.*`, `plugins.<name>.*`) |
| `/api/plugins` | GET | discovered plugins + their declared capabilities |
| `/api/nodes` | GET | `class_type` registry discovered from extracted graphs |
| `/api/scraper` | GET, POST | metadata scan: `enabled`/`paused` toggles + per-host pending counts |
| `/api/feedback` | GET | the live `feedback.json` document as a download (→ §3.2) |
| `/api/feedback-path` | PUT | relocate the feedback document live (→ §3.2) |
| `/api/metadata?host=<name>` | GET | versioned meta poll `{items, pending, v}`; the client merges when `v` moves |
| `/api/meta-want` | POST | `{host, files}` — on-screen names jump the extraction queue (the priority lane is broken today — audit E12; → §3.2) |
| `/api/downloads-check` | POST | which filenames exist in the downloads dir (→ removed §3.2) |

Image identity on the wire is `host:filename` (→ §3.2: plain entry names
under collections). Underneath it, identity is the content hash (§6).

Plugin routes mount under `/api/plugins/<name><path>`:

| Plugin | Routes |
|---|---|
| `variations` | `GET /probe/<id>`, `POST /run` (→ becomes a core feature §3.4) |
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
| `vote` up/down | decision signal about project fitness | `feedback.json`, keyed by content hash (→ entry column §3.2) |
| `favorite` | interesting in itself, independent of fit | same |
| `hidden` | delete fallback on hosts that can't delete | **persisted** per host in `core.delete.hidden` (→ §3.2) |

- Down-vote **hides by default**; the coupling is the
  `core.judgment.downvoteHides` setting.
- "Show thumbed-down" is a temporary reveal, never a data deletion.
- Notes: `pos` / `neg` free text, debounced autosave. Prune-when-empty is
  shallow today (empty objects can persist — audit D5; → §3.2).
- Core judgment record stays small: notes, vote, favorite. Plugin fields
  live under `plugins.<name>` in the same record.

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
- `feedback.json` is a portable JSON document outside the repo (→ sqlite
  canonical §3.2).
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
`metadata.db` / `settings.json` / `feedback.json` in the working tree
(untracked). (→ XDG-by-default §3.3.) Env overrides: `KOZMOZOO_PORT`
(default 2084), `KOZMOZOO_HOSTS`, `KOZMOZOO_STATE`, `KOZMOZOO_FEEDBACK`,
`KOZMOZOO_DOWNLOADS` (→ removed §3.2), `KOZMOZOO_PLUGINS`,
`KOZMOZOO_REVALIDATE_MS`.

### Schema (`metadata.db`, `PRAGMA user_version = 6`, ordered migrations)

```sql
CREATE TABLE metadata (           -- v1: address-keyed, pre-hash rows
  host TEXT NOT NULL, filename TEXT NOT NULL,
  meta TEXT, source TEXT,
  has_workflow INTEGER NOT NULL DEFAULT 0,
  nopng INTEGER NOT NULL DEFAULT 0,
  ext INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL,
  PRIMARY KEY (host, filename)
);
CREATE TABLE files (              -- v2: address → hash
  host TEXT NOT NULL, filename TEXT NOT NULL,
  hash TEXT,                      -- sha256; null until ingested
  size INTEGER,
  mtime REAL,                     -- v3; superseded by stamp
  stamp TEXT,                     -- v6: opaque source stamp (folder mtime / ComfyUI ETag)
  PRIMARY KEY (host, filename)
);
CREATE INDEX files_by_hash ON files(hash);
CREATE TABLE images (             -- v2: hash-keyed extractor output
  hash TEXT PRIMARY KEY,
  meta TEXT, source TEXT,
  has_workflow INTEGER NOT NULL DEFAULT 0,
  nopng INTEGER NOT NULL DEFAULT 0,
  ext INTEGER NOT NULL DEFAULT 0,
  updated_at REAL NOT NULL
);
CREATE TABLE node_registry (      -- v4: class_type → {title, inputs}
  class_type TEXT PRIMARY KEY,
  title TEXT, inputs TEXT NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE input_cache (        -- v5/v6: input-dir address → hash + stamp
  host TEXT NOT NULL, filename TEXT NOT NULL,
  hash TEXT NOT NULL, stamp TEXT,
  PRIMARY KEY (host, filename)
);
```

Migrations are ordered and idempotent; a boot-time `#migrateFromJson` folds
a legacy `metadata.json` into sqlite when `metadata` is empty.
(→ all of this folds into content/collection/entry §3.2.)

### Cache (`~/.local/share/kosmozoo/cache/`, override `KOZMOZOO_CACHE`)

Layout `<ab>/<hash>.png` regardless of real type (→ extension-less §3.3).
Atomic writes only (tmp → rename). Unbounded.

### Ingestion (read → hash → cache → index)

Bytes flow: read from host → SHA-256 → cache (atomic) → `files.hash/size/
stamp` → extractor output into `images`. The address-keyed `metadata` row
is **copied**, not moved — both tables stay live and reads de-dup across
them (→ one ingestion path, one table set §3.2).

### Serve path (cache-first)

`GET /api/images/<id>/bytes`: hash → cache hit (serve + debounced
revalidation) → read-through ingestion → host proxy as last resort (with
background ingest). A busy ComfyUI host is not a read outage.

### Judgments

`feedback.json` (versioned document, `version: 1`) keyed by content hash
with a human-readable `ref: "<host>:<filename>"` per entry. Legacy
`host:filename` keys are re-keyed at startup and lazily on write; orphan
entries keep their keys. Path: `core.feedbackPath` setting →
`KOZMOZOO_FEEDBACK` → `<state dir>/feedback.json`. (→ sqlite canonical,
per-collection export §3.2.)

### Legacy import

`deno task import-legacy` merges the frozen Python `metadata.db` into the
local store (idempotent). (→ removed §3.2: its rows are hash-less metas,
which the v7 model discards by design — a fresh scrape re-derives them)

## 7. Plugin surfaces

The `kz` object handed to `register(kz)`:

| Call | Kind | Purpose |
|---|---|---|
| `kz.mode(id, def)` | capability | a composition mode (no SPA consumer today) |
| `kz.alignment(id, def)` | capability | an alignment contribution (no SPA consumer today) |
| `kz.route(method, path, handler)` | route | server route under `/api/plugins/<name><path>` |
| `kz.probe(def)` | capability | registered, **no consumer** (→ removed §3.4) |
| `kz.exporter(def)` | capability | registered, **no consumer** (→ removed §3.4) |
| `kz.settings.get/set(k, v)` / `.ns()` | persistence | namespaced `plugins.<name>.*` settings |
| `kz.store.getField/setField(host, file, field, v)` | persistence | plugin fields on the judgment record |
| `kz.judgments.get/set(...)` | data | the core judgment record (notes/vote/favorite) |
| `kz.judgments._all()` | internal | every judgment (batch exporters) (→ §3.4) |
| `kz._hashFor(host, filename)` | internal | resolve hash from address (→ §3.4) |
| `kz._cacheGet(hash)` | internal | read cached image bytes (→ §3.4) |
| `kz._hostAddr(host)` | internal | resolve host name to address (→ §3.4) |
| `kz._fetchImageBytes(key)` | internal | fetch image bytes via the engine (→ §3.4) |

Methods prefixed `_` are engine-internal accessors, not part of the public
contract; both shipped server plugins (variations, export) cannot function
without them today (→ public replacements + underscore removal §3.4).
A plugin may also ship `client.js`, served at `/plugins/<name>/client.js`;
the SPA does not load these today (§1).
