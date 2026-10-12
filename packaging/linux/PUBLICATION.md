# Public Linux packaging contract

The public builder compiles the application into one ordinary Deno 2.9.6/V8
GNU/Linux x86_64 executable. Source-built packages use authenticated build tools,
denort and characterized native SQLite bytes; they do not build the Rust/V8/SQLite
toolchain entirely from source. Deno, Node, Python and Docker are not engine runtime
dependencies. Installed browsers and GNU system/helper libraries remain external.

## Explicit inputs and one build authority

Run the following inside the authorized build VM for developer verification:

```sh
bash packaging/linux/build-publication.sh \
  --source-manifest /absolute/source-input.json \
  --inputs /absolute/build-inputs --materials /absolute/dependency-material \
  --cache /absolute/deno-cache --output /absolute/new-output --version 0.2.0
```

All directories are explicit, disk-backed and outside the source checkout. Output
must not exist. `--validate-inputs` performs the same complete source/native/material
authentication without compiling or creating artifacts. This is the M01 seam;
release artifacts are first built only after the reviewed Docker-first checkpoint.
The public core has no fleet UUID/private path requirement. The developer-only
`build-release.sh`/`build-release.py` retains its strict original VM/DMI and private
evidence guard and invokes this same core. Neither route creates tags or publishes.

`source-input.py` records all committed source paths, modes and SHA-256 values plus
commit/tree identity. The versioned source archive includes that manifest at its
root and application source under `kosmozoo/`. For a development application-source
build, explicitly generate a development manifest; this is not an official tagged
release. A final official build requires the accepted immutable source manifest.

`inputs.json` authenticates both compiler/runtime ZIP archives and their extracted
executables, plus the exact SQLite library. `source-materials.json` authenticates
the source/license material and the unchanged notice files. No system-SQLite or
new compiler substitution, unchecked tool download or Docker extraction is a public
build input. Dependency warming uses the frozen lock before network-disabled,
cached-only client build/compile with the authenticated `DENORT_BIN`.

## Acquisition and cache names

The immutable publication base is
`https://github.com/alexindigo/kosmozoo/releases/download/v0.2.0/`.
These are intended release names, not claims that downloads already exist:

| # | Asset / cache alias | Contents / authority |
|---|---|---|
| 1 | `kosmozoo-linux-x86_64` | Official executable; exact frozen SHA256SUMS, artifact and provenance records |
| 2 | `kosmozoo-0.2.0-source.tar.gz` | Exact tagged source plus source-input.json |
| 3 | `kosmozoo-0.2.0-dependency-material.tar.gz` | Exact paths in source-materials.json plus that manifest |
| 4 | `kosmozoo-0.2.0-build-inputs.tar.gz` | Exact paths in inputs.json plus that manifest |
| 5 | `kosmozoo-0.2.0-resources.tar.gz` | Package-owned global resources plus resources.json |
| 6 | `SHA256SUMS`, `artifact.json`, `provenance.json`, `source-input.json`, `resources.json` | Frozen asset and source identity records |
| 7 | `THIRD_PARTY_NOTICES.txt`, `NOTICE-SOURCES.json` | Source-traceable notices, also present in source/resources |

Before extraction, authenticate each archive against the reviewed frozen release
SHA-256 record. Do not trust an unauthenticated downloaded checksum list as its own
authority. Extract only safe regular-file/relative-directory entries into fresh
private directories; never extract an archive over user state or a prior attempt.
The builder rechecks every contained input against tracked pins before execution.
Preseeded candidate caches are local evidence, not public-download proof. Actual
fresh public acquisition is a later authorized publication gate.

The original compiler/runtime upstream URLs are respectively
`https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip`
and
`https://github.com/denoland/deno/releases/download/v2.9.6/denort-x86_64-unknown-linux-gnu.zip`.
Use their tracked archive and extracted-binary hashes. The characterized Debian
SQLite binary is supplied in the authenticated versioned input bundle at
`libsqlite3.so.0.8.6`; its exact Debian 3.40.1-2+deb12u2 source/rebuild material is
in the matching material bundle. The original image provenance is retained in
inputs.json; public consumers need no private image or evidence directory.

## Global package ownership and coexistence

`render-resources.mjs` and the self-installer share `src/desktop/resources.mjs` and
the original templates. Package resources target `/usr/bin/kosmozoo`, the global
desktop/icon/licenses/docs and `/usr/lib/systemd/user/kosmozoo-engine.service`.
The unit resolves `%E/kosmozoo/engine.env` in the actual user's manager and starts
engine-only `serve`; defaults remain wildcard 0.0.0.0:2084, with explicit environment
overrides. App defaults remain loopback:2084. Resource generation has no service,
browser or profile effects.

Pacman owns these files. Package hooks never call `kosmozoo install`, start/enable
a service, enable lingering, open a browser or remove state/cache/plugins/profiles.
Users may explicitly opt into `systemctl --user enable --now kosmozoo-engine.service`.
All variants preserve the Deno appended ELF payload (`!strip`, `!debug`); prebuilt
package bytes must equal the frozen official ELF. Source-built output has its own
measured identity and is not assumed byte-identical to the official executable.

A managed `~/.local/bin/kosmozoo`, user desktop entry or user unit can shadow global
resources. Inspect `command -v kosmozoo` and `systemctl --user show
kosmozoo-engine.service -p FragmentPath` before choosing a migration. Explicit
managed `kosmozoo uninstall` removes only its receipt-matching links and preserves
data/profiles/versions; it is never an automatic package hook. Keep legacy
`kosmozoo.service` and Python-era data for explicit reconciliation. A global unit
is not a managed-local receipt and the self-installer may refuse that conflict.

LGPL/GPL preferred project source, exact dependency/MPL/native source material and
all notices must accompany release assets. See LICENSING.md. Compilation is not
native/package acceptance or legal approval. Changelog records the official ELF
SHA only after it is frozen; a later documentation commit does not alter that tag
or assert it is the binary's embedded source.
