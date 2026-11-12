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
  for (let i = 0; i < 450; i++) {
    const form = new FormData();
    form.append('image', new Blob([image]), `preload-${String(i).padStart(3, '0')}.png`);
    const seeded = await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form });
    assert(seeded.ok || seeded.status === 409, 'seed input exists on the shared fake');
  }
  assert((await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ delays: { inputBytes: 150 } }) })).ok);
  await cdp.evaluate(`(async()=>${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'}))()`);
  await require('./variation-add-helpers.cjs').addParameter(cdp, '43.image');
  await require('./image-picker-helpers.cjs').openImageAdd(cdp);
  await cdp.poll("!!document.querySelector('.vz-input-trigger')");
  const active = new Map(), requests = [], nativeRequests = new Map(), wire = new Map();
  let maxImages = 0, maxBackground = 0, maxPending = 0, metadata = null, metadataWhileImages = false;
  const measureWire = id => {
    const request = nativeRequests.get(id), sent = wire.get(id);
    if (!request || !sent || request.ended || sent.ended) return;
    active.set(id, request.url);
    maxImages = Math.max(maxImages, active.size);
    maxBackground = Math.max(maxBackground, [...active.values()].filter(url => new URL(url).searchParams.get('priority') === 'background').length);
    if (!metadata && active.size === 4) metadata = cdp.evaluate(`(async()=>{const start=performance.now();const response=await fetch('/api/collections/fake/meta');return{status:response.status,ms:performance.now()-start}})()`)
      .then(result => { metadataWhileImages = active.size > 0; return result; });
  };
  const original = cdp.ws.onmessage;
  cdp.ws.onmessage = event => {
    original(event);
    const { method, params: p } = JSON.parse(event.data);
    if (method === 'Network.requestWillBeSent' && p.type === 'Image' && new URL(p.request.url).origin === ENGINE) {
      nativeRequests.set(p.requestId, {url:p.request.url,ended:false});
      requests.push(p.request.url);
      maxPending = Math.max(maxPending, [...nativeRequests.values()].filter(r=>!r.ended).length);
      measureWire(p.requestId);
    }
    // requestWillBeSent also includes requests queued inside Chromium. After
    // native retirement, their notifications can precede old ERR_ABORTED events.
    // ExtraInfo marks headers actually sent; tolerate either event order.
    if (method === 'Network.requestWillBeSentExtraInfo') { wire.set(p.requestId, {...wire.get(p.requestId),sent:true}); measureWire(p.requestId); }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      if(nativeRequests.has(p.requestId))nativeRequests.get(p.requestId).ended=true;
      wire.set(p.requestId,{...wire.get(p.requestId),ended:true}); active.delete(p.requestId);
    }
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
    const slowBand = await cdp.evaluate(`(()=>{
      const list=document.querySelector('.vz-input-list'),box=list.getBoundingClientRect();
      const tiles=[...list.querySelectorAll('.vz-input-option')];
      return {above:tiles.filter(t=>t.getBoundingClientRect().bottom<=box.top).length,below:tiles.filter(t=>t.getBoundingClientRect().top>=box.bottom).length};
    })()`);
    console.log('SLOW_LOOKAHEAD '+JSON.stringify(slowBand));
    if (!process.env.E2E_PRELOAD_BASELINE) {
      assert(slowBand.above<=15 && slowBand.below===15, 'slow scrolling retains only the base band');
      assert.equal(result.emptyTiles, 0, 'entering tiles are already loaded at a steady one-viewport scroll');
      assert.deepEqual(result.lateStarts, [], 'every entering tile starts before visibility');
      assert(result.maxRows <= 16 && result.maxTiles <= 48, 'visible rows plus symmetric lookahead stay bounded');
      assert(maxBackground > 0, 'lookahead demand uses the background lane');
      assert(await cdp.evaluate("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.decoding==='async')"));
    }
    // Start cold in the middle so neither side can borrow decoded first-screen
    // thumbnails. Assert all 15 immediate neighbours, not just mounted count.
    await cdp.evaluate("document.querySelector('.vz-input-list').scrollTop=40*102");
    await sleep(250);
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)", 15000);
    const band = await cdp.evaluate(`(()=>{
      const list=document.querySelector('.vz-input-list'),box=list.getBoundingClientRect();
      const visible=[...list.querySelectorAll('.vz-input-option')].filter(tile=>{const r=tile.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom});
      const indices=visible.map(tile=>Number(tile.dataset.inputName.match(/preload-(\\d+)/)[1]));
      const ready=index=>{const img=list.querySelector('[data-input-name="preload-'+String(index).padStart(3,'0')+'.png"] img');return !!img?.complete&&img.naturalWidth>0};
      return {first:Math.min(...indices),last:Math.max(...indices),above:Array.from({length:15},(_,i)=>ready(Math.min(...indices)-i-1)),below:Array.from({length:15},(_,i)=>ready(Math.max(...indices)+i+1))};
    })()`);
    console.log('LOOKAHEAD_BAND '+JSON.stringify(band));
    if (!process.env.E2E_PRELOAD_BASELINE) {
      assert(band.above.every(Boolean), '15 tiles above the middle viewport are decoded');
      assert(band.below.every(Boolean), '15 tiles below the middle viewport are decoded');
    }
    const steps=[];
    for(const direction of [1,-1]) {
      const step=await cdp.evaluate(`(async()=>{
        const list=document.querySelector('.vz-input-list');
        const visible=()=>{const box=list.getBoundingClientRect();return [...list.querySelectorAll('.vz-input-option')].filter(tile=>{const r=tile.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom})};
        const before=new Set(visible().map(tile=>tile.dataset.inputName));
        const retained=new Set(list.querySelectorAll('img')),changes=[];
        const observer=new MutationObserver(records=>changes.push(...records));
        observer.observe(list,{subtree:true,attributes:true,attributeFilter:['src'],attributeOldValue:true});
        list.scrollTop+=${direction}*list.clientHeight;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const entering=visible().filter(tile=>!before.has(tile.dataset.inputName));
        observer.disconnect();
        return {direction:${direction},newlyVisible:entering.length,decoded:entering.filter(tile=>{const img=tile.querySelector('img');return img.complete&&img.naturalWidth>0}).length,
          retainedSrcChanges:changes.filter(change=>retained.has(change.target)&&change.target.isConnected&&change.oldValue!=null).length};
      })()`);
      steps.push(step);
      if (!process.env.E2E_PRELOAD_BASELINE) {
        assert(step.newlyVisible>0 && step.decoded===step.newlyVisible, JSON.stringify(step));
        assert.equal(step.retainedSrcChanges,0,'visibility changes never retire retained native sources');
      }
      await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)", 15000);
    }
    if (!process.env.E2E_PRELOAD_BASELINE) {
      assert(maxImages<=4 && maxBackground<=2, 'both-direction lookahead respects transport and background ceilings');
    }
    console.log('LOOKAHEAD_STEPS '+JSON.stringify({steps,maxImages,maxBackground}));
    // Cold territory, then a touchpad-like kinetic fling. Wheel deltas decay
    // exponentially for 700ms from four viewport heights per second.
    await cdp.evaluate("document.querySelector('.vz-input-list').scrollTop=75*102");
    await sleep(350);
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)",15000);
    const fastRequestStart = requests.length;
    const wheel = await cdp.evaluate(`(()=>{const list=document.querySelector('.vz-input-list'),box=list.getBoundingClientRect();return{x:box.x+box.width/2,y:box.y+box.height/2,height:list.clientHeight}})()`);
    const wheelStart = performance.now(), tau = 220;
    let previous = 0;
    while (previous < 700) {
      const elapsed = Math.min(700, performance.now() - wheelStart);
      const deltaY = wheel.height * 4 * tau / 1000 * (Math.exp(-previous/tau)-Math.exp(-elapsed/tau));
      if(deltaY>0)await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:wheel.x,y:wheel.y,deltaX:0,deltaY});
      previous=elapsed;
      if(previous<700)await sleep(16);
    }
    const sampleLanding = `(async()=>{
      await new Promise(requestAnimationFrame);
      const list=document.querySelector('.vz-input-list');
      const box=list.getBoundingClientRect(),tiles=[...list.querySelectorAll('.vz-input-option')].filter(t=>{const r=t.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom});
      const decoded=tiles.filter(t=>{const img=t.querySelector('img');return img.complete&&img.naturalWidth>0}).length;
      return {visible:tiles.length,decoded,fraction:decoded/tiles.length,at:performance.now(),scrollTop:list.scrollTop,first:tiles[0]?.dataset.inputName,last:tiles.at(-1)?.dataset.inputName};
    })()`;
    const atStop = await cdp.evaluate(sampleLanding);
    await sleep(300);
    const fast = {...await cdp.evaluate(sampleLanding),atStop};
    const latency = await cdp.evaluate(`(()=>{const samples=performance.getEntriesByType('resource').filter(r=>r.name.includes('/preload-')&&r.name.includes('/bytes')&&r.duration>=100).map(r=>r.duration).sort((a,b)=>a-b);return{count:samples.length,median:samples[Math.floor(samples.length/2)]??null,min:samples[0]??null}})()`);
    const bound = latency.median == null ? null : fast.visible * latency.median / 4;
    console.log('FAST_LOOKAHEAD '+JSON.stringify({...fast,maxImages,maxBackground,maxPending,latency,fourTransferBoundMs:bound,
      minimumFourTransferBoundMs:latency.min==null?null:fast.visible*latency.min/4,
      requests:requests.slice(fastRequestStart).map(url=>decodeURIComponent(new URL(url).pathname).split('/').at(-2))}));
    if(process.env.E2E_MOMENTUM_RESULT)fs.writeFileSync(process.env.E2E_MOMENTUM_RESULT,JSON.stringify({atStop,after:fast,latency,bound,maxImages,maxBackground}));
    assert(maxImages<=4 && maxBackground<=2, 'velocity lookahead preserves native/background ceilings');
    if(process.env.E2E_PICKER_SCREENSHOT) {
      await cdp.evaluate("document.querySelector('.vz-input-list').scrollTop+=document.querySelector('.vz-input-list').clientHeight");
      await sleep(100);
      const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(process.env.E2E_PICKER_SCREENSHOT,Buffer.from(shot.data,'base64'));
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
    console.log('DEMAND_RETIREMENT '+JSON.stringify({requests:retired,settled:true}));
    // Preserve the target even if the fixture's measured service bound exceeds
    // it; check retirement first so a missed deadline does not hide that gate.
    const baseline = process.env.E2E_MOMENTUM_BASE ? JSON.parse(fs.readFileSync(process.env.E2E_MOMENTUM_BASE)) : null;
    const improvement = baseline && baseline.atStop.fraction<1 && atStop.fraction>=baseline.atStop.fraction*3 && atStop.fraction>baseline.atStop.fraction;
    assert(fast.fraction>=.9 || improvement, 'momentum landing: at least 90% decoded at +300ms or 3x the baseline fraction at stop');
    check('input preload: steady scroll, bounded foreground/background transfers, reserved metadata and demand retirement', true);
  } finally {
    cdp.ws.onmessage = original;
    await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ delays: {} }) });
  }
}

(async () => {
  const cdp = await CDP.launch(9336, { windowSize: '1280,900' });
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
