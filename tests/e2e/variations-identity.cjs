// Real browser -> private editor -> Run -> accepted fake-Comfy graphs and proof.
const assert = require('node:assert/strict');
const { pickInput } = require('./image-picker-helpers.cjs');

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
    for (const id of ['76', '81']) {
      const form = new FormData(); form.append('image', new Blob(['current-' + id]), `${id}.png`);
      assert((await fetch(FAKE + '/api/upload/image', { method: 'POST', body: form })).ok);
    }
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
    await cdp.poll("!!document.querySelector('[data-image-id=\"76.image\"] .vz-imgfilespick')");
    await cdp.evaluate(`(()=>{const input=document.querySelector('[data-image-id="76.image"] .vz-imgfilespick'),dt=new DataTransfer();
      dt.items.add(new File(['content'],'identity-content.png',{type:'image/png'}));input.files=dt.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));window.__identityInput=input;window.__identityFile=input.files[0]})()`);
    // A scrolled second trigger must admit a real visible row, not merely create
    // an empty popup. Placement observes ancestor travel, never writes it.
    await cdp.clickAt('[data-image-id="81.image"] .vz-input-trigger');
    await cdp.poll("!!document.querySelector('.vz-input-search')");
    await cdp.evaluate("document.querySelector('.vz-input-search').select()");await cdp.send('Input.insertText',{text:'ref.png'});
    const placedRow = async () => {
      await cdp.poll("!!document.querySelector('.vz-input-option[data-input-name=\"ref.png\"]')");
      const geometry=await cdp.evaluate(`(()=>{const popup=document.querySelector('.vz-input-popover').getBoundingClientRect(),list=document.querySelector('.vz-input-list').getBoundingClientRect(),tile=document.querySelector('.vz-input-option[data-input-name="ref.png"]').getBoundingClientRect();return{scroll:document.querySelector('.vz-sliders').scrollTop,row:list.height>=96&&tile.top>=list.top-.5&&tile.bottom<=list.bottom+.5,visible:popup.left>=0&&popup.top>=0&&popup.right<=innerWidth&&popup.bottom<=innerHeight,tile:tile.toJSON(),list:list.toJSON(),popup:popup.toJSON()}})()`);
      assert(geometry.scroll>0&&geometry.row&&geometry.visible,JSON.stringify(geometry));
    };
    await placedRow();await cdp.poll("!document.querySelector('.vz-image-check')");
    await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
    await cdp.evaluate(`(()=>{const trigger=document.querySelector('[data-image-id="81.image"] .vz-input-trigger'),popup=document.querySelector('.vz-input-popover');const probe=window.__placementProbe={trigger,original:trigger.getBoundingClientRect,descriptor:Object.getOwnPropertyDescriptor(trigger,'getBoundingClientRect'),reads:0,writes:0};trigger.getBoundingClientRect=function(...args){probe.reads++;return probe.original.apply(this,args)};probe.observer=new MutationObserver(records=>probe.writes+=records.length);probe.observer.observe(popup,{attributes:true,attributeFilter:['style']})})()`);
    try{
      await cdp.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
      assert.deepEqual(await cdp.evaluate("({reads:window.__placementProbe.reads,writes:window.__placementProbe.writes})"),{reads:0,writes:0});
      await cdp.evaluate("for(let i=0;i<10;i++)window.dispatchEvent(new Event('resize'))");
      await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      assert.equal(await cdp.evaluate('window.__placementProbe.reads'),1);
      await cdp.evaluate("(()=>{const probe=window.__placementProbe,list=document.querySelector('.vz-sliders');probe.reads=0;probe.writes=0;probe.originalScroll=list.scrollTop;probe.wantedScroll=Math.max(1,list.scrollTop-8);list.scrollTop=probe.wantedScroll})()");
      await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      assert.equal(await cdp.evaluate('window.__placementProbe.reads'),1);await placedRow();
      assert(await cdp.evaluate("document.querySelector('.vz-sliders').scrollTop===window.__placementProbe.wantedScroll&&window.__placementProbe.writes>0"));
      await cdp.evaluate("window.__placementProbe.reads=0;window.__placementProbe.writes=0");await cdp.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
      assert.deepEqual(await cdp.evaluate("({reads:window.__placementProbe.reads,writes:window.__placementProbe.writes})"),{reads:0,writes:0});
      await cdp.keyTrusted('Escape',{vk:27});await cdp.poll("!document.querySelector('.vz-input-search')");
      await cdp.evaluate("window.__placementProbe.reads=0;for(let i=0;i<10;i++)window.dispatchEvent(new Event('resize'))");
      await cdp.evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))");
      assert.equal(await cdp.evaluate('window.__placementProbe.reads'),0);
    }finally{
      await cdp.evaluate("(()=>{const probe=window.__placementProbe;probe.observer.disconnect();if(probe.descriptor)Object.defineProperty(probe.trigger,'getBoundingClientRect',probe.descriptor);else delete probe.trigger.getBoundingClientRect;document.querySelector('.vz-sliders').scrollTop=probe.originalScroll??document.querySelector('.vz-sliders').scrollTop;delete window.__placementProbe})()");
    }
    check('placement: scrolled 81.image has a visible tile row; resize bursts coalesce, ancestor travel is read-only, no measure/write loop and close removes observers',true);
    await pickInput(cdp, 'ref.png', '[data-image-id="81.image"]');
    for (const [id, value] of [['2.text', 'positive-own'], ['92:105.text', 'negative-own']]) {
      await cdp.clickAt(`[data-text-id="${id}"] .vz-cb`);
      await type(`[data-text-id="${id}"] .vz-text-values`, value);
    }
    await cdp.clickAt('[data-enum-id="20.lora_name"] .vz-imgrow-head .vz-cb');
    await cdp.clickAt('[data-enum-id="20.lora_name"] .vz-enum-opt:last-child .vz-cb');
    // Changing every other kind must preserve the first image's exact native File.
    assert(await cdp.evaluate("document.querySelector('[data-image-id=\"76.image\"] .vz-imgfilespick')===window.__identityInput&&window.__identityInput.files[0]===window.__identityFile&&!!document.querySelector('[data-image-id=\"81.image\"] [data-image-name=\"ref.png\"]')"));
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
