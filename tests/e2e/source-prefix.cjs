// Consumer proof for the existing text-copy and card/bulk download paths.
// Run against an isolated engine with copysave pointing to E2E_FAKE.
// The fake's publication seam supplies root, nested and already-tagged entries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18960';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18961';
const KZ = `(await import('/store/instance.js')).appStore`;
const LABEL = 'Filename includes source';
const files = ['plain.png', 'day/nested.png', 'copysave#tagged.png'];

(async () => {
  const page = await CDP.launch(9397, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const root = fs.mkdtempSync(workPath('artifacts/source-prefix-'));
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const ready = () => page.poll(`(async()=>{const s=${KZ};return s.state.host()==='copysave'&&${JSON.stringify(files)}.every(name=>s.state.images.some(image=>image.filename===name))})()`);
  const openMenu = async () => {
    if (!await page.evaluate('!!document.querySelector("#sourcePrefix")')) await page.clickAt('#menuBtn');
    await page.poll('!!document.querySelector("#sourcePrefix")');
  };
  const waitFile = async (directory, name, expectedBytes) => {
    const file = path.join(directory, name), until = Date.now() + 10000;
    while (Date.now() < until) {
      if (fs.existsSync(file)) {
        assert.deepEqual(fs.readFileSync(file), expectedBytes, 'downloaded entry bytes reach the consumer');
        return;
      }
      await sleep(50);
    }
    throw Error('download missing: ' + name + '; directory: ' + fs.readdirSync(directory));
  };
  const directory = async (name) => {
    const dest = path.join(root, name); fs.mkdirSync(dest);
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dest });
    return dest;
  };
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const published = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: files.map((name, index) => ({ name, fixture: ['flux-basic.png', 'flux-lora.png', 'flux-controlnet.png'][index] })) }) });
    assert(published.ok, 'fake publishes root/nested/already-prefixed entries');
    await page.goto(ENGINE + '/#copysave');
    await page.poll(`(async()=>${KZ}.state.host()==='copysave'&&${KZ}.state.images.length>0)()`);
    await invoke('source.reload');
    await ready();
    await page.send('Browser.grantPermissions', { origin: ENGINE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Page.bringToFront');
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.filePrefs.sourcePrefix)()`), true, 'default is on');

    for (const enabled of [true, false]) {
      await openMenu();
      if (enabled === false) await page.clickAt('label:has(#sourcePrefix)');
      await page.poll(`document.querySelector('#sourcePrefix').checked===${enabled}`);
      if (!enabled) await page.poll(`(async()=>(await(await fetch('/api/settings/core.files')).json()).sourcePrefix===false)()`);
      await page.goto(ENGINE + '/#copysave');
      await ready();
      assert.equal(await page.evaluate(`(async()=>${KZ}.state.filePrefs.sourcePrefix)()`), enabled, 'preference survives reload');
      await openMenu();
      assert.equal(await page.evaluate(`document.querySelector('#sourcePrefix').checked`), enabled);
      assert.equal(await page.evaluate(`document.querySelector('label:has(#sourcePrefix)').textContent.trim()`), LABEL);

      const geometry = await page.evaluate(`(()=>{
        const label=document.querySelector('label:has(#sourcePrefix)'),track=label.querySelector('.track'),text=label.querySelector('.single-line-text');
        const l=label.getBoundingClientRect(),t=track.getBoundingClientRect(),r=text.getBoundingClientRect();
        const knob=getComputedStyle(track,'::after'),inset=parseFloat(knob.top),size=parseFloat(knob.height);
        return {whiteSpace:getComputedStyle(text).whiteSpace,wrap:r.height>parseFloat(getComputedStyle(text).lineHeight)*1.5,
          centerDelta:Math.abs((t.top+t.height/2)-(r.top+r.height/2)),inset,opposite:t.height-inset-size,
          visible:l.left>=0&&l.right<=innerWidth&&t.width===28};})()`);
      assert.equal(geometry.whiteSpace, 'nowrap');
      assert(!geometry.wrap && geometry.visible);
      assert(geometry.centerDelta < 1 && Math.abs(geometry.inset - geometry.opposite) < 1, JSON.stringify(geometry));
      await invoke('menu.close');
      const cardDir = await directory(`card-${enabled}`);
      const bytes = new Map();
      const downloads = [];
      for (const name of files) {
        const selector = `.card[data-name=${JSON.stringify(name)}]`;
        await invoke('feed.filter', { value: name });
        await page.poll(`!!document.querySelector(${JSON.stringify(selector + ' .copyable')})`);
        const expectedReference = enabled && !name.startsWith('copysave#') ? 'copysave#' + name : name;
        const leaf = name.split('/').at(-1);
        const expectedName = enabled && !leaf.startsWith('copysave#') ? 'copysave#' + leaf : leaf;
        bytes.set(name, Buffer.from(await (await fetch(ENGINE + '/api/collections/copysave/entries/' + encodeURIComponent(name) + '/bytes')).arrayBuffer()));
        await page.evaluate(`navigator.clipboard.writeText('awaiting-copy')`);
        await page.clickAt(selector + ' .copyable');
        await page.poll(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(expectedReference)})()`);
        await page.clickAt(selector + ' button.download');
        await waitFile(cardDir, expectedName, bytes.get(name));
        await page.clickAt(selector + ' .selcb');
        downloads.push(expectedName);
        console.log(`ok source-prefix ${enabled ? 'on' : 'off'}: clipboard ${expectedReference}; card download ${expectedName}`);
      }
      const bulkDir = await directory(`bulk-${enabled}`);
      await page.clickAt('#bulkBar .download');
      for (let i = 0; i < files.length; i++) await waitFile(bulkDir, downloads[i], bytes.get(files[i]));
      assert.deepEqual(fs.readdirSync(bulkDir).sort(), downloads.sort());
      await invoke('selection.clear');
      console.log(`ok source-prefix ${enabled ? 'on' : 'off'}: bulk delivers all three names and original bytes; reload persists setting`);
    }
    await invoke('feed.filter', { value: '' });
    await invoke('preference.sourcePrefix', { value: true });
    await page.goto(ENGINE + '/#copysave'); await ready(); await openMenu();
    assert.equal(await page.evaluate(`document.querySelector('#sourcePrefix').checked`), true, 'reenabled preference also persists');
    await page.poll(`document.querySelector('.card[data-name="copysave#tagged.png"] img')?.naturalWidth>0`);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath('artifacts/source-prefix-setting.png'), Buffer.from(shot.data, 'base64'));
    assert.deepEqual(errors, []);
    console.log('ok source-prefix: Settings alignment and toggle inset, no wrapping, default/on/off persistence, zero page exceptions');
  } finally {
    await page.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
