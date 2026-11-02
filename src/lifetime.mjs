// One engine cancellation boundary. Children keep their own resource cleanup;
// all asynchronous owners join this signal and publish their outstanding work.
export class EngineLifetime {
  #controller = new AbortController();
  #pending = new Map();
  get signal() { return this.#controller.signal; }
  stop() { this.#controller.abort(new DOMException("Engine stopping", "AbortError")); }
  pending() { return [...this.#pending.values()]; }
  track(name, task) {
    const token = {};
    this.#pending.set(token, name);
    const result = Promise.resolve(task);
    const release = () => this.#pending.delete(token);
    result.then(release, release);
    return result;
  }
  async drain() {
    // Track promises separately from labels, including work installed by a
    // settling handler. Admission is already closed before this is called.
    while (this.#tasks.size) await Promise.allSettled([...this.#tasks]);
  }
  #tasks = new Set();
  run(name, operation) {
    const task = this.track(name, Promise.resolve().then(operation));
    this.#tasks.add(task);
    const release = () => this.#tasks.delete(task);
    task.then(release, release);
    return task;
  }
  fetch = (input, options = {}) => fetch(input, { ...options,
    signal: options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal });
}

// Cancellation wakes waits normally, letting their owning loops retire through
// the same finally paths without leaving a deadline/interval alive.
export function waitFor(ms, signal) {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}
