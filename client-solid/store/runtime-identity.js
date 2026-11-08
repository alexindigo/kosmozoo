// One page-owned runtime observation. Read/transport, projection and clocks are
// injected; this owner never touches browsing, editors or browser lifecycle APIs.
export function makeRuntimeIdentity({ read, publish, schedule = setTimeout, cancel = clearTimeout }) {
  let started = false, suspended = false, disposed = false, settled = false;
  let flight = null, retry = null, failures = 0;
  const active = () => started && !suspended && !disposed;
  const owns = ticket => active() && flight === ticket;

  function stop() {
    if (retry) { cancel(retry.timer); retry = null; }
    const previous = flight;
    flight = null; // Fence before abort, including transports that ignore it.
    if (previous) { cancel(previous.deadline); previous.controller.abort(); }
  }

  function finish(ticket, value) {
    if (!owns(ticket)) return;
    cancel(ticket.deadline);
    flight = null;
    if (typeof value === "string" && value) {
      settled = true;
      failures = 0;
      publish(value);
      return;
    }
    ticket.controller.abort();
    // Only the backoff grows, never an unbounded exponent or a second flight.
    const delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5));
    const pending = {};
    retry = pending;
    pending.timer = schedule(() => {
      if (!active() || retry !== pending) return;
      retry = null;
      acquire();
    }, delay);
  }

  function acquire() {
    if (!active() || settled || flight || retry) return;
    const ticket = { controller: new AbortController() };
    flight = ticket;
    ticket.deadline = schedule(() => finish(ticket), 10000);
    Promise.resolve().then(() => {
      if (owns(ticket)) return read({ signal: ticket.controller.signal });
    }).then(value => finish(ticket, value), () => finish(ticket));
  }

  return {
    start() { if (disposed) return; started = true; acquire(); },
    suspend() { if (disposed || suspended) return; suspended = true; settled = false; stop(); },
    resume() { if (disposed || !suspended) return; suspended = false; acquire(); },
    dispose() { if (disposed) return; disposed = true; stop(); },
  };
}
