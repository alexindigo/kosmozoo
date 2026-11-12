const assert = require('node:assert/strict');
const fs = require('node:fs');

// Real rejected-but-sealed capture, menu transport and retained archive bytes.
// Only the accepted close clock is held so lease/DOM observations are deterministic.
module.exports = async ({ page, evaluate, invoke, list, write, close, open, waitRun, choose, originalId, shot, E }) => {
  await close(); await open('flux-controlnet.png');
  const { addParameter } = require('./variation-add-helpers.cjs');
  await addParameter(page, '9.denoise');
  await page.clickAt('[data-param-key="9.denoise"] .mode-switch button[title="Value"]');
  await write('[data-param-key="9.denoise"] .vz-value-field input', '1e');
  await page.clickAt('.vz-run');
  await page.poll('document.querySelector(".vz-error")?.textContent.includes("number")');
  const invalid = (await list()).items.find(row => row.outcome === 'rejected');
  assert(invalid, 'invalid raw capture remains a selectable, sealed record');
  await close();
  await evaluate(`(async()=>{
    const h=(await import('/store/instance.js')).appStore.actions.variations.services.history;
    window.recallProof={opened:[],released:[],timers:[]};
    const open=h.open,release=h.release,set=window.setTimeout,clear=window.clearTimeout;
    h.open=async(...args)=>{const r=await open(...args);window.recallProof.opened.push({id:r.id,leaseId:r.leaseId,resourceId:r.resources[0].id});return r};
    h.release=async r=>{await release(r);window.recallProof.released.push(r.leaseId)};
    window.setTimeout=function(callback,ms,...args){
      if(ms===3000&&new Error().stack.includes('/features/variations/editor.js')){
        const t={callback,cleared:false};t.id=set(callback,60000,...args);window.recallProof.timers.push(t);return t.id;
      }return set(callback,ms,...args);
    };
    window.clearTimeout=function(id){for(const t of window.recallProof.timers)if(t.id===id)t.cleared=true;return clear(id)};
    window.restoreRecallProbe=()=>{h.open=open;h.release=release;window.setTimeout=set;window.clearTimeout=clear;for(const t of window.recallProof.timers)clear(t.id)};
    return true;
  })()`);
  try {
    await invoke('variations.history.open', { id: originalId });
    await page.poll('!!document.querySelector(".vz-panel")');
    await choose(originalId);
    await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
    const caption = await page.evaluate('document.querySelector(".vh-trigger").textContent');
    await waitRun();
    await page.poll('window.recallProof.timers.length===1');
    const accepted = (await list()).items.find(row => row.id !== originalId && row.id !== invalid.id && row.outcome === 'submitted');
    const before = await page.evaluate(`({prefix:document.querySelector('.vz-prefix').value,suffix:document.querySelector('.vz-suffix').value,value:document.querySelector('[data-param-key="9.denoise"] .vz-value-field input').value,opened:window.recallProof.opened.slice(),released:window.recallProof.released.slice()})`);
    await choose(invalid.id);
    await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
    await shot('empty-overlay-warning');
    assert.equal(await page.evaluate('document.querySelector(".vh-warning strong").textContent'), 'No compatible changes were applied.');
    await page.poll('window.recallProof.released.length===1');
    assert.equal(await page.evaluate('document.querySelector(".vh-trigger").textContent'), caption);
    assert.equal(await page.evaluate('!!document.querySelector(".vz-discard")'), false);
    assert.equal(await page.evaluate('window.recallProof.timers[0].cleared'), false, 'empty recall preserves the accepted close clock');
    assert.equal(await page.evaluate('document.querySelector(".vz-queued").textContent'), 'Queued 1 of 1 jobs');
    const after = await page.evaluate(`({prefix:document.querySelector('.vz-prefix').value,suffix:document.querySelector('.vz-suffix').value,value:document.querySelector('[data-param-key="9.denoise"] .vz-value-field input').value,opened:window.recallProof.opened.slice(),released:window.recallProof.released.slice()})`);
    assert.deepEqual([after.prefix, after.suffix, after.value], [before.prefix, before.suffix, before.value]);
    assert.deepEqual(after.released, [after.opened.at(-1).leaseId], 'release only the empty selection lease');
    const bytes = await evaluate(`(async()=>{
      const h=(await import('/store/instance.js')).appStore.actions.variations.services.history;
      return Promise.all(window.recallProof.opened.slice(0,-1).map(async r=>{
        const response=await fetch('/api/features/variations/history/'+r.id+'/resources/'+r.resourceId+'/bytes?lease='+r.leaseId);
        return {retained:!!h.retained(r.id,r.leaseId),status:response.status,bytes:(await response.arrayBuffer()).byteLength};
      }));
    })()`);
    assert(bytes.length >= 2 && bytes.every(r => r.retained && r.status === 200 && r.bytes > 0), 'all previous successful recall resources remain usable');
    await page.evaluate('window.recallProof.timers[0].callback()');
    await page.poll('!document.querySelector(".vz-panel")');
    fs.writeFileSync(E + '/empty-recall-consumer.json', JSON.stringify({invalidId:invalid.id,acceptedId:accepted.id,caption,before,after,bytes,acceptedTimerClosed:true}, null, 2));
    // Keep both immutable captures/journals for independent SQL/wire verification.
  } finally { await page.evaluate('window.restoreRecallProbe()'); }
};
