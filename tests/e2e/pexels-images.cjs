// Real-browser proof: Pexels services are managed in Settings, browsed in the
// Variations image picker, and chosen photos reach ComfyUI as uploads.
// Needs tests/fake-pexels.mjs three times: E2E_PEXELS (key "secret", curated),
// E2E_PEXELS_BARE (--no-curated) and E2E_PEXELS_FRAMES (--frames, a self-hosted
// catalogue shape), plus the usual engine and fake ComfyUI.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage, settledCount } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker, waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, P = process.env.E2E_PEXELS, BARE = process.env.E2E_PEXELS_BARE, FRAMES = process.env.E2E_PEXELS_FRAMES;
const D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const json = async (base, path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, `${path} ${r.status}`); return r.json();
};
const pexelsTrigger = '.vz-image-add .vz-image-external .vz-input-trigger';

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
    await addService('Frames', FRAMES + '/v1');
    const listed = await (await fetch(B + '/api/features/variations/pexels/services')).text();
    assert(!listed.includes('secret'), 'service list never carries the key');
    const services = JSON.parse(listed).services;
    assert.deepEqual(services.map(s => [s.name, s.url, s.hasKey]), [['Home photos', P, true], ['Bare', BARE, false], ['Frames', FRAMES, false]]);
    assert.equal(await c.evaluate(`document.querySelectorAll('.pexels-service-key').length`), 1);
    await addService('Unreachable', 'http://127.0.0.1:20499');
    const lights = `[...document.querySelectorAll('.pexels-service')].map(r=>[r.querySelector('.pexels-service-name').textContent,r.querySelector('.pexels-service-status').className.replace('pexels-service-status','').trim(),r.querySelector('.pexels-service-problem')?.textContent??''])`;
    // The unreachable service names itself, the request and the recovery (row 236).
    const reached = `${lights}.map(([name,state,problem])=>[name,state,problem.startsWith('Unreachable could not be reached while loading curated photos, page 1: ')&&problem.endsWith('Check its address and connectivity, then Retry.')?'unreachable':problem])`;
    await c.poll(`JSON.stringify(${reached})===${JSON.stringify(JSON.stringify([['Home photos', 'is-ok', ''], ['Bare', 'is-ok', ''], ['Frames', 'is-ok', ''], ['Unreachable', 'is-error', 'unreachable']]))}`, 20000);
    assert.equal(await c.evaluate(`!!document.querySelector('.pexels-service:nth-child(4) [title="Check Unreachable again"]')`), true);
    await shot('settings-services');
    await c.clickAt('.pexels-service:nth-child(4) [title="Remove Unreachable"]');
    await c.poll(`!!document.querySelector('.pexels-service-confirm')`);
    await c.evaluate(`document.querySelector('.pexels-remove').click()`);
    await c.poll(`document.querySelectorAll('.pexels-service').length===3`);

    // A failed removal keeps the open form; a finishing save closes only its own draft.
    const row = name => `[...document.querySelectorAll('.pexels-service')].find(r=>r.querySelector('.pexels-service-name').textContent===${JSON.stringify(name)})`;
    const formName = `document.querySelector('.pexels-form input')?.value`;
    await c.evaluate(`(()=>{window.__pxFetch=window.fetch;window.fetch=(url,options)=>options?.method==='DELETE'&&String(url).includes('/pexels/services/')?Promise.resolve(new Response(JSON.stringify({error:'Remove failed for test'}),{status:500,headers:{'Content-Type':'application/json'}})):window.__pxFetch(url,options)})()`);
    await c.evaluate(`${row('Bare')}.querySelector('.pexels-service-open').click()`);
    await c.poll(`${formName}==='Bare'`);
    await c.evaluate(`${row('Bare')}.querySelector('[title="Remove Bare"]').click()`);
    await c.evaluate(`document.querySelector('.pexels-remove').click()`);
    await c.poll(`document.querySelector('.pexels-settings-message')?.textContent.includes('Remove failed for test')`);
    assert.equal(await c.evaluate(formName), 'Bare', 'failed removal keeps the open form');
    await c.evaluate(`(()=>{window.fetch=(url,options)=>options?.method==='PATCH'?new Promise(resolve=>{window.__pxRelease=()=>resolve(window.__pxFetch(url,options))}):window.__pxFetch(url,options)})()`);
    await c.evaluate(`${row('Home photos')}.querySelector('.pexels-service-open').click()`);
    await c.poll(`${formName}==='Home photos'`);
    await c.evaluate(`document.querySelector('.pexels-form').requestSubmit()`);
    await c.poll(`typeof window.__pxRelease==='function'`);
    await c.evaluate(`${row('Bare')}.querySelector('.pexels-service-open').click()`);
    await c.poll(`${formName}==='Bare'`);
    await field('.pexels-form input', 'Bare edited');
    await c.evaluate(`window.__pxRelease()`);
    await c.poll(`document.querySelector('.pexels-settings-message')?.textContent==='Home photos saved'`);
    assert.equal(await c.evaluate(formName), 'Bare edited', 'another draft survives a finishing save');
    await c.evaluate(`(()=>{window.fetch=window.__pxFetch;[...document.querySelectorAll('.pexels-form button')].find(b=>b.textContent==='Cancel').click()})()`);
    await c.poll(`!document.querySelector('.pexels-form')`);
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
    // External photos sit at the row's right edge, after the engine's own sources.
    const edge = await c.evaluate(`(()=>{const row=document.querySelector('.vz-image-add').getBoundingClientRect(),ext=document.querySelector('.vz-image-external').getBoundingClientRect(),current=document.querySelector('.vz-current-image').getBoundingClientRect(),pad=parseFloat(getComputedStyle(document.querySelector('.vz-image-add')).paddingRight);return {right:row.right-pad-1-ext.right,after:ext.left>current.right}})()`);
    assert(Math.abs(edge.right) < 1 && edge.after, JSON.stringify(edge));

    // Hold each listing at the browser boundary so loading presentation cannot race the fake.
    {
      step('picker loading states');
      const idle = `!document.querySelector('.vz-input-placeholder') && !document.querySelector('.vz-input-list.is-stale') && !document.querySelector('.vz-input-activity-bar.is-active') && !document.querySelector('.vz-input-activity') && !document.querySelector('.vz-input-list[aria-busy=true]')`;
      const busy = `!!document.querySelector('.vz-input-activity-bar.is-active') && !!document.querySelector('.vz-input-list[aria-busy=true]')`;
      const noPreviewText = async () => assert.equal(await c.evaluate(`[...document.querySelectorAll('.vz-input-popover *')].some(el=>el.textContent.includes('Loading preview'))`), false);
      await c.evaluate(`(()=>{const original=window.fetch;window.__pxFetch=original;window.__pxHoldNext=true;window.__pxHeld=false;window.fetch=async(url,options)=>{
        const path=new URL(typeof url==='string'?url:url.url,location.href).pathname;
        if(window.__pxHoldNext&&path.includes('/pexels/services/')&&path.endsWith('/photos')){
          window.__pxHoldNext=false;await new Promise(resolve=>{window.__pxRelease=resolve;window.__pxHeld=true});
        }
        return original(url,options);
      }})()`);
      try {
        await c.clickAt(pexelsTrigger); await waitForInputPicker(c);
        await c.poll(`window.__pxHeld && ${busy} && document.querySelector('.vz-input-activity')?.textContent==='Loading photos from Home photos…'`);
        assert.equal(await c.evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent`), '0 selected in listing; 0 in image set.');
        await c.poll(`document.querySelectorAll('.vz-input-placeholder').length>0`);
        const placeholders = await c.evaluate(`[...document.querySelectorAll('.vz-input-placeholder')].map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))`);
        assert(placeholders.length > 0);
        for (const tile of placeholders) assert(Math.abs(tile.width - 96) < .5 && Math.abs(tile.height - 96) < .5, JSON.stringify(tile));
        await noPreviewText();
        await c.evaluate(`window.__pxRelease()`);
        await c.poll(`${idle} && document.querySelectorAll('.vz-input-option').length>0`, 20000);

        await c.evaluate(`(()=>{window.__pxHeld=false;window.__pxHoldNext=true})()`);
        await field('.vz-input-search', 'cats');
        await c.poll(`window.__pxHeld && ${busy} && !!document.querySelector('.vz-input-list.is-stale') && document.querySelector('.vz-input-activity')?.textContent==='Searching Home photos for "cats"…'`);
        assert.equal(await c.evaluate(`document.querySelectorAll('.vz-input-placeholder').length`), 0, 'stale tiles remain instead of skeletons');
        assert.match(await c.evaluate(`document.querySelector('.vz-input-option').getAttribute('aria-label')`), /^Curated scene/);
        await noPreviewText();
        await c.evaluate(`window.__pxRelease()`);
        await c.poll(`${idle} && document.querySelector('.vz-input-option')?.getAttribute('aria-label')?.startsWith('cats photo 0')`, 20000);
        await noPreviewText();
        await field('.vz-input-search', '');
        await c.poll(`${idle} && document.querySelector('.vz-input-option')?.getAttribute('aria-label')?.startsWith('Curated scene')`, 20000);
        await c.keyTrusted('Escape', { vk: 27 });
        await c.poll(`!document.querySelector('.vz-input-search')`);
      } finally {
        await c.evaluate(`(()=>{window.__pxRelease?.();window.fetch=window.__pxFetch;delete window.__pxRelease;delete window.__pxHeld;delete window.__pxHoldNext;delete window.__pxFetch})()`);
      }
    }

    // Curated on the keyed service, paged as the list scrolls.
    step('open the Pexels picker'); await c.clickAt(pexelsTrigger); await waitForInputPicker(c);
    await c.poll(`document.querySelectorAll('[role=tab]').length===3 && [...document.querySelectorAll('[role=tab]')].map(t=>t.textContent).join()==='Home photos,Bare,Frames'`);
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
    assert.equal(await c.evaluate(`document.querySelector('.vz-input-summary [role=status]').textContent`), '2 selected in listing; 2 in image set.');
    await shot('picker-selected');

    // A service without curated photos asks for a search instead of failing.
    await c.evaluate(`[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Bare').click()`);
    await c.poll(`document.querySelector('.vz-input-search').value==='cats'`);
    await c.evaluate(`(()=>{const s=document.querySelector('.vz-input-search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await c.poll(`document.querySelector('.vz-input-list .vz-image-empty')?.textContent==='Search to find photos on Bare.'`, 20000);
    await shot('picker-search-only');
    await c.send('Input.insertText', { text: 'dogs' });
    await c.poll(`document.querySelectorAll('.vz-input-option').length===3`, 20000);

    // A self-hosted catalogue without curated photos is browsed through an
    // empty search; its opaque IDs become portable file names.
    await c.evaluate(`[...document.querySelectorAll('[role=tab]')].find(t=>t.textContent==='Frames').click()`);
    await c.evaluate(`(()=>{const s=document.querySelector('.vz-input-search');s.value='';s.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await c.poll(`document.querySelector('.vz-input-option')?.getAttribute('aria-label')==='Photoshoot - frame 200'`, 20000);
    await c.poll(`[...document.querySelectorAll('.vz-input-option img')].slice(0,6).every(i=>i.complete&&i.naturalWidth>0)`, 20000);
    await shot('picker-browse-frames');
    await c.clickAt('.vz-input-option[data-input-name="film-7:frame-200"]');
    await c.poll(`document.querySelectorAll('.vz-input-option[aria-selected=true]').length===1`, 20000);
    await c.keyTrusted('Escape', { vk: 27 });
    await c.poll(`!document.querySelector('.vz-input-search')`);

    const names = [...options.map(id => `pexels-${id}.png`), 'pexels-film-7-frame-200.png'];
    // Each photo joins the set when its bytes arrive, so near-simultaneous picks may settle in either order.
    await c.poll(`[...document.querySelectorAll('.vz-image-tile')].map(t=>t.dataset.imageName).sort().join()===${JSON.stringify([...names].sort().join())}`, 20000);
    await waitForSelectedPreviews(c);
    await shot('image-set');

    step('run'); await settledCount(c, '3'); const run = await invoke('variations.run');
    assert.equal(run.adopted, true, JSON.stringify(run) + ' ' + await c.evaluate(`document.querySelector('.vz-messages')?.textContent`)); assert.equal(run.submitted, 3);
    const enqueues = await json(F, '/__test/enqueues');
    const values = enqueues.map(e => e.prompt?.['470']?.inputs?.image ?? e['470']?.inputs?.image).sort();
    assert.deepEqual(values, [...names].sort(), JSON.stringify(enqueues).slice(0, 400));
    assert.deepEqual(errors, []);
    fs.writeFileSync(`${D}/pexels-images.json`, JSON.stringify({ services, options, run, values }, null, 2));
    console.log('pexels-images: ok');
  } catch (error) {
    await shot('failure').catch(() => {});
    console.error(error); process.exitCode = 1;
  } finally { await c.close(); }
})();
