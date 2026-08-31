# AGENTS.md

## Commit times

Quiet-hours timeshifting happens right before push — and only then. While
writing code and while committing changes, do NOT think about quiet hours:
no clock-checking, no deferring commits, no re-dating. Commit when the work
is ready; the timeshift pass is a separate step that happens right before
push, and it is the user's call.

## Test suite

Host deno segfaults on sqlite FFI — always run the suite via the docker
image:

```
docker run --rm --network host -v "$PWD":/work -w /work denoland/deno:latest test --allow-all tests/t_*.mjs
```
