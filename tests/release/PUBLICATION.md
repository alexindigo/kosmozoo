# Publication verification interfaces

These are release-development tools, not customer runtime dependencies. Run
builds, tests, package consumers and captures only in the assigned virtual-machine
guests on `ark.home`. The publication orchestration plan supplies strict profiles,
expected DMI UUIDs, absolute input paths and new disk-backed evidence directories.
An unavailable guest is a blocker; no editing-host or physical-host fallback.

## Native executable acceptance

The fixed interface is:

```sh
python3 -B tests/release/verify-native-publication.py \
  --binary /absolute/current-ELF --previous-binary /absolute/distinct-previous-ELF \
  --older-firefox /absolute/characterized-older-Firefox \
  --workspace /absolute/native-workspace --evidence /absolute/new-evidence \
  --expected-vm-uuid 0053e86d-8233-49eb-97e0-4055e5428be7
```

Execute through the native guest's strict route, in its delivered `source/`
directory. Long invocations use a bounded transient user service and regular
polling, not an unbounded SSH command. The suite invokes native engines, fake
backends, Node/CDP observers and system browsers; no Docker is invoked. Native
runtime, Chromium, five suites, cold GNU/decoded/storage/failure, installer/menu/
service/update/removal, Firefox capability/profile/handoff/port and ordinary
fallback witnesses all refer to the supplied ELF. A missing witness cannot emit
the aggregate PASS. Screenshot spatial review remains a separate gate.

Workspace inputs include authenticated `inputs/build-inputs/` matching
`packaging/linux/inputs.json`, the authenticated stock cold GNU rootfs and its
file/link/mode manifest, characterized older Firefox and native test-tool caches.
The native five-suite driver snapshots the complete selected source graph for
fakes/observers, excluding Git/generated client/state/cache/backups. The engine
uses its embedded payload plus explicitly scoped data/fixtures. Bulk fixture
readiness requires real known dimensions, not a pre-inventory idle counter.

Native input uses the guest's US-layout standard evdev keyboard, with the
authenticated ydotool test package in `native-input.json`. Acquire its exact
archive/signature and verify trusted package signing plus pinned hashes inside
the assigned native guest. No shared daemon, user-group change or compositor
configuration is required. Each run creates a private tester-owned0600 socket
and a root-owned, keyboard-only transient daemon with a900-second independent
lifetime; PID/start-time/executable/hash/token/unit invocation/socket/directory/
device scope is checked before every input and retirement. Only a verified owned
native window is focused. Browser first-run acceptance and Firefox settings are
actual native UI actions; preferences and native registrations are not fabricated.

One independent parent/deadline watchdog owns retirement across the aggregate,
including early Chromium/installer failures. Separate test engines have their
own bounded lifetimes. UI ownership observes the private process cwd and browser
profile/PID relationship even when Chromium scrubs its environment. Engine/unit
ownership verifies account, executable/hash, token, private HOME/state and cgroup;
the installed test additionally checks its resolved fragment/code scope. A
foreign/reused resource is preserved and fails the gate. Normal browser closure
is observed through process exit, not just disappearance of a window. Logs,
receipts, socket evidence, code versions, profiles, quarantine and data remain.
Installer deadline drop-ins are test-owned manager inputs; their exact contents
are retained in evidence when retired. Product unit templates are unchanged.

The original primary-only standalone probes retain their default guards and
behavior. Publication workers select the explicit separate UUID path rather
than weakening an old guard. `test-publication-ownership.py` exercises real native
first-key/repeat, parent-failure/deadline and foreign-resource preservation.

## Actual installed package acceptance

```sh
python3 -B tests/release/verify-aur-installed.py \
  --package-file /absolute/reviewed-package.pkg.tar.zst --package-name kosmozoo-bin \
  --workspace /absolute/native-workspace --evidence /absolute/new-evidence \
  --expected-vm-uuid 0053e86d-8233-49eb-97e0-4055e5428be7
```

`packages/acceptance-inputs.json` is supplied after the real reviewed packages
exist. Its `variants` contains exactly `kosmozoo`, `kosmozoo-bin`, `kosmozoo-git`,
each with `name`, absolute `file` and measured `sha256`; `officialBinarySha256`
is the frozen official ELF hash. `legacy` supplies the genuine previous
`kosmozoo-git` archive's `file`, `name`, `version` and `sha256`. Prebuilt bytes must
match the official ELF. Archive `.PKGINFO`, native ELF/resource/dependency/conflict
policy and exact pacman identities validate before install. No foreign package,
loose-binary copy or fabricated package manager stands in for installed consumers.

The driver intentionally installs/removes exact candidates inside the assigned
guest, observes `/usr/bin` ownership/process identity, package desktop and user
unit consumers, decoded saved data/profile outcomes and transitions. Existing
packages, units, drop-ins and windows require reconciliation, not deletion to
force a baseline. Candidate cache seeding is distinct from public-download proof.
Package builds/installed positive acceptance follow their publication milestones;
M01 contract tests do not manufacture release packages.

## Frozen checksum/source correspondence

```sh
python3 -B tests/release/verify-publication-checksums.py \
  --release-dir /absolute/frozen-release --changelog CHANGELOG.md \
  --version 0.2.0 --tag-commit ACTUAL_TAGGED_COMMIT
```

This read-only verifier checks exact official ELF/asset/SHA256SUMS/changelog and
source/tag/resource/material/input correspondence, including safe archive
boundaries. It does not compile, rebuild, retag or publish. Positive/negative
metadata fixtures test correspondence; they are not an official release record.
The real checksum record is written only after the official artifact is frozen.
See the canonical public build/acquisition/resource contract in
`packaging/linux/PUBLICATION.md`.
