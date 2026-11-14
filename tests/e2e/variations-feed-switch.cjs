// Real popup, root bytes and actual enqueue/upload proof. Runs in the owned VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OTHER = process.env.E2E_FAKE2;
const E = process.env.E2E_EVIDENCE, KZ = `(await import('/store/instance.js')).appStore`;
const NAME = 'feeds-same.png', TARGET = 'feeds-target.png';
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  assert(ENGINE && FAKE && OTHER && E, 'Explicit owned stack and evidence required');
  const page = await CDP.launch(9396, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), requests = [];
  page.ws.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request); });
  await page.send('Network.enable');
  const evaluate = text => page.evaluate(`(async()=>(${text}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const shot = async name => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(E + '/' + name + '.png', Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    fs.mkdirSync(E + '/review/' + name, { recursive: true });
    for (const [region, selector] of [['header', '#chrome'], ['title', '.vz-title'], ['catalogue', '.vz-catalogue'], ['editor', '.vz-sliders'], ['summary', '.vz-right'], ['picker', '.vz-input-popover'], ['footer', '.vz-input-summary']]) {
      const clip = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.right,innerWidth)-Math.max(0,r.x),height:Math.min(r.bottom,innerHeight)-Math.max(0,r.y),scale:2}})()`);
      if (clip && clip.width > 0 && clip.height > 0) fs.writeFileSync(E + '/review/' + name + '/' + region + '.png', Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    }
  };
  const feed = root => page.clickAt(`.vz-input-feeds [data-value="${root}"]`);
  const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
  const waitName = name => page.poll(`!!document.querySelector(${JSON.stringify(option(name))})`, 15000);
  const key = (name, vk) => page.keyTrusted(name, { vk });
  const waitJobs = async count => {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
      if (jobs.length === count) return jobs;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await shot('feeds-missing-enqueue');
    fs.writeFileSync(E + '/missing-enqueue-requests.json', JSON.stringify(requests, null, 2));
    throw new Error('Missing captured enqueue: ' + await evaluate(`document.querySelector('.vz-right')?.textContent`));
  };
  const geometryProbe = `(()=>{
    const popup=document.querySelector('.vz-input-popover'),foot=popup.querySelector('.vz-input-summary'),count=foot.querySelector('[role=status]'),group=foot.querySelector('.tabs');
    const source=popup.querySelector('.vz-input-tabs .tabs-tab'),button=group.querySelector('.tabs-tab');
    const a=count.getBoundingClientRect(),b=group.getBoundingClientRect(),s=getComputedStyle(source),t=getComputedStyle(button),f=foot.getBoundingClientRect(),p=getComputedStyle(popup);
    const chrome=['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth'].reduce((sum,k)=>sum+parseFloat(p[k]),0);
    const floor=a.width+b.width+parseFloat(getComputedStyle(foot).columnGap)+chrome;
    return{center:Math.abs((a.top+a.bottom-b.top-b.bottom)/2),overlap:a.right>b.left,
      contained:foot.scrollWidth<=foot.clientWidth+1||getComputedStyle(foot).overflowX==='auto',
      popupWidth:popup.getBoundingClientRect().width,floor,minimum:Math.min(floor,innerWidth-8),
      height:[source.offsetHeight,button.offsetHeight],tokens:['paddingTop','paddingBottom','paddingLeft','paddingRight','borderWidth','borderRadius','fontSize','lineHeight'].map(k=>[s[k],t[k]]),width:f.width};
  })()`;
  const checkGeometry = async () => {
    await page.poll(`(()=>{const data=${geometryProbe};return data.popupWidth+1>=data.minimum})()`);
    const data=await evaluate(geometryProbe); assert(data.center < 1); assert(!data.overlap); assert(data.contained);
    assert(data.popupWidth+1>=data.minimum); assert.equal(data.height[0],data.height[1]);
    for(const [a,b] of data.tokens)assert.equal(a,b); return data;
  };
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: NAME } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'feeds' } } };
    assert((await control(FAKE, { reset: true, captureEnqueue: true, publishInputs: [{ name: NAME, fixture: 'flux-basic.png', width: 96, height: 64, color: [210, 30, 30, 255] }],
      publish: [{ name: NAME, fixture: 'flux-basic.png', width: 96, height: 64, color: [30, 180, 60, 255] }, { name: TARGET, fixture: 'flux-lora.png', graph, mtime: 2100009002 }] })).ok);
    assert((await control(OTHER, { reset: true, publish: [{ name: 'feeds-foreign.png', fixture: 'flux-ipadapter.png', width: 96, height: 64, color: [40, 60, 210, 255] }] })).ok);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake'); await page.poll(`(async()=>${KZ}.state.images.length>0)()`, 20000);
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + TARGET }); await addParameter(page, '11.image');
    await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page); await waitName(NAME);
    // Retain actual popup and search DOM across root/source switches.
    await evaluate(`(async()=>{window.feedPopup=document.querySelector('.vz-input-popover');window.feedSearch=document.querySelector('.vz-input-search');window.feedBefore={url:location.href,host:${KZ}.state.host(),current:${KZ}.state.currentEntry()?.id,count:document.querySelector('.vz-count').textContent};return true})()`);
    await shot('feeds-imported');
    const imported = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(option(NAME))});return{selected:el.getAttribute('aria-selected'),current:!!el.querySelector('.vz-image-same'),src:el.querySelector('img')?.src}})()`);
    assert.equal(imported.selected, 'true'); assert(imported.current);
    await evaluate(`(()=>{window.feedOldNative=document.querySelector(${JSON.stringify(option(NAME) + ' img')});return true})()`);
    await feed('output'); await waitName(NAME);
    assert(await evaluate(`document.querySelector('.vz-input-popover')===window.feedPopup&&document.querySelector('.vz-input-search')===window.feedSearch`));
    assert(await evaluate(`!window.feedOldNative.isConnected`), 'root change retires old native thumbnail element');
    const output = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(option(NAME))});return{selected:el.getAttribute('aria-selected'),current:!!el.querySelector('.vz-image-same'),src:el.querySelector('img')?.src}})()`);
    assert.equal(output.selected, 'false'); assert(!output.current);
    await page.poll(`document.querySelector(${JSON.stringify(option(NAME) + ' img')})?.complete&&document.querySelector(${JSON.stringify(option(NAME) + ' img')})?.naturalWidth>0`);
    const bytes = await evaluate(`Promise.all([${JSON.stringify(imported.src)},document.querySelector(${JSON.stringify(option(NAME) + ' img')}).src].map(async url=>{const r=await fetch(url),bytes=await r.arrayBuffer();return{root:new URL(url).searchParams.get('kind'),hash:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')}}))`);
    assert.deepEqual(bytes.map(row => row.root ?? 'output'), ['input', 'output']); assert.notEqual(bytes[0].hash, bytes[1].hash);
    const geometryResults = [await checkGeometry()];
    await shot('feeds-generated');
    // Both tab groups own their own dispatcher routing; native activation never picks a tile.
    await key('Home', 36); await page.poll(`document.querySelector('.vz-input-feeds [data-value=input]').getAttribute('aria-selected')==='true'`);
    await key('End', 35); await waitName(NAME); await key('Enter', 13); await key(' ', 32);
    assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 1);
    await page.clickAt('.vz-input-tabs [data-value="fake"]'); await key('End', 35);
    await page.poll(`document.querySelector('.vz-input-tabs [data-value=another]').getAttribute('aria-selected')==='true'`);
    assert.equal(await evaluate(`document.querySelector('.vz-input-feeds [aria-selected=true]').dataset.value`), 'output');
    await key('Home', 36); await waitName(NAME);
    for (const [selector, expected] of [['.vz-input-feeds [data-value="output"]', 'input'], ['.vz-input-tabs [data-value="fake"]', 'another']]) {
      await page.clickAt(selector); await key('ArrowRight', 39);
      const group = selector.includes('feeds') ? '.vz-input-feeds' : '.vz-input-tabs';
      await page.poll(`document.querySelector('${group} [aria-selected=true]').dataset.value===${JSON.stringify(expected)}`);
      await key('ArrowLeft', 37);
    }
    await waitName(NAME);
    await key('Enter', 13); await key(' ', 32);
    assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 1, 'source tab activation does not toggle the grid');
    // Search state and ordered set stay intact through both contexts.
    await page.clickAt('.vz-input-search'); await page.send('Input.insertText', { text: 'feeds-' });
    await feed('input'); await waitName(NAME); await feed('output'); await waitName(NAME);
    assert.equal(await evaluate(`document.querySelector('.vz-input-search').value`), 'feeds-');
    assert(await evaluate(`location.href===window.feedBefore.url&&${KZ}.state.host()===window.feedBefore.host&&${KZ}.state.currentEntry()?.id===window.feedBefore.current&&document.querySelector('.vz-count').textContent===window.feedBefore.count`));
    await page.clickAt(option(NAME)); assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 2);
    await feed('input'); await waitName(NAME); assert.equal(await evaluate(`document.querySelector(${JSON.stringify(option(NAME))}).getAttribute('aria-selected')`), 'true');
    await feed('output'); await waitName(NAME); assert.equal(await evaluate(`document.querySelector(${JSON.stringify(option(NAME))}).getAttribute('aria-selected')`), 'true');
    // Narrow geometry uses the real intrinsic footer, plus presentation-only large-count probes.
    const countText = await evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent`);
    for (const count of [1, 80, 999]) for (const width of [380, 270, 250, 210]) {
      // Typography/allocation probe only: selection behavior is exercised separately.
      await evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent=${JSON.stringify(count + ' selected')}`);
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await page.poll(`document.querySelector('.vz-input-popover').getBoundingClientRect().right<=innerWidth+1`);
      geometryResults.push({ count, viewport: width, ...await checkGeometry() });
      if (count === 1 && width === 250) await shot('feeds-narrow');
    }
    await evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent=${JSON.stringify(countText)}`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.poll(`document.querySelector('.vz-input-popover').getBoundingClientRect().width>300`);
    // Discard suspension retains this exact root/search/DOM and resumes focus/caret.
    await page.clickAt('.vz-input-search'); await evaluate(`(()=>{const s=document.querySelector('.vz-input-search');s.setSelectionRange(2,4);return true})()`);
    await evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`); await page.poll(`!!document.querySelector('.vz-discard')&&!document.querySelector('.vz-input-popover:popover-open')`);
    await page.clickAt('.vz-keep'); await waitForInputPicker(page);
    assert(await evaluate(`document.querySelector('.vz-input-search')===window.feedSearch&&document.querySelector('.vz-input-search').value==='feeds-'&&document.querySelector('.vz-input-feeds [data-value=output]').getAttribute('aria-selected')==='true'`));
    await key('Escape', 27); await page.poll(`!document.querySelector('.vz-input-popover')`);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    assert(await evaluate(`document.querySelector('.vz-input-feeds [aria-selected=true]').dataset.value==='output'&&document.querySelector('.vz-input-search').value==='feeds-'`));
    await key('Escape', 27); await page.poll(`!document.querySelector('.vz-input-popover')`);
    // Same-source generated selection reaches the actual graph, with no upload request.
    await page.clickAt('.vz-run');
    let jobs = await waitJobs(1); assert.equal(jobs[0].prompt['11'].inputs.image, NAME + ' [output]');
    assert.equal(requests.filter(row => row.method === 'POST' && /\/entries(?:\?|$)/.test(new URL(row.url).pathname)).length, 0);
    assert.equal(fs.readdirSync(E).filter(name => /^upload-\d+\.json$/.test(name)).length, 0, 'same-source output makes no backend upload');
    await page.poll(`!document.querySelector('.vz-panel')`, 8000);
    // Foreign generated bytes keep their captured output root and existing File/receipt lane.
    await invoke('variations.open', { id: 'fake:' + TARGET }); await addParameter(page, '11.image'); await removeRecordedImage(page, '11.image');
    await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    await feed('output'); await page.clickAt('.vz-input-tabs [data-value="another"]'); await waitName('feeds-foreign.png');
    const foreignSrc = await evaluate(`document.querySelector(${JSON.stringify(option('feeds-foreign.png') + ' img')}).src`);
    const expected = hash(Buffer.from(await (await fetch(foreignSrc)).arrayBuffer()));
    assert.equal(new URL(foreignSrc).searchParams.get('kind') ?? 'output', 'output');
    await evaluate(`(()=>{const original=window.fetch;window.restoreForeignRead=()=>window.fetch=original;window.fetch=(...args)=>String(args[0]).includes('/another/entries/feeds-foreign.png/bytes')&&!String(args[0]).includes('intent=')?new Promise(resolve=>window.releaseForeignRead=()=>resolve(original(...args))):original(...args);return true})()`);
    await page.clickAt(option('feeds-foreign.png'));
    await page.poll(`typeof window.releaseForeignRead==='function'`);
    await feed('input');
    assert.equal(await evaluate(`document.querySelectorAll('.vz-image-tile').length`), 0);
    await evaluate(`(()=>{window.releaseForeignRead();window.restoreForeignRead();return true})()`);
    await page.poll(`document.querySelectorAll('.vz-image-tile').length===1&&!document.querySelector('.vz-image-check')`, 15000);
    fs.writeFileSync(E + '/foreign-before-run.json', JSON.stringify(await evaluate(`({summary:document.querySelector('.vz-right').textContent,images:[...document.querySelectorAll('.vz-image-tile')].map(el=>({name:el.dataset.imageName,kind:el.dataset.imageKind,text:el.textContent}))})`), null, 2));
    assert(await evaluate(`!!document.querySelector('.vz-input-popover:popover-open')`));
    await key('Escape', 27); await page.poll(`!document.querySelector('.vz-input-popover')`); await page.clickAt('.vz-run');
    jobs = await waitJobs(2);
    const uploaded = jobs[1].prompt['11'].inputs.image;
    assert.equal(hash(Buffer.from(await (await fetch(FAKE + '/api/view?' + new URLSearchParams({ filename: uploaded, type: 'input' }))).arrayBuffer())), expected);
    assert.equal(fs.readdirSync(E).filter(name => /^upload-\d+\.json$/.test(name)).length, 1, 'foreign output materializes one actual backend upload');
    await page.poll(`!document.querySelector('.vz-panel')`, 8000);
    console.log('PASS generated enqueue and foreign output receipt bytes');
    const currentTarget = 'feeds-output-current.png';
    const outputGraph = { ...graph, '11': { ...graph['11'], inputs: { image: NAME + ' [output]' } } };
    assert((await control(FAKE, { publish: [{ name: currentTarget, fixture: 'flux-lora.png', graph: outputGraph }] })).ok);
    await evaluate(`fetch('/api/collections/fake/entries/${currentTarget}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + currentTarget }); await addParameter(page, '11.image');
    await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page); await feed('output'); await waitName(NAME);
    assert(await evaluate(`!!document.querySelector(${JSON.stringify(option(NAME) + ' .vz-image-same')})`));
    assert.equal(await evaluate(`document.querySelector('.vz-count').textContent`), '0');
    await page.clickAt(option(NAME)); await page.clickAt(option(NAME));
    assert.equal(await evaluate(`document.querySelector('.vz-count').textContent`), '0', 'reselected concrete current output remains the unchanged tuple');
    await feed('input'); await waitName(NAME);
    assert(!await evaluate(`!!document.querySelector(${JSON.stringify(option(NAME) + ' .vz-image-same')})`));
    await key('Escape', 27); await page.clickAt('.vz-current-image');
    assert.equal(await evaluate(`document.querySelector('.vz-count').textContent`), '1');
    await page.clickAt('.vz-run'); jobs = await waitJobs(3);
    assert.equal(jobs[2].prompt['11'].inputs.image, currentTarget + ' [output]', 'Current image remains target-relative, separate from the concrete current output');
    assert.equal(fs.readdirSync(E).filter(name => /^upload-\d+\.json$/.test(name)).length, 1);
    await page.poll(`!document.querySelector('.vz-panel')`, 8000);
    // Defer real catalogue reads at the transport boundary. Feed switching must
    // not cancel a captured read or let its later settlement replace another root.
    const paused = [];
    const onPause = event => { const message = JSON.parse(event.data); if (message.method === 'Fetch.requestPaused') paused.push(message.params); };
    page.ws.addEventListener('message', onPause);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*catalogue=images-v1*', requestStage: 'Request' }] });
    const take = async root => {
      const start = Date.now();
      while (!paused.some(row => new URL(row.request.url).searchParams.get('kind') === root)) {
        if (Date.now() - start > 10000) throw new Error('Missing intercepted ' + root + ' catalogue');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return paused.splice(paused.findIndex(row => new URL(row.request.url).searchParams.get('kind') === root), 1)[0];
    };
    const fail = row => page.send('Fetch.fulfillRequest', { requestId: row.requestId, responseCode: 503, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"controlled catalogue failure"}').toString('base64') });
    try {
      await invoke('variations.open', { id: 'fake:' + TARGET });
      const oldInput = await take('input'); await addParameter(page, '11.image'); await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
      await page.poll(`document.querySelector('.vz-input-status[role=status]')?.textContent.includes('imported')`);
      await feed('output'); const currentOutput = await take('output');
      await page.send('Fetch.continueRequest', { requestId: currentOutput.requestId }); await waitName(NAME);
      await fail(oldInput);
      await page.poll(`!document.querySelector('.vz-input-failure:not([hidden])')`);
      assert.equal(await evaluate(`document.querySelector('.vz-input-feeds [aria-selected=true]').dataset.value`), 'output');
      await feed('input'); const failedRetry = await take('input'); await fail(failedRetry);
      await page.poll(`!!document.querySelector('.vz-input-failure:not([hidden])')`);
      assert.equal(await evaluate(`document.querySelectorAll('.vz-input-feeds [role=tab]').length`), 2);
      await shot('feeds-error');
      await page.clickAt('.vz-input-failure .vz-thumbnail-retry'); const retry = await take('input');
      await page.send('Fetch.continueRequest', { requestId: retry.requestId }); await waitName(NAME);
      assert(!await evaluate(`!!document.querySelector('.vz-input-failure:not([hidden])')`));
      await feed('output'); await page.clickAt('.vz-input-tabs [data-value="another"]'); const empty = await take('output');
      const header = Object.entries(empty.request.headers).find(([name]) => name.toLowerCase() === 'x-kosmozoo-origin')[1];
      await page.send('Fetch.fulfillRequest', { requestId: empty.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ files: [], origin: JSON.parse(header), root: 'output' })).toString('base64') });
      await page.poll(`document.querySelector('.vz-input-list .vz-image-empty')?.textContent==='No generated images available.'`);
      assert.equal(await evaluate(`document.querySelectorAll('.vz-input-feeds [role=tab]').length`), 2); await shot('feeds-empty');
      await feed('input'); const otherInput = await take('input'); await page.send('Fetch.continueRequest', { requestId: otherInput.requestId });
      await feed('output'); assert.equal(await evaluate(`document.querySelectorAll('.vz-input-option').length`), 0);
    } finally {
      page.ws.removeEventListener('message', onPause); await page.send('Fetch.disable');
    }
    await evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
    await page.poll(`!document.querySelector('.vz-panel')`);
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/feeds-proof.json', JSON.stringify({ bytes, geometryResults, jobs, requests: requests.filter(row => /catalogue=images-v1|kind=output|\/entries$/.test(row.url)) }, null, 2));
    console.log('PASS boxed tabs, root thumbnails, retained set/query/context, scoped keyboard, narrow geometry, suspend/resume, generated enqueue zero uploads, foreign output receipt bytes');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
