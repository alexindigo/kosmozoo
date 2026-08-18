# Plugins

Extend your own kosmozoo install without waiting for an upstream merge. A
plugin is a folder; drop it in, restart, live. No manifest, no versioning, no
marketplace.

## Where plugins live

Discovery checks, in order:

1. `$KOZMOZOO_PLUGINS`
2. `$XDG_DATA_HOME/kosmozoo/plugins/` (default `~/.local/share/kosmozoo/plugins/`)
3. `./plugins/` in the repo — the development tier

## Shape

```
plugins/<name>/
    plugin.mjs   # export function register(kz) — engine hooks (server side)
    client.js    # optional, served at /plugins/<name>/client.js — UI hooks
```

A plugin is **trusted** and runs **in-process**. Security is deliberately
deferred: no auth, no sandbox, no capability model. Don't install a plugin
you wouldn't run as a shell script.

## The `kz` surface

What `register(kz)` can touch:

| Call | Kind | Purpose |
|---|---|---|
| `kz.mode(id, def)` | capability | a composition mode (blend/split/difference/flicker) |
| `kz.alignment(id, def)` | capability | an alignment contribution (e.g. `face-anchored`) |
| `kz.route(method, path, handler)` | route | server route under `/api/plugins/<name><path>` |
| `kz.probe(def)` | capability | an extractor probe contribution |
| `kz.exporter(def)` | capability | a training-export sink |
| `kz.settings.get/set(k, v)` / `.ns()` | persistence | namespaced `plugins.<name>.*` settings — core never sees them |
| `kz.store.getField/setField(host, file, field, v)` | persistence | plugin fields on the judgment record, namespaced |
| `kz.judgments.get/set(...)` | data | the core judgment record (notes/vote/favorite) |

A plugin declares its own config (a service URL), its own optional
dependency, and its own failure states (*"service unreachable"*, *"model not
downloaded"*, *"loading"*) and surfaces them as **reasons** on the relevant
axis. **Absent must look like absent, never like broken.**

## The three plugin shapes

The first three plugins each prove a different shape:

1. **difference** — client-only (a composition mode).
2. **export** — server + client (training export; the reason Deno is the
   foundation).
3. **detector** — brings its own external dependency (a detection *service*,
   addressed like a ComfyUI host), and degrades to absent when unconfigured.

## Hello world

`plugins/hello/plugin.mjs`:

```js
export function register(kz) {
  kz.settings.set("loaded", true);
  kz.route("GET", "/hello", () => Response.json({ hello: "kosmozoo" }));
}
```

Restart the engine; `GET /api/plugins` lists it and
`GET /api/plugins/hello/hello` answers.
