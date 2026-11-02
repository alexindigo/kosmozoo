// A slow source at the browser's real HTTP boundary, not CDP interception.
// The inventory/registry snapshots precede extraction; wants/deltas/registry
// reads go to the real engine after extraction. Native bytes remain slow.
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');

module.exports = async ({ ENGINE, FAKE, check }) => {
  const source = 'metadata-position', results = [];
  const request = async (path, body) => {
    const response = await fetch(ENGINE + path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const control = async body => {
    const response = await fetch(FAKE + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert(response.ok); await response.json();
  };
  const KZ = `(await import('/store/instance.js')).appStore`;
  const oldPrefetch = await request('/api/prefetch');
  let page, proxy;
  try {
    await request('/api/prefetch', { enabled: false, paused: false });
    await request('/api/collections', { name: source, address: new URL(FAKE).host });
    let sequence = 0;
    for (const delay of [12000, 0]) {
      for (const scenario of ['initial', 'back-top', 'source-switch', 'middle', 'last', 'single']) {
        const count = scenario === 'single' ? 1 : 25;
        const folder = `metadata-position/${sequence++}`;
        const nodeType = `MetadataPosition${sequence}`;
        const names = Array.from({ length: count }, (_, i) => `${folder}/${String(i).padStart(2, '0')}.png`);
        const token = `metadata-${delay ? 'slow' : 'fast'}-${scenario}`;
        // The registry is engine-wide: another live alias may ingest a graph
        // as soon as it is published, even while this collection has no hash.
        // Capture its old schema before making the new type observable.
        const registry = await request('/api/nodes');
        assert(!registry[nodeType], 'new graph type is absent from the captured registry');
        await control({ publish: names.map((name, i) => ({ name, fixture: 'bulk', width: 96, height: 64,
          mtime: 2150000000 + sequence * 100 - i,
          graph: { '1': { class_type: nodeType, inputs: { token: `${token}-${i}` } } } })) });
        await request(`/api/collections/${source}/entries?inventory=1`);
        await request(`/api/collections/${source}/want`, { files: names, interest: 'dimensions' });
        let inventory;
        const deadline = Date.now() + 10000;
        do {
          inventory = await request(`/api/collections/${source}/entries?inventory=1`);
          if (names.every(name => inventory.entries.some(e => e.name === name && e.width && e.height))) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        assert(names.every(name => inventory.entries.some(e => e.name === name && e.width && e.height)), 'fixture dimensions ready');
        assert(names.every(name => inventory.entries.some(e => e.name === name && !e.meta && !e.extracted)), 'snapshot actually precedes extraction');
        for (const name of names) {
          const bytes = await fetch(`${ENGINE}/api/collections/${source}/entries/${encodeURIComponent(name)}/bytes`);
          assert(bytes.ok); await bytes.arrayBuffer();
        }
        let firstRegistry = true, activeBytes = 0, byteStarts = 0;
        const timers = new Set(), trace = [];
        proxy = http.createServer((req, res) => {
          const path = new URL(req.url, ENGINE).pathname;
          if (path === `/api/collections/${source}/entries` && req.url.includes('inventory=1')) {
            res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(inventory)); return;
          }
          if (path === '/api/nodes' && firstRegistry) {
            firstRegistry = false; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(registry)); return;
          }
          const row = { path, start: Date.now() }; trace.push(row);
          const upstream = http.request(ENGINE + req.url, { method: req.method, headers: { ...req.headers, host: new URL(ENGINE).host } }, response => {
            const send = () => { res.writeHead(response.statusCode, response.headers); response.pipe(res); };
            if (path.endsWith('/bytes') && req.method === 'GET') {
              activeBytes++; byteStarts++;
              let settled = false;
              const done = () => { if (!settled) { settled = true; activeBytes--; row.end = Date.now(); } };
              res.once('close', done); res.once('finish', done);
              const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) send(); else response.destroy(); }, delay);
              timers.add(timer);
              res.once('close', () => { clearTimeout(timer); timers.delete(timer); response.destroy(); });
            } else send();
          });
          upstream.on('error', error => { if (!res.destroyed) { res.writeHead(502); res.end(String(error)); } });
          res.once('close', () => upstream.destroy()); req.pipe(upstream);
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${proxy.address().port}`;
        page = await CDP.launch(9343, { windowSize: '1600,1100' });
        const errors = await collectPageErrors(page);
        const index = scenario === 'last' ? count - 1 : scenario === 'middle' ? Math.floor(count / 2) : 0;
        const selected = names[index];
        const started = Date.now();
        let failure;
        try {
          await page.goto(`${origin}/?folder=${encodeURIComponent(folder)}#${source}#${encodeURIComponent(selected)}`);
          await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(selected)}))()`, 10000);
          await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
          const metadataReady = `(async()=>{const s=${KZ},e=s.state.currentEntry()?.entry;
            return e?.filename===${JSON.stringify(selected)}&&e.meta?.nodes?.some(n=>n.inputs.token===${JSON.stringify(`${token}-${index}`)})&&
              document.querySelector('#workspace .info-body')?.innerText.includes(${JSON.stringify(`${token}-${index}`)});})()`;
          await page.poll(metadataReady, 5000);
          const firstMs = Date.now() - started;
          assert(firstMs <= 5000, `initial selection-to-fields deadline: ${firstMs}ms`);
          if (delay) assert(activeBytes > 0 && byteStarts > 0, 'metadata is rendered before pending image responses finish');
          let selectionMs = firstMs;
          if (scenario === 'back-top') {
            await page.evaluate(`(async()=>{const s=${KZ};s.actions.current.set(${JSON.stringify(source)},${JSON.stringify(names.at(-1))});s.actions.feed.restoreToIndex(s.state.currentEntry().index)})()`);
            await page.poll(`(async()=>${KZ}.state.feedScrollEl().scrollTop>1000)()`);
            await page.evaluate(`(async()=>${KZ}.actions.feed.scrollTop())()`);
            await page.poll(`(async()=>${KZ}.state.feedScrollEl().scrollTop===0)()`);
            const selectedAt = Date.now();
            await page.evaluate(`(async()=>${KZ}.handles.invoke('entry.select',{source:${JSON.stringify(source)},file:${JSON.stringify(selected)}}))()`);
            await page.poll(metadataReady, 5000);
            selectionMs = Date.now() - selectedAt;
            assert.equal(await page.evaluate(`(async()=>${KZ}.state.feedScrollEl().scrollTop)()`), 0);
          }
          if (scenario === 'source-switch') {
            await page.evaluate(`(async()=>${KZ}.actions.hosts.select('fixture-dir'))()`);
            const selectedAt = Date.now();
            // Observe the consumer from the intent, not after select's load
            // Promise (which itself waits on metadata) has already completed.
            await page.evaluate(`(async()=>{const s=${KZ};window.__metadataSwitch=s.actions.hosts.select(${JSON.stringify(source)});})()`);
            await page.poll(metadataReady, 5000);
            selectionMs = Date.now() - selectedAt;
          }
          assert(selectionMs <= 5000, `selection-to-fields deadline: ${selectionMs}ms`);
          if (delay) assert(activeBytes > 0, 'image responses remain pending at the selected consumer outcome');
          const state = await page.evaluate(`(async()=>{const s=${KZ},e=s.state.currentEntry();return{current:s.state.current(),
            position:s.state.view().indexOf(e.index),count:s.state.view().length,details:document.querySelector('#workspace .info-body').innerText};})()`);
          assert.equal(state.position, index); assert.equal(state.count, count); assert.deepEqual(errors, []);
          results.push({ delay, scenario, firstMs, selectionMs, activeBytes, byteStarts, state, trace });
          check(`metadata positions: ${delay ? 'slow' : 'fast'} ${scenario} renders the selected graph fields within 5s${delay ? ' while image bytes are pending' : ''}`, true,
            JSON.stringify({ firstMs, selectionMs, activeBytes, byteStarts, position: state.position, count }));
          if (delay && scenario === 'initial') {
            const shot = await page.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(workPath('tests/e2e/.shots/metadata-slow-top.png'), Buffer.from(shot.data, 'base64'));
          }
        } catch (error) {
          failure = error;
          const state = await page.evaluate(`(async()=>{const s=${KZ};return{current:s.state.current(),details:document.querySelector('#workspace .info-body')?.innerText}})()`);
          results.push({ delay, scenario, activeBytes, byteStarts, state, trace, error: String(error) });
          if (delay && scenario === 'initial') {
            const shot = await page.send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(workPath('tests/e2e/.shots/metadata-slow-top-failed.png'), Buffer.from(shot.data, 'base64'));
          }
          check(`metadata positions: ${delay ? 'slow' : 'fast'} ${scenario}`, false, `${error.message}; ${JSON.stringify({activeBytes,byteStarts,state})}`);
        } finally {
          await page.close(); page = null;
          for (const timer of timers) clearTimeout(timer);
          proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null;
          fs.mkdirSync(workPath('tests/e2e/.shots'), { recursive: true });
          fs.writeFileSync(workPath('tests/e2e/.shots/metadata-position.json'), JSON.stringify(results, null, 2));
        }
        if (failure) throw failure;
      }
    }
  } finally {
    if (page) await page.close();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    await request('/api/prefetch', { enabled: oldPrefetch.enabled, paused: oldPrefetch.paused });
    await fetch(`${ENGINE}/api/collections/${source}`, { method: 'DELETE' });
  }
};
