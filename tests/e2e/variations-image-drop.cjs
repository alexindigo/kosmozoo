const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { openImageAdd, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, check, FAKE, KZ }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const names = () => cdp.evaluate("[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName)");
  const box = selector => cdp.evaluate(`(async()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const resources = ['flux-basic.png', 'flux-lora.png', 'flux-ipadapter.png'].map((name, i) => {
    const path = workPath('artifacts', `drop-${i + 1}.png`);
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    fs.copyFileSync(workPath('tests/fixtures', name), path); return path;
  });
  const text = workPath('artifacts', 'skip.txt'); fs.writeFileSync(text, 'not an image');
  const text2 = workPath('artifacts', 'skip2.txt'); fs.writeFileSync(text2, 'not an image either');
  const mixed = workPath('artifacts', 'mixed.png'), append = workPath('artifacts', 'append.png');
  fs.copyFileSync(resources[1], mixed); fs.copyFileSync(resources[2], append);
  const folder = workPath('artifacts', 'folder.png'); fs.mkdirSync(folder, { recursive: true });
  const drag = async (type, point, files) => cdp.send('Input.dispatchDragEvent', {
    type, ...point, data: { items: [], files, dragOperationsMask: 1 },
  });
  const drop = async (point, files) => {
    await drag('dragEnter', point, files); await drag('dragOver', point, files); await drag('drop', point, files);
  };
  await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll("!!document.querySelector('[data-catalogue-id=\"43.image\"]')"); await freshRecipe(cdp);
    await addParameter(cdp,'43.image');await removeRecordedImage(cdp,'43.image');await cdp.clickAt('[data-image-id="43.image"] .vz-parameter-remove');
    const closed = await box('[data-catalogue-id="43.image"]');
    await drag('dragEnter', closed, [resources[0]]); await drag('dragOver', closed, [resources[0]]);
    await cdp.poll("!!document.querySelector('.vz-catalogue-row.vz-image-dropping')");
    await drag('drop', closed, [resources[0]]);
    await cdp.poll("!!document.querySelector('.vz-image-set.on .vz-image-grid')&&document.querySelectorAll('.vz-image-tile').length===1");
    assert.deepEqual(await names(), ['drop-1.png']);
    check('image drop: trusted desktop file drop enables and opens a closed card', true);
    // Seed the second tile through Add files, then exercise native insertion.
    await openImageAdd(cdp);
    await cdp.evaluate(`(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(fs.readFileSync(workPath('tests/fixtures/flux-pulid.png')).toString('base64'))}),c=>c.charCodeAt(0))],'last.png',{type:'image/png'}));const input=document.querySelector('.vz-imgfilespick');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===2");
    await cdp.clickAt('.vz-image-plus'); await waitForSelectedPreviews(cdp);
    const between = await cdp.evaluate("(()=>{const a=document.querySelectorAll('.vz-image-tile')[0].getBoundingClientRect(),b=document.querySelectorAll('.vz-image-tile')[1].getBoundingClientRect();return{x:(a.right+b.left)/2,y:a.y+a.height/2}})()");
    const original = await names();
    await drag('dragEnter', between, resources); await drag('dragOver', between, resources);
    await cdp.poll("!!document.querySelector('.vz-image-drop-gap')&&!!document.querySelector('.vz-image-dropping')");
    assert.deepEqual(await names(), original, 'hover must not edit recipe');
    const geometry = await cdp.evaluate("(()=>{const gap=document.querySelector('.vz-image-drop-gap').getBoundingClientRect(),tile=document.querySelector('.vz-image-tile').getBoundingClientRect(),card=document.querySelector('.vz-image-set'),token=document.createElement('span');token.style.color='var(--secondary)';document.body.append(token);const result={gap:[gap.width,gap.height],tile:[tile.width,tile.height],border:getComputedStyle(card).borderColor,blue:getComputedStyle(token).color};token.remove();return result})()");
    assert.deepEqual(geometry.gap, geometry.tile); assert.equal(geometry.border, geometry.blue);
    await cdp.poll("[...document.querySelectorAll('.vz-image-tile')].every(el=>el.getAnimations().every(a=>a.playState==='finished'))");
    if (process.env.E2E_DROP_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_DROP_SHOT, Buffer.from(shot.data, 'base64'));
    }
    // Leaving restores layout and keeps recipe identity/order.
    await drag('dragOver', await box('.vz-title'), resources);
    await cdp.poll("!document.querySelector('.vz-image-drop-gap')&&!document.querySelector('.vz-image-dropping')");
    assert.deepEqual(await names(), original);
    await drag('dragOver', between, resources); await drag('drop', between, resources);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===5&&!document.querySelector('.vz-image-check')");
    const inserted = ['drop-1.png', 'drop-1.png', 'drop-2.png', 'drop-3.png', 'last.png'];
    assert.deepEqual(await names(), inserted);
    check('image drop: three PNGs insert between tiles; blue card and tile-sized gap are transient', true);
    await drop(await box('.vz-image-plus'), [text, text2, mixed]);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===6&&document.querySelector('.vz-image-drop-status')?.textContent==='2 files skipped — not images'");
    assert.equal((await names()).at(-1), 'mixed.png');
    await drop(await box('.vz-image-plus'), [folder]);
    await cdp.poll("document.querySelector('.vz-image-drop-status')?.textContent==='Folders: use Add folder'");
    assert.equal((await names()).length, 6);
    check('image drop: plus appends; mixed nonimages and folders report one line without expanding', true);
    await drop(await box('.vz-image-plus'), [append]);
    await waitForSelectedPreviews(cdp);
    const snapshot = () => cdp.evaluate("({url:location.href,names:[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName),suffix:document.querySelector('.vz-suffix').value,count:document.querySelector('.vz-count').textContent})");
    const before = await snapshot();
    await drop(await box('.vz-title'), [resources[0]]);
    await drop({ x: 2, y: 2 }, [resources[0]]);
    assert.deepEqual(await snapshot(), before);
    check('image drop: files outside the target in the dialog and on the page retain URL and recipe', true);
    const count = (await (await fetch(FAKE + '/__test/enqueues')).json()).length;
    const result = await invoke('variations.run');
    assert.equal(result.status, 'submitted', JSON.stringify({ result, message: await cdp.evaluate("document.querySelector('.vz-messages').innerText") })); assert.equal(result.adopted, true);
    const submitted = (await (await fetch(FAKE + '/__test/enqueues')).json()).slice(count).map(job => job.prompt['43'].inputs.image);
    assert.deepEqual(submitted, ['drop-2.png', 'drop-3.png', 'last.png', 'mixed.png', 'append.png']);
    check('image drop: Run consumes inserted order through the existing byte-deduplication/upload lane', true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    }
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: false }) });
  }
};
