// Actual input/blur/autosave, persisted engine judgments and field-local geometry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:19450';
const KZ = '(await import("/store/instance.js")).appStore';
const target = '.card[data-name="flux-basic.png"]';
const id = 'fixture-dir:flux-basic.png';

async function run({ page, evidence = process.env.E2E_EVIDENCE ?? workPath('artifacts/feedback-save-status'), baseline = false }) {
  fs.mkdirSync(evidence, { recursive: true });
  const records = [];
  const shot = async name => fs.writeFileSync(`${evidence}/${name}.png`, Buffer.from(
    (await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const input = async (sign, value, blur = false) => {
    await page.clickAt(`${target} textarea.${sign}`);
    await page.evaluate(`(() => { const t = document.activeElement; t.select(); })()`);
    await page.send('Input.insertText', { text: value });
    if (blur) await page.keyTrusted('Tab', { code: 'Tab', vk: 9 });
  };
  const shown = sign => `(() => { const s = document.querySelector('${target} textarea.${sign}')?.parentElement.querySelector('.note-save-status'); return !!s && s.textContent==='Feedback saved' && getComputedStyle(s).visibility === 'visible'; })()`;
  const saved = async (sign, value) => page.poll(`(async () => (await (await fetch('/api/collections/fixture-dir/entries/flux-basic.png')).json()).judgment?.notes?.${sign} === ${JSON.stringify(value)})()`);
  const geometry = () => page.evaluate(`(() => {
    const card = document.querySelector('${target}'), probe = document.querySelector('.card--probe');
    const box = el => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}; };
    return { card:box(card), foot:box(card.querySelector('.card-foot')), probe:box(probe.querySelector('.pair')),
      fields:[...card.querySelectorAll('.boxcol')].map(col => ({ col:box(col), text:box(col.querySelector('textarea')),
        row:box(col.querySelector('.note-actions') || col.querySelector('.btnrow')),
        buttons:box(col.querySelector('.btnrow')), buttonVisibility:getComputedStyle(col.querySelector('.btnrow')).visibility,
        status:col.querySelector('.note-save-status') ? box(col.querySelector('.note-save-status')) : null,
        color:col.querySelector('.note-save-status') ? getComputedStyle(col.querySelector('.note-save-status')).color : null })) };
  })()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.goto(ENGINE + '/#fixture-dir');
  await page.poll(`(async () => { const s=${KZ}; return s.state.host()==='fixture-dir' && !s.state.inventory.loading && s.state.entriesWithKnownSize().length>1; })()`, 20000);
  await page.evaluate(`(async () => { const s=${KZ}; s.actions.diff.hide(); s.actions.current.set('fixture-dir','flux-basic.png'); s.actions.feed.restoreToIndex(s.state.images.findIndex(x=>x.id===${JSON.stringify(id)})); })()`);
  await page.poll(`!!document.querySelector('${target} textarea.pos')`);
  // The live region must exist in the accessibility tree before its text changes.
  const { root } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: target + ' .note-save-status' });
  const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  assert(nodes.some(node => !node.ignored && node.role?.value === 'status'), 'empty save status is exposed before confirmation');
  await page.clickAt(target + ' textarea.pos');
  const initial = await geometry();
  await shot('before');
  for (const sign of ['pos', 'neg']) {
    const value = `feedback-${sign}-${baseline ? 'red' : 'green'}`;
    await input(sign, value, sign === 'neg');
    const draftGeometry = await geometry();
    await saved(sign, value);
    if (baseline) {
      await page.poll(`!!document.querySelector('${target} .saved.show')`);
      records.push(await page.evaluate(`(() => {const s=document.querySelector('${target} .saved.show');return {sign:${JSON.stringify(sign)},color:getComputedStyle(s).color,title:!!s.closest('.ctitle'),text:s.textContent};})()`));
      await shot(`baseline-${sign}`);
    } else {
      await page.poll(shown(sign));
      const g = await geometry(), f = g.fields[sign === 'neg' ? 0 : 1];
      assert.equal(f.color, sign === 'neg' ? 'rgb(255, 102, 102)' : 'rgb(158, 206, 106)');
      assert.equal(f.buttonVisibility, 'hidden');
      assert.deepEqual(f.row, f.buttons);
      assert(f.status.y >= f.text.bottom && f.status.x >= f.col.x && f.status.right <= f.col.right);
      assert(f.status.y >= f.row.y && f.status.bottom <= f.row.bottom);
      assert.equal(g.card.height, initial.card.height);
      assert.equal(g.foot.height, initial.foot.height);
      assert.equal(g.probe.height, initial.probe.height);
      assert.deepEqual(g.card,draftGeometry.card,'confirmation cannot jump or resize the card');
      assert.equal(await page.evaluate(`(() => { const b=document.querySelector('${target} textarea.${sign}').parentElement.querySelector('button');
        const r=b.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b; })()`),false,
        'hidden copy controls are not invisible click targets');
      assert.equal(await page.evaluate(`document.querySelectorAll('.card .note-actions.is-saved').length`), 1);
      await shot(`saved-${sign}`);
      records.push({sign,geometry:g});
      await page.poll(`!(${shown(sign)})`);
      assert.equal((await geometry()).fields[sign === 'neg' ? 0 : 1].buttonVisibility, 'visible');
    }
    await page.evaluate('new Promise(r=>setTimeout(r,1300))');
  }
  fs.writeFileSync(`${evidence}/geometry.json`, JSON.stringify({initial,records}, null, 2));
  if (baseline) {
    assert(records.every(r => r.title && r.color === 'rgb(158, 206, 106)'));
    assert.equal(await page.evaluate(`document.querySelectorAll('${target} .note-save-status').length`), 2,
      'regression: old product has one shared green title flash, not two field-local status rows');
  }
  if (!baseline) {
    // Inject only transport timing/failure, never confirmation state. Successful
    // requests still reach the isolated engine and its real SQLite judgment API.
    await page.evaluate(`(() => { const send=window.fetch.bind(window);
      window.feedbackTransport={mode:'pass',held:0,failed:0,flashes:0,holdFlashes:false,flashCallbacks:[]};
      const schedule=window.setTimeout.bind(window);
      window.setTimeout=(fn,ms,...args)=>{const t=window.feedbackTransport;if(ms===1200){t.flashes++;
        if(t.holdFlashes){const id=schedule(()=>{},60000);t.flashCallbacks.push({id,fn,args});return id;}}
        return schedule(fn,ms,...args);};
      window.fetch=async (...args) => { const t=window.feedbackTransport;
        if (String(args[0]).includes('/judgment') && args[1]?.method==='PATCH') {
          if(t.mode==='fail'){t.mode='pass';t.failed++;return new Response('fixture failure',{status:503});}
          if(t.mode==='hold'){t.mode='pass';t.held++;await new Promise(resolve=>t.release=resolve);}
        } return send(...args); };
    })()`);
    await page.evaluate(`feedbackTransport.mode='hold'`);
    await input('pos', 'slow older draft', true);
    await page.poll('feedbackTransport.held===1');
    await input('pos', 'newer draft');
    await page.evaluate('feedbackTransport.release()');
    await saved('pos', 'slow older draft');
    assert.equal(await page.evaluate(shown('pos')), false, 'old success cannot claim newer text');
    await page.keyTrusted('Tab', {code:'Tab',vk:9});
    await saved('pos', 'newer draft');
    await page.poll(shown('pos'));
    await page.clickAt(target+' .copyable');
    await page.poll(`!!document.querySelector('${target} .copyable.copied')`);
    assert.equal(await page.evaluate(shown('pos')), true, 'filename flash is independent');
    await page.poll(`!(${shown('pos')})`);

    await page.evaluate(`feedbackTransport.mode='fail'`);
    await input('neg','failed draft',true);
    await page.poll(`(async()=>feedbackTransport.failed===1 && ${KZ}.state.chips.some(c=>c.kind==='error'))()`);
    assert.equal(await page.evaluate(shown('neg')),false);
    assert.equal(await page.evaluate(`document.querySelector('${target} textarea.neg').value`),'failed draft');
    await page.clickAt(target+' textarea.neg');
    await page.keyTrusted('Tab',{code:'Tab',vk:9});
    await saved('neg','failed draft');
    await page.poll(shown('neg'));
    await page.poll(`!(${shown('neg')})`);
    await page.evaluate(`(async()=>{const s=${KZ}; for(const chip of s.state.chips.filter(c=>c.kind==='error'))s.actions.status.dismiss(chip.slot);})()`);

    await page.evaluate('feedbackTransport.holdFlashes=true');
    await input('pos','alternating positive',true);
    await page.poll(shown('pos'));
    await input('neg','alternating negative',true);
    await page.poll(shown('neg'));
    assert.equal(await page.evaluate(shown('pos')),true,'field acknowledgments are independent');
    await shot('both-fields');
    await input('pos','new edit clears positive');
    assert.equal(await page.evaluate(shown('pos')),false);
    assert.equal(await page.evaluate(shown('neg')),true);
    await page.keyTrusted('Tab',{code:'Tab',vk:9});
    await saved('pos','new edit clears positive');
    await page.evaluate('feedbackTransport.holdFlashes=false; for(const {id,fn,args} of feedbackTransport.flashCallbacks.splice(0)){clearTimeout(id);fn(...args)}');
    await page.poll(`!(${shown('pos')}) && !(${shown('neg')})`);

    await page.evaluate(`(async()=>{const s=${KZ}, order=s.state.folderView(), i=order.indexOf(s.state.imageIdxById().get('${id}'));
      const neighbor=s.state.images[order[i+1]]; if(!neighbor)throw Error('missing below neighbor');
      await s.handles.invoke('judgment.apply',{id:neighbor.id,intent:{type:'note',sign:'pos',text:'copied neighbor draft'}});})()`);
    await page.clickAt(target+' .note-actions.positive .btnrow button');
    await saved('pos','copied neighbor draft');
    await page.poll(shown('pos'));
    await page.poll(`!(${shown('pos')})`);

    await page.evaluate(`feedbackTransport.mode='hold'`);
    await input('pos','retired request',true);
    await page.poll('feedbackTransport.held===2');
    await page.evaluate(`window.feedbackRetired=document.querySelector('${target} textarea.pos'); feedbackTransport.beforeRetire=feedbackTransport.flashes`);
    await page.evaluate(`(async()=>${KZ}.actions.hosts.select('another'))()`);
    await page.poll('!feedbackRetired.isConnected');
    await page.evaluate('feedbackTransport.release()');
    await saved('pos','retired request');
    assert.equal(await page.evaluate('feedbackTransport.flashes'),await page.evaluate('feedbackTransport.beforeRetire'),
      'unmounted success cannot schedule an orphan flash');
    await page.evaluate(`(async()=>${KZ}.actions.hosts.select('fixture-dir'))()`);
    await page.poll(`!!document.querySelector('${target} textarea.pos')`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.card .note-actions.is-saved').length`),0,
      'retired callbacks cannot flash a replacement field');
    await page.poll(`(() => {const img=document.querySelector('${target} .imgwrap img'); return img?.complete && img.naturalWidth>0;})()`,20000);

    await page.send('Emulation.setDeviceMetricsOverride',{width:620,height:900,deviceScaleFactor:1,mobile:false});
    await page.clickAt(target+' textarea.neg');
    const narrow = await geometry();
    await input('neg','narrow negative',true);
    await saved('neg','narrow negative');
    await page.poll(shown('neg'));
    const g=await geometry(), f=g.fields[0];
    assert.equal(g.card.height,narrow.card.height);
    assert.equal(g.foot.height,narrow.foot.height);
    assert.equal(g.probe.height,narrow.probe.height);
    assert.equal(f.color,'rgb(255, 102, 102)');
    assert(f.status.x>=f.col.x && f.status.right<=f.col.right);
    assert(f.status.y>=f.row.y && f.status.bottom<=f.row.bottom);
    await shot('narrow-negative');
    records.push({name:'narrow',geometry:g});
    await page.poll(`!(${shown('neg')})`);
    fs.writeFileSync(`${evidence}/geometry.json`,JSON.stringify({initial,records,
      scenarios:['autosave','blur','slow-old/new-draft','failure/retry','filename-copy','alternating-fields','new-edit-clears','neighbor-copy','unmount/identity','narrow']},null,2));
  }
  return {input, shown, saved, geometry, shot, records};
}

module.exports = { run };
if (require.main === module) (async () => {
  const page = await CDP.launch(9357, {windowSize:'1600,1200'});
  const errors = await collectPageErrors(page);
  try { await run({page,baseline:process.argv.includes('red')}); assert.deepEqual(errors,[]); console.log('PASS feedback field input/persistence/geometry'); }
  finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
