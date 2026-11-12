const assert = require('node:assert/strict');
const { addParameter } = require('./variation-add-helpers.cjs');

module.exports = async ({ cdp, check, FAKE, KZ }) => {
  const name = 'Qwen_image_2.1_00500_athena_alisa_seed_2.png_00001_alisa_style_donor.png_00001_amaterasu_seed_00_6.png_00001.png';
  const prefix = 'pre_'.repeat(30), suffix = '_{470.image}_{9.denoise}_done';
  const graph = {
    '470': { class_type: 'LoadImage', inputs: { image: 'canny.png' } },
    '9': { class_type: 'BasicScheduler', inputs: { denoise: 1 } },
    '461': { class_type: 'SaveImage', inputs: { filename_prefix: 'Qwen_image_2.1', images: ['470', 0] } },
  };
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const jobs = async () => (await fetch(FAKE + '/__test/enqueues')).json();
  const type = async (selector, text) => {
    await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const reply = await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ captureEnqueue: true, publish: [{ name, fixture: 'flux-basic.png', graph, mtime: 2100000200 }] }) });
  assert(reply.ok);
  try {
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/'+encodeURIComponent(${JSON.stringify(name)})+'/bytes')})()`);
    await invoke('variations.open', { id: 'fake:' + name });
    await addParameter(cdp,'9.denoise');await addParameter(cdp,'470.image');
    await require('./variation-add-helpers.cjs').removeRecordedImage(cdp,'470.image');
    await cdp.poll("!!document.querySelector('[data-image-id=\"470.image\"] .vz-imgfilespick')");
    await cdp.evaluate(`(async()=>{const bytes=await(await fetch('/api/collections/fake/entries/flux-lora.png/bytes')).arrayBuffer(),input=document.querySelector('[data-image-id="470.image"] .vz-imgfilespick'),dt=new DataTransfer();dt.items.add(new File([bytes],${JSON.stringify(name)},{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await cdp.poll("document.querySelectorAll('.vz-image-tile').length===1&&!document.querySelector('.vz-image-check')");
    await type('.vz-prefix', prefix); await type('.vz-suffix', suffix);
    const example = await cdp.evaluate("document.querySelector('.vz-output-example')?.textContent");
    const geometry = await cdp.evaluate(`(()=>{const example=document.querySelector('.vz-output-example'),box=example.getBoundingClientRect(),group=document.querySelector('.vz-naming-group').getBoundingClientRect(),caption=example.previousElementSibling.getBoundingClientRect();return{fullWidth:Math.abs(box.left-group.left)<1&&Math.abs(box.right-group.right)<1,below:box.top>=caption.bottom,oneLine:example.scrollHeight<=example.clientHeight+1,tooltip:example.title.startsWith(example.textContent+'\\n')}})()`);
    assert(geometry.fullWidth && geometry.below && geometry.oneLine && geometry.tooltip, JSON.stringify(geometry));
    if (process.env.E2E_NAMING_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      require('node:fs').writeFileSync(process.env.E2E_NAMING_SHOT, Buffer.from(shot.data, 'base64'));
    }
    const start = (await jobs()).length, result = await invoke('variations.run');
    assert.equal(result.adopted, true, JSON.stringify(result));
    const submitted = (await jobs()).slice(start);
    assert(submitted.length > 0);
    assert.equal(example, submitted[0].prompt['461'].inputs.filename_prefix);
    assert.equal(Buffer.byteLength(example), 200); assert(example.includes('~'));
    const imageStem = name.replace(/\.[^.]+$/, ''), token = imageStem.slice(0, 19) + '~' + imageStem.slice(-20);
    for (const job of submitted) {
      const written = job.prompt['461'].inputs.filename_prefix;
      assert(written.startsWith(prefix));
      assert(written.endsWith('_' + token + '_' + job.prompt['9'].inputs.denoise + '_done_'+job.prompt['9'].inputs.denoise));
      assert(Buffer.byteLength(written + '_00001_.png') <= 255);
      assert.equal(job.prompt['470'].inputs.image, name);
    }
    assert.equal(new Set(submitted.map(job => job.prompt['461'].inputs.filename_prefix)).size, submitted.length);
    check('output names: lineage-grown source and image token queue with whole affixes, byte-safe distinct names and exact dialog-to-fake-prefix equality', true);
  } finally {
    if (await cdp.evaluate("!!document.querySelector('.vz-panel')")) {
      await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
      if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
      await cdp.poll("!document.querySelector('.vz-panel')");
    }
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: false }) });
  }
};
