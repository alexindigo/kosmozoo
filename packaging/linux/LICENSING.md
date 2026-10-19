# Native distribution notices and source references

Kosmozoo is LGPLv3; `LICENSE` incorporates the GPLv3 text supplied in
`LICENSE.GPL`. The executable contains ordinary Deno/denort2.9.6/V8, locked
SQLite binding/runtime module dependencies, protected frontend vendors/icons,
selected bundled plugin code and the pinned native SQLite library. System
GNU/Linux libraries, coreutils/systemd helpers and installed browsers remain
external dependencies.

`resources/THIRD_PARTY_NOTICES.txt` supplies project, runtime, vendor, icon and
native permission/copyright texts. `resources/NOTICE-SOURCES.json` traces those
texts to exact versions/checksums or immutable upstream Git blobs. Rust runtime
collection conservatively includes normal/build transitive source dependencies;
it does not claim that every build-only crate is linked into the final binary.
Every package's actual source notice was preserved in addition to SPDX tool
output. The libuv wrapper's missing manifest expression was reconciled from its
complete MIT/BSD-2-Clause/ISC source notice, not silently discarded as Unknown.

Published V8 crate150.4.0 excludes licence files. The corresponding wrapper Git
commit and its native submodule revisions were used to recover the actual V8,
Strongtalk/fdlibm, ICU, Abseil, LLVM/libc++, SIMD/FP16/Highway and other notices.
Split Chromium repositories that refer to the parent BSD licence retain their
actual dated copyright/permission headers alongside the verified Chromium BSD
text. Source/runtime inputs are not upgraded to work around notice collection.

Third-party notices are embedded in the executable. `kosmozoo package-resources
--prefix=/usr --destdir=/absolute/package-root` writes the project licenses and
notices into `usr/share/licenses/kosmozoo/` alongside the desktop, service, icon
and documentation files. The optional user installer retains the embedded notices
with each managed version. Source-run packages use the same command through Deno.

Release downloads are exactly `kosmozoo-linux-x86_64` and `SHA256SUMS`, which lists
only that executable. Source and build-material archives are not release assets.
The builder retains its authenticated inputs, source/material archives and
artifact/provenance records locally as evidence.

Source references for the distributed code:

| # | Material | Purpose |
|---|---|---|
| 1 | [Kosmozoo tagged source](https://github.com/alexindigo/kosmozoo/archive/refs/tags/v0.2.1.tar.gz) | Preferred editable project source, build scripts and protected vendors; use the `v<version>` tag matching the executable |
| 2 | [Deno v2.9.6](https://github.com/denoland/deno/tree/v2.9.6) and its [Cargo.lock](https://github.com/denoland/deno/blob/v2.9.6/Cargo.lock) | Runtime source and exact locked crate versions; registry crate source is available from [crates.io](https://crates.io/), including MPL-2.0-covered dependencies |
| 3 | [Debian sqlite3 3.40.1-2+deb12u2 source package](https://snapshot.debian.org/package/sqlite3/3.40.1-2%2Bdeb12u2/) | Source, Debian patches and rebuild metadata for the pinned native SQLite library |
| 4 | `THIRD_PARTY_NOTICES.txt`, `NOTICE-SOURCES.json` | Embedded permission texts and exact source/version/checksum references, also emitted by `package-resources` |

Ordinary compilation can be repeated with the recorded toolchain inputs and
build driver. `inputs.json` and `source-materials.json` retain the exact native,
toolchain and local source-material hashes. A compatible explicit
`DENO_SQLITE_PATH` remains available without an automatic native download or
opaque library-selection change. LGPL/GPL and dependency notices accompany
distribution; dependency source is referenced upstream rather than shipped as
release assets. These references and build records are not a legal approval claim.
