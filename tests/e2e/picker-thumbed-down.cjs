// Real discovery consumers: shared policy, cached reprojection and retained work.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OTHER = process.env.E2E_FAKE2, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const NAME = 'visibility-down.png', TARGET = 'visibility-target.png', UP = 'visibility-up.png';
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && OTHER && E, 'Explicit owned stack and evidence required');
  const page = await CDP.launch(9416, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), catalogues = [];
  page.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('catalogue=images-v1')) catalogues.push(message.params.request.url);
  });
  await page.send('Network.enable');
  const evaluate = text => page.evaluate(`(async()=>(${text}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const present = name => `!!document.querySelector(${JSON.stringify(option(name))})`;
  const waitName = name => page.poll(present(name), 15000);
  const root = value => page.clickAt(`.vz-input-feeds [data-value="${value}"]`);
  const selected = () => evaluate(`[...document.querySelectorAll('.vz-image-tile')].map(el=>({name:el.dataset.imageName,kind:el.dataset.imageKind}))`);
  const count = () => evaluate(`document.querySelector('.vz-count').textContent`);
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: NAME } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'visibility' } } };
    assert((await control(FAKE, { reset: true, publishInputs: [{ name: NAME, fixture: 'flux-basic.png' }], publish: [
      { name: NAME, fixture: 'flux-basic.png', width: 96, height: 64, mtime: 2100010003 },
      { name: UP, fixture: 'flux-basic.png', width: 96, height: 64, mtime: 2100010002 },
      { name: TARGET, fixture: 'flux-lora.png', graph, mtime: 2100010001 },
    ] })).ok);
    assert((await control(OTHER, { reset: true, publish: [{ name: NAME, fixture: 'flux-basic.png' }] })).ok);
    await page.goto(ENGINE + '/#fake#' + NAME);
    await page.poll(`!!document.querySelector('.card[data-name="${NAME}"] .down')`, 20000);
    await invoke('selection.set', { id: 'fake:' + NAME, value: true });
    await page.clickAt(`.card[data-name="${NAME}"] .down`);
    await page.poll(`(async()=>{const s=${KZ};return s.state.images.find(i=>i.filename==='${NAME}')?.judgment?.vote==='down'&&!s.state.view().some(i=>s.state.images[i].filename==='${NAME}')})()`);
    assert(await evaluate(`${KZ}.state.selected['fake:${NAME}']`), 'hiding never clears gallery selection');
    await invoke('judgment.apply', { id: 'fake:' + UP, intent: { type: 'set', patch: { vote: 'up' } } });
    const response = await fetch(ENGINE + '/api/collections/another/entries/' + NAME + '/judgment', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ vote: 'down' }) });
    assert(response.ok);
    // The picker must not inherit this unrelated feed filename restriction.
    await invoke('feed.filter', { value: 'no-feed-matches' });
    await evaluate(`fetch('/api/collections/fake/entries/${TARGET}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + TARGET });
    await addParameter(page, '11.image'); await openImageAdd(page);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page); await waitName(NAME);
    const chosenInput = await selected(); assert.equal(chosenInput.length, 1);
    await root('output'); await waitName(UP);
    assert(!await evaluate(present(NAME)), 'feed-downvoted output is absent from discovery');
    assert.equal(await count(), '0');
    const reads = catalogues.length;
    await invoke('preference.revealDown'); await waitName(NAME);
    assert.equal(catalogues.length, reads, 'reveal reprojects the cached catalogue');
    await page.clickAt(option(NAME));
    const chosen = await selected(), chosenCount = await count();
    assert.equal(chosen.length, 2); assert.equal(chosenCount, '1');
    await invoke('preference.revealDown');
    await page.poll('!' + present(NAME));
    assert.deepEqual(await selected(), chosen); assert.equal(await count(), chosenCount, 'hidden chosen output still contributes');
    await invoke('preference.downvoteHides', { value: false }); await waitName(NAME);
    assert.equal(catalogues.length, reads, 'setting changes do not refetch');
    await invoke('preference.downvoteHides', { value: true }); await page.poll('!' + present(NAME));
    await invoke('preference.hideUp'); await page.poll('!' + present(UP));
    await invoke('preference.hideUp'); await waitName(UP);
    // Hold confirmation to observe both optimistic membership and rollback.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `*/entries/${UP}/judgment`, requestStage: 'Request' }] });
    let paused;
    const onPause = event => { const message = JSON.parse(event.data); if (message.method === 'Fetch.requestPaused') paused = message.params; };
    page.ws.addEventListener('message', onPause);
    await evaluate(`(async()=>{window.visibilityVote=${KZ}.handles.invoke('judgment.apply',{id:'fake:${UP}',intent:{type:'set',patch:{vote:'down'}}});return true})()`);
    await page.poll('!' + present(UP));
    assert(paused, 'judgment request is held while the optimistic candidate disappears');
    await page.send('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"controlled rejection"}').toString('base64') });
    await evaluate('window.visibilityVote'); await waitName(UP);
    await page.send('Fetch.disable'); page.ws.removeEventListener('message', onPause);
    assert.equal(catalogues.length, reads, 'optimistic write and rollback reuse retained facts');
    // Search and keyboard operate on eligible names, not retained raw records.
    await page.clickAt('.vz-input-search'); await page.send('Input.insertText', { text: NAME });
    await page.poll(`document.querySelectorAll('.vz-input-option').length===0`);
    await page.keyTrusted('Enter', { vk: 13 }); assert.deepEqual(await selected(), chosen);
    await page.clickAt('.vz-search-clear'); await waitName(UP);
    await root('input'); await waitName(NAME);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(option(NAME))}).getAttribute('aria-selected')`), 'true', 'same-named input remains unjudged and chosen');
    await root('output'); await page.clickAt('.vz-input-tabs [data-value="another"]');
    await page.poll(`document.querySelector('.vz-input-list').getAttribute('aria-busy')!=='true'`);
    assert(!await evaluate(present(NAME)), 'foreign catalogue judgment supplies membership');
    await invoke('preference.revealDown'); await waitName(NAME);
    await invoke('preference.revealDown'); await page.poll('!' + present(NAME));
    await page.clickAt('.vz-input-tabs [data-value="fake"]'); await waitName(UP);
    assert(!await evaluate(present(NAME))); assert.deepEqual(await selected(), chosen); assert.equal(await count(), chosenCount);
    assert(await evaluate(`${KZ}.state.selected['fake:${NAME}']`));
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/picker-visibility-proof.json', JSON.stringify({ catalogues, chosen, chosenCount, pageErrors: errors }, null, 2));
    console.log('PASS feed/picker visibility, cached reveal/settings/hideUp, optimistic rollback, search/keyboard, input and foreign roots, retained selection/count; no page errors');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
