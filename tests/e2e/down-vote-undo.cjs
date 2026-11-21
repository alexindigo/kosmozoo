// End-to-end judgment restoration through the shared status action.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const NAME = 'undo-image.png', UP = 'undo-up.png', TARGET = 'undo-workflow.png';
const UNDO = '#statusStack button[aria-label="Undo down-vote"]';
const card = name => `.card[data-name=${JSON.stringify(name)}]`;
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
(async () => {
  assert(ENGINE && FAKE && E);
  const page = await CDP.launch(9420, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), proof = {};
  const evaluate = expression => page.evaluate(`(async()=>(${expression}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const set = (name, vote) => invoke('judgment.apply', { id: 'fake:' + name, intent: { type: 'set', patch: { vote } } });
  const vote = async name => (await (await fetch(ENGINE + '/api/collections/fake/entries/' + name)).json()).judgment?.vote ?? null;
  const waitUndo = () => page.poll(`!!document.querySelector(${JSON.stringify(UNDO)})`, 10000);
  const visible = (name, expected = true) => `(async()=>{const s=${KZ};return s.state.view().some(i=>s.state.images[i].filename===${JSON.stringify(name)})===${expected}})()`;
  const restoreCard = async name => {
    await invoke('entry.select', { source: 'fake', file: name });
    await invoke('feed.revealEntry', { id: 'fake:' + name });
    await page.poll(`!!document.querySelector(${JSON.stringify(card(name) + ' .down')})`, 10000);
  };
  const shot = async () => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(E + '/down-vote-undo.png', Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    fs.mkdirSync(E + '/review', { recursive: true });
    for (const [name, selector] of [['header', '#chrome'], ['feed', '#candidatesCol'], ['workspace', '#workspace'], ['status', '#statusCol']]) {
      const clip = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.right,innerWidth)-Math.max(0,r.x),height:Math.min(r.bottom,innerHeight)-Math.max(0,r.y),scale:2}})()`);
      if (clip.width > 0 && clip.height > 0) fs.writeFileSync(`${E}/review/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    }
  };
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: NAME } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'undo' } } };
    assert((await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true,
      publishInputs: [{ name: NAME, fixture: 'flux-basic.png' }], publish: [
        { name: NAME, fixture: 'flux-basic.png', width: 96, height: 64, mtime: 2100010013 },
        { name: UP, fixture: 'flux-lora.png', width: 96, height: 64, mtime: 2100010012 },
        { name: TARGET, fixture: 'flux-lora.png', graph, mtime: 2100010011 },
      ] }) })).ok);
    await page.goto(ENGINE + '/#fake#' + NAME);
    await page.poll(`!!document.querySelector(${JSON.stringify(card(NAME) + ' .down')})`, 20000);
    await set(NAME, null); await set(UP, 'up');
    await page.poll(`document.querySelector(${JSON.stringify(card(NAME) + ' .imgwrap img')})?.naturalWidth>0`, 15000);
    await page.clickAt(card(NAME) + ' .down'); await waitUndo();
    await page.poll(visible(NAME, false)); assert.equal(await vote(NAME), 'down');
    assert(await evaluate(`document.querySelector(${JSON.stringify(UNDO)}).closest('[role=status]').textContent.includes('Down-voted ${NAME} (hidden)')`));
    proof.geometry = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(UNDO)}),r=b.getBoundingClientRect(),m=b.previousElementSibling.getBoundingClientRect();return{buttonCenter:r.y+r.height/2,messageCenter:m.y+m.height/2,right:r.right,viewport:innerWidth,height:r.height}})()`);
    assert(Math.abs(proof.geometry.buttonCenter - proof.geometry.messageCenter) < .5);
    assert(proof.geometry.right <= proof.geometry.viewport && proof.geometry.height > 0);
    await page.poll(`document.querySelector(${JSON.stringify(card(UP) + ' .imgwrap img')})?.naturalWidth>0`, 4000);
    await shot();
    // Keyboard activation of the real native Undo button, not a private callback.
    await evaluate(`document.querySelector(${JSON.stringify(UNDO)}).focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.poll(visible(NAME)); assert.equal(await vote(NAME), null);
    await page.poll(`!document.querySelector(${JSON.stringify(UNDO)})`);
    // A registered vote binding traverses the one dispatcher.
    await restoreCard(UP);
    await evaluate(`${KZ}.actions.keys.register({id:'test.undo.down',key:'x',command:'judgment.apply',args:{target:'current',intent:{type:'toggle',field:'vote',value:'down'}}})`);
    await evaluate('document.activeElement?.blur()');
    await page.keyTrusted('x', { vk: 88 }); await waitUndo();
    await page.poll(visible(UP, false));
    await page.clickAt(UNDO); await page.poll(visible(UP)); assert.equal(await vote(UP), 'up');
    // One bulk-bar action restores mixed previous votes with one toast.
    await invoke('selection.set', { id: 'fake:' + NAME, value: true });
    await invoke('selection.set', { id: 'fake:' + UP, value: true });
    await page.clickAt('#bulkBar .down'); await waitUndo();
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(UNDO)}).length`), 1);
    assert(await evaluate(`document.querySelector(${JSON.stringify(UNDO)}).parentElement.textContent.includes('2 images')`));
    await page.clickAt(UNDO); await page.poll(visible(NAME)); await page.poll(visible(UP));
    assert.equal(await vote(NAME), null); assert.equal(await vote(UP), 'up');
    await invoke('selection.clear');
    // Timing uses the actual browser clock and observes removal, not timer setup.
    await set(NAME, 'down'); await waitUndo();
    proof.lifetime = await evaluate(`new Promise(resolve=>{const b=document.querySelector(${JSON.stringify(UNDO)}),start=performance.now();setTimeout(()=>{const retained=b.isConnected;const observer=new MutationObserver(()=>{if(!b.isConnected){observer.disconnect();resolve({retained,elapsed:performance.now()-start})}});observer.observe(document.querySelector('#statusStack'),{childList:true,subtree:true});},4500)})`);
    assert(proof.lifetime.retained); assert(proof.lifetime.elapsed >= 4800 && proof.lifetime.elapsed < 5800);
    await set(NAME, null);
    // Failed persistence rolls back and offers no Undo.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `*/entries/${NAME}/judgment`, requestStage: 'Request' }] });
    let paused;
    const onPause = event => { const m = JSON.parse(event.data); if (m.method === 'Fetch.requestPaused') paused = m.params; };
    page.ws.addEventListener('message', onPause);
    await evaluate(`(async()=>{window.undoFailure=${KZ}.handles.invoke('judgment.apply',{id:'fake:${NAME}',intent:{type:'set',patch:{vote:'down'}}});return true})()`);
    await page.poll(visible(NAME, false));
    for (const end = Date.now() + 10000; !paused && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 25));
    assert(paused); assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(UNDO)}).length`), 0);
    await page.send('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"controlled rejection"}').toString('base64') });
    await evaluate('window.undoFailure'); await page.poll(visible(NAME));
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(UNDO)}).length`), 0);
    await page.send('Fetch.disable'); page.ws.removeEventListener('message', onPause);
    // A live output picker is another consumer of the same restored judgment.
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + TARGET });
    await addParameter(page, '11.image'); await openImageAdd(page);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    await page.clickAt('.vz-input-feeds [data-value="output"]');
    await page.poll(`!!document.querySelector(${JSON.stringify(option(NAME))})`, 15000);
    await set(NAME, 'down'); await waitUndo();
    await page.poll(`!document.querySelector(${JSON.stringify(option(NAME))})`);
    // The modal retains its input isolation; invoke the same status port here.
    await evaluate(`(async()=>{const s=${KZ};return s.actions.status.run(s.state.chips.find(c=>c.action).slot)})()`);
    await page.poll(`!!document.querySelector(${JSON.stringify(option(NAME))})`);
    assert.equal(await vote(NAME), null);
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/undo-proof.json', JSON.stringify({ ...proof, pageErrors: errors }, null, 2));
    console.log('PASS button/key/bulk Undo, none/up restoration, persisted outcomes, 5-second expiry, failed-write rollback, live picker reprojection and centered action geometry; zero page errors');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
