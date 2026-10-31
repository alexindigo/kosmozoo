// Dynamic object_info -> native option row -> real engine -> captured fake prompt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ cdp, check, ENGINE, FAKE, KZ }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/dynamic-combos.json')));
  const source = 'dynamic-combos', filename = 'dynamic-combos.png';
  const row = '[data-enum-id="459:500.sampling_mode"]';
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const post = async (url, body) => assert((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).ok);
  const jobs = async () => (await fetch(FAKE + '/__test/enqueues')).json();
  await post(FAKE + '/__test/activity', { objectInfoByHost: { '127.0.0.3': fixture.objectInfo }, captureEnqueue: true,
    publish: [{ name: filename, fixture: 'flux-lora.png', graph: fixture.graph, mtime: 2100000300 }] });
  await post(ENGINE + '/api/collections', { name: source, address: `127.0.0.3:${new URL(FAKE).port}` });
  try {
    await cdp.poll(`(async()=>!!${KZ}.state.hosts['${source}'])()`);
    await cdp.evaluate(`fetch('/api/collections/${source}/entries/${filename}/bytes').then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer()}).then(()=>true)`);
    await invoke('variations.open', { id: `${source}:${filename}` });
    await cdp.poll(`!!document.querySelector('${row}')`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    // Only the combo axis participates; default-enabled numeric rows are off.
    await cdp.evaluate(`(()=>{for(const cb of document.querySelectorAll('.vz-slider-row .vz-parameter-heading .checkbox'))if(cb.checked)cb.click()})()`);
    await cdp.clickAt(row + ' .vz-parameter-heading .checkbox');
    assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('${row} .vz-enum-opt-name')].map(el=>el.textContent)`), ['on', 'off']);
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-parameter-name').textContent`), 'Generate Text.sampling_mode');
    assert.equal(await cdp.evaluate(`!!document.querySelector('[data-text-id="459:500.sampling_mode"]')`), false);
    check('dynamic combo: Generate Text.sampling_mode renders native on/off option checkboxes, never a textarea', true);
    await cdp.clickAt(row + ' .vz-enum-opt:last-child .checkbox');
    await cdp.poll("document.querySelector('.vz-count').textContent.trim()==='1'");
    await cdp.evaluate("document.activeElement.blur();document.querySelector('.vz-sliders').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    if (process.env.E2E_DYNAMIC_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_DYNAMIC_SHOT, Buffer.from(shot.data, 'base64'));
    }
    const before = (await jobs()).length, result = await invoke('variations.run');
    assert.equal(result.status, 'submitted'); assert.equal(result.adopted, true);
    const submitted = (await jobs()).slice(before);
    assert.equal(submitted.length, 1);
    assert.deepEqual(submitted[0].prompt['459:500'].inputs, { sampling_mode: 'off' });
    check('dynamic combo: selected off option enqueues exactly one prompt with all obsolete sampling children removed and acknowledged', true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
    assert((await fetch(ENGINE + '/api/collections/' + source, { method: 'DELETE' })).ok);
    await post(FAKE + '/__test/activity', { objectInfoByHost: {}, captureEnqueue: false, remove: [filename] });
  }
};
