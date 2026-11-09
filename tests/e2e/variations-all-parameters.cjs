const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');
const { captureReviewRegions } = require('./variation-capture-helpers.cjs');
const ENGINE = process.env.E2E_ENGINE, FAKE = process.env.E2E_FAKE, E = process.env.E2E_EVIDENCE;
const KZ = `(await import('/store/instance.js')).appStore`;
(async () => {
  const cdp = await CDP.launch(19454, { windowSize: '1600,1000' }), errors = await collectPageErrors(cdp);
  const write = async (selector, text) => {
    await cdp.clickAt(selector); await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const shot = async name => { const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${E}/${name}.png`, Buffer.from(data, 'base64')); await captureReviewRegions(cdp, E, name); };
  const candidate = id => `[data-candidate-id="92:105.${id}"]`;
  try {
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
    await cdp.goto(ENGINE + '/#fake#allparams_00001_.png');
    console.log('STEP page loaded');
    await cdp.poll('!!document.querySelector(".card .variations")', 20000);
    if (process.env.E2E_VARIATIONS_CASE === 'protections') {
      await require('./variations-raw-protections.cjs')({ cdp, errors, ENGINE, FAKE, E, KZ, write, shot });
      return;
    }
    await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/allparams_00001_.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:allparams_00001_.png'})})()`);
    await cdp.poll('document.querySelectorAll(".vz-catalogue-row").length===17');
    console.log('STEP complete catalogue opened');
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter").length'), 0);
    assert.equal(await cdp.evaluate('document.querySelector(".vz-suffix").value'), '');
    await shot('empty');
    console.log('STEP empty screenshot');
    // Keyboard transfer and public focus port, then exact invalid buffer retention.
    await cdp.evaluate('document.querySelector("[data-catalogue-id=\\"92:105.object\\"] button").focus()');
    await cdp.keyTrusted(' ', { code: 'Space', vk: 32 });
    console.log('KEYBOARD_TRANSFER', await cdp.evaluate('({panels:document.querySelectorAll(".vz-parameter").length,active:document.activeElement.outerHTML})'));
    await cdp.poll('document.activeElement.matches(".vz-parameter-name")');
    await write(candidate('object') + ' textarea', '{ "unfinished":');
    await cdp.clickAt('.vz-run');
    await cdp.poll('document.querySelector(".vz-error").textContent.includes("complete JSON")');
    assert.equal((await (await fetch(FAKE + '/__test/enqueues')).json()).length, 0);
    await shot('invalid-json');
    await cdp.clickAt(candidate('object') + ' .checkbox');
    await addParameter(cdp, '92:105.object');
    assert.equal(await cdp.evaluate(`document.querySelector('${candidate('object')} textarea').value`), '{ "unfinished":');
    await write(candidate('object') + ' textarea', '{"nested":[false,null,9007199254740993]}');
    await write('.vz-suffix', '_manual_{92:105.flag}');
    for (const id of ['flag', 'nullable', 'array', 'wrapped', 'choice', 'connection', 'unknown', 'seed', 'text']) await addParameter(cdp, `92:105.${id}`);
    await addParameter(cdp, '94.filename_prefix');
    await write('[data-text-id="94.filename_prefix"] textarea', 'selected');
    await write('[data-text-id="92:105.text"] textarea', '  exact\n\ntext  ');
    await write(candidate('nullable') + ' textarea', 'null');
    await write(candidate('unknown') + ' textarea', '{}');
    await write(candidate('array') + ' textarea', '[false,null,18446744073709551615]');
    await write(candidate('wrapped') + ' textarea', '{"__value__":[true,null,0]}');
    await cdp.clickAt(candidate('flag') + ' .vz-typed-options label:nth-child(1) input');
    // Both booleans selected: two actual assignments; false is not a missing value.
    await cdp.clickAt(candidate('choice') + ' .vz-typed-options label:nth-child(3) input');
    await cdp.clickAt(candidate('choice') + ' .vz-typed-options label:nth-child(4) input');
    await write(candidate('connection') + ' input[type=text]', '');
    assert.equal(await cdp.evaluate(`document.querySelector('${candidate('connection')} input[type=text]').value`), '');
    await write(candidate('connection') + ' input[type=text]', '0');
    const seed = '[data-param-key="92:105.seed"]';
    assert.equal(await cdp.evaluate(`document.querySelectorAll('${seed} [role=slider]').length`), 0);
    await cdp.clickAt(seed + ' .mode-switch button:last-child');
    await cdp.poll(`!!document.querySelector('${seed} .vz-value-field input')`);
    await write(seed + ' .vz-value-field input', '18446744073709551614');
    assert.equal(await cdp.evaluate(`document.querySelector('${seed} .vz-value-field input').value`),'18446744073709551614');
    await write('.vz-prefix', 'manual_');
    const expectedSuffix = '_manual_{92:105.flag}';
    assert.equal(await cdp.evaluate('document.querySelector(".vz-suffix").value'), expectedSuffix);
    await write('.vz-field-filter input', 'nothing-matches');
    assert.equal(await cdp.evaluate('document.querySelectorAll(".vz-parameter").length'), 11);
    await write('.vz-field-filter input', '');
    await cdp.poll('document.querySelector(".vz-count").textContent==="2"');
    const example = await cdp.evaluate('document.querySelector(".vz-output-example").textContent');
    assert(example.startsWith('manual_selected_manual_')); assert(!example.includes('18446744073709551614'));
    await shot('typed-editors');
    for (const [name, id] of [['typed-options','choice'],['typed-containers','object'],['typed-exact-number','seed']]) {
      await cdp.evaluate(`document.querySelector(${JSON.stringify(candidate(id).replace('data-candidate-id', id === 'seed' ? 'data-param-key' : 'data-candidate-id'))}).scrollIntoView({block:'center',inline:'nearest'})`);
      await shot(name);
    }
    const geometry = [];
    for (const [width, height] of [[1600,1000],[1024,768],[768,600],[500,700],[360,640],[1024,360]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate('document.querySelector(".vz-suffix").focus()');
      await cdp.keyTrusted('Tab', { vk: 9 });
      assert(await cdp.evaluate('document.activeElement.matches(".vz-run")'));
      const frame = await cdp.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
        const r=s=>document.querySelector(s).getBoundingClientRect(), viewport=r('.vz-body-scroll'), catalogue=r('.vz-catalogue'), center=r('.vz-left'), side=r('.vz-right'),run=r('.vz-run');
        const labels=[...document.querySelectorAll('.vz-panel label')].filter(el=>el.getClientRects().length);
        resolve({width:innerWidth,height:innerHeight,viewport:viewport.toJSON(),catalogue:catalogue.toJSON(),center:center.toJSON(),side:side.toJSON(),run:run.toJSON(),
          overflow:document.querySelector('.vz-body-scroll').scrollWidth-document.querySelector('.vz-body-scroll').clientWidth,
          labels:labels.every(el=>getComputedStyle(el).whiteSpace==='nowrap'),
          scrolls:['.vz-catalogue-list','.vz-sliders','.vz-sidebar-body'].map(s=>getComputedStyle(document.querySelector(s)).overflowY)});
      })))`);
      console.log('GEOMETRY', JSON.stringify(frame));
      await shot(`layout-${width}x${height}`);
      assert(frame.catalogue.right < frame.center.left && frame.center.right < frame.side.left);
      assert(frame.run.left >= frame.viewport.left - 1 && frame.run.right <= frame.viewport.right + 1);
      assert(frame.run.bottom <= frame.viewport.bottom + 1 && frame.run.top >= frame.viewport.top);
      assert(frame.labels && frame.scrolls.every(value => value === 'auto'));
      if (width >= 1024) assert(frame.overflow <= 1);
      geometry.push(frame); await shot(`layout-${width}x${height}`);
    }
    fs.writeFileSync(`${E}/geometry.json`, JSON.stringify(geometry, null, 2));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1600,height:1000,deviceScaleFactor:1,mobile:false });
    await cdp.evaluate('document.querySelector(".vz-body-scroll").scrollLeft=0');
    // Capture the actual immutable request/result while using the normal Run path.
    await cdp.evaluate(`(()=>{const original=window.fetch;window.__requests=[];window.__responses=[];window.fetch=async(url,options)=>{
      if(String(url).includes('/features/variations/run'))window.__requests.push(options.body);
      const response=await original(url,options);if(String(url).includes('/features/variations/run'))window.__responses.push(await response.clone().text());return response;};})()`);
    await cdp.clickAt('.vz-run');
    await cdp.poll('document.querySelector(".vz-queued")?.textContent==="Queued 2 of 2 jobs"',20000);
    const result = await cdp.evaluate('({requests:window.__requests,responses:window.__responses,text:document.querySelector(".vz-messages").textContent,suffix:document.querySelector(".vz-suffix").value})');
    assert.equal(result.suffix, expectedSuffix); assert(!result.text.includes('kept'));
    fs.writeFileSync(`${E}/http-consumer.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${E}/request.json`, result.requests[0]); fs.writeFileSync(`${E}/response.json`, result.responses[0]);
    await shot('queued');
    assert.deepEqual(errors, []);
    console.log('PASS complete empty catalogue, keyboard transfer, raw retention, all typed controls, manual naming, exact uint64, six layouts and actual Run 2/2');
  } finally { if(errors.length)console.error(errors); await cdp.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
