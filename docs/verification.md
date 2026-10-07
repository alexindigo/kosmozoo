# Complete staged-project pre-commit checks

The managed hook checks everything that will be committed: changed staged files
and all unchanged tracked files. Tests are never selected by changed filenames.
Unstaged fixes cannot make a failing staged version pass.

Every attempt exports the Git tree directly from objects, preserving paths,
bytes and Git modes, including tracked database fixtures and files marked
`export-ignore`. The host only does Git/copy/transport operations. All project
checks run in the dedicated virtual machine
`arch-niri-kosmozoo-feature-pre-commit-full-project` on `ark.home`, under disk-backed
`/home/tester/kosmozoo-pre-commit`. Source and generated output are fresh per run.

## Checks

The guest runs infrastructure tests when that staged tree contains them, the full
`tests/t_*.mjs` unit suite, a frozen build, then all five cold browser/HTTP suites
(workbench, variations, diff, cache, feed). The inherited approved naming adapter
keeps the tracked browser runner unchanged. There is no cached green result.

A unit/build/browser failure blocks the commit. Missing/busy VM, changed tools,
occupied test ports/container names, input-integrity failure, missing evidence,
and index mutation during verification also block. Staged work is retained.
No tests run on the laptop or directly on Ark, and the hook does not boot/restart
the VM or fall back to another target automatically.

## Installation

Prepare the owned guest through `vm-fleet-hosts` → `vm-fork` → `kosmozoo-vm`,
verify its actual UUID/MAC/host key/filesystem, then create strict profile
`kosmozoo-pre-commit-full-project`. Before installation, its guest root and
`incoming`, `runs`, `fixtures` directories must be private and guest-user-owned.

From the infrastructure source worktree:

```bash
python3 -B dev/git/install.py --repo /home/user/Projects/kosmozoo \
  --profile kosmozoo-pre-commit-full-project \
  --domain arch-niri-kosmozoo-feature-pre-commit-full-project \
  --vm-uuid be9bb3a6-29f2-484e-a56b-e28ab32a5d68 \
  --guest-root /home/tester/kosmozoo-pre-commit
```

This copies a coherent managed controller bundle and installs the hook in the
repository's Git-common hooks directory, covering linked worktrees and older
branches. It does not modify signing settings/global Git config. Another active
hook or `core.hooksPath` arrangement is preserved and requires explicit integration.
Reinstallation of the same managed configuration is supported; existing bundles
and evidence remain available. Signing continues through the user's normal Git
configuration only after the full staged project has passed.

Normal use remains `git add …` followed by `git commit …`. Expect several minutes
per commit. The dedicated VM must be available; use its authorized lifecycle
workflow if it is stopped. Failure output identifies the phase and retained
evidence directory. Fix and stage the affected code/tests together, then commit
again; do not bypass the hook or weaken assertions.

## Evidence and fixture tests

Host attempt records default to `~/.local/state/kosmozoo/pre-commit/run-*`.
Guest sources/logs/results are under `/home/tester/kosmozoo-pre-commit/runs/run-*`.
Successful completion is bound to this run's staged tree ID, complete manifest,
all mandatory phases and an unchanged active Git index. Generated client output
is guest-local and never installed into the user's running app by verification.

The `guest-local` transport is an integration-test route guarded by the exact
configured DMI VM UUID and writable disk-backed workspace. It is not an SSH
failure fallback and cannot run on the host. Disposable VM Git fixtures generate
their own signing key and use normal signed commits; actual user keys/agent and
real signing configuration are never copied or altered. Their failures prove
Git refuses bad staged code even when an unstaged working-file fix exists.
