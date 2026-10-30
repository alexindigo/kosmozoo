// Focused real-browser runner: --image-set runs only the existing image-set
// contract; the default measures cold, delayed input thumbnails while scrolling.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');

const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const KZ = `(await import('/store/instance.js')).appStore`;

async function preload(cdp, check) {
  const image = fs.readFileSync(workPath('tests/fixtures/flux-lora.png'));
  for (let i = 0; i < 300; i++) {
    const form = new FormData();
    form.append('image', new Blob([image]), `preload-${String(i).padStart(3, '0')}.png`);
    assert((await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form })).ok);
  }
  assert((await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ delays: { inputBytes: 150 } }) })).ok);
  await cdp.evaluate(`(async()=>${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'}))()`);
  await cdp.poll("!!document.querySelector('.vz-input-trigger')");
  const active = new Map(), requests = [];
  let maxImages = 0, maxBackground = 0, metadata = null, metadataWhileImages = false;
  const original = cdp.ws.onmessage;
  cdp.ws.onmessage = event => {
    original(event);
    const { method, params: p } = JSON.parse(event.data);
    if (method === 'Network.requestWillBeSent' && p.type === 'Image' && new URL(p.request.url).origin === ENGINE) {
      active.set(p.requestId, p.request.url);
      requests.push(p.request.url);
      maxImages = Math.max(maxImages, active.size);
      maxBackground = Math.max(maxBackground, [...active.values()].filter(url => new URL(url).searchParams.get('priority') === 'background').length);
      if (!metadata && active.size === 4) metadata = cdp.evaluate(`(async()=>{const start=performance.now();const response=await fetch('/api/collections/fake/meta');return{status:response.status,ms:performance.now()-start}})()`)
        .then(result => { metadataWhileImages = active.size > 0; return result; });
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') active.delete(p.requestId);
  };
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  try {
    await cdp.clickAt('.vz-input-trigger');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length>0");
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)", 15000);
    await cdp.send('Input.insertText', { text: 'preload-' });
    await cdp.poll("document.querySelector('.vz-input-option')?.dataset.inputName==='preload-000.png'");
    // Let initial visible + ahead demand settle, just as a user inspecting the
    // first screen would. The scroll itself never waits for a tile to load.
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)", 15000);
    await sleep(1000);
    const result = await cdp.evaluate(`(async()=>{
      const list=document.querySelector('.vz-input-list'), seen=new Set(), entering=[], empty=new Set();
      let maxRows=0,maxTiles=0;
      const sample=()=>{
        const viewport=list.getBoundingClientRect();
        maxRows=Math.max(maxRows,list.querySelectorAll('.vz-input-row').length);
        maxTiles=Math.max(maxTiles,list.querySelectorAll('img').length);
        for(const tile of list.querySelectorAll('.vz-input-option')){
          const rect=tile.getBoundingClientRect();
          if(rect.bottom<=viewport.top||rect.top>=viewport.bottom)continue;
          const name=tile.dataset.inputName,img=tile.querySelector('img');
          if(!seen.has(name)){
            seen.add(name);entering.push({name,at:performance.now(),loaded:img.complete&&img.naturalWidth>0});
            if(!img.complete||!img.naturalWidth)empty.add(name);
          }
        }
      };
      sample();entering.length=0;empty.clear();
      const start=performance.now(),distance=list.clientHeight;
      await new Promise(resolve=>{
        const frame=now=>{const progress=Math.min(1,(now-start)/1200);list.scrollTop=distance*progress;sample();
          if(progress<1)requestAnimationFrame(frame);else requestAnimationFrame(()=>{sample();resolve()});};
        requestAnimationFrame(frame);
      });
      await new Promise(resolve=>setTimeout(resolve,500));
      const resources=performance.getEntriesByType('resource');
      return {height:list.clientHeight,entering,emptyTiles:empty.size,maxRows,maxTiles,
        lateStarts:entering.filter(tile=>!resources.some(r=>r.name.includes('/'+tile.name+'/bytes')&&r.startTime<tile.at)).map(tile=>tile.name)};
    })()`);
    assert(result.entering.length >= 6, JSON.stringify(result));
    assert(maxImages <= 4, `app-origin images peaked at ${maxImages}`);
    assert(maxBackground <= 2, `background images peaked at ${maxBackground}`);
    assert.equal((await metadata).status, 200);
    assert((await metadata).ms < 150 && metadataWhileImages, 'metadata completes before delayed images, using reserved capacity');
    console.log('PRELOAD_MEASUREMENT ' + JSON.stringify({ ...result, maxImages, maxBackground, metadata: await metadata,
      backgroundRequests: requests.filter(url => new URL(url).searchParams.get('priority') === 'background').length }));
    if (!process.env.E2E_PRELOAD_BASELINE) {
      assert.equal(result.emptyTiles, 0, 'entering tiles are already loaded at a steady one-viewport scroll');
      assert.deepEqual(result.lateStarts, [], 'every entering tile starts before visibility');
      assert(result.maxRows <= 12 && result.maxTiles <= 36, 'mounted rows plus one preloaded viewport stay small');
      assert(maxBackground > 0, 'further-ahead demand uses the background lane');
      assert(await cdp.evaluate("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.decoding==='async')"));
    }
    // Retiring the search and closing must not leave old queued demand draining.
    await cdp.evaluate("(()=>{const input=document.querySelector('.vz-input-search');input.value='preload-299';input.dispatchEvent(new Event('input',{bubbles:true}))})()");
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===1");
    await cdp.keyTrusted('Escape', { vk: 27 });
    await cdp.poll("!document.querySelector('.vz-input-popover')");
    await sleep(350);
    const retired = requests.length;
    await sleep(400);
    assert.equal(requests.length, retired, 'search/close retire queued image demand');
    check('input preload: steady scroll, bounded foreground/background transfers, reserved metadata and demand retirement', true);
  } finally {
    cdp.ws.onmessage = original;
    await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ delays: {} }) });
  }
}

(async () => {
  const cdp = await CDP.launch(9336);
  const errors = await collectPageErrors(cdp);
  let checks = 0;
  const check = (name, ok) => { assert(ok, name); checks++; console.log('ok ' + name); };
  try {
    await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
    await cdp.poll("!!document.querySelector('.card')", 20000);
    if (process.argv.includes('--image-set')) await require('./variations-image-set.cjs')({ cdp, FAKE, KZ, check });
    else await preload(cdp, check);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${checks} focused browser checks; no page errors`);
  } finally { await cdp.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
