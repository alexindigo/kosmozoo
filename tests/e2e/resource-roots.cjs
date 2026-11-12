// Same-named input/output/temp images stay distinct resources in Details, the
// viewer, zoom/focus and a Variations Run. Each root carries different real PNG
// bytes; checks observe native display requests, decoded pixels, URL round trip
// and the actual captured prompt, not mounted elements or HTTP status alone.
const { CDP, collectPageErrors } = require('./cdp.cjs');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const OTHER = process.env.E2E_FAKE2 || 'http://127.0.0.1:18262';
const KZ = `(await import('/store/instance.js')).appStore`;
const NAME = 'roots-same.png', GEN = 'roots-gen.png';
// Real PNG fixtures re-rendered in distinct colours: different bytes AND pixels.
const ROOTS = { input: { fixture: 'flux-basic.png', width: 96, height: 64, color: [200, 40, 40, 255] },
  output: { fixture: 'flux-basic.png', width: 96, height: 64, color: [40, 160, 60, 255] }, temp: { fixture: 'flux-basic.png', width: 96, height: 64, color: [40, 70, 200, 255] } };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const evidence = process.env.E2E_EVIDENCE;
let failures = 0, checks = 0;
const check = (name, ok, detail = '') => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); if (!ok) failures++; };
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const page = await CDP.launch(9393, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const capture = async name => { if (evidence) fs.writeFileSync(`${evidence}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: NAME }, _meta: { title: 'Input root' } },
      '12': { class_type: 'LoadImage', inputs: { image: `${NAME} [output]` }, _meta: { title: 'Output root' } },
      '13': { class_type: 'LoadImage', inputs: { image: `${NAME} [temp]` }, _meta: { title: 'Temp root' } },
      '14': { class_type: 'SaveImage', inputs: { images: ['13', 0], filename_prefix: 'roots' } } };
    assert((await control(FAKE, { reset: true, captureEnqueue: true, publishInputs: [{ name: NAME, ...ROOTS.input }],
      publishTemps: [{ name: NAME, ...ROOTS.temp }],
      publish: [{ name: NAME, ...ROOTS.output, mtime: 2100009001 }, { name: GEN, fixture: 'flux-lora.png', graph, width: 640, height: 480, mtime: 2100009002 }] })).ok);
    // Another ComfyUI source holds a File whose bytes equal the TEMP current.
    assert((await control(OTHER, { reset: true })).ok);
    const tempBytes = Buffer.from(await (await fetch(`${FAKE}/api/view?${new URLSearchParams({ filename: NAME, type: 'temp' })}`)).arrayBuffer());
    const form = new FormData(); form.append('image', new Blob([tempBytes]), 'roots-temp-copy.png');
    assert((await fetch(OTHER + '/api/upload/image', { method: 'POST', body: form })).ok);
    const expected = {};
    for (const root of Object.keys(ROOTS)) {
      const response = await fetch(`${FAKE}/api/view?${new URLSearchParams({ filename: NAME, type: root })}`);
      expected[root] = sha(Buffer.from(await response.arrayBuffer()));
    }
    check('fixture roots hold three different byte streams', new Set(Object.values(expected)).size === 3, JSON.stringify(expected));

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake');
    await page.poll(`(async()=>${KZ}.state.images.length > 0)()`, 20000);
    await page.evaluate(`(async()=>{const s=${KZ}; await s.actions.ui.refresh(); await fetch('/api/collections/fake/entries/${GEN}/bytes');
      await s.actions.ui.refresh(); s.actions.ui.setWorkspace('details'); s.actions.ui.setInfoLayout('split'); s.actions.anchors.setPaneWidth(700);
      s.actions.current.set('fake','${GEN}'); s.actions.feed.restoreToIndex(s.state.currentEntry().index);})()`);
    await page.poll(`document.querySelectorAll('.infoimg[data-resource] img').length===3&&[...document.querySelectorAll('.infoimg[data-resource] img')].every(img=>img.complete&&img.naturalWidth>0)`, 20000);

    // Native display: each tile's actual request URL names its root, its bytes
    // equal that root's backend bytes, and the decoded pixels differ per root.
    const tiles = await page.evaluate(`(async()=>{const out=[];for(const el of document.querySelectorAll('.infoimg[data-resource]')){const img=el.querySelector('img');
      const bytes=new Uint8Array(await (await fetch(img.currentSrc)).arrayBuffer());const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
      const c=document.createElement('canvas');c.width=16;c.height=16;const x=c.getContext('2d');x.drawImage(img,0,0,16,16);
      const pixels=[...new Uint8Array(await crypto.subtle.digest('SHA-256',x.getImageData(0,0,16,16).data))].map(b=>b.toString(16).padStart(2,'0')).join('');
      out.push({key:el.dataset.resource,src:new URL(img.currentSrc).pathname+new URL(img.currentSrc).search,digest,pixels,resource:performance.getEntriesByName(img.currentSrc).length})}return out})()`);
    const byKey = Object.fromEntries(tiles.map(tile => [tile.key, tile]));
    for (const root of Object.keys(ROOTS)) {
      const tile = byKey[`${root}:${NAME}`];
      check(`details ${root}: native request names the ${root} root and serves its bytes`, !!tile && tile.digest === expected[root] && tile.resource > 0 &&
        (root === 'output' ? !tile.src.includes('kind=') : tile.src.includes(`kind=${root}`)), JSON.stringify(tile));
    }
    check('details: decoded pixels differ across the three roots', new Set(tiles.map(tile => tile.pixels)).size === 3);
    if (evidence) fs.writeFileSync(`${evidence}/details-tiles.json`, JSON.stringify({ expected, tiles }, null, 1));
    await capture('roots-details');

    // Focus: the [temp] metadata link flashes the temp tile only.
    await page.evaluate(`(()=>{const ref=[...document.querySelectorAll('.imgref')].find(el=>el.textContent===${JSON.stringify(`${NAME} [temp]`)});ref.scrollIntoView({block:'center'});})()`);
    await page.evaluate(`[...document.querySelectorAll('.imgref')].find(el=>el.textContent===${JSON.stringify(`${NAME} [temp]`)}).click()`);
    await page.poll(`document.querySelector('.infoimg[data-resource="temp:${NAME}"]').classList.contains('flash')`, 3000);
    const flashed = await page.evaluate(`[...document.querySelectorAll('.infoimg.flash')].map(el=>el.dataset.resource)`);
    check('focus: the temp reference addresses the temp image, not the first same name', JSON.stringify(flashed) === JSON.stringify([`temp:${NAME}`]), JSON.stringify(flashed));
    await capture('roots-focus-temp');

    // Zoom: a ctrl+wheel on the temp image writes the temp key only.
    const box = await page.evaluate(`(()=>{const el=document.querySelector('.infoimg[data-resource="temp:${NAME}"] img');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await page.mouse('mouseWheel', box.x, box.y, { deltaY: -120, modifiers: 2 });
    await page.poll(`(async()=>!!${KZ}.actions.views.get('temp:fake:${NAME}'))()`, 3000);
    const zoom = await page.evaluate(`(async()=>{const s=${KZ};return ['input','output','temp'].map(root=>!!s.actions.views.get(root+':fake:${NAME}'))})()`);
    check('zoom: only the temp resource key changed', JSON.stringify(zoom) === '[false,false,true]', JSON.stringify(zoom));

    // Viewer: opening the temp tile selects the temp resource, and the /diff URL
    // round trip restores that same root on a cold boot.
    await page.clickAt(`.infoimg[data-resource="temp:${NAME}"] img`);
    await page.poll(`(async()=>${KZ}.state.diff.open)()`, 5000);
    await page.poll(`document.querySelector('.dz-b img')?.naturalWidth>0`, 10000).catch(() => {});
    // The shared /diff serializer writes the store's actual pair; the URL
    // protocol itself is unchanged (temp rides the side source codec).
    const opened = await page.evaluate(`(async()=>{const s=${KZ},im=document.querySelector('.dz-b img'),pair=s.state.diffPair();
      const {diffUrl}=await import('/js/route-parse.mjs');return {pair,url:diffUrl(pair.a,pair.b,{subject:'b'}),src:im?new URL(im.src).pathname+new URL(im.src).search:null}})()`);
    check('viewer: the opened B side is the temp resource', opened.src === `/api/collections/fake/entries/${NAME}/bytes?kind=temp` && opened.pair.b?.source === 'temp:fake' && opened.pair.b?.file === NAME, JSON.stringify(opened));
    await capture('roots-viewer-temp');
    await invoke('workbench.close').catch(() => {});
    await page.goto(ENGINE + opened.url);
    const booted = await page.poll(`new URL(document.querySelector('.dz-b img')?.src??'http://x/').search==='?kind=temp'&&document.querySelector('.dz-b img').naturalWidth>0`, 45000).then(() => true, () => false);
    const bootState = await page.evaluate(`(async()=>({href:location.pathname+location.search+location.hash,b:document.querySelector('.dz-b img')?.src??null,open:${KZ}.state.diff.open,pair:${KZ}.state.diffPair(),resolved:${KZ}.actions.diff.resolve(${KZ}.state.diffPair().b),bText:document.querySelector('.dz-b')?.textContent??null,bHtml:(document.querySelector('.dz-b')?.outerHTML??'').slice(0,400),aSrc:document.querySelector('.dz-a img')?.src??null,col:document.getElementById('diffStage')?.dataset.col,fetchStatus:(await fetch('/api/collections/fake/entries/roots-same.png/bytes?kind=temp')).status,entries:performance.getEntriesByType('resource').filter(e=>e.name.includes('roots-same')).map(e=>e.name.slice(-60)+' '+e.responseStatus)}))()`);
    check('viewer: cold /diff URL boot restores the temp root', booted && bootState.pair.b?.source === 'temp:fake', JSON.stringify({ url: opened.url, ...bootState }));
    // A real cold boot: leave the /diff document before loading the legacy URL.
    await page.goto(ENGINE + '/#fake');
    await page.goto(ENGINE + `/diff?subject=b#fake#${GEN}:input%3Afake#${NAME}`);
    const inputBoot = await page.poll(`new URL(document.querySelector('.dz-b img')?.src??'http://x/').search==='?kind=input'&&document.querySelector('.dz-b img').naturalWidth>0`, 45000).then(() => true, () => false);
    const inputState = await page.evaluate(`(async()=>({b:document.querySelector('.dz-b img')?.src??null,pair:${KZ}.state.diffPair()}))()`);
    check('viewer: existing input:<host> URLs keep their meaning', inputBoot && inputState.pair.b?.source === 'input:fake', JSON.stringify(inputState));
    await invoke('workbench.close').catch(() => {});

    // Variations: the temp current compares with temp bytes. The same-named
    // input is a different resource; a foreign File equal to the temp current
    // is "same as current" and never uploads. Run writes only the input name.
    await page.goto(ENGINE + `/#fake#${GEN}`);
    await page.poll(`(async()=>${KZ}.state.images.some(i=>i.filename==='${GEN}'))()`, 20000);
    await invoke('variations.open', { id: `fake:${GEN}` });
    await addParameter(page, '13.image');
    await openImageAdd(page);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    const pick = async (tab, name) => {
      await page.clickAt(`[role=tab][data-value="${tab}"]`);
      await page.poll(`!!document.querySelector('[data-input-name=${JSON.stringify(name)}]')`, 15000);
      await page.clickAt(`.vz-input-option[data-input-name=${JSON.stringify(name)}]`);
    };
    await pick('fake', NAME);
    await pick('another', 'roots-temp-copy.png');
    await page.keyTrusted('Escape', { vk: 27 });
    await page.poll("!document.querySelector('.vz-input-search')");
    await page.poll(`document.querySelectorAll('.vz-image-set .vz-image-tile').length===2&&!document.querySelector('.vz-image-set .vz-image-tile.is-pending')`, 15000).catch(() => {});
    await page.poll(`document.querySelector('.vz-count')?.textContent.trim()==='1'`, 15000).catch(() => {});
    const count = await page.evaluate(`document.querySelector('.vz-count')?.textContent.trim()`);
    check('variations: the temp-equal File is excluded as current; the same-named input remains', count === '1', String(count));
    await capture('roots-variations');
    const before = await (await fetch(FAKE + '/__test/enqueues')).json();
    await page.clickAt('.vz-run');
    await page.poll(`(async()=>(await (await fetch(${JSON.stringify(FAKE + '/__test/enqueues')})).json()).length>${before.length})()`, 15000).catch(() => {});
    const jobs = (await (await fetch(FAKE + '/__test/enqueues')).json()).slice(before.length);
    check('variations: the captured prompt assigns only the input-root name', jobs.length === 1 && jobs[0].prompt['13'].inputs.image === NAME &&
      jobs[0].prompt['11'].inputs.image === NAME && jobs[0].prompt['12'].inputs.image === `${NAME} [output]`, JSON.stringify(jobs.map(job => job.prompt['13'].inputs)));
    if (evidence) fs.writeFileSync(`${evidence}/variations-jobs.json`, JSON.stringify(jobs, null, 1));
    await page.poll(`!document.querySelector('.vz-panel')`, 8000).then(() => check('variations: v2 acknowledgement adopted the Run (auto-close)', true),
      async () => check('variations: v2 acknowledgement adopted the Run (auto-close)', false, await page.evaluate(`document.querySelector('.vz-panel [role=status], .vz-error')?.textContent??''`)));
    assert((await control(FAKE, { remove: [NAME] })).ok);
    for (const method of ['GET', 'HEAD']) for (const type of Object.keys(ROOTS)) {
      const response = await fetch(`${FAKE}/api/view?${new URLSearchParams({ filename: NAME, type })}`, { method });
      assert.equal(response.status, type === 'output' ? 404 : 200, `${method} ${type}: output tombstone is root-local`);
      if (method === 'GET' && type !== 'output') assert.equal(sha(Buffer.from(await response.arrayBuffer())), expected[type]);
      else await response.arrayBuffer();
    }
    check('fake output removal preserves same-named input/temp GET and HEAD bytes', true);
    check('no uncaught page errors', errors.length === 0, errors.join(';'));
  } finally { await page.close(); }
  console.log(`resource-roots: ${checks - failures}/${checks} checks; ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); });
