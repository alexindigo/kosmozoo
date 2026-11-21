// Real Chromium: picked-image rotation buttons, Alt direction, composed turns,
// the actual uploaded/archived bytes and history recall. Runs in the owned VM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const TARGET = 'rotate-target.png', ROW = '[data-image-id="11.image"]';
const CW = 'M9 4.55a8 8 0 0 1 6 14.9', CCW = 'M15 4.55a8 8 0 0 0 -6 14.9';
const tile = name => `${ROW} .vz-image-tile[data-image-name=${JSON.stringify(name)}]`;
const rotateButton = name => `${tile(name)} .vz-image-rotate button`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const control = body => fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && E, 'Explicit owned stack and evidence required');
  fs.mkdirSync(E, { recursive: true });
  const page = await CDP.launch(9441, { windowSize: '1400,1000' }), errors = await collectPageErrors(page);
  const evaluate = text => page.evaluate(`(async()=>(${text}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const shot = async name => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(`${E}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  };
  const names = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(ROW + ' .vz-image-tile')})].map(el=>el.dataset.imageName)`);
  const settled = () => page.poll(`!document.querySelector(${JSON.stringify(ROW + ' .vz-image-check')})`, 15000);
  const button = name => evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(rotateButton(name))});return{label:b.getAttribute('aria-label'),title:b.title,cw:b.innerHTML.includes(${JSON.stringify(CW)}),ccw:b.innerHTML.includes(${JSON.stringify(CCW)})}})()`);
  const alt = type => page.send('Input.dispatchKeyEvent', { type, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, nativeVirtualKeyCode: 18, modifiers: type === 'keyUp' ? 0 : 1 });
  const center = selector => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const altClick = async selector => {
    const { x, y } = await center(selector);
    await page.mouse('mouseMoved', x, y, { modifiers: 1 });
    await page.mouse('mousePressed', x, y, { clickCount: 1, buttons: 1, modifiers: 1 });
    await page.mouse('mouseReleased', x, y, { clickCount: 1, buttons: 0, modifiers: 1 });
  };
  const rotate = async (from, to, withAlt = false) => {
    const index = (await names()).indexOf(from);
    if (withAlt) await altClick(rotateButton(from)); else await page.clickAt(rotateButton(from));
    await page.poll(`!!document.querySelector(${JSON.stringify(tile(to))})`, 15000); await settled();
    assert.equal((await names()).indexOf(to), index, `${to} keeps the tile position`);
  };
  // Decode in the page: dimensions and RGBA of actual bytes.
  const pixels = (bytes, name = 'image') => evaluate(`(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}),c=>c.charCodeAt(0));
    const bitmap=await createImageBitmap(new Blob([bytes]));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    return{name:${JSON.stringify(name)},width:bitmap.width,height:bitmap.height,data:[...context.getImageData(0,0,bitmap.width,bitmap.height).data]}})()`);
  const thumbnail = name => evaluate(`(async()=>{const img=document.querySelector(${JSON.stringify(tile(name) + ' img')});return{width:img.naturalWidth,height:img.naturalHeight}})()`);
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: 'rotate-current.png' } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'rotate' } } };
    assert((await control({ reset: true, captureEnqueue: true, publishInputs: [{ name: 'rotate-current.png', fixture: 'flux-basic.png', width: 64, height: 64, color: [90, 90, 90, 255] }],
      publish: [{ name: TARGET, fixture: 'flux-lora.png', graph, mtime: 2100009102 }] })).ok);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fake'); await page.poll(`(async()=>${KZ}.state.images.some(i=>i.filename===${JSON.stringify(TARGET)}))()`, 20000);
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + TARGET }); await addParameter(page, '11.image'); await removeRecordedImage(page, '11.image');
    // Three browser Files: a 2x1 red|blue image, an opaque 96x64 gradient with a
    // top-left marker, and an unrotated striped image.
    await openImageAdd(page, ROW);
    await evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=1;const c=canvas.getContext('2d');
      c.fillStyle='rgb(255,0,0)';c.fillRect(0,0,1,1);c.fillStyle='rgb(0,0,255)';c.fillRect(1,0,1,1);
      const wide=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      const art=document.createElement('canvas');art.width=96;art.height=64;const a=art.getContext('2d'),fill=a.createImageData(96,64);
      for(let y=0;y<64;y++)for(let x=0;x<96;x++){const i=(y*96+x)*4,mark=x<24&&y<24;fill.data.set(mark?[255,255,255,255]:[Math.round(x*255/95),Math.round(y*255/63),128,255],i)}
      a.putImageData(fill,0,0);const photo=await new Promise(resolve=>art.toBlob(resolve,'image/png'));
      window.rotatePhoto=btoa(String.fromCharCode(...new Uint8Array(await photo.arrayBuffer())));
      const stripes=document.createElement('canvas');stripes.width=64;stripes.height=64;const s=stripes.getContext('2d');
      for(let i=0;i<8;i++){s.fillStyle=i%2?'rgb(70,110,170)':'rgb(200,170,90)';s.fillRect(0,i*8,64,8)}
      const plain=await new Promise(resolve=>stripes.toBlob(resolve,'image/png'));
      window.rotatePlain=btoa(String.fromCharCode(...new Uint8Array(await plain.arrayBuffer())));
      const dt=new DataTransfer();dt.items.add(new File([wide],'wide.png',{type:'image/png'}));
      dt.items.add(new File([photo],'photo.png',{type:'image/png'}));
      dt.items.add(new File([plain],'plain.png',{type:'image/png'}));
      const input=document.querySelector(${JSON.stringify(ROW + ' .vz-imgfilespick')});input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await page.poll(`document.querySelectorAll(${JSON.stringify(ROW + ' .vz-image-tile')}).length===3`); await settled();
    assert.deepEqual(await names(), ['wide.png', 'photo.png', 'plain.png']);
    const original = await pixels(Buffer.from(await evaluate('window.rotatePhoto'), 'base64'), 'photo');
    assert.deepEqual([original.width, original.height], [96, 64]);

    // Clockwise by default: icon, label and the rotated thumbnail.
    assert.deepEqual(await button('wide.png'), { label: 'Rotate clockwise', title: 'Rotate clockwise', cw: true, ccw: false });
    await rotate('wide.png', 'wide_r90.png');
    await waitForSelectedPreviews(page);
    assert.deepEqual(await thumbnail('wide_r90.png'), { width: 1, height: 2 });
    assert.equal(await evaluate(`document.activeElement?.closest('.vz-image-rotate')?.parentElement?.dataset.imageName`), 'wide_r90.png', 'focus follows the rotated tile');
    console.log('PASS clockwise rotation replaces the tile in place');

    // Alt/Option flips every tile's icon, label and direction while held.
    await alt('rawKeyDown');
    await page.poll(`[...document.querySelectorAll(${JSON.stringify(ROW + ' .vz-image-rotate button')})].every(b=>b.getAttribute('aria-label')==='Rotate counter-clockwise'&&b.innerHTML.includes(${JSON.stringify(CCW)}))`);
    assert.deepEqual(await button('photo.png'), { label: 'Rotate counter-clockwise', title: 'Rotate counter-clockwise', cw: false, ccw: true });
    await rotate('photo.png', 'photo_r270.png', true);
    const hover = await center(tile('photo_r270.png'));
    await page.mouse('mouseMoved', hover.x, hover.y, { modifiers: 1 });
    await page.poll(`document.querySelector('.vz-count')?.textContent==='3'`, 15000);
    // Overlay controls share one inset: equal gaps to the tile's facing edges.
    const gaps = await evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(tile('photo_r270.png'))}).getBoundingClientRect(),
      x=document.querySelector(${JSON.stringify(tile('photo_r270.png') + ' .vz-image-remove button')}).getBoundingClientRect(),
      r=document.querySelector(${JSON.stringify(rotateButton('photo_r270.png'))}).getBoundingClientRect(),op=getComputedStyle(document.querySelector(${JSON.stringify(rotateButton('photo_r270.png'))}).parentElement).opacity;
      return{removeTop:x.top-t.top,removeRight:t.right-x.right,rotateBottom:t.bottom-r.bottom,rotateRight:t.right-r.right,size:[x.width,x.height,r.width,r.height],opacity:op}})()`);
    for (const value of [gaps.removeRight, gaps.rotateBottom, gaps.rotateRight]) assert(Math.abs(value - gaps.removeTop) <= 1, JSON.stringify(gaps));
    assert.deepEqual(gaps.size.slice(0, 2), gaps.size.slice(2)); assert.equal(gaps.opacity, '1');
    await shot('picked-image-rotate-alt');
    await alt('keyUp');
    await page.poll(`[...document.querySelectorAll(${JSON.stringify(ROW + ' .vz-image-rotate button')})].every(b=>b.getAttribute('aria-label')==='Rotate clockwise'&&b.innerHTML.includes(${JSON.stringify(CW)}))`);
    console.log('PASS Alt flips icon, label and direction for every tile');

    // Composition is over the original: 270 + cw restores the exact File; two more turns give 180.
    const before = await thumbnail('photo_r270.png');
    assert.deepEqual(before, { width: original.height, height: original.width });
    await rotate('photo_r270.png', 'photo.png');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(tile('photo.png'))}).dataset.imageKind`), 'upload');
    await rotate('photo.png', 'photo_r90.png'); await rotate('photo_r90.png', 'photo_r180.png');
    assert.deepEqual(await names(), ['wide_r90.png', 'photo_r180.png', 'plain.png']);
    await waitForSelectedPreviews(page);
    await page.poll(`document.querySelector('.vz-count')?.textContent==='3'`, 15000);
    await shot('picked-image-rotate');
    console.log('PASS turns compose from the original and restore it exactly');

    // Run: uploaded and archived bytes are the rotated pixels.
    await page.poll(`document.querySelector('.vz-count')?.textContent==='3'&&!document.querySelector('.vz-run').disabled`, 15000);
    await page.clickAt('.vz-run');
    let jobs = [];
    for (const start = Date.now(); jobs.length < 3 && Date.now() - start < 60000; await new Promise(resolve => setTimeout(resolve, 100)))
      jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
    assert.equal(jobs.length, 3, await evaluate(`document.querySelector('.vz-right')?.textContent`));
    const uploaded = jobs.map(job => job.prompt['11'].inputs.image);
    assert.deepEqual(uploaded.map(name => name.replace(/ \[input\]$/, '')), ['wide_r90.png', 'photo_r180.png', 'plain.png']);
    const view = async name => Buffer.from(await (await fetch(FAKE + '/api/view?' + new URLSearchParams({ filename: name.replace(/ \[input\]$/, ''), type: 'input' }))).arrayBuffer());
    const wideBytes = await view(uploaded[0]), photoBytes = await view(uploaded[1]);
    const wide = await pixels(wideBytes, 'wide_r90');
    assert.deepEqual([wide.width, wide.height], [1, 2]);
    assert.deepEqual(wide.data, [255, 0, 0, 255, 0, 0, 255, 255], 'cw turn puts the left (red) pixel on top');
    const turned = await pixels(photoBytes, 'photo_r180');
    assert.deepEqual([turned.width, turned.height], [original.width, original.height]);
    let mismatches = 0;
    for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) for (let c = 0; c < 4; c++)
      if (turned.data[((original.height - 1 - y) * original.width + (original.width - 1 - x)) * 4 + c] !== original.data[(y * original.width + x) * 4 + c]) mismatches++;
    assert.equal(mismatches, 0, 'every 180-degree pixel equals the original pixel');
    assert.equal(hash(await view(uploaded[2])), hash(Buffer.from(await evaluate('window.rotatePlain'), 'base64')));
    await page.poll(`!document.querySelector('.vz-panel')`, 15000);
    const list = await evaluate(`fetch('/api/features/variations/history').then(r=>r.json())`);
    const saved = list.items[0], detail = await evaluate(`fetch('/api/features/variations/history/${saved.id}').then(r=>r.json())`);
    const items = detail.recipe.images['11.image'].values.items;
    assert.deepEqual(items.map(item => item.name), ['wide_r90.png', 'photo_r180.png', 'plain.png']);
    const archived = await evaluate(`fetch('/api/features/variations/history/${saved.id}/resources/${items[0].resourceId}/bytes').then(async r=>btoa(String.fromCharCode(...new Uint8Array(await r.arrayBuffer()))))`);
    assert.equal(hash(Buffer.from(archived, 'base64')), hash(wideBytes), 'archived bytes equal the uploaded rotated bytes');
    assert.equal(detail.resources.find(resource => resource.id === items[1].resourceId).hash, hash(photoBytes));
    console.log('PASS uploaded and archived bytes are rotated and pixel-correct');

    // History recall shows the rotated items; a recalled archive item rotates too.
    await page.clickAt('[data-workspace="variation-history"]');
    await page.poll(`!!document.querySelector('[data-history-id="${saved.id}"] .vh-recall')`, 15000);
    await page.clickAt(`[data-history-id="${saved.id}"] .vh-recall`);
    await page.poll(`document.querySelectorAll(${JSON.stringify(ROW + ' [data-image-kind="archive"]')}).length===3`, 20000);
    assert.deepEqual(await names(), ['wide_r90.png', 'photo_r180.png', 'plain.png']);
    await waitForSelectedPreviews(page);
    assert.deepEqual(await thumbnail('wide_r90.png'), { width: 1, height: 2 });
    await rotate('wide_r90.png', 'wide_r90_r270.png', true);
    await waitForSelectedPreviews(page);
    assert.deepEqual(await thumbnail('wide_r90_r270.png'), { width: 2, height: 1 });
    await alt('keyUp');
    await rotate('wide_r90_r270.png', 'wide_r90.png');
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(tile('wide_r90.png'))}).dataset.imageKind`), 'archive');
    console.log('PASS history recall shows rotated items and archive items rotate back exactly');
    await evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
    await page.poll(`!document.querySelector('.vz-panel')`);
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/rotate-proof.json', JSON.stringify({ uploaded, wide, saved: saved.id, items }, null, 2));
    console.log('PASS picked image rotation');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
