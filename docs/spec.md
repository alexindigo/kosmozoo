# Kosmozoo spec

Engine + client contracts for the Deno + Solid tree. The product rationale
lives in `~/Documents/kosmozoo/NORTH_STAR.md`; this file is the binding
contract for what exists here. The client architecture (store shape, feed
invariant, key dispatcher, feature modules, persisted-key registry) lives in
`~/Documents/kosmozoo/ARCHITECTURE.md`.

## 1. The three axes (design contract; plumbing dormant)

Comparison behaviour is designed as three independent axes, not a matrix of
toggles. Availability and reason derive from each mode's declared `needs`.

| Axis | Exclusive | Values | Shipped today |
|---|---|---|---|
| **Alignment** | yes | `independent` / `shared` / `face-anchored` | `detector` plugin registers `face-anchored` from its client half; the SPA does not load plugin client halves, so the axis is dormant |
| **Composition** | yes | `blend` / `split` / `difference` / `flicker` | `difference` plugin registers the mode from its client half; dormant for the same reason |
| **Attention (ROI)** | no | guides, region focus | not implemented |

What IS shipped: the feed (virtualized grid), the workbench (the two-sided
comparator — feed current × right-pane current, Kaleidoscope's four views
with shared pan/zoom; pair URL live), notes/vote/favorite/bookmark, anchor pane, and
the variations feature (server route + modal). The three plugin axes
(alignment / composition-as-plugins / ROI) stay dormant — Difference-the-view
is the canvas mask, not the `difference` plugin.

Keys are the primary input; the keys panel (`?`) lists the live bindings.

## 2. Engine API (public)

Resource-shaped, documented, treated as public. Collections + entries are
the resources; a collection's `capabilities` answer what its backing can do.

| Route | Methods | Notes |
|---|---|---|
| `/api/collections` | GET | configured collections, online probe, `kind`, `pinned`/`autoRefresh` booleans, `capabilities` (`list`/`read`/`add`/`delete` ∈ `trash`/`unlink`/`hide`, `rename`, `subfolders: {supported,reason}`) |
| `/api/collections` | POST | add a source-backed collection `{name, address, pinned?, autoRefresh?}`; flags default false; repeating the same name/address preserves existing flags; different address is 409 |
| `/api/collections/<id>` | PATCH | partial `{pinned?: boolean, autoRefresh?: boolean}`; validates the complete object before writing; invalid fields/types/null/arrays/malformed JSON are 400, unknown source is 404, empty object is a no-op; returns saved booleans without host/folder probing |
| `/api/collections/<id>` | DELETE | remove; refuses the last collection |
| `/api/collections/<id>/activity` | GET | cached engine-owned activity plus canonical flags; never probes a host; unknown source is 404; folders return `supported:false` and a reason |
| `/api/collections/<id>/entries` | GET | the feed listing: size, hash, state, meta, judgment, and dims — `COALESCE(content, entry)`, so an entry the dims pass reached carries width/height before it has a hash. Gone entries are excluded. `?inventory=1` returns the coherent output envelope described below; default remains an array. `?kind=input` lists the input dir instead |
| `/api/collections/<id>/entries/<name>` | GET | one entry |
| `/api/collections/<id>/entries` | POST | multipart upload into the input dir; **409 with the conflicting name, never an overwrite** |
| `/api/collections/<id>/entries/<name>` | DELETE | per capability: folder → unlink; comfy + assets_plus → trash; otherwise → hide + history cleanup |
| `/api/collections/<id>/entries/<name>/bytes` | GET | cache-first bytes (`?kind=input` for input-dir files); ETag is the content hash, `Cache-Control: no-cache` |
| `/api/collections/<id>/entries/<name>/bytes` | HEAD | 404 when the entry's bytes are unknown, else `content-length` |
| `/api/collections/<id>/entries/<name>/judgment` | PATCH | whitelisted fields (`vote`/`favorite`/`bookmark`/`notes`/`plugins.<ns>.*`), defaults deep-pruned, one statement |
| `/api/collections/<id>/feedback.json` | GET | the collection's judgments as a portable v2 document, generated on demand |
| `/api/collections/<id>/meta` | GET | versioned poll `?since=<v>` → `{v, changed, items?, dims?, pending}` — extracted metas and entry dims ride the same channel |
| `/api/collections/<id>/want` | POST | `{files}` — on-screen names jump the extraction queue; the whole name array validates before any queue mutation |
| `/api/content/<hash>` | GET | the content record + `instances: [{collection, name}]` |
| `/api/content/<hash>/bytes` | GET | cache bytes by hash (plugins, workbench) |
| `/api/prefetch` | GET, POST | the two-pass background ingestion: `enabled`/`paused` toggles, per-collection ingest `pending`, the pass totals `dimsPending`/`ingestPending`, and each collection's `lastError` |
| `/api/settings/<ns>` | GET, PATCH | namespaced settings (`core.*`, `plugins.<name>.*`) |
| `/api/plugins` | GET | discovered plugins + their declared capabilities |
| `/api/nodes` | GET | `class_type` registry discovered from extracted graphs |
| `/api/features` | GET | the registered feature modules (`variations`) |

Entry identity on the wire is the plain name under a collection; the
`collection:name` string survives only inside the client as a derived
accessor. Underneath it, identity is the content hash (§6).

For Comfy, `name` is the complete canonical output-root-relative POSIX path:
`image.png`, `a/image.png` and `b/image.png` are distinct addresses with independent
judgments, even when bytes share one content hash. Root names/schema v9 are
unchanged. Encode the entire name as **one** URL segment, for example
`/api/collections/fake/entries/a%2Fimage.png/bytes`. Router captures decode once;
literal `%2F` text is not recursively decoded into another path. Canonical Comfy
paths reject absolute/drive-absolute paths, backslashes, empty/repeated/trailing
segments, exact `.`/`..` segments and controls; ordinary percent, colon, hash,
spaces and Unicode retain their exact identity. Local folder names keep their
existing flat basename grammar. Named-entry and direct Ingest validation precedes
cache/store/backing access. Comfy reads, HEAD/range/stat, input references and
deletion split path into transport `subfolder` and leaf `filename` only at the
backing boundary. Hide-history matching also includes output type and directory.

### Output inventory and folder scope

`?inventory=1` returns `{revision, generation, coverage, subfolders, folders, entries, unavailable, chronology}`.
`revision` is an ephemeral address-owner epoch plus scan revision; `coverage` is
`recursive` or `root-only`; `subfolders` is `{supported, reason}`. `folders`
contains root `""` and every discovered image-directory ancestor. It is derived
from validated raw inventory before Kosmozoo hidden/gone/judgment overlay, and
published atomically with `entries`. Empty physical directories and AssetsPlus's
own hidden assets cannot be independently enumerated.

Complete discovery combines stock `/internal/files/output` roots with the
filesystem-backed AssetsPlus descendant list using `recursive=1`, `scan_depth=-1`,
`limit=0`, existing renderable extensions and `query=/`, without cursor/since/history.
The slash query matches all descendants and excludes every canonical root before
AssetsPlus's metadata inspection, so oversized root images cannot fail that scan.
Discovery retains stock root visibility but never provider ordering. Roots and
descendants use the same metadata-only HEAD Last-Modified authority, represented
as `modified:{atMs,precisionMs:1000,source:"http-last-modified"}`. Flat folders retain
filesystem `mtimeMs`, with `precisionMs:null` and source `filesystem-stat`.
One common finalizer sorts the whole union newest-first, then exact canonical name
using deterministic string comparison. Zero/pre-epoch times are valid; HTTP seconds
are not exact subsecond generation order, and timestamps never come from ETag,
history, observation time or cache maxima. AssetsPlus-only hidden root files
remain visible, as explicitly approved; Kosmozoo's own hidden/gone overlay and
AssetsPlus descendant hiding remain honored. Whole responses validate before publication;
conflicting duplicates, malformed records and truncation are errors. Definitive
extension absence permits explicit stock-root coverage with a disabled folder
control. A known recursive host's outage/incompatible response cannot downgrade
to root-only. Discovery is independent of the delete preference. Existing 10s
request timeouts apply; complete discovery/metadata waves have a 60s deadline.
Collection capability probes discover config separately
from inventory scans.

Context-owned address bindings for both drivers share immutable complete snapshots
and the common generation owner. Comfy metadata uses four concurrent HEADs per
owner, separate from the byte-read gate. Missing/invalid dates and HTTP/transport
failures reject incomplete chronology and retain prior data. Listing-to-HEAD 404
reconciles once and retries still-listed paths once; confirmed absences appear in
`unavailable`, preserving raw addresses for folder options. Available entries all
carry dates; `chronology:{order:"modified-desc",complete:true}` declares the contract.
Only a fresh, current worker-owned availability check may mark an entry gone,
bypassing cached dimensions/bytes. GET inventory schedules no such writes.

Explicit listing/refresh is fresh; background reads may reuse accepted snapshots
within the configured relist cadence, with zero new HEADs. Initial invalidation
coalesces a frozen follow-up target; further invalidations remain pending without
starving that reader. Reader completion is logically bounded to 120s, including
ignored-abort transports. Last-address removal/shutdown fences late results;
re-add gets a new epoch. Collection-incarnation tokens additionally protect async
overlay, worker queues and Ingest dimension/full-read/stat/remap/stamp commits,
including same-ID/address reuse while another alias survives. Byte single-flight/
revalidation throttle keys include incarnation; content cache keys do not change.
Prefetch relist counters acknowledge only the captured successful request; failed
or concurrently newer requests remain pending with bounded retry.
Listing schedules no ingestion writes; the existing worker/want paths acquire
dimensions and bytes.

The API overlay and browser folder/filter/judgment/known-size projections preserve
the finalized sequence as subsequences. The store retains `modified` in both load
and refresh without same-content enrichment restoring old dates. Single-entry GET
may expose a date from the accepted snapshot or null, without initiating a scan;
bytes HEAD remains cache/content metadata, not source chronology.

Root browsing includes every discoverable output; selected folder includes its
descendants by segment boundary, so `a` excludes `ab`. The SPA keeps complete
inventory and derives local folder/filename/judgment views without refetching on
folder selection. Selected IDs, drafts, zoom, anchors, source/metadata sessions
and edited feature state survive view exclusion. Missing image-derived folders
remain selected with an empty/unavailable option, empty feed and fileless URL.

The browser stores `kosmozoo.sourceBrowse.v1` as
`{version:1, hosts:{id:{address,folder,current}}}`: one address-checked pair per
host, independent per browser/origin. `current:null` is deliberate, distinct from
no record. Corrupt/future bytes are preserved; denied/quota storage falls back to
session memory with one reported error. Different-host tab writes merge without
storage-event navigation. Successful listing resolves a missing remembered image
within retained scope; offline/loading states never erase the pair. Source pin/
refresh flags and judgments remain SQLite-owned.

Feed URLs retain `#host[#encoded-full-name]`, with optional `folder` and `filter`
query parameters (empty values omitted), preserving unrelated query values.
Explicit feed/diff URLs and Back/Forward win over memory, including fileless
intent. Bare boot/source selection restores that host's pair. Folder changes keep
current if visible, otherwise choose first visible or null. Explicit image links
widen scope when needed and omit the outgoing filename filter; Back restores
previous folder/filter/image. Typing and current movement replace; source/folder/
link navigation can push. Refresh adopts live browsing intent, not an older URL.
Diff sources and filenames encode separately; both sides and folder/filter context
survive left stepping/mirroring/close. Clipboard references retain full paths;
individual downloads suggest `host#leaf` while requesting exact full-path bytes.

Nested variations match the exact producing node directory, retain that directory
and full-path lineage, and apply existing prefix/suffix/counter/NAME_MAX treatment
only to the leaf. Ambiguous nested producers and directory-bearing nested
prefix/suffix substitutions reject rather than guessing. Browsing scope is not a
generation destination.

Feature routes mount under `/api/features/<name><path>`: `variations`
serves `GET /probe/<id>` + `POST /run` (a core feature module, not a plugin).

Plugin routes mount under `/api/plugins/<name><path>`:

| Plugin | Routes |
|---|---|
| `detector` | `POST /detect`, `GET /status` |
| `critic` | `GET /status`, `POST /describe`, `POST /diff-describe`, `POST /caption` |
| `hello` | `GET /hello` |

Collections answer one capabilities shape (the ONE derivation —
`src/collections.mjs` — read by the listing, the delete route, and the
client's delete affordance alike):

| kind | list | read | add | delete | rename |
|---|---|---|---|---|---|
| `folder` | ✓ | ✓ | — | `unlink` (permanent) | — |
| `comfy` + assets_plus | ✓ | ✓ | ✓ (input-dir upload) | `trash` (recoverable) | — |
| `comfy` otherwise | ✓ | ✓ | ✓ | `hide` (kosmozoo-side flag + history cleanup) | — |
| `virtual` | schema slot only (future) | | | | |

A folder collection's address is `folder:/abs/path`; it lists renderable
extensions (png, jpg, jpeg, webp, gif, svg, avif, bmp), newest-first by
mtime, basename-only (no subdirectories, no traversal); its bytes come
straight from disk; the PNG extraction pipeline applies unchanged. A
non-directory `folder:` address is rejected at add time (400 with reason).

### Source activity and chrome

`Jobs` is context-owned; one single-flight read loop per distinct Comfy address
observes all sources, including unselected/unpinned ones. Aliases share runtime
activity and upstream reads, but their SQLite pin/refresh flags are independent.
Runtime registration reconciles address references; removal of the last alias
aborts its reads. Re-add has a fresh epoch. `start:false` starts no timers;
shutdown stops/aborts monitoring. Cadence is 2s active/queued, 5s idle, failure
backoff capped at 30s. Folder sources invoke no generation telemetry.

The backing uses GET `/api/queue`, retained/targeted `/api/history` and best-effort
`/internal/logs/raw`, with the existing 10s timeout plus an owner abort signal.
Queue/history failures are not empty results. No graph, submitting client ID,
arbitrary raw log or direct browser-to-Comfy connection crosses the activity API.

Supported snapshots contain `epoch`, `state` (`unknown`, `idle`, `running`,
`disconnected`), `sampledAt`, `runningCount`, `queuedCount`, `runningPromptId`,
`progress` (null or `{value,max,fraction}`), `terminalRevision`, `resyncRevision`,
`historyGap` and `error`. Before successful observation the state is unknown.
Counters are best-effort **current-operation** progress, not workflow percentage
or proof that outputs finished saving. Log snapshots are associated only with
bracketed stable prompt identity and content continuity; stale/ambiguous counters
are indeterminate, and disconnect/idle/prompt replacement clears fill. A slow
unchanged operation count remains valid. Transfer-byte counters are excluded.

Startup establishes full retained-history baseline without replaying old finishes.
Regular history reads start at 64 and expand until the previous completion
boundary is found or retained history is exhausted. Distinct terminal IDs advance
the revision, including jobs entirely between polls, error/interruption and jobs
without outputs. Vanished queue identities remain unresolved until targeted
history proves terminal execution. Terminal evidence wins over stale queue data.
Recovery/coverage gaps request freshness catch-up, without inventing successful
jobs whose history was erased before observation. Stock APIs cannot supply a
lossless audit of erased history or pending jobs submitted/deleted between samples.

Saved `autoRefresh` requests a prefetch relist on terminal/catch-up notifications;
the existing worker discovers outputs and runs dimension/ingestion passes,
honoring its pause/politeness behavior. Entry GETs remain side-effect-free.
The browser polls cached activity independently of metadata work, with per-source
single-flight/backoff and lifecycle fences. Enabled-source completion and manual
refresh use one selected-session incremental merge lane; completions during a
read leave a follow-up pending, and failures retain the target for retry.
The first known activity snapshot is coordinated with initial feed loading;
unknown startup telemetry is not consumed as a baseline. If the feed loaded
first, known activity requests freshness catch-up without replaying old history
as new terminal jobs. Inactive sources never steal focus or write the selected
feed. Load/metadata/want/size results are source-session-owned, including A→B→A
navigation. Judgment read protection, newer same-content enrichment, keyed editing
nodes, viewport anchors, bulk selection, URL/current/trail, notes, zoom, anchors
and workbench state survive incremental arrivals. Unknown-size arrivals are
wanted and acquire real dimensions. Grid rendering uses entry-ID strings, with
current measurement sizes resolved separately; replacing measurement objects
does not remount retained cards.

Feed-side topbar order: logo/wordmark, refresh icon, host dropdown, controlled
native Output folder selector, separated pinned sources,
flexible space, filename filter. Pinned buttons forward the dropdown's selection
action; circles are grey idle, filled SVG sectors for available counters, distinct
active outlines when indeterminate, and warning/unknown treatments without stale
fill. Source-row pin and auto-refresh toggles save independently without selecting
or closing the dropdown. Folder refresh controls are disabled with an explicit
reason; pinned folders have a grey circle labelled with their no-generation reason.
The filter opens/focuses immediately left of its icon; click/Escape collapses
without clearing its query. Header owns a separate split synchronized through
the existing store-owned pane width, with scoped bounds matching the main pane
and its adjacent divider/bar footprint. Main composition and its layout styles
are unchanged; the filter follows the actual feed edge. Unhide/Hide up-voted
chrome buttons are removed; their session visibility actions and judgment
preferences remain available to existing non-chrome consumers.

The pinned group has a non-scrolling vertical separator only when pins exist,
with smaller gaps inside its scrollable button strip. Empty pins retain flexible
allocation. Folder labels truncate within compact allocations with full path in
the accessible title; unsupported controls expose a root-only reason. Native
select typing retains precedence in the existing key dispatcher.

The existing feed rail current marker follows live viewport midpoint-crossing
geometry during valid scrolling, then committed current after settle. One shared
pure selector maps known-size virtual positions to IDs and rejects stale item-key
geometry. The marker is read-only presentation, never another stored pointer:
current/trail/URL/browser pair/metadata/comparison remain on the existing 150ms
settle policy. Debounce callbacks belong to their source session, browse intent
and registered seams; explicit context/current/diff navigation retires old work.
Settle batches current and marker reconnection. Compensation and an open workbench
retain committed marker/current; snap-quiet restore/scrub/top track actual motion.
Ordinary rail ticks use the existing subdued `--foreground-dim` neutral through
shared card-state presentation; card neutrals, judgment colors/priorities, wave
length/glow, geometry, tape windowing and scrub handlers retain their contracts.

Static surfaces: `/shared/<name>` serves the allow-listed `src/` modules
(`extractor.mjs`, `features/variations/shared.mjs`, `entry-path.mjs`) to the browser;
`/plugins/<name>/client.js` serves a plugin's client half; `/` and `/diff`
serve the Solid app from `client-solid-dist/`, with shared assets (`/css`,
`/vendor`, `/js`, logos) from `client/`.

### Client commands and modal ownership

Application inputs follow **input → shared handle → private operation**. The plain
per-store registry returns stable source-independent ports via
`store.handles.get(id)`; `store.handles.invoke(id,args)` resolves that same port.
Definitions validate data (not events/DOM/functions), preserving action results/
Promises. Covered compatibility actions delegate to handles; mechanical/read/
editor/lifecycle ports are explicitly classified. Ordered bindings reference
commands with constant arguments/context/routing through one injected adapter.
All twelve IDs/defaults/descriptions/matching/conflicts/saved-reset behavior remain.
KeysPanel edits mappings; no new shortcut or command-launch control is introduced.

Input eligibility is separate from semantic execution. Capture/bubble routing
retains native select/typing/capture precedence and intentional decline. Accepted
false/no-op/Promise requests consume input. Token-specific layer cleanup cannot
erase a replacement owner. Popup capture Escape priority is retained except below
an owned blocking decision. An injected result adapter observes async errors
without replacing returned Promises. Programmatic mode/column/lock configuration
remains callable independently of keyboard/UI pair/workbench gates.

All card/bulk/button/menu/programmatic commands converge through judgment,
navigation/selection/reference, download/delete, source/folder/filter, workspace/
layout/preferences and anchor handles. Implicit IDs resolve before await/visibility
mutation; source toggle interpretation remains in the serialized writer. Both
native feedback links retain href/download and modified/auxiliary/context resource
behavior; primary activation uses `collection.feedback.download` with the explicit
originating source and actual v2 JSON download, without duplicate activation or
synthetic outside-click propagation. Features contribute command definitions,
data bindings and affordances through the registry, without feature-name dispatch.

Variations owns form/baselines/File references/order, dirty comparison, decision,
focus/caret and Run state. Its bridge contains opening metadata, a fresh scalar
session and owner-safe request capabilities only. Dirty close/replacement shows
**“Discard your changes?”**, **“Keep editing”** and **“Discard changes”** inside
the still-mounted panel, outside its inert editor. Escape cancels only the decision;
Cancel preserves exact form/widget/file identity and URL. Identical requests share
one terminal Promise/continuation/permit; conflicts return busy, and stale/disposal/
error paths settle safely. Raw incomplete increment text survives blur unchanged.
SliderRow retires active widget listeners with the matching original-target
terminal adaptation and quarantines that physical gesture through release/cancel.

Run/button/handle input enters `variations.run` and the owner's requestRun. All draft
domains/opening targets are captured before upload, running/pending-leave requests
return busy, and owner/Run fences protect unsent work/results/timers. Different-
backend local files reject before uploads. Full success needs valid positive
complete counts on every target with no failures. Counts acknowledge no field
usage: edited/unused/dormant work stays dirty even on success. The existing three-
second close requires the same alive Run/edit revision, unchanged clean draft and
no decision. Submitted jobs continue after dismissal. Source/folder/filter/Back/
Forward browsing retains the modal and captured targets.

## 3. Judgment model

| Concept | Meaning | Persistence |
|---|---|---|
| `vote` up/down | decision signal about project fitness | `entry` column, per (collection, name) |
| `favorite` | interesting in itself, independent of fit | same |
| `bookmark` | return to this image later, independent of favorite | same |
| `hidden` | delete fallback on hosts that can't delete | `entry` column, per (collection, name) |

- Down-vote **hides by default**; the coupling is the
  `core.judgment.downvoteHides` setting.
- "Show thumbed-down" is a temporary reveal, never a data deletion.
- Notes: `pos` / `neg` free text, debounced autosave; defaults are
  deep-pruned (a field set to its default is stored as absent).
- Core judgment record stays small: notes, vote, favorite, bookmark. Plugin fields
  live in the entry's `plugin_fields` JSON, namespaced `plugins.<name>`.
- The card action row uses an icon-only download control and a sky-blue
  bookmark toggle between star and download. Existing favorites never become
  bookmarks automatically. All judgment intents (button, bulk, keyboard, or
  programmatic) share one entry-ID handler. Optimistic state, serialization,
  confirmation, read protection, and rollback are shared, not per control.
  Note edits carry their original entry ID and merge signs in the handler.
- One card-state derivation supplies active control flags and presentation
  tokens. Border treatment is favorite (orange), else bookmark (sky blue),
  else vote; current retains that color or supplies white when untreated.
  Card and rail consume the same color token. The tick has no judgment-specific
  color logic. Border and inset-shadow geometry exist in every state; only
  colors change. Non-current shadow blends into the background; current shadow
  follows the treatment. Decoration never changes card height.

## 4. Knowledge harvest (from the outgoing implementation)

Non-obvious behaviour the rewrite must not rediscover one bug at a time.

| # | Lesson | Outgoing evidence |
|---|---|---|
| 1 | Navigation needs a load-generation guard | `index.html:2302`, `2312` |
| 2 | Outgoing view state must be written back before the incoming view is read | `index.html:2402` |
| 3 | Cover the swap: hold the outgoing frame until the incoming image loads | `index.html:2287–2300`, `2326` |
| 4 | Derived state must never persist over its source | charter invariant 1 |
| 5 | List progress needed three independent mechanisms (sentinel, scroll safety net, programmatic restore) only because sizes were unknown at render; with size-before-render (ARCHITECTURE.md) a deep jump is one `scrollToIndex` and the safety net is gone | charter, list engine |
| 6 | Unload by `removeAttribute('src')` — aborts the fetch and releases decoded bytes | `index.html:1442` |
| 7 | Never cache a `null` detection — a transient failure would poison that image permanently | `index.html:2966–2971` |
| 8 | Scraper politeness set: single-flight, 100 ms gaps, backoff capped 30 s, HTTP 404 ⇒ permanent, two-tier queue with on-screen priority, pause gate — restored in the prefetch (per-collection backoff; `want` promotes in both passes) | `server.py:810–890` |
| 9 | Graph inputs arrive as arrays when they are links — scalar probes must filter | `server.py:493–501` |
| 10 | Prompt-text walk: ≤8 hops, `zeroout` on the path ⇒ empty string | `server.py:466–481` |
| 11 | PNG text chunks: stop at first `IDAT`, cap at 256 KB | `server.py:703–748` |
| 12 | Guides persist globally, not per-image | `kosmozoo.guides.v1` |
| 13 | Judgment entries prune only when fully empty; a field set to its default is stored as absent — restored (`judgmentPatch` deep-prunes) | `server.py:756–778` |
| 14 | Manual image retry must cache-bust, or a partial cached response is reused | `index.html:1427–1438` |
| 15 | ~20 ComfyUI `class_type` probes are empirical field data, not architecture — port them verbatim | `server.py:516–683` |

## 5. Boundaries

- The engine is native ESM on Deno; the only engine dependency is
  `jsr:@db/sqlite@0.13.0`.
- The client is **built**: Solid JSX compiled by
  `deno run --allow-all build.mjs` (Babel + `babel-preset-solid` from pinned
  esm.sh URLs, no Vite, no npm) from `client-solid/` into
  `client-solid-dist/`; framework-free modules stay in `client/js/`.
  Solid, the virtualizer, and noUiSlider (ESM) are vendored dists with
  vendor-time path rewrites and the `process.env.NODE_ENV` substitution
  (no bundler, no `process` in the browser); `fetch-vendor-solid.sh`
  regenerates files and `client/vendor/CHECKSUMS` together, and
  `tests/t_vendor_pristine.mjs` fails a hand edit.
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

Identity is content hash (SHA-256). `collection:name` is an address, not
an identity.

### State location

State dir resolution: `KOZMOZOO_STATE` if set, else
`$XDG_STATE_HOME/kosmozoo` (default `~/.local/state/kosmozoo`) — the repo
working tree is never a state dir. Env overrides: `KOZMOZOO_PORT` (default
2084), `KOZMOZOO_HOSTS` (first-boot seed), `KOZMOZOO_STATE`,
`KOZMOZOO_FEEDBACK` (migration import only), `KOZMOZOO_CACHE`,
`KOZMOZOO_PLUGINS`, `KOZMOZOO_REVALIDATE_MS`.

### Schema (`metadata.db`, `PRAGMA user_version = 9`, ordered migrations)

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
  created_at REAL NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  auto_refresh INTEGER NOT NULL DEFAULT 0 CHECK (auto_refresh IN (0, 1))
);
CREATE TABLE entry (
  collection TEXT NOT NULL REFERENCES collection(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'output',  -- 'output' | 'input' (comfy dirs)
  hash TEXT REFERENCES content(hash),   -- null until ingested
  stamp TEXT,                           -- opaque source stamp (revalidation)
  state TEXT NOT NULL DEFAULT 'seen',   -- seen | ingested | gone
  vote TEXT, favorite INTEGER, bookmark INTEGER, notes TEXT, hidden INTEGER,
  plugin_fields TEXT,                   -- JSON, namespaced plugins.<name>
  width INTEGER, height INTEGER,        -- dims known before the hash is (dims pass)
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
v7→v8 adds the nullable `bookmark` column without changing existing judgments.
v8→v9 transactionally adds the source flag columns, checking existing columns
so a partial/version-write interrupted migration can be retried. Source flags
are canonical SQLite attributes, shared by browsers and retained across restarts;
they are not engine settings or browser convenience storage. Runtime activity
and revision epochs are ephemeral and never persisted.

### Cache (`~/.local/share/kosmozoo/cache/`, override `KOZMOZOO_CACHE`)

Layout `<ab>/<hash>` — extension-less; the mime is sniffed from the bytes
at serve time. Atomic writes only (tmp → rename). Unbounded.

### Ingestion (read → hash → cache → content → entry)

`src/ingest.mjs` is the ONLY module that turns bytes into rows: read from
the backing → SHA-256 → cache (atomic) → content row (+ dims, + extractor
output when the row's `ext` is stale) → entry (`hash`, `stamp`,
`state='ingested'`). The bytes routes are this path running on demand;
revalidation is an `Ingest` method (stale-while-revalidate over every
backing kind).

`Ingest.dims(collection, name)` is the pre-ingest half: dims live in a
file's first bytes (PNG IHDR, GIF descriptor, WebP VP8*, JPEG SOF), so a
64 KB ranged head read (`Range: bytes=0-65535`; full-read fallback on a
200-without-206) + `imageDims` stores them on `entry.width/height` — no
hash, no cache write, no extract. Known dims (content via the entry's
hash, or the entry columns) short-circuit the read; a 404 head read tells
the prefetch the source lost the file, and the prefetch marks the entry
`gone`.

The prefetch runs TWO passes over each collection's listing: pass 1 the
dims head reads (10 ms inter-file — size-before-render on a fresh host is
fast), pass 2 the full ingestion above at the existing politeness
(100 ms). Each collection gets its OWN async worker with its own inter-file
delays and backoff — one host's outage never stalls another; a worker's
failure is logged, surfaced as its `lastError` on `/api/prefetch`, and the
worker restarts after the backoff cap. The dims queue drains before
ingestion starts; `want` (on-screen names) promotes in both queues;
per-collection backoff caps at 30 s; 404 ⇒ `entry.state='gone'`
(permanent); the pause gate holds both passes.

### Serve path (cache-first)

`GET /api/collections/<id>/entries/<name>/bytes`: hash → cache hit (serve
+ debounced revalidation) → read-through ingestion → backing proxy as last
resort (with background ingest). A busy ComfyUI host is not a read
outage.

### Judgments

Judgments are columns on `entry` (`vote`, `favorite`, `bookmark`, `notes`,
`plugin_fields`) — sqlite is canonical and they are per (collection, name),
so two instances of the same content carry independent judgments. Writes go
through `judgmentPatch` (whitelisted fields, defaults deep-pruned, one
statement). The old hash-keyed `feedback.json` is imported ONCE at first
boot: hash keys fan out to every entry with the hash; a key matching no
entry is recovered via the judgment's `ref` (`<host>:<filename>` — the
entry is created `gone` with the hash set); anything unrecoverable is
counted as dropped and logged. The imported document is copied to
`<path>.v1-backup-<ts>` and never written again. `KOZMOZOO_FEEDBACK` is
honored for that import only.

## 7. Plugin surfaces

The `kz` object handed to `register(kz)`:

| Call | Kind | Purpose |
|---|---|---|
| `kz.mode(id, def)` | capability | a composition mode (no SPA consumer today) |
| `kz.alignment(id, def)` | capability | an alignment contribution; `needs[].ok` may be a function — evaluated per `/api/plugins` request |
| `kz.route(method, path, handler)` | route | server route under `/api/plugins/<name><path>` |
| `kz.settings.get/set(k, v)` / `.ns()` | persistence | namespaced `plugins.<name>.*` settings |
| `kz.store.getField/setField(collection, name, field, v)` | persistence | plugin fields on the entry's `plugin_fields` |
| `kz.content.bytes(hash)` / `.graph(hash)` / `.bytesForEntry(collection, name)` | data | engine-mediated cache/graph reads |
| `kz.judgments.get/set(...)` | data | the core judgment record, per entry (entry columns) |
| `kz.reason(status, error, reason)` | response | the shared `{error, reason}` failure shape |

Underscore accessors are gone: no plugin reaches engine internals. The
variations feature moved to `src/features/variations/` (core feature, not a
plugin); the export plugin was deleted (a generic export returns later on
the entries API). A plugin may also ship `client.js`, served at
`/plugins/<name>/client.js`; the SPA does not load these today (§1).
