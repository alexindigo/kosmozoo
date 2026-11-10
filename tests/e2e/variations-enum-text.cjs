// Task 4: real catalogue -> retained editor -> native layout/typing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, check, ENGINE, FAKE, KZ }) => {
  const source = 'enum-text-editors', filename = 'enum-text-editors.png';
  const small = ['euler', 'euler_a', 'heun', 'dpm_2', 'ddim', 'uni_pc'];
  const large = Array.from({ length: 30 }, (_, i) => `model_${String(i).padStart(2, '0')}.safetensors`);
  const current = large[17];
  const objectInfo = {
    EditorParameters: { display_name: 'Editor parameters', input: { required: {
      sampler: [small], model: [large], text: ['STRING', { multiline: true }],
    } } },
    SaveImage: { output_node: true, input: { required: { filename_prefix: ['STRING'] } } },
  };
  const graph = {
    '81': { class_type: 'EditorParameters', inputs: { sampler: 'ddim', model: current, text: 'One line.' } },
    '94': { class_type: 'SaveImage', inputs: { images: ['81', 0], filename_prefix: 'editors' } },
  };
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `${url}: ${response.status}`);
  };
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const shortRow = '[data-enum-id="81.sampler"]', longRow = '[data-enum-id="81.model"]';
  const textRow = '[data-text-id="81.text"]', textarea = textRow + ' .vz-text-values';
  const type = async (selector, text) => {
    await cdp.clickAt(selector);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
    await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  };
  const geometry = () => cdp.evaluate(`(()=>{
    const input=document.querySelector('${textarea}'),s=getComputedStyle(input);
    return {height:input.getBoundingClientRect().height,client:input.clientHeight,scroll:input.scrollHeight,
      line:parseFloat(s.lineHeight),chrome:parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.borderTopWidth)+parseFloat(s.borderBottomWidth),
      resize:s.resize,font:s.fontFamily,sharedFont:getComputedStyle(document.querySelector('.vz-field-filter input')).fontFamily,x:input.getBoundingClientRect().x,name:document.querySelector('${textRow} .vz-parameter-name').getBoundingClientRect().x};
  })()`);
  await post(FAKE + '/__test/activity', { objectInfoByHost: { '127.0.0.2': objectInfo },
    publish: [{ name: filename, fixture: 'flux-lora.png', graph, mtime: 2100000200 }] });
  await post(ENGINE + '/api/collections', { name: source, address: `127.0.0.2:${new URL(FAKE).port}` });
  try {
    await cdp.poll(`(async()=>!!${KZ}.state.hosts['${source}'])()`);
    await cdp.evaluate(`fetch('/api/collections/${source}/entries/${filename}/bytes').then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer()}).then(()=>true)`);
    await invoke('variations.open', { id: `${source}:${filename}` });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const id of ['81.sampler','81.model','81.text']) await addParameter(cdp,id);
    await cdp.poll(`document.querySelectorAll('${shortRow} .vz-enum-opt').length===6`);
    await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const grid = await cdp.evaluate(`(()=>{
      const row=document.querySelector('${shortRow}');return [...row.querySelectorAll('.vz-enum-opt')].map(el=>({
        text:el.textContent,y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width,
        checkbox:el.querySelector('.checkbox').getBoundingClientRect().width,
        label:el.querySelector('.vz-enum-opt-name').clientWidth,natural:el.querySelector('.vz-enum-opt-name').scrollWidth}));
    })()`);
    assert.deepEqual(grid.map(option => option.text), small);
    assert(new Set(grid.map(option => option.y)).size <= 2, JSON.stringify(grid));
    assert(Math.max(...grid.map(option => option.width)) - Math.min(...grid.map(option => option.width)) < 1);
    assert(grid.every(option => option.checkbox === 14 && option.label >= option.natural));
    check('enum/text: six short options wrap into at most two equal-width rows, longest label fits, option checkboxes are 14px', true, JSON.stringify(grid));
    assert(await cdp.evaluate(`(()=>{const r=document.querySelector('${shortRow}'),v=r.querySelector('.vz-enum-current .vz-enum-opt-name');return v.textContent==='ddim'&&getComputedStyle(v).color===getComputedStyle(r.querySelector('.vz-parameter-current')).color})()`));
    check('enum/text: chosen current option and contribution summary use foreground', true);

    const order = () => cdp.evaluate(`[...document.querySelectorAll('${longRow} .vz-enum-opt-name')].map(el=>el.textContent)`);
    const expected = [current, ...large.filter(value => value !== current)];
    assert.deepEqual(await order(), expected);
    const list = await cdp.evaluate(`(()=>{const el=document.querySelector('${longRow} .vz-enum-list'),row=el.querySelector('label');return {height:el.clientHeight,scroll:el.scrollHeight,row:row.getBoundingClientRect().height,gap:parseFloat(getComputedStyle(el).rowGap)}})()`);
    assert(list.scroll > list.height && Math.abs(list.height - (8 * list.row + 7 * list.gap)) < 1);
    await cdp.clickAt(longRow + ' .vz-enum-opt:nth-child(3) .checkbox');
    await cdp.poll(`document.querySelector('${longRow} .vz-enum-selected').textContent==='2 selected'`);
    assert.deepEqual(await order(), expected);
    check('enum/text: 30 options show current first, eight visible rows, and checking preserves catalogue order with a live selected count', true, JSON.stringify(list));
    await type(longRow + ' .vz-enum-filter', 'model_29');
    assert.deepEqual(await order(), [current, large[29]]);
    await cdp.clickAt(longRow + ' .vz-enum-opt:last-child .checkbox');
    await cdp.poll(`document.querySelector('${longRow} .vz-enum-selected').textContent==='3 selected'`);
    await type(longRow + ' .vz-enum-filter', 'no matches');
    assert.deepEqual(await order(), [current]);
    assert.equal(await cdp.evaluate(`document.querySelector('${longRow} .vz-enum-selected').textContent`), '3 selected');
    await type(longRow + ' .vz-enum-filter', '');
    assert.deepEqual(await order(), expected);
    check('enum/text: filtering keeps current visible first, preserves all selections and restores original option order', true);

    const heights = [];
    for (const lines of [1, 3, 8, 12, 1]) {
      await type(textarea, Array.from({ length: lines }, (_, i) => `Line ${i + 1}`).join('\n'));
      const g = await geometry(); heights.push({ lines, ...g });
      assert(Math.abs(g.height - (Math.min(lines, 8) * g.line + g.chrome)) <= 1, JSON.stringify(g));
      assert.equal(g.resize, 'none'); assert.equal(g.font, g.sharedFont); assert(Math.abs(g.x-g.name)<0.5);
      if (lines > 8) assert(g.scroll > g.client);
      else assert(g.scroll <= g.client + 1);
    }
    check('enum/text: textarea grows 1/3/8 lines, caps and scrolls at 12, shrinks back to one; shared TextField font/no handle/name inset', true, JSON.stringify(heights));
    await type(textarea, 'A wrapping paragraph with enough words to occupy several visual lines. '.repeat(5));
    const wide = await geometry(); assert(wide.height > wide.line + wide.chrome);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 768, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.poll(`document.querySelector('${textarea}').getBoundingClientRect().height>${wide.height}`);
    for (const width of [768, 500]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      assert(await cdp.evaluate(`document.querySelector('.vz-sliders').scrollWidth<=document.querySelector('.vz-sliders').clientWidth+1`));
    }
    check('enum/text: wrapping reacts to viewport width; both enum layouts and text fit narrow lists without horizontal scrolling', true);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await type(textarea, 'First paragraph.\n\nSecond paragraph.\nAn indented line stays literal.');
    await cdp.clickAt(textRow + ' .vz-parameter-remove');
    await addParameter(cdp,'81.text');
    const restored = await geometry(); assert(Math.abs(restored.height - (4 * restored.line + restored.chrome)) <= 1);
    assert.equal(await cdp.evaluate(`document.querySelector('${textarea}').value`), 'First paragraph.\n\nSecond paragraph.\nAn indented line stays literal.');
    check('enum/text: collapse/reopen sizes the retained literal template on its new native textarea', true);
    await cdp.evaluate("document.activeElement.blur();document.querySelector('.vz-sliders').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    if (process.env.E2E_ENUM_TEXT_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_ENUM_TEXT_SHOT, Buffer.from(shot.data, 'base64'));
    }
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
    assert((await fetch(ENGINE + '/api/collections/' + source, { method: 'DELETE' })).ok);
    await post(FAKE + '/__test/activity', { objectInfoByHost: {}, remove: [filename] });
  }
};
