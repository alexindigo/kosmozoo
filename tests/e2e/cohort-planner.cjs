// Heterogeneous cohort on a second host: exact preview, no leftover effects,
// retained editor/native input, and a new explicit Run for the adjusted rest.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, F2 = process.env.E2E_FAKE2, D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const request = async (base, path, body) => {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, `${path}: ${response.status}`); return response.json();
};
const graph = (name, choice) => ({
  load: { class_type: 'LoadImage', inputs: { image: `${name}-only.png` } },
  n: { class_type: 'CohortNode', inputs: { images: ['load', 0], steps: 20, ...(choice ? { choice: 'a' } : {}) } },
  save: { class_type: 'SaveImage', inputs: { images: ['n', 0], filename_prefix: `cohort/${name}` } },
});
(async () => {
  fs.mkdirSync(D, { recursive: true });
  const info = await request(F, '/api/object_info');
  info.CohortNode = { input: { required: { images: ['IMAGE', {}], steps: ['INT', { min: 0, max: 100 }] }, optional: { choice: [['a', 'b'], {}] } }, output: ['IMAGE'] };
  await request(F, '/__test/activity', { objectInfo: info, captureEnqueue: true,
    publishInputs: ['a', 'leftover', 'b'].map((name, index) => ({ name: `${name}-only.png`, width: 16, height: 16, color: [20 + index * 60, 30, 50, 255] })),
    publish: ['a', 'leftover', 'b'].map(name => ({ name: `cohort/${name}.png`, graph: graph(name, name !== 'leftover') })) });
  await request(F2, '/__test/activity', { objectInfo: info, captureEnqueue: true });
  const c = await CDP.launch(19693, { windowSize: '1400,900' }), errors = await collectPageErrors(c);
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const shot = async name => {
    const image = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${D}/${name}.png`, Buffer.from(image.data, 'base64'));
    for (const [region, selector] of Object.entries({ header: '.vz-header', catalogue: '.vz-catalogue', editor: '.vz-left', summary: '.vz-right', strip: '.vz-batch' })) {
      const clip = await c.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&r.width>0&&r.height>0?{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}:null})()`);
      if (clip) { const crop = await c.send('Page.captureScreenshot', { format: 'png', clip }); fs.writeFileSync(`${D}/review-${name}-${region}.png`, Buffer.from(crop.data, 'base64')); }
    }
  };
  const field = (selector, value) => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  try {
    await c.goto(B + '/#fake#cohort%2Fa.png');
    await c.poll(`(async()=>${KZ}.state.images.some(image=>image.filename==='cohort/leftover.png')&&!!${KZ}.state.hosts.another)()`, 20000);
    await invoke('variations.open', { ids: ['a', 'leftover', 'b'].map(name => `fake:cohort/${name}.png`), bulk: true });
    await c.poll(`document.querySelector('.vz-count')?.textContent==='0'`, 20000);
    assert(await c.evaluate(`document.querySelector('.vz-run').disabled`), 'all zero work disables Run');
    await c.evaluate(`(()=>{const e=document.querySelector('.vz-run-on-select');e.value='another';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await c.poll(`document.querySelector('.vz-count')?.textContent==='3'&&!document.querySelector('.vz-run').disabled`, 20000);
    await addParameter(c, 'n.choice');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='2'&&document.querySelectorAll('.vz-batch-problem').length===1`, 20000);
    const problem = await c.evaluate(`({id:document.querySelector('.vz-batch-problem').dataset.targetId,text:document.querySelector('.vz-batch-issue').textContent})`);
    assert.equal(problem.id, 'fake:cohort/leftover.png'); assert(/missing/.test(problem.text), problem.text);
    assert.equal((await request(F2, '/__test/enqueues')).length, 0);
    assert.equal((await request(B, '/api/features/variations/history')).items.length, 0, 'preview is effect-free');
    await c.evaluate(`window.cohortPrefix=document.querySelector('.vz-prefix')`);
    await field('.vz-prefix', 'kept-');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='2'&&!document.querySelector('.vz-run').disabled`, 20000);
    await shot('cohort-plan-before-run');
    const first = await invoke('variations.run');
    assert.equal(first.submitted, 2, JSON.stringify(first)); assert.equal(first.adopted, false);
    await c.poll(`document.querySelectorAll('.vz-batch-item').length===1&&document.querySelector('.vz-batch-problem')?.dataset.targetId==='fake:cohort/leftover.png'`, 20000);
    const jobs = await request(F2, '/__test/enqueues'); assert.equal(jobs.length, 2);
    assert.deepEqual(jobs.map(job => job.prompt.load.inputs.image).sort(), ['a-only.png', 'b-only.png']);
    assert.equal((await fetch(F2 + '/api/view?type=input&filename=leftover-only.png')).status, 404, 'no bytes uploaded for the leftover');
    assert.equal((await request(F, '/__test/enqueues')).length, 0, 'source host receives no jobs');
    assert(await c.evaluate(`window.cohortPrefix===document.querySelector('.vz-prefix')&&window.cohortPrefix.value==='kept-'`), 'recipe/native field retained');
    const geometry = await c.evaluate(`(()=>{const b=document.querySelector('.vz-batch').getBoundingClientRect(),r=document.querySelector('.vz-run').getBoundingClientRect(),p=document.querySelector('.vz-panel').getBoundingClientRect();return {separate:r.bottom<=b.top,contained:b.bottom<=p.bottom}})()`);
    assert(Object.values(geometry).every(Boolean), JSON.stringify(geometry));
    await new Promise(resolve => setTimeout(resolve, 3200)); assert(await c.evaluate(`!!document.querySelector('.vz-panel')`), 'leftovers prevent auto-close');
    await shot('cohort-leftover-retained');
    await c.clickAt('[data-enum-id="n.choice"] .vz-parameter-remove');
    await addParameter(c, 'n.steps');
    await c.clickAt('[data-param-key="n.steps"] .mode-switch button[title="Value"]');
    await field('[data-param-key="n.steps"] .vz-value-field input', '21');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='1'&&!document.querySelector('.vz-run').disabled&&!document.querySelector('.vz-batch-problem')`, 20000);
    const second = await invoke('variations.run'); assert.equal(second.submitted, 1, JSON.stringify(second)); assert.equal(second.adopted, true);
    const finalJobs = await request(F2, '/__test/enqueues'); assert.equal(finalJobs.length, 3);
    assert.equal(finalJobs[2].prompt.load.inputs.image, 'leftover-only.png'); assert.equal(finalJobs[2].prompt.n.inputs.steps, 21);
    const history = await request(B, '/api/features/variations/history'); assert.equal(history.items.length, 2);
    const saved = await request(B, '/api/features/variations/history/' + history.items[1].id);
    assert.equal(saved.outcome, 'submitted'); assert.deepEqual(saved.summary.leftovers.map(target => target.index), [1]);
    assert(saved.effects.filter(effect => effect.kind === 'upload').every(effect => !effect.id.startsWith('upload-1-')));
    // A newer recipe revision during Run retains every captured target, including
    // independently queued ones. Outcomes describe the old captured setup only.
    await invoke('variations.close');
    await c.poll(`!document.querySelector('.vz-panel')`, 10000);
    // The stock fake deliberately rejects duplicate upload names instead of
    // implementing ComfyUI collision naming. Isolate this second scenario's
    // destination resources rather than testing that unrelated fake limitation.
    await request(F2, '/__test/activity', { reset: true, objectInfo: info, captureEnqueue: true });
    await invoke('variations.open', { ids: ['a', 'leftover', 'b'].map(name => `fake:cohort/${name}.png`), bulk: true });
    await c.poll(`!!document.querySelector('.vz-run-on-select')&&document.querySelectorAll('.vz-catalogue-row').length>0`, 20000);
    await c.evaluate(`(()=>{const e=document.querySelector('.vz-run-on-select');e.value='another';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await c.poll(`document.querySelector('.vz-count')?.textContent==='3'`, 20000);
    await addParameter(c, 'n.choice');
    await field('.vz-prefix', 'captured-');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='2'&&!document.querySelector('.vz-run').disabled`, 20000);
    await c.evaluate(`(()=>{const original=window.fetch;let release;const gate=new Promise(resolve=>{release=resolve});window.cohortEntered=0;window.cohortRelease=()=>{window.fetch=original;release()};window.fetch=(url,options)=>{if(String(url).endsWith('/features/variations/run')){window.cohortEntered++;return gate.then(()=>original(url,options));}return original(url,options)};})()`);
    await c.evaluate(`(async()=>{window.cohortRunning=${KZ}.handles.invoke('variations.run');return true})()`);
    await c.poll(`window.cohortEntered===2`, 20000);
    await field('.vz-prefix', 'newer-');
    await c.evaluate(`window.cohortRelease()`);
    const newer = await c.evaluate(`window.cohortRunning`);
    assert.equal(newer.submitted, 2, JSON.stringify(newer)); assert.equal(newer.adopted, false);
    await c.poll(`document.querySelectorAll('.vz-batch-item').length===3&&document.querySelectorAll('.vz-batch-queued').length===2&&document.querySelectorAll('.vz-batch-outcome.vz-batch-issue').length===1`, 20000);
    assert.equal(await c.evaluate(`document.querySelector('.vz-prefix').value`), 'newer-');
    assert(await c.evaluate(`document.querySelector('.vz-messages').textContent.includes('newer edits have been kept with all captured images')`));
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(await c.evaluate(`document.querySelectorAll('.vz-batch-item').length`), 3, 'newer edits keep the cohort and prevent auto-close');
    const queuedSetup = (await request(F2, '/__test/enqueues')).slice(-2);
    assert.equal(queuedSetup.length, 2);
    assert(queuedSetup.every(job => job.prompt.save.inputs.filename_prefix.includes('captured-') && !job.prompt.save.inputs.filename_prefix.includes('newer-')), 'only the captured recipe was queued');
    await shot('cohort-newer-edits-retain-targets');
    assert.deepEqual(errors, []);
    fs.writeFileSync(D + '/result.json', JSON.stringify({ problem, first, second, newer, geometry, jobs: finalJobs.length + queuedSetup.length, history: (await request(B, '/api/features/variations/history')).items.length, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ first, second, newer, jobs: finalJobs.length + queuedSetup.length, pageErrors: errors }));
  } catch (error) {
    console.error('cohort state', await c.evaluate(`({count:document.querySelector('.vz-count')?.textContent,message:document.querySelector('.vz-messages')?.textContent,batch:document.querySelector('.vz-batch')?.textContent})`));
    await shot('cohort-diagnostic'); throw error;
  } finally { await c.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
