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
| **Alignment** | yes | `independent` / `shared` / `face-anchored` | `detector` plugin declares `face-anchored` in the engine; no SPA consumer, so the axis is dormant |
| **Composition** | yes | `blend` / `split` / `difference` / `flicker` | `difference` plugin declares the mode in the engine; dormant for the same reason |
| **Attention (ROI)** | no | guides, region focus | not implemented |

What IS shipped: the feed (virtualized grid), the workbench (the two-sided
comparator — feed current × right-pane current, per-kind views
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
| `/api/runtime` | GET | version1 cached engine identity: `protocol`, `version`, instance nonce, source-input version, mode, startup/ready/stopping status, actual binding and configured bind; plus `app: {version, revision}` from the startup-read `VERSION` and optional build revision (separate from the lease protocol); no SQL/source/plugin work, no absolute state path; identity plumbing, not authentication |
| `/api/collections` | GET | configured collections, captured `incarnation`/`sourceVersion` and flags, online probe, `kind`, `capabilities` (`list`/`read`/`add`/`delete` ∈ `trash`/`unlink`/`hide`, `rename`, `subfolders: {supported,reason}`) |
| `/api/collections` | POST | add a source-backed collection `{name, address, pinned?, autoRefresh?}`; flags default false; repeating the same name/address preserves existing flags; different address is 409 |
| `/api/collections/<id>` | PATCH | partial `{pinned?: boolean, autoRefresh?: boolean}`; validates the complete object before writing; invalid fields/types/null/arrays/malformed JSON are 400, unknown source is 404, empty object is a no-op; returns saved booleans and their committed `sourceVersion` without host/folder probing |
| `/api/collections/<id>` | DELETE | remove; refuses the last collection |
| `/api/events` | GET | one native SSE delivery connection per app tab; complete version1 authoritative cached source maps, no upstream probe/list/monitor creation |
| `/api/collections/<id>/entries` | GET | the feed listing: size, hash, state, meta, judgment, and dims — `COALESCE(content, entry)`, so an entry the dims pass reached carries width/height before it has a hash. Gone entries are excluded. `?inventory=1` returns the coherent output envelope described below; default remains an array. `?kind=input` lists the input dir instead |
| `/api/collections/<id>/entries/<name>` | GET | one entry |
| `/api/collections/<id>/entries` | POST | multipart upload into the input dir; **409 with the conflicting name, never an overwrite** |
| `/api/collections/<id>/entries/<name>` | DELETE | per capability: folder → unlink; comfy + assets_plus → trash; otherwise → hide + history cleanup |
| `/api/collections/<id>/entries/<name>/bytes` | GET | cache-first bytes (`?kind=input` for input-dir files); ETag is the content hash, `Cache-Control: no-cache`; single-byte ranges (§Serve path) |
| `/api/collections/<id>/entries/<name>/bytes` | HEAD | 404 when the entry's bytes are unknown, else `content-length` |
| `/api/collections/<id>/entries/<name>/judgment` | PATCH | whitelisted fields (`vote`/`favorite`/`bookmark`/`notes`/`plugins.<ns>.*`), defaults deep-pruned, one statement |
| `/api/collections/<id>/feedback.json` | GET | the collection's judgments as a portable v2 document, generated on demand |
| `/api/collections/<id>/meta` | GET | versioned identity delta `?since=<v>` → `{v, changed, items?, dims?, pending}`; no cursor gives a full snapshot; pending includes dimension work |
| `/api/collections/<id>/want` | POST | `{files, interest?:"full"\|"dimensions", priority?:"foreground"\|"background"}`; legacy defaults full/foreground; all names/options validate before queue mutation; reply `{pending, items, dims}` carries the named entries' already-known metadata (full interest only) and dimensions |
| `/api/content/<hash>` | GET | the content record + `instances: [{collection, name}]` |
| `/api/content/<hash>/bytes` | GET | cache bytes by hash (plugins, workbench); same single-byte-range semantics |
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

`?inventory=1` returns `{revision, generation, coverage, subfolders, folders, entries, unavailable, chronology, arrivals}`.
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

Complete inventory acceptance observes visible names in memory, independently
of file timestamps and ingestion. Each name gets a per-source session sequence
once; relists/revalidation do not manufacture arrivals. The existing source stream
delivers only `{sequence,latestVisibleSeq}` to all browsers, or null before the
first complete inventory. Missing/hidden/gone/deleted entries do not contribute
to `latestVisibleSeq`; deletion retires membership immediately. Inventory entries
carry their `arrivalSeq`. Source retirement discards this in-memory history.

Each browser baselines its own in-memory seen value at the first projection,
keeps its viewed source current, and clears attention when opening another source.
An unselected source is new while its latest visible sequence exceeds that value.
Reload starts quiet; nothing is persisted or written back to the engine. Selected
sources never show orange. Pills and picker entries consume the same state and
“New images.” wording, using `--attention` for text/edge without pulsing or layout
change. There is no extra transport or browser inventory poll.
Runtime source membership reconciles the existing headless workers as boot does,
so a new unselected source does not await browser demand to join observation.

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
extensions (png, jpg, jpeg, webp, gif, svg, avif, bmp, mp4, webm, mov, flac, mp3, opus, wav), newest-first by
mtime, basename-only (no subdirectories, no traversal); its bytes come
straight from disk; the shared media extraction pipeline applies unchanged. A
non-directory `folder:` address is rejected at add time (400 with reason).

Comfy source addresses accept `host[:port]` over HTTP only, without a URL scheme
or IPv6 literal. Omitting the port means 80; explicit ports must be decimal whole
numbers from 1 through 65535. One normalization owner in `src/collections.mjs`
serves API admission and environment seeds. Only `host:port` is stored and shown
in the picker: `comfy.home` becomes `comfy.home:80`. Repeating either spelling
under the same name is the same source; a different port remains a 409 conflict.
Existing stored addresses and source origins are unchanged.

### Source activity and chrome

`Jobs` is context-owned; one single-flight read loop per distinct Comfy address
observes all sources, including unselected/unpinned ones. Aliases share runtime
activity and upstream reads, but their SQLite pin/refresh flags are independent.
Runtime registration reconciles address references; removal of the last alias
aborts its reads. Re-add has a fresh epoch. `start:false` starts no timers;
shutdown stops/aborts monitoring. Cadence is 2s active/queued, 5s idle, failure
backoff capped at 30s. Folder sources invoke no generation telemetry.

The same address monitor owns one receive-only ComfyUI `/ws` connection with
an independent random clientId, a 10s connection deadline and 1–30s reconnect
backoff. It never sends messages or submits work. Binary previews and oversized
or malformed text frames are ignored. Last-alias removal and engine stop close
the socket and retire callbacks/retries. Queue/history remain authoritative:
socket loss clears optional live enrichment without changing running/idle or
delaying completion. No socket starts under `start:false`.

The authoritative lane uses GET `/api/queue` and retained/targeted `/api/history`.
It installs completion snapshots and notifies relisting without awaiting optional
progress. A separate prompt-owned flight reads best-effort `/internal/logs/raw`
and brackets it with queue identity; it cannot delay the next authoritative tick.
Both lanes use the existing 10s backing timeout and owner abort signals. Progress
retires on prompt change, disconnect, last-address removal or stop, and late
results cannot decorate a replacement. Even an ignored abort cannot create a
second physical auxiliary flight in that monitor. Stock `{size:{cols,rows},entries}`
and legacy numeric-size log envelopes normalize at the backing boundary.
Queue/history failures are not empty results. No graph, submitting client ID,
arbitrary raw log or direct browser-to-Comfy connection crosses the activity API.

Supported snapshots contain `epoch`, `state` (`unknown`, `idle`, `running`,
`disconnected`), `sampledAt`, `runningCount`, `queuedCount`, `runningPromptId`,
`progress` (null or `{value,max,fraction}`), `terminalRevision`, `resyncRevision`,
`historyGap` and `error`. Before successful observation the state is unknown.
The additive enrichment group is `progressBasis` (`exact`, `log` or null),
`workflow` and `workflowReason` (`other-client` or `unavailable`). The client
validates this group atomically; the original version1 shape remains readable.
One operation field prefers an exact websocket `progress` counter over the
bracketed log counter; log flight settlement cannot overwrite live exact data.
`workflow` is null or `{promptId,done,total,fraction,basis:"graph+events"}`.
Its static denominator is the dependency closure of the running queue item's
output targets, using the same engine graph traversal as Variations. Finished
nodes and non-lazy ancestors of observed running/finished nodes count done;
lazy flags come from the backing's existing cached object_info. A running
node contributes its bounded operation fraction unless already counted done.
Runtime-expanded IDs outside the static closure are ignored. The result is
monotone within the prompt and capped below 1 while still queued/running;
only the authoritative poll ends activity. The UI calls this **about** N of M
steps, not an exact prediction of future execution. A missing graph, targets,
catalogue or observable matching node state leaves workflow unavailable. Other
tabs' client-addressed events cannot be observed; no identity is impersonated.
Raw queue graphs, node catalogues and submitting client IDs stay engine-private.
Counters are best-effort **current-operation** progress, not workflow percentage
or proof that outputs finished saving. Log snapshots are associated only with
bracketed stable prompt identity and content continuity; stale/ambiguous counters
are indeterminate, and disconnect/idle/prompt replacement clears fill. A slow
unchanged operation count remains valid. Transfer-byte counters are excluded.

Pinned sources render one 24px concentric SVG: the existing current-step sector
inside a thin workflow arc, clockwise from 12 o'clock. Known workflow progress
uses the shared secondary token; unavailable workflow data uses a muted half arc
turning linearly every 2.5s (static with reduced motion). The faint outer track
and arc exist only while running. Idle, unknown and disconnected states have no
outer arc; disconnected activity delivery withholds both measures. Tooltip and
accessible label share plain wording: "workflow about N of M steps" (N is the
whole completed-step portion of done), "current step V/M (live)" or "(from log)".
Only the engine's other-client reason adds "queued from another ComfyUI tab";
other missing data has a generic unavailable explanation.

Immediately left of the ring, the same flex-centred chip displays the source's
outstanding queue size (`runningCount + queuedCount`). Tabular 12px numerals use
the shared muted foreground token and reserve at least two digit columns, so
1→12 does not resize the chip. Values through 999 display literally, larger
values display `999+`. Zero, unsupported, unknown, upstream-disconnected and
delivery-disconnected states show no number or retained allocation. Pending-only
queues still show their positive count even though no prompt is running. The
chip and instrument share one snapshot-derived label, adding e.g. "3 in queue
(1 running, 2 waiting)" with the uncapped total. No separate count state or fetch
is introduced.

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
The context's `SourceActivity` subscribes once to committed Store mutations and
semantic Jobs snapshot installations, including independent auxiliary progress.
Store emits only real committed insert/remove/flag changes, with a process-local
attribute revision; transaction-bound boot import is covered by initial projection.
Address-less placeholders never become configured sources or retire explicit fake
backings. One synchronous registry boundary owns live hosts, inventory incarnation,
Jobs membership and publication; same-ID/address remove/re-add cannot coalesce away
retirement. Compatibility collection helpers persist only; they do not write the map.

Source versions are `{epoch, incarnation, attributesRevision}`, distinct from Jobs
and inventory versions and not stored in SQLite. Discovery/mutation replies capture
the actual row/version before probing. Bootstrap and stream share the same source
identity. SSE `sources` events carry `id: <epoch>:<revision>` and JSON
`{version:1,epoch,revision,sources:{id:{address,kind,incarnation,pinned,autoRefresh,
sourceVersion,activity,arrivals}}}`. The entire source map is authoritative; absence removes
a source, and revision jumps are legal latest snapshots. Whole-frame validation
precedes any application. Unknown/incomplete/malformed frames retain accepted state
and require controlled resynchronization. Exact own source keys are preserved.

Every connect captures a current full cached projection synchronously with
registration; no replay log or probing collections call. Publication excludes
timestamp-only `sampledAt` churn; cached explicit reads retain current sample times.
Each subscriber retains at most one active encoded frame and one latest pending
snapshot. Demand-only high-water0 delivery chunks at16384 bytes, keeping the JS
queue empty (at most one delivered chunk), stricter than the64KiB queue ceiling.
Large maps are complete, never truncated. Slow readers do not block producers.
Fifteen-second comment heartbeats are transport liveness, never source changes.
Cancel, request abort, enqueue failure and stop share idempotent retirement. Stream
admission/listeners/subscribers retire at shutdown entry, before the existing
Jobs -> inventory -> prefetch -> HTTP -> Store shutdown sequence.

The Store owns one injectable subscription, independent of sources, pins, folders,
selection and component mounts. Source activity is delivered exclusively through
the event stream; there is no per-source activity GET route. Native
EventSource failure closes its retry machinery before one API-owned exponential,
jittered retry capped30s. Only an accepted full snapshot establishes ready. No
polling fallback. Pagehide suspends delivery; pageshow reestablishes it for bfcache.
Whole-Store disposal retires adapter retries, page listeners and acquisition owners.
Delivery disconnection is separate from upstream Jobs state: cached inventory/editors
remain, while stale running fill is withheld with an honest disconnected label.

Source-map acceptance preserves unchanged records/sessions, atomically reconciles
membership, confirmed flags and activity, then reconciles selected work once.
The private registry owns exact-ID membership in a Map and fixed-field reactive
records. Source IDs never become Solid mutation paths; derived public host,
activity and saving maps retain exact own keys, including prototype-named IDs.
Incarnation/epoch changes retire old owners even with identical ID/address and a
surviving Jobs alias. Probing discovery only enriches still-matching identities,
never resurrects membership or rolls flags back. The serialized confirmed-only
flag writer buffers the newest authoritative version during writes; events and
HTTP acknowledgements reconcile causally after success/failure/drain. Queued
toggles use latest confirmed values. Progress delivery continues during saves.
Membership replies additionally capture `sourceCursor:{epoch,revision}`; removal
acknowledges its retired sourceVersion as well. One private membership floor fences
older complete maps against confirmed removal/replacement, so a queued active frame
cannot resurrect retired ownership. This cursor orders delivery only, never inventory
acceptance. Source writes refuse after shutdown admission retires, while cached
compatibility projection remains readable through lifecycle drainage.

HTTP1 has a small per-browser/origin connection pool. The Chromium fixture checks
six live streams and queued ordinary HTTP until one is released, plus responsive
API/bytes with two app tabs. One stream per tab is not unlimited-tab support;
there is no implicit WebSocket/HTTP2/SharedWorker transport substitution.

Enabled-source completion and manual
refresh use one selected-session incremental merge lane; completions during a
read leave a follow-up pending, and failures retain the target for retry.
Each source's private freshness owner separates observed from accepted targets.
Only an issued ticket captured for a successful owned inventory read acknowledges
its captured epoch/terminal/resync tuple; unknown, forged, foreign, retired and
older tickets cannot acknowledge newer accepted work. Initial/manual requested
reads are separately retained, including an initial failure without any known
activity. Failures retry at 1–30s; unchanged activity does not bypass backoff.
The same private owner captures a delivery-gap generation in each issued ticket.
Recovery marks one gap per genuine lost-delivery episode, not per frame/heartbeat
or retry. A read acknowledges only its captured gap, even when the Jobs tuple is
unchanged. A target-null ticket may acknowledge its captured gap without consuming
Jobs first observed afterward. Disabled automatic work retains both obligations;
reconnect never increments manual counts or fabricates Jobs resync revisions.
Disabling auto-refresh pauses derived completion work without forgetting it;
confirmed enablement reconciles already-observed pending work. Explicit refresh
may request an immediate attempt.

Initial inventory never waits for held/unavailable activity. Unknown startup
telemetry is not consumed as a baseline: first-known activity after read capture
leaves freshness catch-up pending without replaying history as terminal jobs.
Initial and retry/refresh reads share one acceptance routine. The first successful
acceptance owns navigation resolution and restoration even after initial failure;
later acceptance owns keyed merge/viewport compensation and live browsing intent.
Inactive sources never steal focus or write the selected feed.
Load/metadata/want/size results are source-session/source-record-owned, including A→B→A
navigation. Judgment read protection, newer same-content enrichment, keyed editing
nodes, viewport anchors, bulk selection, URL/current/trail, notes, zoom, anchors
and workbench state survive incremental arrivals. Unknown-size arrivals are
wanted and acquire real dimensions. Grid rendering uses entry-ID strings, with
current measurement sizes resolved separately; replacing measurement objects
does not remount retained cards.

Grid's registered, owner-disposed seam publishes reactive measured readiness,
positive viewport dimensions and identity-keyed virtual items. One Store
reconciliation projects actual viewport identities (without overscan) and current into
one approximately twenty-entry foreground window. The Store-owned acquisition policy
admits sizes, feed src, inline images, metadata wants/reads/publication, node refresh
and scraper status. The policy alone defines bounded resource classes: native images
retain six foreground/two background slots; control (wants, polls, required node
registry refresh, byte-size HEAD and scraper status) has three foreground/one
background slots that native transfers cannot consume. Beyond-window work uses idle
quanta of at most eight ms. Background images wait while foreground work is pending;
background control follows its own class so an unfinished native image cannot strand
the metadata channel. The app-origin HTTP/1 transport budget is six connections:
one source-delivery stream, one reserved control connection and the derived four
native transfers, shared across both image lanes. Native measurement/display owners
declare their actual URL; other origins and non-HTTP resources retain the global
image ceilings. Native completion/abort releases both budgets together, without
preempting active images. Required registry refresh follows the graph identities it
serves and acknowledges only the changes captured by its accepted read. Wants are retained, acknowledged and
single-flight; outstanding lane heads are identity-indexed, so scheduler queries never
scan the acknowledged library. Projection changes reindex only affected foreground
identities. Metadata dimensions publish atomically in batches of at most 200
entries/eight ms. Empty, zero or stale-key geometry stays pending. Range/size/readiness
changes can acquire images without scrolling or another current change. Current-first
ripple remains; idle coverage extends by union. A settle keeps in-flight srcs and
loaded srcs still inside its new range ± pad; its ripple re-admits the rest of the
range and other members are released. Acquisition permission is separate from
permission to commit scroll-derived current/trail/URL: loading-time motion can settle
acquisition without later gaining browsing permission. Active gestures freeze
new src admission; the existing 150ms settle, compensation suppression and
one navigation restore remain.

The private size factory composes one retained native resource owner shared by feed
dimensions/src and owner-disposed inline registrations, admitted by that policy. Views
only register inputs and render its read-only results. Mounted feed and inline image
displays register their own load/error lifetimes with that same owner and policy: a
ready measurement does not exempt later DOM cache validation from capacity.
Retirement aborts the native consumer before releasing its slot. Resources and
ephemeral dimensions carry source context/content identity; context retirement
disposes resources and cached dimensions, and content replacement retires stale
resources and releases aborted capacity before replacement admission. Late callbacks
require matching context/resource/content. Completion is context/resource/content
owned, independent of whether its starting interest survives a re-window. Background
Images request low browser priority and explicit background engine intent; decoding is
async. Measurement and src-error owners share one eight-second retry timer with
retained callbacks and owner-specific cancellation, so one owner's work or retirement
cannot erase another's. Each measurement attempt has a 30-second deadline and exactly
one delayed retry; waiting blocks every early staging trigger. Retained measurement
interest drains through the policy even when no card can mount. A terminal measurement
failure is a known 1024×1024 box, not an omitted entry. Only pending entries stay
out of the feed. The size owner supplies the same dimensions to feed membership,
pending counts and CardSlot geometry; a terminal box cannot change height when
late metadata arrives. Learning an entry's first hash is same-content enrichment
and preserves active measurements and terminal boxes; changing a known hash
retires them. If authoritative dimensions arrive during an attempt, a subsequent
measurement error settles with those dimensions rather than resizing the already
ready card into a fallback. The box displays the filename and “Can't display this file.”,
with normal judgment, notes, download and hide/delete controls available. The
footer counts the same filtered, size-ready entries as the virtualizer (including
failures), and separately reports pending measurements.
Store disposal releases measurement resources, deadlines, queued interest, the
resize listener and retry work.

Images measure off-DOM with `Image`; videos use a retained
`<video preload="metadata">` and `videoWidth`/`videoHeight`, inside that same
owner and policy, with the same context/content guards, deadline and retry.
Listing/extractor dimensions still take precedence. Retirement pauses video,
removes its source and resets the native consumer before releasing capacity.
Audio is immediately size-ready with the fixed 1024×160 face, without measurement
or a size read; audio and known-size video srcs start without a native probe. Late dimensions and decode errors cannot resize audio cards.
One pure media-geometry model retains natural dimensions across feed, details
and anchors. Images/video scale down to available width, never enlarge; the box
height is max(displayed media height, available width × 9/16). Media is centred;
above the minimum the box hugs it vertically. Terminal failures keep their square
box and audio keeps its fixed face aspect. Playable controls occupy a separate
adjacent row below that box; its stable measured height is included in cardHeight,
virtualizer estimates and landing compensation, even while src is absent or failed.

`MediaBox` owns native display/load/zoom and player state; `Zoomable` is its
store adapter for feed/details/anchors. The comparator also renders MediaBox,
with its existing stage-owned entangled zoom. One shared controls component
provides play/pause, seek, elapsed/duration, mute, per-player loop (off by
default, never persisted) and open-in-viewer. Video and audio never autoplay; paused
card video players show a play affordance centred on the displayed first decoded frame. Surface
click toggles playback, while pan drags suppress their trailing click. Images
retain click-to-open and animated-image behavior. A per-store capability owner
pauses every other registered player on a native play event, and disposal or
src-window retirement pauses/unloads the consumer.
Native load lifetime follows source value and element identity, not unrelated
reactive window invalidations; zoom bindings follow element/key identity.
Audio uses the same controls, focus/Space semantics and arbitration, without a
picture: its primary play/pause button and duration share a centered row inside
the fixed box, without repeating the filename already in the card title.
No waveform or runtime transcode is involved. Tooltips call it an “audio file”.
Every playback button uses the shared IconButton contract, with primary play
and quiet mute/loop toggles using the shared active state. Surfaces and seek
use semantic palette tokens. Card open uses a four-corner full-screen icon,
titled “open full screen”; viewer media controls have no open button.
Native decode/unsupported-format errors say “Your browser can't play this
video format.” or “…audio format.”; image decode errors say “This image can't
be decoded.” Unknown causes keep the generic reason. Every failure adds
“Download it to open elsewhere.”, with ordinary card download still available.
Audio's viewer has one view and no switcher or B side.
The per-kind workbench view catalogue owns opening defaults, command admission
and the toolbar. Video opens in Full (A only), and offers Split (two-up),
Overlay (one-up/blink) and Slider (wipe); Difference is absent. Audio has only
Full. Images offer Full/Two-Up/One-Up/Split/Difference. Every kind opens in Full,
with A only, on every open (including explicit pairs and deep links).
Video comparison choices require the existing anchor/node-image B pair.
The persisted, rebindable `wb.full` binding defaults to `f`; keys1–4keep
their existing mode meanings. Full is available for every asset kind.
The viewer is a structural column: media area flexes above an ordered A/B
controls row, followed immediately by the existing bottom toolbar. One
playable side spans the dock; two playable sides get equal side-by-side bars
labelled A/B. MediaBox retains player state and receives its controls mount
as a presentation input; controls never participate in image pan/wipe layout.
Every native layer and the Difference canvas derive contain-fit geometry from
the same pure media-geometry model, using the actual media-area allocation;
constrained grid tracks cannot grow to a native element's intrinsic aspect.
Viewer crops are resource-keyed session state, separate from the persisted
feed/details/anchor views. Every open resets viewer crops to centred/fitted;
mode switches preserve only the viewer's own crops and locked-delta semantics.
Allocation changes rederive transforms and the Difference draw. Viewer gestures
never alter persisted card crops. There is no centred viewer play button for
any kind; its docked play button is the visible playback affordance.

Every crop uses the shared version2 model `{version:2,s,cx,cy,fh,fv,rot}`:
`cx`/`cy` are normalized image coordinates under the allocation centre; `s` is
relative to the existing natural-size-capped fit. Centres remain unbounded for
pan. Native transforms and Difference destinations derive from that same model
on every fit/allocation change, independently of element binding time. A missing
or zero fit is pending and cannot authorize a gesture or compatible-read write.
Persisted and viewer-session view ports convert legacy `{s,txf,tyf,…}` records
once, in the first valid fitted frame supplied to the owner. Old records did not
store their historical reference box; that first frame defines their compatible
interpretation. The persisted owner saves the version2 conversion through its
normal debounce; subsequent restore/resize reads never write derived views back.
Binding lifetime remains element/key-owned, with active drag listeners retired
on disposal. Wheel/pan deltas, scale limits and the viewer open-centred rule remain.

Workbench guards accept video/audio only after `loadeddata` and images after decode;
accepted source, kind and filename stay together through a failed swap, retaining
the last good side. Without a last-good side, a failed guard carries its native
media error code or image decode cause to the same MediaBox failure formatter;
unknown guard timeouts stay generic. Closing retires pending guards and native sources. Two-up,
one-up and split allow video/audio without synchronization. Non-image pairs disable
Difference with “difference mode compares still images”; the semantic mode
command enforces the same restriction. Hidden one-up players pause.

The shared browser JSON transport throws `ApiError` on non-success, retaining
method/path/status and at most 1024 characters of recognized engine JSON
`error`/`reason` detail. Empty, malformed and foreign bodies remain HTTP failures;
successful payloads keep their existing shape. Failure detail is text, never HTML.

With no configured sources, the feed shows an inline centered message and a
link-style action opening the existing source-picker add form. Initial inventory
and refresh failures with HTTP502 `collection unreachable` share a source-record
reachability owner: one error per outage, quiet retries at the existing cadence,
and offline presentation in the picker. Successful inventory clears the error
and restores online presentation. Discovery and navigation cannot reset an outage;
source retirement clears it. Other errors retain their normal reporting.

Feed-side topbar order: logo/wordmark, refresh icon, host dropdown, controlled
native Output folder selector, filename filter, separated pinned sources,
flexible space. Pinned buttons forward the dropdown's selection
action; circles are grey idle, filled SVG sectors for available counters, distinct
active outlines when indeterminate, and warning/unknown treatments without stale
fill. Source-row pin and auto-refresh toggles save independently without selecting
or closing the dropdown. Folder refresh controls are disabled with an explicit
reason; pinned folders have a grey circle labelled with their no-generation reason.
The filter opens/focuses immediately left of its icon; click/Escape collapses
without clearing its query. The header's feed and workspace sections size from
their own content: the feed section takes the remaining width and the workspace
section its content width; neither follows the main pane divider. Main
composition and its layout styles are unchanged; expanding the filter pushes the scrollable pins right. Unhide/Hide up-voted
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
The feed reads each compensation's anchor from the actual scroll position in the layout
it showed, never a remembered one; the Store applies the compensation and moves the
settle's gesture origin by the same applied displacement, so compensation is never
gesture travel and cannot invite the settle tidy, however late the settle timer runs.
Ordinary rail ticks use the existing subdued `--foreground-dim` neutral through
shared card-state presentation; card neutrals, judgment colors/priorities, wave
length/glow, geometry, tape windowing and scrub handlers retain their contracts.

New inventory identities in the current source, or entries newer than the seen
floor captured before opening another source, light their rail ticks once for
1400ms. Store inventory acceptance owns event publication and its accepted sequence
independently of source-stream seen advancement. The rail takes the entire event
once when candidates become size-ready, including identities outside its filter/tape window;
scrolling, rerendering and remounting cannot replay it. Source navigation/disposal
retires pending events. The rail owns its native animations and cancels on tick
identity replacement/unmount. Only brightness/light fades; reduced motion uses
color alone. No tick dimensions, wave/scrub geometry or browsing state changes.
Size-pending candidates wait for the existing size owner's feed admission; removed
entries and retired sessions discard them. A ready off-tape tick never waits.

Static surfaces: `/shared/<name>` serves the allow-listed `src/` modules
(`extractor.mjs`, `backings/mime.mjs`, `features/variations/shared.mjs`, `entry-path.mjs`, `source-origin.mjs`, `version.mjs`) to the browser;
`/` and `/diff` serve the Solid app from `client-solid-dist/`, with shared
assets (`/css`, `/vendor`, `/js`, logos) from `client/`.

### Client commands and modal ownership

Application inputs follow **input → shared handle → private operation**. The plain
per-store registry returns stable source-independent ports via
`store.handles.get(id)`; `store.handles.invoke(id,args)` resolves that same port.
Definitions validate data (not events/DOM/functions), preserving action results/
Promises. Covered compatibility actions delegate to handles; mechanical/read/
editor/lifecycle ports are explicitly classified. Ordered bindings reference
commands with constant arguments/context/routing through one injected adapter.
The twelve existing IDs/defaults/order retain their behavior. `media.toggle`
adds a persisted, rebindable Space binding through the same dispatcher. It routes
to the player containing keyboard focus, or the workbench's active player;
typing and modal layers retain priority. Accepted playback keys prevent native
scrolling. KeysPanel displays Space by name and edits mappings.
`wb.full` adds the persisted/rebindable full-view shortcut `f`, via that same
dispatcher; typing and modal priority are unchanged.

Payload/binding records use own enumerable data properties and dense arrays;
accessors, symbol properties, hidden callbacks and cycles reject before execution
or getter activation. Description metadata is a string, never an executor alias.
Present selectors/optional fields must carry valid values; undefined is not an ID.
Explicitly allowed native File resources retain their exact object identity.

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

One modal-private `makeVariationEditor` owns registered editable fields, clean
baselines, codecs, compilation/consumption bindings, issued immutable Run tickets,
results and close eligibility. Catalogue metadata is readonly and separate from
editable work. Unknown edits reject before mutation. Dirty compares only declared
editable leaves; initialization seeds untouched clean defaults without overwriting
early typed naming or manufacturing a user-edit revision. SliderRow's raw increment
is controlled by this owner and parsed once; view/child File/caret/gesture identity
and stable row-ID mounting remain private. No whole row-object comparison or
independently maintained acknowledgement path whitelist owns this flow.

Each Load Image row owns one ordered image set, initially empty. Existing ComfyUI
input names, native browser Files and engine-host image paths can be added over multiple turns and mixed;
identity deduplication uses input name, exact File identity or absolute engine path, never filename-only
deduplication of Files. Removal changes that same set. The chosen thumbnail grid
is above persistent acquisition controls, even when the axis is off. “ComfyUI
inputs” opens a searchable, virtualized, multi-select list; arrows/Enter select
and Escape closes its owned popup before the modal. Only visible input rows load
engine input-byte thumbnails. Engine thumbnails in the list and the chosen grid
register near the viewport as foreground displays of the Store's one acquisition
policy, sharing its capacity; a source change does not retire them, their owner's
unmount does. “Add files…” uses the browser's multi-file picker;
there is no browser-directory input or mutually exclusive image mode.
The persistent folder path field and Add action recursively acquire engine-host
images, including subfolders. The feature filesystem owner skips symlink traversal,
returns sorted canonical absolute paths and rejects more than 500 images with an
explicit message instead of silently truncating. Directory paths use the same
engine-host trust boundary as `folder:` sources, not the browser's filesystem.

The shared folder icon immediately to the path field's right asks the **engine**
to open the desktop portal directory chooser; it never uses browser directory
selection. `GET /api/features/variations/folder-chooser` returns `{available,reason}`.
Only app mode with a reachable session bus and FileChooser version 3+ enables it;
serve/container/no-portal cases disable it with “Folder chooser needs the desktop
app”, without disabling the typed path or Add. `POST /choose-folder` accepts
`{path:""|absolutePath}` and returns `{path,cancelled:false}` or
`{path:null,cancelled:true}`. Selection fills the path; Add still explicitly acquires
the recursive set. Cancel/errors preserve the draft, and later typing wins over
late chooser results. Editor suspension/unmount aborts the request.
The context-owned desktop service uses an in-project Deno Unix-socket D-Bus client
(SASL EXTERNAL, Hello, Properties.Get, pre-call signal subscription, OpenFile with
`directory:true`, Response). It adds no runtime dependency. Each operation owns a
connection; responses match the portal's unique sender and returned handle, including
early signals/legacy handles. Only one local file URI is accepted and decoded once.
Abort, five-minute timeout and engine shutdown close the request and connection.

`POST /api/features/variations/folder-images` accepts `{path}` and returns
`{path,items:[{kind:"server-path",name,path}],limit:500}`. `GET /folder-image?path=...`
serves an image-only regular file for its thumbnail, with `Cache-Control:no-store`.
`POST /inspect-path/<host>` accepts `{path,current,kind,names?}` plus captured origin
and returns the same readonly hash evidence as `inspect-image`. `POST /upload-path/<host>`
accepts `{path,hash}` plus that origin, rechecks the inspected bytes, and sends them
through the existing backing upload itself; browser bytes are never required.
Changed files reject with 409 and retain work; remove/add refreshes their comparison.
Stale source contexts reject with 412, including completed old-origin upload detail
when retirement occurred during a write. Real returned names, not preview names,
still own Run provenance. Path items join the same compiler/adoption leaf as Files.
The native popup joins the modal's owned suspend/resume seam: a blocking leave
decision hides its top-layer surface without replacing search DOM or losing
query/caret. Both Keep editing and Escape restore it before focus restoration.
The blocking decision consumes its pointer clicks, which cannot dismiss an
underlying popup as outside-click side effects.
Thumbnail GET/HEAD URLs may carry `origin=<JSON>` so native image elements retain
the captured source boundary too. Header/query origin validation has one owner;
conflicting origins reject, and stale byte requests reject before cache/backing IO.

`POST /api/features/variations/inspect-image/<host>` accepts multipart `image`,
`current`, `kind` (input/output), and optional JSON `names` for the requested
filename's known collision family, with the captured `X-Kosmozoo-Origin`. It returns
`{hash,currentHash,existing:[{name,hash}],origin}` using Ingest's existing cache/read owner. Comparison
never uploads to ComfyUI. The editor retains readonly comparison evidence outside
editable leaves, marks byte-identical Files “Same as current” and compiles them to
the current name without upload. The shared axis kernel owns exact current-tuple
exclusion in both displayed count and Run; mixed numeric/text axes still retain
their existing Cartesian semantics. Pending/failed comparison is visible and
cannot authorize an unverified upload. Actual uploads still occur only at Run.
The prepared count also projects stock ComfyUI's name/byte dedupe and collision
sequence (`stem (n).ext`) over the selected set in upload order. Only relevant
known collision-family bytes are read, not the whole input catalogue. Confirmed
upload names remain readonly session evidence across later remove/add turns.
Predictions are used only for counting; graph values and provenance always come
from actual upload receipts, including returned renamed files.
One compiler-generated image-set consumption binding replaces the old mode/file/
localFiles leaves, so a fully acknowledged set has no dormant acquisition work.

All variation kinds (numeric, enum, text and image) use the same node/input
identity codec in `src/features/variations/shared.mjs`. IDs are `<nodeId>.<input>`
(for example `76.image`, `81.image`, `20.strength_model`, `92:109.text`); segments
are percent-encoded when needed, including literal dots. Class names and custom
titles are display/schema metadata, never identity. One classified graph walk
creates singleton descriptors and rejects duplicate or unresolved locations;
probe and Run use that same catalogue. The editor rejects duplicates before
seeding any rows, and every row controls exactly its own node/input. Numeric
siblings are independent sliders, with independent currents and proof. Slider
tuning still uses the class/input schema key. Readable labels include title or
class, node ID and input, e.g. `Load Image #76 · image`.

Naming tokens use those exact IDs (`_{76.image}_{81.image}`), through the same
codec/parser. Unknown placeholder syntax remains literal and cannot certify
naming consumption. Existing `{Class.input}`, custom-title/class label tokens
and `{image}` are compatibility aliases for the first carrier in catalogue
order; `{image}` selects the first image descriptor even if only a later image
varies. Explicit IDs are required to address siblings independently. Variation
drafts and parameter choices are session-private and are not persisted, so
there are no saved legacy parameter keys to migrate.

Run/button/handle input enters `variations.run` and the owner's requestRun. A private
ticket captures all editable values/targets/revision/close generation before IO.
The compiler emits the request and its raw-value consumption bindings in the same
read/encode operation. Source-independent handles/broker retain opening metadata
and owner capabilities only. Running/pending-decision input is busy. Clean metadata
settling during a Run cannot strand captured submitted work. Newer/edit-and-revert
revisions, pending decisions and genuinely unused values still prevent adoption.

Opening/probe/Run retain an `Origin:{source,address,kind,epoch,incarnation}`; pin and
refresh attribute revisions are not operation identity. Probe optionally accepts
expected origin in `?origin=<JSON>` and returns `context:{origin,graphHash}`. Each
target is prepared before uploads. A new effect cannot acquire a replacement source
under the same ID; version2 Run compares captured origin and graph hash at entry,
then fences source lifetime throughout unsent enqueues. Shutdown retires operation
admission before backing IO. Already uploaded bytes/accepted jobs are not deleted
or automatically retried.

Input-list GET and multipart upload optionally carry `X-Kosmozoo-Origin:<JSON>`.
The engine captures the registry token/address before awaits, checks expected
origin before IO and lifetime after IO. Modern input reads return `{files,origin}`;
modern uploads return `{name,origin}` with a validated real returned name. Retired
upload contexts report412, including actual completed old-origin upload detail
when applicable, rather than authorizing follow-ups or inventing a conflict.
Legacy callers retain the input array/`{name}` shapes. Local-file runs across different
physical backends reject before writes; aliases sharing one backend retain separate
target identities and matched upload-resource provenance.

Run requires `acknowledgement:{version:2,runId,requestId}` and captured source/graph
context. Missing or invalid acknowledgement/context and version1 requests reject
before enqueue. The response echoes correlation, matched context, `target:{id,host,filename}`
and complete indexed `accepted:[{index,promptId,applied:{ranges:[],imageParams:[]},
selections:{ranges:[],imageParams:[]},naming:[]}]`. UUIDs use native Web Crypto entropy on the
existing HTTP LAN origin; they are correlation, not retry/idempotency keys.

Every Comfy backing enqueue builds its outgoing prompt through `freshSubmissionGraph`: clone the graph and remove only each node descriptor's execution-only `is_changed`, preserving inputs (including `inputs.is_changed`), all other fields and envelope lineage without cache-busting.

Variation narrowing keeps the producer's complete transitive input-link closure (including every lazy input), removes only output-class nodes outside it, leaves non-output nodes untouched, and rejects dangling links before enqueue.

Naming proof uses only the exact node IDs returned by the naming writer; no writes means no naming acknowledgement.

Actual surviving carrier assignments and recognized naming writes certify positive
use on confirmed accepted prompts. The same typed axis kernel owns count/generation
and off-selection exclusion proof. Tuple identity is per field, never delimiter
serialization; count does not allocate the Cartesian product. True/inert/missing
choices and ambiguous carriers receive no invented proof. The owner validates every
target/context/correlation, safe positive complete counts, explicit empty errors,
unique indexes/prompt IDs and requested field sets before any adoption. It intersects
all-target/all-permutation proof with compiler bindings and advances only captured
eligible leaves. Off consumes only selection; unused values, filters, dormant
templates, inactive filenames/Files and newer work remain protected. Editor text
and File references/order are never normalized/replaced. Enqueue node-error partial
acceptance or malformed success provides no complete proof or automatic resubmit.

Queued counts, validated proof, adoption, remaining work and close eligibility are
separate owner outcomes. The result explains when queued work cannot consume the
draft. Clean acknowledged work can close manually without discard and use the
existing three-second auto-close through the same ordinary leave guard. Private
close generation/owner/revision/decision/ticket checks fence firing and future timer
creation after Keep editing/manual leave/edits/new Run/disposal. Source/folder/filter/
Back/Forward browsing retains the modal and captured targets.

Each Variations text field is one literal template. Line breaks, blank paragraphs,
indentation and surrounding whitespace are retained in every submitted value;
formatting never creates extra variation axes. Only explicit `{{label}}` inputs
expand a whole-template Cartesian product, with the same expansion used for the
displayed count and Run payload. Missing referenced values keep that row inert;
clearing the field yields one empty string. Unchanged multiline text still matches
the exact current permutation and is excluded normally.

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
  `deno run --frozen --cached-only --allow-all build.mjs` (Babel +
  `babel-preset-solid` from locked npm packages, no Vite) from `client-solid/` into
  `client-solid-dist/`; framework-free modules stay in `client/js/`.
  Solid, the virtualizer, and noUiSlider (ESM) are vendored dists with
  vendor-time path rewrites and the `process.env.NODE_ENV` substitution
  (no bundler, no `process` in the browser); after `deno task deps`, run
  `deno task vendor` to regenerate files and `client/vendor/CHECKSUMS` from
  the locked npm cache, offline. `dev/vendor-browser.mjs` owns the file/transform
  inventory; `tests/t_vendor_pristine.mjs` checks hashes and the complete file set.
- Source/Docker native SQLite selection remains the explicit system library.
  The Linux executable selects its included, pinned library before importing
  the engine graph; a valid explicit `DENO_SQLITE_PATH` is retained. Invalid/
  empty overrides and `DENO_SQLITE_LOCAL=1` fail without a download fallback.
  Deno's included-native loader materializes the bytes beneath its actual temp
  parent, which must be writable and permit executable mappings.
- `feedback.json` is a portable judgment document, generated on demand per
  collection (`/api/collections/<id>/feedback.json`) — sqlite is canonical.
- Packaged runs are the [Linux executable](executable.md) and
  [production container image](container.md), with complete built UI, native
  SQLite and persistent state/cache; development stays one `deno run` away.
- No ML runtime, model weights, or Python anywhere in core. Specialized
  capabilities live behind a plugin/service boundary.
- Security deliberately deferred: no auth, no sandbox, no capability model.

Run `deno task deps` to acquire the frozen engine, plugin, compiler, browser and unit-test
graph into `DENO_DIR` before offline builds or tests (`--frozen --cached-only`).
Module dependencies come only from npm/jsr registries, with exact direct versions
in `deno.json` and transitive integrity in `deno.lock`; HTTP module imports are
forbidden by `tests/t_dependency_sources.mjs`. Only `deno task deps:update` may
deliberately update the lock, whose diff must be reviewed.

The staged-tree pre-commit hook, browser runner, Docker builder and publication
builder all use that same acquisition task before frozen, cached-only execution.
The browser runner mounts one prepared `DENO_DIR` in both engines and fakes;
`E2E_DENO_DIR` optionally supplies a reusable caller-owned disk-backed cache.
`deno task test` prepares the graph before running cached-only tests; `setup`
requires an already prepared cache. Cached-only restricts module acquisition,
not application HTTP traffic or native/toolchain input handling.

## 6. Storage (hash identity + sqlite + JSON documents)

Identity is content hash (SHA-256). `collection:name` is an address, not
an identity.

### State location

State dir resolution: `KOZMOZOO_STATE` if set, else
`$XDG_STATE_HOME/kosmozoo` (default `~/.local/state/kosmozoo`) — the repo
working tree is never a state dir. Env overrides: `KOZMOZOO_PORT` (default
2084), `KOZMOZOO_BIND`, `KOZMOZOO_HOSTS` (first-boot seed), `KOZMOZOO_STATE`,
`KOZMOZOO_FEEDBACK` (migration import only), `KOZMOZOO_CACHE`,
`KOZMOZOO_PLUGINS`, `KOZMOZOO_REVALIDATE_MS`.

Fresh state starts with no collections when `KOZMOZOO_HOSTS` is unset or empty.
An explicit comma-separated `name=host[:port]` or `name=folder:/path` list seeds an
empty collection table; existing nonempty collections always take precedence.
There is no separate first-boot marker, so an empty table can be seeded later.
Seeds use the same address normalization and collection validation as API adds;
invalid entries fail startup with a `KOZMOZOO_HOSTS` error before any seed is stored.

One pure bind/port resolver owns startup modes. Desktop app defaults to
`127.0.0.1`; source development, foreground `serve` and Docker to
`0.0.0.0`. Explicit bind/whole-port overrides win; malformed/empty values fail.
Browser destinations normalize loopback/wildcards to localhost and retain an
actually reachable explicitly selected interface (bracketed for IPv6).

New engines acquire an awaited exclusive lock on a stable real-filesystem
`engine.lock` before Store/workers. Private atomic metadata binds readiness to
the held inode and nonce; aliases/host-container path namespaces need not have
the same absolute path. App reuse requires the matching ready endpoint and
refuses copied/unrelated state, legacy/unrelated listeners and explicit override
conflicts without killing, port hopping, reconfiguration or reseeding. The lock
inode is never unlinked. Factories retire resources they acquired on failure;
borrowed test resources stay caller-owned. Normal/failure drainage fences source
admission/streams first, then Jobs/inventory/prefetch/HTTP/Store and the lease.

Native browser adapters use stable dedicated provider profiles and safe argv,
outside engine Context/Store/plugins. Firefox native registration is additionally
checked against the requested URI, preventing hostname-only reuse of an old
port. Unavailable/unknown/conflicting native app capability uses the selected-port
ordinary-browser URL with a whitelisted transient Store-owned status notice;
no prefs/registry/profile/lock reset or notice persistence is performed.

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

`src/backings/mime.mjs` is the shared extension → `{mime, kind}` registry;
`mediaKind(name)` classifies images, videos (mp4/mov/webm) and audio
(flac/mp3/opus/wav). `RENDERABLE` admits the existing image extensions plus
mp4/mov/webm and flac/mp3/opus/wav. The input-folder /
LoadImage list always uses the image-only set derived from this registry.

`metaFromBytes(bytes, name)` owns metadata dispatch for ingestion and cached
graph reads. It returns `[meta, hasWorkflow, graph]`, with the executed API prompt
graph separate from the editor workflow. Hash-only readers select by signature.
PNG text (including APNG `comf` chunks after IDAT), WebP EXIF prefix strings,
QuickTime mdta keys/ilst and iTunes comment envelopes, and Matroska SimpleTags
all produce the same metadata/lineage contract. Version5 re-extracts previously
ingested content through the existing staleness owner. No ffmpeg/runtime decoder
dependency is introduced.

Audio readers normalize FLAC Vorbis-comment blocks, Ogg Opus `OpusTags` packets
(including continuation across pages), MP3 ID3v2.3/v2.4 `TXXX` frames and WAV
`LIST/INFO/ICMT` JSON comment envelopes through that same dispatcher. ffmpeg/PyAV
preserve named `prompt`, `workflow` and `kz` dictionary keys in FLAC/Opus/MP3.
WAV's ffmpeg INFO writer has a fixed vocabulary and drops those arbitrary keys:
write `comment={"prompt":…, "workflow":…, "kz":…}` to retain them in `ICMT`.
Without embedded metadata a WAV is still listed/playable, with no invented graph.
Current stock ComfyUI SaveAudio writes FLAC/MP3/Opus, not WAV. Readers check record
bounds, skip unsupported ID3 compression/encryption and never search encoded audio
payloads for JSON. Audio adds no further extractor-version bump (version remains 5).

`Ingest.dims(collection, name)` is the pre-ingest half: dims live in a
file's first bytes (PNG IHDR, GIF descriptor, WebP VP8*, JPEG SOF), so a
64 KB ranged head read (`Range: bytes=0-65535`; full-read fallback on a
200-without-206) + `imageDims` stores them on `entry.width/height` — no
hash, no cache write, no extract. Known dims (content via the entry's
hash, or the entry columns) short-circuit the read; a 404 head read tells
the prefetch the source lost the file, and the prefetch marks the entry
`gone`.

Video dimensions use MP4/MOV video-track `tkhd` display dimensions (including
quarter-turn rotation), or WebM video-track PixelWidth/PixelHeight. A 64KiB head
may miss a trailing moov; full ingestion and browser measurement cover that case.
Metadata writes advance one durable cursor per write. A bounded session-local
change index delivers only changed identities/fields, including content's output
aliases across collections. Absent, invalid, future or older-than-retained cursors
receive the full snapshot (including after restart); equal cursors omit payloads
but still report pending dimension/ingest work. Dimension-only writes never resend
unchanged graph metadata. Delivery history does not change the database schema.
A delta cannot be re-requested by cursor once acknowledged, so a want's reply
carries its names' current state: a reader that had not yet listed an entry when
its change arrived recovers it by demanding that identity.

The prefetch runs TWO passes over each collection's listing: pass 1 the
dims head reads (10 ms inter-file — size-before-render on a fresh host is
fast), pass 2 the full ingestion above at the existing politeness
(100 ms). Each collection gets its OWN async worker with its own inter-file
delays and backoff — one host's outage never stalls another; a worker's
failure is logged, surfaced as its `lastError` on `/api/prefetch`, and the
worker restarts after the backoff cap. The dims queue drains before
ingestion starts; full foreground `want` promotes in both queues, while dimension
interest only queues dimension reads. Whole-library walking is explicitly low
priority; prio lanes pass high priority to the existing Ingest executor;
per-collection backoff caps at 30 s; 404 ⇒ `entry.state='gone'`
(permanent); the pause gate holds both passes.

### Serve path (cache-first)

`GET /api/collections/<id>/entries/<name>/bytes`: hash → cache hit (serve
+ debounced revalidation) → read-through ingestion → backing proxy as last
resort (with background ingest). A busy ComfyUI host is not a read
outage.

Both entry and hash bytes routes advertise `Accept-Ranges: bytes`. A valid
single `bytes=start-end`, `bytes=start-` or `bytes=-suffix` request returns206
with exact inclusive bytes, Content-Length and Content-Range. Unsatisfiable
ranges return416 with `Content-Range: bytes */<length>`. Malformed, multi-range
or unsupported units are ignored (200). Matching If-None-Match takes precedence
(304); If-Range must match the strong content ETag, otherwise full bytes return.
The complete file still goes through hashing/cache before slicing: no streaming
rewrite. Comfy byte reads have a ten-second **idle** deadline, reset by headers
and body progress; a progressing large download has no total ten-second limit.
Bytes requests default to foreground; `?priority=background` keeps off-window
read-through in Ingest's low lane. Invalid priority rejects before acquisition.
All backing read paths (dimensions, bytes and revalidation) share the address gate:
four total reads, at most three background, with a slot retained through complete
body buffering. Foreground takes the next available slot; a queued low single-flight
can be promoted. Cached responses retain the existing validators/revalidation.

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
the entries API). Plugin capabilities have no SPA consumer today (§1).
