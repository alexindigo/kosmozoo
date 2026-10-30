// Consumer proof: hostile input names decode through real engine/Comfy bytes;
// preview failure is distinct from selection and byte-comparison evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18261';
const names = ['thumb-#athena.png', 'thumb-%2F%25.png', 'thumb-?query.png', 'thumb-space café 日本.png',
  'thumb-literal [input].png', 'thumb-' + 'x'.repeat(190) + '.png'];
const KZ = `(await import('/store/instance.js')).appStore`;
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const tile = name => `.vz-image-tile[data-image-name=${JSON.stringify(name)}]`;

async function thumbnails({ cdp, check }) {
  const shot = async state => {
    if (!process.env.E2E_SHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${process.env.E2E_SHOTS}-${state}.png`, Buffer.from(data, 'base64'));
  };
  const geometry = async state => {
    const observed = await cdp.evaluate(`(()=>{const t=document.querySelector('.vz-input-option'),i=t.querySelector('img'),a=t.getBoundingClientRect(),b=i.getBoundingClientRect(),retry=t.parentElement.querySelector('.vz-thumbnail-retry'),r=retry.getBoundingClientRect();return {width:a.width,height:a.height,center:Math.abs((a.top+a.bottom-b.top-b.bottom)/2),image:getComputedStyle(i).visibility,retry:retry.parentElement.hidden||r.left>=a.left&&r.right<=a.right&&r.top>=a.top&&r.bottom<=a.bottom}})()`);
    assert.equal(observed.width, 96); assert.equal(observed.height, 96); assert(observed.center < 1); assert(observed.retry);
    assert.equal(observed.image, state === 'loaded' ? 'visible' : 'hidden');
    console.log('THUMB_GEOMETRY ' + JSON.stringify({ state, ...observed }));
  };
  const bytes = fs.readFileSync(workPath('tests/fixtures/flux-lora.png'));
  for (const name of names) {
    const form = new FormData(); form.append('image', new Blob([bytes]), name);
    const reply = await fetch(ENGINE + '/api/collections/fake/entries', { method: 'POST', body: form });
    assert(reply.ok); const receipt = await reply.json(); assert.equal(receipt.name, name);
    console.log('UPLOAD_NAME ' + JSON.stringify({ requested: name, receipt }));
  }
  console.log('INPUT_CATALOGUE ' + await (await fetch(ENGINE + '/api/collections/fake/entries?kind=input')).text());
  await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
  await cdp.poll("!!document.querySelector('.card')", 20000);
  await cdp.evaluate(`(async()=>${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'}))()`);
  await cdp.poll("!!document.querySelector('.vz-input-trigger')");
  await cdp.clickAt('.vz-input-trigger');
  await cdp.poll("document.querySelectorAll('.vz-input-option').length>0");
  await cdp.evaluate("document.querySelector('.vz-input-search').focus()");
  await cdp.send('Input.insertText', { text: 'thumb-' });
  console.log('PICKER_QUERY ' + await cdp.evaluate("JSON.stringify({query:document.querySelector('.vz-input-search').value,names:[...document.querySelectorAll('.vz-input-option')].map(t=>t.dataset.inputName)})"));
  await cdp.poll("document.querySelectorAll('.vz-input-option').length===6");
  await cdp.poll("[...document.querySelectorAll('.vz-input-option img')].every(i=>i.complete&&i.naturalWidth>0)", 15000);
  const urls = await cdp.evaluate("[...document.querySelectorAll('.vz-input-option')].map(t=>({name:t.dataset.inputName,title:t.title,src:t.querySelector('img').src,text:t.textContent}))");
  for (const row of urls) {
    const url = new URL(row.src);
    assert.equal(decodeURIComponent(url.pathname.split('/').at(-2)), row.name);
    assert.equal(url.hash, ''); assert.equal(url.searchParams.get('kind'), 'input');
    assert.equal(row.title, row.name); assert(!row.text.includes(row.name), 'picker names stay tooltip-only');
  }
  const readOrder = await (await fetch(FAKE + '/read-order')).json();
  for (const name of names) assert(readOrder.includes(name), `upstream read exact name ${name}`);
  console.log('HOSTILE_TRACE ' + JSON.stringify({ urls, upstream: readOrder.filter(n => names.includes(n)) }));
  check('hostile names: browser decodes all six inputs through exact engine and backing identities', true);
  if (!process.env.E2E_THUMB_BASELINE) await geometry('loaded');
  await shot('loaded');

  // Fail native preview requests at the browser transport boundary only.
  // Comparison/engine evidence continues normally and must not be changed.
  let fail = true, held = null, attempts = 0;
  const waitHeld = async () => {
    for (let i = 0; i < 100 && !held; i++) await sleep(20);
    assert(held, 'retry passes through existing native acquisition port');
  };
  const original = cdp.ws.onmessage;
  cdp.ws.onmessage = event => {
    original(event);
    const { method, params: p } = JSON.parse(event.data);
    if (method === 'Network.loadingFailed') console.log('THUMB_NATIVE_FAILURE ' + JSON.stringify(p));
    if (method !== 'Fetch.requestPaused') return;
    const url = new URL(p.request.url);
    if (decodeURIComponent(url.pathname.split('/').at(-2)) !== names[0]) {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }); return;
    }
    attempts++;
    console.log('THUMB_INTERCEPTION ' + JSON.stringify({ requestId: p.requestId, url: p.request.url, fail, attempts }));
    if (fail) cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, body: '' });
    else held = p.requestId;
  };
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/entries/*/bytes*', resourceType: 'Image' }] });
  try {
    // Remount only the popup so the same URL gets a cold native lifetime.
    await cdp.keyTrusted('Escape', { vk: 27 });
    await cdp.clickAt('.vz-input-trigger');
    await cdp.poll(`!!document.querySelector(${JSON.stringify(option(names[0]))})`);
    await cdp.poll(`(()=>{const i=document.querySelector(${JSON.stringify(option(names[0]))}).querySelector('img');return i.complete&&!i.naturalWidth})()`);
    await shot('failure');
    if (process.env.E2E_THUMB_BASELINE) {
      console.log('BASELINE_FAILURE ' + await cdp.evaluate(`JSON.stringify({text:document.querySelector(${JSON.stringify(option(names[0]))}).textContent,failed:!!document.querySelector('.vz-thumbnail-failed'),retry:!!document.querySelector('.vz-thumbnail-retry')})`));
      return;
    }
    await cdp.poll("!!document.querySelector('.vz-input-tile .vz-thumbnail-failure:not([hidden])')", 3000);
    check('failed picker preview has explicit state and named retry', await cdp.evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(option(names[0]))}).parentElement;return !t.querySelector('.vz-thumbnail-failure').hidden&&t.textContent.includes('Preview failed')&&t.querySelector('.vz-thumbnail-retry').getAttribute('aria-label')===${JSON.stringify('Retry preview for ' + names[0])}})()`));
    await geometry('failed');
    await cdp.clickAt(option(names[0]));
    await cdp.poll(`${`document.querySelector(${JSON.stringify(option(names[0]))})`}.getAttribute('aria-selected')==='true'`);
    await cdp.poll(`!!document.querySelector(${JSON.stringify(tile(names[0]) + ' .vz-thumbnail-failure:not([hidden])')})`);
    await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    check('failed preview remains selectable', true);
    const retry = '.vz-input-tile .vz-thumbnail-failure:not([hidden]) .vz-thumbnail-retry';
    fail = false; const before = attempts;
    await cdp.evaluate(`document.querySelector(${JSON.stringify(retry)}).focus()`);
    // Native button activation includes the Enter character; the driver's
    // raw-key helper intentionally exercises only custom keydown handlers.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.poll("!!document.querySelector('.vz-input-tile .vz-thumbnail-pending')");
    await geometry('pending');
    await shot('pending');
    await waitHeld();
    console.log('THUMB_CONTINUE ' + held);
    { const requestId = held; held = null; await cdp.send('Fetch.continueRequest', { requestId }); }
    await cdp.poll(`(()=>{const t=document.querySelector(${JSON.stringify(option(names[0]))});const i=t.querySelector('img');return i.complete&&i.naturalWidth>0&&t.parentElement.querySelector('.vz-thumbnail-failure').hidden})()`);
    assert.equal(attempts, before + 1);
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(option(names[0]))}).getAttribute('aria-selected')`), 'true');
    check('named retry reacquires once, reaches decoded pixels and preserves selection', true);
    await shot('recovered');
    fail = true;
    await cdp.keyTrusted('Escape', { vk: 27 });
    await cdp.poll(`!!document.querySelector(${JSON.stringify(tile(names[0]))})`);
    await cdp.poll(`!!document.querySelector(${JSON.stringify(tile(names[0]) + ' .vz-thumbnail-failure:not([hidden])')})`);
    await shot('selected-failed');
    fail = false; await cdp.clickAt(tile(names[0]) + ' .vz-thumbnail-retry');
    await cdp.poll("!!document.querySelector('.vz-image-tile .vz-thumbnail-pending')");
    await waitHeld();
    { const requestId = held; held = null; await cdp.send('Fetch.continueRequest', { requestId }); }
    await cdp.poll(`(()=>{const i=document.querySelector(${JSON.stringify(tile(names[0]) + ' img')});return i.complete&&i.naturalWidth>0})()`);
    check('selected-set tile shares failed/pending/retry/loaded states', true);
    await shot('selected-recovered');
  } catch (error) {
    console.log('THUMB_ERROR ' + error.message);
    console.log('THUMB_DOM ' + await cdp.evaluate("document.querySelector('.vz-input-tile')?.outerHTML"));
    await shot('error');
    throw error;
  } finally {
    if (held) await cdp.send('Fetch.continueRequest', { requestId: held }).catch(error => console.log('THUMB_RETIRED ' + error.message));
    await cdp.send('Fetch.disable'); cdp.ws.onmessage = original;
  }
  await cdp.evaluate(`(()=>{const input=document.querySelector('.vz-imgfilespick'),d=new DataTransfer();d.items.add(new File(['not an image'],'broken-local.png',{type:'image/png'}));input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await cdp.poll("!!document.querySelector('[data-image-name=\"broken-local.png\"] .vz-thumbnail-failure:not([hidden])')");
  const localBefore = attempts;
  await cdp.clickAt('[data-image-name="broken-local.png"] .vz-thumbnail-retry');
  await cdp.poll("!!document.querySelector('[data-image-name=\"broken-local.png\"] .vz-thumbnail-failure:not([hidden])')");
  assert.equal(attempts, localBefore, 'local retry never contacts the engine');
  check('failed local File uses same named retry without changing selection or uploading bytes', await cdp.evaluate("document.querySelectorAll('.vz-image-tile').length===2"));
  await shot('local-failed');
  await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
  await cdp.poll("!!document.querySelector('.vz-discard-confirm')");
  await cdp.clickAt('.vz-discard-confirm');
  await cdp.poll("!document.querySelector('.vz-root')");
  await sleep(100);
}
module.exports = thumbnails;
if (require.main === module) (async () => {
  const cdp = await CDP.launch(9337, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(cdp); let checks = 0;
  try {
    await thumbnails({ cdp, check(name, ok) { assert(ok, name); checks++; console.log('ok ' + name); } });
    assert.deepEqual(errors, []); console.log(`PASS: ${checks} thumbnail checks; no page errors`);
  } finally { await cdp.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
