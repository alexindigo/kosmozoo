// Exact name data through real inventory, feed, native display and actions.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, removeRecordedImage } = require('./variation-add-helpers.cjs');
const { openImageAdd, waitForInputPicker } = require('./image-picker-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const names = ['line\nbreak.png', 'carriage\rreturn.png', 'tab\tname.png', 'dir\nname/leaf\r\t.png', 'quotes"[name]#%.png'];
const post = async (base, url, body) => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text()); return r.json();
};
const entry = name => '/api/collections/fake/entries/' + encodeURIComponent(name);
const card = name => `[...document.querySelectorAll('.card')].find(el=>el.dataset.name===${JSON.stringify(name)})`;
(async () => {
  assert(B && F && E);
  fs.mkdirSync(E, { recursive: true });
  await post(F, '/__test/activity', { captureEnqueue: true, assetsPlusDelete: true,
    publish: names.map((name, i) => ({ name, width: 180, height: 100, color: [i * 40, 80, 120, 255], graph: {
      '1': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
      '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: name.slice(0, -4) } },
    } })), listingRecords: { root: ['nul\0.png', '../bad.png'], nested: [{ relpath: 'dir/../bad.png', size: 12, mtime: 1 }] } });
  const page = await CDP.launch(19561, { windowSize: '1400,1000' }), errors = await collectPageErrors(page), proof = [];
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const shot = async name => fs.writeFileSync(path.join(E, name + '.png'), Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  try {
    await page.goto(B + '/#fake#' + encodeURIComponent(names[0]));
    await page.poll(`(async()=>${KZ}.state.inventory.skipped?.count===3&&${KZ}.state.images.some(e=>e.filename===${JSON.stringify(names[0])}))()`, 20000);
    await page.poll(`[...document.querySelectorAll('#statusStack .warning')].some(el=>el.textContent==='3 files could not be listed: invalid relative path (3) (fake)')`);
    // No stale warning leaks into another source, and return rereads its facts.
    await invoke('source.select', { id: 'another' });
    await page.poll(`(async()=>${KZ}.state.host()==='another'&&!${KZ}.state.inventory.loading)()`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#statusStack .warning')].some(el=>el.textContent.includes('could not be listed'))`), false);
    await invoke('source.select', { id: 'fake' });
    await page.poll(`(async()=>${KZ}.state.inventory.skipped?.count===3)()`);
    const downloads = path.join(E, 'downloads'); fs.mkdirSync(downloads);
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      await invoke('entry.navigate', { source: 'fake', file: name });
      await page.poll(`!!(${card(name)})?.querySelector('.media-box.ic-loaded img')?.naturalWidth`, 20000);
      await page.poll(`document.querySelector('#workspace .ws-name')?.title===${JSON.stringify(name)}`, 20000);
      const title = await page.evaluate(`(()=>{const el=(${card(name)}).querySelector('.ctitle .copyable');return {text:el.textContent,title:el.title,height:el.getBoundingClientRect().height};})()`);
      assert.equal(title.text, name.replace(/[\r\n\t\u2028\u2029]/g, ' ')); assert.equal(title.title, name + '\nCopy the image file name and folder path');
      assert(title.height > 0 && title.height < 30);
      await page.poll(`document.querySelector('#workspace .info-body')?.textContent.includes('LoadImage')`, 20000);
      await invoke('feed.filter', { value: name });
      await page.poll(`(async()=>${KZ}.state.view().length===1&&new URL(location.href).searchParams.get('filter')===${JSON.stringify(name)})()`);
      await invoke('feed.revealEntry', { id: 'fake:' + name });
      await page.poll(`(()=>{const image=(${card(name)})?.querySelector('.media-box.ic-loaded img'),root=document.querySelector('#candidatesCol');if(!image?.naturalWidth)return false;const a=image.getBoundingClientRect(),b=root.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;})()`, 20000);
      if (i === 0) await shot('listing-warning');
      await invoke('feed.filter', { value: '' });
      await invoke('feed.revealEntry', { id: 'fake:' + name });
      await page.poll(`!!(${card(name)})?.querySelector('.media-box.ic-loaded img')?.naturalWidth`, 20000);
      await page.evaluate(`(${card(name)}).querySelector('.favorite').click()`);
      await page.poll(`(async()=>(await (await fetch(${JSON.stringify(entry(name))})).json()).judgment?.favorite===true)()`);
      await page.evaluate(`(${card(name)}).querySelector('.download').click()`);
      const download = 'fake#' + name.split('/').at(-1).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      for (let n = 0; n < 200 && !fs.existsSync(path.join(downloads, download)); n++) await new Promise(resolve => setTimeout(resolve, 50));
      const bytes = Buffer.from(await (await fetch(B + entry(name) + '/bytes')).arrayBuffer());
      assert.deepEqual(fs.readFileSync(path.join(downloads, download)), bytes);
      // Open the actual native viewer on the exact resource, then return.
      await page.evaluate(`(${card(name)}).querySelector('img').click()`);
      await page.poll(`!!document.querySelector('#diff:not([hidden]) img')?.naturalWidth`, 20000);
      await invoke('workbench.close');
      await page.poll(`!document.querySelector('#diff:not([hidden])')`);
      await invoke('variations.open', { id: 'fake:' + name });
      await page.poll(`!!document.querySelector('[data-catalogue-id="1.image"]')`, 20000);
      await addParameter(page, '1.image'); await removeRecordedImage(page, '1.image');
      await openImageAdd(page); await page.clickAt('.vz-image-set .vz-input-trigger'); await waitForInputPicker(page);
      await page.clickAt('.vz-input-feeds [data-value="output"]');
      const option = `[...document.querySelectorAll('.vz-input-option')].find(el=>el.dataset.inputName===${JSON.stringify(name)})`;
      await page.poll(`!!(${option})`, 20000); await page.evaluate(`(${option}).click()`);
      await page.keyTrusted('Escape', { vk: 27 });
      await page.poll(`!document.querySelector('.vz-input-search')`);
      await page.poll(`document.querySelector('.vz-count')?.textContent==='1'`, 20000);
      const result = await invoke('variations.run');
      assert.equal(result.submitted, 1, JSON.stringify(result)); assert.equal(result.adopted, true, JSON.stringify(result));
      const job = (await (await fetch(F + '/__test/enqueues')).json()).at(-1).prompt;
      assert.equal(job['1'].inputs.image, name + ' [output]');
      assert(job['2'].inputs.filename_prefix.startsWith(name.slice(0, -4)));
      proof.push({ name, title, submitted: result.submitted, input: job['1'].inputs.image });
      await invoke('variations.close'); await page.poll(`!document.querySelector('.vz-panel')`);
      await page.evaluate(`(${card(name)}).querySelector('.delete').click()`);
      await page.poll(`!!document.querySelector('#confirmPanel')`, 10000);
      await page.clickAt('#confirmPanel .confirm-ok');
      await page.poll(`(async()=>!${KZ}.state.images.some(e=>e.filename===${JSON.stringify(name)}))()`, 20000);
    }
    await post(F, '/__test/activity', { listingRecords: { root: [], nested: [] } });
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
    await page.poll(`![...document.querySelectorAll('#statusStack .warning')].some(el=>el.textContent.includes('could not be listed'))`);
    await shot('listing-recovered');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(E, 'result.json'), JSON.stringify({ proof, errors }, null, 2));
    console.log(JSON.stringify({ names: proof.length, submitted: proof.length, skipped: 3, cleared: true, pageErrors: errors }));
  } catch (error) {
    fs.writeFileSync(path.join(E, 'failure.json'), JSON.stringify(await page.evaluate(`({body:document.body.innerText,options:[...document.querySelectorAll('.vz-input-option')].map(el=>el.dataset.inputName),errors:${JSON.stringify(errors)}})`), null, 2));
    await shot('listing-failure'); throw error;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
