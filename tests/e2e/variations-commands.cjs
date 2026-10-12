// End-of-chain outcomes inside the existing cold variations suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const fileControl = '.vz-imgrow:not(.vz-enumrow):not(.vz-textrow) .vz-cb';
const fileSetup = async (cdp) => {
  await cdp.poll(`!!document.querySelector(${JSON.stringify(fileControl)})`);
  await cdp.clickAt(fileControl);
  await cdp.evaluate(`(()=>{const e=document.querySelector('.vz-imgmode');e.value='files';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await cdp.poll(`!!document.querySelector('.vz-imgfilespick')`);
  await cdp.evaluate(`(()=>{const e=document.querySelector('.vz-imgfilespick'),dt=new DataTransfer();dt.items.add(new File(['a'],'a.png',{type:'image/png'}));dt.items.add(new File(['b'],'b.png',{type:'image/png'}));e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));window.__fileInput=e;window.__files=[...e.files]})()`);
};

async function verifyFileReadiness({ cdp, KZ, check }) {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  for (const [name, args] of [
    ['single', { id: 'fake:flux-controlnet.png' }],
    ['mixed batch', { ids: ['fake:flux-controlnet.png', 'another:flux-controlnet.png'], bulk: true }],
    ['reopened single', { id: 'fake:flux-controlnet.png' }],
  ]) {
    let task, state = 'not started', setupError;
    await cdp.evaluate(`(()=>{
      window.__fileReadyFetch=window.fetch;window.__fileReadyRelease=null;window.__fileReadyResponse=null;window.__fileReadyEffects=[];
      window.fetch=async(url,options)=>{
        if(options?.body instanceof FormData || String(url).includes('/features/variations/run'))window.__fileReadyEffects.push(String(url));
        const response=await window.__fileReadyFetch(url,options);
        if(!String(url).includes('/entries?kind=input'))return response;
        window.__fileReadyResponse={status:response.status,body:await response.clone().json(),origin:JSON.parse(options.headers['X-Kosmozoo-Origin'])};
        return new Promise(resolve=>window.__fileReadyRelease=()=>resolve(response));
      };
    })()`);
    try {
      await invoke('variations.open', args);
      await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0 && typeof window.__fileReadyRelease==='function'`);
      const response = await cdp.evaluate('window.__fileReadyResponse');
      assert.equal(response.status, 200); assert.deepEqual(response.body.origin, response.origin); assert(response.body.files.length > 0);
      state = 'pending';
      task = fileSetup(cdp).then(() => { state = 'complete'; }, error => { state = 'rejected'; setupError = error; });
      assert.equal(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(fileControl)})`), false);
      assert.equal(state, 'pending', 'File setup must remain pending until its image control mounts');
      await cdp.evaluate('window.__fileReadyRelease()');
      await task; if (setupError) throw setupError;
      assert.equal(state, 'complete');
      assert(await cdp.evaluate(`document.querySelector('.vz-imgfilespick')===window.__fileInput && [...window.__fileInput.files].every((file,index)=>file===window.__files[index])`));
      if (name === 'mixed batch') {
        assert.equal((await invoke('variations.run')).status, 'invalid');
        assert(await cdp.evaluate(`document.querySelector('.vz-error').textContent.includes('different backends')`));
        assert(await cdp.evaluate(`document.querySelector('.vz-imgfilespick')===window.__fileInput && [...window.__fileInput.files].every((file,index)=>file===window.__files[index])`));
      }
      assert.deepEqual(await cdp.evaluate('window.__fileReadyEffects'), []);
      check(`File setup owns delayed input readiness: ${name}, matched response, exact Files and no effects`, true);
    } finally {
      await cdp.evaluate('window.__fileReadyRelease?.();window.fetch=window.__fileReadyFetch');
      await task;
      if (await cdp.evaluate(`!!document.querySelector('.vz-panel')`)) {
        await cdp.evaluate(`(async()=>{window.__fileReadyLeave=${KZ}.handles.invoke('variations.close');return true})()`);
        if (await cdp.evaluate(`!!document.querySelector('.vz-discard')`)) await cdp.clickAt('.vz-discard-confirm');
        await cdp.poll(`!document.querySelector('.vz-panel')`);
      }
    }
  }
}

module.exports = async ({ cdp, check, FAKE, KZ }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const open = async (file = 'flux-basic.png') => {
    await invoke('variations.open', { id: `fake:${file}` });
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0`);
  };
  const requestClose = () => cdp.evaluate(`(async()=>{window.__leave=${KZ}.handles.invoke('variations.close');return true})()`);
  const discard = async () => {
    await requestClose();
    if (await cdp.evaluate(`!!document.querySelector('.vz-discard')`)) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll(`!document.querySelector('.vz-root')`);
  };
  const type = async (selector, text) => {
    await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const state = () => cdp.evaluate(`(()=>{const p=document.querySelector('.vz-panel');return {session:p?.dataset.session,url:location.href,
    values:[...p.querySelectorAll('input:not([type=file]),textarea,select')].map(e=>[e.value,e.checked]),labels:[...p.querySelectorAll('.vz-bound')].map(e=>e.textContent)}})()`);
  const shot = async (name) => {
    fs.mkdirSync(workPath('tests/e2e/.shots'),{recursive:true});
    const image=await cdp.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(workPath(`tests/e2e/.shots/command-variations-${name}.png`),Buffer.from(image.data,'base64'));
  };
  const test = async (name, run) => {
    try { await run(); check(name, true); }
    catch (error) { check(name, false, error.stack ?? String(error)); throw error; }
  };

  await test('File setup readiness follows the input catalogue across single, batch and reopened modals',
    () => verifyFileReadiness({ cdp, KZ, check }));

  await test('owned decision: raw incomplete increment, DOM/widget identity, caret, Tab and Escape', async () => {
    await open();
    const selector = '.vz-slider-row[data-param-key$="denoise"] .vz-row-inc-input';
    await type(selector, '1e');
    await cdp.evaluate(`(()=>{window.__panel=document.querySelector('.vz-panel');window.__increment=document.querySelector('${selector}');window.__widget=document.querySelector('.vz-slider');window.__increment.setSelectionRange(1,2);window.__increment.dispatchEvent(new Event('select'))})()`);
    const before = await state();
    await shot('before');
    await cdp.clickAt('.vz-close');
    await cdp.poll(`!!document.querySelector('.vz-discard')`);
    assert.deepEqual(await cdp.evaluate(`({focused:document.activeElement?.className,inert:document.querySelector('.vz-editor').inert,
      attribute:document.querySelector('.vz-editor').getAttribute('inert'),contained:document.querySelector('.vz-panel').contains(document.querySelector('.vz-discard'))})`),
      { focused:'vz-keep', inert:true, attribute:'', contained:true });
    await shot('decision');
    await cdp.keyTrusted('Tab', { vk: 9 });
    assert(await cdp.evaluate(`document.activeElement===document.querySelector('.vz-discard-confirm')`));
    await cdp.keyTrusted('Tab', { vk: 9 });
    assert(await cdp.evaluate(`document.activeElement===document.querySelector('.vz-keep')`));
    await cdp.keyTrusted('Escape', { vk: 27 });
    await cdp.poll(`!document.querySelector('.vz-discard')`);
    assert.deepEqual(await state(), before);
    assert(await cdp.evaluate(`document.querySelector('.vz-panel')===window.__panel && document.querySelector('${selector}')===window.__increment && document.querySelector('.vz-slider')===window.__widget && document.activeElement===window.__increment && window.__increment.selectionStart===1 && window.__increment.selectionEnd===2`));
    await shot('cancel');
    assert.equal((await invoke('variations.run')).status, 'invalid');
    assert.equal(await cdp.evaluate(`document.querySelector('${selector}').value`), '1e');
    await discard();
    await shot('discard');
  });

  await test('replacement: one Promise, captured destination, busy conflicting request and fresh scalar mount', async () => {
    await open();
    await type('.vz-prefix', 'edited');
    const original = await state();
    const requested = await cdp.evaluate(`(async()=>{const kz=${KZ};kz.handles.invoke('selection.clear');kz.handles.invoke('selection.set',{id:'fake:flux-lora.png',value:true});
      window.__replace=kz.handles.invoke('variations.open',{target:'selected',bulk:true});
      window.__same=kz.handles.invoke('variations.open',{target:'selected',bulk:true});
      const same=window.__replace===window.__same;
      const busy=await kz.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'});
      const run=await kz.handles.invoke('variations.run');kz.handles.invoke('selection.clear');return {same,busy,run}})()`);
    assert.equal(requested.same, true);
    assert.equal(requested.busy.status, 'busy');
    assert.equal(requested.run.status, 'busy');
    await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll(`document.querySelector('.vz-panel')?.dataset.session!==${JSON.stringify(original.session)}`);
    assert.deepEqual(await cdp.evaluate('window.__replace'), { status: 'applied' });
    assert.deepEqual(await cdp.evaluate(`(async()=>${KZ}.state.variations.images.map(i=>i.id))()`), ['fake:flux-lora.png']);
    await discard();
  });

  await test('editable domains and exact File objects survive Cancel and SPA navigation', async () => {
    await open('flux-controlnet.png');
    await fileSetup(cdp);
    await cdp.clickAt('.vz-textrow .vz-imgrow-head .vz-cb');
    await type('.vz-text-values', 'a {{kept}} template');
    await type('.vz-tpl-input', 'first; second');
    await cdp.clickAt('.vz-enumrow .vz-imgrow-head .vz-cb');
    await cdp.clickAt('.vz-enumrow.on .vz-enum-opt:last-child .vz-cb');
    await type('.vz-prefix', 'files-kept');
    const before = await state();
    await requestClose();
    await cdp.clickAt('.vz-keep');
    assert.deepEqual(await cdp.evaluate('window.__leave'), { status: 'cancelled' });
    assert.deepEqual(await state(), before);
    assert(await cdp.evaluate(`document.querySelector('.vz-imgfilespick')===window.__fileInput && [...window.__fileInput.files].every((f,i)=>f===window.__files[i])`));
    await invoke('source.folder', { folder: 'missing-scope' });
    await invoke('feed.filter', { value: 'excluded' });
    assert.equal((await state()).session, before.session);
    assert.equal(await cdp.evaluate(`document.querySelector('.vz-prefix').value`), 'files-kept');
    await discard();
    await invoke('source.folder', { folder: '' });
    await invoke('feed.filter', { value: '' });
  });

  await test('held slider drag stays quiescent through confirmation, Cancel and physical release', async () => {
    await open();
    const selector = '.vz-slider-row[data-param-key$="denoise"] .noUi-handle[data-handle="1"]';
    const point = () => cdp.evaluate(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    let p = await point();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', buttons: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x-27, y:p.y, buttons: 1 });
    const before = await state();
    await requestClose();
    await cdp.poll(`!!document.querySelector('.vz-discard')`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:p.x-70, y:p.y, buttons:1 });
    assert.deepEqual(await state(), before);
    await cdp.keyTrusted('Escape', { vk:27 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x:p.x-100, y:p.y, buttons:1 });
    assert.deepEqual(await state(), before);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x:p.x-100, y:p.y, button:'left', buttons:0 });
    assert.deepEqual(await state(), before);
    p=await point(); await cdp.drag(p.x,p.y,p.x-25,p.y);
    assert.notDeepEqual((await state()).labels,before.labels);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});
    p=await point();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:7}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x-11,y:p.y,id:7}]});
    const touchBefore=await state();
    await requestClose();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
    await cdp.keyTrusted('Escape',{vk:27});
    assert.deepEqual(await state(),touchBefore);
    p=await point();
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:8}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x-23,y:p.y,id:8}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.notDeepEqual((await state()).labels,touchBefore.labels);
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
    await discard();
  });

  await test('early edits remain dirty after delayed probe defaults arrive',async()=>{
    await cdp.evaluate(`(()=>{window.__originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/features/variations/probe/')?new Promise(resolve=>window.__probe=()=>resolve(window.__originalFetch(url,options))):window.__originalFetch(url,options)})()`);
    await invoke('variations.open',{id:'fake:flux-basic.png'});
    await cdp.poll(`!!document.querySelector('.vz-prefix') && typeof window.__probe==='function'`);
    await type('.vz-prefix','typed-before-probe');
    await requestClose(); await cdp.clickAt('.vz-keep');
    await cdp.evaluate(`window.__probe()`);
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0`);
    assert.equal(await cdp.evaluate(`document.querySelector('.vz-prefix').value`),'typed-before-probe');
    await requestClose(); assert(await cdp.evaluate(`!!document.querySelector('.vz-discard')`));
    await cdp.clickAt('.vz-discard-confirm'); await cdp.poll(`!document.querySelector('.vz-panel')`);
    await cdp.evaluate(`window.fetch=window.__originalFetch`);
  });

  await test('mixed-backend files reject before uploads; per-target zero cannot hide under aggregate success',async()=>{
    await invoke('variations.open',{ids:['fake:flux-controlnet.png','another:flux-controlnet.png'],bulk:true});
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0`); await fileSetup(cdp);
    await cdp.evaluate(`(()=>{window.__originalFetch=window.fetch;window.__sideEffects=0;window.fetch=(url,options)=>{if(options?.body instanceof FormData || String(url).includes('/features/variations/run'))window.__sideEffects++;return window.__originalFetch(url,options)}})()`);
    assert.equal((await invoke('variations.run')).status,'invalid');
    assert.equal(await cdp.evaluate(`window.__sideEffects`),0);
    assert(await cdp.evaluate(`document.querySelector('.vz-error').textContent.includes('different backends') && document.querySelector('.vz-imgfilespick')===window.__fileInput`));
    await cdp.evaluate(`window.fetch=window.__originalFetch`); await discard();
    await invoke('variations.open',{ids:['fake:flux-basic.png','another:flux-basic.png'],bulk:true});
    await cdp.poll(`document.querySelectorAll('.vz-slider-row').length>0`);
    await cdp.evaluate(`(()=>{window.__originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/features/variations/run')?Promise.resolve(new Response(JSON.stringify(JSON.parse(options.body).host==='fake'?{submitted:1,total:1}:{submitted:0,total:0}),{status:200})):window.__originalFetch(url,options)})()`);
    assert.equal((await invoke('variations.run')).status,'failed');
    await new Promise(r=>setTimeout(r,3100));
    assert(await cdp.evaluate(`!!document.querySelector('.vz-panel') && !document.querySelector('.vz-error').classList.contains('vz-ok')`));
    await cdp.evaluate(`window.fetch=window.__originalFetch`); await discard();
  });

  await test('blocking decision outranks underlying popup; Escape cancels only the decision', async () => {
    await invoke('workbench.openPair',{left:{source:'fake',file:'flux-basic.png'},right:{source:'fake',file:'flux-lora.png'}});
    await open(); await type('.vz-prefix','popup-guard');
    await invoke('workbench.popup.toggle',{control:'active'});
    await cdp.poll(`!!document.querySelector('.dz-vpop')`);
    await requestClose(); await cdp.keyTrusted('Escape',{vk:27});
    await cdp.poll(`!document.querySelector('.vz-discard')`);
    assert(await cdp.evaluate(`!!document.querySelector('.dz-vpop') && !!document.querySelector('.vz-panel') && document.querySelector('.vz-prefix').value==='popup-guard'`));
    await invoke('workbench.popup.close'); await discard(); await invoke('workbench.close');
  });

  await test('Run snapshots before upload; stale A completion cannot publish or auto-close B', async () => {
    await open('flux-controlnet.png'); await fileSetup(cdp);
    await cdp.clickAt('.vz-textrow .vz-imgrow-head .vz-cb');
    await type('.vz-text-values','before upload text');
    await cdp.evaluate(`(()=>{window.__originalFetch=window.fetch;window.__bodies=[];window.fetch=(url,options)=>{
      if(options?.body instanceof FormData)return new Promise(resolve=>window.__upload=()=>resolve(new Response(JSON.stringify({name:options.body.get('image').name,origin:JSON.parse(options.headers['X-Kosmozoo-Origin'])}),{status:200})));
      if(String(url).includes('/features/variations/run')){window.__bodies.push(JSON.parse(options.body));return Promise.resolve(new Response(JSON.stringify({submitted:1,total:1}),{status:200}))}
      return window.__originalFetch(url,options)}})()`);
    await type('.vz-prefix','before-upload');
    await cdp.evaluate(`(async()=>{window.__run=${KZ}.handles.invoke('variations.run');return true})()`);
    await cdp.poll(`typeof window.__upload==='function'`);
    await type('.vz-prefix','after-upload');
    await type('.vz-text-values','after upload text');
    // Two picked files: release both upload awaits independently.
    await cdp.evaluate(`window.__upload();window.__upload=null`);
    await cdp.poll(`typeof window.__upload==='function'`);
    await cdp.evaluate(`window.__upload()`);
    assert.equal((await cdp.evaluate('window.__run')).status,'submitted');
    assert.equal(await cdp.evaluate(`window.__bodies[0].prefix`),'before-upload');
    assert.deepEqual(await cdp.evaluate(`Object.values(window.__bodies[0].imageParams).find(p=>p.values.includes('before upload text'))?.values`),['before upload text']);
    assert.equal(await cdp.evaluate(`document.querySelector('.vz-prefix').value`),'after-upload');
    await new Promise(r=>setTimeout(r,3200)); assert(await cdp.evaluate(`!!document.querySelector('.vz-panel')`));
    await cdp.evaluate(`window.fetch=(url,options)=>String(url).includes('/features/variations/run')?new Promise(resolve=>window.__finish=()=>resolve(new Response(JSON.stringify({submitted:1,total:1}),{status:200}))):options?.body instanceof FormData?Promise.resolve(new Response(JSON.stringify({name:options.body.get('image').name,origin:JSON.parse(options.headers['X-Kosmozoo-Origin'])}),{status:200})):window.__originalFetch(url,options)`);
    await cdp.evaluate(`(async()=>{window.__oldRun=${KZ}.handles.invoke('variations.run');return true})()`);
    await cdp.poll(`typeof window.__finish==='function'`);
    await cdp.evaluate(`(async()=>{window.__replacement=${KZ}.handles.invoke('variations.open',{id:'fake:flux-basic.png'});return true})()`);
    await cdp.clickAt('.vz-discard-confirm');
    const sessionB=(await state()).session;
    await invoke('variations.open',{id:'fake:flux-controlnet.png'});
    await cdp.poll(`document.querySelector('.vz-panel')?.dataset.session!==${JSON.stringify(sessionB)}`);
    const reopenedA=(await state()).session;
    await cdp.evaluate(`window.__finish()`);
    assert.equal((await cdp.evaluate('window.__oldRun')).status,'stale');
    assert.equal((await state()).session,reopenedA);
    assert.equal(await cdp.evaluate(`document.querySelector('.vz-error').textContent`),'');
    await cdp.evaluate(`window.fetch=window.__originalFetch`); await discard();
  });

  await test('partial/zero/malformed counts stay open; acknowledged edited fields manually close; clean success auto-closes', async () => {
    for(const response of [{submitted:1,total:2},{submitted:0,total:0},{submitted:1},{submitted:1,total:1,errors:[{error:'failed permutation'}]}]){
      await open();
      await cdp.evaluate(`(()=>{window.__originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/features/variations/run')?Promise.resolve(new Response(${JSON.stringify(JSON.stringify(response))},{status:200})):window.__originalFetch(url,options)})()`);
      assert.equal((await invoke('variations.run')).status,'failed');
      await new Promise(r=>setTimeout(r,3100));
      assert(await cdp.evaluate(`!!document.querySelector('.vz-panel') && !document.querySelector('.vz-error').classList.contains('vz-ok')`));
      await cdp.evaluate(`window.fetch=window.__originalFetch`); await discard();
    }
    await fetch(`${FAKE}/__test/activity`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
    await open(); await type('.vz-prefix','edited-acknowledged');
    assert.equal((await invoke('variations.run')).status,'submitted');
    const jobs=await(await fetch(`${FAKE}/__test/enqueues`)).json();
    assert(jobs.length>0); assert(jobs.every(job=>job.prompt && job.extra_data));
    await requestClose(); await cdp.poll(`!document.querySelector('.vz-panel')`);
    assert.equal(await cdp.evaluate(`!!document.querySelector('.vz-discard')`),false);
    await open(); assert.equal((await invoke('variations.run')).status,'submitted');
    await cdp.poll(`!document.querySelector('.vz-panel')`,6000);
    await fetch(`${FAKE}/__test/activity`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:false})});
  });
};
module.exports.verifyFileReadiness = verifyFileReadiness;
