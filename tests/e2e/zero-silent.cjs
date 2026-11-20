// Real acquisition paths share count-only identities; crossing the per-image
// cap keeps the workload visible without admitting effects.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, openImageFolder, pickInput, waitForInputPicker } = require('./image-picker-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, F2 = process.env.E2E_FAKE2, P = process.env.E2E_PEXELS, D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const request = async (base, path, body) => {
  const r = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(r.ok, `${path}: ${r.status}`); return r.json();
};
(async () => {
  fs.mkdirSync(D, { recursive: true });
  const info = await request(F, '/api/object_info');
  info.ZeroNode = { input: { required: { images: ['IMAGE', {}], steps: ['INT', { min: 0, max: 1000 }] } }, output: ['IMAGE'] };
  const graph = { load: { class_type: 'LoadImage', inputs: { image: 'zero-original.png' } },
    n: { class_type: 'ZeroNode', inputs: { steps: 1, images: ['load', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['n', 0], filename_prefix: 'zero-target' } } };
  await request(F, '/__test/activity', { objectInfo: info, captureEnqueue: true,
    publishInputs: [{ name: 'zero-original.png', width: 16, height: 16, color: [1, 2, 3, 255] },
      ...Array.from({ length: 36 }, (_, i) => ({ name: `zero-${i}.png`, width: 16, height: 16, color: [i + 10, 25, 50, 255] }))],
    publish: [{ name: 'zero-target.png', graph }, { name: 'zero-output.png', graph }] });
  await request(F2, '/__test/activity', { publish: [{ name: 'zero-foreign.png', graph }] });
  await request(B, '/api/features/variations/pexels/services', { name: 'Test photos', url: P });
  const c = await CDP.launch(19897, { windowSize: '1400,900' }), errors = await collectPageErrors(c);
  const observations = [];
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const field = (selector, value) => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const record = async name => {
    const state = await c.evaluate(`({count:document.querySelector('.vz-count')?.textContent,status:document.querySelector('.vz-messages')?.textContent,title:document.querySelector('.vz-messages')?.title,overLimit:document.querySelector('.vz-count')?.classList.contains('vz-count-over-limit'),disabled:document.querySelector('.vz-run')?.disabled,strip:!!document.querySelector('.vz-batch-item'),plans:window.zeroPlans})`);
    observations.push({ name, ...state }); fs.writeFileSync(D + '/observations.json', JSON.stringify(observations, null, 2)); return state;
  };
  const shot = async name => fs.writeFileSync(`${D}/${name}.png`, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const open = async () => {
    await invoke('variations.open', { id: 'fake:zero-target.png' });
    await c.poll(`document.querySelector('.vz-count')?.textContent==='0'`, 20000);
    await addParameter(c, 'n.steps');
    await field('[data-param-key="n.steps"] .vz-range-field:nth-child(1) input', '2');
    await field('[data-param-key="n.steps"] .vz-range-field:nth-child(2) input', '18');
    await field('[data-param-key="n.steps"] .vz-row-inc-input', '1');
    await addParameter(c, 'load.image'); await removeRecordedImage(c, 'load.image');
    await openImageAdd(c);
  };
  const close = async () => {
    await c.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    await c.poll(`!!document.querySelector('.vz-discard-confirm')`); await c.clickAt('.vz-discard-confirm');
    await c.poll(`!document.querySelector('.vz-panel')`);
  };
  const files = async (start, end) => c.evaluate(`(async()=>{const data=new DataTransfer();for(let i=${start};i<${end};i++){const bytes=await(await fetch('/api/collections/fake/entries/zero-'+i+'.png/bytes?kind=input')).arrayBuffer();data.items.add(new File([bytes],'chosen-'+i+'.png',{type:'image/png'}))}const input=document.querySelector('.vz-imgfilespick');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  try {
    await c.goto(B + '/#fake#zero-target.png');
    await c.poll(`(async()=>${KZ}.state.images.some(i=>i.filename==='zero-target.png')&&!!${KZ}.state.hosts.another)()`, 20000);
    await c.evaluate(`(()=>{const original=window.fetch;window.zeroPlans=[];window.fetch=async(...args)=>{const r=await original(...args);if(String(args[0]).endsWith('/features/variations/plan'))window.zeroPlans.push(await r.clone().json());return r}})()`);
    for (const kind of ['input', 'output', 'target', 'browser-file', 'server-path', 'foreign-output', 'pexels']) {
      await open();
      if (kind === 'input') await pickInput(c, 'zero-0.png');
      if (kind === 'target') await c.clickAt('.vz-current-image');
      if (kind === 'browser-file') await files(0, 1);
      if (kind === 'server-path') {
        const folder = D + '/folder'; fs.mkdirSync(folder, { recursive: true });
        const r = await fetch(F + '/api/view?type=input&filename=zero-0.png'); fs.writeFileSync(folder + '/from-folder.png', Buffer.from(await r.arrayBuffer()));
        await openImageFolder(c); await field('.vz-folder-path', folder); await c.clickAt('.vz-folder-add');
      }
      if (kind === 'output' || kind === 'foreign-output') {
        await c.clickAt('.vz-input-trigger'); await waitForInputPicker(c);
        if (kind === 'foreign-output') await c.clickAt('.vz-input-tabs [role=tab][data-value="another"]');
        await c.clickAt('.vz-input-feeds [role=tab][data-value="output"]');
        const name = kind === 'output' ? 'zero-output.png' : 'zero-foreign.png';
        await c.poll(`!!document.querySelector('[data-input-name="${name}"]')`, 20000);
        await c.clickAt(`[data-input-name="${name}"]`); await c.keyTrusted('Escape', { vk: 27 });
      }
      if (kind === 'pexels') {
        await c.clickAt('.vz-image-external .vz-input-trigger'); await waitForInputPicker(c);
        await c.poll(`document.querySelectorAll('.vz-input-option').length>0`, 20000);
        await c.clickAt('.vz-input-option'); await c.keyTrusted('Escape', { vk: 27 });
      }
      await c.poll(`document.querySelector('.vz-count')?.textContent==='17'&&!document.querySelector('.vz-run').disabled`, 20000);
      const state = await record(kind); assert(!state.strip, 'single target has no strip');
      await close();
    }
    await open(); await files(0, 22);
    await c.poll(`document.querySelector('.vz-count')?.textContent==='374'&&!document.querySelector('.vz-run').disabled`, 20000);
    await record('22 images x 17 values');
    await files(22, 36);
    await c.poll(`window.zeroPlans.at(-1)?.[0]?.problem?.code==='too-many'&&!document.querySelector('.vz-image-check')`, 20000);
    const high = await record('36 images x 17 values'); await shot('over-limit-single-target');
    assert.equal(high.count, '612', JSON.stringify(high)); assert(high.overLimit); assert(high.disabled); assert(!high.strip);
    assert.match(high.status, /612 jobs for this image; the limit is 500 per image/);
    assert(high.title.includes(high.status.trim()));
    const before = await request(F, '/__ordered');
    assert.equal((await invoke('variations.run')).status, 'invalid');
    assert.equal((await request(B, '/api/features/variations/history')).items.length, 0);
    assert.deepEqual(await request(F, '/__ordered'), before, 'over-limit Run has no upload or prompt effects');
    // Existing result text must not conceal a newly computed target problem.
    await field('[data-param-key="n.steps"] .vz-range-field:nth-child(2) input', '17');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='576'&&document.querySelector('.vz-messages')?.textContent.includes('576 jobs for this image')`, 20000);
    await record('problem after previous Run result');
    // A non-count failure also remains visible with one target and no strip.
    await c.evaluate(`(()=>{const original=window.fetch;window.fetch=(url,...rest)=>String(url).endsWith('/features/variations/plan')?Promise.resolve(new Response(JSON.stringify([{index:0,count:0,problem:{code:'unavailable',message:'Original input is unavailable; choose another image.'}}]),{headers:{'Content-Type':'application/json'}})):original(url,...rest)})()`);
    await field('.vz-prefix', 'next-');
    await c.poll(`document.querySelector('.vz-count')?.textContent==='0'&&document.querySelector('.vz-messages')?.textContent.includes('Original input is unavailable')`, 20000);
    const forced = await record('forced problem without strip'); assert(!forced.strip); assert(forced.disabled); await shot('problem-single-target');
    assert.deepEqual(errors, []); console.log(JSON.stringify({ cases: observations.map(({name,count}) => ({name,count})), pageErrors: errors }));
  } catch (error) { await record('failure'); await shot('failure'); throw error; }
  finally { await c.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
