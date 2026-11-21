const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage, settledCount } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.E2E_EVIDENCE ?? process.env.KZ_TIME_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const names = ['selection-one.png', 'selection-two.png', 'selection-three.png'];
const graph = { '470': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
  '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'selection', images: ['470', 0] } } };
const post = async (base, path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
};
(async () => {
  assert(B && F, 'card-selection needs E2E_ENGINE and E2E_FAKE');
  await post(F, '/__test/activity', { captureEnqueue: true, publish: names.map((name, index) => ({ name, graph, fixture: 'flux-basic.png', mtime: 2100000700 + index })) });
  for (const name of names) assert((await fetch(B + `/api/collections/fake/entries/${name}/bytes`)).ok);
  const info = await (await fetch(F + '/api/object_info')).json();
  await post(F, '/__test/activity', { objectInfoByHost: { '127.0.0.2': info } });
  const added = await fetch(B + '/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'selection-other', address: `127.0.0.2:${new URL(F).port}` }) });
  assert(added.ok, `add other source: ${added.status}`);
  const c = await CDP.launch(19496, { windowSize: '1440,1000' }), errors = await collectPageErrors(c), proof = {};
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const selection = `(async()=>Object.keys(${KZ}.state.selected).sort())()`;
  const expected = names.map(name => `fake:${name}`).sort();
  const check = async () => {
    await c.poll(`(async()=>document.querySelector('#bulkCount')?.textContent==='3 selected'&&JSON.stringify(Object.keys(${KZ}.state.selected).sort())===${JSON.stringify(JSON.stringify(expected))})()`, 30000);
    for (const name of names) {
      await invoke('feed.revealEntry', { id: `fake:${name}` });
      await c.poll(`document.querySelector(${JSON.stringify(`.card[data-name="${name}"] .selcb`)})?.checked===true`);
    }
  };
  try {
    await c.goto(B + '/?filter=selection-#fake#selection-one.png');
    await c.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='selection-three.png'))()`, 30000);
    await invoke('selection.clear'); await invoke('source.attributes', { id: 'fake', patch: { autoRefresh: true } });
    for (const name of names) {
      await invoke('feed.revealEntry', { id: `fake:${name}` });
      const selector = `.card[data-name="${name}"] .selcb`;
      await c.poll(`!!document.querySelector(${JSON.stringify(selector)})`);
      await c.clickAt(selector);
    }
    await check(); proof.ticked = await c.evaluate(selection);
    await c.send('Page.reload'); await c.poll(`document.readyState==='complete'`); await check();
    proof.reloaded = await c.evaluate(selection);
    await invoke('source.select', { id: 'selection-other' });
    await c.poll(`(async()=>${KZ}.state.host()==='selection-other'&&!${KZ}.state.inventory.loading)()`);
    assert.deepEqual(await c.evaluate(selection), []);
    await invoke('source.select', { id: 'fake' }); await check(); proof.switched = await c.evaluate(selection);
    await invoke('variations.open', { target: 'selected' });
    await addParameter(c, '470.image'); await removeRecordedImage(c, '470.image');
    await c.clickAt('[data-image-id="470.image"] .vz-current-image');
    await settledCount(c, '3');
    const before = (await (await fetch(F + '/__test/enqueues')).json()).length;
    proof.run = await invoke('variations.run'); assert.equal(proof.run.submitted, 3, JSON.stringify(proof.run));
    const ids = Array.from({ length: 3 }, (_, index) => `captured-${before + index + 1}`);
    await post(F, '/__test/activity', { running: ids });
    await c.poll(`(async()=>${KZ}.state.sourceActivity.fake?.state==='running')()`, 30000);
    const arrivals = ids.map((id, index) => ({ id, output: `selection-arrival-${index}.png`, fixture: 'flux-basic.png', graph }));
    await post(F, '/__test/activity', { finish: arrivals });
    await c.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='selection-arrival-2.png'))()`, 60000);
    await c.poll(`!document.querySelector('.vz-panel')`, 20000); await check(); proof.afterRun = await c.evaluate(selection);
    await c.clickAt('#bulkBar [title="Clear selection"]');
    await c.poll(`!document.querySelector('#bulkBar')`);
    await c.send('Page.reload');
    await c.poll(`(async()=>${KZ}.state.images.length>0&&!${KZ}.state.inventory.loading)()`, 30000);
    assert.deepEqual(await c.evaluate(selection), []); assert.equal(await c.evaluate(`!!document.querySelector('.selcb:checked')`), false);
    assert.deepEqual(errors, []);
    if (D) { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(D + '/card-selection.json', JSON.stringify({ ...proof, pageErrors: errors }, null, 2)); }
    console.log('card-selection: ok');
  } finally { await c.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
