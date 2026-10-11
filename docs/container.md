# Packaged engine image

The image contains the Deno engine, compiled Solid client, shared/vendored browser
assets, cached dependencies, system SQLite and four plugin modules. No application
checkout is needed at runtime. The detector/critic modules are HTTP clients;
their Python/ML services are separate deployments and are not included.

## Build and run

The Dockerfile builds an **amd64** Debian image using the SHA-256-verified Deno
2.9.6 release pin shared with `.devcontainer/Dockerfile`. The build downloads
Debian packages and locked Deno dependencies and compiles `client-solid/` with
`build.mjs`; runtime needs no dependency downloads. Deno resolutions are frozen
against `deno.lock`. Debian package repositories/base tags can change, so this
is not a claim of bit-for-bit identical images across builds.

Run development builds/tests inside your authorized VM. From its copied checkout:

```sh
docker build -t kosmozoo:local .
docker run -d --name kosmozoo-image \
  -p 127.0.0.1:18084:2084 \
  --mount type=volume,src=kosmozoo-image-state,dst=/data/state \
  --mount type=volume,src=kosmozoo-image-cache,dst=/data/cache \
  kosmozoo:local
```

Open `http://127.0.0.1:18084`. This example leaves existing :2084/:2086 deployments
alone. The engine has no authentication; bind the published port to loopback or
place it behind your own access-controlled proxy.

The process runs directly as PID 1, **uid/gid 1000**, rather than through a shell
wrapper. The image's state/cache directories are owned by that user, so fresh
named volumes work without root initialization. With bind-mounted data directories,
provide uid/gid 1000 write access beforehand; the image never changes your host
directory ownership on startup.

## Persistent data

| # | Container path | Contents |
|---|---|---|
| 1 | `/data/state` | `metadata.db`, its WAL/SHM files, settings and migration backups; canonical collections, flags and judgments. |
| 2 | `/data/cache` | Content-addressed bytes, stored as `<ab>/<hash>`. |

Mount the entire state directory, not only `metadata.db`: SQLite WAL belongs
beside the database. Keep both named volumes when replacing a container. A cache
can be refilled from available sources; retain it when those sources may disappear.
Never use live production state for a proving run. Current schema/migration
contracts are documented in [the spec](spec.md).

`docker stop --timeout 30 kosmozoo-image` delivers SIGTERM. The engine fences
source admission and native event streams first, then stops jobs/inventory/prefetch,
drains its HTTP server and closes SQLite and its cooperative state lease before exiting.
Restart the same container with `docker start kosmozoo-image`, or recreate it
using the same two volume names. Avoid force-removal when you want graceful close.

## Configuration and first boot

The image sets `KOZMOZOO_HOSTS` to an empty string. A fresh state volume therefore
starts with **no collections** (`GET /api/collections` returns `{}`), without a
default `127.0.0.1:8188` source. Add collections through `POST /api/collections`
or supply a seed when creating the container:

```sh
# Add this option to docker run when seeding an empty state volume:
-e KOZMOZOO_HOSTS="studio=comfy.example:8188"
```

Existing nonempty SQLite collections take precedence over that environment seed.
An empty table can be seeded on a later boot too; there is no separate first-boot
marker. Bare `deno task dev` keeps its development default. Background prefetch
and source monitoring start on boot for configured collections; core preferences
and source flags retain their existing semantics.

| # | Environment variable | Image default / purpose |
|---|---|---|
| 1 | `KOZMOZOO_PORT` | `2084`, container listen port; update port publishing if overridden. |
| 2 | `KOZMOZOO_BIND` | `0.0.0.0`; explicit bind overrides use the same strict resolver as source and executable modes. |
| 3 | `KOZMOZOO_HOSTS` | Empty; comma-separated `name=host:port` or `name=folder:/path` seed for an empty collection table. |
| 4 | `KOZMOZOO_STATE` | `/data/state`. |
| 5 | `KOZMOZOO_CACHE` | `/data/cache`. |
| 6 | `KOZMOZOO_FEEDBACK` | Optional legacy v1 judgment import path, never a canonical output file. Mount the import document with the disposable/migrated state as appropriate. |
| 7 | `KOZMOZOO_PLUGINS` | `/opt/kosmozoo/plugins`, packaged hello/difference/detector/critic modules. |
| 8 | `KOZMOZOO_REVALIDATE_MS` | Engine default, cache revalidation debounce override. |
| 9 | `DENO_SQLITE_PATH` | `/usr/lib/libsqlite3.so`, linked to Debian's native library. |

Plugin discovery retains its existing tiers: the configured path, then
`$XDG_DATA_HOME/kosmozoo/plugins` (default `/data/.local/share/kosmozoo/plugins`).
The image deliberately has no `/app/plugins` development tier to shadow user
plugins. The runtime client does not load plugin client halves automatically;
packaging them does not enable the dormant comparison axes.

## Folder collections

Folder addresses refer to paths **inside the container**. Bind only source data,
not the application checkout:

```sh
# Add these options to docker run for a read-only local folder source:
--mount type=bind,src=/absolute/image-folder,dst=/sources/images,readonly \
-e KOZMOZOO_HOSTS="photos=folder:/sources/images"
```

Files must be readable by uid 1000. A read-only mount permits browsing but prevents
the folder driver's permanent unlink operation; use a writable data mount only
when deletion is intended. Folder sources remain flat, while Comfy output
inventory supports the nested-path contract in [the spec](spec.md). Comfy addresses
must be reachable from the container; `127.0.0.1` on bridge networking denotes
the container itself, not a host-side Comfy service.

## Image verification

In the authorized VM, after building:

```sh
mkdir -p "$HOME/kosmozoo-container-evidence"
bash tests/e2e/run-image.sh
```

This runs the five existing suites against the built image. Only test data and
state/cache volumes are mounted into the engine; fake-host/browser test source
mounts belong to their separate containers. The runner retains engine mount/log
evidence, checks non-root execution and graceful shutdown, and refuses occupied
test resources. `KOSMOZOO_IMAGE` overrides the default `kosmozoo:local` tag; the
runner records and runs its resolved image ID. See [verification.md](verification.md)
for the separate full staged-project pre-commit hook.

`tests/release/verify-image.sh --image <immutable-id-or-tag> --evidence <fresh-dir>
--rollback-source <prepared-old-source>` provides the separate cold/migration and
rootless rehearsal. The old source has its own verified manifest and built client;
only the retained old-deployment leg receives that source bind. Replacement
engines receive image code and data-only mounts. It records actual system SQLite
package/library bytes, Docker save config and uncompressed layer digests, imported
Podman runtime identity, keep-id data writes, recreation, code rollback retaining
new writes, and full-pair snapshot recovery into fresh disposable siblings.
Stopped containers, images, archive and before/after state/cache remain available;
the driver never prunes images or fixes ownership with recursive chown.

Project and dependency licence notices accompany the image under
`/usr/share/doc/kosmozoo/`. The source/build material and final clean-commit artifact
identity remain separate distribution gates; mutable Debian inputs are measured,
not represented as the executable's independently pinned native input.

The cutover checkpoint has two additional VM-only helpers.
`check-cutover-snapshot.sh --evidence <dir>` reads `snapshot-input.json` containing
the stopped-writer receipt, complete state/cache path/hash/mode/ownership inventory
and canonical SQLite/settings fingerprint; it requires schema9, integrity/FK
checks and every content-addressed cache file. Prepare the stopped snapshot and
seal that fresh baseline during the approved no-writer interval, not from a live
database or historical user-data counts.
`verify-deployed-readonly.sh --evidence <dir>` reads `readonly-input.json` with the
expected four shared-module hashes, known cached-content hashes/sizes and current
canonical source addresses/flags. Its fixed production origin is
`http://architect.home:2084`; requests are only GETs for runtime identity, those
shared modules, direct cached content and one120-second native SSE connection.
It does not list upstream inventories or exercise SPA/generation/settings writes.
The explicit `--fixture-origin` accepts only loopback for disposable guest proof;
its receipt labels fixture evidence and cannot be presented as production proof.
