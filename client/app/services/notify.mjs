// client/app/services/notify.mjs — the re-render signal.
//
// render() means "state changed; paint again". The mechanism lives on the
// Preact side now: <App> subscribes once for the whole tree, and <Grid> —
// a root of its own inside #grid, rendered by the feed engine — subscribes
// for itself. state.mjs holds the snapshot only.

const listeners = new Set();

export function render() {
  for (const fn of listeners) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
