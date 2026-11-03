// Shared row consumer contract: card toggles, selected set-all and probe geometry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const KZ = '(await import("/store/instance.js")).appStore';
const card = '.card[data-name="flux-basic.png"]';

(async () => {
  const page = await CDP.launch(9401, { windowSize: '1600,1200' });
  const errors = await collectPageErrors(page);
  const invoke = (command, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}))()`);
  const shot = async name => {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath(`artifacts/entry-actions-${name}.png`), Buffer.from(image.data, 'base64'));
  };
  const crop = async (name, selector) => {
    const clip = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:2}})()`);
    const image = await page.send('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(workPath(`artifacts/entry-actions-${name}-2x.png`), Buffer.from(image.data, 'base64'));
  };
  try {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/#fixture-dir#flux-basic.png');
    await page.poll(`!!document.querySelector('${card} .bookmark')`);
    await invoke('selection.clear');
    await invoke('feed.filter', { value: 'flux-' });
    for (const file of ['flux-basic.png', 'flux-lora.png']) {
      await invoke('judgment.apply', { id: 'fixture-dir:' + file, intent: { type: 'set', patch: { vote: null, favorite: null, bookmark: null } } });
      await invoke('selection.set', { id: 'fixture-dir:' + file, value: true });
    }
    const rows = await page.evaluate(`(()=>{const variants=sel=>[...document.querySelectorAll(sel+' button')].map(b=>b.className.split(' ')[1]);return{card:variants('${card} .btnwrap'),bulk:variants('#bulkBar').filter(v=>v!=='clear-selection'),probe:variants('.card--probe .btnwrap')}})()`);
    assert.deepEqual(rows.bulk, rows.card, 'bar and card expose one ordered action catalogue');
    assert.deepEqual(rows.probe, rows.card, 'probe renders the same action catalogue');
    assert.deepEqual(rows.card, ['variations', 'down', 'up', 'favorite', 'bookmark', 'download', 'delete']);
    assert.equal(await page.evaluate(`!!document.querySelector('#bulkClear, #bulkBar .savebtn, #bulkBar [disabled]')`), false);
    console.log('ok shared ordered actions: ' + rows.card.join(', '));

    for (let pass = 0; pass < 2; pass++) {
      // Each completed bulk write replaces the transient chip. Snapshot DOM
      // identity so the previous pass's identical message cannot satisfy this one.
      await page.evaluate(`globalThis.__bulkBookmarkChips = new Set(document.querySelectorAll('#statusStack .statuschip')); true`);
      const freshStatus = `[...document.querySelectorAll('#statusStack .statuschip')].some(chip => !globalThis.__bulkBookmarkChips.has(chip) && chip.textContent === '2 images bookmarked')`;
      assert.equal(await page.evaluate(freshStatus), false, `pass ${pass + 1}: existing status is not a new completion`);
      await page.clickAt('#bulkBar .bookmark');
      await page.poll(freshStatus);
      await page.poll(`(async()=>{const s=${KZ};return ['flux-basic.png','flux-lora.png'].every(f=>s.state.cardState('fixture-dir:'+f).active.bookmark)})()`);
    }
    await page.evaluate(`delete globalThis.__bulkBookmarkChips`);
    assert.equal(await page.evaluate(`document.querySelector('#bulkBar .bookmark').hasAttribute('aria-pressed')`), false, 'selected set-all has no active state');
    for (const file of ['flux-basic.png', 'flux-lora.png']) {
      const entry = await (await fetch(ENGINE + '/api/collections/fixture-dir/entries/' + file)).json();
      assert.equal(entry.judgment.bookmark, true, 'set-all persisted on ' + file);
    }
    console.log('ok selection bookmark sets every entry, repeated click does not toggle');

    const directory = fs.mkdtempSync(workPath('artifacts/entry-actions-download-'));
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
    await page.clickAt('#bulkBar .download');
    for (let i = 0; i < 200 && fs.readdirSync(directory).filter(f => f.endsWith('.png')).length < 2; i++) await sleep(50);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['fixture-dir#flux-basic.png', 'fixture-dir#flux-lora.png']);
    for (const file of ['flux-basic.png', 'flux-lora.png']) {
      const bytes = Buffer.from(await (await fetch(ENGINE + '/api/collections/fixture-dir/entries/' + file + '/bytes')).arrayBuffer());
      assert.deepEqual(fs.readFileSync(directory + '/fixture-dir#' + file), bytes);
    }
    console.log('ok selected download delivers both original files');

    const geometry = await page.evaluate(`(()=>{const clear=document.querySelector('#bulkBar [title="Clear selection"]'),count=document.querySelector('#bulkCount');const a=clear.getBoundingClientRect(),b=count.getBoundingClientRect();return{left:a.right<=b.left,center:Math.abs(a.y+a.height/2-b.y-b.height/2),nowrap:getComputedStyle(count).whiteSpace}})()`);
    assert(geometry.left && geometry.center < 1 && geometry.nowrap === 'nowrap', JSON.stringify(geometry));
    await page.clickAt('#bulkBar [title="Clear selection"]');
    await page.poll(`(async()=>!document.querySelector('#bulkBar')&&Object.keys(${KZ}.state.selected).length===0)()`);
    console.log('ok clear-selection is left of one-line count, centered, and clears selection');

    for (const variant of ['bookmark', 'favorite', 'up']) {
      for (const active of [false, true]) {
        // bookmark starts on from the set-all test; others start off.
        const desired = variant === 'bookmark' ? active : !active;
        await page.clickAt(card + ' .' + variant);
        await page.poll(`document.querySelector('${card} .${variant}')?.getAttribute('aria-pressed')==='${desired}'`);
      }
    }
    console.log('ok card judgments toggle in both directions with active presentation');

    for (const width of [1000, 1600]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1200, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
      const geometry = await page.evaluate(`(async()=>{const s=${KZ},{cardHeight}=await import('/store/sizes.js'),c=document.querySelector('${card}'),p=document.querySelector('.card--probe');return{actual:c.getBoundingClientRect().height,expected:cardHeight(s.state.cardSize(s.state.imageIdxById().get('fixture-dir:flux-basic.png')),document.querySelector('#candidatesCol').clientWidth),title:c.querySelector('.ctitle').getBoundingClientRect().height,probe:p.querySelector('.ctitle').getBoundingClientRect().height}})()`);
      assert.equal(geometry.actual, geometry.expected, JSON.stringify(geometry));
      assert.equal(geometry.title, geometry.probe, JSON.stringify(geometry));
    }
    console.log('ok probe chrome and calculated card height match real card at narrow/wide widths');
    for (const file of ['flux-basic.png', 'flux-lora.png']) await invoke('selection.set', { id: 'fixture-dir:' + file, value: true });
    await page.evaluate(`document.querySelector('${card} .bookmark').focus()`);
    await shot('selected-focus');
    await crop('card-focus', card + ' .btnwrap');
    const r = await page.evaluate(`document.querySelector('#bulkBar .bookmark').getBoundingClientRect().toJSON()`);
    await page.mouse('mouseMoved', r.x + r.width / 2, r.y + r.height / 2);
    await shot('selected');
    await crop('bar-hover', '#bulkBar');
    assert.deepEqual(errors, []);
    console.log('ok entry-actions: zero page errors; full and 2x focus/hover review captures saved');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
