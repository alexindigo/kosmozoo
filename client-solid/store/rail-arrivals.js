// Store-owned one-shot delivery, independent of tick/rail DOM lifetimes.
import { createSignal } from "solid-js";

export function makeRailArrivals() {
  let epoch = 0, pending = new Set();
  const [event, setEvent] = createSignal({ epoch });
  const [waiting, setWaiting] = createSignal([]);
  return {
    event,
    waiting,
    stage(ids) {
      if (ids.length) setWaiting(previous => [...new Set([...previous, ...ids])]);
    },
    resolve(ready, present) {
      // Size readiness is feed admission. Filter/tape exclusion is not a delay:
      // the rail consumes every ready identity, even when it has no visible tick.
      const resolved = new Set(ready);
      setWaiting(previous => {
        const remaining = previous.filter(id => present.has(id) && !resolved.has(id));
        return remaining.length === previous.length ? previous : remaining;
      });
      if (ready.length) {
        for (const id of ready) pending.add(id);
        setEvent({ epoch });
      }
    },
    take(ticket) {
      if (ticket !== event()) return [];
      const ids = [...pending];
      pending.clear();
      return ids;
    },
    retire() {
      setWaiting([]);
      pending.clear();
      setEvent({ epoch: ++epoch });
    },
  };
}
