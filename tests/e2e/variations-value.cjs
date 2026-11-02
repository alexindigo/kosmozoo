// Numeric modes, session defaults and actual submitted graph values.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshRecipe } = require('./recipe-helpers.cjs');
module.exports = async ({ cdp, check, KZ, FAKE }) => {
  const row = '[data-param-key="9.denoise"]';
  const open = async () => {
    await cdp.evaluate(`(async()=>{await ${KZ}.handles.invoke('variations.open',{id:'fake:flux-controlnet.png'})})()`);
    await cdp.poll(`!!document.querySelector('${row} .vz-numeric-editor')`);
  };
  const field = async (selector, value) => {
    await cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select()})()`);
    await cdp.send('Input.insertText', { text: value });
    await cdp.evaluate('document.activeElement.blur()');
  };
  const closeKept = async () => {
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  try {
    await open(); await freshRecipe(cdp);
    await cdp.poll(`!!document.querySelector('${row} .vz-range-fields')`);
    const layout = await cdp.evaluate(`(()=>{const r=document.querySelector('${row}'),rect=s=>r.querySelector(s).getBoundingClientRect(),cy=s=>{const x=rect(s);return x.y+x.height/2};
      const controls=r.querySelector('.vz-numeric-controls'),parts=[...controls.querySelectorAll('.mode-switch,.vz-range-field')].map(el=>el.getBoundingClientRect());
      return {center:[cy('.vz-rail'),cy('.noUi-handle'),cy('.noUi-connect'),cy('.vz-marker')],
        line:parts.map(p=>p.y+p.height/2), track:rect('.vz-rangewrap').bottom,controls:rect('.vz-numeric-controls').top,
        right:rect('.vz-range-fields').right,step:rect('.vz-range-field:last-child').right,
        labels:r.querySelectorAll('.noUi-tooltip,.vz-min-label,.vz-max-label').length,
        current:r.querySelector('.vz-editor-current').textContent,marker:rect('.vz-marker').x+1,
        currentCenter:rect('.vz-editor-current').x+rect('.vz-editor-current').width/2};})()`);
    assert(layout.center.every(value => Math.abs(value-layout.center[0]) < .5), JSON.stringify(layout));
    assert(layout.line.every(value => Math.abs(value-layout.line[0]) < .5), JSON.stringify(layout));
    assert(layout.track <= layout.controls); assert(Math.abs(layout.right-layout.step)<.5);
    assert.equal(layout.labels,0); assert.equal(layout.current,'1'); assert(Math.abs(layout.marker-layout.currentCenter)<.5);
    check('numeric modes: full-width track shares rail/band/thumb/current centerline, orange label only; one controls line and right-aligned Step', true, JSON.stringify(layout));
    await field(`${row} .vz-range-field:first-child input`, '0.7');
    await field(`${row} .vz-row-inc-input`, '0.1');
    await cdp.clickAt(`${row} .mode-switch button[title="Value"]`);
    assert.equal(await cdp.evaluate(`document.querySelectorAll('${row} [role="slider"]').length`),1);
    assert.equal(await cdp.evaluate("document.querySelector('.vz-count').textContent"),'0');
    await field(`${row} .vz-value-field input`, '0.9');
    await cdp.poll("document.querySelector('.vz-count').textContent==='1'");
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-parameter-current').textContent`),'1 value');
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-editor-current').textContent`),'1');
    check('numeric modes: one Value thumb contributes exactly one value; unchanged current counts zero, changed value counts one', true);
    const thumb = `${row} [role="slider"]`;
    await cdp.evaluate(`document.querySelector('${thumb}').focus()`);
    await cdp.keyTrusted('ArrowLeft', { vk: 37 });
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-value-field input').value`),'0.89');
    const point = await cdp.evaluate(`(()=>{const r=document.querySelector('${thumb}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await cdp.drag(point.x,point.y,point.x-30,point.y);
    const dragged = await cdp.evaluate(`document.querySelector('${row} .vz-value-field input').value`);
    assert(Number(dragged)<.89);
    check('numeric modes: typing, fine keyboard nudge and trusted Value drag stay synchronized', true, dragged);
    await field(`${row} .vz-value-field input`, '0.9');
    await cdp.clickAt(`${row} .checkbox`); await cdp.clickAt(`${row} .checkbox`);
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-value-field input').value`),'0.9');
    await cdp.clickAt(`${row} .mode-switch button[title="Range"]`);
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-range-field:first-child input').value`),'0.7');
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-row-inc-input').value`),'0.1');
    await cdp.clickAt(`${row} .mode-switch button[title="Value"]`);
    check('numeric modes: collapse and mode changes preserve independent Value and Range settings', true);
    // Observe the terminal graph, then verify the next session's fresh defaults.
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({captureEnqueue:true})});
    const before = (await (await fetch(FAKE+'/__test/enqueues')).json()).length;
    await cdp.clickAt('.vz-run');
    await cdp.poll("document.querySelector('.vz-queued')?.textContent==='Queued 1 of 1 jobs'");
    const jobs = (await (await fetch(FAKE+'/__test/enqueues')).json()).slice(before);
    assert.equal(jobs.length,1); assert.equal(jobs[0].prompt['9'].inputs.denoise,.9);
    check('numeric modes: Value Run enqueues exactly one final graph with denoise 0.9',true);
    await closeKept(); await open();
    assert(await cdp.evaluate(`document.querySelector('${row} button[title="Range"]').getAttribute('aria-pressed')==='true'`));
    assert.equal(await cdp.evaluate(`document.querySelector('${row} .vz-row-inc-input').value`),'0.05');
    check('numeric modes: successful Run and reopen reset mode and raw Step to fresh defaults',true);
    await cdp.clickAt(`${row} .mode-switch button[title="Value"]`);
    await field(`${row} .vz-value-field input`, '0.9');
    // Show both editor modes in one full realistic-size screenshot.
    await cdp.clickAt('[data-param-key="9.steps"] .checkbox');
    await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop=0");
    if (process.env.E2E_VALUE_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(process.env.E2E_VALUE_SHOT,Buffer.from(shot.data,'base64'));
    }
    for (const width of [768,500]) {
      await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      assert(await cdp.evaluate("document.querySelector('.vz-sliders').scrollWidth<=document.querySelector('.vz-sliders').clientWidth+1"));
    }
    check('numeric modes: both editors remain within the list at 768px and 500px',true);
    await closeKept();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    const history = await (await fetch(FAKE+'/api/history')).json();
    const source = Object.values(history).find(entry => entry.outputs?.['9']?.images?.some(image => image.filename==='flux-controlnet.png'));
    assert(source);
    const first = structuredClone(source.prompt[2]), second = structuredClone(first); second['9'].inputs.denoise=.5;
    await fetch(FAKE+'/__test/activity',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publish:[
      {name:'value-batch-first.png',fixture:'flux-controlnet.png',graph:first},
      {name:'value-batch-second.png',fixture:'flux-controlnet.png',graph:second}]})});
    await cdp.evaluate(`(async()=>{for(const name of ['value-batch-first.png','value-batch-second.png'])await fetch('/api/collections/fake/entries/'+name+'/bytes');await ${KZ}.handles.invoke('variations.open',{ids:['fake:value-batch-first.png','fake:value-batch-second.png'],bulk:true})})()`);
    await cdp.poll(`!!document.querySelector('${row} .vz-numeric-editor')`);
    await cdp.clickAt(`${row} .mode-switch button[title="Value"]`);
    await field(`${row} .vz-value-field input`,'0.9');
    await cdp.poll("document.querySelector('.vz-count').textContent==='2'");
    const batchStart = (await (await fetch(FAKE+'/__test/enqueues')).json()).length;
    const result = await cdp.evaluate(`(async()=>${KZ}.handles.invoke('variations.run'))()`);
    assert.equal(result.adopted,true); assert.equal(result.submitted,2);
    const batchJobs = (await (await fetch(FAKE+'/__test/enqueues')).json()).slice(batchStart);
    assert.equal(batchJobs.length,2); assert(batchJobs.every(job=>job.prompt['9'].inputs.denoise===.9));
    assert.equal(new Set(batchJobs.map(job=>job.extra_data.extra_pnginfo.kz.source)).size,2);
    check('numeric modes: two batch targets with currents 1 and 0.5 each enqueue exactly one final graph at the same fixed 0.9',true);
  } finally { await closeKept(); await cdp.send('Emulation.clearDeviceMetricsOverride'); }
};
