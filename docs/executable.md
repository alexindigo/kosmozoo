# Linux x86_64 executable

The standalone entrypoint packages the current Solid client, shared browser
modules, engine, four bundled plugins, SQLite and optional installer resources.
It uses ordinary Deno 2.9.6/V8 compilation for `x86_64-unknown-linux-gnu`.
Running it does not require a checkout, installed Deno or Docker. It targets
GNU/Linux x86_64; portability and ABI assumptions belong to the accompanying
artifact evidence, not a universal Linux or musl promise.

## Commands

These are end-user operations; project builds and verification follow the
VM-only workflow in [verification.md](verification.md).

| # | Command | Behavior |
|---|---|---|
| 1 | `kosmozoo` or `kosmozoo app` | Start a loopback engine and request an installed-browser app window, or reuse the selected state's matching ready engine |
| 2 | `kosmozoo app --browser=/absolute/executable` | Choose a characterized installed browser adapter and retain that selection for subsequent menu/app launches |
| 3 | `kosmozoo serve` | Foreground engine only; no browser window |
| 4 | `kosmozoo browser-settings firefox` | Open `about:config` in the dedicated Firefox profile without writing preferences |
| 5 | `kosmozoo install` | Create managed user-local launcher, versioned code, unit, menu entry and icon; leave the service inactive |
| 6 | `kosmozoo install --service` | Explicitly enable/start the managed engine-only user service |
| 7 | `kosmozoo uninstall` | Remove matching managed links; retain state, cache, plugins, browser profiles and previous code versions |
| 8 | `kosmozoo --help` / `--version` | Print command/input information without opening engine state or SQLite |

## Binding, state and shutdown

`KOZMOZOO_PORT` defaults to2084 in every mode. Desktop `app` defaults to
`127.0.0.1`; `serve`, direct source development and Docker default to
`0.0.0.0`. Explicit `KOZMOZOO_BIND`/`KOZMOZOO_PORT` win. Bind is an IP address
or hostname without scheme/port; port must be a whole number1–65535. Empty,
truncated or malformed explicit values fail rather than silently choosing a
different port.

The local browser URL is `http://localhost:<port>/` for loopback/wildcard
bindings. An explicitly selected non-loopback interface uses its actual address,
with brackets for IPv6. The CLI prints listening binding and browser URL
separately. Service/Docker wildcard exposure is deliberately unauthenticated;
there is no added access-control layer.

Existing `KOZMOZOO_STATE`, `KOZMOZOO_CACHE`, first-boot `KOZMOZOO_HOSTS`,
migration-only `KOZMOZOO_FEEDBACK`, plugin and XDG precedence stay the same.
One stable real-filesystem `engine.lock` protects cooperative new-engine
ownership. Private atomic instance metadata and `/api/runtime` readiness use an
instance nonce and lock identity; no absolute state path is published. The nonce
is identity plumbing, not authentication. Path aliases can refer to the same
state; copied/unrelated state or listeners cannot authorize reuse.

App reuse cannot silently reconfigure an active service. Explicit bind/port
conflicts, legacy/unrelated listeners and uncertain identity fail without killing
a process, starting another state writer, choosing a random port or reseeding.
Browser window closure leaves submitted work running. Stop a foreground engine
with SIGINT/SIGTERM, or stop its managed user service with
`systemctl --user stop kosmozoo-engine.service`. Shutdown retires source admission/
streams before workers, HTTP, storage and the instance lease. Corrupt JSON is
quarantined with original bytes retained and startup stops for explicit repair.

## Installed browsers

Chromium-family app adapters and supported Firefox use persistent family-specific
profiles under `${XDG_DATA_HOME:-$HOME/.local/share}/kosmozoo/browser/<provider>/`.
They do not borrow/copy ordinary profiles, clear profile locks/data, install a
browser or change the system default. Chromium's adapter selects Wayland when
the session supplies it. Firefox uses its installed Linux taskbartabs/native
recreation protocol, not the removed `--ssb` flag or a fabricated registry.
Firefox's native app window can retain its simplified navigation toolbar.

Native Firefox registration is hostname/container-scoped. If an existing
registration's start URL differs from the selected engine URL (for example after
a port change), the launcher preserves that registration and opens the correct
regular-browser URL with an explanation. It never silently attaches the GUI to
the old engine or rewrites Firefox's registry to force an app window.

Supported-but-disabled Firefox reports instructions for
`browser.taskbarTabs.enabled` in its dedicated `about:config` profile. Enable it
there explicitly, close Firefox so the setting is saved, then relaunch. Missing
prefs do not imply an unsupported version. Locked/uncharacterized policy or
unknown packages get an honest availability diagnostic. No preference is turned
on automatically.

When app windows are unavailable, the launcher prints the chosen-port regular
browser URL and requests the ordinary URL opener. A whitelisted transient notice
in the existing application status surface makes instructions visible from menu
launch too. Query text cannot become commands or HTML, and the notice is not
persisted as engine or browsing preferences. A browser's own first-run dialogs
remain browser-owned user interactions.

## Optional user installation

Managed resources are `~/.local/bin/kosmozoo`, the versioned XDG data application
tree, `kosmozoo-engine.service`, menu entry and icon. The unrelated legacy
`kosmozoo.service` is not managed. Installation requires the native executable;
source-interpreter invocation is not a self-installation route.

The installer refuses unmanaged or changed files/links/units. Complete staged
versions have private receipts; activation changes one `current` symlink
atomically. Previous code is retained. Menu and service paths use their native
escaping, including spaces/quotes/percent. Desktop-entry executable paths with
`=` are rejected by that format's contract.

The optional installation requires systemd user utilities and `/usr/bin/env` from
coreutils. The unit and menu use env-exec with literal argv, not a shell, so
native launchers validate a stable executable token before interpreting the
quoted user-local engine path. The process becomes the same engine. The
user-owned environment file at
`${XDG_CONFIG_HOME:-$HOME/.config}/kosmozoo/engine.env` can override bind/port and
existing engine settings. No root installation, lingering, firewall change or
unconditional restart loop is performed.

The environment file contains one `KEY=VALUE` assignment per line, for example:

```ini
KOZMOZOO_BIND=127.0.0.1
KOZMOZOO_PORT=2085
```

Quote values containing spaces according to systemd's environment-file syntax.
The generated unit's `EnvironmentFile=` directive itself is a single literal
path, distinct from the quoted argv syntax used for `ExecStart=`.

An active managed update stops that unit cleanly, activates code and checks its
matching readiness. A failed update restores the prior code pointer but leaves
the engine stopped: changed/quarantined state is preserved for inspection and
explicit repair rather than automatically booting old code into empty documents.
Uninstall removes only matching managed links and retains data/profiles/versions.

## Native inputs and rebuild material

`packaging/linux/inputs.json` separately authenticates compiler and denort
archives/extracted binaries and the actual characterized SQLite library bytes.
The build creates a frozen source staging tree, fresh complete client build and
explicit resource payload. Dependency warming is separate from network-disabled,
frozen/cached-only compilation with the verified `DENORT_BIN`.

Native selection occurs before the literal dynamic engine import. A valid
explicit `DENO_SQLITE_PATH` is retained. Empty/invalid overrides or
`DENO_SQLITE_LOCAL=1` fail; there is no binding-download fallback. Without an
override, Deno materializes the included SQLite library into its private native
cache beneath the temporary directory before dlopen. That directory must be
writable and allow executable mappings. Single-file distribution does not mean
zero transient native extraction.

Selected bundled plugins retain their existing discovery/static surfaces and
trusted local drop-ins. The detector's Python service/worker/model files are not
embedded; comparison-plugin axes still have their documented dormant SPA status.

Development candidates are labelled working inputs with no fictitious Git commit.
Final distribution requires clean commit/tree/source identity, complete notices
and license/source-rebuild material, checksums, measured ABI compatibility and
actual executable/image consumer evidence. The packaging driver does not publish
or create a release version/tag.

## Verification

Release workloads run in the identified Kosmozoo VM, never on the editing host.
`tests/e2e/run-executable.sh` drives all five browser suites against the actual
binary with data-only engine mounts. `tests/release/verify-linux.sh` composes
runtime, native browser, local-plugin, cold Bookworm, measured ABI and installer
consumer gates. Its core phase requires `--binary`, a fresh `--evidence`,
`--previous-binary` for upgrade/recovery, and `--image-input` for the characterized
cold runtime.

The native Firefox phases are `firefox-setup`, `firefox-fallback`,
`firefox-settings`, `firefox-enabled`, `firefox-finish`, `firefox-handoff`, and
`firefox-port-change`. Complete first-run UI before fallback observation; enable
the preference through the dedicated settings UI and close Firefox before the
enabled phase. Stop the initial engine with `firefox-finish` before independent
handoff/port-change probes. `browser-fallbacks` additionally takes the verified
archived executable through `--older-firefox`. `finish` checks the same binary's
complete witnesses and emits `LINUX RELEASE ACCEPTANCE PASS`; screenshot spatial
review and final clean-commit rebuild identity are separate required gates.
