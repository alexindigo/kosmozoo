// Actual Comfy history -> engine binding -> shown record -> rendered Details.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE;
const OUT = process.env.KZ_GENERATION_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const request = async (base, path, body) => {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
};
const timed = (id, output, fixture, ms) => ({ id, output, fixture, messages: [
  ['execution_start', { prompt_id: id, timestamp: 1700000000000 }],
  ['execution_success', { prompt_id: id, timestamp: 1700000000000 + ms }],
] });
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await request(FAKE, '/__test/activity', {
    finish: [timed('generation-basic', 'timing/image.png', 'flux-basic.png', 140138),
      timed('generation-with-input', 'timing/with-input.png', 'flux-controlnet.png', 1325026)],
    publish: [{ name: 'unknown/image.png', fixture: 'flux-basic.png' }],
  });
  await request(ENGINE, '/api/collections', { name: 'folder', address: 'folder:/work/tests/fixtures' });
  // Wait for the existing engine-owned observer, never a browser-to-Comfy read.
  const url = '/api/collections/fake/entries/' + encodeURIComponent('timing/image.png') + '/meta';
  const deadline = Date.now() + 15000;
  while ((await request(ENGINE, url)).generationTimeMs !== 140138) {
    assert(Date.now() < deadline, 'history timing observation did not arrive');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await CDP.launch(19481, { windowSize: '1400,900' });
  const errors = await collectPageErrors(page), results = [];
  const text = expected => `document.querySelector('.ws-generation')?.textContent === ${JSON.stringify(expected)}`;
  const navigate = async name => {
    await page.evaluate(`(async()=>${KZ}.handles.invoke('entry.navigate',{source:'fake',file:${JSON.stringify(name)}}))()`);
  };
  const geometry = async () => page.evaluate(`(()=>{
    const head=document.querySelector('.ws-head'), box=document.querySelector('.ws-generation');
    const h=head.getBoundingClientRect(), b=box.getBoundingClientRect(), style=getComputedStyle(box);
    const label=box.querySelector('.ws-generation-label'),value=box.querySelector('.ws-generation-value');
    const l=label.getBoundingClientRect(),v=value.getBoundingClientRect();
    return {adjacent:head.nextElementSibling===box,head:h.toJSON(),box:b.toJSON(),
      border:style.borderTopWidth,label:l.toJSON(),value:v.toJSON(),
      contained:l.right<=b.right&&v.right<=b.right&&l.left>=b.left&&v.left>=b.left,
      singleLine:l.height<=20&&v.height<=20};
  })()`);
  const shot = async name => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(image.data, 'base64'));
  };
  try {
    await page.goto(ENGINE + '/#fake#' + encodeURIComponent('timing/image.png'));
    await page.poll(`(async()=>!!${KZ}.state.currentEntry()?.entry)()`, 20000);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
    await page.poll(text('Generation time: 2m 20s'), 20000);
    let bounds = await geometry();
    assert(bounds.adjacent && bounds.box.top >= bounds.head.bottom && Math.abs(bounds.box.left - bounds.head.left) < 1);
    assert.equal(bounds.border, '1px'); assert(bounds.contained && bounds.singleLine);
    results.push({ state: 'timed', bounds });
    await shot('generation-time-known');
    await navigate('unknown/image.png');
    await page.poll(text('Generation time: --'), 15000);
    await shot('generation-time-unavailable');
    results.push({ state: 'same-basename-unknown', text: await page.evaluate(`document.querySelector('.ws-generation').textContent`) });
    await request(FAKE, '/__test/activity', { finish: [timed('generation-late', 'unknown/image.png', 'flux-basic.png', 7000)] });
    await page.poll(text('Generation time: 7s'), 15000);
    results.push({ state: 'completion-updates-visible-image-without-navigation' });
    await navigate('timing/with-input.png');
    await page.poll(text('Generation time: 22m 5s'), 15000);
    await page.poll(`!!document.querySelector('.info-source-nodes .ws-generation')`, 10000);
    bounds = await geometry(); console.log('split geometry', JSON.stringify(bounds)); await shot('generation-time-split');
    assert(bounds.adjacent && bounds.contained && bounds.singleLine);
    results.push({ state: 'split-with-node-images', bounds });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 780, height: 850, deviceScaleFactor: 1, mobile: false });
    await page.poll(text('Generation time: 22m 5s'), 10000);
    bounds = await geometry(); assert(bounds.contained && bounds.singleLine);
    results.push({ state: 'narrow', bounds });
    await shot('generation-time-narrow');
    await navigate('timing/image.png');
    await page.poll(text('Generation time: 2m 20s'), 15000);
    await page.evaluate(`(async()=>${KZ}.handles.invoke('entry.navigate',{source:'folder',file:'flux-basic.png'}))()`);
    await page.poll(text('Generation time: --'), 15000);
    results.push({ state: 'folder-source-unavailable' });
    assert.deepEqual(errors, []);
    fs.writeFileSync(OUT + '/result.json', JSON.stringify({ results, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ passed: results.map(result => result.state), pageErrors: errors }));
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
