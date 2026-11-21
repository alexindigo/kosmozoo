// Real picker projection: independent judgments, source identity and stable geometry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OTHER = process.env.E2E_FAKE2, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const names = Array.from({ length: 8 }, (_, i) => `judgments-${i}.png`), target = 'judgments-target.png';
const flags = ['up', 'favorite', 'bookmark'], labels = ['up-voted', 'starred', 'bookmarked'];
const option = name => `.vz-input-option[data-input-name=${JSON.stringify(name)}]`;
const control = (base, body) => fetch(base + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
(async () => {
  assert(ENGINE && FAKE && OTHER && E);
  const page = await CDP.launch(9417, { windowSize: '1400,1000' });
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
  const waitName = name => page.poll(`!!document.querySelector(${JSON.stringify(option(name))})`, 15000);
  const inspect = name => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(option(name))}),r=el.getBoundingClientRect();return {label:el.getAttribute('aria-label'),width:r.width,height:r.height,dots:[...el.querySelectorAll('[data-judgment]')].map(d=>{const b=d.getBoundingClientRect(),s=getComputedStyle(d);return {name:d.dataset.judgment,color:s.backgroundColor,width:b.width,height:b.height,x:b.x-r.x,y:b.y-r.y,pointer:getComputedStyle(d.parentElement).pointerEvents}})}})()`);
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
    const graph = { '11': { class_type: 'LoadImage', inputs: { image: names[0] } }, '14': { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: 'judgments' } } };
    const outputs = names.map((name, i) => ({ name, fixture: 'flux-basic.png', width: 96, height: 64, mtime: 2100020008 - i }));
    assert((await control(FAKE, { reset: true, publishInputs: [names[0], names[7]].map(name => ({ name, fixture: 'flux-basic.png' })), publish: [...outputs, { name: target, fixture: 'flux-lora.png', graph, mtime: 2100020000 }] })).ok);
    assert((await control(OTHER, { reset: true, publish: outputs })).ok);
    await page.goto(ENGINE + '/#fake#' + names[7]);
    await page.poll(`!!document.querySelector('.card[data-name="${names[7]}"] .up')`, 20000);
    await setJudgment(names[7], { vote: 'up', favorite: true, bookmark: true });
    const colors = await evaluate(`Object.fromEntries(${JSON.stringify(flags)}.map(flag=>{const el=document.querySelector('.card[data-name="${names[7]}"] .'+flag);return [flag,getComputedStyle(el).color]}))`);
    await evaluate(`fetch('/api/collections/fake/entries/${target}/bytes')`);
    await invoke('variations.open', { id: 'fake:' + target });
    await addParameter(page, '11.image'); await openImageAdd(page);
    await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page); await waitName(names[7]);
    assert.equal((await inspect(names[7])).dots.length, 0, 'same-named input never inherits output judgments');
    await root('output'); await waitName(names[7]);
    const before = await inspect(names[0]); await shot('picker-before');
    const reads = catalogues.length;
    for (let i = 0; i < names.length; i++) await setJudgment(names[i], { vote: i & 1 ? 'up' : null, favorite: !!(i & 2), bookmark: !!(i & 4) });
    await page.poll(`document.querySelectorAll('.vz-input-judgment').length===12`);
    const combinations = [];
    for (let i = 0; i < names.length; i++) {
      const actual = await inspect(names[i]), expected = flags.filter((_, bit) => i & (1 << bit));
      assert.deepEqual(actual.dots.map(dot => dot.name), expected);
      assert.equal(actual.label, [names[i], ...labels.filter((_, bit) => i & (1 << bit))].join(', '));
      assert.equal(actual.width, before.width); assert.equal(actual.height, before.height);
      for (let d = 0; d < actual.dots.length; d++) {
        const dot = actual.dots[d]; assert.equal(dot.color, colors[dot.name]);
        assert.equal(dot.width, 8); assert.equal(dot.height, 8); assert.equal(dot.pointer, 'none');
        assert.equal(dot.x, 6 + d * 8); assert.equal(dot.y, 6);
      }
      combinations.push(actual);
    }
    await page.poll(`[...document.querySelectorAll('.vz-input-option img')].filter(el=>el.complete&&el.naturalWidth>0).length>=8`, 20000);
    await shot('picker-judgment-dots');
    // A pending feed judgment updates immediately and rejection restores the dots.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `*/entries/${names[0]}/judgment`, requestStage: 'Request' }] });
    let paused;
    const onPause = event => { const message = JSON.parse(event.data); if (message.method === 'Fetch.requestPaused') paused = message.params; };
    page.ws.addEventListener('message', onPause);
    await evaluate(`(async()=>{window.dotVote=${KZ}.handles.invoke('judgment.apply',{id:'fake:${names[0]}',intent:{type:'set',patch:{vote:'up'}}});return true})()`);
    await page.poll(`document.querySelector(${JSON.stringify(option(names[0]))}).querySelector('[data-judgment="up"]')!==null`);
    for (const end = Date.now() + 10000; !paused && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 25));
    assert(paused);
    await page.send('Fetch.fulfillRequest', { requestId: paused.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from('{"error":"controlled rejection"}').toString('base64') });
    await evaluate('window.dotVote');
    await page.poll(`document.querySelector(${JSON.stringify(option(names[0]))}).querySelectorAll('[data-judgment]').length===0`);
    await page.send('Fetch.disable'); page.ws.removeEventListener('message', onPause);
    assert.equal(catalogues.length, reads, 'live changes and rollback never refetch');
    const response = await fetch(ENGINE + '/api/collections/another/entries/' + names[0] + '/judgment', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true, bookmark: true }) });
    assert(response.ok);
    await page.clickAt('.vz-input-tabs [data-value="another"]'); await waitName(names[0]);
    assert.deepEqual((await inspect(names[0])).dots.map(dot => dot.name), ['favorite', 'bookmark'], 'foreign catalogue uses its own flags');
    assert.deepEqual((await inspect(names[7])).dots, [], 'same name does not borrow local flags');
    await page.clickAt('.vz-input-tabs [data-value="fake"]'); await waitName(names[7]);
    assert.deepEqual((await inspect(names[7])).dots.map(dot => dot.name), flags);
    await root('input'); await waitName(names[7]); assert.equal((await inspect(names[7])).dots.length, 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(E + '/judgment-dots-proof.json', JSON.stringify({ colors, before, combinations, catalogues, pageErrors: errors }, null, 2));
    console.log('PASS eight judgment combinations, feed colors, accessible order, 96px geometry, optimistic update/rollback, source isolation, input exclusion and no extra reads/page errors');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
