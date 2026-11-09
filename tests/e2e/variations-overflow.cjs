// Hostile source strings must never negotiate the Variations column widths.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const { waitForSelectedPreviews } = require('./image-picker-helpers.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

// One generator for every scalar catalogue kind. Numeric values stay numeric;
// their labels/keys and raw increment editors carry the hostile spelling too.
const hostile = (role, type = 'STRING') => type === 'INT' ? Number.MAX_SAFE_INTEGER
  : type === 'FLOAT' ? 1234567890.125 : `ark#atmo_${role}_` + 'W'.repeat(200);
function hostileCatalogue() {
  const filename = hostile('output') + '.png', inputName = hostile('input') + '.png';
  const template = hostile('template');
  const fields = ['INT', 'FLOAT', 'ENUM', 'STRING'].map(type => ({
    type, key: hostile(type + '_key'), value: hostile(type + '_value', type),
  }));
  const objectInfo = {
    LoadImage: { input: { required: { image: [[inputName]] } } },
    OverflowParameters: { display_name: hostile('registry_title'), input: { required: Object.fromEntries(fields.map(field =>
      [field.key, field.type === 'ENUM' ? [[field.value, ...Array.from({ length: 11 }, (_, index) => field.value + '_' + index)]] : [field.type, {}]])) } },
    SaveImage: { output_node: true, input: { required: { filename_prefix: ['STRING'] } } },
  };
  const graph = {
    '76': { class_type: 'LoadImage', inputs: { image: inputName }, _meta: { title: hostile('image_title') } },
    '81': { class_type: 'OverflowParameters', inputs: Object.fromEntries(fields.map(field =>
      [field.key, field.type === 'STRING' ? field.value + `{{${template}}}` : field.value])), _meta: { title: hostile('parameter_title') } },
    '94': { class_type: 'SaveImage', inputs: { images: ['76', 0], filename_prefix: hostile('output_prefix') } },
  };
  return { filename, inputName, fields, objectInfo, graph };
}

module.exports = async ({ cdp, ENGINE, FAKE, KZ, check }) => {
  const { filename, inputName, fields, objectInfo, graph } = hostileCatalogue();
  const source = 'overflow-geometry';
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, `${url}: ${response.status}`); return response.json();
  };
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const type = async (selector, value) => {
    await cdp.clickAt(selector);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text: value });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`);
  };
  const capture = async width => {
    if (!process.env.OVF_ARTIFACTS) return;
    fs.mkdirSync(process.env.OVF_ARTIFACTS, { recursive: true });
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(process.env.OVF_ARTIFACTS, `variations-${width}.png`), Buffer.from(image.data, 'base64'));
  };
  // A distinct address has its own production catalogue cache; no test-only
  // cache invalidation or fake response intercepts in the browser are needed.
  const image = fs.readFileSync(workPath('tests/fixtures/flux-lora.png'));
  const form = new FormData(); form.append('image', new Blob([image]), inputName);
  assert((await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form })).ok);
  await post(FAKE + '/__test/activity', { objectInfoByHost: { localhost: objectInfo },
    publish: [{ name: filename, fixture: 'flux-lora.png', graph, mtime: 2100000100 }] });
  await post(ENGINE + '/api/collections', { name: source, address: `localhost:${new URL(FAKE).port}` });
  const failures = [];
  try {
    await cdp.poll(`(async()=>!!${KZ}.state.hosts[${JSON.stringify(source)}])()`);
    await cdp.evaluate(`fetch('/api/collections/${source}/entries/' + encodeURIComponent(${JSON.stringify(filename)}) + '/bytes').then(r=>{if(!r.ok)throw Error(r.status);return r.arrayBuffer()}).then(()=>true)`);
    const catalogue = await cdp.evaluate(`fetch('/api/features/variations/probe/'+encodeURIComponent(${JSON.stringify(`${source}:${filename}`)})).then(r=>r.json())`);
    assert.equal(catalogue.params.length, 2);
    assert.deepEqual(catalogue.params.map(field => field.integer).sort(), [false, true]);
    for (const channel of ['stringParams', 'enumParams', 'textParams']) assert.equal(catalogue[channel].length, 1, channel);
    check('hostile generator covers integer, float, image, enum and text catalogue fields', true);
    await invoke('variations.open', { id: `${source}:${filename}` });
    await addParameter(cdp,'76.image');
    await require('./image-picker-helpers.cjs').openImageAdd(cdp);
    await cdp.clickAt('.vz-input-trigger');
    await cdp.poll("document.querySelectorAll('.vz-input-option').length>0");
    await type('.vz-input-search', inputName);
    await cdp.poll("document.querySelectorAll('.vz-input-option').length===1");
    assert.equal(await cdp.evaluate("document.querySelector('.vz-input-option').title"), inputName);
    await cdp.clickAt('.vz-input-option');
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1");
    await cdp.keyTrusted('Escape', { vk: 27 });
    await addParameter(cdp,'81.'+encodeURIComponent(fields.find(field=>field.type==='ENUM').key));
    await cdp.poll("document.querySelectorAll('.vz-enum-opt').length===12");
    await type('.vz-enum-filter', fields.find(field => field.type === 'ENUM').value);
    await cdp.poll("document.querySelectorAll('.vz-enum-opt').length===12");
    await addParameter(cdp,'81.'+encodeURIComponent(fields.find(field=>field.type==='STRING').key));
    await cdp.poll("!!document.querySelector('.vz-tpl-input')");
    await type('.vz-tpl-input', hostile('substitution'));
    for (const field of fields.filter(field => ['INT', 'FLOAT'].includes(field.type))) {
      const row = `[data-param-key=${JSON.stringify('81.' + encodeURIComponent(field.key))}]`;
      await addParameter(cdp,'81.'+encodeURIComponent(field.key));
      await type(row + ' .vz-row-inc-input', hostile(field.type + '_increment'));
    }
    await require('./image-picker-helpers.cjs').openImageFolder(cdp);
    await type('.vz-folder-path', '/engine/' + hostile('folder') + '/' + hostile('subfolder'));
    await type('.vz-prefix', hostile('prefix'));
    await type('.vz-suffix', hostile('suffix'));
    await cdp.evaluate('document.activeElement.blur()');
    await waitForSelectedPreviews(cdp);

    for (const width of [1280, 768, 500]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      const measure = async state => {
        const geometry = await cdp.evaluate(`(()=>{
          const root=document.querySelector('.vz-root');
          const elements=[root,...root.querySelectorAll('*')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0);
          const scrolls=elements.filter(e=>{const s=getComputedStyle(e);return /(auto|scroll)/.test(s.overflowX+' '+s.overflowY)});
          const name=e=>e.className?.baseVal??e.className;
          const describe=e=>({name:name(e),width:e.clientWidth,scroll:e.scrollWidth,min:getComputedStyle(e).minWidth,tracks:getComputedStyle(e).gridTemplateColumns});
          const escaped=elements.flatMap(e=>{
            // Top-layer/fixed boxes have the viewport as their CSS parent;
            // normal boxes use the nearest box-generating DOM parent.
            let parent=e.parentElement;
            while(parent&&getComputedStyle(parent).display==='contents')parent=parent.parentElement;
            const style=parent&&getComputedStyle(parent);
            const viewport=getComputedStyle(e).position==='fixed';
            const inner=parent instanceof HTMLElement?parent.clientWidth:parent?.getBoundingClientRect().width
              -parseFloat(style.borderLeftWidth||0)-parseFloat(style.borderRightWidth||0);
            const available=viewport?innerWidth:inner-parseFloat(style.paddingLeft||0)-parseFloat(style.paddingRight||0);
            const width=e.getBoundingClientRect().width;
            return width>available+1&&!e.matches('.vz-body')?[{...describe(e),width,available,parent:viewport?'viewport':name(parent)}]:[];
          });
          return {scrolls:scrolls.map(describe),offenders:scrolls.filter(e=>e.scrollWidth>e.clientWidth+1&&!(innerWidth<1024&&e.matches('.vz-body-scroll'))).map(describe),
            escaped,unshrinkable:elements.filter(e=>e!==root&&!e.matches('.vz-body')&&getComputedStyle(e).minWidth!=='0px').map(describe),measured:elements.length};
        })()`);
        console.log(`overflow geometry ${width} ${state}: ${JSON.stringify(geometry)}`);
        assert(geometry.scrolls.length>0, 'must exercise actual scroll containers');
        if (geometry.offenders.length || geometry.escaped.length || geometry.unshrinkable.length) failures.push({ width, state, ...geometry });
        check(`hostile names: every element shrinks/fits its parent content box and every scroller fits at ${width}px (${state})`, !geometry.offenders.length && !geometry.escaped.length && !geometry.unshrinkable.length);
      };
      await measure('editors');
      await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0;document.querySelector('.vz-body').scrollTop=0");
      await capture(width);
      await require('./image-picker-helpers.cjs').openImageAdd(cdp);
      await cdp.clickAt('.vz-input-trigger');
      await cdp.poll("!!document.querySelector('.vz-input-popover:popover-open')");
      await measure('input picker');
      await cdp.keyTrusted('Escape', { vk: 27 });
    }
    // A full narrow composition includes the below-fold text and naming pane;
    // the scrolling contract above is still measured at the fixed 900px height.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 500, height: 1700, deviceScaleFactor: 1, mobile: false });
    await cdp.evaluate("document.querySelector('.vz-body').scrollTop=0;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await capture('500-full');
    // The complete values remain in tooltips, never shortened in the model.
    const titles = await cdp.evaluate(`(()=>{
      return [...document.querySelectorAll('.vz-panel *')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).textOverflow==='ellipsis').map(e=>({text:e.textContent,title:e.title,primitive:e.classList.contains('single-line-text')}));
    })()`);
    assert(titles.length>0, 'hostile labels must exercise truncation');
    check('every truncated display string uses the shared full-tooltip text primitive', titles.every(e=>e.primitive&&e.title.includes(e.text)), JSON.stringify(titles));
    assert.equal(failures.length, 0, JSON.stringify(failures));
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

if (require.main === module) (async () => {
  const cdp = await CDP.launch(9347, { windowSize: '1400,1000' });
  const errors = await collectPageErrors(cdp);
  let failed = 0;
  try {
    const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE;
    const KZ = '(await import("/store/instance.js")).appStore';
    await cdp.goto(ENGINE);
    await cdp.poll(`(async()=>${KZ}.state.images.length>0)()`);
    await module.exports({ cdp, ENGINE, FAKE, KZ, check: (name, ok, detail) => {
      console.log(`[${ok ? ' ok ' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failed++;
    } });
    assert.deepEqual(errors, []);
    assert.equal(failed, 0);
  } finally { await cdp.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
