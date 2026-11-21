const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, PEXELS = process.env.E2E_PEXELS, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
(async () => {
  assert(ENGINE && FAKE && PEXELS && E);
  const page = await CDP.launch(9475, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), proof = {};
  const evaluate = expression => page.evaluate(`(async()=>(${expression}))()`);
  const box = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const layout = () => evaluate(`(()=>{const bar=document.querySelector('.vz-image-add'),list=document.querySelector('.vz-image-picked'),tile=list.querySelector('.vz-image-tile');return {bar:bar.getBoundingClientRect().toJSON(),list:list.getBoundingClientRect().toJSON(),tile:tile.getBoundingClientRect().toJSON(),scroll:list.scrollTop,max:list.scrollHeight-list.clientHeight,outer:document.querySelector('.vz-sliders').scrollTop,toolbarFirst:!!(bar.compareDocumentPosition(list)&Node.DOCUMENT_POSITION_FOLLOWING)}})()`);
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: 'original.png' } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'toolbar' } } };
    assert((await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true, publishInputs: [{ name: 'original.png', fixture: 'flux-basic.png' }], publish: [{ name: 'toolbar-target.png', fixture: 'flux-lora.png', graph }] }) })).ok);
    assert((await fetch(ENGINE + '/api/features/variations/pexels/services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test photos', url: PEXELS, key: 'test-key' }) })).ok);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake'); await page.poll(`(async()=>${KZ}.state.images.length>0)()`, 20000);
    await evaluate(`fetch('/api/collections/fake/entries/toolbar-target.png/bytes')`);
    await evaluate(`${KZ}.handles.invoke('variations.open',{id:'fake:toolbar-target.png'})`);
    await addParameter(page, '11.image'); await removeRecordedImage(page, '11.image');
    assert(await evaluate(`!!document.querySelector('.vz-image-empty')&&document.querySelector('.vz-image-add').getBoundingClientRect().height>0`), 'empty set has an always-visible toolbar');
    await evaluate(`(async()=>{const data=new DataTransfer(),canvas=document.createElement('canvas');canvas.width=96;canvas.height=64;const ctx=canvas.getContext('2d');for(let i=0;i<48;i++){ctx.fillStyle='hsl('+i*17+' 45% 40%)';ctx.fillRect(0,0,96,64);ctx.fillStyle='white';ctx.font='20px sans-serif';ctx.fillText(String(i+1),12,40);data.items.add(new File([await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))],'picked-'+String(i+1).padStart(2,'0')+'.png',{type:'image/png'}));}const input=document.querySelector('.vz-imgfilespick');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await page.poll(`document.querySelectorAll('.vz-image-tile').length===48&&!document.querySelector('.vz-image-check')`, 30000);
    await evaluate(`document.querySelector('.vz-image-content').scrollIntoView({block:'start'})`);
    proof.before = await layout();
    assert(proof.before.toolbarFirst && proof.before.bar.bottom <= proof.before.list.top, JSON.stringify(proof.before));
    assert(proof.before.max > 500, 'long list must scroll');
    const list = proof.before.list;
    await page.mouse('mouseMoved', list.x + list.width / 2, list.y + list.height / 2);
    await page.mouse('mouseWheel', list.x + list.width / 2, list.y + list.height / 2, { deltaY: 650 });
    await page.poll(`document.querySelector('.vz-image-picked').scrollTop>300`);
    proof.after = await layout();
    for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(proof.after.bar[key] - proof.before.bar[key]) < 1, 'toolbar moved: ' + key);
    assert(proof.after.bar.top >= 0 && proof.after.bar.bottom <= 1000, 'toolbar stays in viewport');
    assert.equal(proof.after.outer, proof.before.outer, 'wheel scroll is list-owned');
    assert(proof.after.tile.top < proof.before.tile.top - 300, 'tiles move under the fixed toolbar');
    for (const selector of ['.vz-image-add > .vz-input-picker .vz-input-trigger', '.vz-image-external .vz-input-trigger']) {
      await page.clickAt(selector); await waitForInputPicker(page);
      const trigger = await box(selector), popup = await box('.vz-input-popover');
      assert(Math.min(Math.abs(popup.top-trigger.bottom), Math.abs(trigger.top-popup.bottom)) <= 12, JSON.stringify({trigger,popup}));
      assert(popup.right > trigger.left && popup.left < trigger.right, 'flyout overlaps its trigger horizontally');
      proof[selector] = { trigger, popup };
      await page.keyTrusted('Escape', { vk: 27 });
      await page.poll(`!document.querySelector('.vz-input-popover')`);
    }
    await page.clickAt('.vz-folder-trigger');
    await page.poll(`document.querySelector('.vz-folder-path')?.getBoundingClientRect().height>0`);
    const folder = await box('.vz-image-folder'), toolbar = await box('.vz-image-add');
    assert(folder.top >= toolbar.top && folder.bottom <= toolbar.bottom, 'folder controls remain in the toolbar');
    await page.clickAt('.vz-folder-trigger');
    // Native Tab leaves the final acquisition control for the first picked tile.
    await evaluate(`document.querySelector('.vz-image-external .vz-input-trigger').focus()`);
    await page.keyTrusted('Tab', { vk: 9 });
    await page.poll(`document.activeElement.matches('.vz-image-tile')`);
    await evaluate(`document.querySelector('.vz-image-picked').scrollTop=650`);
    await page.poll(`document.querySelector('.vz-image-picked').scrollTop>600`);
    await page.mouse('mouseMoved', 2, 2);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    fs.writeFileSync(`${E}/image-set-toolbar.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${E}/image-set-toolbar-proof.json`, JSON.stringify({...proof, pageErrors:errors}, null, 2));
    console.log('PASS image-set toolbar: empty and 48 picked images, native wheel scroll, fixed toolbar geometry, DOM/Tab order, ComfyUI/Pexels anchoring, folder controls');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
