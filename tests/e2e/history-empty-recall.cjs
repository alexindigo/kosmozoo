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
    // Reuse these immutable captures: concurrency must not create another Run.
    await invoke('variations.history.open', { id: originalId });
    await page.poll('!!document.querySelector(".vz-panel")');
    await evaluate(`(async()=>{
      const h=(await import('/store/instance.js')).appStore.actions.variations.services.history,open=h.open,release=h.release;
      window.busyProof={calls:[]};
      h.open=(id)=>{window.busyProof.calls.push(id);return open(id)};
      h.release=async r=>{await release(r);if(window.busyProof.holdRelease)await new Promise(resolve=>{window.busyProof.finishRelease=resolve})};
      window.restoreBusyProbe=()=>{window.busyProof.finishRelease?.();h.open=open;h.release=release};
      return true;
    })()`);
    const busy = 'Another recall is in progress. This selection was not applied.';
    const snapshot = () => page.evaluate(`({caption:document.querySelector('.vh-trigger').textContent,fields:[...document.querySelectorAll('.vz-panel input,.vz-panel textarea')].map(e=>[e.getAttribute('aria-label'),e.value,e.checked]),message:document.querySelector('.vz-messages').textContent,timers:window.recallProof.timers.map(t=>t.cleared),opened:window.recallProof.opened.length,released:window.recallProof.released.length})`);
    const outcomes = [];
    let paused = null, opens = [];
    const intercept = event => { const msg=JSON.parse(event.data); if(msg.method==='Fetch.requestPaused'){ paused=msg.params.requestId; opens.push(msg.params.request.url); } };
    page.ws.addEventListener('message', intercept);
    await page.send('Fetch.enable', {patterns:[{urlPattern:'*/api/features/variations/history/*/open',requestStage:'Request'}]});
    try {
      for (const outcome of ['applied', 'error', 'unchanged', 'stale', 'cancelled']) {
        const a = outcome === 'unchanged' ? invalid.id : originalId, b = a === originalId ? invalid.id : originalId;
        paused = null;
        const callStart = await page.evaluate('window.busyProof.calls.length'), openStart = opens.length;
        await choose(a);
        for(let i=0;i<100&&!paused;i++) await new Promise(resolve=>setTimeout(resolve,20));
        assert(paused, 'admitted recall reached the real open transport');
        await choose(a);
        assert.equal(await page.evaluate('window.busyProof.calls.length'),callStart+1,'same ID shares admission and one acquisition');
        const untouched = await snapshot();
        await shot('busy-before-' + outcome);
        await choose(b);
        await page.poll(`document.querySelector('.vh-menu:popover-open .vh-status')?.textContent===${JSON.stringify(busy)}`);
        assert.deepEqual(await snapshot(),untouched,'busy selection changes no recipe, caption, result, timer or lease');
        assert.equal(await page.evaluate('window.busyProof.calls.length'),callStart+1,'busy B never acquires');
        assert.equal(opens.length,openStart+1);
        const geometry = await page.evaluate(`(()=>{const menu=document.querySelector('.vh-menu:popover-open'),status=menu.querySelector('.vh-status'),label=menu.querySelector('.vh-menu-label'),m=menu.getBoundingClientRect(),s=status.getBoundingClientRect(),l=label.getBoundingClientRect();return {menu:m.toJSON(),status:s.toJSON(),label:l.toJSON(),visible:status.checkVisibility(),top:status.contains(document.elementFromPoint(s.left+s.width/2,s.top+s.height/2)),disabled:menu.querySelectorAll('[disabled]').length}})()`);
        assert(geometry.visible&&geometry.top&&geometry.status.top>=geometry.label.bottom&&geometry.status.bottom<=geometry.menu.bottom,'notice is visible inside the native popup flow');
        assert.equal(geometry.disabled,0);
        await shot('busy-' + outcome);
        if(outcome==='stale') await page.evaluate(`(()=>{window.busyProof.holdRelease=true;const e=document.querySelector('.vz-prefix');e.value='newer_';e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        if(outcome==='cancelled') {
          await page.evaluate('window.busyProof.holdRelease=false;window.busyProof.finishRelease();window.busyProof.finishRelease=null');
          await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          assert.equal(await page.evaluate('document.querySelector(".vh-menu .vh-status")?.textContent'),busy,'old finally cannot erase a newer admission notice');
        }
        if(outcome==='error') await page.send('Fetch.fulfillRequest',{requestId:paused,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"Fixture recall unavailable"}').toString('base64')});
        else await page.send('Fetch.continueRequest',{requestId:paused});
        if(outcome==='cancelled') { await page.poll('!!document.querySelector(".vz-discard")');await page.clickAt('.vz-keep'); }
        await page.poll(`!document.querySelector('.vh-menu .vh-status')?.textContent.includes('Another recall')`);
        if(outcome==='applied') {
          await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
          assert.equal(await page.evaluate('document.querySelector(\'[data-param-key="9.denoise"] .vz-value-field input\').value'),'0.9');
          assert.equal(await page.evaluate('window.recallProof.opened.length'),untouched.opened+1);
          assert.equal(await page.evaluate('window.recallProof.released.length'),untouched.released,'only A acquires and retains its applied lease');
        }
        if(outcome==='error') await page.poll('document.querySelector(".vh-menu .vh-error")?.textContent.includes("Fixture recall unavailable")');
        if(['unchanged','stale','cancelled'].includes(outcome)) await page.poll(`window.recallProof.released.length===${untouched.released+1}`);
        outcomes.push({outcome,geometry,after:await snapshot()});
      }
      // A's lease cleanup is history-owned: a held release cannot delay A's
      // terminal result, nor let A's late completion close B's newer popup.
      await page.evaluate('window.busyProof.holdRelease=true;window.busyProof.finishRelease=null');
      paused=null;await choose(invalid.id);
      for(let i=0;i<100&&!paused;i++) await new Promise(resolve=>setTimeout(resolve,20));
      assert(paused);await page.send('Fetch.continueRequest',{requestId:paused});paused=null;
      await page.poll('!!window.busyProof.finishRelease');
      await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
      await page.evaluate('window.busyProof.holdRelease=false');
      await choose(invalid.id);
      for(let i=0;i<100&&!paused;i++) await new Promise(resolve=>setTimeout(resolve,20));
      assert(paused,'B admitted while A lease release is still held');
      await page.evaluate('window.busyProof.finishRelease();window.busyProof.finishRelease=null');
      await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert.equal(await page.evaluate('document.querySelector(".vh-trigger").getAttribute("aria-expanded")'),'true','late A cleanup cannot close B');
      await page.send('Fetch.continueRequest',{requestId:paused});paused=null;
      await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
      // A fresh explicit B selection is admitted, not a hidden queued action.
      paused=null;await choose(invalid.id);
      for(let i=0;i<100&&!paused;i++) await new Promise(resolve=>setTimeout(resolve,20));
      assert(paused);assert.equal(await page.evaluate('!!document.querySelector(".vh-menu .vh-status")'),false);
      await page.send('Fetch.continueRequest',{requestId:paused});paused=null;
      await page.poll('document.querySelector(".vh-trigger").getAttribute("aria-expanded")==="false"');
      fs.writeFileSync(E+'/busy-recall-consumer.json',JSON.stringify({outcomes,opens,proof:await page.evaluate('window.busyProof'),records:(await list()).items.length},null,2));
      assert.equal((await list()).items.length,4);
      paused=null;await choose(originalId);
      for(let i=0;i<100&&!paused;i++) await new Promise(resolve=>setTimeout(resolve,20));
      assert(paused);await choose(invalid.id);
      const opened=await page.evaluate('window.recallProof.opened.length');
      await close();await page.send('Fetch.continueRequest',{requestId:paused});paused=null;
      await page.poll(`window.recallProof.opened.length===${opened+1}&&window.recallProof.released.includes(window.recallProof.opened.at(-1).leaseId)`);
      assert.equal(await page.evaluate('!!document.querySelector(".vz-panel")'),false,'retired mount cannot publish a late recall');
      fs.writeFileSync(E+'/busy-disposal-consumer.json',JSON.stringify(await page.evaluate('({opened:window.recallProof.opened,released:window.recallProof.released,mounted:!!document.querySelector(".vz-panel")})'),null,2));
    } finally {
      if(paused) await page.send('Fetch.continueRequest',{requestId:paused}).catch(()=>{});
      await page.send('Fetch.disable');page.ws.removeEventListener('message',intercept);
      await page.evaluate('window.restoreBusyProbe()');
    }
    await close();
    // Keep both immutable captures/journals for independent SQL/wire verification.
  } finally { await page.evaluate('window.restoreRecallProbe()'); }
};
