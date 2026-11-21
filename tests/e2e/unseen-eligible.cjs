// Real selected/unselected source consumers, backed by the ordinary arrival stream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE;
const FAKE = process.env.E2E_FAKE;
const KZ = '(await import("/store/instance.js")).appStore';

async function run(page) {
  const records = [], prefix = 'eligible/' + require('node:crypto').randomUUID();
  const control = async body => {
    const response = await fetch(FAKE + '/__test/activity', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  };
  const owned = require('./owned-fixtures.cjs').fakeFixtures(FAKE,control);
  const invoke = (id,args={}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const vote = async (name,value) => {
    const response = await fetch(ENGINE+'/api/collections/another/entries/'+encodeURIComponent(name)+'/judgment',
      {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({vote:value})});
    assert.equal(response.status,200);
  };
  const select = source => page.evaluate(`(async()=>${KZ}.actions.hosts.select(${JSON.stringify(source)}))()`);
  const record = async (label,expected) => {
    await page.poll(`(async()=>${KZ}.state.sourceHasNew('another')===${expected})()`,20000);
    await invoke('source.menu.open');
    const result = await page.evaluate(`(async()=>{const s=${KZ},row=document.querySelector('.hostpick[data-source="another"]'),chip=document.querySelector('.pinned-source[data-source="another"]');
      return {source:s.state.sourceHasNew('another'),any:s.state.anySourceHasNew(),row:row.classList.contains('has-new'),chip:chip.classList.contains('has-new'),icon:document.querySelector('link[rel="icon"]').getAttribute('href')};})()`);
    for(const key of ['source','any','row','chip'])assert.equal(result[key],expected,label+' '+key);
    await invoke('source.menu.close');records.push({label,...result});console.log('ok '+label);
    return result;
  };
  await page.send('Emulation.setDeviceMetricsOverride',{width:1400,height:900,deviceScaleFactor:1,mobile:false});
  await page.goto(ENGINE+'/#another');
  await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading&&${KZ}.state.images.length>40)()`,20000);
  await page.evaluate(`(async()=>${KZ}.actions.hosts.patch('another',{pinned:true,autoRefresh:true}))()`);
  const original = await record('quiet-baseline',false);
  return owned.run(async()=>{
    await select('fake');
    const name=prefix+'/down.png';
    // Persist the judgment before inventory discovers the new output. No transient
    // eligible arrival is introduced merely to set up the hidden-arrival case.
    await vote(name,'down');
    await owned.publish([{name,fixture:'flux-basic.png',width:150,height:90,mtime:1}]);
    const response=await fetch(ENGINE+'/api/collections/another/entries?inventory=1&arrivals=items-v1');
    const inventory=await response.json(),seq=inventory.entries.find(e=>e.name===name).arrivalSeq;
    assert(inventory.arrivals.downVotedRanges.some(([a,b])=>a<=seq&&seq<=b));
    // A subsequent control toggle proves the stream delivered and retained raw
    // unseen facts, not just that the negative assertion raced publication.
    await invoke('preference.revealDown');await record('unselected-reveal-restores',true);
    await invoke('preference.revealDown');const hidden=await record('unselected-downvote-quiet',false);
    assert.equal(hidden.icon,original.icon);
    await select('another');
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
    await page.poll(`(async()=>${KZ}.state.images.some(e=>e.filename===${JSON.stringify(name)}))()`);
    await record('selected-downvote-quiet',false);
    assert.equal(await page.evaluate(`!!document.querySelector('.card[data-name="${name}"]')`),false);
    await invoke('preference.downvoteHides',{value:false});await record('selected-hiding-off-restores',true);
    await invoke('preference.downvoteHides',{value:true});await record('selected-hiding-on-quiet',false);
    await vote(name,'up');await record('upvote-restores-unexposed',true);
    await invoke('preference.hideUp');await record('hide-up-quiet',false);
    await invoke('preference.hideUp');await record('show-up-restores',true);
    await page.evaluate(`(async()=>${KZ}.actions.ui.refresh())()`);
    // Expose through the real feed once, then verify reveal does not resurrect it.
    await invoke('entry.navigate',{source:'another',file:name});
    await page.poll(`(async()=>!${KZ}.state.entryHasNew(${JSON.stringify('another:'+name)}))()`,20000);
    await record('exposure-clears',false);
    await invoke('preference.revealDown');await record('acknowledged-stays-quiet',false);
    await invoke('preference.revealDown');
    await select('fake');
    const normal=prefix+'/normal.png';
    await owned.publish([{name:normal,fixture:'flux-basic.png',width:150,height:90,mtime:1}]);
    await fetch(ENGINE+'/api/collections/another/entries?inventory=1&arrivals=items-v1');
    const active=await record('normal-unselected-arrival-marks',true);
    await page.poll(`document.querySelector('link[rel="icon"]').getAttribute('href')!==${JSON.stringify(original.icon)}`);
    assert(active.source);
    fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'eligible.json'),JSON.stringify(records,null,2));
    console.log('PASS '+records.length+' eligible attention consumer outcomes');
  });
}
module.exports={run};
if(require.main===module)(async()=>{
  const page=await CDP.launch(9355,{windowSize:'1600,1200'}),errors=await collectPageErrors(page);
  try{await run(page);assert.deepEqual(errors,[],'zero uncaught page errors');}
  finally{fs.writeFileSync(path.join(process.env.E2E_EVIDENCE,'page-errors.json'),JSON.stringify(errors,null,2));await page.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
