// Every advertised viewer shortcut reaches its rendered consumer, including remaps.
const assert = require('node:assert/strict');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
const KZ = `(await import('/store/instance.js')).appStore`;

(async () => {
  const page = await CDP.launch(9383, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const state = expression => `(async()=>${expression})()`;
  const invoke = (command, args = {}) => page.evaluate(state(`${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`));
  const title = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).title`);
  const key = async value => {
    // Native focus remains on the user's clicked control, not document.
    await page.keyTrusted(value, { vk: value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0 });
  };
  const openPair = async kind => {
    await invoke('workbench.openPair', {
      left: { source: 'fake', file: kind === 'video' ? 'hint-video.webm' : 'flux-basic.png' },
      right: { source: 'another', file: 'flux-basic.png' }, push: true,
    });
    await page.poll(`!document.querySelector('#diff').hidden && !!document.querySelector('#diffModes')`);
    await page.poll(state(`${KZ}.state.diffKind() === '${kind}'`));
  };
  const modes = [
    ['wb.full', 'f', 'full', 'Full'], ['wb.twoUp', '1', 'two-up', 'Two-Up'],
    ['wb.oneUp', '2', 'one-up', 'One-Up'], ['wb.split', '3', 'split', 'Split'],
    ['wb.difference', '4', 'difference', 'Difference'],
  ];
  const modeProof = async (kind, remaps = {}) => {
    for (const [id, original, mode, imageLabel] of modes) {
      if (kind === 'video' && mode === 'difference') continue;
      const label = kind === 'video' ? ({ 'two-up': 'Split', 'one-up': 'Overlay', split: 'Slider' }[mode] ?? imageLabel) : imageLabel;
      const shortcut = remaps[id] ?? original;
      // Start elsewhere so the assertion cannot pass on an existing mode.
      await invoke('workbench.mode', { mode: mode === 'full' ? 'two-up' : 'full' });
      const selector = `#diffModes button[title=${JSON.stringify(`${label} (${shortcut})`)}]`;
      assert(await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `${label} must advertise ${shortcut}`);
      await key(shortcut);
      await page.poll(state(`${KZ}.state.diff.mode === ${JSON.stringify(mode)}`));
      await page.poll(`document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-pressed') === 'true'`);
      console.log(`ok ${kind} ${label} (${shortcut}) changes the rendered active view`);
    }
  };
  try {
    const published = await fetch(FAKE + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: [{ name: 'hint-video.webm', fixture: 'media/workflow.webm', mtime: 2100000100 }] }),
    });
    assert(published.ok);
    await page.goto(ENGINE + '/#fake');
    await page.poll(`!!document.querySelector('.card')`, 20000);
    await openPair('image');
    await modeProof('image');
    await key('1');
    assert.equal(await title('.dz-sidebtn'), 'active side — primary in every view (ArrowLeft/Right)');
    for (const [shortcut, label] of [['ArrowRight', 'B'], ['ArrowLeft', 'A']]) {
      await key(shortcut);
      await page.poll(`document.querySelector('.dz-sidebtn')?.textContent === '${label}'`);
      console.log(`ok ${shortcut} changes the rendered active side to ${label}`);
    }
    for (const locked of [false, true]) {
      assert.equal(await title('#diffAlignment'), 'comparison alignment (a); shared / independent (l)');
      await key('l');
      await page.poll(`document.querySelector('#diffAlignment')?.value === '${locked ? 'shared' : 'independent'}'`);
      console.log(`ok l toggles rendered lock to ${locked}`);
    }
    assert.equal(await title('#diffKeysBtn'), 'actions & keys (?)');
    await key('?');
    await page.poll(`!!document.querySelector('#keysPanel')`);
    await key('Escape');
    await page.poll(`!document.querySelector('#keysPanel')`);
    assert.equal(await title('#diffClose'), 'close (Esc)');
    await key('Escape');
    await page.poll(`document.querySelector('#diff').hidden`);
    console.log('ok ? opens keys panel; Esc closes panel and viewer');
    await invoke('anchor.info.open', { name: 'hint-test' });
    await page.poll(`!!document.querySelector('#infoClose')`);
    assert.equal(await title('#infoClose'), 'close (Esc)');
    await key('Escape');
    await page.poll(`!document.querySelector('#infoClose')`);
    console.log('ok anchor info Esc closes the rendered modal');
    await openPair('video');
    await modeProof('video');
    await invoke('workbench.close');

    // Use the real capture path; persisted mappings feed the same live registry.
    const remaps = Object.fromEntries(modes.map(([id], i) => [id, ['g', '5', '6', '7', '8'][i]]));
    Object.assign(remaps, { 'wb.colLeft': 's', 'wb.colRight': 'd', 'wb.lock': 'k', 'wb.close': 'x', 'app.keys': 'j', 'wb.alignment': 'v' });
    for (const [id, shortcut] of Object.entries(remaps)) {
      await page.evaluate(state(`${KZ}.actions.keys.startCapture(${JSON.stringify(id)})`));
      await key(shortcut);
    }
    await openPair('image');
    await modeProof('image', remaps);
    await key('5');
    assert.equal(await title('#diffAlignment'), 'comparison alignment (v); shared / independent (k)');
    await invoke('workbench.alignment', { mode: 'independent' });
    await key('v'); await page.poll(`document.querySelector('#diffAlignment')?.value === 'shared'`);
    assert.equal(await title('.dz-sidebtn'), 'active side — primary in every view (s/d)');
    for (const [shortcut, label] of [['d', 'B'], ['s', 'A']]) {
      await key(shortcut);
      await page.poll(`document.querySelector('.dz-sidebtn')?.textContent === '${label}'`);
    }
    const locked = await page.evaluate(state(`${KZ}.state.diff.locked`));
    assert((await title('#diffAlignment')).endsWith(' (k)'));
    await key('k');
    await page.poll(`document.querySelector('#diffAlignment')?.value === '${!locked ? 'shared' : 'independent'}'`);
    assert.equal(await title('#diffKeysBtn'), 'actions & keys (j)');
    await key('j');
    await page.poll(`!!document.querySelector('#keysPanel')`);
    // The default-key tooltip is explanatory, not an active shortcut claim.
    assert(await page.evaluate(`[...document.querySelectorAll('.kbd')].some(e => e.textContent === 'k' && e.title === 'default: l — click to rebind, right-click resets')`));
    await key('Escape');
    assert.equal(await title('#diffClose'), 'close (x)');
    await key('x');
    await page.poll(`document.querySelector('#diff').hidden`);
    await page.poll(`(async()=>{
      const saved = await (await fetch('/api/settings/core.keys')).json();
      return Object.entries(${JSON.stringify(remaps)}).every(([id,key]) => saved[id] === key);
    })()`);
    await page.goto(ENGINE + '/#fake');
    await page.poll(state(`${KZ}.state.bindings().find(b => b.id === 'wb.full')?.key === 'g'`), 20000);
    await openPair('video');
    await modeProof('video', remaps);
    console.log('ok remapped side, lock, keys, close and modes; saved mode hints survive cold reload');
    assert.deepEqual(errors, [], 'no uncaught browser exceptions');
    console.log('key hints e2e OK');
  } finally {
    // Await the fixture reset before closing the browser; resetAll's fire-and-
    // forget preference writes could otherwise be cancelled by browser shutdown.
    await page.evaluate(`(async()=>{
      const s = ${KZ};
      const response = await fetch('/api/settings/core.keys', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(s.state.bindings().map(b => [b.id, null]))),
      });
      if (!response.ok) throw new Error('key fixture reset failed');
      await s.actions.keys.loadSaved();
    })()`);
    const removed = await fetch(FAKE + '/__test/activity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove: ['hint-video.webm'] }),
    });
    assert(removed.ok);
    await invoke('workbench.close');
    await page.evaluate(state(`${KZ}.actions.ui.refresh()`));
    await page.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
