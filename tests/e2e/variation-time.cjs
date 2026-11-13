// Readonly original-image timing flows through the actual modal and preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, OUT = process.env.KZ_TIME_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const request = async (base, path, body) => {
  const response = await fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
};
const timing = (id, output, milliseconds) => ({ id, output, fixture: 'flux-basic.png', messages: [
  ['execution_start', { prompt_id: id, timestamp: 1700000000000 }],
  ['execution_success', { prompt_id: id, timestamp: 1700000000000 + milliseconds }],
] });
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await request(FAKE, '/__test/activity', { finish: [timing('time-a', 'estimate/a.png', 720000), timing('time-b', 'estimate/b.png', 360000)],
    publish: [{ name: 'estimate/unknown.png', fixture: 'flux-basic.png' }] });
  const deadline = Date.now() + 15000;
  while ((await request(ENGINE, '/api/collections/fake/entries/estimate%2Fa.png/meta')).generationTimeMs !== 720000) {
    assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 100));
  }
  const page = await CDP.launch(19491, { windowSize: '1400,900' });
  const errors = await collectPageErrors(page), results = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const row = '[data-param-key="9.steps"]';
  const field = async (selector, value) => page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('missing field');el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const wait = async (count, time) => {
    await page.poll(`document.querySelector('.vz-count')?.textContent===${JSON.stringify(count)} && document.querySelector('.vz-time-value')?.textContent===${JSON.stringify(time)}`, 15000);
    const geometry = await page.evaluate(`(()=>{
      const selectors=['.vz-count-group > .vz-rlabel','.vz-time-label','.vz-count','.vz-time-value','.vz-right','.vz-run','.vz-panel'];
      const elements=selectors.map(s=>document.querySelector(s)),rects=elements.map(e=>e.getBoundingClientRect());
      const [label,timeLabel,count,time,sidebar,run,panel]=rects;
      return {label:label.toJSON(),timeLabel:timeLabel.toJSON(),count:count.toJSON(),time:time.toJSON(),
        sidebar:sidebar.toJSON(),run:run.toJSON(),panel:panel.toJSON(),labelText:elements[1].textContent,
        nowrap:getComputedStyle(elements[1]).whiteSpace==='nowrap',
        contained:time.right<=sidebar.right&&timeLabel.right<=sidebar.right&&count.right<=time.left&&time.left>=sidebar.left,
        adjacent:timeLabel.left>label.left&&Math.abs(timeLabel.top-label.top)<1,
        numberDominant:parseFloat(getComputedStyle(elements[2]).fontSize)>parseFloat(getComputedStyle(elements[3]).fontSize)};
    })()`);
    assert.equal(geometry.labelText, 'Estimated time:');
    assert(geometry.contained && geometry.nowrap && geometry.adjacent && geometry.numberDominant, JSON.stringify(geometry));
    results.push({ count, time, geometry });
  };
  const shot = async name => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT + '/' + name + '.png', Buffer.from(image.data, 'base64'));
  };
  const close = async () => {
    await page.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await page.evaluate(`!!document.querySelector('.vz-discard')`)) await page.clickAt('.vz-discard-confirm');
    await page.poll(`!document.querySelector('.vz-panel')`);
  };
  const open = async names => {
    await invoke('variations.open', { ids: names.map(name => 'fake:' + name), bulk: names.length > 1 });
    await addParameter(page, '9.steps');
    await page.clickAt(row + ' .mode-switch button[title="Value"]');
    await field(row + ' .vz-value-field input', '19');
  };
  try {
    await page.goto(ENGINE + '/#fake#estimate%2Fa.png');
    await page.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='estimate/unknown.png'))()`, 20000);
    await open(['estimate/a.png']);
    await wait('1', '12m'); await shot('variation-time-complete');
    await page.clickAt(row + ' .mode-switch button[title="Range"]');
    await field(row + ' .vz-range-field:nth-child(1) input', '18');
    await field(row + ' .vz-range-field:nth-child(2) input', '19');
    await field(row + ' .vz-row-inc-input', '1');
    await wait('2', '24m');
    await field(row + ' .vz-row-inc-input', '-'); await wait('—', '--');
    await close();
    await open(['estimate/a.png', 'estimate/b.png']); await wait('2', '18m'); await close();
    await open(['estimate/a.png', 'estimate/unknown.png']);
    await wait('2', 'above 12m'); await shot('variation-time-partial');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 850, height: 600, deviceScaleFactor: 1, mobile: false });
    // The established narrow dialog retains its three tracks in an inner
    // horizontal scroller; programmatic focus is not a scroll command.
    await page.evaluate(`(()=>{const body=document.querySelector('.vz-body-scroll');body.scrollLeft=body.scrollWidth;})()`);
    await page.poll(`(()=>{const run=document.querySelector('.vz-run').getBoundingClientRect(),panel=document.querySelector('.vz-panel').getBoundingClientRect();return run.right<=panel.right;})()`);
    await wait('2', 'above 12m');
    const bounds = results.at(-1).geometry;
    console.log('narrow geometry', JSON.stringify(bounds));
    await shot('variation-time-narrow');
    assert(bounds.run.bottom <= bounds.panel.bottom && bounds.run.right <= bounds.panel.right);
    await close();
    await page.send('Emulation.clearDeviceMetricsOverride');
    await open(['estimate/unknown.png']); await wait('1', '--'); await shot('variation-time-unavailable');
    await close();
    assert.deepEqual(errors, []);
    const enqueues = await request(FAKE, '/__test/enqueues'); assert.equal(enqueues.length, 0);
    fs.writeFileSync(OUT + '/result.json', JSON.stringify({ results, pageErrors: errors, enqueues: enqueues.length }, null, 2));
    console.log(JSON.stringify({ passed: results.map(({ count, time }) => ({ count, time })), pageErrors: errors, enqueues: enqueues.length }));
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
