const assert = require('node:assert/strict');
module.exports = async ({ page, ENGINE, FAKE, KZ, check, capture }) => {
  const other = new URL(FAKE); other.port = String(Number(other.port) + 1);
  const control = async body => {
    const response = await fetch(other.origin + '/__test/activity', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.json();
  };
  const chip = '.pinned-source[data-source="another"]';
  const active = `window.railGlows.filter(x=>x.animation.playState==='running')`;
  const arrive = async (id, outputs) => {
    await control({ running: [id] });
    await page.poll(`(async()=>${KZ}.state.sourceActivity.another?.runningPromptId===${JSON.stringify(id)})()`,15000);
    await control({ running: [], finish: outputs.map(output => ({ id, width: 150, height: 90, ...output })) });
  };
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.diff.hide();s.actions.ui.setFilter('');
      await s.actions.hosts.patch('another',{pinned:true,autoRefresh:true});await s.actions.hosts.select('another');})()`);
    await page.poll(`(async()=>${KZ}.state.images.length>1&&!${KZ}.state.inventory.loading)()`);
    await page.evaluate(`(async()=>await ${KZ}.actions.hosts.select('fixture-dir'))()`);
    await capture(page, 'source-new-before');
    await control({ reset: true, running: ['arrival-job'] });
    await page.poll(`(async()=>${KZ}.state.sourceActivity.another?.runningPromptId==='arrival-job')()`,15000);
    await control({ running: [], finish: [{ id: 'arrival-job', output: 'arrival/new.png', width: 150, height: 90, mtime: 1 }] });
    await page.poll(`document.querySelector('${chip}')?.classList.contains('has-new')`,20000);
    await page.poll(`[...document.querySelector('${chip}').getAnimations()].every(a=>a.playState==='finished')`);
    const attention = await page.evaluate(`(()=>{const b=document.querySelector('${chip}');
      const probe=document.createElement('span');probe.style.color='var(--attention)';document.body.appendChild(probe);
      const expected=getComputedStyle(probe).color;probe.remove();
      return {color:getComputedStyle(b).color,expected,title:b.title,aria:b.getAttribute('aria-label'),on:b.classList.contains('on')};})()`);
    assert.equal(attention.color, attention.expected); assert.equal(attention.on, false);
    assert(attention.title.includes('New images.')); assert.equal(attention.title, attention.aria);
    check('new content: unselected-source arrival reaches orange pill and shared tooltip/aria',true);
    await capture(page, 'source-new-orange-pill');
    await page.clickAt('#hostBtn');
    await page.poll(`document.querySelector('.hostpick[data-source="another"]')?.classList.contains('has-new')`);
    await capture(page, 'source-new-picker');
    await page.clickAt('#hostBtn');
    await page.evaluate(`(()=>{window.railGlows=[];window.originalAnimate=Element.prototype.animate;
      Element.prototype.animate=function(...args){const animation=window.originalAnimate.apply(this,args);
        if(animation.id==='rail-arrival')window.railGlows.push({id:this.dataset.entryId,el:this,animation});
        return animation;};})()`);
    await page.clickAt(chip);
    await page.poll(`(async()=>${KZ}.state.host()==='another'&&!${KZ}.state.inventory.loading)()`);
    await page.poll(`!document.querySelector('${chip}').classList.contains('has-new')`);
    check('new content: switching clears orange using only browser session state',true);
    await page.poll(`${active}.length===1`);
    assert.deepEqual(await page.evaluate(`window.railGlows.map(x=>x.id)`),['another:arrival/new.png']);
    const geometry = await page.evaluate(`(()=>{const {el,animation}=window.railGlows[0];
      animation.pause();animation.currentTime=200;const r=el.getBoundingClientRect();
      return {width:r.width,height:r.height,x:r.x,y:r.y,duration:animation.effect.getTiming().duration,
        iterations:animation.effect.getTiming().iterations};})()`);
    assert.equal(geometry.duration,1400); assert.equal(geometry.iterations,1);
    await page.poll(`Array.from(document.querySelectorAll('.card img')).some(el=>el.complete&&el.naturalWidth>0)`,15000);
    await capture(page,'source-new-rail-mid-glow');
    const mid = await page.evaluate(`getComputedStyle(window.railGlows[0].el).backgroundColor`);
    await page.evaluate(`window.railGlows[0].animation.play()`);
    await page.poll(`${active}.length===0`);
    const end = await page.evaluate(`(()=>{const {el}=window.railGlows[0],s=getComputedStyle(el),r=el.getBoundingClientRect();
      const probe=document.createElement('span');probe.style.color=s.getPropertyValue('--card-color');
      document.body.appendChild(probe);const expected=getComputedStyle(probe).color;probe.remove();
      return {color:s.backgroundColor,expected,width:r.width,height:r.height,x:r.x,y:r.y};})()`);
    assert.notEqual(mid,end.color); assert.equal(end.color,end.expected);
    assert.deepEqual({width:end.width,height:end.height,x:end.x,y:end.y},
      {width:geometry.width,height:geometry.height,x:geometry.x,y:geometry.y});
    await capture(page,'source-new-rail-after-glow');
    check('rail glow: switching lights exactly the new tick once, fades to its treatment, with identical geometry',true);
    // Filter exclusion destroys/recreates its numeric tape node: consumed events cannot replay.
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('no-such-image');})()`);
    await page.poll(`document.querySelectorAll('.fr-tick').length===0`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter(''))()`);
    await page.poll(`!!document.querySelector('.fr-tick[data-entry-id="another:arrival/new.png"]')`);
    assert.equal(await page.evaluate(`window.railGlows.length`),1);
    check('rail glow: rerender and tick remount do not replay a consumed switch event',true);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 260, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.feed.restoreToIndex(s.state.entriesWithKnownSize()[0]);})()`);
    await page.poll(`document.querySelector('.fr-top').textContent==='1'`);
    await arrive('current-arrival', [{ output:'arrival/current.png',mtime:4102444800 }, { output:'arrival/off-tape.png',mtime:1 }]);
    await page.poll(`${active}.some(x=>x.id==='another:arrival/current.png')`,20000);
    await page.poll(`(async()=>${KZ}.state.images.some(x=>x.filename==='arrival/off-tape.png'))()`);
    await page.poll(`(async()=>{const s=${KZ};return s.state.entriesWithKnownSize().some(i=>s.state.images[i].filename==='arrival/off-tape.png');})()`,20000);
    assert.deepEqual(await page.evaluate(`window.railGlows.map(x=>x.id)`),['another:arrival/new.png','another:arrival/current.png']);
    assert.equal(await page.evaluate(`document.querySelector('${chip}').classList.contains('has-new')`),false);
    await page.evaluate(`(async()=>{const s=${KZ};const n=s.state.entriesWithKnownSize();s.actions.feed.restoreToIndex(n[n.length-1]);})()`);
    await page.poll(`!!document.querySelector('.fr-tick[data-entry-id="another:arrival/off-tape.png"]')`);
    assert.equal(await page.evaluate(`window.railGlows.length`),2);
    await page.poll(`${active}.length===0`);
    check('rail glow: current-source arrival lights only its on-tape tick; off-tape arrivals never play later; selected pill stays clear',true);

    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] });
    await arrive('reduced-arrival', [{ output:'arrival/reduced.png',mtime:4102444801 }]);
    await page.poll(`${active}.some(x=>x.id==='another:arrival/reduced.png')`,20000);
    const reduced = await page.evaluate(`(()=>{const x=window.railGlows.at(-1);return {
      keys:x.animation.effect.getKeyframes().flatMap(Object.keys),transform:getComputedStyle(x.el).transform};})()`);
    assert.equal(reduced.transform,'none');
    assert(reduced.keys.includes('backgroundColor'));
    assert(!reduced.keys.some(key=>['transform','width','height','boxShadow'].includes(key)));
    check('rail glow: reduced motion animates color alone, with no transform or size changes',true);
    await page.evaluate(`(async()=>{const s=${KZ};s.actions.ui.setFilter('no-such-image');})()`);
    await page.poll(`window.railGlows.at(-1).animation.playState==='idle'`);
    await page.evaluate(`(async()=>${KZ}.actions.ui.setFilter(''))()`);
    await page.poll(`!!document.querySelector('.fr-tick[data-entry-id="another:arrival/reduced.png"]')`);
    assert.equal(await page.evaluate(`window.railGlows.length`),3);
    check('rail glow: identity retirement cancels native animation and does not replay on return',true);
    await page.evaluate(`Element.prototype.animate=window.originalAnimate;delete window.originalAnimate;delete window.railGlows`);
    await page.goto(ENGINE+'/#fixture-dir');
    await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);
    assert.equal(await page.evaluate(`document.querySelector('${chip}').classList.contains('has-new')`),false);
    check('new content: reload starts quiet with a fresh session baseline',true);
  } finally {
    await page.evaluate(`(()=>{if(window.originalAnimate)Element.prototype.animate=window.originalAnimate;
      delete window.originalAnimate;delete window.railGlows;})()`);
    await page.send('Emulation.setEmulatedMedia', { features:[] });
    await control({ reset: true, remove: ['arrival/new.png','arrival/current.png','arrival/off-tape.png','arrival/reduced.png'] });
    await page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.patch('another',{pinned:false,autoRefresh:false});await s.actions.hosts.select('fake');})()`);
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
};
