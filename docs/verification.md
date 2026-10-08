# Complete staged-project pre-commit checks

The managed hook checks everything that will be committed: changed staged files
and all unchanged tracked files. Tests are never selected by changed filenames.
Unstaged fixes cannot make a failing staged version pass.

Every attempt exports the Git tree directly from objects, preserving paths,
bytes and Git modes, including tracked database fixtures and files marked
`export-ignore`. The host only does Git/copy/transport operations. All project
checks run in a fresh virtual machine on `ark.home` for every invocation, under
disk-backed `/home/tester/kosmozoo-pre-commit`. The prepared
`arch-niri-kosmozoo-precommit-base@precommit-ready` supplies the tools; invocation domains are
`arch-niri-kosmozoo-precommit-base-run-<unique-id>`. The base stays shut off.

## Checks

The guest runs infrastructure tests when that staged tree contains them, the full
`tests/t_*.mjs` unit suite, a frozen build, then all five cold browser/HTTP suites
(workbench, variations, diff, cache, feed). The inherited approved naming adapter
keeps the tracked browser runner unchanged. There is no cached green result.

A unit/build/browser failure blocks the commit. Missing/busy VM, changed tools,
occupied test ports/container names, input-integrity failure, missing evidence,
and index mutation during verification also block. Staged work is retained.
No tests run on the laptop or directly on Ark. Each invocation creates a new owned
guest, verifies domain/storage/key/filesystem/DMI identity, and never falls back
to host execution. A missing or changed prepared base blocks the commit.

## Installation

Prepare the base through `vm-fleet-hosts` → `vm-fork` → `kosmozoo-vm`, verify its
actual UUID/MAC/private disk/NVRAM/host key/filesystem, and create a strict base
profile. Its private guest root and empty `incoming`, `runs`, `fixtures`, `tmp`
directories must be disk-backed and guest-user-owned. Docker, pinned tool images,
Git/Python/rsync/curl/jq and the approved naming adapter are inherited, never
installed per invocation. Capture an offline uniquely named checkpoint and validate an
independent invocation before activation.

From the infrastructure source worktree:

```bash
python3 -B dev/git/install.py --repo /home/user/Projects/kosmozoo \
  --config /path/to/private/fresh-base-config.json \
  --expected-config /path/to/exact/previous-managed-config.json
```

This copies a coherent managed controller bundle and installs the hook in the
repository's Git-common hooks directory, covering linked worktrees and older
branches. It does not modify signing settings/global Git config. Another active
hook or `core.hooksPath` arrangement is preserved and requires explicit integration.
The fresh-base JSON records transport `fresh-vm`, verified `base_profile`, base
domain/UUID/MAC/disk/NVRAM, `snapshot`/`snapshot_sha256` and the exact physical
`disk_snapshot` record, operator-proven `host_key` and
`guest_host_key`, pinned `fork_tool`/`fork_sha256`, the existing transfer tool/module,
guest root and evidence root. Reinstallation of the same managed configuration
is supported. Migration requires the exact expected previous configuration and
retains its backup; unexpected config changes block installation. Existing bundles
and evidence remain available. Signing continues through the user's normal Git
configuration only after the full staged project has passed.

Before each fork, the lifecycle requires exactly one physical qcow2 snapshot with
the configured tag and its exact approved identity, in addition to the libvirt
metadata digest. Inherited duplicate tags cannot silently select an older state.

Normal use remains `git add …` followed by `git commit …`. Expect several minutes
per commit, including VM creation/shutdown. Ark and the prepared offline checkpoint
must be available. Failure output identifies the phase, owned guest and retained
evidence directory. Fix and stage the affected code/tests together, then commit
again; do not bypass the hook or weaken assertions.

## Evidence and fixture tests

Host attempt records default to `~/.local/state/kosmozoo/pre-commit/run-*`.
Guest sources/logs/results are under `/home/tester/kosmozoo-pre-commit/runs/run-*`.
Successful completion is bound to this run's staged tree ID, complete manifest,
all mandatory phases and an unchanged active Git index. Generated client output
is guest-local and never installed into the user's running app by verification.

The host attempt also retains `lifecycle.json`, domain XML, strict per-invocation
known-hosts/profile and lifecycle/fork logs. Only after complete matching evidence,
all mandatory phases and index validation does the controller gracefully shut
down and remove this invocation's domain, private disk and NVRAM. It rechecks
identity and exclusive ownership before removal and observes their absence.
Failures, interruptions, partial provisioning and cleanup errors block the commit
and retain the failed guest/resources for diagnosis; no automatic failed-VM
cleanup. The old dedicated verification VM and prepared bases are not retired.

The `guest-local` transport is an integration-test route guarded by the exact
configured DMI VM UUID and writable disk-backed workspace. It is not an SSH
failure fallback and cannot run on the host. Disposable VM Git fixtures generate
their own signing key and use normal signed commits; actual user keys/agent and
real signing configuration are never copied or altered. Their failures prove
Git refuses bad staged code even when an unstaged working-file fix exists.
