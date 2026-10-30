// Item 3: real rendered controls, exact fake-queue outcome and fixed-sidebar geometry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { pickInput } = require('./image-picker-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE || 'http://127.0.0.1:18460';
const FAKE = process.env.E2E_FAKE || 'http://127.0.0.1:18461';
const KZ = `(await import('/store/instance.js')).appStore`;

async function main() {
  const cdp = await CDP.launch(9353, { windowSize: '1440,1000' });
  const errors = await collectPageErrors(cdp);
  const shot = async state => {
    if (!process.env.E2E_SHOTS) return;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`${process.env.E2E_SHOTS}-${state}.png`, Buffer.from(data, 'base64'));
  };
  const type = async (selector, text) => {
    await cdp.clickAt(selector); await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const denoise = '[data-param-key="9.denoise"]';
  try {
    const bytes = fs.readFileSync('/work/tests/fixtures/flux-lora.png');
    const upload = new FormData(); upload.append('image', new Blob([bytes]), 'third.png');
    assert((await fetch(FAKE + '/api/upload/image', { method: 'POST', body: upload })).ok);
    await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
    await cdp.poll("!!document.querySelector('.card')", 20000);
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-controlnet.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
    await cdp.poll(`!!document.querySelector('${denoise} .noUi-handle')&&!!document.querySelector('.vz-input-trigger')`);
    await shot('default');
    const compact = await cdp.evaluate("[...document.querySelectorAll('.vz-slider-row.vz-off')].map(row=>({id:row.dataset.paramKey,height:row.getBoundingClientRect().height,editorVisible:!!row.querySelector('.vz-numeric-editor')?.getClientRects().length}))");
    assert(compact.length > 2); assert(compact.every(row => row.height <= 44 && !row.editorVisible), JSON.stringify(compact));
    console.log('PASS compact inactive numeric rows ' + JSON.stringify(compact));
    assert.equal(await cdp.evaluate(`document.querySelector('${denoise} .vz-parameter-name').textContent`), 'Denoise');
    assert(await cdp.evaluate(`document.querySelector('${denoise} .vz-label').title.includes('#9')`));
    const identity = await cdp.evaluate(`(()=>{window.__uiWidget=document.querySelector('${denoise} .vz-slider');const cb=document.querySelector('${denoise} .vz-cb');return {name:cb.labels[0].textContent,description:document.getElementById(cb.getAttribute('aria-describedby')).textContent,thumbs:[...document.querySelectorAll('${denoise} [role="slider"]')].map(e=>e.getAttribute('aria-label'))}})()`);
    assert.equal(identity.name, 'Denoise'); assert.equal(identity.description, 'BasicScheduler #9 · denoise'); assert(identity.thumbs[0].includes('lower')); assert(identity.thumbs[1].includes('upper'));
    await cdp.clickAt(`${denoise} .vz-cb`); await cdp.clickAt(`${denoise} .vz-cb`);
    assert(await cdp.evaluate(`window.__uiWidget===document.querySelector('${denoise} .vz-slider')`));
    const suffixBeforeLabel = await cdp.evaluate("document.querySelector('.vz-suffix').value");
    await cdp.clickAt('[data-param-key="9.steps"] .vz-parameter-name');
    await cdp.poll("document.querySelector('[data-param-key=\"9.steps\"] .vz-cb').checked");
    assert.equal(await cdp.evaluate("document.querySelector('.vz-suffix').value"), suffixBeforeLabel+'_{9.steps}', 'associated name toggles once without also inserting a second naming token');
    await cdp.clickAt('[data-param-key="9.steps"] .vz-parameter-name');
    await cdp.poll("!document.querySelector('[data-param-key=\"9.steps\"] .vz-cb').checked");
    assert.equal(await cdp.evaluate("document.querySelector('.vz-suffix').value"), suffixBeforeLabel);
    await cdp.clickAt(`${denoise} .vz-range-field:first-child input`);
    await type(`${denoise} .vz-range-field:first-child input`, '.85');
    await cdp.keyTrusted('Tab', { vk: 9 });
    assert.equal(await cdp.evaluate(`Number(document.querySelector('${denoise} .vz-range-field:first-child input').value)`), .85);
    await type(`${denoise} .vz-row-inc-input`, '1e');
    await cdp.poll("document.querySelector('.vz-count').textContent==='—'");
    assert(await cdp.evaluate(`document.querySelector('${denoise} .vz-row-inc-input').getAttribute('aria-invalid')==='true'`));
    assert(await cdp.evaluate("document.querySelector('.vz-messages').textContent.includes('Step')"));
    await shot('invalid-step'); await type(`${denoise} .vz-row-inc-input`, '.05');
    await cdp.clickAt(`${denoise} .vz-step-btn:first-child`);
    await cdp.poll(`document.querySelector('${denoise} .vz-row-inc-input').value==='0.025'`);
    await cdp.clickAt(`${denoise} .vz-step-btn:last-child`);
    await cdp.poll(`document.querySelector('${denoise} .vz-row-inc-input').value==='0.05'`);
    console.log('PASS named range fields, raw validation, halve/double and native widget lifetime');

    const upper = `${denoise} .vz-range-field:nth-child(2) input`;
    await type(upper, '.95'); await cdp.keyTrusted('Tab', { vk: 9 });
    assert(await cdp.evaluate(`!document.querySelector('${denoise} .vz-slider').classList.contains('noUi-state-tap')`));
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    const point = await cdp.evaluate(`(()=>{const r=document.querySelector('${denoise} [data-handle="1"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{...point,id:12}] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x:point.x-50,y:point.y,id:12}] });
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    await cdp.poll(`Number(document.querySelector('${upper}').value)<.95`);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled:false });
    await type(upper, '1'); await cdp.keyTrusted('Tab', { vk:9 });
    console.log('PASS numeric writes admit the next real touch immediately, without a tap-transition gate');

    await cdp.clickAt('.vz-image-set .vz-cb');
    for (const name of ['canny.png', 'ref.png', 'third.png']) await pickInput(cdp, name);
    await cdp.poll("document.querySelector('.vz-count').textContent==='11'");
    assert(await cdp.evaluate("document.querySelector('.vz-count-sub').textContent.includes('3 input images × 4 denoise values · 1 unchanged combination excluded')"));
    assert(await cdp.evaluate("document.querySelector('.vz-folder-path').labels[0].textContent==='Folder on the engine computer'"));
    assert(await cdp.evaluate("document.querySelector('.vz-folder-help').textContent.includes('per folder import')"));
    await type('.vz-prefix', 'study_'); await type('.vz-suffix', '_{9.denoise}');
    await cdp.poll("document.querySelector('.vz-name-example').textContent.includes('study_flux-controlnet_0.85')");
    await cdp.evaluate("document.querySelector('.vz-prefix').setSelectionRange(0,0)");
    await cdp.evaluate("document.querySelector('.vz-insert-parameter').focus()");
    await cdp.keyTrusted('ArrowDown', { vk: 40 });
    await cdp.poll("document.querySelector('.vz-suffix').value.includes('{43.image}')");
    assert(await cdp.evaluate("document.querySelector('.vz-suffix').value.includes('{43.image}')"));
    assert(await cdp.evaluate("document.activeElement===document.querySelector('.vz-suffix')"));
    console.log('PASS exact tuple explanation, labelled acquisition, canonical naming sample and insertion');
    await shot('populated');

    await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-cb');
    assert(await cdp.evaluate("[...document.querySelectorAll('[data-enum-id=\"9.scheduler\"] .vz-enum-opt')].some(e=>e.textContent.includes('Current'))"));
    await cdp.clickAt('[data-text-id="2.text"] .vz-cb');
    await type('[data-text-id="2.text"] .vz-text-values', 'A portrait of {{subject}}.\nLine breaks stay.');
    await cdp.poll("document.querySelector('.vz-count').textContent==='—'");
    assert(await cdp.evaluate("document.querySelector('.vz-tpl-input').getAttribute('aria-invalid')==='true'"));
    await type('.vz-tpl-input', 'a person; a cat');
    await cdp.poll("document.querySelector('.vz-count').textContent==='24'");
    await shot('text-and-enum');
    await cdp.clickAt('[data-text-id="2.text"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('[data-enum-id="9.scheduler"] .vz-imgrow-head .vz-cb');
    await cdp.poll("document.querySelector('.vz-count').textContent==='11'");
    console.log('PASS current enum semantics and persistent template syntax/invalid-value associations');

    await cdp.evaluate(`(()=>{const original=window.fetch;window.__uiRelease=null;window.__uiRestore=()=>window.fetch=original;
      window.fetch=(url,options)=>{const response=original(url,options);return String(url).includes('/inspect-image/')?response.then(r=>new Promise(resolve=>window.__uiRelease=()=>resolve(r))):response}})()`);
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),input=document.querySelector('.vz-imgfilespick'),data=new DataTransfer();data.items.add(new File([bytes],'checking.png',{type:'image/png'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("typeof window.__uiRelease==='function'");
    assert(await cdp.evaluate("document.querySelector('.vz-right').textContent.includes('Checking images…')&&document.querySelector('.vz-count-group').textContent.includes('Estimated variations')"));
    await shot('checking'); await cdp.evaluate('window.__uiRelease();window.__uiRestore()');
    await cdp.poll("!document.querySelector('.vz-image-check')");
    await cdp.clickAt('[data-image-name="checking.png"] button[aria-label="Remove checking.png"]');
    await cdp.poll("document.querySelector('.vz-count').textContent==='11'");
    console.log('PASS checking evidence is visibly provisional without discarding the image set');

    for (const [width, height] of [[1280,900], [768,900], [500,900], [800,461]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      if (height === 461) {
        const suffix = await cdp.evaluate("document.querySelector('.vz-suffix').value");
        await type('.vz-suffix', suffix + '{missing}'); await cdp.clickAt('.vz-run');
        await cdp.poll("document.querySelector('.vz-error').textContent.includes('naming token')");
        await type('.vz-suffix', suffix);
        await cdp.evaluate(`(()=>{window.__sidebarFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/features/variations/run')
          ?Promise.resolve(new Response(JSON.stringify({error:'A long engine explanation. '.repeat(100)}),{status:400}))
          :window.__sidebarFetch(url,options)})()`);
        try {
          await cdp.clickAt('.vz-run');
          await cdp.poll("document.querySelector('.vz-error').textContent.length>2000");
        } finally { await cdp.evaluate('window.fetch=window.__sidebarFetch'); }
      }
      const geometry = await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const r=s=>document.querySelector(s).getBoundingClientRect(),side=r('.vz-right'),left=r('.vz-left'),run=r('.vz-run'),panel=r('.vz-panel');
        const field=document.querySelector('${denoise} .vz-range-fields'),inputs=[...field.querySelectorAll('input')].map(e=>e.getBoundingClientRect());
        const lane=r('${denoise} .vz-lane-track'),rail=r('${denoise} .vz-rail'),handles=[...document.querySelectorAll('${denoise} .noUi-handle')].map(e=>e.getBoundingClientRect());
        const body=document.querySelector('.vz-sidebar-body'),message=r('.vz-messages');
        resolve({width:${width},side:side.toJSON(),left:left.toJSON(),run:run.toJSON(),panel:panel.toJSON(),scroll:document.querySelector('.vz-sliders').scrollWidth-document.querySelector('.vz-sliders').clientWidth,
          body:body.getBoundingClientRect().toJSON(),bodyScroll:body.scrollHeight-body.clientHeight,message:message.toJSON(),
          messageScroll:document.querySelector('.vz-messages').scrollHeight-document.querySelector('.vz-messages').clientHeight,
          fields:inputs.every(a=>inputs.every(b=>a===b||a.right<=b.left+.5||b.right<=a.left+.5||a.bottom<=b.top+.5||b.bottom<=a.top+.5)),
          centers:[rail,...handles].map(r=>Math.abs((r.top+r.bottom-lane.top-lane.bottom)/2))});
      })))`);
      console.log('UI_GEOMETRY ' + JSON.stringify(geometry)); await shot(`width-${width}`);
      assert(geometry.side.left > geometry.left.right); assert(geometry.run.bottom <= geometry.panel.bottom);
      assert(Math.abs(geometry.run.bottom-geometry.side.bottom) < 1);
      assert(geometry.message.bottom <= geometry.run.top);
      assert(geometry.run.top-geometry.message.bottom <= 11, 'message is directly above Queue');
      assert(geometry.body.top >= geometry.side.top && geometry.body.bottom <= geometry.message.top);
      if(height === 461) {
        assert(geometry.bodyScroll > 0, 'short-window sidebar owns a real body scroller');
        assert(geometry.message.height > 0, 'message remains above the pinned action');
        assert(geometry.message.height <= geometry.side.height*.4+1 && geometry.messageScroll > 0, 'long result has bounded owned overflow');
        assert(await cdp.evaluate(`(()=>{const body=document.querySelector('.vz-sidebar-body');body.scrollTop=0;const a=body.getBoundingClientRect(),b=body.querySelector('.vz-count').getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()`));
        assert(await cdp.evaluate(`(()=>{const body=document.querySelector('.vz-sidebar-body');body.scrollTop=body.scrollHeight;const a=body.getBoundingClientRect(),b=body.querySelector('.vz-name-help').getBoundingClientRect();return b.top>=a.top&&b.bottom<=a.bottom})()`));
      }
      assert(geometry.fields); assert(geometry.centers.every(delta => delta < .5)); assert(geometry.scroll <= 1);
      const before = geometry.run.top;
      await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=10000");
      assert.equal(await cdp.evaluate("document.querySelector('.vz-run').getBoundingClientRect().top"), before);
      await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
      console.log('PASS sidebar, field and track geometry ' + JSON.stringify(geometry)); await shot(`width-${width}`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    const capture = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) }); assert(capture.ok);
    await cdp.clickAt('.vz-run');
    await cdp.poll("document.querySelector('.vz-queued')?.textContent==='Queued 11 of 11 jobs'", 20000);
    const jobs = await (await fetch(FAKE + '/__test/enqueues')).json();
    assert.equal(jobs.length, 11);
    const tuples = jobs.map(job => [job.prompt['43'].inputs.image, job.prompt['9'].inputs.denoise]);
    assert.equal(new Set(tuples.map(tuple => JSON.stringify(tuple))).size, 11);
    assert(tuples.every(([image, denoise]) => ['canny.png','ref.png','third.png'].includes(image)
      && [.85,.9,.95,1].includes(denoise) && !(image === 'canny.png' && denoise === 1)));
    assert(jobs.every(job => Object.values(job.prompt).some(node => node.class_type === 'SaveImage' && node.inputs.filename_prefix.startsWith('study_'))));
    console.log('QUEUED_TUPLES ' + JSON.stringify(tuples));
    await shot('queued');
    await cdp.poll("!document.querySelector('.vz-panel')", 6000);
    console.log('PASS queue result and existing clean auto-close');

    const published = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publish: [{ name: 'summary-large.png', fixture: 'flux-lora.png', mtime: 2100000200, graph: {
        '91': { class_type: 'SummaryNumbers', inputs: { a: 1e9, b: 1e9, c: 1e9 } },
        '94': { class_type: 'SaveImage', inputs: { images: ['91',0], filename_prefix: 'summary-large' } },
      } }] }) }); assert(published.ok);
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/summary-large.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:summary-large.png'})})()`);
    await cdp.poll("document.querySelectorAll('.vz-slider-row').length===3");
    for (const key of ['a','b','c']) await cdp.clickAt(`[data-param-key="91.${key}"] .vz-cb`);
    await cdp.poll("document.querySelector('.vz-count').title.includes('(estimate)')");
    assert(await cdp.evaluate("document.querySelector('.vz-count').textContent.includes('10^')&&document.querySelector('.vz-messages').textContent.includes('precision')"));
    assert.equal(await cdp.evaluate("document.querySelector('.vz-run').disabled"), false);
    await shot('large-count');
    await cdp.clickAt('.vz-close'); await cdp.poll("!!document.querySelector('.vz-discard')"); await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
    assert.equal((await (await fetch(FAKE + '/__test/enqueues')).json()).length, 11);
    console.log('PASS large count has bounded notation, full approximate value and precision explanation without a new action limit');

    await cdp.goto(ENGINE + '/#fake#flux-controlnet.png');
    await cdp.poll("!!document.querySelector('.boxcol textarea.neg')&&!!document.querySelector('.infogroup-head')", 20000);
    assert.equal(await cdp.evaluate("document.querySelector('.card .boxcol textarea.neg').getAttribute('aria-label')"), 'Negative feedback');
    assert.equal(await cdp.evaluate("document.querySelector('.card .boxcol textarea.pos').getAttribute('aria-label')"), 'Positive feedback');
    await cdp.keyTrusted('Tab', { vk: 9 });
    await cdp.evaluate("document.querySelector('.card .boxcol textarea.neg').focus()");
    assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.card .boxcol textarea.neg')).outlineWidth"), '2px');
    await shot('feedback-focus');
    assert.equal(await cdp.evaluate("document.querySelector('#hostBtn').getAttribute('aria-controls')"), 'hostDrop');
    await cdp.clickAt('#hostBtn'); await cdp.poll("document.querySelector('#hostBtn').getAttribute('aria-expanded')==='true'");
    await cdp.clickAt('#hostBtn'); await cdp.poll("document.querySelector('#hostBtn').getAttribute('aria-expanded')==='false'");
    const expanded = await cdp.evaluate("document.querySelector('.infogroup-head').getAttribute('aria-expanded')");
    await cdp.clickAt('.infogroup-head');
    assert.notEqual(await cdp.evaluate("document.querySelector('.infogroup-head').getAttribute('aria-expanded')"), expanded);
    assert(await cdp.evaluate("!!document.getElementById(document.querySelector('.infogroup-head').getAttribute('aria-controls'))"));
    console.log('PASS feedback names/focus and source/metadata disclosure semantics');

    await cdp.goto(ENGINE + '/diff#fake#flux-controlnet.png:another#flux-basic.png');
    await cdp.poll(`(async()=>${KZ}.state.diff.open&&!document.querySelector('#diff').hidden)()`, 20000);
    await cdp.poll("!!document.querySelector('#diffModes .dz-segbtn.on')", 20000);
    assert.equal(await cdp.evaluate("document.querySelector('#diffModes').getAttribute('role')"), 'group');
    await cdp.key('1');
    await cdp.poll(`(async()=>${KZ}.state.diff.mode==='two-up'&&document.querySelector('#diffModes .dz-segbtn.on').getAttribute('aria-pressed')==='true')()`);
    await cdp.poll("['.dz-a .dz-img','.dz-b .dz-img'].every(selector=>{const image=document.querySelector(selector);return image?.complete&&image.naturalWidth>0})", 20000);
    assert.equal(await cdp.evaluate("document.querySelectorAll('#diffModes [aria-pressed=\"true\"]').length"), 1);
    await shot('viewer-mode');
    console.log('PASS comparison mode group and pressed state follow the existing key dispatcher');
    assert.deepEqual(errors, []); console.log('PASS no browser page errors');
  } finally { if(errors.length) console.error('PAGE_ERRORS ' + JSON.stringify(errors)); await cdp.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
