const assert = require('node:assert/strict');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, KZ, check }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const point = selector => cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const outside = await point('#chrome .logo');
  // The same outside-click owner serves both ordinary header dropdowns.
  for (const [trigger, input, open] of [['#hostBtn', '#hostAddr', "document.querySelector('#hostBtn').getAttribute('aria-expanded')==='true'"],
    ['#menuBtn', '#menuSearch', "!!document.querySelector('#menu')"]]) {
    await cdp.clickAt(trigger); await cdp.poll(open);
    const from = await point(input);
    await cdp.mouse('mousePressed', from.x, from.y, { buttons: 1, clickCount: 1 });
    await cdp.mouse('mouseMoved', outside.x, outside.y, { buttons: 1 });
    await cdp.mouse('mouseReleased', outside.x, outside.y, { buttons: 0, clickCount: 1 });
    assert(await cdp.evaluate(open), 'an inside-origin pointer release dismissed ' + trigger);
    await cdp.clickAt('#chrome .logo'); await cdp.poll(`!(${open})`);
  }
  check('outside click: source and options menus retain inside-origin releases and close on a subsequent genuine outside click', true);
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes')})()`);
  await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
  await cdp.poll("!!document.querySelector('[data-catalogue-id=\"43.image\"]')"); await freshRecipe(cdp);
  await addParameter(cdp,'43.image'); await openImageAdd(cdp);
  await cdp.clickAt('.vz-input-trigger'); await waitForInputPicker(cdp);
  try {
    // Last-selection removal restores the empty-state row and moves the anchor.
    // The test click driver must await its settled search geometry.
    for (let turn = 0; turn < 12; turn++) {
      await cdp.keyTrusted('Enter', { vk: 13 });
      await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
      await cdp.keyTrusted('Enter', { vk: 13 });
      await cdp.clickAt('.vz-input-search');
      assert(await cdp.evaluate("document.activeElement.matches('.vz-input-search')"));
    }
    // Force the originally intermittent lifecycle boundary: a real press inside
    // search, placement changes while held, then release at the original point.
    const from = await point('.vz-input-search');
    await cdp.mouse('mousePressed', from.x, from.y, { buttons: 1, clickCount: 1 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await cdp.poll(`(()=>{const r=document.querySelector('.vz-input-search')?.getBoundingClientRect();return r&&(Math.abs(r.x+r.width/2-${from.x})>30||Math.abs(r.y+r.height/2-${from.y})>30)})()`);
    await cdp.mouse('mouseReleased', Math.min(from.x, 799), Math.min(from.y, 599), { buttons: 0, clickCount: 1 });
    assert(await cdp.evaluate("!!document.querySelector('.vz-input-search')&&document.activeElement.matches('.vz-input-search')"));
    await cdp.send('Input.insertText', { text: 'canny' });
    await cdp.poll("document.querySelector('.vz-input-search')?.value==='canny'");
    await cdp.clickAt('.vz-count'); await cdp.poll("!document.querySelector('.vz-input-search')");
    assert(await cdp.evaluate("!!document.querySelector('.vz-panel')"));
    check('input picker: a placement change between search press/release preserves the search and focus; a later outside click still closes it', true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  }
};
