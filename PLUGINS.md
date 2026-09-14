# Plugins

Extend your own kosmozoo install without waiting for an upstream merge. A
plugin is a folder; drop it in, restart, live. No manifest, no versioning, no
marketplace.

Not everything extensible is a plugin: **variations** is a *feature module*
(`src/features/`) — a core module with isolated state, mounted at
`/api/features/variations/*`. Features ship with the engine; plugins are the
drop-in tier.

## Where plugins live

Discovery checks, in order:

1. `$KOZMOZOO_PLUGINS`
2. `$XDG_DATA_HOME/kosmozoo/plugins/` (default `~/.local/share/kosmozoo/plugins/`)
3. `./plugins/` in the repo — the development tier

## Shape

```
plugins/<name>/
    plugin.mjs   # (or .ts / .js) export function register(kz) — engine hooks
    client.js    # optional, served at /plugins/<name>/client.js — UI hooks
```

A plugin is **trusted** and runs **in-process**. Security is deliberately
deferred: no auth, no sandbox, no capability model. Don't install a plugin
you wouldn't run as a shell script.

## The `kz` surface

What `register(kz)` can touch:

| Call | Kind | Purpose |
|---|---|---|
| `kz.mode(id, def)` | capability | a composition mode (client half picks it up) |
| `kz.alignment(id, def)` | capability | an alignment contribution (e.g. `face-anchored`) |
| `kz.route(method, path, handler)` | route | server route under `/api/plugins/<name><path>` |
| `kz.settings.get/set(k, v)` / `.ns()` | persistence | namespaced `plugins.<name>.*` settings — core never sees them |
| `kz.store.getField/setField(collection, name, field, v)` | persistence | plugin fields on the judgment record, namespaced |
| `kz.judgments.get/set(collection, name, …)` / `.all()` | data | the core judgment record (notes/vote/favorite) |
| `kz.content.bytes(hash)` / `.graph(hash)` / `.bytesForEntry(collection, name)` | data | engine-mediated content access — no plugin talks to a host or the cache directly |
| `kz.reason(status, error, reason)` | shape | the shared `{error, reason}` failure response |

Judgments are **per entry** — keyed by `(collection, name)`, stored as
columns on the entry row. The same image in two collections has two
judgment records; `kz.judgments.all()` returns each row with its `hash` so
batch consumers can group by content when they want to.

A plugin declares its own config (a service URL), its own optional
dependency, and its own failure states (*"service unreachable"*, *"model not
downloaded"*, *"loading"*) and surfaces them as **reasons** on the relevant
axis. **Absent must look like absent, never like broken.** Capability
`needs` are evaluated per request, never frozen at register time.

## The bundled plugins

Each proves a different shape:

1. **difference** — client-only (a composition mode via `kz.mode`).
2. **detector** — brings its own external dependency (a detection *service*,
   addressed like a ComfyUI host), and degrades to absent when unconfigured.
3. **critic** — a thin proxy: routes forwarded to an external
   describe/caption service, failures surfaced via `kz.reason`.
4. **hello** — the minimal proof that the host loads a folder and calls
   `register(kz)`.

## Hello world

`plugins/hello/plugin.mjs`:

```js
export function register(kz) {
  kz.settings.get("loaded", false); // reads must not write (a plugin boot is not a state change)
  kz.route("GET", "/hello", () => Response.json({ hello: "kosmozoo" }));
}
```

Restart the engine; `GET /api/plugins` lists it and
`GET /api/plugins/hello/hello` answers.
