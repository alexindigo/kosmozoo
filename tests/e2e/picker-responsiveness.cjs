const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OTHER = process.env.E2E_FAKE2, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`, TARGET = 'responsiveness-target.png';
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && OTHER && E);
  const page = await CDP.launch(9471, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), proof = {}, paused = [];
  const evaluate = expression => page.evaluate(`(async()=>(${expression}))()`);
  const space = type => page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    ...(type === 'keyDown' ? { text: ' ', unmodifiedText: ' ' } : {}) });
  const hover = async selector => {
    const r = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await page.mouse('mouseMoved', r.x, r.y);
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`);
  };
  const capture = async name => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(`${E}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    fs.mkdirSync(`${E}/review/${name}`, { recursive: true });
    for (const [region, selector] of [['header', '#chrome'], ['title', '.vz-title'], ['catalogue', '.vz-catalogue'], ['editor', '.vz-sliders'], ['summary', '.vz-right'], ['picker', '.vz-input-popover']]) {
      const clip = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r?{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.right,innerWidth)-Math.max(0,r.x),height:Math.min(r.bottom,innerHeight)-Math.max(0,r.y),scale:2}:null})()`);
      if (clip && clip.width > 0 && clip.height > 0) fs.writeFileSync(`${E}/review/${name}/${region}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    }
  };
  const onPause = event => { const m = JSON.parse(event.data); if (m.method === 'Fetch.requestPaused') paused.push(m.params); };
  try {
    const names = Array.from({ length: 10 }, (_, i) => `rapid-${i}.png`);
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: 'original.png' } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'responsive' } } };
    assert((await control(FAKE, { reset: true, publishInputs: [{ name: 'original.png', fixture: 'flux-basic.png' }], publish: [{ name: TARGET, fixture: 'flux-lora.png', graph }] })).ok);
    assert((await control(OTHER, { reset: true, publishInputs: [...names, 'fail.png', 'cancel.png', 'peek-delayed.png', 'peek-failed.png'].map((name, i) => ({ name, fixture: 'flux-basic.png', width: 96, height: 64, color: [40 + i * 10, 80, 180, 255] })) })).ok);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake'); await page.poll(`(async()=>${KZ}.state.images.length>0)()`, 20000);
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await evaluate(`${KZ}.handles.invoke('variations.open',{id:'fake:${TARGET}'})`);
    await addParameter(page, '11.image'); await removeRecordedImage(page, '11.image');
    await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    assert(await evaluate(`document.activeElement.matches('.vz-input-list')`), 'opening focuses the grid, not search');
    await page.clickAt('.vz-input-tabs [data-value="another"]');
    await page.poll(`!!document.querySelector(${JSON.stringify(option(names[0]))})`);
    // Only membership byte reads are held. Native thumbnail/peek loads retain
    // their real display/acquisition path, independent of selected membership.
    await evaluate(`(()=>{const original=window.fetch;window.pickReads=[];window.pickFrames=[];window.pickActive=0;window.pickMax=0;
      window.fetch=(...args)=>{const url=String(args[0]);if(!url.includes('/another/entries/')||!url.includes('/bytes')||url.includes('intent='))return original(...args);
        const name=decodeURIComponent(url.split('/entries/')[1].split('/bytes')[0]);window.pickActive++;window.pickMax=Math.max(window.pickMax,window.pickActive);
        return new Promise((resolve,reject)=>window.pickReads.push({name,release:async(fail=false)=>{try{resolve(fail?new Response(JSON.stringify({error:'controlled byte failure'}),{status:503,headers:{'Content-Type':'application/json'}}):await original(...args))}catch(e){reject(e)}finally{window.pickActive--}}}));};
      document.addEventListener('click',event=>{const tile=event.target.closest('.vz-input-option');if(!tile||!tile.dataset.inputName.startsWith('rapid-'))return;
        const name=tile.dataset.inputName;requestAnimationFrame(()=>window.pickFrames.push({name,selected:tile.getAttribute('aria-selected'),pending:!!tile.closest('.vz-thumbnail').querySelector('.vz-thumbnail-acquiring'),search:document.activeElement.matches('.vz-input-search')}));},true);return true})()`);
    for (const name of names) await page.clickAt(option(name));
    await page.poll(`window.pickFrames.length===10`);
    proof.firstFrame = await evaluate('window.pickFrames');
    assert(proof.firstFrame.every(row => row.selected === 'true' && row.pending && !row.search), JSON.stringify(proof.firstFrame));
    assert.equal(await evaluate('window.pickReads.length'), 4);
    proof.indicators = await evaluate(`(()=>{const tile=document.querySelector('.vz-input-option[aria-selected=true]'),check=tile.querySelector('.vz-input-selected svg path'),spinner=tile.closest('.vz-thumbnail').querySelector('.vz-submit-spinner'),r=spinner.getBoundingClientRect();return{check:check?.getAttribute('d'),spinner:[r.width,r.height],display:getComputedStyle(spinner.parentElement).display}})()`);
    assert(proof.indicators.check, 'selected check must contain icon geometry');
    assert(proof.indicators.spinner.every(value=>value>=16), JSON.stringify(proof.indicators));
    await hover(option('rapid-9.png')); await capture('picker-responsiveness');
    await space('keyDown');
    await page.poll(`document.querySelector('.vz-peek-image.is-shown')?.naturalWidth>0`);
    assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 0, 'pending acquisition can peek without adding its File');
    await space('keyUp'); await page.poll(`!document.querySelector('.vz-peek:popover-open')`);
    for (const group of [[3, 2, 1], [6, 5, 4], [9, 8, 7]]) {
      await page.poll(`window.pickReads.length>=${Math.max(...group) + 1}`);
      await evaluate(`Promise.all(${JSON.stringify(group)}.map(i=>window.pickReads.find(row=>row.name==='rapid-'+i+'.png').release()))`);
    }
    assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 0, 'later completions wait for the first click');
    await evaluate(`window.pickReads.find(row=>row.name==='rapid-0.png').release()`);
    await page.poll(`document.querySelectorAll('.vz-image-tile').length===10&&!document.querySelector('.vz-image-check')`, 30000);
    proof.order = await evaluate(`[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName)`);
    assert.deepEqual(proof.order, names); assert.equal(await evaluate('window.pickMax'), 4);
    await page.clickAt(option('fail.png')); await page.clickAt(option('cancel.png')); await page.clickAt(option('cancel.png'));
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(option('cancel.png'))}).getAttribute('aria-selected')`), 'false');
    await evaluate(`Promise.all([window.pickReads.find(row=>row.name==='cancel.png').release(),window.pickReads.find(row=>row.name==='fail.png').release(true)])`);
    await page.poll(`document.querySelector(${JSON.stringify(option('fail.png'))}).getAttribute('aria-selected')==='false'`);
    proof.failure = await evaluate(`document.querySelector(${JSON.stringify(option('fail.png'))}).closest('.vz-thumbnail').textContent`);
    assert(proof.failure.includes('fail.png') && proof.failure.includes('controlled byte failure'), proof.failure);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName)`), names);
    // Hover geometry is unchanged for picker and picked tiles, with the same
    // high-contrast outline. The input remains ordinary text when clicked.
    const geometry = async selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),s=getComputedStyle(el);return{rect:[r.x,r.y,r.width,r.height],outline:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor}})()`);
    await page.mouse('mouseMoved', 2, 2); const before = await geometry(option('rapid-9.png'));
    await hover(option('rapid-9.png')); const after = await geometry(option('rapid-9.png'));
    assert.deepEqual(after.rect, before.rect); assert.equal(after.outline, 'solid'); assert.equal(after.width, '2px'); proof.hover = after;
    await page.clickAt('.vz-input-search'); await hover(option('rapid-9.png')); await space('keyDown'); await space('keyUp');
    assert.equal(await evaluate(`document.querySelector('.vz-input-search').value`), ' ');
    assert(!await evaluate(`!!document.querySelector('.vz-peek:popover-open')`));
    await page.clickAt('.vz-search-clear');
    // Retire/reopen the picker to acquire unseen thumbnail URLs under CDP.
    await page.keyTrusted('Escape', { vk: 27 });
    const picked = '.vz-image-tile[data-image-name="rapid-0.png"]';
    await page.clickAt(picked); await page.mouse('mouseMoved', 2, 2); const pickedBefore = await geometry(picked);
    await hover(picked); const pickedAfter = await geometry(picked);
    assert.deepEqual(pickedAfter.rect, pickedBefore.rect); assert.equal(pickedAfter.color, after.color); assert.equal(pickedAfter.width, after.width);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    assert(!await evaluate(`document.activeElement.matches('.vz-input-search')`));
    await page.clickAt('.vz-input-search'); await page.send('Input.insertText', { text: 'peek-' });
    await page.keyTrusted('Escape', { vk: 27 });
    page.ws.addEventListener('message', onPause);
    await page.send('Network.enable'); await page.send('Network.setCacheDisabled', { cacheDisabled: true }); await page.send('Network.clearBrowserCache');
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*peek-*.png*', resourceType: 'Image', requestStage: 'Request' }] });
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    await page.poll(`!!document.querySelector(${JSON.stringify(option('peek-delayed.png'))})`);
    await hover(option('peek-delayed.png')); await space('keyDown');
    await page.poll(`!!document.querySelector('.vz-peek:popover-open .vz-peek-loading')`);
    proof.loading = await evaluate(`({text:document.querySelector('.vz-peek-loading').textContent,backdrop:getComputedStyle(document.querySelector('.vz-peek-backdrop')).opacity,box:document.querySelector('.vz-peek-frame').getBoundingClientRect().toJSON(),layer:document.querySelector('.vz-peek').getBoundingClientRect().toJSON(),open:document.querySelector('.vz-peek').matches(':popover-open'),display:getComputedStyle(document.querySelector('.vz-peek')).display,visibility:getComputedStyle(document.querySelector('.vz-peek-loading')).visibility})`);
    assert.equal(proof.loading.backdrop, '1'); assert(proof.loading.box.width > 0);
    await capture('picker-peek-loading');
    proof.loadingAfterCapture = await evaluate(`({open:document.querySelector('.vz-peek').matches(':popover-open'),loading:!!document.querySelector('.vz-peek-loading'),focus:document.hasFocus()})`);
    assert(proof.loadingAfterCapture.loading, 'loading capture must retain the held native request');
    await page.send('Fetch.disable');
    await page.poll(`document.querySelector('.vz-peek-image.is-shown')?.naturalWidth>0&&!document.querySelector('.vz-peek-loading')`);
    await space('keyUp'); await page.poll(`!document.querySelector('.vz-peek:popover-open')`);
    // A failed thumbnail retains its hover surface. A fresh peek requests the
    // same real resource and can replace the placeholder with decoded pixels.
    await page.keyTrusted('Escape', { vk: 27 });
    await page.send('Network.enable'); await page.send('Network.clearBrowserCache');
    paused.length = 0;
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*peek-failed.png*', resourceType: 'Image', requestStage: 'Request' }] });
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    for (let i = 0; i < 100 && !paused.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert(paused.length, 'intercepted native thumbnail');
    for (const request of paused.splice(0)) await page.send('Fetch.fulfillRequest', { requestId: request.requestId, responseCode: 503, body: '' });
    await page.poll(`!document.querySelector(${JSON.stringify(option('peek-failed.png'))}).closest('.vz-thumbnail').querySelector('.vz-thumbnail-failure').hidden`);
    await hover(option('peek-failed.png')); await space('keyDown');
    await page.poll(`!!document.querySelector('.vz-peek:popover-open .vz-peek-loading')`);
    await page.send('Fetch.disable');
    await page.poll(`document.querySelector('.vz-peek-image.is-shown')?.naturalWidth>0`);
    await space('keyUp'); await page.poll(`!document.querySelector('.vz-peek:popover-open')`);
    // Keyboard navigation stays on the non-text surface.
    await page.keyTrusted('ArrowRight', { vk: 39 }); await page.poll(`document.activeElement.matches('.vz-input-option')`);
    assert(!await evaluate(`document.activeElement.matches('.vz-input-search')`));
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${E}/picker-responsiveness-proof.json`, JSON.stringify({ ...proof, pageErrors: errors }, null, 2));
    console.log('PASS picker responsiveness: first-frame optimistic 10/10, four concurrent reads, click order, cancel/failure isolation, no search autofocus, text Space, hover geometry, pending/unloaded/failed-thumbnail peek -> decoded image');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
