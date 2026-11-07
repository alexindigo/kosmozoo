// Independent detection admission, observed at the browser and service consumers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE, DETECTOR = process.env.E2E_DETECTOR, E = process.env.FACE_EVIDENCE;
assert(ENGINE && DETECTOR && E, 'explicit owned guest environment required');
const KZ = "(await import('/store/instance.js')).appStore";
(async () => {
  fs.mkdirSync(E, { recursive: true });
  const page = await CDP.launch(9396, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page), network = [], proofs = [];
  await page.send('Network.enable');
  const original = page.ws.onmessage;
  page.ws.onmessage = event => {
    original(event);
    const m = JSON.parse(event.data);
    if (m.method === 'Network.requestWillBeSent' && /\/api\/plugins\/detector\/(status|detect)/.test(m.params.request.url))
      network.push({ id: m.params.requestId, url: m.params.request.url, method: m.params.request.method });
    if (m.method === 'Network.loadingFailed') {
      const r = network.find(r => r.id === m.params.requestId);
      if (r) r.failure = m.params.errorText;
    }
  };
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const state = expr => page.evaluate(`(async()=>${expr})()`);
  const config = async body => assert((await fetch(DETECTOR + '/__test/config', { method: 'POST', body: JSON.stringify(body) })).ok);
  const operations = async () => (await fetch(DETECTOR + '/__test/operations')).json();
  const counts = async () => {
    const service = await operations();
    return { browser: network.length, status: network.filter(r => r.url.endsWith('/status')).length,
      infer: network.filter(r => r.url.endsWith('/detect')).length, service: service.length,
      health: service.filter(r => r.kind === 'health').length, serviceInfer: service.filter(r => r.kind === 'infer').length };
  };
  const quiet = async (before, label) => {
    await sleep(500); assert.deepEqual(await counts(), before, label);
    proofs.push({ label, counts: before }); console.log('QUIET', label, JSON.stringify(before));
  };
  const frames = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const capture = async name => { if (process.env.FACE_SKIP_SCREENSHOTS === '1' && name !== 'failure') return; await frames(); fs.writeFileSync(path.join(E, name + '.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); };
  const open = async (a = 'multi-a.png', b = 'multi-b.png') => {
    await invoke('workbench.openPair', { left: { source: 'faces', file: a }, right: { source: 'faces', file: b }, push: true });
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll(`document.querySelector('.dz-a img')?.naturalWidth>0&&document.querySelector('.dz-b img')?.naturalWidth>0`);
  };
  const records = () => page.evaluate(`(async()=>{const s=${KZ};return ['a','b'].map(side=>s.actions['face-alignment'].acceptedRecord(side));})()`);
  const ready = () => page.poll(`document.querySelectorAll('.face-selected').length===4`, 20000);
  const rects = () => page.evaluate(`['a','b'].map(side=>document.querySelector('.dz-'+side+' img').getBoundingClientRect().toJSON())`);
  const raw = () => state(`JSON.stringify(${KZ}.state.diff.views)`);
  const use = async (side, index) => { const r = (await records())[side === 'a' ? 0 : 1]; assert(await invoke('faces.use', { side, record: r.id, face: r.faces[index].id })); };
  const assertRects = (a, b, label) => a.forEach((r, i) => ['left', 'top', 'width', 'height'].forEach(k => assert(Math.abs(r[k] - b[i][k]) < .6, label + ' ' + k)));
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await config({ ready: true, fail: false, delay: 0, healthDelay: 0 });
    const serviceBeforeBoot = await operations();
    await page.goto(ENGINE + '/#faces'); await page.poll(`!!document.querySelector('.card')`, 20000);
    const initial = await counts();
    assert.equal(initial.browser, 0, 'app boot does not issue operational detector requests');
    assert.equal(initial.service, serviceBeforeBoot.length, 'app boot does not probe health or infer');
    await invoke('faces.settings.edit', { value: DETECTOR }); await invoke('faces.settings.save');
    await open(); await invoke('workbench.alignment', { mode: 'face' }); await frames();
    assert.equal(await page.evaluate(`document.querySelector('#faceDetection').getAttribute('aria-pressed')`), 'false');
    assert.equal(await page.evaluate(`!!document.querySelector('.face-feedback,.face-status,.face-choice')`), false);
    await quiet(initial, 'fresh OFF: saved configuration and Face alignment cannot activate detector');
    await capture('default-off');
    await invoke('faces.retry'); await quiet(initial, 'retry OFF has no operational request');
    await invoke('workbench.alignment', { mode: 'independent' }); const ordinary = await rects();
    await page.clickAt('#faceDetection'); await ready();
    assert.equal(await state(`${KZ}.state.diff.alignment`), 'independent');
    assertRects(await rects(), ordinary, 'detect-only ordinary geometry');
    assert(!await page.evaluate(`document.querySelector('.face-status').textContent.includes('registered')`));
    await capture('on-independent-all-selected');
    // Explicit native double-click, rather than the toggle, requests alignment.
    const point = await page.evaluate(`(()=>{const r=document.querySelector('.dz-a img').getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    for (const clickCount of [1, 2]) {
      await page.mouse('mousePressed', point.x, point.y, { clickCount, buttons: 1 });
      await page.mouse('mouseReleased', point.x, point.y, { clickCount, buttons: 0 });
    }
    await page.poll(`document.querySelector('#diffAlignment').value==='face'&&document.querySelector('.dz-a .is-anchor')`);
    await use('b', 0); await invoke('workbench.mode', { mode: 'one-up' });
    await invoke('workbench.parameters', { parameter: 'activeOpacity', value: .5 });
    await page.drag(650, 350, 675, 365); await frames();
    const chosen = await records(), registered = await rects(), crops = await raw();
    await page.keyTrusted('Tab', { vk: 9 });
    await page.evaluate(`document.querySelector('#faceDetection').focus()`);
    const toggleBox = await page.evaluate(`document.querySelector('#faceDetection').getBoundingClientRect().toJSON()`);
    await page.mouse('mouseMoved', toggleBox.x + toggleBox.width / 2, toggleBox.y + toggleBox.height / 2);
    assert(await page.evaluate(`document.querySelector('#faceDetection').matches(':focus-visible')`));
    const iconGaps = await page.evaluate(`(()=>{const b=document.querySelector('#faceDetection').getBoundingClientRect(),i=document.querySelector('#faceDetection svg').getBoundingClientRect();return [i.left-b.left,b.right-i.right,i.top-b.top,b.bottom-i.bottom];})()`);
    assert(Math.max(...iconGaps) - Math.min(...iconGaps) < 1, 'toggle icon is structurally centered with equal space');
    proofs.push({ label: 'shared toggle on/aria state, native focus and uniform icon space', iconGaps });
    await capture('on-registered-focus-hover');
    await page.clickAt('#faceDetection'); await frames();
    assert.equal(await page.evaluate(`!!document.querySelector('.face-feedback,.face-status,.face-choice')`), false);
    assert.equal(await state(`${KZ}.state.diff.alignment`), 'face'); assert.equal(await raw(), crops);
    const off = await counts(); await quiet(off, 'OFF valid choices: no status, health or inference');
    assert.equal(await invoke('faces.use', { side: 'a', record: chosen[0].id, face: chosen[0].faces[1].id }), false);
    // An unavailable handshake has no model observation. It cannot retire
    // valid immutable choices merely because its status lacks a model field.
    await page.evaluate(`(()=>{const original=window.fetch;window.restoreReadinessFetch=()=>window.fetch=original;
      window.fetch=async(url,options)=>{const response=await original(url,options);return String(url).endsWith('/api/plugins/detector/status')?new Promise(resolve=>window.releaseChoiceStatus=()=>resolve(new Response(JSON.stringify({state:'unreachable'}),{status:200}))):response;};})()`);
    await page.clickAt('#faceDetection');
    await page.poll(`!!window.releaseChoiceStatus`);
    assert.equal(await page.evaluate(`document.querySelector('.face-status').dataset.phase`), 'pending');
    const choiceCounts = await counts();
    await invoke('workbench.alignment', { mode: 'independent' });
    // Native face activation observes the consumer outcome, not only the return value.
    await page.evaluate(`document.querySelectorAll('.face-choice')[1].focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal((await records())[0].anchor, chosen[0].faces[1].id, 'pending ON handshake admits a different valid cached face');
    assert.equal(await state(`${KZ}.state.diff.alignment`), 'face', 'cached native face use explicitly requests Face alignment');
    await quiet(choiceCounts, 'cached choice during pending ON handshake admits no work');
    const pendingChoice = await records();
    await page.evaluate(`window.releaseChoiceStatus()`);
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='error'`);
    await invoke('workbench.alignment', { mode: 'shared' });
    await use('a', 0);
    assert.equal(await state(`${KZ}.state.diff.alignment`), 'face');
    assert.deepEqual(await records(), chosen, 'missing model observation retains valid choices during readiness failure');
    await quiet(choiceCounts, 'cached choice during unavailable ON handshake admits no work');
    const unavailableChoice = await records();
    await page.clickAt('#faceDetection');
    const cachedCommand = { side: 'a', record: chosen[0].id, face: chosen[0].faces[1].id };
    assert.equal(await invoke('faces.use', cachedCommand), false, 'OFF rejects the same valid cached-face command');
    await invoke('faces.retry'); await quiet(choiceCounts, 'OFF cached choice and retry remain retired');
    proofs.push({ label: 'cached choice live while pending/unavailable, OFF rejects', before: chosen, pendingChoice, unavailableChoice, counts: choiceCounts });
    await page.evaluate(`window.restoreReadinessFetch()`); await page.clickAt('#faceDetection'); await ready(); await frames();
    assert.deepEqual(await records(), chosen); assertRects(await rects(), registered, 'reenable keeps common camera');
    assert.equal(await raw(), crops); assert.equal((await counts()).infer, off.infer, 'cached identities do not infer again');
    // A ticket captured before a same-task OFF/ON cannot revive when geometry and IDs match.
    await page.evaluate(`(async()=>{const s=${KZ};window.oldFaceGesture=s.state.comparisonProvider().gesture('a',{geometry:{width:1400,height:800}},()=>"toggle-frame");s.handles.invoke('faces.detection.toggle');s.handles.invoke('faces.detection.toggle');})()`);
    await ready(); await frames(); const beforeOld = await rects();
    await page.evaluate(`window.oldFaceGesture.pan(100,100)`); await frames();
    assertRects(await rects(), beforeOld, 'retired activation gesture');
    await page.drag(650, 350, 670, 360); await frames();
    assert(Math.abs((await rects())[1].left - beforeOld[1].left - 20) < .6, 'fresh registered gesture works');
    await invoke('workbench.alignment', { mode: 'shared' }); await ready();
    assert(!await page.evaluate(`document.querySelector('.face-status').textContent.includes('registered')`));
    const sharedGeometry = await rects(); await invoke('workbench.alignment', { mode: 'independent' }); await frames();
    assertRects(await rects(), sharedGeometry, 'Shared/Independent detection uses ordinary geometry');
    await page.evaluate(`document.querySelectorAll('.face-choice')[1].focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    assert.equal(await state(`${KZ}.state.diff.alignment`), 'face', 'native face use explicitly requests alignment');
    const beforeNavigation = await records();
    await invoke('entry.select', { source: 'faces', file: 'single.png' });
    await page.poll(`document.querySelectorAll('.dz-a .face-selected').length===1`);
    const afterNewImage = await counts();
    await invoke('entry.select', { source: 'faces', file: 'multi-a.png' }); await ready();
    assert.deepEqual(await records(), beforeNavigation, 'image navigation retains the exact valid choices');
    await quiet(afterNewImage, 'return to cached image admits no new inference');
    const invalid = { side: 'a', record: chosen[0].id, face: 'foreign-face' };
    await invoke('workbench.alignment', { mode: 'independent' });
    assert.equal(await invoke('faces.use', invalid), false); assert.equal(await state(`${KZ}.state.diff.alignment`), 'independent');
    await invoke('workbench.close'); await page.poll(`location.pathname!=='/diff'`); await open(); await ready();
    assert.equal(await page.evaluate(`document.querySelector('#faceDetection').getAttribute('aria-pressed')`), 'true');
    await invoke('workbench.mode', { mode: 'full' });
    assert.equal(await page.evaluate(`!!document.querySelector('#faceDetection,.face-feedback')`), false);
    await invoke('workbench.mode', { mode: 'two-up' }); await ready();
    const beforeComposition = await counts(), retained = await records();
    await invoke('workbench.mode', { mode: 'one-up' }); await invoke('workbench.mode', { mode: 'two-up' }); await ready();
    assert.deepEqual(await records(), retained); await quiet(beforeComposition, 'composition keeps cached records');
    // Reload is the app/store lifetime boundary, even with a saved service URL.
    const beforeReload = await counts();
    await page.evaluate(`window.toggleDocument = true`); await page.send('Page.reload');
    await page.poll(`!window.toggleDocument&&!!document.querySelector('.card')`, 20000);
    await open(); await invoke('workbench.alignment', { mode: 'face' });
    await quiet(beforeReload, 'reload resets detection OFF');
    assert.equal(await page.evaluate(`document.querySelector('#faceDetection').getAttribute('aria-pressed')`), 'false');
    // Pending status and an awaited retry retire with the activation, even if the service finishes.
    await config({ healthDelay: 900 }); await page.clickAt('#faceDetection');
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='pending'`);
    await page.evaluate(`(async()=>{window.retiredRetry=${KZ}.handles.invoke('faces.retry');return true;})()`);
    await page.clickAt('#faceDetection'); const statusOff = await counts();
    await sleep(1100); await page.evaluate(`window.retiredRetry`); await quiet(statusOff, 'pending status/retry OFF cannot resume inference');
    assert.equal(await page.evaluate(`!!document.querySelector('.face-feedback')`), false);
    await config({ healthDelay: 0, delay: 900 });
    await page.clickAt('#faceDetection');
    const beforeInfer = statusOff.infer;
    await page.poll(`document.querySelector('.face-status')?.textContent==='Detecting faces'`);
    const deadline = Date.now() + 10000;
    while ((await counts()).infer === beforeInfer) { assert(Date.now() < deadline, 'pending inference started'); await sleep(20); }
    await page.clickAt('#faceDetection'); const inferenceOff = await counts();
    await sleep(1100); await quiet(inferenceOff, 'pending inference OFF cannot admit its queued peer');
    assert.equal(await page.evaluate(`!!document.querySelector('.face-feedback')`), false);
    assert(network.some(r => r.failure), 'browser operational request was aborted');
    await config({ delay: 0 }); await page.clickAt('#faceDetection'); await ready();
    assert.equal((await records())[0].anchor, null, 'old inference cannot select into the new activation');
    // An old retry whose transport ignores abort must not clear a new interval's
    // cached error after that interval has already become ready.
    await config({ fail: true }); await open();
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='error'`);
    await page.evaluate(`(()=>{const original=window.fetch;let hold=true;window.restoreToggleFetch=()=>window.fetch=original;
      window.fetch=async(url,options)=>{const response=await original(url,options);if(hold&&String(url).endsWith('/api/plugins/detector/status')){hold=false;return new Promise(resolve=>window.releaseRetiredStatus=()=>resolve(response));}return response;};})()`);
    await page.evaluate(`(async()=>{window.retiredRetry=${KZ}.handles.invoke('faces.retry');return true;})()`);
    await page.poll(`!!window.releaseRetiredStatus`);
    await page.evaluate(`(async()=>{const s=${KZ};s.handles.invoke('faces.detection.toggle');s.handles.invoke('faces.detection.toggle');})()`);
    await page.poll(`document.querySelector('.face-status')?.dataset.phase==='error'`);
    const beforeRetiredRetry = await counts();
    await page.evaluate(`window.releaseRetiredStatus();window.restoreToggleFetch();window.retiredRetry`);
    await quiet(beforeRetiredRetry, 'old awaited retry cannot clear a new activation error or infer');
    assert.equal(await page.evaluate(`document.querySelector('.face-status').dataset.phase`), 'error');
    await config({ fail: false }); await invoke('faces.retry'); await ready();
    // Save remains available OFF, with no hidden warmup or health call.
    await page.clickAt('#faceDetection'); const beforeSave = await counts();
    await invoke('faces.settings.edit', { value: DETECTOR + '/v2' }); await invoke('faces.settings.save');
    await quiet(beforeSave, 'settings saved OFF without operational detector calls');
    await page.clickAt('#faceDetection'); await ready();
    assert((await records()).every(r => r.detector.serviceUrl === DETECTOR + '/v2'));
    await invoke('faces.settings.edit', { value: DETECTOR }); await invoke('faces.settings.save'); await ready();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(E, 'toggle-proofs.json'), JSON.stringify({ initial, proofs, network, service: await operations(), errors }, null, 2));
    console.log('FACE DETECTION TOGGLE: ALL PASS', JSON.stringify(await counts()));
  } catch (error) {
    await capture('failure').catch(() => {});
    fs.writeFileSync(path.join(E, 'failure.json'), JSON.stringify({ error: String(error.stack), proofs, network, service: await operations(), errors }, null, 2));
    throw error;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
