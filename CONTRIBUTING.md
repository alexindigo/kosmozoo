# Contributing

Open the repository in its devcontainer and install the hook once per clone:
`git config core.hooksPath dev/hooks`.
The hook runs `deno task deps` against the staged tree inside the devcontainer
image, then runs frozen, cached-only unit tests and the client build, using its
resource caps and Docker or Podman (Podman is preferred when available).

For manual work in the devcontainer, acquire modules with `deno task deps`, then
build with `deno run --frozen --cached-only --allow-all build.mjs` and run
`deno task test` (which prepares dependencies before cached-only tests).
`deno task setup` also requires the prepared cache. Only `deps` acquires modules;
`deno task deps:update` deliberately updates the lock for review. Dependencies
come from npm/jsr, never HTTP module imports. Regenerate the checked-in browser
assets with `deno task vendor` after acquisition.

The browser suite (`tests/e2e/run.sh`) prepares one run-owned dependency cache,
then starts both engines and fakes with `--frozen --cached-only`. Set
`E2E_DENO_DIR` to an absolute disk-backed directory to reuse a caller-owned cache;
the runner prepares it through the same task and preserves it at cleanup.
