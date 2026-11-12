const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ownedFixtures } = require('./owned-fixtures.cjs');
(async () => {
  const origin = process.env.E2E_FAKE, records = [];
  const read = async route => { const r = await fetch(origin + route); assert(r.ok); return r.json(); };
  const control = async body => { const r = await fetch(origin + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok); return r.json(); };
  for (const phase of ['publish', 'start', 'finish', 'success']) {
    const id = 'cleanup-' + require('node:crypto').randomUUID(), name = id + '.png';
    let terminal;
    const owner = ownedFixtures({ read, control: async body => {
      const result = await control(body);
      if (body.finish?.[0].output) terminal = (await read('/api/history'))[id];
      if (phase === 'publish' && body.publish || phase === 'start' && body.running || phase === 'finish' && body.finish?.[0].output) throw new Error('injected lost reply');
      return result;
    } });
    const operation = () => owner.run(async () => {
      if (phase === 'publish') await owner.publish([{ name, fixture: 'flux-basic.png' }]);
      else { await owner.start(id); await owner.finish(id, [{ output: name, fixture: 'flux-basic.png' }]); }
    });
    if (phase === 'success') await operation(); else await assert.rejects(operation, /injected lost reply/);
    const queue = await read('/api/queue'), history = await read('/api/history');
    assert(![...queue.queue_running, ...queue.queue_pending].some(row => row[1] === id));
    const bytes = await fetch(origin + '/api/view?type=output&filename=' + encodeURIComponent(name)); assert.equal(bytes.status, 404);
    if (terminal) assert.deepEqual(history[id], terminal, 'cleanup preserves successful terminal history');
    records.push({ phase, id, name, absent: true, terminalPreserved: !!terminal });
  }
  fs.writeFileSync(process.env.E2E_EVIDENCE + '/fixture-cleanup.json', JSON.stringify(records));
  console.log('PASS real fake output/job early failure, lost finish reply and successful history preservation');
})().catch(error => { console.error(error); process.exitCode = 1; });
