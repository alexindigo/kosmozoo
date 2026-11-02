// Every rendered text editor shares appearance; native focus and feedback tones
// are checked at the consumer, including containment after revealing each field.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { openImageFolder, openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const KZ = '(await import("/store/instance.js")).appStore';

async function textFields({ page, check = (name, ok, detail) => { assert(ok, detail); console.log('ok ' + name); } }) {
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const frame = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const records = [];
  const capture = async (name, selector) => {
    if (!process.env.TF_CAPTURE) return;
    await page.evaluate(`{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});el.focus()}`);
    await frame();
    assert(await page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();return document.activeElement===el&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el})()`), `${name}: focused field is covered`);
    const clip = await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.max(0,r.x-8),y:Math.max(0,r.y-8),width:r.width+16,height:r.height+16,scale:2}})()`);
    for (const [suffix, extra] of [['', {}], ['-focus', { clip }]]) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png', ...extra });
      fs.writeFileSync(`${process.env.TF_CAPTURE}/${name}${suffix}.png`, Buffer.from(shot.data, 'base64'));
    }
  };
  const inspect = async (surface, minimum = 1, scope = null) => {
    // Reveal the surface's editors first; feed overscan rows outside the
    // viewport aren't visible and can be retired by the virtualizer on scroll.
    const count = await page.evaluate(`(()=>{const root=${scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document'};const fields=[...root.querySelectorAll('input:not([type]),input[type="text"],input[type="search"],input[type="number"],textarea')];if(fields.some(el=>!el.classList.contains('text-field')))throw Error('unshared native text field in '+${JSON.stringify(surface)});window.__textFields=fields.filter(el=>{const b=el.getBoundingClientRect();if(!b.width||(!${!!scope}&&(b.bottom<=0||b.top>=innerHeight)))return false;for(let p=el;p;p=p.parentElement){const s=getComputedStyle(p);if(p.hidden||s.display==='none'||s.visibility==='hidden'||+s.opacity===0||p.inert||p.getAttribute('aria-hidden')==='true')return false;if(!${!!scope}&&/(auto|scroll|hidden|clip)/.test(s.overflowX+' '+s.overflowY)){const r=p.getBoundingClientRect();if(b.bottom<=r.top||b.top>=r.bottom||b.right<=r.left||b.left>=r.right)return false}}return true});return __textFields.length})()`);
    assert(count >= minimum, `${surface}: only ${count} fields`);
    for (let i = 0; i < count; i++) {
      const row = await page.evaluate(`(async()=>{
        const el=__textFields[${i}];el.blur();
        const color=token=>{const p=document.createElement('span');p.style.color=getComputedStyle(el).getPropertyValue(token);document.body.append(p);const c=getComputedStyle(p).color;p.remove();return c};
        const normal=getComputedStyle(el).borderColor;
        el.scrollIntoView({block:${scope ? "'center'" : "'nearest'"},inline:'nearest'});el.focus();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
        const s=getComputedStyle(el),b=el.getBoundingClientRect();const containers=[];
        for(let p=el.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);if(!/(auto|scroll|hidden|clip)/.test(s.overflowX+' '+s.overflowY))continue;const r=p.getBoundingClientRect(),left=r.left+p.clientLeft,top=r.top+p.clientTop;containers.push({name:p.id||p.className,left,top,right:left+p.clientWidth,bottom:top+p.clientHeight})}
        return {surface:${JSON.stringify(surface)},label:el.getAttribute('aria-label')||el.id||el.className,shared:el.classList.contains('text-field'),tone:el.classList.contains('neg')?'negative':el.classList.contains('pos')?'positive':null,normal,focused:document.activeElement===el,outline:s.outlineStyle,border:s.borderColor,secondary:color('--secondary'),negative:color('--negative'),positive:color('--positive'),box:b.toJSON(),containers,contained:containers.every(r=>b.left>=r.left-1&&b.right<=r.right+1&&b.top>=r.top-1&&b.bottom<=r.bottom+1)};
      })()`);
      records.push(row);
      assert(row.shared, `${surface}: missing shared TextField: ${row.label}`);
      assert(row.focused && row.outline === 'none', JSON.stringify(row));
      assert.equal(row.border, row.tone === 'negative' ? row.negative : row.secondary, JSON.stringify(row));
      if (row.tone) assert.equal(row.normal, row[row.tone], JSON.stringify(row));
      assert(row.contained, JSON.stringify(row));
    }
    check(`${surface}: ${count} shared fields, focus colours and unclipped border boxes`, true);
  };
  await page.goto((process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260') + '/#fake#flux-controlnet.png');
  await page.poll(`(async()=>!${KZ}.state.inventory.loading&&!!document.querySelector('.card textarea'))()`);
  await invoke('feed.filter.toggle');
  await page.clickAt('#filter');
  await inspect('header and feed', 3);
  await page.evaluate("document.querySelector('#filter').focus()");
  await capture('header', '#filter');
  for (const tone of ['neg', 'pos']) {
    await page.evaluate(`document.querySelector('.card textarea.${tone}').focus()`);
    await capture('feedback-' + tone, '.card textarea.' + tone);
  }
  // The stable probe is the same native component, with exactly the same box.
  const geometry = await page.evaluate(`['neg','pos'].map(t=>{const real=document.querySelector('.card textarea.'+t),probe=document.querySelector('.card--probe textarea.'+t);return {tone:t,shared:probe.classList.contains('text-field'),real:real.getBoundingClientRect().height,probe:probe.getBoundingClientRect().height}})`);
  assert(geometry.every(r => r.shared && r.real === r.probe), JSON.stringify(geometry));
  await invoke('source.menu.open'); await inspect('source form', 2, '#hostDrop');
  await capture('source-name', '#hostName');
  await page.evaluate("document.querySelector('#hostAddr').focus()"); await capture('source', '#hostAddr');
  await invoke('source.menu.close');
  await invoke('menu.toggle'); await inspect('settings', 1, '#menu'); await capture('settings', '#menuSearch'); await invoke('menu.close');
  await invoke('keys.panel.toggle'); await inspect('keys', 1, '#keysPanel');
  await page.evaluate("document.querySelector('#keysSearch').focus()"); await capture('keys', '#keysSearch');
  await invoke('keys.panel.close');
  await page.evaluate(`(async()=>{const s=${KZ},blob=await(await fetch('/api/collections/fake/entries/flux-basic.png/bytes')).blob();await s.actions.anchors.addFiles([new File([blob],'text-fields-anchor.png',{type:'image/png'})]);s.actions.ui.setWorkspace('anchors')})()`);
  await page.poll("!!document.querySelector('.anchor')"); await inspect('anchors and feed', 3);
  await invoke('anchor.remove', { name: 'text-fields-anchor.png' });
  await page.evaluate(`(async()=>${KZ}.actions.ui.setWorkspace('details'))()`);
  await page.evaluate("fetch('/api/collections/fake/entries/flux-controlnet.png/bytes').then(r=>r.arrayBuffer()).then(()=>true)");
  await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
  await page.poll("document.querySelectorAll('.vz-parameter').length>8");
  await page.evaluate("[...document.querySelectorAll('.vz-parameter:not(.on) > .vz-parameter-heading .checkbox')].forEach(el=>el.click())");
  await page.poll("!!document.querySelector('.vz-text-values')&&!!document.querySelector('.vz-row-inc-input')");
  await page.evaluate("document.querySelector('.vz-text-values').focus();document.querySelector('.vz-text-values').select()");
  await page.send('Input.insertText', { text: 'A {{subject}}' });
  await page.poll("!!document.querySelector('.vz-tpl-input')");
  assert.equal(await page.evaluate("getComputedStyle(document.querySelector('.vz-text-values')).resize"), 'none');
  await inspect('variations', 10, '.vz-panel');
  for (const [name, selector] of [['prefix','.vz-prefix'],['suffix','.vz-suffix'],['from','.vz-range-field > input[aria-label$=" From"]'],['to','.vz-range-field > input[aria-label$=" To"]'],['increment','.vz-row-inc-input'],['template','.vz-text-values'],['alternatives','.vz-tpl-input']]) await capture(name, selector);
  await page.clickAt('.vz-slider-row .mode-label:last-child');
  await page.poll("!!document.querySelector('.vz-value-field input')");
  await inspect('fixed numeric value', 5, '.vz-panel');
  await capture('value', '.vz-value-field input');
  await page.evaluate("document.querySelector('.vz-sliders').scrollTop=0;document.querySelector('.vz-field-filter input').focus()");
  await page.send('Input.insertText', { text: 's' });
  const filterGaps = await page.evaluate(`(()=>{const f=document.querySelector('.vz-field-filter').getBoundingClientRect(),i=document.querySelector('.vz-filter-clear svg').getBoundingClientRect();return [i.top-f.top,f.bottom-i.bottom,f.right-i.right]})()`);
  assert(Math.max(...filterGaps) - Math.min(...filterGaps) <= 1, JSON.stringify(filterGaps));
  await capture('variations', '.vz-field-filter input');
  await page.clickAt('.vz-filter-clear');
  await openImageFolder(page); await inspect('folder acquisition', 11);
  await page.evaluate("document.querySelector('.vz-folder-path').focus()"); await capture('folder', '.vz-folder-path');
  await openImageAdd(page); await page.clickAt('.vz-input-trigger'); await waitForInputPicker(page);
  await page.clickAt('.vz-input-search'); await page.send('Input.insertText', { text: 'canny' });
  await inspect('input picker', 12);
  await page.evaluate("document.querySelector('.vz-input-search').focus()"); await capture('input-picker', '.vz-input-search');
  await page.keyTrusted('Escape', { vk: 27 });
  await page.clickAt('.vz-close');
  if (await page.evaluate("!!document.querySelector('.vz-discard-confirm')")) await page.clickAt('.vz-discard-confirm');
  await page.poll("!document.querySelector('.vz-panel')");
  // Reach the catalogue-filter branch with the existing fake's public fixture
  // control, using a fresh host identity so no cached catalogue can hide it.
  const FAKE = process.env.E2E_FAKE ?? 'http://127.0.0.1:18261', ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
  const post = async (url, body) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok, `${url}: ${r.status}`); };
  const source = 'text-field-enum', filename = 'text-field-enum.png';
  await post(FAKE + '/__test/activity', { objectInfoByHost: { '127.0.0.3': {
    TextFieldEnum: { input: { required: { model: [Array.from({ length: 30 }, (_, i) => `model_${i}`)] } } },
    SaveImage: { output_node: true, input: { required: { filename_prefix: ['STRING'] } } },
  } }, publish: [{ name: filename, fixture: 'flux-basic.png', mtime: 2100000200, graph: {
    '81': { class_type: 'TextFieldEnum', inputs: { model: 'model_0' } },
    '94': { class_type: 'SaveImage', inputs: { images: ['81', 0], filename_prefix: 'text-fields' } },
  } }] });
  await post(ENGINE + '/api/collections', { name: source, address: `127.0.0.3:${new URL(FAKE).port}` });
  try {
    await page.poll(`(async()=>!!${KZ}.state.hosts['${source}'])()`);
    await page.evaluate(`fetch('/api/collections/${source}/entries/${filename}/bytes').then(r=>r.arrayBuffer()).then(()=>true)`);
    await invoke('variations.open', { id: `${source}:${filename}` });
    await page.poll("!!document.querySelector('.vz-enumrow')"); await page.clickAt('.vz-enumrow .checkbox');
    await page.poll("!!document.querySelector('.vz-enum-filter')");
    await inspect('enum catalogue filter', 4, '.vz-panel'); await capture('enum-filter', '.vz-enum-filter');
    await page.clickAt('.vz-close');
    if (await page.evaluate("!!document.querySelector('.vz-discard-confirm')")) await page.clickAt('.vz-discard-confirm');
    await page.poll("!document.querySelector('.vz-panel')");
  } finally {
    const r = await fetch(ENGINE + '/api/collections/' + source, { method: 'DELETE' }); assert(r.ok);
    await post(FAKE + '/__test/activity', { remove: [filename] });
  }
  await invoke('feed.filter.close');
  if (process.env.TF_CAPTURE) fs.writeFileSync(process.env.TF_CAPTURE + '/text-fields.json', JSON.stringify({ records, geometry }, null, 2));
  console.log(`text-fields: ${records.length} field/state checks across 10 surfaces; feedback geometry matches probe; trailing icon gaps ${filterGaps}`);
}

module.exports = textFields;
if (require.main === module) (async () => {
  const page = await CDP.launch(9365, { windowSize: '1600,1100' });
  const errors = await collectPageErrors(page);
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await textFields({ page });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
