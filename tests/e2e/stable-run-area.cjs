// Observe the real editor's entire summary geometry across naming, admission
// and submission states. No private editor state or fabricated status nodes.
const assert = require('node:assert/strict'), fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter, settledCount } = require('./variation-add-helpers.cjs');
const B = process.env.E2E_ENGINE, F = process.env.E2E_FAKE, D = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
const request = async (path, body) => {
  const r = await fetch(F + path, body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert(r.ok, `${path}: ${r.status}`); return r.json();
};
const selectors = {sidebar:'.vz-right',body:'.vz-sidebar-body',count:'.vz-count-group',number:'.vz-count',time:'.vz-time-value',breakdown:'.vz-count-sub',naming:'.vz-naming-group',example:'.vz-output-preview',status:'.vz-messages',run:'.vz-run-slot'};
(async () => {
  fs.mkdirSync(D, {recursive:true});
  const info = await request('/api/object_info');
  info.StableNode = {input:{required:{steps:['INT',{min:0,max:100}]},optional:{choice:[['a','b','c'],{}]}},output:['IMAGE']};
  await request('/__test/activity', {objectInfo:info,captureEnqueue:true,publish:['ready','leftover'].map(name=>({name:`stable/${name}.png`,graph:{
    n:{class_type:'StableNode',inputs:name==='ready'?{choice:'a',steps:20}:{steps:20}},save:{class_type:'SaveImage',inputs:{images:['n',0],filename_prefix:`stable/${name}`}},
  }}))});
  await request('/__ordered', {delay:4000});
  const c = await CDP.launch(19893, {windowSize:'1400,900'}), errors = await collectPageErrors(c);
  const invoke = (id,args={}) => c.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const samples = [], failures = [];
  const settle = () => c.evaluate(`new Promise(resolve=>setTimeout(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve)),500))`);
  const sample = async (state, baseline) => {
    await settle();
    // Native focus scrolls a short sidebar. Compare its content coordinates,
    // without mistaking deliberate scroll travel for input-driven reflow.
    const value = await c.evaluate(`(()=>{const selectors=${JSON.stringify(selectors)},boxes={},scroll=document.querySelector('.vz-sidebar-body').scrollTop;for(const [name,s] of Object.entries(selectors)){const r=document.querySelector(s)?.getBoundingClientRect();boxes[name]=r?{x:r.x,y:r.y+(['sidebar','body','status','run'].includes(name)?0:scroll),width:r.width,height:r.height}:null}const r=document.querySelector('.vz-run')?.getBoundingClientRect();return {boxes,button:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,text:document.querySelector('.vz-messages').textContent,progress:document.querySelector('.vz-submitting')?.textContent}})()`);
    samples.push({state,...value});
    console.log(state);
    if (baseline) {
      for (const name of Object.keys(selectors)) {
        const before=baseline.boxes[name],after=value.boxes[name];
        if (!before || !after || Object.keys(before).some(key=>Math.abs(before[key]-after[key])>.5)) failures.push({state,name,before,after});
      }
      const before=baseline.button,after=value.button;
      if (before && after && Object.keys(before).some(key=>Math.abs(before[key]-after[key])>.5)) failures.push({state,name:'button',before,after});
    }
    fs.writeFileSync(D+'/geometry.json',JSON.stringify({tolerance:.5,samples,failures,pageErrors:errors},null,2));
    return value;
  };
  const field = async (selector,value) => {
    await c.clickAt(selector);
    await c.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await c.send('Input.insertText',{text:value});
  };
  const closeDraft = async () => {
    await c.evaluate(`(async()=>{window.stableClose=${KZ}.handles.invoke('variations.close');return true})()`);
    await c.poll(`!!document.querySelector('.vz-discard-confirm')`,10000);
    await c.clickAt('.vz-discard-confirm');
    await c.poll(`!document.querySelector('.vz-panel')`,10000);
  };
  const shot = async name => {
    const image=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${D}/${name}.png`,Buffer.from(image.data,'base64'));
    for(const [region,s] of Object.entries({header:'.vz-header',catalogue:'.vz-catalogue',editor:'.vz-left',summary:'.vz-right',batch:'.vz-batch'})){
      const clip=await c.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(s)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`);
      const crop=await c.send('Page.captureScreenshot',{format:'png',clip});fs.writeFileSync(`${D}/review-${name}-${region}.png`,Buffer.from(crop.data,'base64'));
    }
  };
  try {
    for(const [width,height] of [[1400,900],[900,600],[900,420]]) {
      await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await c.goto(B+'/#fake#stable%2Fready.png');
      await c.poll(`(async()=>${KZ}.state.images.some(i=>i.filename==='stable/leftover.png'))()`,20000);
      await invoke('variations.open',{ids:['fake:stable/ready.png','fake:stable/leftover.png'],bulk:true});
      await settledCount(c, '0', { and: `document.querySelectorAll('.vz-catalogue-row').length>0`, timeout: 20000 });
      const baseline=await sample(`${width}x${height}:zero`);
      await addParameter(c,'n.choice');
      await c.clickAt('[data-enum-id="n.choice"] .vz-enum-opt:nth-child(2)');
      await c.clickAt('[data-enum-id="n.choice"] .vz-enum-opt:nth-child(3)');
      await settledCount(c, '2', { and: `!document.querySelector('.vz-run').disabled`, timeout: 20000 });
      await sample(`${width}:ready-leftover`,baseline);
      if(width===1400) await shot('variations-run-area-short');
      // Destination reads produce the real failed/Retry and conflict states.
      await c.evaluate(`(()=>{const original=window.fetch;window.fetch=(url,options)=>{if(String(url).includes('/probe/')&&String(url).includes('destination=')){window.fetch=original;return Promise.resolve(new Response(JSON.stringify({error:'The destination catalogue could not be read. Try again when the host is reachable.'}),{status:502,headers:{'Content-Type':'application/json'}}));}return original(url,options)}})()`);
      const choose = host => c.evaluate(`(()=>{const e=document.querySelector('.vz-run-on-select');e.value=${JSON.stringify(host)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await choose('another');
      await c.poll(`!!document.querySelector('.vz-catalogue-retry')`,20000);
      await sample(`${width}:failed-retry`,baseline);
      if (!failures.length) assert(await c.evaluate(`(()=>{const s=document.querySelector('.vz-messages'),t=s.querySelector('.vz-message-content');return t.scrollHeight>t.clientHeight&&s.title.includes(t.textContent)&&s.getAttribute('aria-live')==='polite'})()`),'long status is clamped, with complete text retained for hints and assistive technology');
      if(width===1400) await shot('variations-run-area-long');
      await c.clickAt('.vz-catalogue-retry');
      await c.poll(`!document.querySelector('.vz-catalogue-retry')&&!!document.querySelector('.vz-conflict')&&document.querySelector('.vz-run').disabled`,20000);
      await sample(`${width}:destination-conflict`,baseline);
      await choose('fake');
      await settledCount(c, '2', { and: `!document.querySelector('.vz-run').disabled`, timeout: 20000 });
      for(const selector of ['.vz-prefix','.vz-suffix']) {
        for(const value of ['x','a longer name with spaces '.repeat(3),'very long name with spaces '.repeat(40),'{missing}']) {
          await field(selector,value);
          await sample(`${width}:${selector}:${value.length}:${value[0]}`,baseline);
        }
        await field(selector,'');
      }
      await c.poll(`!document.querySelector('.vz-run').disabled`,20000);
      await c.evaluate(`(async()=>{window.stableRun=${KZ}.handles.invoke('variations.run');return true})()`);
      await c.poll(`document.querySelector('.vz-submitting')?.textContent.includes('Submitting')`,20000);
      await sample(`${width}:submitting`,baseline);
      const result=await c.evaluate(`window.stableRun`);
      assert.equal(result.submitted,2,JSON.stringify(result));assert.equal(result.adopted,false);
      await c.poll(`!!document.querySelector('.vz-run')&&document.querySelectorAll('.vz-batch-problem').length===1`,20000);
      const final=await sample(`${width}:result-leftover`,baseline);
      assert.match(final.text,/2 confirmed, 0 partial, 0 unknown, 0 unsent; 2 sent/);
      if(width===1400) await shot('variations-run-area-result');
      // Every clamped message remains in the DOM and in the full-text hint.
      if (!failures.length) assert(await c.evaluate(`(()=>{const s=document.querySelector('.vz-messages');return s.getAttribute('aria-live')==='polite'&&s.title.includes(s.querySelector('.vz-error').textContent)})()`));
      fs.writeFileSync(D+'/geometry.json',JSON.stringify({tolerance:.5,samples,failures,pageErrors:errors},null,2));
      await closeDraft();
      // Single-target invalid raw input must also stay inside the same tracks;
      // mixed-cohort summaries intentionally aggregate target-specific problems.
      await invoke('variations.open',{id:'fake:stable/ready.png'});
      await settledCount(c, '0', { and: `document.querySelectorAll('.vz-catalogue-row').length>0`, timeout: 20000 });
      const single=await sample(`${width}:single-zero`);
      await addParameter(c,'n.choice');
      await c.clickAt('[data-enum-id="n.choice"] .vz-enum-opt:nth-child(2)');
      await settledCount(c, '1', { and: `!document.querySelector('.vz-run').disabled`, timeout: 20000 });
      await sample(`${width}:single-ready`,single);
      await addParameter(c,'n.steps');
      await c.clickAt('[data-param-key="n.steps"] .mode-switch button[title="Value"]');
      await field('[data-param-key="n.steps"] .vz-value-field input','-');
      await settledCount(c, '--', { and: `document.querySelector('.vz-run').disabled`, timeout: 20000 });
      const invalid=await sample(`${width}:invalid-numeric`,single);
      assert(invalid.text.length>0,'invalid raw input has an explanatory status');
      await closeDraft();
    }
    fs.writeFileSync(D+'/geometry.json',JSON.stringify({tolerance:.5,samples,failures,pageErrors:errors},null,2));
    assert.deepEqual(errors,[]);assert.deepEqual(failures,[],'summary rows and Run allocation must not depend on text/state');
    console.log(JSON.stringify({samples:samples.length,failures:failures.length,pageErrors:errors}));
  } finally { await c.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
