import { InventoryError, cancelled, finalizeInventory, freezeTree, bounded } from "./inventory.mjs";

// No URLs, database or kind dispatch. One owner coordinates complete waves.
export function makeInventoryOwner({ collect, clock = () => performance.now(), epoch = crypto.randomUUID(),
  waveTimeoutMs = 60_000, readerTimeoutMs = 120_000 } = {}) {
  const lifecycle = new AbortController();
  let requested = 0, published = 0, revision = 0, snapshot = null, sampledAt = 0;
  let draining = null, stopped = false, activeWave = null, activeGeneration = 0, drainInvalidations = false;
  const cohorts = new Set();
  const settle = (cohort, error, value) => {
    if (!cohorts.delete(cohort)) return;
    clearTimeout(cohort.timer);
    if (error) cohort.reject(error); else cohort.resolve(value);
  };
  async function drain() {
    while (!stopped && (cohorts.size || drainInvalidations && requested > published)) {
      const generation = requested;
      const wave = new AbortController(); activeWave = wave; activeGeneration = generation;
      const signal = AbortSignal.any([lifecycle.signal, wave.signal]);
      for (const cohort of cohorts) if (cohort.phase === "initial" && cohort.target <= generation) cohort.started = generation;
      try {
        const candidate = await bounded(() => collect({ signal, generation, deadlineMs: clock() + waveTimeoutMs }), {
          signal, timeoutMs: waveTimeoutMs,
          timeoutError: new InventoryError("wave-deadline", "Complete inventory wave exceeded its deadline"),
          onTimeout: (error) => wave.abort(error),
        });
        if (stopped || signal.aborted) throw signal.reason ?? cancelled();
        const complete = finalizeInventory(candidate);
        snapshot = freezeTree({ ...complete, revision: `${epoch}:${++revision}`, generation });
        published = generation; sampledAt = clock();
        for (const cohort of [...cohorts]) {
          if (cohort.phase === "follow-up") {
            if (generation >= cohort.target) settle(cohort, null, snapshot);
          } else if (cohort.started === generation) {
            if (requested > generation) { cohort.phase = "follow-up"; cohort.target = requested; }
            else settle(cohort, null, snapshot);
          }
        }
      } catch (error) {
        wave.abort(error);
        for (const cohort of [...cohorts]) if (cohort.started === generation || cohort.phase === "follow-up" && cohort.target <= generation) settle(cohort, error);
        drainInvalidations = false;
        if (!cohorts.size) break;
      } finally { if (activeWave === wave) activeWave = null; }
    }
  }
  const launch = () => {
    if (draining || stopped) return;
    draining = Promise.resolve().then(drain).finally(() => {
      draining = null;
      if (!stopped && cohorts.size) launch();
    });
  };
  return {
    signal: lifecycle.signal,
    inventory({ maxAgeMs = 0 } = {}) {
      if (stopped) return Promise.reject(cancelled("Inventory owner disposed"));
      if (snapshot && requested === published && maxAgeMs > 0 && clock() - sampledAt < maxAgeMs) return Promise.resolve(snapshot);
      // A settled wave's drain promise may still be unwinding its finally.
      // It must not prevent a genuinely fresh read from advancing generation.
      if (!activeWave && requested === published) requested++;
      if (requested === 0) requested = 1;
      const target = requested;
      const joined = [...cohorts].find((c) => c.target === target);
      if (joined) return joined.promise;
      const cohort = { target, phase: "initial", started: activeWave && activeGeneration >= target ? activeGeneration : null };
      cohort.promise = new Promise((resolve, reject) => { cohort.resolve = resolve; cohort.reject = reject; });
      cohort.timer = setTimeout(() => settle(cohort, new InventoryError("reader-deadline", "Inventory reader freshness target exceeded its bound")), readerTimeoutMs);
      cohorts.add(cohort); launch(); return cohort.promise;
    },
    invalidateInventory() {
      if (stopped) return;
      requested++;
      if (draining) drainInvalidations = true;
    },
    peekInventory() { return snapshot; },
    async disposeInventory() {
      if (stopped) return;
      stopped = true; const error = cancelled("Inventory owner disposed");
      lifecycle.abort(error); activeWave?.abort(error);
      for (const cohort of [...cohorts]) settle(cohort, error);
      await draining;
    },
  };
}
