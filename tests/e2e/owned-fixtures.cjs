// Scenario-private fake mutations. Enroll before IO: a lost response does not
// prove publication/start/finish failed. Never sweep another scenario's jobs.
function ownedFixtures({ control, read }) {
  const outputs = new Set(), jobs = new Set();
  const queueIds = queue => [...queue.queue_running, ...queue.queue_pending].map(row => row[1]);
  return {
    async publish(items) {
      for (const item of items) outputs.add(item.name);
      return control({ publish: items });
    },
    async start(id) {
      jobs.add(id);
      const queue = await read('/api/queue');
      return control({ running: [...new Set([...queue.queue_running.map(row => row[1]), id])] });
    },
    async finish(id, items) {
      jobs.add(id);
      for (const item of items) if (item.output) outputs.add(item.output);
      // Do not forget job ownership on a response: cleanup independently reads
      // authoritative queue/history, including a successful but lost reply.
      return control({ finish: items.map(item => ({ ...item, id })) });
    },
    async run(operation, cleanup = () => {}) {
      let primary;
      try { return await operation(); }
      catch (error) { primary = error; throw error; }
      finally {
        const results = await Promise.allSettled([
          Promise.resolve().then(cleanup),
          ...[...jobs].map(async id => {
            const queue = await read('/api/queue'), history = await read('/api/history');
            if (!queueIds(queue).includes(id)) return;
            if (history[id]?.status?.completed) throw new Error(`Successful job still active: ${id}`);
            await control({ finish: [{ id, outcome: 'interrupted' }] });
          }),
          ...(outputs.size ? [Promise.resolve().then(() => control({ remove: [...outputs] }))] : []),
        ]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) {
          if (primary) primary.cleanupErrors = failures;
          else throw new AggregateError(failures, 'Scenario fixture cleanup failed');
        }
      }
    },
  };
}
function fakeFixtures(origin, control) {
  return ownedFixtures({ control, read: async route => {
    const response = await fetch(origin + route);
    if (!response.ok) throw new Error(`Fake read ${route}: ${response.status}`);
    return response.json();
  } });
}
module.exports = { ownedFixtures, fakeFixtures };
