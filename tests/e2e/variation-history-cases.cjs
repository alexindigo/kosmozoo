const assert = require('node:assert/strict');
const fs = require('node:fs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
module.exports = async ({ page, evaluate, invoke, list, write, panel, waitRun, ENGINE, FAKE, E, scenario, original, shot }) => {
  const originalId = original.id;
  const close = async () => {
    await evaluate(`((await import('/store/instance.js')).appStore.handles.invoke('variations.close'),true)`);
    if (await page.evaluate('!!document.querySelector(".vz-discard")')) await page.clickAt('.vz-discard-confirm');
    await page.poll('!document.querySelector(".vz-panel")');
  };
  const open = async name => {
    await evaluate(`fetch('/api/collections/fake/entries/${encodeURIComponent(name)}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + name });
    await page.poll('document.querySelectorAll(".vz-catalogue-row").length>0');
  };
  const choose = async () => {
    // A resumed logical popup waits one placement frame before becoming native
    // top-layer chrome. Do not toggle it closed during that retained lifetime.
    if (!await page.evaluate('document.querySelector(".vh-trigger")?.getAttribute("aria-expanded")==="true"')) await page.clickAt('.vh-trigger');
    await page.poll('document.querySelector(".vh-menu")?.matches(":popover-open")&&!document.querySelector(".vh-menu").inert');
    await page.poll(`!!document.querySelector('.vh-menu [data-history-id="${originalId}"] .vh-recall')`);
    await page.clickAt(`.vh-menu [data-history-id="${originalId}"] .vh-recall`);
  };
  if (scenario === 'mismatch') {
    await close(); await open('flux-basic.png');
    await addParameter(page, '9.steps');
    await page.clickAt('[data-param-key="9.steps"] .mode-switch button[title="Value"]');
    await write('[data-param-key="9.steps"] .vz-value-field input', '32');
    await write('.vz-suffix', '_kept');
    await choose();
    await page.poll('document.querySelector(".vh-warning")?.textContent.includes("missing")');
    await shot('compatible-overlay-warning');
    assert.equal(await page.evaluate('document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input").value'), '0.9');
    assert.equal(await page.evaluate('document.querySelector(".vz-suffix").value'), '_kept');
    assert.equal(await evaluate(`(await import('/store/instance.js')).appStore.state.variations.images[0].filename`), 'flux-basic.png');
    await waitRun();
    const jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
    assert.equal(jobs[1].prompt['9'].inputs.steps, 32); assert.equal(jobs[1].prompt['9'].inputs.denoise, .9);
    fs.writeFileSync(E + '/mismatch-consumer.json', JSON.stringify(jobs));
  } else if (scenario === 'guards') {
    await require('./history-template-labels.cjs')({page,evaluate});
    await close(); await open('flux-controlnet.png');
    await addParameter(page, '43.image');
    await addParameter(page, '9.denoise'); await page.clickAt('[data-param-key="9.denoise"] .mode-switch button[title="Value"]');
    await write('[data-param-key="9.denoise"] .vz-value-field input', '0.7');
    await page.evaluate('window.testHistoryInput=document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input")');
    await choose(); await page.poll('!!document.querySelector(".vz-discard")');
    await shot('recall-overlap-decision');
    assert.equal(await page.evaluate('!!document.querySelector(".vh-menu")?.matches(":popover-open")'), false);
    let heldRelease = null;
    const holdRelease = event => { const msg=JSON.parse(event.data); if(msg.method==='Fetch.requestPaused') heldRelease=msg.params.requestId; };
    page.ws.addEventListener('message',holdRelease);
    await page.send('Fetch.enable',{patterns:[{urlPattern:'*/api/features/variations/history/*/leases/*',requestStage:'Request'}]});
    try {
      await page.clickAt('.vz-keep');
      await page.poll('!document.querySelector(".vz-discard")');
      assert.equal(await page.evaluate('window.testHistoryInput===document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input") && window.testHistoryInput.value==="0.7"'), true);
      for(let i=0;i<100&&!heldRelease;i++)await new Promise(resolve=>setTimeout(resolve,20));
      assert(heldRelease,'cancelled recall releases its lease through real transport');
      await choose(); await page.poll('!!document.querySelector(".vz-discard")');
    } finally {
      if(heldRelease)await page.send('Fetch.continueRequest',{requestId:heldRelease});
      await page.send('Fetch.disable');page.ws.removeEventListener('message',holdRelease);
    }
    await page.clickAt('.vz-discard-confirm');
    await page.poll('document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input")?.value==="0.9"');
    await openImageAdd(page, '[data-image-id="43.image"]');
    await page.clickAt('[data-image-id="43.image"] .vz-input-trigger');
    await waitForInputPicker(page);
    await page.keyTrusted('Escape', { vk: 27 });
    await page.clickAt('.vh-trigger');
    await page.poll('document.querySelector(".vh-menu")?.matches(":popover-open")&&!document.querySelector(".vh-menu").inert');
    await page.clickAt('.vh-trigger');
    console.log('PASS confirmed in-place recall resumes existing input picker and history dropdown');
    assert.equal((await list()).items.length, 1, 'recall/edit alone creates no run');
    await close();
    await panel();
    let pendingOpen=null,releasedLate=false;
    const fence=event=>{const msg=JSON.parse(event.data);if(msg.method!=='Fetch.requestPaused')return;
      if(msg.params.request.url.includes('/leases/')){releasedLate=true;page.send('Fetch.continueRequest',{requestId:msg.params.requestId}).catch(()=>{})}
      else pendingOpen=msg.params.requestId;
    };
    page.ws.addEventListener('message',fence);
    await page.send('Fetch.enable',{patterns:[{urlPattern:`*/api/features/variations/history/${originalId}/open`,requestStage:'Request'},{urlPattern:'*/api/features/variations/history/*/leases/*',requestStage:'Request'}]});
    await page.clickAt(`.vh-panel [data-history-id="${originalId}"] .vh-recall`);
    for(let i=0;i<100&&!pendingOpen;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert(pendingOpen,'original recall is pending before its archive read');
    await open('flux-basic.png');
    await page.send('Fetch.continueRequest',{requestId:pendingOpen});
    for(let i=0;i<200&&!releasedLate;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert(releasedLate,'stale original read releases only its new lease');
    await page.send('Fetch.disable');page.ws.removeEventListener('message',fence);
    assert.equal(await evaluate(`(await import('/store/instance.js')).appStore.state.variations.images[0].filename`),'flux-basic.png');
    assert.equal(await page.evaluate('!!document.querySelector(".vz-discard")'),false);
    await close();
  } else if (scenario === 'recovery') {
    await close(); await open('flux-controlnet.png');
    await addParameter(page, '9.denoise'); await page.clickAt('[data-param-key="9.denoise"] .mode-switch button[title="Value"]');
    await write('[data-param-key="9.denoise"] .vz-value-field input', '1e');
    await page.clickAt('.vz-run'); await page.poll('document.querySelector(".vz-error")?.textContent.includes("number")');
    const rows = await list(); assert.equal(rows.items.length, 2); assert.equal(rows.items[0].outcome, 'rejected');
    const detail = await evaluate(`fetch('/api/features/variations/history/${rows.items[0].id}').then(r=>r.json())`);
    assert.equal(detail.recipe.numeric['9.denoise'].values.value, '1e'); assert.equal(detail.effects.length, 0);
    const jobs = await (await fetch(FAKE + '/__test/enqueues')).json(); assert.equal(jobs.length, 1);
    await close(); await panel();
    await page.clickAt(`[data-history-id="${rows.items[0].id}"] .vh-recall`);
    await page.poll('document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input")?.value==="1e"');
    fs.writeFileSync(E + '/rejected-attempt.json', JSON.stringify(detail));
    await close();
    for (const [mode, value] of [['uncertain','0.8'],['partial','0.7']]) {
      assert((await fetch(FAKE+'/__fixture/acceptance',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode})})).ok);
      await invoke('variations.history.open',{id:originalId});
      await page.poll('!!document.querySelector(".vz-panel")');
      await write('[data-param-key="9.denoise"] .vz-value-field input',value);
      await page.clickAt('.vz-run');
      await page.poll(`fetch('/api/features/variations/history').then(r=>r.json()).then(r=>r.items[0]?.outcome===${JSON.stringify(mode)})`,30000);
      const before=(await(await fetch(FAKE+'/__test/enqueues')).json()).length;
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,3200))');
      assert.equal((await(await fetch(FAKE+'/__test/enqueues')).json()).length,before,'uncertain/partial attempts never retry automatically');
      assert.equal(await page.evaluate('!!document.querySelector(".vz-panel")'),true,'partial/uncertain never auto-closes the draft');
      await close();
    }
  } else if (scenario === 'deletion') {
    await panel(); await page.clickAt(`[data-history-id="${originalId}"] .vh-recall`);
    await page.poll('!!document.querySelector(".vz-panel")');
    // A second client deletes the list record while the opened editor holds its lease.
    await evaluate(`fetch('/api/features/variations/history/${originalId}',{method:'DELETE'}).then(r=>{if(!r.ok)throw Error('delete failed');return r.json()})`);
    assert.equal((await list()).items.length, 0);
    await write('[data-param-key="9.denoise"] .vz-value-field input', '0.8');
    await waitRun(); assert.equal((await list()).items.length, 1);
    await panel();
    const id = (await list()).items[0].id;
    await page.clickAt(`[data-history-id="${id}"] .vh-delete`);
    await page.poll('!document.querySelector(".vh-panel .vh-entry")');
    assert.equal((await list()).items.length, 0);
    await shot('empty-history');
  } else if (scenario === 'layout') {
    await panel();
    await shot('right-panel');
    let paused=null;
    const intercept=event=>{const msg=JSON.parse(event.data);if(msg.method==='Fetch.requestPaused')paused=msg.params.requestId};
    page.ws.addEventListener('message',intercept);
    await page.send('Fetch.enable',{patterns:[{urlPattern:'*/api/features/variations/history',requestStage:'Request'}]});
    await invoke('workspace.select',{space:'details'});await invoke('workspace.select',{space:'variation-history'});
    for(let i=0;i<100&&!paused;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert(paused,'history read reached the browser transport');
    await page.poll('document.querySelector(".vh-panel .vh-status")?.textContent.includes("Reading")');await shot('history-loading');
    await page.send('Fetch.fulfillRequest',{requestId:paused,responseCode:503,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from('{"error":"Fixture history read unavailable"}').toString('base64')});
    await page.poll('document.querySelector(".vh-panel .vh-error")?.textContent.includes("503")');await shot('history-error');
    await page.send('Fetch.disable');page.ws.removeEventListener('message',intercept);
    await page.clickAt('.vh-panel .vh-error button');await page.poll('!document.querySelector(".vh-panel .vh-error")&&!document.querySelector(".vh-panel .vh-status")');
    const geometry = [];
    for (const width of [220, 300, 480]) {
      await evaluate(`(await import('/store/instance.js')).appStore.actions.anchors.setPaneWidth(${width})`);
      await page.poll(`Math.abs(document.querySelector('#workspace').getBoundingClientRect().width-${width})<1`);
      geometry.push(await page.evaluate(`(()=>{const row=document.querySelector('.vh-entry'),box=row.getBoundingClientRect();return {width:${width},overflow:row.scrollWidth>row.clientWidth,labels:[...row.querySelectorAll('.vh-label')].map(e=>({height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)})),box:box.toJSON()}})()`));
    }
    assert(geometry.every(row => !row.overflow && row.labels.every(label => label.height <= label.line + 1)), JSON.stringify(geometry));
    await page.clickAt(`[data-history-id="${originalId}"] .vh-recall`); await page.poll('!!document.querySelector(".vz-panel")');
    await page.clickAt('.vh-trigger'); await page.poll('!!document.querySelector(".vh-menu")?.matches(":popover-open")'); await shot('dialog-dropdown');
    await page.clickAt('.vh-trigger');
    for (const [width, height] of [[1280,800],[500,700],[360,640],[1024,360]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor:1, mobile:false });
      await page.evaluate('document.querySelector(".vz-suffix").focus()'); await page.keyTrusted('Tab', {vk:9});
      const result = await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=document.querySelector('.vh-trigger').getBoundingClientRect(),c=document.querySelector('.vh-trigger .chevron-slot').getBoundingClientRect();resolve({width:innerWidth,height:innerHeight,trigger:r.toJSON(),chevron:c.toJSON(),disabled:document.querySelectorAll('.vz-panel [disabled]').length,run:document.querySelector('.vz-run').getBoundingClientRect().toJSON()})})))`);
      geometry.push(result); assert.equal(result.disabled, 0); assert(result.run.bottom <= height + 1 && result.run.top >= 0, JSON.stringify(result));
      assert(Math.abs((result.trigger.top+result.trigger.bottom-result.chevron.top-result.chevron.bottom)/2)<.5,'trigger/chevron share a structural centerline');
    }
    fs.writeFileSync(E + '/geometry.json', JSON.stringify(geometry));
    await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    await close();
    await evaluate(`fetch('/api/collections/fake',{method:'DELETE'}).then(r=>{if(!r.ok)throw Error('fixture source removal failed');return r.json()})`);
    await invoke('variations.history.open',{id:originalId});
    await page.poll('!!document.querySelector(".vz-readiness-error")&&!document.querySelector(".vz-run")');
    assert.equal(await page.evaluate('document.querySelector("[data-param-key=\\"9.denoise\\"] .vz-value-field input").value'),'0.9');
    await shot('offline-original');
  }
  console.log('History browser consumer passed: ' + scenario);
};
