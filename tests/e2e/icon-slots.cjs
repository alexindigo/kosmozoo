// Real rendered geometry, across every consumer of the shared icon allocation.
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { pickInput, openImageFolder } = require('./image-picker-helpers.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261';
const KZ = '(await import("/store/instance.js")).appStore';

(async () => {
  const page = await CDP.launch(9361, { windowSize: '1800,1200' });
  const errors = await collectPageErrors(page), records = [], problems = [];
  const invoke = (id, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(id)}, ${JSON.stringify(args)}))()`);
  const control = async body => {
    const response = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error('fixture control: ' + response.status);
  };
  const frame = () => page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const shot = async name => {
    await frame();
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(workPath(`artifacts/icon-slots-${name}.png`), Buffer.from(image.data, 'base64'));
  };
  const inspect = async (name, selector, minimum = 1) => {
    await frame();
    const rows = await page.evaluate(`(() => {
      const visible = el => { for (let p = el; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0 || p.hidden) return false; } return el.getBoundingClientRect().width > 0; };
      return [...document.querySelectorAll(${JSON.stringify(selector)})].filter(visible).map(control => {
        const slot = control.matches('select') ? control.parentElement.querySelector('.chevron-slot') : control.querySelector('.chevron-slot') ?? control;
        const icon = slot?.querySelector('svg'), box = slot?.getBoundingClientRect(), glyph = icon?.getBoundingClientRect();
        const outer = control.closest('.search-control')?.getBoundingClientRect() ?? control.getBoundingClientRect();
        return { title: control.title || control.getAttribute('aria-label'), classes: control.className,
          control: outer.toJSON(), slot: box?.toJSON(), icon: glyph?.toJSON(),
          gaps: glyph && { left: glyph.left - box.left, right: box.right - glyph.right, top: glyph.top - box.top, bottom: box.bottom - glyph.bottom },
          trailing: !!slot?.classList.contains('chevron-slot'),
          facing: glyph && (slot?.classList.contains('chevron-slot') || control.matches('.vz-search-clear')) ? { right: outer.right - glyph.right, top: glyph.top - outer.top, bottom: outer.bottom - glyph.bottom } : null };
      });
    })()`);
    records.push({ name, rows });
    if (rows.length < minimum) problems.push(`${name}: expected >= ${minimum}, got ${rows.length}`);
    for (const row of rows) {
      const gaps = row.gaps && Object.values(row.gaps);
      if (!gaps || Math.max(...gaps) - Math.min(...gaps) > 1 || Math.min(...gaps) < 0) problems.push(`${name}/${row.title}: unequal or missing icon slot ${JSON.stringify(row.gaps)}`);
      if (row.slot && Math.abs(row.slot.width - row.slot.height) > 1) problems.push(`${name}/${row.title}: non-square slot`);
      if (row.facing && Math.max(...Object.values(row.facing)) - Math.min(...Object.values(row.facing)) > 1) problems.push(`${name}/${row.title}: unequal control-facing gaps ${JSON.stringify(row.facing)}`);
    }
    console.log(`${name}: ${rows.length} controls; ${JSON.stringify(rows.map(r => ({ title: r.title, gaps: r.gaps, facing: r.facing })))}`);
  };
  try {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await control({ publish: [{ name: 'icon-slots.webm', fixture: 'media/workflow.webm', mtime: 2100000200 }] });
    await page.goto(ENGINE);
    await page.poll(`(async () => !!${KZ}.state.hosts.fake && !!document.querySelector('.card'))()`);
    await page.evaluate(`(async () => { const s = ${KZ}; await s.actions.hosts.select('fake'); s.actions.folders.select(''); s.actions.ui.setFilter(''); await s.actions.ui.refresh(); })()`);
    await inspect('header', '#chrome .chrome-icon', 2);
    await inspect('output-folder', '#outputFolder');
    // Native option construction must precede the controlled value write,
    // including a synthetic unavailable folder first seen during cold boot.
    const unavailable = 'icon-slot/unavailable';
    await page.goto(ENGINE + '/?folder=' + encodeURIComponent(unavailable) + '#fake');
    await page.poll(`(async () => !${KZ}.state.inventory.loading && ${KZ}.state.images.length > 0)()`);
    const selection = await page.evaluate(`(async () => ({ value: document.querySelector('#outputFolder').value,
      model: ${KZ}.state.selectedFolder(), options: [...document.querySelector('#outputFolder').options].map(o => o.value) }))()`);
    if (selection.value !== unavailable || selection.model !== unavailable) problems.push('native Select lost its controlled value while constructing options: ' + JSON.stringify(selection));
    await page.evaluate(`(async () => ${KZ}.actions.folders.select(''))()`);
    await page.poll("!!document.querySelector('.card .votebtn')");
    await inspect('feed-actions', '.card .btnwrap .votebtn', 7);
    await page.clickAt('#hostBtn');
    await page.poll('!!document.querySelector("#hostMenu .chrome-icon, .hostmenu .chrome-icon, #hostPicker .chrome-icon")');
    await inspect('source-actions', '#hostPicker .chrome-icon', 2);
    await page.clickAt('#hostBtn');
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.ui.setFilter('icon-slots.webm'); })()`);
    await page.poll("!!document.querySelector('.card .media-controls') && !!document.querySelector('.card .media-play')");
    await inspect('feed-media', '.card .media-controls button, .card .media-play', 5);
    await page.evaluate(`(async () => ${KZ}.actions.ui.setFilter(''))()`);
    await invoke('entry.select', { source: 'fake', file: 'icon-slots.webm' });
    await page.poll("document.querySelector('#workspace')?.textContent.includes('SaveVideo')");
    await shot('header');
    await invoke('workbench.openPair', { left: { source: 'fake', file: 'icon-slots.webm' }, right: { source: 'fake', file: 'flux-basic.png' } });
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll("!!document.querySelector('#diffMedia .media-loop')");
    await inspect('viewer-video', '#diffBar .viewer-btn:has(svg), #diffClose, #diffMedia button', 10);
    await invoke('workbench.openPair', { left: { source: 'fake', file: 'flux-basic.png' }, right: { source: 'fake', file: 'flux-lora.png' } });
    await invoke('workbench.mode', { mode: 'difference' });
    await page.poll("!!document.querySelector('.dz-threshold')");
    await inspect('viewer-image', '#diffBar .viewer-btn:has(svg), #diffClose', 10);
    await invoke('workbench.close');
    await page.evaluate("fetch('/api/collections/fake/entries/flux-controlnet.png/bytes').then(r => r.arrayBuffer()).then(() => true)");
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await page.poll("!!document.querySelector('.vz-image-set') && !!document.querySelector('.vz-row-inc')");
    if (await page.evaluate("!!document.querySelector('.vz-workspace')")) problems.push('single recipe shows an unavailable switcher');
    await page.clickAt('.vz-field-filter input');
    await page.send('Input.insertText', { text: 'image' });
    await inspect('field-filter-clear', '.vz-field-filter button');
    await page.clickAt('.vz-field-filter button');
    await inspect('dialog-close', 'button.vz-close, .vz-close button');
    await inspect('step', '.vz-row-inc button', 2);
    if (!await page.evaluate("document.querySelector('.vz-image-set .checkbox').checked")) await page.clickAt('.vz-image-set .checkbox');
    await pickInput(page, 'canny.png');
    await page.evaluate("document.querySelector('.vz-image-tile').focus()");
    await inspect('image-remove', '.vz-image-remove button');
    await openImageFolder(page);
    // Browser mode has no chooser; measure the available desktop state through
    // the same public acquisition component, with capability injected.
    await page.evaluate(`(async()=>{const {render,createComponent}=await import('/vendor/solid/web.mjs'),{FolderImages}=await import('/features/variations/FolderImages.js');const root=document.createElement('div');root.id='folder-geometry';document.querySelector('.vz-folder').append(root);window.__folderGeometry=()=>{dispose();root.remove()};const dispose=render(()=>createComponent(FolderImages,{capability:()=>({available:true}),registerEditor:()=>()=>{},onChoose:async()=>({path:null}),onAdd:async()=>({count:0})}),root)})()`);
    await inspect('folder', '#folder-geometry .vz-folder-chooser button');
    await page.evaluate('__folderGeometry()');
    await inspect('input-trigger', '.vz-input-trigger');
    await page.clickAt('.vz-input-trigger');
    await page.poll("!!document.querySelector('.vz-input-search') && getComputedStyle(document.querySelector('.vz-input-popover')).opacity === '1'");
    await page.clickAt('.vz-input-search');
    await page.evaluate("document.querySelector('.vz-input-search').select()");
    await page.send('Input.insertText', { text: 'canny' });
    await page.poll("document.querySelector('.vz-input-search').value === 'canny'");
    await inspect('search-clear', '.vz-search-clear');
    await shot('input-search');
    if (await page.evaluate("!!document.querySelector('.vz-search-clear')")) {
      await page.clickAt('.vz-search-clear');
      await page.poll("document.querySelector('.vz-input-search').value === '' && document.activeElement.matches('.vz-input-search') && !document.querySelector('.vz-search-clear')");
    }
    await page.keyTrusted('Escape', { vk: 27 });
    await page.poll("!document.querySelector('.vz-input-popover')");
    await page.evaluate("document.querySelector('.vz-sliders').scrollTop = 0; document.activeElement.blur()");
    await shot('variations');
    // Updating option presentation must retain the native control/focus for
    // the same semantic choice, just as the original comparison group did.
    const modeIdentity = await page.evaluate(`(async () => {
      try {
        const { ModeSwitch } = await import('/components/ModeSwitch.js');
        const { createSignal } = await import('/vendor/solid/solid.mjs');
        const { render, createComponent } = await import('/vendor/solid/web.mjs');
        const { iconSvg } = await import('/js/icons.mjs');
        const surface = document.createElement('div'); surface.style.cssText = 'position:fixed;bottom:0;right:0'; document.body.append(surface);
        const [options, setOptions] = createSignal([{ value: 'a', label: 'A', icon: iconSvg('x') }]);
        const dispose = render(() => createComponent(ModeSwitch, { get options() { return options(); }, value: 'a', label: 'Mode identity probe', onChange() {} }), surface);
        try {
          const button = surface.querySelector('button'); button.focus();
          setOptions(options().map(option => ({ ...option, title: 'Updated presentation' })));
          await new Promise(resolve => requestAnimationFrame(resolve));
          return { same: surface.querySelector('button') === button, focused: document.activeElement === button };
        } finally { dispose(); surface.remove(); }
      } catch (error) { return { error: String(error) }; }
    })()`);
    if (!modeIdentity.same || !modeIdentity.focused) problems.push('mode choices lost native identity/focus on presentation update: ' + JSON.stringify(modeIdentity));
    console.log('mode-choice identity: ' + JSON.stringify(modeIdentity));
    if (errors.length) problems.push('page errors: ' + JSON.stringify(errors));
    fs.writeFileSync(workPath('artifacts/icon-slots.json'), JSON.stringify({ records, problems, errors }, null, 2));
    for (const problem of problems) console.error('FAIL ' + problem);
    console.log(`icon-slot geometry: ${records.length} surfaces, ${records.reduce((sum, r) => sum + r.rows.length, 0)} controls, ${problems.length} failures`);
    if (problems.length) process.exitCode = 1;
  } finally {
    await page.close();
    await control({ remove: ['icon-slots.webm'] });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
