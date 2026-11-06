// Control availability and actual native opacity must agree across viewer transitions.
const assert = require('node:assert/strict');
const { CDP } = require('./cdp.cjs');
const fs = require('node:fs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const KZ = `(await import('/store/instance.js')).appStore`;

(async () => {
  const page = await CDP.launch(9333, { windowSize: '1600,1000' });
  const invoke = (id, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(id)}, ${JSON.stringify(args)}))()`);
  const frames = () => page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const capture = async name => {
    await frames();
    fs.mkdirSync('artifacts', { recursive: true });
    fs.writeFileSync(`artifacts/opacity-${name}.png`, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  };
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.goto(ENGINE + '/diff#fake#flux-basic.png:another#flux-basic.png');
    await page.poll(`document.querySelector('.dz-a img')?.naturalWidth > 0`, 20000);
    await page.key('1');
    await page.poll(`!!document.querySelector('.dz-active-op')`);
    await page.clickAt('.dz-active-op');
    const track = await page.evaluate(`(() => { const r = document.querySelector('.dz-vtrack').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height*.6 }; })()`);
    await page.mouse('mousePressed', track.x, track.y, { clickCount: 1, buttons: 1 });
    await page.mouse('mouseReleased', track.x, track.y, { clickCount: 1, buttons: 0 });
    await page.key('Escape');
    const chosen = await page.evaluate(`(async () => ${KZ}.state.diff.activeOpacity)()`);
    assert(Math.abs(chosen - .4) < .02, `slider selected ${chosen}`);
    const observe = () => page.evaluate(`(async () => {
      const s = ${KZ}, img = document.querySelector('.dz-cell[data-active="true"] img');
      return { control: !!document.querySelector('.dz-active-op'), opacity: Number(getComputedStyle(img).opacity), raw: s.state.diff.activeOpacity, mode: s.state.diff.mode };
    })()`);
    console.log('eligible comparison', JSON.stringify(await observe()));
    assert(Math.abs((await observe()).opacity - chosen) < .001);
    await capture('eligible');
    await page.key('f');
    await page.poll(`document.getElementById('diffStage').dataset.mode === 'full'`);
    const full = await observe();
    console.log('hidden-control Full', JSON.stringify(full));
    assert.equal(full.control, false);
    assert.equal(full.raw, chosen);
    assert.equal(full.opacity, 1, 'Full without an opacity control must render opaque');
    await capture('full');
    await page.key('1');
    await page.poll(`!!document.querySelector('.dz-active-op')`);
    assert(Math.abs((await observe()).opacity - chosen) < .001, 'return restores chosen opacity');
    for (const subject of ['b', 'a']) {
      await invoke('workbench.column', { column: subject === 'a' ? 'feed' : 'right' });
      for (const mode of ['two-up', 'one-up', 'split', 'full']) {
        await invoke('workbench.mode', { mode });
        await frames();
        await page.poll(`document.querySelector('.dz-${subject} img')?.naturalWidth > 0`);
        const result = await observe();
        assert.equal(result.control, mode !== 'full');
        assert(Math.abs(result.opacity - (mode === 'full' ? 1 : chosen)) < .001, JSON.stringify(result));
        assert.equal(result.raw, chosen);
        console.log(`image ${subject}/${mode}`, JSON.stringify(result));
      }
    }
    // Close the explicit /diff pair before selecting an ordinary unpaired
    // entry: an open /diff route intentionally retains its explicit peer.
    await invoke('workbench.close');
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setWorkspace('details'); s.actions.current.set('fake', 'flux-lora.png'); s.actions.diff.open(); })()`);
    await page.poll(`(async () => ${KZ}.state.diffPair().b === null)()`);
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll(`document.querySelector('.dz-a img')?.src.includes('flux-lora.png')`);
    const unpaired = await observe();
    assert.equal(unpaired.control, false);
    assert.equal(unpaired.opacity, 1);
    assert.equal(unpaired.raw, chosen);
    console.log('unpaired comparison', JSON.stringify(unpaired));
    await invoke('workbench.close');
    const pair = { left: { source: 'fake', file: 'flux-basic.png' }, right: { source: 'another', file: 'flux-basic.png' } };
    await invoke('workbench.openPair', pair);
    await page.poll(`document.querySelector('.dz-a img')?.naturalWidth > 0`);
    assert.equal((await observe()).opacity, 1, 'reopen in Full is opaque');
    await invoke('workbench.mode', { mode: 'two-up' });
    assert(Math.abs((await observe()).opacity - chosen) < .001, 'reopen retains comparison choice');
    // Identical pair: highlight opacity cannot change the base. Read canvas
    // pixels after its completed paint, not its default empty buffer.
    await invoke('workbench.parameters', { parameter: 'opacity', value: 0 });
    await invoke('workbench.mode', { mode: 'difference' });
    const basePixel = `(() => {
      const c = document.querySelector('.dz-canvas'), img = document.querySelector('.dz-a img');
      if (!c || c.width < 1000 || !img?.naturalWidth) return false;
      const p = document.createElement('canvas'); p.width = p.height = 1;
      p.getContext('2d').drawImage(img, img.naturalWidth/2, img.naturalHeight/2, 1, 1, 0, 0, 1, 1);
      const base = [...p.getContext('2d').getImageData(0, 0, 1, 1).data];
      const paint = [...c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data];
      return base.slice(0,3).some(v => v > 20) && base.slice(0,3).every((v,i) => Math.abs(v * ${chosen} - paint[i]) < 2) && paint[3] === 255;
    })()`;
    await page.poll(basePixel);
    assert(await page.evaluate(`!!document.querySelector('.dz-mask-op') && !!document.querySelector('.dz-active-op')`));
    await invoke('workbench.parameters', { parameter: 'opacity', value: .25 });
    await page.poll(basePixel);
    console.log('Difference: canvas base pixels reflect chosen opacity independently of highlight');
    // Video uses the same active native-media opacity contract; audio has no
    // opacity surface. Fixtures enter via the existing fake/refresh seam.
    const response = await fetch((process.env.E2E_FAKE ?? 'http://127.0.0.1:18261') + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publish: [
        { name: 'opacity-video.webm', fixture: 'media/workflow.webm', mtime: 2100009000 },
        { name: 'opacity-audio.wav', fixture: 'media/workflow.wav', mtime: 2100008999 },
      ] }),
    });
    assert(response.ok);
    await page.evaluate(`(async () => ${KZ}.actions.ui.refresh())()`);
    await invoke('workbench.openPair', { ...pair, left: { source: 'fake', file: 'opacity-video.webm' } });
    await page.poll(`document.querySelector('.dz-a video')?.readyState >= 2`, 20000);
    for (const mode of ['two-up', 'one-up', 'split', 'full']) {
      await invoke('workbench.mode', { mode }); await frames();
      const video = await page.evaluate(`(() => ({ control: !!document.querySelector('.dz-active-op'), opacity: Number(getComputedStyle(document.querySelector('.dz-a video')).opacity) }))()`);
      assert.equal(video.control, mode !== 'full');
      assert(Math.abs(video.opacity - (mode === 'full' ? 1 : chosen)) < .001);
      console.log(`video/${mode}`, JSON.stringify(video));
    }
    await invoke('workbench.openPair', { ...pair, left: { source: 'fake', file: 'opacity-audio.wav' } });
    await page.poll(`document.querySelector('.dz-a audio')?.readyState >= 2`, 20000);
    assert.equal(await page.evaluate(`!!document.querySelector('.dz-active-op') || !!document.querySelector('.dz-mask-op')`), false);
    assert.equal(await page.evaluate(`(async () => ${KZ}.state.diff.activeOpacity)()`), chosen);
    console.log('audio: opacity controls absent, raw choice retained');
    console.log('OPACITY SCOPE: ALL PASS');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
