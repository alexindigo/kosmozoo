// One Run-owned read lifetime. A completed/stale read cannot publish or re-arm.
export function observeSubmission({ read, publish, failure = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const controller = new AbortController();
  let alive = true, timer = null, pending = null, last = null;
  const poll = () => {
    if (!alive) return;
    pending = Promise.resolve().then(() => alive ? read(controller.signal) : null).then(value => {
      if (!Number.isSafeInteger(value?.sent) || value.sent < 0 || !Number.isSafeInteger(value?.total) || value.total < value.sent) throw new Error("Invalid submission progress record");
      if (alive) { last = value; publish(value); }
    }).catch(error => {
      // A read failure is not an enqueue failure or permission to retry effects.
      if (alive) { failure(error, last); publish(null); }
    }).finally(() => {
      pending = null;
      if (alive) timer = setTimer(poll, 500);
    });
  };
  poll();
  return async () => {
    alive = false; controller.abort();
    if (timer !== null) clearTimer(timer);
    await pending;
  };
}
