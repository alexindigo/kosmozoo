# Releasing

## Release identity

The tracked root `VERSION` file is the release version: `MAJOR.MINOR` or
`MAJOR.MINOR.PATCH` digits, for example `0.2.0`.

1. Bump `VERSION` in the release's changelog commit, **before** tagging.
2. Tag that commit `v` + the contents of `VERSION` (for example `v0.2.0`).

Development commits keep the last release's value. Git tags and commit counts
never choose or increment the version.

The Docker release workflow runs `dev/check-release-version.sh <tag>` before
building and refuses to publish a tag that does not equal `v` + `VERSION`. It
builds images with `KOZMOZOO_REVISION` set to the tagged commit.

## What the running app shows

The engine reads `VERSION` once at startup; a missing, unreadable or invalid file
stops startup with an error naming the file. It logs the version before the
"listening" line, returns `app: {version, revision}` from `/api/runtime`, and the
store supplies the formatted version for the header logo tooltip. This does not
change the instance/lease runtime protocol.

The revision comes from `KOZMOZOO_REVISION` when nonempty (7–40 lowercase hex
characters), otherwise the executable's `provenance.commit`, otherwise null.

| Build | Revision source | Shown as |
|---|---|---|
| Official Linux executable | Embedded `provenance.commit` | `v0.2.0 (abc1234)` |
| Release image | `KOZMOZOO_REVISION` build argument | `v0.2.0 (abc1234)` |
| AUR source packages | Launcher exports `KOZMOZOO_REVISION`: `kosmozoo` reads the tarball's embedded commit using `git get-tar-commit-id`; `kosmozoo-git` uses `git rev-parse HEAD` of its build checkout | `v0.2.0 (abc1234)` |
| Source run / local image | No revision | `v0.2.0-dev` |

No known version formats as an empty string (and no logo title).
`kosmozoo --version` also prints the source-input digest (or `working-source`),
the running Deno version and target. Publication builds refuse a `--version`
that differs from the staged `VERSION` file.

Local images can supply a revision with
`docker build --build-arg KOZMOZOO_REVISION=$(git rev-parse HEAD) .`.
