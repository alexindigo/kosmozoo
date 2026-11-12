// Dialog lifetime observed through rendered controls and actual fake-backend jobs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { addParameter } = require('./variation-add-helpers.cjs');
module.exports = async ({ cdp, ENGINE, FAKE, KZ, check }) => {
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const dismiss = async () => {
    if (!await cdp.evaluate("!!document.querySelector('.vz-panel')")) return;
    await cdp.evaluate(`(async()=>{${KZ}.handles.invoke('variations.close');return true})()`);
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  const open = async (args = { id: 'fake:flux-controlnet.png' }) => {
    await invoke('variations.open', args);
    await cdp.poll("document.querySelectorAll('.vz-catalogue-row').length>0");
  };
  const type = async (selector, text) => {
    await cdp.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select()})()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const capture = async name => {
    if (!process.env.VS_CAPTURE) return;
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.VS_CAPTURE + '/' + name + '.png', Buffer.from(shot.data, 'base64'));
  };
  const jobs = async () => (await fetch(FAKE + '/__test/enqueues')).json();
  const selected = name => !process.env.VS_CASE || process.env.VS_CASE === name;
  try {
    await dismiss();
    await cdp.evaluate("(async()=>{for(const name of ['flux-controlnet.png','flux-basic.png'])await fetch('/api/collections/fake/entries/'+name+'/bytes')})()");
    if (selected('a')) {
      await open(); await type('.vz-prefix', 'discard-me');
      await cdp.clickAt('.vz-close'); await cdp.poll("!!document.querySelector('.vz-discard')");
      await cdp.clickAt('.vz-discard-confirm'); await cdp.poll("!document.querySelector('.vz-panel')");
      await open(); assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"), '');
      check('session a: Discard closes; reopening starts with fresh defaults', true); await dismiss();
    }
    if (selected('b')) {
      await open(); await type('.vz-prefix', 'keep-me');
      await cdp.keyTrusted('Escape', { vk: 27 }); await cdp.poll("!!document.querySelector('.vz-discard')");
      await capture('confirmation'); await cdp.clickAt('.vz-keep');
      await cdp.poll("!document.querySelector('.vz-discard')");
      assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"), 'keep-me');
      // Replacing an opening follows the very same decision; cancellation keeps A.
      await cdp.evaluate(`(async()=>{window.__vsReplace=${KZ}.handles.invoke('variations.open',{id:'fake:flux-basic.png'});return true})()`);
      await cdp.poll("!!document.querySelector('.vz-discard')"); await cdp.clickAt('.vz-keep');
      assert.equal((await cdp.evaluate('window.__vsReplace')).status, 'cancelled');
      assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"), 'keep-me');
      await cdp.evaluate(`(async()=>{window.__vsReplace=${KZ}.handles.invoke('variations.open',{id:'fake:flux-basic.png'});return true})()`);
      await cdp.poll("!!document.querySelector('.vz-discard')"); await cdp.clickAt('.vz-discard-confirm');
      assert.equal((await cdp.evaluate('window.__vsReplace')).status, 'applied');
      await cdp.poll("document.querySelectorAll('.vz-catalogue-row').length>0");
      assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"), '');
      check('session b: Keep editing preserves edits; replacement confirms once and starts fresh', true); await dismiss();
    }
    if (selected('c')) {
      await open(); await capture('single'); await cdp.clickAt('.vz-close');
      await cdp.poll("!document.querySelector('.vz-panel')");
      assert.equal(await cdp.evaluate("!!document.querySelector('.vz-discard')"), false);
      check('session c: clean draft closes without confirmation', true);
    }
    if (selected('d')) {
      await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
      await open(); await addParameter(cdp,'9.denoise'); await type('.vz-prefix', 'session-success_'); const before = (await jobs()).length;
      const result = await invoke('variations.run'); assert.equal(result.adopted, true);
      const submitted = (await jobs()).slice(before); assert(submitted.length > 0);
      assert(submitted.every(job => Object.values(job.prompt).some(node => node.class_type === 'SaveImage' && node.inputs.filename_prefix.startsWith('session-success_'))));
      await cdp.poll("!document.querySelector('.vz-panel')", 6000); await open();
      assert.equal(await cdp.evaluate("document.querySelector('.vz-prefix').value"), '');
      check('session d: successful actual Run closes and reopening has fresh defaults', true); await dismiss();
    }
    if (selected('e')) {
      for (const mode of ['failed', 'partial', 'uncertain']) {
        await open(); await addParameter(cdp,'9.denoise'); await type('.vz-prefix', 'keep-after-' + mode);
        await type('.vz-slider-row[data-param-key="9.denoise"] .vz-row-inc-input', '1e-1');
        const before = await cdp.evaluate("[document.querySelector('.vz-prefix').value,document.querySelector('.vz-suffix').value,document.querySelector('.vz-row-inc-input').value]");
        await cdp.evaluate(`(()=>{window.__vsFetch=window.fetch;window.__vsCalls=0;window.fetch=(url,options)=>{if(!String(url).includes('/features/variations/run'))return window.__vsFetch(url,options);window.__vsCalls++;${mode === 'uncertain' ? "return Promise.reject(new Error('lost response'))" : `return Promise.resolve(new Response(JSON.stringify(${JSON.stringify(mode === 'partial' ? { submitted: 1, total: 3, errors: [{ error: 'partial result' }] } : { error: 'forced failure' })}),{status:${mode === 'partial' ? 200 : 500}}))`}}})()`);
        try {
          const result = await invoke('variations.run'); assert.equal(result.adopted, false);
          assert.deepEqual(await cdp.evaluate("[document.querySelector('.vz-prefix').value,document.querySelector('.vz-suffix').value,document.querySelector('.vz-row-inc-input').value]"), before);
          assert(await cdp.evaluate("document.querySelector('.vz-error').textContent.length>0"));
          await new Promise(resolve => setTimeout(resolve, 3200));
          assert(await cdp.evaluate("!!document.querySelector('.vz-panel')&&window.__vsCalls===1"));
          check('session e: ' + mode + ' Run preserves exact draft, result text and no retry', true);
        } finally { await cdp.evaluate('window.fetch=window.__vsFetch'); await dismiss(); }
      }
    }
    if (selected('f')) {
      await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
      await open({ ids: ['fake:flux-controlnet.png', 'fake:flux-basic.png'], bulk: true });
      await addParameter(cdp,'9.denoise');
      assert(await cdp.evaluate("document.querySelector('.vz-title').textContent.includes('applying to 2 images')"));
      await type('.vz-prefix', 'session-bulk_'); await capture('bulk'); const before = (await jobs()).length;
      const result = await invoke('variations.run'); assert.equal(result.adopted, true);
      const submitted = (await jobs()).slice(before); assert.equal(submitted.length, result.submitted);
      assert.deepEqual([...new Set(submitted.map(job => job.extra_data.extra_pnginfo.kz.source))].sort(), ['fake:flux-basic.png', 'fake:flux-controlnet.png']);
      assert(submitted.every(job => Object.values(job.prompt).some(node => node.class_type === 'SaveImage' && node.inputs.filename_prefix.startsWith('session-bulk_'))));
      await cdp.poll("!document.querySelector('.vz-panel')", 6000);
      check('session f: one bulk draft reaches both actual target graphs', true);
    }
    if (selected('g')) {
      // Recreate a source to exercise the old-origin state that exposed the controls.
      const name = 'session-owner', address = new URL(FAKE).host;
      const create = () => fetch(ENGINE + '/api/collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, address }) });
      try {
        assert((await create()).ok); await cdp.poll(`(async()=>!!${KZ}.state.hosts['session-owner'])()`);
        await cdp.evaluate("(async()=>{await fetch('/api/collections/session-owner/entries/flux-controlnet.png/bytes')})()");
        await open({ id: name + ':flux-controlnet.png' }); await dismiss();
        const incarnation = await cdp.evaluate(`(async()=>${KZ}.state.hosts['session-owner'].sourceVersion.incarnation)()`);
        assert((await fetch(ENGINE + '/api/collections/' + name, { method: 'DELETE' })).ok); assert((await create()).ok);
        await cdp.poll(`(async()=>!!${KZ}.state.hosts['session-owner']&&${KZ}.state.hosts['session-owner'].sourceVersion.incarnation!==${JSON.stringify(incarnation)})()`);
        await cdp.evaluate("(async()=>{await fetch('/api/collections/session-owner/entries/flux-controlnet.png/bytes')})()");
        await invoke('variations.open', { id: name + ':flux-controlnet.png' });
        await cdp.poll("document.querySelectorAll('.vz-catalogue-row').length>0||!!document.querySelector('.vz-workspace-new')");
        assert(await cdp.evaluate("!document.querySelector('.vz-workspace,.vz-workspace-new,.vz-retained-values,.vz-workspace-status')&&!document.querySelector('[aria-label=\"Recipe workspace\"]')&&!document.querySelector('.vz-panel').textContent.includes('New recipe')"));
        check('session g: no recipe switcher, new-recipe action or old-origin mode after source replacement', true);
      } finally { await dismiss(); await fetch(ENGINE + '/api/collections/' + name, { method: 'DELETE' }); }
    }
  } finally {
    await dismiss();
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: false }) });
  }
};
