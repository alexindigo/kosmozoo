# Public Linux packaging contract

The public builder compiles the application into one ordinary Deno 2.9.6/V8
GNU/Linux x86_64 executable. Source-built packages use authenticated build tools,
denort and characterized native SQLite bytes; they do not build the Rust/V8/SQLite
toolchain entirely from source. Deno, Node, Python and Docker are not engine runtime
dependencies. Installed browsers and GNU system/helper libraries remain external.

## Explicit inputs and one build authority

Build:

```sh
bash packaging/linux/build-publication.sh \
  --source-manifest /absolute/source-input.json \
  --inputs /absolute/build-inputs --materials /absolute/dependency-material \
  --cache /absolute/deno-cache --output /absolute/new-output --version 0.2.1
```

All directories are explicit, disk-backed and outside the source checkout. Output
must not exist. `--validate-inputs` performs the same complete source/native/material
authentication without compiling or creating artifacts.
The core has no fleet UUID/private path requirement and does not create tags or publish.

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

## Release assets and build inputs

The immutable publication base is
`https://github.com/alexindigo/kosmozoo/releases/download/v0.2.1/`.
Each release publishes exactly two assets:

| # | Asset | Contents / authority |
|---|---|---|
| 1 | `kosmozoo-linux-x86_64` | Official executable, including third-party notices and package resources |
| 2 | `SHA256SUMS` | SHA-256 of that executable only |

Source, dependency-material, build-input and resource archives, manifests, notices
and logs produced by the builder stay local as evidence; they are not uploaded as
release assets. Package-owned files come from `package-resources`, not a separate
resource download. Do not trust an unauthenticated downloaded checksum list as its
own authority.

Project source is the GitHub `v<version>` tag archive, for example
[`v0.2.1`](https://github.com/alexindigo/kosmozoo/archive/refs/tags/v0.2.1.tar.gz).
Dependency source is referenced upstream: [Deno v2.9.6](https://github.com/denoland/deno/tree/v2.9.6),
its [Cargo.lock](https://github.com/denoland/deno/blob/v2.9.6/Cargo.lock) crates on
[crates.io](https://crates.io/) (including MPL-2.0 dependencies), and the
[Debian sqlite3 3.40.1-2+deb12u2 source package](https://snapshot.debian.org/package/sqlite3/3.40.1-2%2Bdeb12u2/).
See LICENSING.md for the notice/source contract.

The original compiler/runtime upstream URLs are respectively
`https://github.com/denoland/deno/releases/download/v2.9.6/deno-x86_64-unknown-linux-gnu.zip`
and
`https://github.com/denoland/deno/releases/download/v2.9.6/denort-x86_64-unknown-linux-gnu.zip`.
Use their tracked archive and extracted-binary hashes. The characterized Debian
SQLite binary belongs at `libsqlite3.so.0.8.6` under the explicit input directory;
its Debian package version and original image provenance remain in `inputs.json`.
The builder requires the authenticated local source/rebuild material identified
by `source-materials.json`. Before extraction, authenticate each input against
the tracked pins and use fresh private directories, never user state or a prior
attempt. The builder rechecks all inputs before execution.

## Global package ownership and coexistence

The AUR `kosmozoo` and `kosmozoo-git` packages run the application source with
Arch's `deno` and `sqlite` packages instead of compiling. They are not the official
executable and are not byte-identical to it.

Packagers run `kosmozoo package-resources --prefix=/usr --destdir=/absolute/package-root`
after installing the executable. Source-run packages invoke `src/cli.mjs
package-resources` through their packaged Deno environment with the same options.
Both paths and `render-resources.mjs` use `writePackageResources`, which shares
`src/desktop/resources.mjs` and the original templates with the self-installer.
The command requires absolute paths, refuses to overwrite files and does not use
the network or HOME/XDG locations. Package resources target `/usr/bin/kosmozoo`, the global
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

Notices travel in the executable and are emitted into packages by
`package-resources`; project and dependency/MPL/native source is referenced at the
upstream locations above rather than supplied as release assets. Compilation is not
native/package acceptance or legal approval. Changelog records the official ELF
SHA only after it is frozen; a later documentation commit does not alter that tag
or assert it is the binary's embedded source.
