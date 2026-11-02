const assert = require('node:assert/strict');

// The range and row-shell regressions share one four-kind public fixture.
module.exports = async ({ cdp, FAKE, KZ, name }, run) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const post = async body => {
    const r = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(r.ok, `fixture: ${r.status}`);
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await post({ captureEnqueue: true, publish: [{ name, fixture: 'flux-basic.png', graph: {
    '470': { class_type: 'LoadImage', inputs: { image: 'canny.png' } },
    '9': { class_type: 'BasicScheduler', inputs: { denoise: 1, steps: 20, scheduler: 'simple' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'original prompt' } },
    '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'polish', images: ['470', 0] } },
  } }] });
  await cdp.evaluate(`fetch('/api/collections/fake/entries/${name}/bytes').then(r=>r.arrayBuffer()).then(()=>true)`);
  const open = async () => {
    await invoke('variations.open', { id: 'fake:' + name });
    await cdp.poll("!!document.querySelector('[data-image-id=\"470.image\"]')&&!!document.querySelector('[data-text-id=\"2.text\"]')");
  };
  const type = async (selector, text) => {
    await cdp.clickAt(selector);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text });
  };
  await open();
  try { await run({ invoke, type, open }); }
  finally {
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
    await post({ captureEnqueue: false });
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
};
