const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.KZ_TIME_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const req = async (base, path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, `${path} ${r.status}`); return r.json();
};
const timed = (id, ms) => ({ id, output: `batch/${id}.png`, fixture: 'flux-basic.png', graphPrefix: `batch/${id}`, messages: [
  ['execution_start', { prompt_id: id, timestamp: 1700000000000 }], ['execution_success', { prompt_id: id, timestamp: 1700000000000 + ms }],
] });
(async () => {
  fs.mkdirSync(D, { recursive: true });
  await req(F, '/__test/activity', { captureEnqueue: true, finish: [timed('a', 720000), timed('b', 360000)], publish: [{ name: 'batch/unknown.png', fixture: 'flux-basic.png' }] });
  const deadline = Date.now() + 15000;
  while ((await req(B, '/api/collections/fake/entries/batch%2Fa.png/meta')).generationTimeMs !== 720000) {
    assert(Date.now() < deadline, 'fixture timing not observed'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const c = await CDP.launch(19491, { windowSize: '1400,900' }), errors = await collectPageErrors(c), states = [];
  c.ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) console.log('failed resource', m.params.response.status, m.params.response.url); });
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const field = (selector, value) => c.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(D + '/' + name + '.png', Buffer.from(s.data, 'base64')); };
  const row = '[data-param-key="9.steps"]';
  const close = async () => { await c.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`); if (await c.evaluate(`!!document.querySelector('.vz-discard-confirm')`)) await c.clickAt('.vz-discard-confirm'); await c.poll(`!document.querySelector('.vz-panel')`); };
  const remove = id => c.clickAt(`[data-target-id="fake:batch/${id}.png"] .vz-batch-remove`);
  try {
    await c.goto(B + '/#fake#batch%2Fa.png');
    await c.poll(`(async()=>${KZ}.state.images.some(i=>i.filename==='batch/unknown.png'))()`, 20000);
    await invoke('variations.open', { ids: ['a', 'b', 'unknown'].map(id => `fake:batch/${id}.png`), bulk: true });
    await addParameter(c, '9.steps'); await c.clickAt(row + ' .mode-switch button[title="Value"]'); await field(row + ' .vz-value-field input', '19');
    await c.poll(`document.querySelectorAll('.vz-batch-item').length===3 && document.querySelector('.vz-time-value')?.textContent==='above 18m'`, 20000);
    await c.poll(`[...document.querySelectorAll('.vz-batch-thumbnail img')].every(i=>i.naturalWidth>0)`, 20000);
    const items = await c.evaluate(`[...document.querySelectorAll('.vz-batch-item')].map(e=>({id:e.dataset.targetId,name:e.querySelector('.vz-batch-name').textContent,time:e.querySelector('.vz-batch-time').textContent}))`);
    assert.deepEqual(items.map(i => i.time), ['Generation time: 12m 0s', 'Generation time: 6m 0s', 'Generation time: --']);
    const geometry = await c.evaluate(`(()=>{const b=document.querySelector('.vz-batch').getBoundingClientRect(),body=document.querySelector('.vz-body-scroll').getBoundingClientRect(),run=document.querySelector('.vz-run').getBoundingClientRect(),panel=document.querySelector('.vz-panel').getBoundingClientRect();return {batch:b.toJSON(),body:body.toJSON(),run:run.toJSON(),panel:panel.toJSON()};})()`);
    assert(geometry.batch.top >= geometry.body.bottom && geometry.run.bottom <= geometry.batch.top && geometry.batch.bottom <= geometry.panel.bottom);
    states.push({ count: 3, items, geometry }); await shot('batch-three-targets');
    // Removing the original workflow target must retain the existing native input.
    await c.evaluate(`window.batchField=document.querySelector(${JSON.stringify(row + ' .vz-value-field input')})`);
    await remove('a');
    await c.poll(`document.querySelectorAll('.vz-batch-item').length===2 && document.querySelector('.vz-count').textContent==='2' && document.querySelector('.vz-time-value').textContent==='above 6m'`);
    assert(await c.evaluate(`window.batchField===document.querySelector(${JSON.stringify(row + ' .vz-value-field input')})&&window.batchField.value==='19'`));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 850, height: 600, deviceScaleFactor: 1, mobile: false });
    await c.evaluate(`(()=>{const b=document.querySelector('.vz-body-scroll');b.scrollLeft=b.scrollWidth;})()`);
    await c.poll(`(()=>{const r=document.querySelector('.vz-run').getBoundingClientRect(),b=document.querySelector('.vz-batch').getBoundingClientRect(),p=document.querySelector('.vz-panel').getBoundingClientRect();return r.right<=p.right&&r.bottom<=b.top&&b.bottom<=p.bottom})()`);
    await shot('batch-narrow-two-targets'); states.push({ count: 2, narrow: true });
    await c.send('Emulation.clearDeviceMetricsOverride');
    await remove('unknown');
    await c.poll(`!document.querySelector('.vz-batch')&&document.querySelector('.vz-count').textContent==='1'&&document.querySelector('.vz-time-value').textContent==='6m'`);
    assert(await c.evaluate(`document.querySelector('.vz-title').textContent.includes('applying to 1 image')`));
    await shot('batch-one-strip-hidden'); states.push({ count: 1, hidden: true });
    const run = await invoke('variations.run'); assert.equal(run.adopted, true, JSON.stringify(run)); assert.equal(run.submitted, 1);
    const history = await req(B, '/api/features/variations/history'), saved = await req(B, '/api/features/variations/history/' + history.items[0].id);
    assert.equal(saved.cohortMode, 'bulk'); assert.deepEqual(saved.targets.map(t => t.filename), ['batch/b.png']);
    assert.equal((await req(F, '/__test/enqueues')).length, 1);
    if (await c.evaluate(`!!document.querySelector('.vz-panel')`)) await close();
    await invoke('variations.history.open', { id: saved.id });
    await c.poll(`!!document.querySelector('.vz-panel')&&document.querySelectorAll('.vz-catalogue-row').length>0`);
    assert.equal(await c.evaluate(`!!document.querySelector('.vz-batch')`), false);
    assert(await c.evaluate(`document.querySelector('.vz-title').textContent.includes('applying to 1 image')`));
    await close();
    // Membership alone is unsent work; it must pass the ordinary discard guard.
    await invoke('variations.open', { ids: ['fake:batch/a.png', 'fake:batch/b.png'], bulk: true });
    await c.poll(`document.querySelectorAll('.vz-batch-item').length===2`); await remove('a');
    await c.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    await c.poll(`!!document.querySelector('.vz-discard-confirm')`); await c.clickAt('.vz-discard-confirm');
    assert.deepEqual(errors, []);
    fs.writeFileSync(D + '/result.json', JSON.stringify({ states, savedTargets: saved.targets.map(t => t.filename), cohortMode: saved.cohortMode, pageErrors: errors, submittedFakeJobs: 1 }, null, 2));
    console.log(JSON.stringify({ states: states.map(s => s.count), savedTargets: saved.targets.map(t => t.filename), cohortMode: saved.cohortMode, pageErrors: errors }));
  } catch (error) {
    console.log('batch diagnostic', await c.evaluate(`JSON.stringify({items:document.querySelectorAll('.vz-batch-item').length,count:document.querySelector('.vz-count')?.textContent,time:document.querySelector('.vz-time-value')?.textContent,messages:document.querySelector('.vz-messages')?.textContent,itemsText:document.querySelector('.vz-batch')?.textContent})`));
    await shot('batch-diagnostic'); throw error;
  } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
