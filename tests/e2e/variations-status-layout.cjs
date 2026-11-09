// Async comparison settlement must not move an acquisition click target.
const assert = require('node:assert/strict');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, KZ, check }) => {
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
  await cdp.poll("!!document.querySelector('[data-catalogue-id=\"43.image\"]')");await freshRecipe(cdp);
  await addParameter(cdp,'43.image');
  await cdp.poll("!!document.querySelector('.vz-imgfilespick')");
  await cdp.evaluate(`(()=>{const original=window.fetch;window.__statusRelease=null;window.__statusRestore=()=>window.fetch=original;window.fetch=(url,options)=>{const task=original(url,options);return String(url).includes('/features/variations/inspect-image/')&&options?.body?.get?.('image')?.name==='stable-status.png'?task.then(response=>new Promise(resolve=>window.__statusRelease=()=>resolve(response))):task}})()`);
  try {
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File([bytes],'stable-status.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("typeof window.__statusRelease==='function'&&!!document.querySelector('.vz-image-check')");
    await require('./image-picker-helpers.cjs').openImageFolder(cdp);
    await cdp.clickAt('.vz-folder-path');await cdp.send('Input.insertText',{text:'/images'});
    await cdp.poll("!!document.querySelector('.vz-folder-add')");
    const before=await cdp.evaluate("document.querySelector('.vz-folder-add').getBoundingClientRect().toJSON()");
    await cdp.evaluate('window.__statusRelease()');await cdp.poll("!document.querySelector('.vz-image-check')");
    assert.equal(await cdp.evaluate("!!document.querySelector('.vz-image-error')"),false);
    const after=await cdp.evaluate("document.querySelector('.vz-folder-add').getBoundingClientRect().toJSON()");
    assert(Math.abs(before.top-after.top)<.5&&Math.abs(before.bottom-after.bottom)<.5,JSON.stringify({before,after}));
    check('image comparison: pending-to-ready settlement preserves acquisition click-target geometry',true);
  } finally {
    await cdp.evaluate('window.__statusRelease?.();window.__statusRestore()');
    await cdp.evaluate(`(async()=>{window.__statusLeave=${KZ}.handles.invoke('variations.close');return true})()`);
    if(await cdp.evaluate("!!document.querySelector('.vz-discard')"))await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  }
};
