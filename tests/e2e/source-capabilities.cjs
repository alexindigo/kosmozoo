// Real discovery/stream/DOM contract. All mutations target disposable VM fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const { observeSources } = require('./source-traffic.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18660';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18661';
const KZ = '(await import("/store/instance.js")).appStore';
const directory = workPath('artifacts/source-capabilities');
const card = '.card[data-name="flux-controlnet.png"]';

(async () => {
  fs.mkdirSync(directory, { recursive: true });
  const page = await CDP.launch(9421, { windowSize: '1600,1200' });
  const errors = await collectPageErrors(page), traffic = await observeSources(page), records = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const record = (name, evidence) => { records.push({ name, evidence }); console.log('PASS ' + name + ' ' + JSON.stringify(evidence ?? {})); };
  const capture = async name => {
    await page.poll("[...document.querySelectorAll('.card:not(.card--probe) img[src]')].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).every(img=>img.complete&&img.naturalWidth>0)", 20000);
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${directory}/${name}.png`, Buffer.from(shot.data, 'base64'));
    for (const [region, selector] of [['header', '#chrome'], ['bulk', '#bulkBar'], ['card', '.card:not(.card--probe) .ctitle'], ['editor', '.vz-panel']]) {
      const clip = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();if(!r)return null;
        const x=Math.max(0,r.x),y=Math.max(0,r.y),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
        return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y,scale:2}:null})()`);
      if (clip) {
        const crop = await page.send('Page.captureScreenshot', { format: 'png', clip });
        fs.writeFileSync(`${directory}/${name}-${region}-crop.png`, Buffer.from(crop.data, 'base64'));
      }
    }
  };
  const allRows = `(()=>{const row=s=>document.querySelector(s+' .delete');return [row('.card:not(.card--probe) .btnwrap'),row('#bulkBar'),row('.card--probe .btnwrap')].map(b=>b?.title??null)})()`;
  const mode = async text => {
    await page.poll(`(${allRows}).every(title=>title&&title.includes(${JSON.stringify(text)}))`, 20000);
    const titles = await page.evaluate(allRows); record('three Delete readers: ' + text, titles);
  };
  const http = async (path, method, body) => {
    const response = await fetch(ENGINE + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    assert(response.ok, path + ': ' + response.status); return response.json();
  };
  let primaryFailure;
  try {
    const enabled = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetsPlusDelete: true }) });
    assert(enabled.ok); await enabled.json();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      const original=window.fetch, Native=window.EventSource;
      const probe=window.__capRead={hold:true,inventoryHold:true,failures:1,reads:0,active:0,max:0,streams:0,maxStreams:0,waiters:[],inventoryWaiters:[]};
      window.__capPage=crypto.randomUUID();
      window.EventSource=class extends Native {constructor(...args){super(...args);this.retired=false;probe.streams++;probe.maxStreams=Math.max(probe.maxStreams,probe.streams)}
        close(){if(!this.retired){this.retired=true;probe.streams--}return super.close()}};
      const wait=(array,signal)=>new Promise((resolve,reject)=>{
        const aborted=()=>reject(new DOMException('Retired','AbortError'));if(signal?.aborted)return aborted();
        signal?.addEventListener('abort',aborted,{once:true});array.push(()=>{signal?.removeEventListener('abort',aborted);resolve()});});
      probe.release=()=>{probe.hold=false;probe.waiters.splice(0).forEach(resolve=>resolve())};
      probe.releaseInventory=()=>{probe.inventoryHold=false;probe.inventoryWaiters.splice(0).forEach(resolve=>resolve())};
      window.fetch=async(url,options)=>{
        const u=new URL(typeof url==='string'?url:url.url,location.href);
        if(u.pathname==='/api/collections'&&(!options?.method||options.method==='GET')){
          probe.reads++;probe.active++;probe.max=Math.max(probe.max,probe.active);
          try{if(probe.failures-->0)return new Response(JSON.stringify({error:'controlled discovery failure'}),{status:503});
            const response=await original(url,options);if(probe.hold)await wait(probe.waiters,options?.signal);return response;
          }finally{probe.active--}
        }
        const response=await original(url,options);
        if(u.pathname.endsWith('/entries')&&u.searchParams.get('inventory')==='1'&&probe.inventoryHold)await wait(probe.inventoryWaiters,options?.signal);
        return response;
      };
    })()` });
    await page.goto(ENGINE + '/#fake#flux-controlnet.png');
    await page.poll(`(async()=>!!${KZ}.state.hosts.fake&&${KZ}.state.inventory.loading)()`);
    assert.equal(await page.evaluate('!!document.querySelector("#outputFolder")'), false);
    record('pending unknown subfolders omit FolderPicker');
    await page.evaluate('__capRead.releaseInventory()');
    await page.poll(`!!document.querySelector('${card} .bookmark')&&!!document.querySelector('#outputFolder')`, 25000);
    await invoke('selection.set', { id: 'fake:flux-controlnet.png', value: true });
    assert.deepEqual(await page.evaluate(allRows), [null, null, null]);
    await capture('unknown'); record('unknown capability omits Card, BulkBar and probe Delete; accepted inventory restores folders');
    await page.poll('__capRead.waiters.length>0', 10000); await page.evaluate('__capRead.release()');
    await mode('trash'); await capture('recovered-trash');
    assert.equal(await page.evaluate('__capRead.reads'), 2);

    // Discovery-only refresh/policy settlement must leave real user/editor state intact.
    await page.evaluate(`(async()=>{const s=${KZ},{api}=await import('/js/api.mjs');
      window.__capOriginalJudgment=api.setJudgment;api.setJudgment=(...args)=>new Promise(resolve=>window.__capReleaseJudgment=()=>resolve(window.__capOriginalJudgment(...args)));
      s.handles.invoke('entry.select',{source:'fake',file:'flux-basic.png'});s.handles.invoke('entry.select',{source:'fake',file:'flux-controlnet.png'});
      s.actions.views.set('fake:flux-controlnet.png',{version:2,s:2,cx:.5,cy:.5,fh:1,fv:1,rot:0},{persist:false});
      s.actions.ui.setFilter('flux-');window.__capCard=document.querySelector('${card}');window.__capNote=window.__capCard.querySelector('textarea.pos');})()`);
    await page.clickAt(card + ' textarea.pos'); await page.send('Input.insertText', { text: 'capability-retained note' });
    await page.poll('!!window.__capReleaseJudgment', 10000);
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await page.poll("!!document.querySelector('.vz-prefix')&&!!document.querySelector('.vz-image-set')", 20000);
    if (!await page.evaluate("document.querySelector('.vz-image-set .checkbox').checked")) await page.clickAt('.vz-image-set .checkbox');
    await page.poll("!!document.querySelector('.vz-imgfilespick')");
    await page.evaluate(`(async()=>{const input=document.querySelector('.vz-imgfilespick'),dt=new DataTransfer();
      const bytes=await (await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes')).arrayBuffer();
      dt.items.add(new File([bytes],'retained-native.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
      window.__capInput=input;window.__capFile=input.files[0];window.__capPanel=document.querySelector('.vz-panel');
      const s=${KZ};await s.handles.invoke('anchor.add',{files:[new File([bytes],'retained-anchor.png',{type:'image/png'})]});
      window.__capAnchor=s.state.anchors[0];window.__capAnchorSrc=window.__capAnchor.src;})()`);
    await page.clickAt('.vz-prefix'); await page.send('Input.insertText', { text: 'retained_' });
    await page.poll("document.querySelector('.vz-prefix').value==='retained_'");
    const retained = `(async()=>{const s=${KZ};return {current:s.state.current(),trail:s.state.currentStack(),url:location.href,
      folder:s.state.selectedFolder(),filter:s.state.feedFilter(),selected:JSON.parse(JSON.stringify(s.state.selected)),
      views:JSON.parse(JSON.stringify(s.state.views)),anchors:s.state.anchors.map(a=>({name:a.name,same:a===window.__capAnchor,sourceSame:a.src===window.__capAnchorSrc})),
      note:document.querySelector('${card} textarea.pos')?.value,draft:JSON.parse(JSON.stringify(s.state.drafts)),
      prefix:document.querySelector('.vz-prefix')?.value,session:document.querySelector('.vz-panel')?.dataset.session,
      card:document.querySelector('${card}')===window.__capCard,noteNode:document.querySelector('${card} textarea.pos')===window.__capNote,
      panel:document.querySelector('.vz-panel')===window.__capPanel,fileInput:document.querySelector('.vz-imgfilespick')===window.__capInput,
      nativeFile:window.__capInput.files[0]===window.__capFile};})()`;
    const before = await page.evaluate(retained);
    assert(before.card && before.noteNode && before.panel && before.fileInput && before.nativeFile);
    assert(before.trail.length > 0 && before.anchors.length > 0 && before.anchors[0].same && before.anchors[0].sourceSame);
    await page.evaluate(`(async()=>{__capRead.hold=true;window.__capPolicy=${KZ}.actions.menu.deleteAssetsPlus(false);return true})()`);
    await page.poll('__capRead.waiters.length>0');
    assert.deepEqual(await page.evaluate(retained), before);
    await page.evaluate('__capRead.release()'); await page.evaluate('__capPolicy');
    assert.deepEqual(await page.evaluate(retained), before); await capture('retained-editor');
    record('discovery-only settlement retains card/note/editor/native File, drafts, selection, current/trail/URL, folder/filter, zoom and anchors', before);
    await page.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    await page.poll("!!document.querySelector('.vz-discard')"); await page.clickAt('.vz-discard-confirm');
    await page.poll("!document.querySelector('.vz-panel')");
    await page.evaluate(`(async()=>{const {api}=await import('/js/api.mjs');window.__capReleaseJudgment();api.setJudgment=window.__capOriginalJudgment})()`);
    await mode('hide'); await capture('known-hide');

    await invoke('source.select', { id: 'fixture-dir' });
    await page.poll("!!document.querySelector('.card .bookmark')");
    await invoke('selection.set', { id: 'fixture-dir:flux-basic.png', value: true });
    await mode('permanent'); assert.equal(await page.evaluate('!!document.querySelector("#outputFolder")'), false);
    await page.clickAt('.card:not(.card--probe) .delete'); await page.poll("!!document.querySelector('.confirm-ok')");
    assert.equal(await page.evaluate("document.querySelector('.confirm-ok').textContent"), 'Delete forever');
    await page.clickAt('.confirm-cancel'); await capture('known-unlink');

    await invoke('source.select', { id: 'fake' });
    await page.evaluate(`(async()=>await ${KZ}.actions.menu.deleteAssetsPlus(true))()`);
    await invoke('selection.set', { id: 'fake:flux-controlnet.png', value: true }); await mode('trash');
    const focused = await page.evaluate(`(async()=>${KZ}.state.host())()`);
    await http('/api/collections', 'POST', { name: 'cap-added', address: new URL(FAKE).host });
    await page.poll(`(async()=>${KZ}.state.hosts['cap-added']?.capabilities?.delete==='trash')()`);
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.host())()`), focused);
    const old = await page.evaluate(`(async()=>${KZ}.state.hosts['cap-added'].incarnation)()`);
    await http('/api/collections/cap-added', 'DELETE');
    await page.poll(`(async()=>!${KZ}.state.hosts['cap-added'])()`);
    await http('/api/collections', 'POST', { name: 'cap-added', address: new URL(FAKE).host });
    await page.poll(`(async()=>${KZ}.state.hosts['cap-added']?.incarnation!==${JSON.stringify(old)}&&${KZ}.state.hosts['cap-added']?.capabilities?.delete==='trash')()`);
    await http('/api/collections/cap-added', 'DELETE'); record('stream-only addition/removal/readd autonomously discovers current identity without stealing selection');

    // The external VM harness gracefully restarts this same disposable engine.
    const epoch = await page.evaluate(`(async()=>${KZ}.state.hosts.fake.sourceVersion.epoch)()`), pageToken = await page.evaluate('__capPage');
    await page.evaluate('__capRead.hold=true'); fs.writeFileSync(workPath(process.env.CAP_RESTART_REQUEST), 'restart');
    await page.poll(`(async()=>${KZ}.state.hosts.fake.sourceVersion.epoch!==${JSON.stringify(epoch)}&&${KZ}.state.hosts.fake.capabilities===null)()`, 30000);
    await page.poll(`!!document.querySelector('${card} .bookmark')`, 25000);
    // Source retirement retains existing selection-clearing semantics. Re-select
    // only for observing the bulk reader, never to trigger capability discovery.
    await invoke('selection.set', { id: 'fake:flux-controlnet.png', value: true });
    assert.deepEqual(await page.evaluate(allRows), [null, null, null]);
    await page.poll('__capRead.waiters.length>0'); await page.evaluate('__capRead.release()');
    await mode('trash'); assert.equal(await page.evaluate('__capPage'), pageToken);
    await page.poll('!!document.querySelector("#outputFolder")'); await capture('restart-recovered');
    record('real same-tab engine restart recovers three readers and folders without refresh or page reload', { oldEpoch: epoch, pageToken });
    await sleep(1200);
    const counters = await page.evaluate('({reads:__capRead.reads,maxDiscovery:__capRead.max,activeStreams:__capRead.streams,maxStreams:__capRead.maxStreams})');
    assert.equal(counters.maxDiscovery, 1); assert.equal(counters.activeStreams, 1); assert.equal(counters.maxStreams, 1); assert(counters.reads <= 12, JSON.stringify(counters));
    await traffic.validate(); assert.equal(traffic.activity().length, 0); record('bounded discovery and one active source stream', counters);
    assert.deepEqual(errors, []);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let cleanupFailure;
    try {
      console.log('FINAL CONSUMER', JSON.stringify(await page.evaluate(`(async()=>({rows:${allRows},host:${KZ}.state.host(),capabilities:${KZ}.state.currentCollection()?.capabilities,counters:{reads:__capRead.reads,active:__capRead.active,max:__capRead.max}}))()`)));
    } catch (probeError) {
      console.error('final consumer probe failed:', probeError);
    }
    try {
      fs.writeFileSync(`${directory}/results.json`, JSON.stringify({ records, errors, requests: traffic.requests, responses: traffic.responses, frames: traffic.frames }, null, 2));
    } catch (writeError) {
      cleanupFailure = writeError;
      console.error('consumer evidence write failed:', writeError);
    } finally {
      try { await page.close(); }
      catch (closeError) {
        cleanupFailure ??= closeError;
        console.error('consumer browser close failed:', closeError);
      }
    }
    if (!primaryFailure && cleanupFailure) throw cleanupFailure;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
