const assert = require('node:assert/strict');
const { addParameter } = require('./variation-add-helpers.cjs');

// Readonly comparison settlement must not retire a real user's held gesture.
module.exports = async ({ cdp, FAKE, KZ, check }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const name = 'drag-settlement_00001_.png', graph = {
    '470': { class_type: 'LoadImage', inputs: { image: 'canny.png' } },
    '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'drag-settlement', images: ['470', 0] } },
  };
  assert((await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publish: [{ name, fixture: 'flux-basic.png', graph }] }) })).ok);
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/'+${JSON.stringify(name)}+'/bytes')})()`);
  await invoke('variations.open', { id: 'fake:' + name });
   await addParameter(cdp,'470.image');
   await require('./variation-add-helpers.cjs').removeRecordedImage(cdp,'470.image');
  await cdp.evaluate(`(()=>{const original=window.fetch;window.__gestureRelease=[];window.__gestureRestore=()=>window.fetch=original;
    window.fetch=async(url,options)=>{const response=await original(url,options);return String(url).includes('/features/variations/inspect-image/')&&options?.body?.get?.('image')?.name.startsWith('drag-settlement-')?new Promise(resolve=>window.__gestureRelease.push(()=>resolve(response))):response}})()`);
  try {
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();for(const name of ['drag-settlement-a.png','drag-settlement-b.png'])data.items.add(new File([bytes],name,{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("window.__gestureRelease.length===2&&document.querySelectorAll('.vz-image-check').length===2");
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const box = index => cdp.evaluate(`(()=>{const tile=document.querySelectorAll('.vz-image-tile')[${index}],r=tile.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const from = await box(1), to = await box(0);
    await cdp.mouse('mousePressed', from.x, from.y, { buttons: 1 });
    await cdp.mouse('mouseMoved', to.x, to.y, { buttons: 1 });
    await cdp.poll("!!document.querySelector('.vz-image-dragging')");
    await cdp.evaluate('window.__gestureRelease[0]()');
    await cdp.poll("document.querySelectorAll('.vz-image-check').length===1");
    assert(await cdp.evaluate("!!document.querySelector('.vz-image-dragging')"), 'readonly image comparison cancelled the held drag');
    await cdp.evaluate('window.__gestureRelease[1]()');
    await cdp.poll("!document.querySelector('.vz-image-check')");
    assert(await cdp.evaluate("!!document.querySelector('.vz-image-dragging')"));
    await cdp.mouse('mouseReleased', to.x, to.y, { buttons: 0 });
    await cdp.poll("!document.querySelector('.vz-image-dragging')&&document.querySelector('.vz-image-tile')?.dataset.imageName==='drag-settlement-b.png'");
    assert(await cdp.evaluate("[...document.querySelectorAll('.vz-image-tile')].every(tile=>tile.getAnimations().length===0)"));
    check('image order: both readonly comparisons settle during a held reduced-motion drag without cancelling it; release commits exact order', true);
    const changedFrom = await box(0), changedTo = await box(1);
    await cdp.mouse('mousePressed', changedFrom.x, changedFrom.y, { buttons: 1 });
    await cdp.mouse('mouseMoved', changedTo.x, changedTo.y, { buttons: 1 });
    await cdp.poll("!!document.querySelector('.vz-image-dragging')");
    // As in the ordinary grid keyboard tests, explicitly target the native
    // tile before Delete; preview reordering can move its focused DOM node.
    await cdp.evaluate("document.querySelector('.vz-image-dragging').focus({preventScroll:true})");
    await cdp.keyTrusted('Delete', { vk: 46 });
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1&&!document.querySelector('.vz-image-dragging')");
    await cdp.mouse('mouseReleased', changedTo.x, changedTo.y, { buttons: 0 });
    check('image order: an actual membership edit still retires a held gesture before physical release', true);
  } finally {
    await cdp.evaluate('window.__gestureRelease.forEach(release=>release());window.__gestureRestore()');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
  }
};
