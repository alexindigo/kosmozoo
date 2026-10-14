# Native distribution notices and corresponding-source material

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

The candidate build supplies:

| # | Material | Purpose |
|---|---|---|
| 1 | Complete project source archive and source-input manifest | Exact source/paths/modes with build scripts and protected vendors; final distribution requires a clean committed tree |
| 2 | `corresponding-dependency-material.tar.gz` | Pinned Deno source, Cargo lock and checksum-verified registry source archives, including MPL-covered source, with exact native SQLite Debian source/rebuild material |
| 3 | `THIRD_PARTY_NOTICES.txt`, `NOTICE-SOURCES.json` | Retained licence/copyright permissions and their source provenance |
| 4 | `inputs.json`, `source-materials.json`, artifact/provenance/checksum manifests | Independently verified compiler/denort/native archives/bytes and source-material input identity |

The project source is the preferred editable form for its LGPL-covered modules;
ordinary compilation can be repeated with the recorded toolchain inputs and
build driver. A compatible explicit `DENO_SQLITE_PATH` remains available without
an automatic native download or opaque library-selection change. All LGPL/GPL
and dependency notices accompany distribution. The optional installer retains
the embedded notices with each managed version.

MPL-covered dependency source is supplied rather than assuming a checksum or
generic licence label satisfies source obligations. No version/tag or legal
approval record is invented by the build driver.
