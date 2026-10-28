const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const { pickInput } = require('./image-picker-helpers.cjs');

module.exports = async ({ cdp, FAKE, KZ, check }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const image = fs.readFileSync(workPath('tests/fixtures/flux-lora.png'));
  const capture = async name => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    fs.writeFileSync(workPath('artifacts', name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  for (let base = 0; base < 553; base += 4) await Promise.all(Array.from({ length: Math.min(4, 553 - base) }, async (_, offset) => {
    const form = new FormData(); form.append('image', new Blob([image]), `picker-${String(base + offset).padStart(4, '0')}.png`);
    assert((await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form })).ok);
  }));
  await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
  try {
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll("!!document.querySelector('.vz-image-set')");
    assert.equal(await cdp.evaluate("document.querySelector('.vz-image-empty').textContent"), 'No images added yet.');
    assert(await cdp.evaluate("!!document.querySelector('.vz-input-trigger')&&!!document.querySelector('.vz-imgfilespick')&&!document.querySelector('[webkitdirectory]')"));
    await capture('image-set-empty');
    await cdp.clickAt('.vz-image-set .vz-cb');
    await cdp.clickAt('[data-param-key="9.denoise"] .vz-cb');
    await cdp.clickAt('.vz-input-trigger');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length>0");
    assert(await cdp.evaluate("document.querySelectorAll('.vz-input-option').length<=6"));
    assert(await cdp.evaluate("performance.getEntriesByType('resource').filter(r=>r.name.includes('picker-')&&r.name.includes('/bytes')).length<=6"));
    await cdp.send('Input.insertText', { text: 'PICKER-055' });
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===3");
    await cdp.evaluate("(()=>{window.__pickerSearch=document.querySelector('.vz-input-search');window.__pickerSearch.setSelectionRange(1,4);window.__pickerSearch.dispatchEvent(new Event('select'))})()");
    for (const cancel of ['button', 'escape']) {
      await cdp.evaluate(`(async()=>{window.__pickerLeave=${KZ}.handles.invoke('variations.close');return true})()`);
      await cdp.poll("!!document.querySelector('.vz-discard')");
      assert.equal(await cdp.evaluate("!!document.querySelector('.vz-input-popover:popover-open')"), false);
      assert(await cdp.evaluate("document.querySelector('.vz-input-search')===window.__pickerSearch&&window.__pickerSearch.value==='PICKER-055'"));
      if (cancel === 'button') await cdp.clickAt('.vz-keep'); else await cdp.keyTrusted('Escape', { vk: 27 });
      await cdp.poll("!document.querySelector('.vz-discard')&&!!document.querySelector('.vz-input-popover:popover-open')");
      assert(await cdp.evaluate("document.querySelector('.vz-input-search')===window.__pickerSearch&&document.activeElement===window.__pickerSearch&&window.__pickerSearch.selectionStart===1&&window.__pickerSearch.selectionEnd===4"));
    }
    await cdp.evaluate("window.__pickerSearch.setSelectionRange(window.__pickerSearch.value.length,window.__pickerSearch.value.length)");
    await capture('image-set-search');
    const alignment = await cdp.evaluate(`(()=>{const button=document.querySelector('.vz-input-trigger').getBoundingClientRect(),popup=document.querySelector('.vz-input-popover').getBoundingClientRect(),row=document.querySelector('.vz-input-option'),img=row.querySelector('img').getBoundingClientRect(),name=row.querySelector('.vz-input-name').getBoundingClientRect();return {anchor:Math.abs(button.left-popup.left),center:Math.abs((img.top+img.bottom-name.top-name.bottom)/2),visible:popup.left>=0&&popup.right<=innerWidth&&popup.top>=0&&popup.bottom<=innerHeight}})()`);
    assert(alignment.anchor < 1 && alignment.center < 1 && alignment.visible, JSON.stringify(alignment));
    await cdp.keyTrusted('Enter', { vk: 13 });
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
    assert(await cdp.evaluate("!!document.querySelector('.vz-input-search')"));
    await cdp.keyTrusted('ArrowDown', { vk: 40 }); await cdp.keyTrusted('Enter', { vk: 13 });
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===2");
    assert.equal(await cdp.evaluate("document.getElementById(document.querySelector('.vz-input-search').getAttribute('aria-activedescendant')).dataset.inputName"), 'picker-0551.png');
    await cdp.keyTrusted('Enter', { vk: 13 });
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
    await cdp.keyTrusted('Escape', { vk: 27 });
    await cdp.poll("!document.querySelector('.vz-input-search')&&!!document.querySelector('.vz-panel')");
    await pickInput(cdp, 'canny.png');
    await cdp.evaluate(`(async()=>{const current=await(await fetch('/api/collections/fake/entries/canny.png/bytes?kind=input')).arrayBuffer();const other=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();window.__pickerAlternate=new File([other],'picked-upload.png',{type:'image/png'});const input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File([current],'same-current.png',{type:'image/png'}));data.items.add(window.__pickerAlternate);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===4&&!document.querySelector('.vz-image-check')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.vz-image-tile .vz-image-same').length"), 2);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-count').textContent"), '2');
    await cdp.clickAt('.vz-image-tile[data-image-name="picked-upload.png"] .chrome-icon');
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===3&&document.querySelector('.vz-count').textContent==='1'");
    await cdp.evaluate("(()=>{const input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(window.__pickerAlternate);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()");
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===4&&!document.querySelector('.vz-image-check')");
    await capture('image-set-inputs-and-files');
    const before = (await (await fetch(FAKE + '/__test/enqueues')).json()).length;
    const result = await invoke('variations.run'); assert.equal(result.status, 'submitted'); assert.equal(result.submitted, 2); assert.equal(result.adopted, true);
    const jobs = (await (await fetch(FAKE + '/__test/enqueues')).json()).slice(before);
    assert.deepEqual([...new Set(jobs.map(job => job.prompt['43'].inputs.image))], ['picker-0550.png', 'picked-upload.png']);
    await cdp.poll("!document.querySelector('.vz-panel')", 6000);
    check('image set: 553 inputs stay virtual/lazy, anchored search and keyboard multi-selection mix with repeated File additions, removal, exact count and acknowledged auto-close', true);

    // A second run exercises the actual engine filesystem, not a mocked list.
    const folder = workPath('artifacts', 'engine-folder');
    fs.mkdirSync(folder + '/nested', { recursive: true });
    fs.writeFileSync(folder + '/nested/turn-folder.png', image);
    fs.writeFileSync(folder + '/ignore.mp4', 'not an image');
    fs.writeFileSync(folder + '/same-current.png', Buffer.from(await cdp.evaluate("(async()=>Array.from(new Uint8Array(await(await fetch('/api/collections/fake/entries/canny.png/bytes?kind=input')).arrayBuffer())))()")));
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll("!!document.querySelector('.vz-folder-path')");
    await cdp.clickAt('.vz-image-set .vz-cb');
    await cdp.clickAt('[data-param-key="9.denoise"] .vz-cb');
    await pickInput(cdp, 'picker-0550.png');
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();const input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File([bytes],'turn-browser.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    const addFolder = async value => {
      await cdp.evaluate(`(()=>{const input=document.querySelector('.vz-folder-path');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await cdp.clickAt('.vz-folder-add');
      await cdp.poll("document.querySelector('.vz-folder-add').textContent==='Add'");
    };
    await addFolder(folder);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===4&&!document.querySelector('.vz-image-check')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.vz-image-same').length"), 1);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-count').textContent"), '3');
    await addFolder(folder); // same paths do not duplicate the set
    assert.equal(await cdp.evaluate("document.querySelectorAll('.vz-image-tile').length"), 4);
    await addFolder('relative');
    await cdp.poll("document.querySelector('.vz-folder [role=status]')?.textContent.includes('absolute')");
    assert.equal(await cdp.evaluate("document.querySelectorAll('.vz-image-tile').length"), 4);
    await addFolder(folder);
    await cdp.clickAt('.vz-image-tile[data-image-name="turn-folder.png"] .chrome-icon');
    await cdp.poll("document.querySelector('.vz-count').textContent==='2'");
    await addFolder(folder);
    await cdp.poll("document.querySelector('.vz-count').textContent==='3'&&!document.querySelector('.vz-image-check')");
    await cdp.poll("[...document.querySelectorAll('.vz-image-tile img')].every(img=>img.complete&&img.naturalWidth>0)");
    const folderGeometry = await cdp.evaluate(`(()=>{const input=document.querySelector('.vz-folder-path').getBoundingClientRect(),add=document.querySelector('.vz-folder-add').getBoundingClientRect(),footer=document.querySelector('.vz-image-add').getBoundingClientRect(),grid=document.querySelector('.vz-image-grid').getBoundingClientRect();return {center:Math.abs((input.top+input.bottom-add.top-add.bottom)/2),order:input.right<=add.left&&grid.bottom<footer.top,contained:input.left>=footer.left&&add.right<=footer.right}})()`);
    assert(folderGeometry.center < 1 && folderGeometry.order && folderGeometry.contained, JSON.stringify(folderGeometry));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    try {
      await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
      await capture('image-set-inputs-files-folder');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 820, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate("document.querySelector('.vz-body').scrollTop=0");
      const narrow = await cdp.evaluate(`(()=>{const element=document.querySelector('.vz-folder-path'),input=element.getBoundingClientRect(),add=document.querySelector('.vz-folder-add').getBoundingClientRect(),footer=document.querySelector('.vz-image-add').getBoundingClientRect(),list=document.querySelector('.vz-sliders').getBoundingClientRect(),right=document.querySelector('.vz-right').getBoundingClientRect();return{center:Math.abs((input.top+input.bottom-add.top-add.bottom)/2),contained:input.left>=footer.left&&add.right<=footer.right&&footer.right<=innerWidth,visible:input.top>=0&&add.bottom<=innerHeight,hit:document.elementFromPoint(input.left+input.width/2,input.top+input.height/2)===element,ordered:right.top>=list.bottom-1}})()`);
      assert(narrow.center < 1 && narrow.contained && narrow.visible && narrow.hit && narrow.ordered, JSON.stringify(narrow));
    } finally { await cdp.send('Emulation.clearDeviceMetricsOverride'); }
    const beforeFolder = (await (await fetch(FAKE + '/__test/enqueues')).json()).length;
    const folderRun = await invoke('variations.run'); assert.equal(folderRun.submitted, 3); assert.equal(folderRun.adopted, true);
    const folderJobs = (await (await fetch(FAKE + '/__test/enqueues')).json()).slice(beforeFolder);
    assert.deepEqual([...new Set(folderJobs.map(job => job.prompt['43'].inputs.image))], ['picker-0550.png', 'turn-browser.png', 'turn-folder.png']);
    await cdp.poll("!document.querySelector('.vz-panel')", 6000);
    check('image set: recursive engine folder mixes with inputs and Files across turns; path dedupe, same-current bytes, errors, removal, real thumbnails, geometry, exact submissions and acknowledged auto-close', true);
  } finally {
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    }
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: false }) });
  }
};
