const assert = require('node:assert/strict');
const fs = require('node:fs');
module.exports = async ({ page, evaluate, E, original, permanent }) => {
  let held, leaseId, deletes = 0;
  const tasks = [];
  const intercept = event => {
    const message = JSON.parse(event.data);
    if (message.method !== 'Fetch.requestPaused') return;
    const p = message.params;
    if (p.request.url.endsWith('/open')) { held = p.requestId; return; }
    if (p.request.method !== 'DELETE') { tasks.push(page.send('Fetch.continueRequest', { requestId: p.requestId })); return; }
    deletes++;
    tasks.push(page.send(deletes === 1 || permanent ? 'Fetch.fulfillRequest' : 'Fetch.continueRequest', {
      requestId: p.requestId,
      ...(deletes === 1 || permanent ? { responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"injected release failure"}').toString('base64') } : {}),
    }));
  };
  page.ws.addEventListener('message', intercept);
  await page.send('Fetch.enable', { patterns: [
    { urlPattern: `*/api/features/variations/history/${original.id}/open`, requestStage: 'Response' },
    { urlPattern: '*/api/features/variations/history/*/leases/*', requestStage: 'Request' },
  ] });
  try {
    await evaluate(`(async()=>{
      const {install}=await import('/features/variations/index.js');
      const store=(await import('/store/instance.js')).appStore;
      const listeners=new Set(),add=window.addEventListener,remove=window.removeEventListener;
      window.addEventListener=function(type,fn,...rest){if(type==='focus'||type==='pageshow')listeners.add(fn);return add.call(this,type,fn,...rest)};
      window.removeEventListener=function(type,fn,...rest){listeners.delete(fn);return remove.call(this,type,fn,...rest)};
      try { window.disposalFeature=install(store); } finally { window.addEventListener=add; }
      window.disposalHistory=window.disposalFeature.ports.services.history;
      window.disposalOpen=window.disposalHistory.open(${JSON.stringify(original.id)}).then(()=>({published:true}),e=>({error:e.message}));
      window.disposalFinish=()=>{window.disposalDrain=window.disposalFeature.dispose().then(results=>{window.disposalResult=results.map(r=>r.status);return results});window.disposalListeners=listeners.size;window.removeEventListener=remove;};
    })()`);
    for (let i = 0; i < 200 && !held; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(held, 'server acquisition response held before disposal');
    const body = await page.send('Fetch.getResponseBody', { requestId: held });
    leaseId = JSON.parse(body.base64Encoded ? Buffer.from(body.body, 'base64').toString() : body.body).leaseId;
    assert(leaseId);
    await evaluate('window.disposalFinish()');
    assert.equal(await page.evaluate('window.disposalResult===undefined'), true, 'drain waits for admitted open');
    assert.equal(await page.evaluate('window.disposalListeners'), 0, 'feature listeners retire synchronously');
    await page.send('Fetch.continueRequest', { requestId: held }); held = null;
    await page.poll('Array.isArray(window.disposalResult)', 20000);
    const result = await evaluate(`(async()=>({id:${JSON.stringify(original.id)},leaseId:${JSON.stringify(leaseId)},open:await window.disposalOpen,
      results:window.disposalResult,retained:!!window.disposalHistory.retained(${JSON.stringify(original.id)},${JSON.stringify(leaseId)}),error:window.disposalHistory.state().error}))()`);
    assert.equal(deletes, 2, 'bounded initial DELETE plus one retry');
    assert.equal(result.open.error, 'History entry unavailable'); assert.equal(result.retained, permanent);
    assert.deepEqual(result.results, [permanent ? 'rejected' : 'fulfilled']);
    if (permanent) assert(result.error.includes('release failed'));
    fs.writeFileSync(E + '/disposal.json', JSON.stringify({ ...result, deletes, permanent }));
    await Promise.all(tasks);
    console.log('PASS feature disposal late acquisition, bounded DELETE and retained client outcome');
  } finally {
    if (held) await page.send('Fetch.continueRequest', { requestId: held }).catch(() => {});
    await page.send('Fetch.disable'); page.ws.removeEventListener('message', intercept);
  }
};
