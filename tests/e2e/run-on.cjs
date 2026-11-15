// Run on: header row, destination conflicts in red at the top, closest-choice
// resolution, Run blocked until resolved, and jobs reaching only that host.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.KZ_TIME_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const port = new URL(F).port, image = 'flux-basic.png';
const post = async (base, path, body) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok, `${path} ${r.status}`); return r.json().catch(() => null); };
const get = async (base, path) => (await fetch(base + path)).json();
(async () => {
  fs.mkdirSync(D, { recursive: true });
  // Two more hosts on the fake's other addresses. Both list every class the
  // workflow uses (a real object_info lists all installed nodes) except where noted.
  const info = await get(F, '/api/object_info');
  await fetch(B + `/api/collections/fake/entries/${image}/bytes`);
  const probe = await get(B, `/api/features/variations/probe/${encodeURIComponent('fake:' + image)}`);
  for (const node of probe.nodes) info[node.type] ??= { input: { required: {} } };
  const models = ['flux1-dev-fp8.safetensors', 'sdxl.safetensors'];
  const third = { ...info, UNETLoader: { input: { required: { ...info.UNETLoader.input.required, unet_name: [models, {}] } } } };
  const other = { ...third }; delete other.FluxGuidance;
  await post(F, '/__test/activity', { objectInfoByHost: { '127.0.0.2': other, '127.0.0.3': third }, captureEnqueue: true });
  await post(B, '/api/collections', { name: 'other', address: `127.0.0.2:${port}` });
  await post(B, '/api/collections', { name: 'third', address: `127.0.0.3:${port}` });
  const c = await CDP.launch(19491, { windowSize: '1400,900' }), errors = await collectPageErrors(c), proof = {};
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(D + '/' + name + '.png', Buffer.from(s.data, 'base64')); };
  const choose = host => c.evaluate(`(()=>{const s=document.querySelector('.vz-run-on-select');s.value=${JSON.stringify(host)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  try {
    await c.goto(B + '/#fake#' + encodeURIComponent(image));
    await c.poll(`(async()=>!!${KZ}.state.hosts.third&&${KZ}.state.host()==='fake')()`, 20000);
    await c.evaluate(`(async()=>${KZ}.handles.invoke('variations.open',{id:'fake:${image}'}))()`);
    await c.poll(`document.querySelectorAll('.vz-catalogue-row').length>0&&document.querySelector('.vz-run-on .select-face')?.textContent==='Run on fake'`, 20000);
    // One header row: title, recall (flexible), Run on, close, in that order and on one line.
    proof.header = await c.evaluate(`(()=>{const h=document.querySelector('.vz-header').getBoundingClientRect(),parts=['.vz-title','.vh-trigger','.vz-run-on .select-control','.vz-close'].map(s=>document.querySelector(s).getBoundingClientRect());
      return {ordered:parts.every((r,i)=>!i||r.left>=parts[i-1].right),oneRow:parts.every(r=>r.top>=h.top-1&&r.bottom<=h.top+40),recallWidest:parts[1].width>parts[2].width,
        titleOneLine:document.querySelector('.vz-title').scrollHeight<=document.querySelector('.vz-title').clientHeight+1,noConflicts:!document.querySelector('.vz-conflict'),
        centerline:parts.slice(1).every(r=>Math.abs((r.top+r.bottom)/2-(parts[1].top+parts[1].bottom)/2)<0.5),
        inset:(()=>{const at=(box,text)=>document.querySelector(text).getBoundingClientRect().left-document.querySelector(box).getBoundingClientRect().left;
          return Math.abs(at('.vz-run-on .select-control','.vz-run-on .select-face-content > .single-line-text')-at('.vh-trigger','.vh-trigger > .single-line-text'))<0.5})()}})()`);
    assert(Object.values(proof.header).every(Boolean), JSON.stringify(proof.header));
    await shot('run-on-header');
    // The host is a compared parameter: only the current sampler reproduces the
    // original here (0 variations) but is a new image on another host (1).
    await addParameter(c, '8.sampler_name');
    await c.poll(`document.querySelectorAll('[data-enum-id="8.sampler_name"] .vz-enum-picked').length===1&&document.querySelector('.vz-count')?.textContent==='0'`, 20000);
    await choose('third');
    await c.poll(`document.querySelector('.vz-run-on .select-face')?.textContent==='Run on third'&&document.querySelector('.vz-count')?.textContent==='1'`, 20000);
    proof.hostCounted = await c.evaluate(`document.querySelector('.vz-count').textContent`);
    // A failed destination check says so and offers Retry for the same host.
    await c.evaluate(`(()=>{const original=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/probe/')&&String(url).includes('destination=')&&decodeURIComponent(String(url)).includes('"source":"other"')){window.fetch=original;return Promise.resolve(new Response(JSON.stringify({error:'object_info timed out'}),{status:502,headers:{'Content-Type':'application/json'}}));}return original(url,options)}})()`);
    await choose('other');
    await c.poll(`!!document.querySelector('.vz-catalogue-retry')`, 20000);
    proof.failed = await c.evaluate(`document.querySelector('.vz-messages .vz-readiness-error')?.textContent`);
    assert(/^Couldn't check other: /.test(proof.failed), proof.failed);
    await shot('run-on-check-failed');
    await c.clickAt('.vz-catalogue-retry');
    await c.poll(`document.querySelector('.vz-catalogue-row')?.classList.contains('vz-conflict')`, 20000);
    assert.equal(await c.evaluate(`!!document.querySelector('.vz-catalogue-retry')`), false);
    proof.other = await c.evaluate(`({rows:[...document.querySelectorAll('.vz-catalogue-row')].map(r=>({id:r.dataset.catalogueId,conflict:r.classList.contains('vz-conflict'),reason:r.querySelector('.vz-conflict-reason')?.textContent??null})),
      message:document.querySelector('.vz-messages').textContent,red:getComputedStyle(document.querySelector('.vz-catalogue-row.vz-conflict .vz-conflict-reason')).color})`);
    const first = proof.other.rows.findIndex(r => !r.conflict);
    assert(first > 0 && proof.other.rows.slice(first).every(r => !r.conflict), 'conflicts are first');
    assert(proof.other.rows.some(r => r.reason === 'flux1-dev.safetensors is not on other'));
    assert(proof.other.rows.some(r => r.reason === 'FluxGuidance is not installed on other'));
    assert(/Resolve \d+ conflicts with other before running\./.test(proof.other.message), proof.other.message);
    await shot('run-on-conflicts');
    const unet = proof.other.rows.find(r => r.reason?.startsWith('flux1-dev')).id;
    await c.clickAt(`[data-catalogue-id="${unet}"] .vz-catalogue-context`);
    await c.poll(`!!document.querySelector('[data-enum-id="${unet}"] .vz-conflict-pick')`);
    proof.suggestions = await c.evaluate(`[...document.querySelectorAll('[data-enum-id="${unet}"] .vz-conflict-pick')].map(b=>b.textContent)`);
    assert.deepEqual(proof.suggestions, ['flux1-dev-fp8.safetensors']);
    // The missing pick is listed in red and can be unpicked; the sidebar explains the conflict.
    proof.opened = await c.evaluate(`({missing:[...document.querySelectorAll('[data-enum-id="${unet}"] .vz-enum-missing')].map(e=>e.textContent),message:document.querySelector('.vz-messages').textContent,
      nameColor:getComputedStyle(document.querySelector('[data-enum-id="${unet}"] .vz-parameter-name .vz-label')).color})`);
    assert.deepEqual(proof.opened.missing, ['flux1-dev.safetensors']);
    assert.equal(proof.opened.nameColor, proof.other.red, 'the editor card names the conflict in the same red');
    assert(/Resolve \d+ conflicts with other before running\./.test(proof.opened.message), proof.opened.message);
    await shot('run-on-suggestion');
    await c.clickAt(`[data-enum-id="${unet}"] .vz-conflict-pick`);
    await c.poll(`!document.querySelector('[data-enum-id="${unet}"]').classList.contains('vz-conflict')`);
    const before = (await get(F, '/__test/enqueues')).length;
    proof.blocked = await c.evaluate(`(async()=>${KZ}.handles.invoke('variations.run'))()`);
    assert.equal(proof.blocked.status, 'invalid'); assert.equal((await get(F, '/__test/enqueues')).length, before, 'node conflict sends nothing');
    // The same resolution on a host that has every node runs there only.
    await choose('third');
    await c.poll(`document.querySelector('.vz-run-on .select-face')?.textContent==='Run on third'&&document.querySelector('.vz-count')?.textContent==='1'&&!document.querySelector('.vz-conflict')`, 20000);
    proof.run = await c.evaluate(`(async()=>${KZ}.handles.invoke('variations.run'))()`);
    assert.equal(proof.run.submitted, 1, JSON.stringify(proof.run));
    const hosts = await get(F, '/__test/enqueue-hosts'), jobs = await get(F, '/__test/enqueues');
    proof.hosts = hosts.slice(before); assert.deepEqual(proof.hosts, ['127.0.0.3']);
    const job = jobs.at(-1).prompt, loader = Object.values(job).find(n => n.class_type === 'UNETLoader');
    assert.equal(loader.inputs.unet_name, 'flux1-dev-fp8.safetensors');
    const saved = await get(B, '/api/features/variations/history/' + (await get(B, '/api/features/variations/history')).items[0].id);
    assert.equal(saved.destination?.source, 'third');
    await shot('run-on-submitted');
    assert.deepEqual(errors, []);
    fs.writeFileSync(D + '/result.json', JSON.stringify({ ...proof, pageErrors: errors }, null, 2));
    console.log(JSON.stringify({ hostCounted: proof.hostCounted, header: proof.header, suggestions: proof.suggestions, blocked: proof.blocked.status, hosts: proof.hosts, pageErrors: errors }));
  } finally { await c.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
