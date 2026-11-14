const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
const { CDP } = require('./cdp.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const OTHER = process.env.E2E_FAKE2 || 'http://127.0.0.1:18262';
const KZ = '(await import("/store/instance.js")).appStore';

module.exports = async ({ cdp, check }) => {
  const extraSources = ['a-very-long-source-name-that-must-truncate', 'Studio', 'remote-workstation', 'third-renderer'];
  const invoke = (command, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}))()`);
  const capture = async name => {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    fs.writeFileSync(workPath('artifacts', name + '.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const selectors = { picker: '.vz-input-popover', tabs: '.vz-input-tabs', ...(name === 'source-tabs-selected-focus' ? {
      sidebar: '.vz-right', parameters: '.vz-left', title: '.vz-title', header: '#hostPicker', 'focused-tab': '.tabs-tab:focus-visible',
    } : {}) };
    for (const [region, selector] of Object.entries(selectors)) {
      const clip = await cdp.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.width,innerWidth-Math.max(0,r.x)),height:Math.min(r.height,innerHeight-Math.max(0,r.y)),scale:1}:null})()`);
      if (clip) fs.writeFileSync(workPath('artifacts', name + '-' + region + '-review.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    }
  };
  const close = async () => {
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  const open = async () => {
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await addParameter(cdp,'43.image');await require('./variation-add-helpers.cjs').removeRecordedImage(cdp,'43.image');
    await openImageAdd(cdp); await cdp.clickAt('.vz-input-trigger'); await waitForInputPicker(cdp);
  };
  await fetch(OTHER + '/__test/activity', { method: 'POST', body: JSON.stringify({ reset: true }) });
  const form = new FormData(); form.append('image', new Blob([fs.readFileSync(workPath('tests/fixtures/flux-lora.png'))]), 'remote-only.png');
  assert((await fetch(OTHER + '/api/upload/image', { method: 'POST', body: form })).ok);
  const retryForm = new FormData(); retryForm.append('image', new Blob([fs.readFileSync(workPath('tests/fixtures/flux-basic.png'))]), 'retry-image.png');
  assert((await fetch(OTHER + '/api/upload/image', { method: 'POST', body: retryForm })).ok);
  await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ reset: true, captureEnqueue: true }) });
  try {
    await open();
    assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.vz-input-tabs [role=tab]')].map(el=>el.textContent)"), ['fake', 'another']);
    const placement = await cdp.evaluate("(()=>{window.__sourcePopup=document.querySelector('.vz-input-popover');const r=window.__sourcePopup.getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()");
    await capture('source-tabs-target');
    await cdp.evaluate(`window.__tabsFetch=window.fetch;window.__listMode='fail';window.fetch=(...args)=>{
      const url=String(args[0]);
      if(url.includes('/another/entries?kind=input')) {
        if(window.__listMode==='fail') return Promise.resolve(new Response('Controlled failure',{status:503}));
        if(window.__listMode==='pending') return new Promise(resolve=>window.__releaseList=()=>resolve(window.__tabsFetch(...args)));
      }
      return window.__tabsFetch(...args);
    }`);
    await cdp.clickAt('[role=tab][data-value="another"]');
    await cdp.poll("document.querySelector('.vz-input-failure')?.hidden===false");
    assert.equal(await cdp.evaluate("document.querySelector('.vz-input-failure [role=status]').textContent"), "Couldn't list another's imported images.");
    assert(await cdp.evaluate("document.querySelector('.vz-input-failure [role=status]').title.includes('503')"));
    await capture('source-tabs-list-failed');
    await cdp.evaluate("window.__listMode='pending'");
    await cdp.clickAt('.vz-input-failure .vz-thumbnail-retry');
    await cdp.poll("document.querySelector('.vz-input-status')?.textContent==='Reading another imported images...'");
    await capture('source-tabs-list-pending');
    await cdp.evaluate("window.__listMode='ready';window.__releaseList()");
    await cdp.poll("!!document.querySelector('[data-input-name=" + JSON.stringify('remote-only.png') + "]')");
    assert.deepEqual(await cdp.evaluate("(()=>{const popup=document.querySelector('.vz-input-popover'),r=popup.getBoundingClientRect();if(popup!==window.__sourcePopup)throw new Error('Popup replaced');return[r.x,r.y,r.width,r.height]})()"), placement);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-input-popover').matches(':popover-open')"), true);
    await cdp.clickAt('.vz-input-search');
    await cdp.send('Input.insertText', { text: 'remote-only' });
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===1");
    await cdp.clickAt('[role=tab][data-value="fake"]');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===0");
    await cdp.clickAt('[role=tab][data-value="another"]');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===1");
    await cdp.clickAt('.vz-search-clear');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===4");
    await cdp.evaluate(`window.__inputReads=0;window.__failImage=true;window.fetch=(...args)=>{
      const url=String(args[0]);
      if(url.includes('/another/entries/remote-only.png/bytes')&&!url.includes('intent=')) {
        window.__inputReads++;return new Promise(resolve=>window.__releaseImage=()=>resolve(window.__tabsFetch(...args)));
      }
      if(url.includes('/another/entries/retry-image.png/bytes')&&!url.includes('intent=')&&window.__failImage) {
        window.__failImage=false;return Promise.resolve(new Response('Controlled failure',{status:502}));
      }
      return window.__tabsFetch(...args);
    }`);
    await cdp.clickAt('[data-input-name="retry-image.png"]');
    await cdp.poll("!!document.querySelector('[aria-label=" + JSON.stringify('Retry image for retry-image.png') + "]')&&document.querySelectorAll('.vz-image-tile').length===0");
    assert.equal(await cdp.evaluate("document.querySelector('[data-input-name=\"retry-image.png\"]').closest('.vz-thumbnail').querySelector('.vz-thumbnail-failed [role=status]').textContent"), "Couldn't load retry-image.png.");
    assert(await cdp.evaluate("document.querySelector('[data-input-name=\"retry-image.png\"]').closest('.vz-thumbnail').querySelector('.vz-thumbnail-failed [role=status]').title.includes('502')"));
    await cdp.evaluate("document.querySelector('[aria-label=" + JSON.stringify('Retry image for retry-image.png') + "]').focus()");
    await capture('source-tabs-image-failed');
    await cdp.clickAt('[aria-label="Retry image for retry-image.png"]');
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1&&!document.querySelector('.vz-image-check')");
    await cdp.clickAt('[data-input-name="retry-image.png"]');
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===0");
    const tile = '[data-input-name="remote-only.png"]';
    await cdp.clickAt(tile);
    await cdp.poll("[...document.querySelectorAll('.vz-thumbnail-acquiring')].some(el=>el.textContent==='Loading image…')");
    await capture('source-tabs-image-pending');
    await cdp.evaluate('window.__releaseImage()');
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1&&!document.querySelector('.vz-image-check')");
    await cdp.poll(`document.querySelector(${JSON.stringify(tile)}).getAttribute('aria-selected')==='true'`);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-count').textContent"), '1');
    await cdp.clickAt(tile); await cdp.poll("document.querySelectorAll('.vz-image-tile').length===0");
    await cdp.clickAt(tile); await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
    assert.equal(await cdp.evaluate('window.__inputReads'), 1);
    await cdp.evaluate("document.querySelector('[role=tab][data-value=another]').focus()");
    await cdp.keyTrusted('ArrowLeft', { vk: 37 });
    await cdp.poll("document.activeElement.dataset.value==='fake'&&document.activeElement.getAttribute('aria-selected')==='true'");
    await cdp.keyTrusted('ArrowRight', { vk: 39 });
    await cdp.poll("document.activeElement.dataset.value==='another'&&document.activeElement.getAttribute('aria-selected')==='true'");
    const geometry = await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('.vz-input-tabs [role=tab]')].map(el=>el.getBoundingClientRect());return tabs.every(r=>Math.abs(r.top-tabs[0].top)<1)})()");
    assert(geometry);
    const focusGeometry = await cdp.evaluate(`(()=>{
      const tab=document.activeElement,strip=tab.closest('[role=tablist]'),style=getComputedStyle(tab),t=tab.getBoundingClientRect(),s=strip.getBoundingClientRect();
      const client={left:s.left+strip.clientLeft,top:s.top+strip.clientTop,right:s.left+strip.clientLeft+strip.clientWidth,bottom:s.top+strip.clientTop+strip.clientHeight};
      return {focused:tab.matches('[role=tab]:focus-visible'),outline:style.outlineStyle,shadow:style.boxShadow,
        contained:t.left>=client.left-.5&&t.top>=client.top-.5&&t.right<=client.right+.5&&t.bottom<=client.bottom+.5,
        tab:{left:t.left,top:t.top,right:t.right,bottom:t.bottom},client};
    })()`);
    fs.writeFileSync(workPath('artifacts','source-tabs-focus-geometry.json'), JSON.stringify(focusGeometry,null,2)+'\n');
    assert(focusGeometry.focused&&focusGeometry.outline==='none'&&focusGeometry.shadow.includes('inset')&&focusGeometry.contained,JSON.stringify(focusGeometry));
    await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(img=>img.complete&&img.naturalWidth>0)");
    await capture('source-tabs-selected-focus');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...(await cdp.evaluate("(()=>{const r=document.querySelector('[role=tab][data-value=another]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")) });
    await capture('source-tabs-hover');
    await cdp.keyTrusted('Escape', { vk: 27 });
    const result = await invoke('variations.run');
    assert.equal(result.adopted, true, JSON.stringify({ result, message: await cdp.evaluate("document.querySelector('.vz-messages').textContent") }));
    const jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
    assert(jobs.some(job => job.prompt['43'].inputs.image === 'remote-only.png'));
    assert((await (await fetch(FAKE + '/internal/files/input')).json()).some(name => name.startsWith('remote-only.png')));
    await cdp.poll("!document.querySelector('.vz-panel')", 6000);
    check('source tabs: target first, foreign listing, editor-owned File toggle/reuse, dispatcher arrows, one row, upload and Run receipt', true);
    for (const name of extraSources) assert((await invoke('source.add', { name, address: new URL(OTHER).host })).ok);
    await open();
    const overflow = await cdp.evaluate("(()=>{const strip=document.querySelector('.tabs'),tabs=[...strip.querySelectorAll('[role=tab]')];return {overflow:strip.scrollWidth>strip.clientWidth,sameRow:tabs.every(el=>Math.abs(el.getBoundingClientRect().top-tabs[0].getBoundingClientRect().top)<1),labels:tabs.every(el=>getComputedStyle(el.querySelector('.single-line-text')).whiteSpace==='nowrap')}})()");
    assert(overflow.overflow&&overflow.sameRow&&overflow.labels, JSON.stringify(overflow));
    await cdp.evaluate("document.querySelector('[role=tab]').focus()");
    await cdp.keyTrusted('End', { vk: 35 });
    await cdp.poll("document.activeElement.dataset.value==='third-renderer'");
    await capture('source-tabs-overflow');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 820, deviceScaleFactor: 1, mobile: false });
    await cdp.poll("(()=>{const r=document.querySelector('.vz-input-popover').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()");
    assert(await cdp.evaluate("(()=>{const tabs=[...document.querySelectorAll('.vz-input-tabs [role=tab]')].map(el=>el.getBoundingClientRect());return tabs.every(r=>Math.abs(r.top-tabs[0].top)<1)})()"));
    await capture('source-tabs-narrow');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await close();
    for (const id of extraSources) await invoke('source.remove', { id });
    await invoke('source.remove', { id: 'another' });
    await cdp.poll(`(async()=>!${KZ}.state.hosts.another)()`);
    await open();
    assert.equal(await cdp.evaluate("!!document.querySelector('.vz-input-tabs [role=tablist]')"), false);
    await capture('source-tabs-single-source');
    check('source tabs: strip absent with a single ComfyUI source', true);
  } finally {
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) await close();
    await cdp.evaluate("if(window.__tabsFetch)window.fetch=window.__tabsFetch");
    for (const id of extraSources) if (await cdp.evaluate(`(async()=>!!${KZ}.state.hosts[${JSON.stringify(id)}])()`)) await invoke('source.remove', { id });
    await invoke('source.add', { name: 'another', address: new URL(OTHER).host });
    await fetch(FAKE + '/__test/activity', { method: 'POST', body: JSON.stringify({ captureEnqueue: false }) });
  }
};
if (require.main === module) (async () => {
  const cdp = await CDP.launch(9349, { windowSize: '1400,1000' });
  try { await cdp.goto(ENGINE); await cdp.poll(`(async()=>${KZ}.state.images.length>0)()`); await module.exports({ cdp, check: (name, ok) => { assert(ok); console.log('PASS ' + name); } }); }
  finally { await cdp.close(); }
})().catch(error => { console.error(error); process.exit(1); });
