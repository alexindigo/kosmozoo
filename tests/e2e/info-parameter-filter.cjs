const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const path = require('node:path');
const { workPath, temporaryPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
const KZ = '(await import("/store/instance.js")).appStore';
const amount = 0.123456789012345, second = 0.123456789012346;
const literal = '  first\r\n\r\nsecond\rthird\n' + 'fixture paragraph '.repeat(18);
const graph = (withImage, value = amount) => ({
  '10': { class_type: 'FilterFixture', inputs: { amount: second } },
  '2': { class_type: 'FilterFixture', inputs: { amount: value, text: literal, flag: false, empty: '' } },
  ...(withImage ? { '20': { class_type: 'LoadImage', inputs: { image: 'ref.png' } } } : {}),
});
(async () => {
  // Headless Chromium has no input hardware by default. Configure its real
  // desktop media through the driver's existing binary seam; touch emulation
  // below then overrides it to coarse/non-hover. No stylesheet/DOM shim.
  const binary = process.env.CHROME_BIN ?? fs.readdirSync('/ms-playwright').filter(name => /^chromium-\d+$/.test(name))
    .sort().reverse().map(name => path.join('/ms-playwright', name, 'chrome-linux/chrome')).find(name => fs.existsSync(name));
  assert(binary, 'Playwright image supplies Chromium');
  const desktop = temporaryPath('info-filter-desktop-browser');
  fs.writeFileSync(desktop, `#!/bin/sh\nexec ${JSON.stringify(binary)} --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 "$@"\n`, { mode: 0o755 });
  process.env.CHROME_BIN = desktop;
  const page = await CDP.launch(9416, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const edit = (field, value) => invoke('feed.filter.edit', { field, value });
  // Character-producing native keys need the char-bearing keyDown path. The
  // shared driver's rawKeyDown helper is intentionally for navigation keys.
  const activate = async (key, code, vk, text) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const clickFilter = async selector => {
    await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const r = await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    await page.mouse('mouseMoved', r.x + r.width / 2, r.y + r.height / 2);
    await page.poll(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity==='1'`);
    // Metadata publication can replace an equal row while its geometry stays
    // fixed. Hit-test the live control rather than retaining an old DOM node.
    const live = await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    await page.mouse('mousePressed', live.x + live.width / 2, live.y + live.height / 2, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', live.x + live.width / 2, live.y + live.height / 2, { clickCount: 1, buttons: 0 });
  };
  const state = expression => page.evaluate(`(async()=>{const s=${KZ};return ${expression}})()`);
  const shot = async (name, selector) => {
    await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const clip = selector && await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.max(0,r.x-6),y:Math.max(0,r.y-6),width:r.width+12,height:r.height+12,scale:2}})()`);
    const image = await page.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    fs.writeFileSync(workPath(`artifacts/info-parameter-${name}.png`), Buffer.from(image.data, 'base64'));
  };
  const waitModel = async (parameter, value) => {
    await page.poll(`(async()=>{const m=${KZ}.state.feedFilter();return m.parameter===${JSON.stringify(parameter)}&&m.parameterMode==='equals'&&m.parameterValue===${JSON.stringify(value)}})()`);
    await page.poll(`!document.querySelector('#filterMenu').hidden`);
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('filterValue')`), value);
  };
  const select = async name => {
    await invoke('entry.select', { source: 'fake', file: name });
    await page.poll(`document.querySelector('#workspace .ws-name')?.textContent===${JSON.stringify(name)} && !!document.querySelector('#workspace .info-filter-action button')`, 30000);
  };
  try {
    assert.equal(await page.evaluate(`matchMedia('(hover: hover)').matches`), true, 'desktop browser configuration supports hover');
    const response = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: [
      { name: 'info-filter/plain.png', color: [100, 130, 160, 255], graph: graph(false), mtime: 2100000703 },
      { name: 'info-filter/reference.png', color: [160, 130, 100, 255], graph: graph(true), mtime: 2100000702 },
      { name: 'info-filter/other.png', color: [130, 160, 100, 255], graph: graph(false, 9), mtime: 2100000701 },
    ] }) });
    assert(response.ok);
    await page.goto(ENGINE + '/#fake#info-filter/plain.png');
    await page.poll(`(async()=>${KZ}.state.images.length>3000)()`, 60000);
    await invoke('source.refresh');
    // Keep the focused interaction on this scenario's named fixtures while the
    // unchanged 3000-item stack continues background metadata publication. This
    // also gives the row intent a non-default filename condition to preserve.
    await edit('filename', 'info-filter/');
    await page.poll(`document.querySelector('#workspace .info-filter-action button')`, 30000);
    await page.poll(`document.querySelector('.card[data-name="info-filter/plain.png"] img')?.naturalWidth>0`, 30000);
    const rows = '#workspace .info-filter-row[data-parameter="FilterFixture.amount"]';
    const first = rows + ' .info-filter-action button';
    assert.equal(await page.evaluate(`document.querySelectorAll(${JSON.stringify(rows)}).length`), 2);
    await page.evaluate(`document.querySelector(${JSON.stringify(first)}).scrollIntoView({block:'center'})`);
    await page.mouse('mouseMoved', 5, 5);
    const geometry = () => page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(rows)}),v=r.querySelector('.info-filter-content');return [r,v].map(e=>{const b=e.getBoundingClientRect();return[b.x,b.y,b.width,b.height]})})()`);
    const before = await geometry();
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(first)})).opacity`), '0');
    const box = await page.evaluate(`document.querySelector(${JSON.stringify(rows)}).getBoundingClientRect().toJSON()`);
    await page.mouse('mouseMoved', box.x + box.width / 2, box.y + box.height / 2);
    await page.poll(`getComputedStyle(document.querySelector(${JSON.stringify(first)})).opacity==='1'`);
    assert.deepEqual(await geometry(), before, 'hover reserves geometry');
    const centers = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(rows)}),a=r.querySelector('button').getBoundingClientRect(),v=r.querySelector('.info-filter-content').getBoundingClientRect();return [a.y+a.height/2,v.y+v.height/2]})()`);
    assert(Math.abs(centers[0]-centers[1])<1, 'short row text and action share the structural centerline');
    await shot('hover'); await shot('hover-row-2x', rows);
    await page.mouse('mouseMoved', 5, 5);
    await page.evaluate(`window.__infoAction=document.querySelector(${JSON.stringify(first)});__infoAction.focus()`);
    const late = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: [
      { name: 'info-filter/registry.png', color: [90, 100, 110, 255], graph: { '1': { class_type: 'LateFilterFixture', inputs: { token: 'fixture-only' } } }, mtime: 2100000700 },
    ] }) });
    assert(late.ok);
    await invoke('source.refresh');
    await page.poll(`(async()=>${KZ}.state.fieldsList().some(([id])=>id==='LateFilterFixture.token'))()`, 30000);
    assert.equal(await page.evaluate(`__infoAction.isConnected && document.activeElement===__infoAction`), true, 'registry publication retains focused occurrence instead of remounting metadata');
    await page.keyTrusted('Tab', { code: 'Tab', vk: 9 });
    assert.equal(await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(rows + ':nth-of-type(2) .info-filter-action button')})`), true, 'concealed actions remain in native Tab order');
    // Focus the first native action after real keyboard modality is established.
    await page.evaluate(`document.querySelector(${JSON.stringify(first)}).focus()`);
    assert.equal(await page.evaluate(`document.activeElement.matches(':focus-visible')`), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.activeElement).opacity`), '1');
    assert.deepEqual(await geometry(), before, 'focus reserves geometry');
    await shot('focus'); await shot('focus-row-2x', rows);
    await activate('Enter', 'Enter', 13, '\r');
    await waitModel('FilterFixture.amount', String(amount));
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===2)()`, 30000);
    await page.poll(`document.querySelector('.card[data-name="info-filter/plain.png"] img')?.naturalWidth>0`, 30000);
    assert.equal(await page.evaluate(`document.querySelector('#filter-parameterValue').tagName`), 'TEXTAREA');
    assert.equal(await state('s.state.feedFilter().parameterValue'), String(amount), 'not rounded display');
    await page.key('Escape');
    await invoke('selection.set', { id: 'fake:info-filter/other.png', value: true });
    const selected = await state('Object.keys(s.state.selected).filter(id=>s.state.selected[id])');
    // The second occurrence has the same rounded text but its own literal value.
    await clickFilter(rows + ':nth-of-type(2) .info-filter-action button');
    await waitModel('FilterFixture.amount', String(second));
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===3)()`, 30000);
    await clickFilter('#workspace .info-filter-row[data-parameter="FilterFixture.flag"] button');
    await waitModel('FilterFixture.flag', 'false');
    assert.equal(await page.evaluate(`document.querySelector('#filterMenu').hidden`), false, 'repeated intent does not toggle closed');
    assert.deepEqual(await state('Object.keys(s.state.selected).filter(id=>s.state.selected[id])'), selected);
    await invoke('judgment.apply', { id: 'fake:info-filter/plain.png', intent: { type: 'set', patch: { favorite: true, notes: { neg: 'fixture note' } } } });
    for (const mode of ['and', 'or']) {
      await edit('mode', mode); await edit('filename', 'plain'); await edit('directory', 'info-filter');
      await edit('favorite', 'true'); await edit('negativeMode', 'contains'); await edit('negative', 'fixture note');
      const before = await state('s.state.feedFilter()');
      await clickFilter(first);
      await waitModel('FilterFixture.amount', String(amount));
      assert.deepEqual(await state('s.state.feedFilter()'), { ...before, parameter: 'FilterFixture.amount', parameterMode: 'equals', parameterValue: String(amount) });
      await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===${mode === 'and' ? 1 : 4})()`, 30000);
      await page.poll(`document.querySelector('.card[data-name="info-filter/plain.png"] img')?.naturalWidth>0`, 30000);
    }
    await invoke('feed.filter.clear');
    await clickFilter('#workspace .info-filter-row[data-parameter="FilterFixture.text"] button');
    await waitModel('FilterFixture.text', literal);
    const longCenters = await page.evaluate(`(()=>{const r=document.querySelector('#workspace .info-filter-row[data-parameter="FilterFixture.text"]'),a=r.querySelector('button').getBoundingClientRect(),v=r.querySelector('.plabel').getBoundingClientRect();return [a.y+a.height/2,v.y+v.height/2]})()`);
    assert(Math.abs(longCenters[0]-longCenters[1])<1, 'long row heading and action share the structural centerline');
    assert.equal(await page.evaluate(`document.querySelector('#filter-parameterValue').value`), literal.replace(/\r\n?/g, '\n'), 'native textarea projection');
    for (let i = 0; i < 2; i++) { await page.key('Escape'); await invoke('feed.filter.open'); }
    assert.equal(await state('s.state.feedFilter().parameterValue'), literal, 'opening never normalizes Store');
    assert.equal(await page.evaluate(`new URLSearchParams(location.search).get('filterValue')`), literal, 'opening never normalizes URL');
    await edit('parameterMode', 'contains');
    assert.equal(await page.evaluate(`document.querySelector('#filter-parameterValue').tagName`), 'TEXTAREA', 'Contains uses the same multiline control');
    assert.equal(await state('s.state.feedFilter().parameterValue'), literal);
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===3)()`, 30000);
    await edit('parameterMode', 'equals');
    await shot('applied'); await shot('applied-dialog-2x', '#filterMenu');
    await page.clickAt('#filter-parameterValue');
    await page.send('Input.insertText', { text: 'edited ' });
    const edited = await page.evaluate(`document.querySelector('#filter-parameterValue').value`);
    assert.equal(await state('s.state.feedFilter().parameterValue'), edited, 'real edits use native text');
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===0 && ${KZ}.state.current()===null)()`);
    // The existing visibility owner correctly retires a no-longer-matching
    // current after the real edit. Restore the captured fixture intent through
    // its semantic command, not a row that no longer exists.
    await invoke('feed.filter.parameter', { parameter: 'FilterFixture.text', value: literal });
    await waitModel('FilterFixture.text', literal);
    const saved = await page.evaluate('location.href');
    await invoke('entry.navigate', { source: 'fake', file: 'info-filter/reference.png' });
    await page.evaluate('history.back()');
    await page.poll(`location.href===${JSON.stringify(saved)}`);
    await page.poll(`(async()=>${KZ}.state.feedFilter().parameterValue===${JSON.stringify(literal)})()`);
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===3)()`, 30000);
    await page.poll(`document.querySelector('.card[data-name="info-filter/plain.png"] img')?.naturalWidth>0`, 30000);
    await page.evaluate('location.reload()');
    await page.poll(`(async()=>${KZ}.state.feedFilter().parameterValue===${JSON.stringify(literal)})()`, 30000);
    await page.poll(`(async()=>${KZ}.state.entriesWithKnownSize().length===3)()`, 30000);
    await invoke('feed.filter.clear'); await select('info-filter/reference.png');
    assert.equal(await page.evaluate(`!!document.querySelector('#workspace .info-source-images')`), true);
    for (const layout of ['split', 'rev', 'stacked', 'stacked-rev']) {
      await invoke('metadata.layout', { layout });
      await page.key('Escape');
      await clickFilter('#workspace .info-filter-row[data-parameter="FilterFixture.flag"] button');
      await waitModel('FilterFixture.flag', 'false');
      await page.poll(`(async()=>{const s=${KZ},ids=s.state.entriesWithKnownSize();return ids.length===3 && ids.every(i=>s.state.images[i].filename.startsWith('info-filter/'))})()`, 30000);
      await page.poll(`document.querySelector('.card[data-name="info-filter/reference.png"]')`);
      await page.poll(`document.querySelector('#workspace .info-source-images img')?.naturalWidth>0`, 30000);
      assert.equal(await state('s.state.selected["fake:info-filter/other.png"]'), true);
      await shot('reference-' + layout); await shot('reference-' + layout + '-2x', '#workspace');
    }
    await page.key('Escape');
    await page.clickAt('#workspace .imgref');
    await page.poll(`document.querySelector('#workspace .infoimg[data-resource="input:ref.png"]').classList.contains('flash')`);
    const heading = '#workspace .infogroup-head';
    await page.clickAt(heading);
    assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(heading)}).getAttribute('aria-expanded')`), 'false');
    await page.clickAt(heading);
    await page.evaluate(`document.querySelector('#workspace .info-filter-row[data-parameter="FilterFixture.flag"] button').focus()`);
    await activate(' ', 'Space', 32, ' ');
    await waitModel('FilterFixture.flag', 'false');
    await page.key('Escape');
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    assert.equal(await page.evaluate(`matchMedia('(hover: none)').matches && matchMedia('(pointer: coarse)').matches`), true, 'native touch media configuration');
    await page.mouse('mouseMoved', 5, 5);
    await page.evaluate('document.activeElement.blur()');
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('#workspace .info-filter-action button')).opacity`), '1', 'touch discovers action without hover');
    const touchBox = await page.evaluate(`document.querySelector('#workspace .info-filter-action button').getBoundingClientRect().toJSON()`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchBox.x + touchBox.width / 2, y: touchBox.y + touchBox.height / 2 }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.poll(`!document.querySelector('#filterMenu').hidden`);
    await invoke('feed.filter.close');
    await page.evaluate(`(async()=>{const s=${KZ},api=await import('/js/api.mjs'),blob=await(await fetch(api.entryBytesUrl('fake','info-filter/plain.png'))).blob();await s.actions.anchors.addFiles([new File([blob],'info-filter-anchor.png',{type:'image/png'})])})()`);
    await invoke('workspace.select', { space: 'anchors' });
    await page.poll(`(async()=>!!${KZ}.state.anchors.find(a=>a.name==='info-filter-anchor.png')?.meta?.nodes?.length)()`);
    await invoke('anchor.info.open', { name: 'info-filter-anchor.png' });
    await page.poll(`document.querySelectorAll('#infoPanel .infogroup').length>0`);
    assert.equal(await page.evaluate(`document.querySelectorAll('#infoPanel .info-filter-action, #workspace .info-filter-action').length`), 0, 'anchor surfaces do not inherit feed filter controls');
    await invoke('anchor.info.close');
    await invoke('anchor.remove', { name: 'info-filter-anchor.png' });
    await invoke('workspace.select', { space: 'details' });
    assert.deepEqual(errors, []);
    console.log('ok Info filter: exact occurrence, atomic replacement, feed/selection, both branches/layouts, literal CRLF, native edit, URL/Back, hover/focus/keyboard/touch geometry and reference/disclosure');
  } catch (error) {
    console.error('fixture diagnostics', await state('({model:s.state.feedFilter(),current:s.state.current(),count:s.state.entriesWithKnownSize().length})'), errors);
    throw error;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
