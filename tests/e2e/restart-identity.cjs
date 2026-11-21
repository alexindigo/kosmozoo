const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { CDP, collectPageErrors, sleep } = require('./cdp.cjs');
const { addParameter, removeRecordedImage, settledCount } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, R = process.env.E2E_RESTART_DIR;
assert(R && path.isAbsolute(R), 'restart-identity needs an absolute E2E_RESTART_DIR shared with the engine restart runner');
const D = process.env.E2E_EVIDENCE ?? process.env.KZ_TIME_EVIDENCE, folder = process.env.E2E_FOLDER_IMAGES ?? '/work/tests/fixtures';
const KZ = `(await import('/store/instance.js')).appStore`, name = 'restart-identity.png';
const graph = { '470': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
  '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'restart-identity', images: ['470', 0] } } };
const post = async (base, route, body) => {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert(response.ok, `${route}: ${response.status}`); return response.json();
};
async function restart() {
  const request = path.join(R, 'request'), done = path.join(R, 'done');
  assert(!fs.existsSync(request) && !fs.existsSync(done), 'restart handshake directory must start without request/done files');
  fs.writeFileSync(request, 'restart-identity\n');
  const deadline = Date.now() + 90000;
  while (!fs.existsSync(done)) { assert(Date.now() < deadline, 'engine restart handshake timed out after 90 seconds'); await sleep(100); }
  fs.unlinkSync(request); fs.unlinkSync(done);
  const readyDeadline = Date.now() + 90000;
  for (;;) {
    try { if ((await fetch(B + '/api/runtime', { signal: AbortSignal.timeout(3000) })).status === 200) return; } catch { /* engine is starting */ }
    assert(Date.now() < readyDeadline, 'engine /api/runtime did not recover after restart'); await sleep(100);
  }
}
(async () => {
  assert(B && F, 'restart-identity needs E2E_ENGINE and E2E_FAKE');
  await post(F, '/__test/activity', { captureEnqueue: true, publish: [{ name, graph, fixture: 'flux-basic.png', mtime: 2100000800 }] });
  assert((await fetch(B + `/api/collections/fake/entries/${name}/bytes`)).ok);
  const c = await CDP.launch(19497, { windowSize: '1440,1000' }), errors = await collectPageErrors(c), proof = {};
  const invoke = (id, args = {}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const origin = `(async()=>{const s=${KZ},r=s.state.hosts.fake;return{source:'fake',address:r.address,kind:r.kind,incarnation:r.incarnation}})()`;
  const field = (selector, value) => c.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const open = async () => {
    await invoke('variations.open', { id: `fake:${name}` }); await addParameter(c, '470.image');
    await removeRecordedImage(c, '470.image'); await c.clickAt('[data-image-id="470.image"] .vz-image-plus');
  };
  try {
    await c.goto(B + '/#fake#' + name);
    await c.poll(`(async()=>${KZ}.state.images.some(image=>image.filename===${JSON.stringify(name)}))()`, 30000);
    await invoke('selection.clear');
    await invoke('feed.revealEntry', { id: `fake:${name}` });
    await c.poll(`!!document.querySelector(${JSON.stringify(`.card[data-name="${name}"] .selcb`)})`, 30000);
    await c.clickAt(`.card[data-name="${name}"] .selcb`);
    await open(); await field('.vz-prefix', 'kept-prefix-');
    await c.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),dt=new DataTransfer();dt.items.add(new File([bytes],'kept-native.png',{type:'image/png'}));const el=document.querySelector('.vz-imgfilespick');el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await c.poll(`!!document.querySelector('[data-image-kind="upload"]')&&!document.querySelector('.vz-messages')?.textContent.includes('Checking images')`, 30000);
    proof.before = await c.evaluate(origin);
    const epoch = await c.evaluate(`(async()=>${KZ}.state.hosts.fake.sourceVersion.epoch)()`);
    await c.evaluate(`window.__restartPanel=document.querySelector('.vz-panel');window.__restartFileTile=document.querySelector('[data-image-kind="upload"]');window.__restartDocument=document.documentElement;true`);
    await restart();
    await c.poll(`(async()=>${KZ}.state.hosts.fake?.sourceVersion.epoch!==${JSON.stringify(epoch)}&&!${KZ}.state.inventory.loading)()`, 60000);
    proof.after = await c.evaluate(origin); assert.deepEqual(proof.after, proof.before);
    assert.equal(await c.evaluate(`document.documentElement===window.__restartDocument&&document.querySelector('.vz-panel')===window.__restartPanel&&document.querySelector('[data-image-kind="upload"]')===window.__restartFileTile&&document.querySelector('.vz-prefix').value==='kept-prefix-'`), true, 'restart retains the mounted raw editor and native File tile without a page reload');
    assert.equal(await c.evaluate(`(async()=>${KZ}.state.selected[${JSON.stringify(`fake:${name}`)}]===true)()`), true);
    await c.clickAt('.vz-folder-trigger'); await field('.vz-folder-path', folder); await c.clickAt('.vz-folder-add');
    await c.poll(`document.querySelectorAll('[data-image-kind="server-path"]').length>0`, 30000);
    await settledCount(c, { test: 'Number(count)>0' }, { and: `!document.querySelector('.vz-messages')?.textContent.includes('Checking images')`, timeout: 30000 });
    proof.run = await invoke('variations.run'); assert(proof.run.submitted > 0, JSON.stringify(proof.run));
    assert(!/origin changed|removed or changed since/.test(await c.evaluate(`document.querySelector('.vz-messages')?.textContent??''`)));
    await c.poll(`!document.querySelector('.vz-panel')`, 20000);
    await invoke('feed.revealEntry', { id: `fake:${name}` });
    await c.poll(`document.querySelector(${JSON.stringify(`.card[data-name="${name}"] .selcb`)})?.checked===true`);
    await open(); await c.clickAt('.vz-current-image');
    const before = (await (await fetch(F + '/__test/enqueues')).json()).length;
    // The engine never removes its last source; keep another one registered.
    await post(B, '/api/collections', { name: 'restart-other', address: `127.0.0.2:${new URL(F).port}` });
    const removed = await fetch(B + '/api/collections/fake', { method: 'DELETE' });
    assert(removed.ok, `remove fake: ${removed.status} ${await removed.text()}`);
    await c.poll(`(async()=>!${KZ}.state.hosts.fake)()`, 30000);
    await post(B, '/api/collections', { name: 'fake', address: proof.before.address });
    await c.poll(`(async()=>!!${KZ}.state.hosts.fake&&${KZ}.state.hosts.fake.incarnation!==${JSON.stringify(proof.before.incarnation)})()`, 30000);
    proof.stale = await invoke('variations.run');
    const message = `${name}: fake changed. Your edits remain here; previously issued jobs/uploads are not reversed.`;
    await c.poll(`document.querySelector('.vz-messages')?.textContent.includes(${JSON.stringify(message)})`);
    assert.equal((await (await fetch(F + '/__test/enqueues')).json()).length, before, 'stale registration sends no jobs');
    assert.deepEqual(errors, []);
    if (D) { fs.mkdirSync(D, { recursive: true }); fs.writeFileSync(D + '/restart-identity.json', JSON.stringify({ ...proof, pageErrors: errors }, null, 2)); }
    console.log('restart-identity: ok');
  } finally { await c.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
