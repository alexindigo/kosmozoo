// Real-browser proof: Pexels services are managed in Settings, browsed in the
// Variations image picker, and chosen photos reach ComfyUI as uploads.
// Needs tests/fake-pexels.mjs twice: E2E_PEXELS (key "secret", curated) and
// E2E_PEXELS_BARE (--no-curated), plus the usual engine and fake ComfyUI.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, P = process.env.E2E_PEXELS, BARE = process.env.E2E_PEXELS_BARE;
const D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const json = async (base, path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, `${path} ${r.status}`); return r.json();
};
const pexelsTrigger = '.vz-image-add .vz-input-picker:nth-child(2) .vz-input-trigger';

(async () => {
  fs.mkdirSync(D, { recursive: true });
  const c = await CDP.launch(19495, { windowSize: '1440,1000' }), errors = await collectPageErrors(c);
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const field = (selector, value) => c.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const step = label => console.log('step:', label);
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${D}/${name}.png`, Buffer.from(s.data, 'base64')); };
  const addService = async (name, url, key) => {
    await c.clickAt('.pexels-settings [title="Add Pexels service"]');
    await c.poll(`!!document.querySelector('.pexels-form')`);
    const form = await c.evaluate(`[...document.querySelectorAll('.pexels-form input')].map(i=>'#'+i.id)`);
    await field(form[0], name); await field(form[1], url); if (key) await field(form[2], key);
    await c.clickAt('.pexels-form button[type="submit"]');
    await c.poll(`!document.querySelector('.pexels-form') && [...document.querySelectorAll('.pexels-service-name')].some(e=>e.textContent===${JSON.stringify(name)})`);
  };
  try {
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    step('open the feed'); await c.goto(B + '/#fake#flux-basic.png');
    await c.poll(`(async()=>${KZ}.state.images.length>0&&!!document.querySelector('.card'))()`, 20000);

    // Settings: add, inspect redaction, edit-form wording, cancel.
    step('add services in Settings'); await c.clickAt('#menuBtn');
    await c.poll(`!!document.querySelector('.pexels-settings-empty')`);
    await field('#menuSearch', 'pexels');
    await addService('Home photos', P + '/v1', 'secret');
    step('second service'); await addService('Bare', BARE);
    const listed = await (await fetch(B + '/api/features/variations/pexels/services')).text();
    assert(!listed.includes('secret'), 'service list never carries the key');
    const services = JSON.parse(listed).services;
    assert.deepEqual(services.map(s => [s.name, s.url, s.hasKey]), [['Home photos', P, true], ['Bare', BARE, false]]);
    assert.equal(await c.evaluate(`document.querySelectorAll('.pexels-service-key').length`), 1);
    await shot('settings-services');
    await c.clickAt('.pexels-service-open');
    await c.poll(`document.querySelector('.pexels-form input[type=password]')?.placeholder==='Saved key is kept'`);
    await shot('settings-edit');
    await c.evaluate(`[...document.querySelectorAll('.pexels-form button')].find(b=>b.textContent==='Cancel').click()`);
    step('close Settings'); await invoke('menu.close');

    // A target whose workflow loads an image.
    const name = 'pexels-target.png', graph = {
      '470': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'pexels-target', images: ['470', 0] } },
    };
    await json(F, '/__test/activity', { captureEnqueue: true, publish: [{ name, fixture: 'flux-basic.png', graph, mtime: 2100000600 }] });
    await c.evaluate(`fetch('/api/collections/fake/entries/${name}/bytes').then(r=>r.arrayBuffer()).then(()=>true)`);
    step('open Variations'); await invoke('variations.open', { id: `fake:${name}` });
    await addParameter(c, '470.image');
    await removeRecordedImage(c, '470.image');
    await openImageAdd(c);
    assert.deepEqual(await c.evaluate(`[...document.querySelectorAll('.vz-image-add .vz-input-trigger')].map(b=>b.textContent)`), ['ComfyUI images', 'Pexels photos']);

    // Curated on the keyed service, paged as the list scrolls.
    step('open the Pexels picker'); await c.clickAt(pexelsTrigger); await waitForInputPicker(c);
    await c.poll(`document.querySelectorAll('[role=tab]').length===2 && [...document.querySelectorAll('[role=tab]')].map(t=>t.textContent).join()==='Home photos,Bare'`);
    await c.poll(`document.querySelectorAll('.vz-input-option').length>0 && [...document.querySelectorAll('.vz-input-option img')].every(i=>i.complete&&i.naturalWidth>0)`, 20000);
    assert.equal(await c.evaluate(`document.querySelector('.vz-input-search').placeholder`), 'Search photos...');
    assert.match(await c.evaluate(`document.querySelector('.vz-input-option').getAttribute('aria-label')`), /^Curated scene 0 - photo by Photographer 100$/);
    assert.equal(await c.evaluate(`!!document.querySelector('.vz-input-feeds')`), false, 'no imported/generated tabs for Pexels');
    await shot('picker-curated');
    await c.evaluate(`(()=>{const l=document.querySelector('.vz-input-list');l.scrollTop=l.scrollHeight;})()`);
    await c.poll(`(async()=>{const l=document.querySelector('.vz-input-list');l.scrollTop=l.scrollHeight;await new Promise(r=>setTimeout(r,50));return document.querySelector('.vz-input-window').offsetHeight>14*102*1.5})()`, 20000);

    // Search, choose two photos.
    await c.evaluate(`document.querySelector('.vz-input-search').focus()`);
    step('search'); await c.send('Input.insertText', { text: 'cats' });
    await c.poll(`document.querySelector('.vz-input-option')?.getAttribute('aria-label')?.startsWith('cats photo 0')`, 20000);
    await c.poll(`[...document.querySelectorAll('.vz-input-option img')].slice(0,6).every(i=>i.complete&&i.naturalWidth>0)`, 20000);
    const options = await c.evaluate(`[...document.querySelectorAll('.vz-input-option')].slice(0,2).map(o=>o.dataset.inputName)`);
    for (const option of options) await c.clickAt(`.vz-input-option[data-input-name="${option}"]`);
    await c.poll(`document.querySelectorAll('.vz-input-option[aria-selected=true]').length===2`, 20000);
    assert.equal(await c.evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent`), '2 selected');
    await shot('picker-selected');

    // A service without curated photos asks for a search instead of failing.
    await c.evaluate(`[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Bare').click()`);
    await c.poll(`document.querySelector('.vz-input-search').value==='cats'`);
    await c.evaluate(`(()=>{const s=document.querySelector('.vz-input-search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await c.poll(`document.querySelector('.vz-input-list .vz-image-empty')?.textContent==='Search to find photos on Bare.'`, 20000);
    await shot('picker-search-only');
    await c.send('Input.insertText', { text: 'dogs' });
    await c.poll(`document.querySelectorAll('.vz-input-option').length===3`, 20000);
    await c.keyTrusted('Escape', { vk: 27 });
    await c.poll(`!document.querySelector('.vz-input-search')`);

    await c.poll(`[...document.querySelectorAll('.vz-image-tile')].map(t=>t.dataset.imageName).join()===${JSON.stringify(options.map(id => `pexels-${id}.png`).join())}`, 20000);
    await waitForSelectedPreviews(c);
    await shot('image-set');

    step('run'); const run = await invoke('variations.run');
    assert.equal(run.adopted, true, JSON.stringify(run) + ' ' + await c.evaluate(`document.querySelector('.vz-messages')?.textContent`)); assert.equal(run.submitted, 2);
    const enqueues = await json(F, '/__test/enqueues');
    const values = enqueues.map(e => e.prompt?.['470']?.inputs?.image ?? e['470']?.inputs?.image).sort();
    assert.deepEqual(values, options.map(id => `pexels-${id}.png`).sort(), JSON.stringify(enqueues).slice(0, 400));
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${D}/pexels-images.json`, JSON.stringify({ services, options, run, values }, null, 2));
    console.log('pexels-images: ok');
  } catch (error) {
    await shot('failure').catch(() => {});
    console.error(error); process.exitCode = 1;
  } finally { await c.close(); }
})();
