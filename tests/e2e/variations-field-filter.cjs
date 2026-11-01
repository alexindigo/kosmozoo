const assert = require('node:assert/strict');
const fs = require('node:fs');

module.exports = async ({ cdp, check, KZ }) => {
  const invoke = (command, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(command)},${JSON.stringify(args)}))()`);
  const input = '.vz-field-filter input';
  const type = async text => {
    await cdp.clickAt(input);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(input)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(input)}).value === ${JSON.stringify(text)}`);
  };
  await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
  await cdp.poll("document.querySelectorAll('.vz-parameter').length > 8");
  try {
    assert(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(input)})`), 'Filter fields input replaces the workspace label');
    check('field filter exists; single-recipe switcher is absent', await cdp.evaluate("!document.querySelector('.vz-workspace') && !document.querySelector('.vz-workspace-label')"));
    await cdp.clickAt(input);
    const focus = await cdp.evaluate(`(()=>{
      const input=document.querySelector('.vz-field-filter input'),style=getComputedStyle(input);
      const probe=document.createElement('span');probe.style.color=style.getPropertyValue('--secondary');
      document.body.append(probe);const secondary=getComputedStyle(probe).color;probe.remove();
      const box=input.getBoundingClientRect(),scroller=document.querySelector('.vz-sliders'),outer=scroller.getBoundingClientRect();
      const client={left:outer.left+scroller.clientLeft,top:outer.top+scroller.clientTop};
      client.right=client.left+scroller.clientWidth;client.bottom=client.top+scroller.clientHeight;
      return {focused:document.activeElement===input,outline:style.outlineStyle,border:style.borderColor,secondary,
        box:box.toJSON(),client,contained:box.left>=client.left&&box.top>=client.top&&box.right<=client.right&&box.bottom<=client.bottom};
    })()`);
    assert(focus.focused && focus.outline === 'none' && focus.border === focus.secondary && focus.contained, JSON.stringify(focus));
    check('focused filter uses its complete in-scroller secondary border without an outside outline', true, JSON.stringify(focus));
    const total = await cdp.evaluate("document.querySelectorAll('.vz-parameter').length");
    const snapshot = () => cdp.evaluate("JSON.stringify({count:document.querySelector('.vz-count').textContent,sidebar:document.querySelector('.vz-right').textContent,prefix:document.querySelector('.vz-prefix').value,suffix:document.querySelector('.vz-suffix').value})");
    const row = '.vz-slider-row[data-param-key$="denoise"]';
    if (await cdp.evaluate(`document.querySelector('${row}').classList.contains('vz-off')`)) await cdp.clickAt(row + ' .checkbox');
    await cdp.evaluate(`document.querySelector('${row} .vz-row-inc-input').focus();document.querySelector('${row} .vz-row-inc-input').select()`);
    await cdp.send('Input.insertText', { text: '0.0250' });
    const before = await snapshot();
    await cdp.evaluate(`window.__filterKept = document.querySelector('${row} .vz-row-inc-input')`);
    await type('  IMAGE  ');
    const filtered = await cdp.evaluate(`(()=>{const rows=[...document.querySelectorAll('.vz-parameter')];const shown=rows.filter(r=>r.getClientRects().length);return {total:rows.length,shown:shown.length,allMatch:shown.every(r=>r.querySelector('.vz-parameter-name').textContent.toLowerCase().includes('image')),images:shown.some(r=>r.matches('.vz-image-set')),hiddenChecked:!document.querySelector('${row}').getClientRects().length}})()`);
    assert(filtered.total === total && filtered.shown > 0 && filtered.shown < total && filtered.allMatch && filtered.images && filtered.hiddenChecked, JSON.stringify(filtered));
    assert.equal(await snapshot(), before);
    check('typing filters checked and unchecked fields, including image-set rows, without changing sidebar', true, JSON.stringify(filtered));
    const gaps = await cdp.evaluate(`(()=>{const field=document.querySelector('.vz-field-filter').getBoundingClientRect(),icon=document.querySelector('.vz-field-filter button svg').getBoundingClientRect();return [icon.top-field.top,field.bottom-icon.bottom,field.right-icon.right]})()`);
    assert(Math.max(...gaps) - Math.min(...gaps) <= 1, JSON.stringify(gaps));
    check('clear icon has equal top, bottom and right gaps within 1px', true, JSON.stringify(gaps));
    await type('no-such-field-xyz');
    assert.equal(await cdp.evaluate("document.querySelector('.vz-filter-empty')?.textContent"), 'No fields match "no-such-field-xyz"');
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.vz-parameter')].filter(r=>r.getClientRects().length).length"), 0);
    check('empty result shows the query while every row stays mounted', true);
    await cdp.clickAt('.vz-field-filter button');
    assert(await cdp.evaluate(`document.activeElement === document.querySelector(${JSON.stringify(input)})`));
    assert.equal(await cdp.evaluate("[...document.querySelectorAll('.vz-parameter')].filter(r=>r.getClientRects().length).length"), total);
    assert(await cdp.evaluate(`window.__filterKept === document.querySelector('${row} .vz-row-inc-input') && window.__filterKept.value === '0.0250'`));
    assert.equal(await snapshot(), before);
    check('clear restores every field, exact checked widget/raw value and focus', true);
    for (const kind of ['.vz-enumrow', '.vz-textrow']) {
      const name = await cdp.evaluate(`document.querySelector('${kind} .vz-parameter-name').textContent`);
      await type(name.toUpperCase());
      assert(await cdp.evaluate(`document.querySelector('${kind}').getClientRects().length > 0`));
      assert.equal(await snapshot(), before);
      await cdp.clickAt('.vz-field-filter button');
    }
    check('enum and text fields match their displayed title and raw name too', true);
    const keysBefore = await cdp.evaluate(`(async()=>${KZ}.state.keysPanelOpen())()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8, text: '?' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '?', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 8 });
    await cdp.poll("document.querySelector('.vz-field-filter input')?.value === '?'");
    assert(await cdp.evaluate("!!document.querySelector('.vz-panel')"));
    assert.equal(await cdp.evaluate(`(async()=>${KZ}.state.keysPanelOpen())()`), keysBefore);
    check('typing shortcut keys stays in the filter through the existing input policy', true);
    await cdp.clickAt('.vz-field-filter button');
    const sticky = await cdp.evaluate(`(async()=>{const scroller=document.querySelector('.vz-sliders'),tools=document.querySelector('.vz-workspace-tools');const before=tools.getBoundingClientRect().top;scroller.scrollTop=scroller.scrollHeight;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {before,after:tools.getBoundingClientRect().top,scroll:scroller.scrollTop,hit:tools.contains(document.elementFromPoint(tools.getBoundingClientRect().left+10,tools.getBoundingClientRect().top+10))}})()`);
    assert(sticky.scroll > 0 && Math.abs(sticky.before - sticky.after) <= 1 && sticky.hit, JSON.stringify(sticky));
    check('filter stays visible above scrolling parameter rows', true, JSON.stringify(sticky));
    await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
    await type('s');
    if (process.env.VF_SCREENSHOT) {
      await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.VF_SCREENSHOT, Buffer.from(image.data, 'base64'));
    }
    await cdp.clickAt('.vz-field-filter button');
    // Remove only the explicit value edit, then prove filtering itself leaves no work.
    await cdp.clickAt('.vz-workspace-discard');
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll(`!!document.querySelector(${JSON.stringify(input)}) && document.querySelector(${JSON.stringify(input)}).value === ''`);
    await type('prompt');
    await invoke('variations.close');
    assert(await cdp.evaluate("!document.querySelector('.vz-panel') && !document.querySelector('.vz-discard')"));
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    await cdp.poll(`!!document.querySelector(${JSON.stringify(input)})`);
    assert.equal(await cdp.evaluate(`document.querySelector(${JSON.stringify(input)}).value`), '');
    check('filter creates no dirty work or close guard and resets on reopen', true);
    await invoke('variations.close');
  } finally {
    await cdp.evaluate('delete window.__filterKept');
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.clickAt('.vz-close');
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    }
  }
};
