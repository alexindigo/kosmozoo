// A collection-level negative may outlive the delta that superseded it.
// Reproduce that boundary with a cached negative inventory and an already
// consumed cursor, while the entry routes retain the real engine records.
const http = require('node:http');
const assert = require('node:assert/strict');
const { CDP, collectPageErrors } = require('./cdp.cjs');

module.exports = async ({ ENGINE, FAKE, check }) => {
  const source = 'metadata-negative';
  const folder = 'metadata-negative';
  const cases = [
    { name: `${folder}/nested # percent%2F ${'long-'.repeat(25)}.mp4`, fixture: 'media/workflow.mp4', token: 'A moving cosmic zoo' },
    { name: `${folder}/nested # image.png`, fixture: 'bulk', width: 96, height: 64,
      graph: { '1': { class_type: 'NegativeMetadataToken', inputs: { token: 'shown image metadata' } } }, token: 'shown image metadata' },
    { name: `${folder}/bare.png`, fixture: 'bulk', token: null },
  ];
  const json = async (url, body) => {
    const response = await fetch(url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert(response.ok, `${url}: ${response.status}`);
    return response.json();
  };
  const KZ = `(await import('/store/instance.js')).appStore`;
  const oldPrefetch = await json(ENGINE + '/api/prefetch');
  let proxy, page;
  const records = new Map();
  try {
    await json(ENGINE + '/api/prefetch', { enabled: false, paused: false });
    await json(ENGINE + '/api/collections', { name: source, address: new URL(FAKE).host });
    await json(FAKE + '/__test/activity', { publish: cases.map((item, i) => ({ ...item, mtime: 2160000000 - i })) });
    for (const item of cases) {
      const record = await json(`${ENGINE}/api/collections/${source}/entries/${encodeURIComponent(item.name)}/meta`);
      assert.equal(record.extracted, true);
      assert.equal(!!record.meta, !!item.token);
    }
    const inventory = await json(`${ENGINE}/api/collections/${source}/entries?inventory=1`);
    // This is the already-consumed negative snapshot, not the entry's record.
    for (const item of inventory.entries) if (cases.some(c => c.name === item.name)) item.meta = null;
    proxy = http.createServer((req, res) => {
      const path = new URL(req.url, ENGINE).pathname;
      if (path === `/api/collections/${source}/entries` && req.url.includes('inventory=1')) {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(inventory)); return;
      }
      if (path.endsWith('/meta') && path.includes(`/collections/${source}/entries/`)) records.set(path, (records.get(path) ?? 0) + 1);
      const upstream = http.request(ENGINE + req.url, { method: req.method, headers: { ...req.headers, host: new URL(ENGINE).host } }, reply => {
        res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
      });
      upstream.on('error', error => { if (!res.destroyed) { res.writeHead(502); res.end(String(error)); } });
      res.once('close', () => upstream.destroy()); req.pipe(upstream);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    page = await CDP.launch(9348, { windowSize: '1500,1000' });
    const errors = await collectPageErrors(page);
    const origin = `http://127.0.0.1:${proxy.address().port}`;
    await page.goto(`${origin}/?folder=${folder}#${source}#${encodeURIComponent(cases[0].name)}`);
    await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(cases[0].name)}))()`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
    for (const item of cases) {
      await page.evaluate(`(async()=>${KZ}.handles.invoke('entry.select',{source:${JSON.stringify(source)},file:${JSON.stringify(item.name)}}))()`);
      const path = `/api/collections/${source}/entries/${encodeURIComponent(item.name)}/meta`;
      await page.poll(`(async()=>{const s=${KZ},e=s.state.currentEntry()?.entry,t=document.querySelector('#workspace .info-body')?.innerText;
        return e?.filename===${JSON.stringify(item.name)}&&${item.token
          ? `!!e.meta?.nodes?.length&&t?.includes(${JSON.stringify(item.token)})&&!t.includes('No embedded generation parameters')`
          : `e.extracted&&t?.includes('No embedded generation parameters')`};})()`, 5000);
      // The negative case must have received its direct record too, not merely
      // rendered the listing's old fallback before its read started.
      for (let i = 0; !records.get(path) && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(records.get(path), 1, 'one shown-record read per identity, including a genuine negative');
      check(`metadata negative: ${item.token ? item.name.endsWith('.mp4') ? 'video' : 'image' : 'genuine absence'} verified through its own record`, true);
    }
    assert.deepEqual(errors, []);
  } finally {
    if (page) await page.close();
    if (proxy) { const closed = new Promise(resolve => proxy.close(resolve)); proxy.closeAllConnections(); await closed; }
    await json(ENGINE + '/api/prefetch', { enabled: oldPrefetch.enabled, paused: oldPrefetch.paused });
    await fetch(`${ENGINE}/api/collections/${source}`, { method: 'DELETE' });
    await json(FAKE + '/__test/activity', { remove: cases.map(item => item.name) });
  }
};
