// Real Chromium: exact messages in production status/field/catalogue/thumbnail/
// batch/history components, plus actual modal catalogue-error and naming paths.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, settledCount } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const cases = JSON.parse(fs.readFileSync('/work/runtime/clear-errors-cases.json', 'utf8'));
const request = async (base, path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, `${path}: ${r.status}`); return r.json();
};
(async () => {
  fs.mkdirSync(D, { recursive: true });
  const info = await request(F, '/api/object_info');
  info.ErrorNode = { input: { required: { steps: ['INT', { min: 0, max: 1000 }] } }, output: ['IMAGE'] };
  await request(F, '/__test/activity', { objectInfo: info, publish: [{ name: 'errors.png', graph: {
    n: { class_type: 'ErrorNode', inputs: { steps: 1 } }, save: { class_type: 'SaveImage', inputs: { images: ['n', 0], filename_prefix: 'errors' } },
  } }] });
  const c = await CDP.launch(19917, { windowSize: '1400,900' }), errors = await collectPageErrors(c);
  const observations = [];
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const field = (selector, value) => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const shot = async name => fs.writeFileSync(`${D}/${name}.png`, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  try {
    await c.goto(B + '/#fake#errors.png');
    await c.poll(`(async()=>${KZ}.state.images.some(i=>i.filename==='errors.png'))()`, 20000);
    // Current successful transport, malformed installation. Catch must settle Run.
    await c.evaluate(`(()=>{const read=window.fetch;window.fetch=async(...args)=>{const r=await read(...args);if(String(args[0]).includes('/probe/')){window.fetch=read;const data=await r.json();data.parameters.push(data.parameters[0]);return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})}return r}})()`);
    await invoke('variations.open', { id: 'fake:errors.png' });
    await c.poll(`document.querySelector('.vz-messages')?.textContent.includes('Cannot use the workflow catalogue for errors.png')&&!!document.querySelector('.vz-catalogue-retry')`, 20000);
    assert(await c.evaluate(`document.querySelector('.vz-run').disabled`)); await shot('catalogue-install-error');
    await c.clickAt('.vz-catalogue-retry');
    await settledCount(c, '0', { and: `!document.querySelector('.vz-catalogue-retry')`, timeout: 20000 });
    await addParameter(c, 'n.steps');
    await field('[data-param-key="n.steps"] .vz-range-field:nth-child(1) input', '2');
    await field('[data-param-key="n.steps"] .vz-range-field:nth-child(2) input', '3');
    await field('[data-param-key="n.steps"] .vz-row-inc-input', '1');
    await c.poll(`!document.querySelector('.vz-run').disabled`, 20000);
    await field('.vz-prefix', '{missing}');
    await c.poll(`document.querySelector('.vz-run').disabled&&document.querySelector('.vz-messages').textContent.includes('Unresolved naming token')`, 20000);
    assert.equal((await invoke('variations.run')).status, 'invalid');
    await field('.vz-prefix', '{other-missing}');
    await c.poll(`document.querySelector('.vz-messages').textContent.includes('Previous Run:')`, 20000);
    const status = await c.evaluate(`document.querySelector('.vz-messages').textContent`);
    assert(status.indexOf('Unresolved naming token') < status.indexOf('Previous Run:'));
    await shot('current-naming-before-previous-run');
    // Retire this real editor through its ordinary guard before component matrix.
    await c.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    await c.poll(`!!document.querySelector('.vz-discard-confirm')`); await c.clickAt('.vz-discard-confirm');
    await c.poll(`!document.querySelector('.vz-panel')`);
    await c.evaluate(`(async()=>{
      const s=await import('/vendor/solid/solid.mjs'),web=await import('/vendor/solid/web.mjs');
      const names=['RunStatus','ParameterRow','ParameterCatalogue','BatchTargets','HistoryEntry','Thumbnail'];
      const parts={};for(const name of names)parts[name]=(await import('/features/variations/'+name+'.js'))[name];
      const mount=document.createElement('section');mount.id='ce-production-fixture';mount.style.cssText='position:fixed;inset:40px;z-index:100000;background:var(--background);padding:24px;overflow:auto';document.body.append(mount);
      let cleanup;window.ceRender=(test)=>{cleanup?.();mount.replaceChildren();
        const p=test.problem,row={id:'n.steps',label:'Steps',title:'Node',type:'Node',nodeIds:['n'],key:'steps',current:1,enabled:true,domain:'numeric',problems:[p]};
        const no=()=>()=>{};
        let component,props;
        if(test.location==='status'){component=parts.RunStatus;props={preview:{status:test.row===19?'invalid':'ready'},problems:[p],result:test.row===19?{ok:true,text:'queued earlier'}:null};}
        else if(test.location==='batch'){component=parts.BatchTargets;props={targets:[{id:'fake:b.png',host:'fake',filename:'b.png'}],showProblem:true,problem:()=>p,thumbnail:()=>null,generationTime:()=>null};}
        else if(test.location==='history'){component=parts.HistoryEntry;props={entry:{id:'saved-a',createdAt:0,captureState:'complete',outcome:'uncertain',summary:{targets:['b.png'],parameters:[],problems:[p],effects:{sent:3,confirmed:1,partial:1,unknown:1,unsent:0}}},targets:true,
          onInspect:async()=>({summary:{targets:['b.png']},effects:[{id:'job-0-0',kind:'permutation',state:'confirmed',result:{nodeErrors:{}}},{id:'job-0-1',kind:'permutation',state:'partial',result:{nodeErrors:{save:{errors:['invalid input']}}}}]})};}
        else if(test.location==='thumbnail'){component=parts.Thumbnail;props={src:null,name:'b.png'};}
        else if(test.location==='catalogue'){component=parts.ParameterCatalogue;props={sections:[{nodes:[{ids:['n.steps']}]}],row:()=>({...row,enabled:false}),matches:()=>true,thumbnail:()=>null,registerFocus:no,registerPopup:no,registerEditor:no,previewActive:false};}
        else{component=parts.ParameterRow;props={row:()=>row,enabled:()=>true,summary:'1 value',onEnable:()=>{},onInsert:()=>{}};}
        cleanup=web.render(()=>s.createComponent(component,props),mount);
      };
    })()`);
    const selectors = { status: '.vz-messages', field: '.vz-parameter', catalogue: '.vz-catalogue-row', batch: '.vz-batch-issue', history: '.vh-entry', thumbnail: '.vz-thumbnail' };
    for (const test of cases) {
      await c.evaluate(`window.ceRender(${JSON.stringify(test)})`);
      const selector = '#ce-production-fixture ' + selectors[test.location];
      const full = test.message + ' ' + test.problem.action;
      await c.poll(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes(${JSON.stringify(full)})`, 5000);
      const view = await c.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect(),style=getComputedStyle(el);return {row:${test.row},location:${JSON.stringify(test.location)},text:el.textContent,width:r.width,height:r.height,visible:style.visibility!=='hidden'&&style.display!=='none'&&r.bottom>0&&r.top<innerHeight}})()`);
      assert(view.visible && view.width > 0 && view.height > 0, JSON.stringify(view)); observations.push(view);
      if (test.row === 178) {
        await c.clickAt('#ce-production-fixture .vh-inspect');
        await c.poll(`document.querySelector('[data-effect-id="job-0-1"]')?.textContent.includes('invalid input')`);
        assert.equal(await c.evaluate(`document.querySelector('[data-effect-id="job-0-0"]')?.textContent`), 'permutation job-0-0: confirmed');
        await shot('history-effects');
      }
    }
    await shot('problem-contract-production-fields');
    assert.equal(observations.length, 38); assert.deepEqual(errors, []);
    fs.writeFileSync(D + '/rows.json', JSON.stringify({ observations, pageErrors: errors, integrated: [16, 19, 84] }, null, 2));
    console.log(JSON.stringify({ rows: observations.length, integrated: [16, 19, 84], pageErrors: errors }));
  } catch (error) { await shot('failure'); throw error; }
  finally { await c.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
