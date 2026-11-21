// Real-browser proof of the Variations Space peek: picker tabs (imported,
// generated, Pexels) and the chosen set, through trusted pointer and key input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, PEXELS = process.env.E2E_PEXELS, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const WIDE = 'peek-wide.png', TALL = 'peek-tall.png', OUT = 'peek-output.png', TARGET = 'peek-target.png';
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && PEXELS && E, 'Explicit owned stack and evidence required');
  fs.mkdirSync(E, { recursive: true });
  const page = await CDP.launch(9461, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), proof = {};
  // A renderer that stops answering must fail the run instead of hanging it.
  const send = page.send.bind(page);
  page.send = (method, params) => Promise.race([send(method, params), new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`CDP ${method} unanswered: ${JSON.stringify(params ?? {}).slice(0, 160)}`)), 20000))]);
  const evaluate = text => page.evaluate(`(async()=>(${text}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const waitName = name => page.poll(`!!document.querySelector(${JSON.stringify(option(name))})`, 15000);
  const space = (type, extra = {}) => page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    ...(type === 'keyDown' ? { text: ' ', unmodifiedText: ' ' } : {}), ...extra });
  const hover = async selector => {
    const box = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.mouse('mouseMoved', box.x, box.y);
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).matches(':hover')`);
  };
  const probe = `(()=>{const layer=document.querySelector('.vz-peek');if(!layer)return{mounted:false,open:false};
    const frame=layer.querySelector('.vz-peek-frame'),image=layer.querySelector('.vz-peek-image.is-shown'),r=frame.getBoundingClientRect();
    const centre=document.elementFromPoint(innerWidth/2,innerHeight/2);
    return{mounted:true,open:layer.matches(':popover-open'),src:image?.getAttribute('src')??null,natural:image&&image.complete?[image.naturalWidth,image.naturalHeight]:null,
      box:{left:r.left,top:r.top,width:r.width,height:r.height},backdrop:getComputedStyle(layer.querySelector('.vz-peek-backdrop')).opacity,
      running:layer.getAnimations({subtree:true}).filter(a=>a.playState==='running').length,images:layer.querySelectorAll('.vz-peek-image').length,
      pointer:getComputedStyle(layer).pointerEvents,underneath:!!centre&&!centre.closest('.vz-peek'),viewport:[innerWidth,innerHeight]}})()`;
  const peekState = () => evaluate(probe);
  const settledOpen = src => page.poll(`(()=>{const s=${probe};return s.open&&s.src===${JSON.stringify(src)}&&s.natural&&s.running===0&&s.backdrop==='1'?s:null})()`, 8000);
  const closed = () => page.poll(`(()=>{const s=${probe};return !s.open&&s.images===0?s:null})()`, 3000);
  const fitted = async state => {
    const expected = await evaluate(`(async()=>{const {peekBox}=await import('/features/variations/image-peek.js');return peekBox({width:${state.natural[0]},height:${state.natural[1]}},{width:innerWidth,height:innerHeight})})()`);
    for (const key of ['left', 'top', 'width', 'height']) assert(Math.abs(state.box[key] - expected[key]) <= 1, `fitted ${key}: ${JSON.stringify({ state, expected })}`);
    return expected;
  };
  const scrolls = `[...document.querySelectorAll('*')].filter(el=>!el.closest('.vz-peek')&&(el.scrollHeight>el.clientHeight+1||el.scrollTop>0)).map(el=>[el.className||el.tagName,el.scrollTop]).concat([['window',scrollY]])`;
  const tiles = `[...document.querySelectorAll('.vz-input-option,.vz-image-tile')].map(el=>{const r=el.getBoundingClientRect(),img=el.querySelector('img');return[el.dataset.inputName??el.dataset.imageName,el.getAttribute('aria-selected'),img?.getAttribute('src'),Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]})`;
  const tileSrc = selector => evaluate(`document.querySelector(${JSON.stringify(selector + ' img')}).getAttribute('src')`);
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: WIDE } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'peek' } } };
    assert((await control(FAKE, { reset: true, publishInputs: [
      { name: WIDE, fixture: 'flux-basic.png', width: 96, height: 64, color: [210, 40, 40, 255] },
      { name: TALL, fixture: 'flux-basic.png', width: 64, height: 96, color: [40, 70, 210, 255] }],
    publish: [{ name: OUT, fixture: 'flux-basic.png', width: 80, height: 80, color: [40, 170, 70, 255], mtime: 2100020002 },
      { name: TARGET, fixture: 'flux-lora.png', graph, mtime: 2100020001 }] })).ok);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake#' + TARGET);
    await page.poll(`(async()=>${KZ}.state.images.length>0)()`, 20000);
    const service = await evaluate(`fetch('/api/features/variations/pexels/services',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Peek photos',url:${JSON.stringify(PEXELS + '/v1')}})}).then(r=>r.status)`);
    assert.equal(service, 201);
    // Observe animation requests made by the overlay only (duration/easing contract).
    await evaluate(`(()=>{window.peekMotion=[];const native=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.closest?.('.vz-peek'))window.peekMotion.push({part:this.className,duration:options?.duration,easing:options?.easing});return native.call(this,frames,options)};return true})()`);
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + TARGET });
    await addParameter(page, '11.image');
    await openImageAdd(page); await page.clickAt('.vz-image-add > .vz-input-picker .vz-input-trigger'); await waitForInputPicker(page);
    await waitName(WIDE); await waitName(TALL);
    await page.poll(`[${JSON.stringify(option(WIDE))},${JSON.stringify(option(TALL))}].every(s=>{const i=document.querySelector(s+' img');return i?.complete&&i.naturalWidth>0})`);
    await evaluate(`(()=>{window.peekEverOpen=false;const tick=()=>{if(document.querySelector('.vz-peek:popover-open'))window.peekEverOpen=true;window.peekTick=requestAnimationFrame(tick)};tick();return true})()`);

    console.log('step 1');
    // 1. Space typed into the search box is text, never a peek.
    assert(!await evaluate(`document.activeElement.matches('.vz-input-search')`));
    await page.clickAt('.vz-input-search');
    assert(await evaluate(`document.activeElement.matches('.vz-input-search')`));
    await hover(option(WIDE));
    await space('keyDown'); await space('keyUp');
    await page.poll(`document.querySelector('.vz-input-search').value===' '`);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    assert(!await evaluate('window.peekEverOpen'), 'search box Space opened a peek');
    await page.clickAt('.vz-search-clear'); await waitName(WIDE);
    proof.search = 'typed a space, no peek';

    console.log('step 2');
    // 2. Hovered candidate (focus on an option, not text): fly out, hold, repeat.
    await page.keyTrusted('ArrowRight', { vk: 39 });
    await page.poll(`document.activeElement.matches('.vz-input-option')`);
    await hover(option(WIDE));
    const before = { scrolls: await evaluate(scrolls), tiles: await evaluate(tiles), focus: await evaluate(`document.activeElement.dataset.inputName`) };
    const wideSrc = await tileSrc(option(WIDE));
    await space('keyDown');
    const opened = await settledOpen(wideSrc);
    assert.deepEqual(opened.natural, [96, 64]); proof.wideBox = await fitted(opened);
    assert.equal(opened.pointer, 'none'); assert(opened.underneath, 'pointer-transparent overlay');
    assert.equal(await evaluate(`document.querySelector('.vz-input-search').value`), '', 'peek keydown inserted no text');
    const motion = await evaluate('window.peekMotion');
    assert(motion.length >= 2 && motion.every(m => m.duration >= 150 && m.duration <= 200 && m.easing === 'ease-out'), JSON.stringify(motion));
    for (let index = 0; index < 3; index++) await space('keyDown', { autoRepeat: true });
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const held = await peekState();
    assert(held.open && held.src === wideSrc && held.running === 0, 'auto-repeat keeps the held peek');
    assert.equal((await evaluate('window.peekMotion')).length, motion.length, 'auto-repeat starts no animation');
    assert.deepEqual(await evaluate(scrolls), before.scrolls, 'no page scroll while held');
    const capture = async name => fs.writeFileSync(`${E}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    await capture('space-peek-candidate');

    console.log('step 3');
    // 3. Switching tiles while held keeps a decoded frame on every rendered frame.
    await evaluate(`(()=>{window.peekGaps=0;window.peekFrames=0;const tick=()=>{const i=document.querySelector('.vz-peek-image.is-shown');window.peekFrames++;if(!i||!i.complete||!i.naturalWidth)window.peekGaps++;window.peekSwitch=requestAnimationFrame(tick)};tick();return true})()`);
    const tallSrc = await tileSrc(option(TALL));
    await hover(option(TALL));
    const switched = await settledOpen(tallSrc);
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const gaps = await evaluate('(cancelAnimationFrame(window.peekSwitch),{gaps:window.peekGaps,frames:window.peekFrames})');
    assert.equal(gaps.gaps, 0, 'no frame without a decoded picture: ' + JSON.stringify(gaps));
    assert.deepEqual(switched.natural, [64, 96]); proof.tallBox = await fitted(switched);

    console.log('step 4');
    // 4. Release returns to the tile; tiles, selection, focus and scroll are unchanged.
    const motionBeforeRelease = (await evaluate('window.peekMotion')).length;
    await space('keyUp');
    await closed();
    assert((await evaluate('window.peekMotion')).length > motionBeforeRelease, 'release animates back');
    assert.deepEqual(await evaluate(tiles), before.tiles, 'tiles unchanged');
    assert.deepEqual(await evaluate(scrolls), before.scrolls, 'no page scroll after release');
    assert.equal(await evaluate(`document.activeElement.dataset.inputName`), before.focus);
    proof.candidates = { motion, gaps };

    console.log('step 5');
    // 5. Generated tab: a focused tab button neither scrolls nor activates.
    await page.clickAt('.vz-input-feeds [data-value="output"]'); await waitName(OUT);
    await page.poll(`(()=>{const i=document.querySelector(${JSON.stringify(option(OUT) + ' img')});return i?.complete&&i.naturalWidth>0})()`);
    const outSrc = await tileSrc(option(OUT));
    const outBefore = await evaluate(tiles);
    await hover(option(OUT)); await space('keyDown');
    assert.deepEqual((await settledOpen(outSrc)).natural, [80, 80]);
    await space('keyUp'); await closed();
    assert.deepEqual(await evaluate(tiles), outBefore);
    assert.equal(await evaluate(`document.querySelector('.vz-input-feeds [data-value="output"]').getAttribute('aria-selected')`), 'true');

    console.log('step 6');
    // 6. Window blur ends a held peek.
    await hover(option(OUT)); await space('keyDown'); await settledOpen(outSrc);
    await evaluate(`(window.dispatchEvent(new Event('blur')),true)`); await closed();
    await space('keyUp');

    console.log('step 7');
    // 7. The chosen set: the recorded tile peeks its own picture; the focused
    //    trigger is not activated by the released Space.
    await page.keyTrusted('Escape', { vk: 27 }); await page.poll(`!document.querySelector('.vz-input-popover')`);
    const tile = '.vz-image-tile[data-image-kind="reference"]', preview = tile + ' .vz-image-preview';
    await page.poll(`(()=>{const i=document.querySelector(${JSON.stringify(tile + ' img')});return i?.complete&&i.naturalWidth>0})()`);
    const chosenSrc = await tileSrc(tile), chosenBefore = await evaluate(tiles), focused = await evaluate(`document.activeElement.className`);
    await hover(preview); await space('keyDown');
    assert.deepEqual((await settledOpen(chosenSrc)).natural, [96, 64]);
    await space('keyUp'); await closed();
    assert.deepEqual(await evaluate(tiles), chosenBefore, 'chosen tile unchanged');
    assert(!await evaluate(`!!document.querySelector('.vz-input-popover')`), 'released Space activated nothing');
    assert.equal(await evaluate(`document.activeElement.className`), focused);
    proof.chosen = chosenSrc;

    console.log('step 8');
    // 8. Pexels: the thumbnail shows first, then the full image replaces it.
    await page.clickAt('.vz-image-external .vz-input-trigger'); await waitForInputPicker(page);
    await page.poll(`(()=>{const i=document.querySelector('.vz-image-external .vz-input-option img');return i?.complete&&i.naturalWidth>0})()`, 15000);
    await page.keyTrusted('ArrowRight', { vk: 39 }); await page.poll(`document.activeElement.matches('.vz-input-option')`);
    const photo = `.vz-image-external .vz-input-option[data-input-name=${JSON.stringify(await evaluate(`document.querySelector('.vz-image-external .vz-input-option').dataset.inputName`))}]`;
    await page.poll(`(()=>{const i=document.querySelector(${JSON.stringify(photo + ' img')});return i?.complete&&i.naturalWidth>0})()`);
    const thumbSrc = await tileSrc(photo);
    assert(thumbSrc.includes('/thumbnail?'));
    await evaluate(`(()=>{window.peekSources=[];new MutationObserver(()=>{const i=document.querySelector('.vz-peek-image.is-shown');const s=i?.getAttribute('src');if(s&&window.peekSources.at(-1)!==s)window.peekSources.push(s)}).observe(document.querySelector('.vz-peek'),{subtree:true,attributes:true,childList:true});return true})()`);
    await hover(photo); await space('keyDown');
    const full = thumbSrc.replace('/thumbnail?', '/image?');
    const pexels = await settledOpen(full);
    const sources = await evaluate('window.peekSources');
    assert.deepEqual(sources, [thumbSrc, full], 'thumbnail first, then the full image');
    proof.pexels = { sources, natural: pexels.natural, box: await fitted(pexels) };
    await capture('space-peek-mid');
    await space('keyUp'); await closed();

    console.log('step 9');
    // 9. Reduced motion: no animation, just show and hide.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    const motionCount = (await evaluate('window.peekMotion')).length;
    await hover(photo); await space('keyDown');
    await settledOpen(full);
    await space('keyUp');
    assert(!(await peekState()).open, 'reduced motion hides immediately');
    assert.equal((await evaluate('window.peekMotion')).length, motionCount, 'reduced motion requests no animation');
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });

    console.log('step 10');
    // 10. Closing the dialog ends a held peek.
    await hover(photo); await space('keyDown'); await settledOpen(full);
    // The close intent settles only once the unsent-draft decision is answered.
    await evaluate(`(async()=>{const store=${KZ};window.peekClose=store.handles.invoke('variations.close',{});return true})()`);
    await page.poll(`!!document.querySelector('.vz-discard-confirm') || !document.querySelector('.vz-root')`);
    // The overlay is pointer-transparent: the decision below it stays clickable.
    if (await evaluate(`!!document.querySelector('.vz-root')`)) await page.clickAt('.vz-discard-confirm');
    await page.poll(`!document.querySelector('.vz-root')&&!document.querySelector('.vz-peek')`);
    await evaluate('window.peekClose');
    await space('keyUp');
    await evaluate('(cancelAnimationFrame(window.peekTick),true)');
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/space-peek-proof.json', JSON.stringify({ ...proof, pageErrors: errors }, null, 2));
    console.log('PASS space peek: search typing, fitted fly-out, repeat, flicker-free switch, release, generated tab, blur, chosen set, Pexels full swap, reduced motion, dialog close; no page errors');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
