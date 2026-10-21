// Real browser -> private editor -> Run -> accepted fake-Comfy graphs and proof.
const assert = require('node:assert/strict');

module.exports = async ({ cdp, FAKE, KZ, check }) => {
  const http = async (path, body) => {
    const response = await fetch(FAKE + path, body ? { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    assert(response.ok); return response.json();
  };
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const type = async (selector, text) => {
    await cdp.clickAt(selector);
    await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  await http('/__test/activity', { captureEnqueue: true });
  try {
    const history = await http('/api/history');
    const source = Object.values(history).find(entry => entry.outputs?.['9']?.images?.some(image => image.filename === 'flux-lora.png'));
    assert(source);
    const graph = structuredClone(source.prompt[2]);
    for (const id of ['76', '81']) graph[id] = { class_type: 'LoadImage', inputs: { image: `${id}.png` }, _meta: { title: 'Reference' } };
    graph['92:105'] = structuredClone(graph['2']); graph['92:105'].inputs.text = 'nested original';
    for (const id of ['76', '81', '92:105', '20', '21']) graph[id].is_changed = [`archived-${id}`];
    graph['92:105'].inputs.is_changed = 'custom input retained';
    for (const id of ['20', '21']) graph[id]._meta = { title: 'LoRA' };
    await http('/__test/activity', { publish: [{ name: 'identity-multiple.png', fixture: 'flux-lora.png', graph, mtime: 2100000001 }] });
    await cdp.evaluate("(async()=>{await fetch('/api/collections/fake/entries/identity-multiple.png/bytes')})()");
    await invoke('variations.open', { id: 'fake:identity-multiple.png' });
    await cdp.poll("document.querySelectorAll('[data-image-id]').length===2&&!!document.querySelector('[data-text-id=\"92:105.text\"]')");
    const labels = await cdp.evaluate("[...document.querySelectorAll('[data-image-id] .vz-imgrow-label')].map(e=>e.textContent)");
    assert.deepEqual(labels, ['Reference #76 · image', 'Reference #81 · image']);
    for (const id of ['20', '21']) assert(await cdp.evaluate(`!!document.querySelector('[data-param-key="${id}.strength_model"]')`));
    await cdp.clickAt('[data-param-key="9.denoise"] .vz-cb');
    await cdp.clickAt('[data-param-key="20.strength_model"] .vz-cb');
    await type('[data-param-key="20.strength_model"] .vz-row-inc-input', '0.3');
    for (const id of ['76.image', '81.image']) await cdp.clickAt(`[data-image-id="${id}"] .vz-cb`);
    await cdp.evaluate(`(()=>{const row=document.querySelector('[data-image-id="76.image"]'),mode=row.querySelector('.vz-imgmode');
      mode.value='files';mode.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("!!document.querySelector('[data-image-id=\"76.image\"] .vz-imgfilespick')");
    await cdp.evaluate(`(()=>{const input=document.querySelector('[data-image-id="76.image"] .vz-imgfilespick'),dt=new DataTransfer();
      dt.items.add(new File(['content'],'identity-content.png',{type:'image/png'}));input.files=dt.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));window.__identityInput=input;window.__identityFile=input.files[0];
      const select=document.querySelector('[data-image-id="81.image"] .vz-imgfile');select.value='ref.png';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    for (const [id, value] of [['2.text', 'positive-own'], ['92:105.text', 'negative-own']]) {
      await cdp.clickAt(`[data-text-id="${id}"] .vz-cb`);
      await type(`[data-text-id="${id}"] .vz-text-values`, value);
    }
    await cdp.clickAt('[data-enum-id="20.lora_name"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('[data-enum-id="20.lora_name"] .vz-enum-opt:last-child .vz-cb');
    // Changing every other kind must preserve the first image's exact native File.
    assert(await cdp.evaluate("document.querySelector('[data-image-id=\"76.image\"] .vz-imgfilespick')===window.__identityInput&&window.__identityInput.files[0]===window.__identityFile&&document.querySelector('[data-image-id=\"81.image\"] .vz-imgfile').value==='ref.png'"));
    await type('.vz-prefix', 'identity_');
    await type('.vz-suffix', '_{76.image}_{81.image}_{20.strength_model}_{20.lora_name}_{2.text}_{92:105.text}');
    const start = (await http('/__test/enqueues')).length;
    const result = await invoke('variations.run');
    assert.equal(result.status, 'submitted'); assert.equal(result.adopted, true);
    const jobs = (await http('/__test/enqueues')).slice(start);
    assert.equal(jobs.length, 6);
    assert.equal(new Set(jobs.map(job => job.prompt['20'].inputs.strength_model)).size, 3);
    assert.equal(new Set(jobs.map(job => job.prompt['20'].inputs.lora_name)).size, 2);
    for (const job of jobs) {
      assert(Object.values(job.prompt).every(node => !Object.hasOwn(node, 'is_changed')));
      assert.equal(job.prompt['92:105'].inputs.is_changed, 'custom input retained');
      assert.equal(job.prompt['21'].inputs.strength_model, graph['21'].inputs.strength_model);
      assert.equal(job.prompt['21'].inputs.lora_name, graph['21'].inputs.lora_name);
      assert.equal(job.prompt['76'].inputs.image, 'identity-content.png');
      assert.equal(job.prompt['81'].inputs.image, 'ref.png');
      assert.equal(job.prompt['2'].inputs.text, 'positive-own');
      assert.equal(job.prompt['92:105'].inputs.text, 'negative-own');
      const names = Object.values(job.prompt).filter(node => node.class_type === 'SaveImage').map(node => node.inputs.filename_prefix);
      assert(names.length); assert(names.every(name => !/[{}]/.test(name) && name.includes('_identity-content.png_ref.png_') && name.endsWith('_positive-own_negative-own')));
    }
    assert(await cdp.evaluate("window.__identityInput.files[0]===window.__identityFile"));
    await cdp.poll("!document.querySelector('.vz-panel')", 6000);
    check('identity: two LoadImages, two LoRAs, two text nodes and enum choices reach six own-node graphs, expanded names and clean proof adoption', true);
  } finally {
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{window.__identityLeave=${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
    await http('/__test/activity', { captureEnqueue: false });
  }
};
