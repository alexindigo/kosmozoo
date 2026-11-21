// Real picker membership, keyboard and geometry through its live projection.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OTHER = process.env.E2E_FAKE2, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const names = Array.from({ length: 8 }, (_, i) => `filters-${i}.png`), target = 'filters-target.png';
const flags = ['up', 'favorite', 'bookmark'], labels = ['Only up-voted', 'Only starred', 'Only bookmarked'];
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const button = bit => `.vz-input-filters button[aria-label=${JSON.stringify(labels[bit])}]`;
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && OTHER && E);
  const page = await CDP.launch(9418, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(page), catalogues = [];
  page.ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Network.requestWillBeSent' && message.params.request.url.includes('catalogue=images-v1')) catalogues.push(message.params.request.url);
  });
  await page.send('Network.enable');
  const evaluate = text => page.evaluate(`(async()=>(${text}))()`);
  const invoke = (command, args = {}) => evaluate(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
  const setJudgment = (name, patch) => invoke('judgment.apply', { id: 'fake:' + name, intent: { type: 'set', patch } });
  const root = value => page.clickAt(`.vz-input-feeds [data-value="${value}"]`);
  const listing = () => evaluate(`[...document.querySelectorAll('.vz-input-option')].map(el=>el.dataset.inputName).sort()`);
  const waitNames = async expected => {
    try { await page.poll(`JSON.stringify([...document.querySelectorAll('.vz-input-option')].map(el=>el.dataset.inputName).sort())===${JSON.stringify(JSON.stringify([...expected].sort()))}`, 15000); }
    catch (error) {
      error.message += ' ' + JSON.stringify(await evaluate(`({expected:${JSON.stringify(expected)},names:[...document.querySelectorAll('.vz-input-option')].map(el=>el.dataset.inputName),focus:document.activeElement?.outerHTML,filters:[...document.querySelectorAll('.vz-input-filters button')].map(el=>el.outerHTML)})`));
      throw error;
    }
  };
  let bits = 0;
  const choose = async next => {
    for (let bit = 0; bit < 3; bit++) if ((bits ^ next) & (1 << bit)) await page.clickAt(button(bit));
    bits = next;
    for (let bit = 0; bit < 3; bit++) assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button(bit))}).getAttribute('aria-pressed')`), String(!!(bits & (1 << bit))));
  };
  const query = async text => {
    await page.clickAt('.vz-input-search');
    await evaluate(`(()=>{const el=document.querySelector('.vz-input-search');el.value=${JSON.stringify(text)};el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  };
  const geometry = () => evaluate(`(()=>{const field=document.querySelector('.vz-input-search').getBoundingClientRect();return [...document.querySelectorAll('.vz-input-filters button')].map(el=>{const b=el.getBoundingClientRect(),s=el.querySelector('svg').getBoundingClientRect();return {height:b.height,center:b.y+b.height/2,searchCenter:field.y+field.height/2,searchHeight:field.height,searchWidth:field.width,gaps:[s.x-b.x,b.right-s.right,s.y-b.y,b.bottom-s.bottom],fill:getComputedStyle(el.querySelector('circle')).fill,stroke:getComputedStyle(el.querySelector('circle')).stroke}})})()`);
  const shot = async name => {
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(`${E}/${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    fs.mkdirSync(`${E}/review/${name}`, { recursive: true });
    for (const [region, selector] of [['header', '#chrome'], ['title', '.vz-title'], ['catalogue', '.vz-catalogue'], ['editor', '.vz-sliders'], ['summary', '.vz-right'], ['picker', '.vz-input-popover']]) {
      const clip = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return{x:Math.max(0,r.x),y:Math.max(0,r.y),width:Math.min(r.right,innerWidth)-Math.max(0,r.x),height:Math.min(r.bottom,innerHeight)-Math.max(0,r.y),scale:2}})()`);
      if (clip && clip.width > 0 && clip.height > 0) fs.writeFileSync(`${E}/review/${name}/${region}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png', clip })).data, 'base64'));
    }
  };
  try {
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: names[0] } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'filters' } } };
    const outputs = names.map((name, i) => ({ name, fixture: i & 1 ? 'flux-basic.png' : 'flux-lora.png', width: 96, height: 64, mtime: 2100020008 - i }));
    assert((await control(FAKE, { reset: true, publishInputs: [names[0], names[7]].map(name => ({ name, fixture: 'flux-basic.png' })), publish: [...outputs, { name: target, fixture: 'flux-lora.png', graph, mtime: 2100020000 }] })).ok);
    assert((await control(OTHER, { reset: true, publish: outputs })).ok);
    await page.goto(ENGINE + '/#fake#' + names[7]);
    await page.poll(`!!document.querySelector('.card[data-name="${names[7]}"] .up')`, 20000);
    for (let i = 0; i < names.length; i++) await setJudgment(names[i], { vote: i & 1 ? 'up' : null, favorite: !!(i & 2), bookmark: !!(i & 4) });
    await evaluate(`fetch('/api/collections/fake/entries/${target}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + target });
    await addParameter(page, '11.image'); await openImageAdd(page);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
    await page.poll(`!!document.querySelector(${JSON.stringify(option(names[7]))})`);
    const inputNames = await listing();
    assert(await evaluate(`[...document.querySelectorAll('.vz-input-filters button')].every(el=>el.disabled&&el.title==='Input files have no votes')`));
    await root('output'); await page.poll(`!!document.querySelector(${JSON.stringify(option(target))})`);
    const unpressed = await geometry();
    assert(unpressed.every(g => g.fill === 'none'));
    const reads = catalogues.length, combinations = [];
    for (let next = 1; next < 8; next++) {
      await choose(next);
      const expected = names.filter((_, i) => (i & next) === next);
      await waitNames(expected); combinations.push({ filters: next, names: await listing() });
    }
    await choose(3); await query('7'); await waitNames([names[7]]);
    await query('missing'); await waitNames([]);
    await page.poll(`document.querySelector('.vz-image-empty')?.textContent==='No images match the selected filters'`);
    await query(''); await waitNames([names[3], names[7]]);
    await page.poll(`[...document.querySelectorAll('.vz-input-option img')].every(el=>el.complete&&el.naturalWidth>0)`, 20000);
    await shot('picker-judgment-filters');
    // Optimistic live membership and failed-write rollback use the same overlay.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `*/entries/${names[7]}/judgment`, requestStage: 'Request' }] });
    let paused;
    const onPause = event => { const message = JSON.parse(event.data); if (message.method === 'Fetch.requestPaused') paused = message.params; };
    page.ws.addEventListener('message', onPause);
    await evaluate(`(async()=>{window.filterVote=${KZ}.handles.invoke('judgment.apply',{id:'fake:${names[7]}',intent:{type:'set',patch:{favorite:false}}});return true})()`);
    await waitNames([names[3]]);
    for (const end = Date.now() + 10000; !paused && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 25));
    assert(paused);
    await page.send('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"controlled rejection"}').toString('base64') });
    await evaluate('window.filterVote'); await waitNames([names[3], names[7]]);
    await page.send('Fetch.disable'); page.ws.removeEventListener('message', onPause);
    await setJudgment(names[7], { vote: null }); await waitNames([names[3]]);
    await setJudgment(names[7], { vote: 'up' }); await waitNames([names[3], names[7]]);
    assert.equal(catalogues.length, reads, 'toggles/search/live judgments never refetch');
    const measured = await geometry();
    for (const g of measured) {
      assert(Math.abs(g.center - g.searchCenter) < .5); assert.equal(g.height, g.searchHeight);
      assert(Math.max(...g.gaps) - Math.min(...g.gaps) <= 1); assert(g.searchWidth > 100);
    }
    assert(measured.slice(0, 2).every(g => g.fill === g.stroke)); assert.equal(measured[2].fill, 'none');
    await page.poll(`[...document.querySelectorAll('.vz-input-option img')].every(el=>el.complete&&el.naturalWidth>0)`, 20000);
    // Navigation and selection only see the projected pair; Enter on a filter
    // retains native button semantics instead of choosing an image.
    await page.clickAt('.vz-input-search'); await page.keyTrusted('ArrowRight', { vk: 39 });
    await page.poll(`document.activeElement?.dataset.inputName===${JSON.stringify(names[7])}`);
    await page.keyTrusted('Enter', { vk: 13 });
    await page.poll(`document.querySelector(${JSON.stringify(option(names[7]))})?.getAttribute('aria-selected')==='true'`);
    await page.poll(`document.querySelector('.vz-input-summary [role=status]')?.textContent.includes('1 selected in listing')`);
    await evaluate(`document.querySelector(${JSON.stringify(button(2))}).focus()`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    bits = 7; await waitNames([names[7]]);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button(2))}).getAttribute('aria-pressed')`), 'true');
    await choose(3);
    await page.clickAt('.vz-input-tabs [data-value="another"]'); await waitNames([]);
    await page.poll(`document.querySelector('.vz-image-empty')?.textContent==='No images match the selected filters'`);
    await page.clickAt('.vz-input-tabs [data-value="fake"]'); await waitNames([names[3], names[7]]);
    await root('input'); await waitNames(inputNames);
    assert(await evaluate(`[...document.querySelectorAll('.vz-input-filters button')].every(el=>el.disabled)`));
    await root('output'); await waitNames([names[3], names[7]]);
    await page.clickAt('.vz-input-trigger'); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page); await waitNames([names[3], names[7]]);
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/filters-proof.json', JSON.stringify({ combinations, unpressed, measured, catalogues, pageErrors: errors }, null, 2));
    console.log('PASS all seven AND filter combinations, search, empty state, live votes/rollback, source/root/reopen retention, disabled inputs, keyboard, counts, colors and centered toolbar geometry');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
