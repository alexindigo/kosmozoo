// Task 2's contract at the rendered consumer, across all four input kinds.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshRecipe } = require('./recipe-helpers.cjs');
const { toggleParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, check, KZ }) => {
  const kinds = ['.vz-slider-row', '.vz-enumrow', '.vz-textrow', '.vz-image-set'];
  const row = kind => kind === '.vz-slider-row' ? '[data-param-key="9.denoise"]' : kind;
  const ids = {'.vz-slider-row':'9.denoise','.vz-enumrow':'9.scheduler','.vz-textrow':'2.text','.vz-image-set':'43.image'};
  const toggle = kind => toggleParameter(cdp,ids[kind]);
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
  await cdp.poll("document.querySelectorAll('.vz-catalogue-row').length>0");
  await freshRecipe(cdp);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  try {
    const geometry = await cdp.evaluate(`(()=>{
      const rows=[...document.querySelectorAll('.vz-catalogue-row')],list=document.querySelector('.vz-catalogue-list');
      return { rows:rows.map(el=>({id:el.dataset.catalogueId,name:el.querySelector('.vz-catalogue-name').textContent,
        height:el.getBoundingClientRect().height,x:el.querySelector('.vz-catalogue-name').getBoundingClientRect().x,
        opacity:getComputedStyle(el).opacity,body:!!el.querySelector('.vz-numeric-editor,.vz-imgrow-body,.vz-image-content'),
        border:getComputedStyle(el).borderTopWidth,image:!!el.querySelector('.vz-catalogue-picture'),current:(el.querySelector('.vz-catalogue-current')??el.querySelector('.vz-catalogue-picture')).textContent})),scroll:list.scrollWidth-list.clientWidth};
    })()`);
    assert(geometry.rows.length > 6);
    assert(geometry.rows.every(item => !item.body && item.border === '1px'));
    const textRows=geometry.rows.filter(item=>!item.image);
    assert(Math.max(...textRows.map(item => item.height))-Math.min(...textRows.map(item => item.height)) <= 1);
    check('row frame: every closed kind uses the bordered catalogue card; textual cards share height and image cards retain their thumbnail allocation', true, JSON.stringify(geometry));
    assert(geometry.rows.every(item => item.opacity === '1'));
    check('row frame: unadded catalogue has ordinary foreground values', true);
    assert(geometry.rows.every(item => Math.abs(item.x-geometry.rows[0].x) < 0.5));
    check('row frame: names share one left inset across all kinds', true);
    assert(geometry.scroll <= 1);
    check('row frame: list has no horizontal scroll', true);
    // The complete catalogue distinguishes repeated class/input occurrences by node.
    assert(geometry.rows.every(item => item.name.length && !item.current.startsWith('Current ')));
    assert.deepEqual(geometry.rows.filter(item => item.id === '2.text' || item.id === '42.text').map(item => item.name), ['text', 'text']);
    assert.deepEqual(await cdp.evaluate("['2.text','42.text'].map(id=>document.querySelector('[data-catalogue-id=\"'+id+'\"] .vz-catalogue-node-name').textContent)"), ['CLIPTextEncode', 'CLIPTextEncode']);
    assert.equal(await cdp.evaluate("document.querySelector('[data-catalogue-id=\"43.image\"] .vz-catalogue-picture').title"), 'canny.png (input)');
    assert(await cdp.evaluate("!document.querySelector('.vz-insert-parameter,.vz-name-example,.vz-name-help,.vz-parameter-identity')&&document.querySelector('.vz-run').textContent==='Run'"));
    check('row frame: raw ComfyUI names, current image filename and Run replace retired chrome', true);
    // Open names insert at both naming targets without toggling. Closed names
    // now enable the shared row shell; opaque IDs remain the token identities.
    for (const [index, kind] of kinds.entries()) {
      await toggle(kind);
      const target = index % 2 ? '.vz-suffix' : '.vz-prefix';
      await cdp.evaluate(`(()=>{const input=document.querySelector('${target}');input.focus();input.select()})()`);
      await cdp.send('Input.insertText', { text: 'pre__post' });
      await cdp.evaluate(`document.querySelector('${target}').setSelectionRange(4,4)`);
      const id = await cdp.evaluate(`(()=>{const r=document.querySelector('${row(kind)}');return r.dataset.paramKey??r.dataset.enumId??r.dataset.textId??r.dataset.imageId})()`);
      await cdp.clickAt(`${row(kind)} .vz-parameter-name`);
      assert.equal(await cdp.evaluate(`document.querySelector('${target}').value`), `pre_{${id}}_post`);
      assert.equal(await cdp.evaluate(`!!document.querySelector('${row(kind)}.on .vz-parameter-remove')`), true);
      assert(await cdp.evaluate(`document.activeElement===document.querySelector('${target}')`));
      await toggle(kind);
    }
    check('row frame: every kind inserts its canonical token at the focused prefix/suffix caret without toggling', true);
    // Keep the capture's naming valid and inspect the two state geometries.
    for (const selector of ['.vz-prefix','.vz-suffix']) await cdp.evaluate(`(()=>{const input=document.querySelector('${selector}');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    for (const kind of kinds) await toggle(kind);
    assert(await cdp.evaluate("[...document.querySelectorAll('.vz-parameter.on')].length===4&&[...document.querySelectorAll('.vz-parameter.on')].every(row=>getComputedStyle(row).opacity==='1')"));
    check('row frame: each expanded kind is full strength and mounts its editor', true);
    const numeric = '[data-param-key="9.denoise"]';
    for (const [selector, value] of [[`${numeric} .vz-range-field:first-child input`, '0.7'], [`${numeric} .vz-row-inc-input`, '0.1']]) {
      await cdp.clickAt(selector);
      await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
      await cdp.send('Input.insertText', { text: value });
      await cdp.keyTrusted('Tab', { vk: 9 });
      await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`);
    }
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
    assert.deepEqual(await cdp.evaluate("[...document.querySelectorAll('.vz-image-tile')].map(el=>el.dataset.imageName)"), ['canny.png','row-retained.png']);
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
