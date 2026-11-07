// Real plugin + deterministic byte service + rendered native/canvas consumer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18460';
const DETECTOR = process.env.E2E_DETECTOR ?? 'http://127.0.0.1:18463';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18461';
const E = process.env.FACE_EVIDENCE ?? 'artifacts/face-alignment';
const KZ = `(await import('/store/instance.js')).appStore`;
const fixtures = { a: [[256, 256, 160], [75, 75, 32]], b: [[210, 210, 40], [360, 120, 48]] };

(async () => {
  fs.mkdirSync(E, { recursive: true });
  // Own the fake's fixture lifetime so this consumer can be repeated without
  // a prior run's uploaded same-name input causing a stock collision response.
  assert((await fetch(FAKE+'/__test/activity',{method:'POST',body:JSON.stringify({reset:true})})).ok);
  const initialRequests = (await (await fetch(DETECTOR + '/__test/requests')).json()).length;
  const page = await CDP.launch(9390, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page), proofs = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const state = expr => page.evaluate(`(async()=>${expr})()`);
  const frames = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const config = async body => { const r = await fetch(DETECTOR + '/__test/config', { method: 'POST', body: JSON.stringify(body) }); assert(r.ok); };
  const requests = async () => (await fetch(DETECTOR + '/__test/requests')).json();
  const requestAfter = async count => {
    const until=Date.now()+15000;
    while((await requests()).length<=count){assert(Date.now()<until,'inference request started');await sleep(50);}
  };
  const capture = async name => { await frames(); fs.writeFileSync(path.join(E, name + '.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  const open = async (left = { source: 'faces', file: 'multi-a.png' }, right = { source: 'faces', file: 'multi-b.png' }) => {
    await invoke('workbench.openPair', { left, right });
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll(`document.querySelector('.dz-a img')?.naturalWidth > 0 && document.querySelector('.dz-b img')?.naturalWidth > 0`, 20000);
  };
  const selectFaceMode = async () => {
    await page.clickAt('#diffAlignment');
    await page.keyTrusted('End', { vk: 35 }); await page.keyTrusted('Enter', { vk: 13 });
    await page.poll(`document.querySelector('#diffAlignment')?.value === 'face'`);
  };
  const count = side => page.evaluate(`document.querySelectorAll('.dz-${side} .face-selected[data-selected="true"]').length`);
  const anchor = side => page.evaluate(`document.querySelector('.dz-${side} .face-selected.is-anchor')?.dataset.face ?? null`);
  const nativePoint = (side, index = 0) => page.evaluate(`(() => {
    const img = document.querySelector('.dz-${side} img'), r = img.getBoundingClientRect(), p = ${JSON.stringify(fixtures[side][index])};
    return { x: r.left + p[0] / img.naturalWidth * r.width, y: r.top + p[1] / img.naturalHeight * r.height };
  })()`);
  const doubleClick = async (side, index) => {
    const p = await nativePoint(side, index);
    for (const clickCount of [1, 2]) {
      await page.mouse('mousePressed', p.x, p.y, { clickCount, buttons: 1 });
      await page.mouse('mouseReleased', p.x, p.y, { clickCount, buttons: 0 });
    }
    await page.poll(`document.querySelector('.dz-${side} .face-selected.is-anchor')?.dataset.face.endsWith(':${index}')`);
  };
  const geometry = async (label, ia = 0, ib = 0, local = false) => {
    await frames();
    const observed = await page.evaluate(`(() => {
      const result = {};
      for (const [side, index] of [['a',${ia}],['b',${ib}]]) {
        const img = document.querySelector('.dz-'+side+' img'), r = img.getBoundingClientRect(), cell = img.closest('.dz-cell').getBoundingClientRect();
        const [x,y,span] = ${JSON.stringify(fixtures)}[side][index];
        const ox = ${local} ? cell.left : 0, oy = ${local} ? cell.top : 0;
        result[side] = { midpoint: [r.left+x/img.naturalWidth*r.width-ox,r.top+y/img.naturalHeight*r.height-oy],
          span: span/img.naturalWidth*r.width, width:r.width, src:img.src,
          eyes:[...document.querySelectorAll('.dz-'+side+' .face-eye')].map(e=>{const p=e.getBoundingClientRect();return[p.left+p.width/2-ox,p.top+p.height/2-oy];}) };
      }
      return result;
    })()`);
    assert(Math.abs(observed.a.span - observed.b.span) < .6, label + ' native eye spans ' + JSON.stringify(observed));
    observed.a.midpoint.forEach((v, i) => assert(Math.abs(v - observed.b.midpoint[i]) < .6, label + ' native midpoints'));
    for (const side of ['a', 'b']) {
      assert.equal(observed[side].eyes.length, 2);
      const midpoint = observed[side].eyes[0].map((v, i) => (v + observed[side].eyes[1][i]) / 2);
      midpoint.forEach((v, i) => assert(Math.abs(v - observed[side].midpoint[i]) < .6, label + ' feedback/native agreement'));
    }
    proofs.push({ label, observed }); console.log('geometry', label, JSON.stringify(observed));
    return observed;
  };
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake');
    await page.poll(`!!document.querySelector('.card')`, 20000);
    assert.equal((await requests()).length, initialRequests, 'browsing has no inference');
    if (!await state(`Object.hasOwn(${KZ}.state.hosts,'faces')`)) {
      await invoke('source.add', { name: 'faces', address: 'folder:' + (process.env.FACE_FIXTURES ?? '/work/tests/.tmp-runtime/face-fixtures') });
      await page.poll(`(async()=>Object.hasOwn(${KZ}.state.hosts,'faces'))()`);
    }
    await page.clickAt('#menuBtn');
    await page.poll(`!!document.querySelector('#faceServiceUrl')`);
    await page.clickAt('#faceServiceUrl');
    await page.evaluate(`document.querySelector('#faceServiceUrl').select()`);
    await page.send('Input.insertText', { text: DETECTOR });
    await page.clickAt('.face-settings button[type="submit"]');
    await page.poll(`document.querySelector('.face-settings [role="status"]')?.textContent === 'Detector settings saved'`);
    assert.equal((await (await fetch(ENGINE + '/api/settings/plugins.detector')).json()).serviceUrl, DETECTOR);
    await capture('settings-saved');
    await page.clickAt('#menuBtn');
    await open(); await selectFaceMode(); await page.clickAt('#faceDetection');
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length === 2 && document.querySelectorAll('.dz-b .face-selected').length === 2`, 20000);
    assert.equal(await anchor('a'), null); assert.equal(await anchor('b'), null);
    assert.equal(await count('a'), 2); assert.equal(await count('b'), 2);
    const controlGeometry = await page.evaluate(`(() => {
      const control=document.querySelector('#diffAlignment').parentElement.getBoundingClientRect();
      const icon=document.querySelector('#diffAlignment').parentElement.querySelector('.chevron-slot svg').getBoundingClientRect();
      return {top:icon.top-control.top,bottom:control.bottom-icon.bottom,right:control.right-icon.right};
    })()`);
    assert(Math.max(...Object.values(controlGeometry))-Math.min(...Object.values(controlGeometry))<1,'selector chevron has uniform edge spacing');
    proofs.push({label:'alignment selector structural chevron spacing',controlGeometry});
    await capture('multi-face-waiting');
    const retired = await page.evaluate(`(() => { const r = document.querySelector('.dz-a .face-feedback'); return { side:'a',record:r.dataset.record,face:r.querySelector('[data-face]').dataset.face }; })()`);
    await doubleClick('a', 0); assert.equal(await anchor('b'), null);
    await doubleClick('b', 0);
    assert.equal(await count('a'), 2); assert.equal(await count('b'), 2);
    const belowFit = await geometry('two-up below-fit', 0, 0, true);
    assert(Math.abs(belowFit.a.width / belowFit.b.width - .25) < .001, 'candidate genuinely below fit');
    await capture('multi-face-chosen-two-up');
    await doubleClick('a', 1);
    await geometry('different candidate face', 1, 0, true);
    assert.equal(await count('a'), 2);
    await doubleClick('b', 1); await geometry('different reference face', 1, 1, true);
    assert.equal(await count('b'), 2);
    await doubleClick('b', 0);
    // Keyboard activation reaches the same identity-validated semantic command.
    await page.evaluate(`document.querySelector('.face-choices button').focus()`);
    await page.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r' });
    await page.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13 });
    await page.poll(`document.querySelector('.dz-a .is-anchor')?.dataset.face.endsWith(':0')`);
    await invoke('workbench.mode', { mode: 'one-up' });
    await invoke('workbench.parameters', { parameter: 'activeOpacity', value: .5 });
    const overlapping = await geometry('overlap before gestures');
    const raw = await state(`JSON.stringify(${KZ}.state.diff.views)`);
    const p = await nativePoint('a', 0);
    await page.drag(p.x, p.y, p.x + 28, p.y + 19);
    const moved = await geometry('common camera pan');
    assert(moved.a.midpoint[0] > overlapping.a.midpoint[0] + 20);
    const chosen = await anchor('a');
    const afterPan = await nativePoint('a', 1);
    await page.mouse('mousePressed', afterPan.x, afterPan.y, { clickCount:1, buttons:1 });
    await page.mouse('mouseReleased', afterPan.x, afterPan.y, { clickCount:1, buttons:0 });
    await page.mouse('mousePressed', afterPan.x, afterPan.y, { clickCount:2, buttons:1 });
    await page.mouse('mouseMoved', afterPan.x+12, afterPan.y, { buttons:1 });
    await page.mouse('mouseReleased', afterPan.x+12, afterPan.y, { clickCount:2, buttons:0 });
    await frames();
    assert.equal(await anchor('a'), chosen, 'drag suppression cannot become a face choice');
    const wheel = await nativePoint('a', 0);
    await page.mouse('mouseWheel', wheel.x, wheel.y, { modifiers: 2, deltaY: -24, deltaX: 0 });
    await page.poll(`document.querySelector('.dz-a img').getBoundingClientRect().width > ${moved.a.width + 1}`);
    await geometry('common camera zoom');
    assert.equal(await state(`JSON.stringify(${KZ}.state.diff.views)`), raw, 'registered gestures never write ordinary crops');
    await capture('registered-overlap');
    for (const column of ['right', 'feed', 'right', 'feed']) {
      await invoke('workbench.column', { column }); await geometry('blink ' + column);
    }
    await invoke('workbench.mode', { mode:'split' });
    await geometry('split uses the same registered frame');
    await doubleClick('b',1);
    assert((await anchor('a')).endsWith(':0'),'clipped-side hit changes B only');
    await geometry('split reference choice',0,1);
    await page.evaluate(`document.querySelectorAll('.face-choices')[1].querySelector('button').focus()`);
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await page.poll(`document.querySelector('.dz-b .is-anchor')?.dataset.face.endsWith(':0')`);
    await invoke('workbench.mode', { mode: 'difference' });
    // Both rendered eyes are white in the fixture. A shared final rectangle
    // must produce the same non-orange pixel in the actual Difference canvas.
    await page.poll(`(() => {
      const c=document.querySelector('.dz-canvas'), g=document.querySelector('.dz-canvas-cell .face-eye');
      if(!c||!g||c.width<1000)return false;
      const p=g.getBoundingClientRect(),r=c.getBoundingClientRect();
      const pixel=c.getContext('2d').getImageData(Math.round(p.left+p.width/2-r.left),Math.round(p.top+p.height/2-r.top),1,1).data;
      return pixel[0]>100 && Math.abs(pixel[0]-pixel[1])<2 && Math.abs(pixel[1]-pixel[2])<2;
    })()`, 10000);
    proofs.push({ label: 'Difference actual eye pixels match, not orange' });
    await capture('registered-difference');
    await invoke('workbench.mode', { mode: 'full' });
    assert.equal(await page.evaluate(`!!document.querySelector('#diffAlignment') || !!document.querySelector('.face-feedback')`), false);
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length===2`);
    await geometry('return retains camera and anchors', 0, 0, true);
    await page.key('l');
    await page.poll(`document.querySelector('#diffAlignment').value==='shared'`);
    assert.equal(await count('a'), 2, 'Shared retains detection feedback independently of registration');
    assert.equal(await count('b'), 2);
    await page.key('a'); await page.poll(`document.querySelector('#diffAlignment').value==='face'`);
    await invoke('workbench.close'); await open();
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length===2`);
    assert.equal(await anchor('a'), null, 'new viewer lifetime does not inherit a face index');
    assert.equal(await invoke('faces.use', retired), false, 'retired command cannot mutate reopened pair');
    // Genuine empty and unusable landmarks have distinct visible statuses.
    for (const [name, phase] of [['no-face.png','empty'],['invalid-eyes.png','unusable']]) {
      await open({ source:'faces',file:name });
      await page.poll(`document.querySelector('.face-status')?.dataset.phase==='${phase}'`);
      await capture('state-'+phase);
      console.log('visible unavailable state', name, phase);
    }
    await config({ ready: false });
    await open({ source:'faces',file:'single.png' });
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='loading'`);
    assert(await page.evaluate(`document.querySelector('.face-status').textContent.includes('model is loading')`));
    await capture('state-model-loading');
    await config({ ready: true }); await page.clickAt('.face-controls-slot .btn');
    await page.poll(`document.querySelector('.dz-a .face-selected.is-anchor')`);
    await config({ fail: true });
    await open({ source:'faces',file:'single.png' });
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='error'`);
    assert(await page.evaluate(`document.querySelector('.face-status').textContent.includes('controlled inference failure')`));
    await capture('state-service-error');
    await config({ fail: false }); await page.clickAt('.face-controls-slot .btn');
    await page.poll(`document.querySelector('.dz-a .face-selected.is-anchor')`);
    console.log('service failure retry reaches actual selected face');
    // Retire a pending image and configuration through production commands.
    await config({ delay: 1200 });
    const beforeNavigation=(await requests()).length;
    await page.goto(ENGINE+'/diff#faces#multi-a.png:faces#multi-b.png');
    await page.poll(`(async()=>${KZ}.state.diff.open)()`);
    await invoke('workbench.mode',{mode:'two-up'});await invoke('workbench.alignment',{mode:'face'});
    await page.clickAt('#faceDetection');
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='pending'`);
    await requestAfter(beforeNavigation);
    await invoke('entry.select',{source:'faces',file:'single.png'});
    await invoke('faces.settings.edit', { value: DETECTOR + '/v2' }); await invoke('faces.settings.save');
    await page.poll(`document.querySelector('.dz-a .face-selected.is-anchor')`, 20000);
    assert.equal(await count('a'), 1, 'retired multi-face result cannot overlay current single-face pixels');
    assert.equal(await invoke('faces.use', retired), false);
    await config({ delay: 0 });
    // Same-name input/output addressing uses different actual bytes.
    const input = Buffer.from(await (await fetch(DETECTOR + '/fixtures/multi-b.png')).arrayBuffer());
    const form = new FormData(); form.set('image', new Blob([input]), 'face-same.png');
    assert((await fetch(FAKE + '/api/upload/image', { method:'POST',body:form })).ok);
    assert((await fetch(FAKE + '/__test/activity', { method:'POST',body:JSON.stringify({publish:[{name:'face-same.png',fixture:'bulk'}]}) })).ok);
    await invoke('source.refresh');
    await open({source:'faces',file:'multi-a.png'},{source:'input:fake',file:'face-same.png'});
    await page.poll(`document.querySelectorAll('.dz-b .face-selected').length===2`);
    const bUrl = await page.evaluate(`document.querySelector('.dz-b img').src`);
    assert(bUrl.includes(crypto.createHash('sha256').update(input).digest('hex')), 'input feedback bound to exact input bytes');
    const output = Buffer.from(await (await fetch(ENGINE + '/api/collections/fake/entries/face-same.png/bytes')).arrayBuffer());
    assert.notDeepEqual(input, output);
    // Local anchors retain the raw-byte path and accepted byte identity.
    const base64 = input.toString('base64');
    await page.evaluate(`(async()=>{const bytes=Uint8Array.from(atob('${base64}'),c=>c.charCodeAt(0));await ${KZ}.handles.invoke('anchor.add',{files:[new File([bytes],'face-local.png',{type:'image/png'})]});})()`);
    const anchorName = await state(`${KZ}.state.anchors.at(-1).name`);
    await open({source:'faces',file:'multi-a.png'},{source:'anchor',file:anchorName});
    await page.poll(`document.querySelectorAll('.dz-b .face-selected').length===2`);
    assert(await page.evaluate(`document.querySelector('.dz-b img').src.startsWith('data:')`));
    console.log('input/output and raw local anchor reach real detector and visible feedback');
    // An inference result for replacement bytes must never decorate the old
    // decoded frame retained by the native display owner after a failed swap.
    await invoke('workbench.alignment', { mode:'independent' });
    await page.clickAt('#faceDetection');
    const mutable = process.env.FACE_MUTABLE ?? '/work/tests/.tmp-mutable';
    const mutableFile = path.join(mutable, 'flux-basic.png'), original = fs.readFileSync(mutableFile);
    const originalHash=crypto.createHash('sha256').update(original).digest('hex');
    const initialDeadline=Date.now()+15000;
    for(;;) {
      const served=Buffer.from(await(await fetch(ENGINE+'/api/collections/mut/entries/flux-basic.png/bytes')).arrayBuffer());
      if(served.equals(original))break;
      assert(Date.now()<initialDeadline,'restored fixture bytes reached the engine before the replacement case');await sleep(200);
    }
    await invoke('source.select',{id:'mut'});await invoke('source.refresh');
    await page.poll(`(async()=>${KZ}.state.images.find(i=>i.filename==='flux-basic.png')?.hash==='${originalHash}')()`);
    await open({source:'mut',file:'flux-basic.png'});
    await page.poll(`document.querySelector('.dz-a img')?.src.endsWith('/collections/mut/entries/flux-basic.png/bytes') && document.querySelector('.dz-a img').naturalWidth===${original.readUInt32BE(16)}`);
    const oldSize = await page.evaluate(`(()=>{const im=document.querySelector('.dz-a img');return {w:im.naturalWidth,h:im.naturalHeight};})()`);
    const makeResult = (size, count=1) => ({ ...size, faces:Array.from({length:count},(_,i)=>{
      const x=size.w*(.4+i*.2),y=size.h*.4,span=size.w*.1;
      const kps=Array.from({length:28},()=>[x,y,1]);
      for(let n=11;n<17;n++)kps[n]=[x-span/2,y,1];for(let n=17;n<23;n++)kps[n]=[x+span/2,y,1];
      return {bbox:[x-span,y-span,x+span,y+span],score:1,kps};
    }) });
    await config({records:{[originalHash]:makeResult(oldSize)}});
    await invoke('workbench.alignment',{mode:'face'});
    await page.clickAt('#faceDetection');
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length===1`);
    const coherent = await page.evaluate(`(()=>({src:document.querySelector('.dz-a img').src,record:document.querySelector('.dz-a .face-feedback').dataset.record}))()`);
    try {
      const invalid = Buffer.from('undecodable replacement face bytes');
      const invalidHash = crypto.createHash('sha256').update(invalid).digest('hex');
      await config({records:{[invalidHash]:makeResult({w:512,h:512},2)}});
      // Hold the actual inference response after the engine has ingested the
      // replacement. Known content presentation must not depend on ML timing.
      await page.evaluate(`(()=>{const original=window.fetch;window.restoreContentFetch=()=>window.fetch=original;
        window.fetch=async(url,options)=>{const response=await original(url,options);if(String(url).endsWith('/api/plugins/detector/detect')&&typeof options?.body==='string'&&options.body.includes('${invalidHash}'))return new Promise(resolve=>window.releaseContentInference=()=>resolve(response));return response;};})()`);
      fs.writeFileSync(mutableFile, invalid);
      const future = new Date(Date.now()+5000); fs.utimesSync(mutableFile,future,future);
      const until = Date.now()+15000;
      for (;;) {
        const served=Buffer.from(await(await fetch(ENGINE+'/api/collections/mut/entries/flux-basic.png/bytes')).arrayBuffer());
        if(served.equals(invalid))break;
        assert(Date.now()<until,'replacement bytes reached engine');await sleep(200);
      }
      await invoke('source.refresh');
      await page.poll(`!!window.releaseContentInference`,15000);
      const pending = await page.evaluate(`(async()=>{const s=${KZ},resource=s.actions.diff.resolve(s.state.diffPair().a);
        return{resource,request:s.state.comparisonProvider().resource('a',resource),accepted:s.actions['face-alignment'].acceptedRecord('a'),
          src:document.querySelector('.dz-a img').src,record:document.querySelector('.dz-a .face-feedback')?.dataset.record};})()`);
      proofs.push({label:'known immutable replacement while ML is pending retains accepted old frame',pending});
      assert.equal(pending.resource.hash,invalidHash,'Store has the canonical new content identity');
      assert.equal(pending.request.src,'/api/content/'+invalidHash+'/bytes', 'pending known content cannot downgrade to a mutable address');
      assert.equal(pending.request.hash,invalidHash);assert.equal(pending.request.recordId,undefined,'held ML response is not a published record');
      assert.equal(pending.src,coherent.src,'failed known-content decode keeps the actual accepted old pixels');
      assert.equal(pending.record,coherent.record,'pending ML cannot retire old accepted feedback');
      await page.evaluate(`window.releaseContentInference();window.restoreContentFetch()`);
      // Content replacement invalidates the old request key and runs detection
      // for the new known hash even though the file name did not change.
      const deadline=Date.now()+15000;
      while(!(await requests()).some(r=>r.hash===invalidHash&&!r.pending)) {
        assert(Date.now()<deadline,'replacement content was detected'); await sleep(100);
      }
      await frames();
      assert.equal(await page.evaluate(`document.querySelector('.dz-a img').src`),coherent.src);
      assert.equal(await page.evaluate(`document.querySelector('.dz-a .face-feedback')?.dataset.record`),coherent.record);
      assert.equal(await count('a'),1,'two new faces never overlay the retained old pixels');
      proofs.push({label:'failed immutable decode retains coherent old frame and its one-face feedback',coherent,invalidHash});
      await capture('retained-immutable-after-failed-decode');
    } finally { await page.evaluate(`window.releaseContentInference?.();window.restoreContentFetch?.()`).catch(()=>{});fs.writeFileSync(mutableFile,original); }
    // Source removal retires in-flight work; re-adding the same name creates a
    // different source lifetime and cannot inherit the removed source's face IDs.
    await config({delay:1000}); const beforeRemoval=(await requests()).length; await open();
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='pending'`);
    await requestAfter(beforeRemoval);
    await invoke('source.remove',{id:'faces'});
    await sleep(1200);
    assert.equal(await state(`Object.hasOwn(${KZ}.state.hosts,'faces')`),false);
    await invoke('source.add',{name:'faces',address:'folder:'+(process.env.FACE_FIXTURES??'/work/tests/.tmp-runtime/face-fixtures')});
    await config({delay:0}); await open();
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length===2`,20000);
    assert.equal(await anchor('a'),null); assert.equal(await anchor('b'),null);
    assert.equal(await invoke('faces.use',retired),false);
    console.log('source retirement and failed-decode immutable-content fencing reach displayed consumers');
    assert((await fetch(FAKE+'/__test/activity',{method:'POST',body:JSON.stringify({publish:[
      {name:'face-video.webm',fixture:'media/workflow.webm'},{name:'face-audio.wav',fixture:'media/workflow.wav'}
    ]})})).ok);
    await invoke('workbench.openPair',{left:{source:'fake',file:'face-video.webm'},right:{source:'faces',file:'multi-b.png'}});
    await invoke('workbench.mode',{mode:'two-up'});
    await page.poll(`document.querySelector('.dz-a video')?.readyState>=2`,20000);
    assert.equal(await page.evaluate(`!!document.querySelector('.face-feedback')`),false);
    assert.deepEqual(await page.evaluate(`[...document.querySelector('#diffAlignment').options].map(o=>o.value)`),['independent','shared']);
    assert.equal(await state(`${KZ}.state.diff.alignment`),'face','ineligible surface retains requested face choice without applying it');
    await page.key('a'); await page.poll(`document.querySelector('#diffAlignment').value==='independent'`);
    await page.key('a'); await page.poll(`document.querySelector('#diffAlignment').value==='shared'`);
    await page.key('l'); await page.poll(`document.querySelector('#diffAlignment').value==='independent'`);
    await invoke('workbench.alignment',{mode:'face'});
    await invoke('workbench.openPair',{left:{source:'fake',file:'face-audio.wav'},right:{source:'faces',file:'multi-b.png'}});
    await page.poll(`document.querySelector('.dz-a audio')?.readyState>=2`,20000);
    assert.equal(await page.evaluate(`!!document.querySelector('#diffAlignment')||!!document.querySelector('.face-feedback')`),false);
    console.log('video/audio omit face effects, retain the request, and a/l use the available alignment choices');
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    fs.writeFileSync(path.join(E, 'consumer-proofs.json'), JSON.stringify({ proofs, requests:await requests(), errors }, null, 2));
    console.log('FACE ALIGNMENT CONSUMER: ALL PASS');
  } catch (error) {
    await capture('failure').catch(()=>{});
    const consumer = await page.evaluate(`(async()=>({alignment:${KZ}.state.diff.alignment,selector:document.querySelector('#diffAlignment')?.value,
      status:document.querySelector('.face-status')?.textContent,pair:${KZ}.state.diffPair(),
      sources:Object.keys(${KZ}.state.hosts),images:[...document.querySelectorAll('#diffStage img')].map(i=>({src:i.src,w:i.naturalWidth,h:i.naturalHeight}))}))()`).catch(()=>null);
    fs.writeFileSync(path.join(E, 'failure.json'), JSON.stringify({ message:String(error.stack), errors, proofs,consumer }, null, 2));
    throw error;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
