// Task 2's contract at the rendered consumer, across all four input kinds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { discardRecipe } = require('./recipe-helpers.cjs');
module.exports = async ({ cdp, check, KZ }) => {
  const kinds = ['.vz-slider-row', '.vz-enumrow', '.vz-textrow', '.vz-image-set'];
  const row = kind => kind === '.vz-slider-row' ? '[data-param-key="9.denoise"]' : kind;
  const toggle = kind => cdp.clickAt(`${row(kind)} .vz-parameter-heading .checkbox`);
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
  await cdp.poll(kinds.map(kind => `!!document.querySelector('${kind}')`).join('&&'));
  await discardRecipe(cdp);await cdp.poll("!!document.querySelector('.vz-image-set')");
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  try {
    await toggle('.vz-slider-row');
    const geometry = await cdp.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('.vz-parameter')],list=document.querySelector('.vz-sliders');
      return { rows:rows.map(el=>({name:el.querySelector('.vz-parameter-name').textContent,
        height:el.getBoundingClientRect().height,x:el.querySelector('.vz-parameter-name').getBoundingClientRect().x,
        opacity:getComputedStyle(el).opacity,body:!!el.querySelector('.vz-numeric-editor,.vz-imgrow-body,.vz-image-content'),
        current:el.querySelector('.vz-parameter-current').textContent})),scroll:list.scrollWidth-list.clientWidth};
    })()`);
    assert(geometry.rows.length > 6);
    assert(geometry.rows.every(item => !item.body && item.height <= 41));
    assert(Math.max(...geometry.rows.map(item => item.height))-Math.min(...geometry.rows.map(item => item.height)) <= 1);
    check('row frame: every closed kind is one equal-height line, with no body in the DOM', true, JSON.stringify(geometry));
    assert(geometry.rows.every(item => item.opacity === '0.55'));
    check('row frame: all closed cards, including images, have opacity 0.55', true);
    assert(geometry.rows.every(item => Math.abs(item.x-geometry.rows[0].x) < 0.5));
    check('row frame: names share one left inset across all kinds', true);
    assert(geometry.scroll <= 1);
    check('row frame: list has no horizontal scroll', true);
    assert(geometry.rows.every(item => item.name.includes('.') && !item.name.includes('#') && !item.current.startsWith('Current ')));
    assert.equal(await cdp.evaluate("document.querySelector('.vz-image-set .vz-parameter-current').textContent"), 'canny.png');
    assert(await cdp.evaluate("!document.querySelector('.vz-insert-parameter,.vz-name-example,.vz-name-help,.vz-parameter-identity')&&document.querySelector('.vz-run').textContent==='Run'"));
    check('row frame: raw ComfyUI names, current image filename and Run replace retired chrome', true);
    // Use trusted button activation and both naming targets. Insertion must not
    // enable a row, and opaque graph IDs must survive the display-name change.
    for (const [index, kind] of kinds.entries()) {
      const target = index % 2 ? '.vz-suffix' : '.vz-prefix';
      await cdp.evaluate(`(()=>{const input=document.querySelector('${target}');input.focus();input.select()})()`);
      await cdp.send('Input.insertText', { text: 'pre__post' });
      await cdp.evaluate(`document.querySelector('${target}').setSelectionRange(4,4)`);
      const id = await cdp.evaluate(`(()=>{const r=document.querySelector('${row(kind)}');return r.dataset.paramKey??r.dataset.enumId??r.dataset.textId??r.dataset.imageId})()`);
      await cdp.clickAt(`${row(kind)} .vz-parameter-name`);
      assert.equal(await cdp.evaluate(`document.querySelector('${target}').value`), `pre_{${id}}_post`);
      assert.equal(await cdp.evaluate(`document.querySelector('${row(kind)} .checkbox').checked`), false);
      assert(await cdp.evaluate(`document.activeElement===document.querySelector('${target}')`));
    }
    check('row frame: every kind inserts its canonical token at the focused prefix/suffix caret without toggling', true);
    // Keep the capture's naming valid and inspect the two state geometries.
    for (const selector of ['.vz-prefix','.vz-suffix']) await cdp.evaluate(`(()=>{const input=document.querySelector('${selector}');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    for (const kind of kinds) await toggle(kind);
    assert(await cdp.evaluate("[...document.querySelectorAll('.vz-parameter.on')].length===4&&[...document.querySelectorAll('.vz-parameter.on')].every(row=>getComputedStyle(row).opacity==='1')"));
    check('row frame: each expanded kind is full strength and mounts its editor', true);
    const numeric = '[data-param-key="9.denoise"]';
    await cdp.evaluate(`(()=>{const input=document.querySelector('${numeric} .vz-range-field:first-child input');input.value='0.7';input.dispatchEvent(new Event('change',{bubbles:true}));const step=document.querySelector('${numeric} .vz-row-inc-input');step.value='0.1';step.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    const text = '.vz-textrow .vz-text-values';
    await cdp.evaluate(`(()=>{const input=document.querySelector('${text}');input.value='retained template';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await cdp.clickAt('.vz-enumrow.on .vz-enum-opt:last-child .checkbox');
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer();const input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File([bytes],'row-retained.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("!document.querySelector('.vz-image-check')");
    const picks = await cdp.evaluate("[...document.querySelectorAll('.vz-enumrow.on .vz-enum-opt .checkbox')].map(input=>input.checked)");
    for (const kind of kinds) { await toggle(kind); await toggle(kind); }
    assert.equal(await cdp.evaluate(`document.querySelector('${numeric} .vz-range-field:first-child input').value`), '0.7');
    assert.equal(await cdp.evaluate(`document.querySelector('${numeric} .vz-row-inc-input').value`), '0.1');
    assert.equal(await cdp.evaluate(`document.querySelector('${text}').value`), 'retained template');
    assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.vz-enumrow.on .vz-enum-opt .checkbox')].map(input=>input.checked)"), picks);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-image-tile').dataset.imageName"), 'row-retained.png');
    await cdp.poll("document.querySelector('.vz-image-tile img')?.naturalWidth>0");
    check('row frame: numeric bounds/raw increment, enum picks, text and native File preview survive collapse/reopen', true);
    assert(await cdp.evaluate("[...document.querySelectorAll('.vz-parameter.on .vz-parameter-current')].every(el=>/\\d+ (values?|options?|images?)/.test(el.textContent))"));
    check('row frame: open headings show their contributed values/options/images', true);
    await toggle('.vz-image-set');await toggle('.vz-textrow');
    await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
    if (process.env.E2E_ROW_FRAME_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_ROW_FRAME_SHOT, Buffer.from(shot.data, 'base64'));
    }
    for (const width of [768,500]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      assert(await cdp.evaluate("document.querySelector('.vz-sliders').scrollWidth<=document.querySelector('.vz-sliders').clientWidth+1"));
    }
    check('row frame: expanded list remains free of horizontal scroll at 768px and 500px', true);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    // A close request is asynchronous; wait for its decision before confirming.
    await cdp.poll("!!document.querySelector('.vz-discard')||!document.querySelector('.vz-panel')");
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  }
};
