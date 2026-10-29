const assert = require('node:assert/strict');
module.exports = async ({ page, ENGINE, FAKE, KZ, check, capture }) => {
  const other = new URL(FAKE); other.port = String(Number(other.port) + 1);
  const control = async body => {
    const response = await fetch(other.origin + '/__test/activity', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.json();
  };
  const chip = '.pinned-source[data-source="another"]';
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
    await page.clickAt(chip);
    await page.poll(`(async()=>${KZ}.state.host()==='another'&&!${KZ}.state.inventory.loading)()`);
    await page.poll(`!document.querySelector('${chip}').classList.contains('has-new')`);
    check('new content: switching clears orange using only browser session state',true);
    await page.goto(ENGINE+'/#fixture-dir');
    await page.poll(`(async()=>${KZ}.state.sourceDelivery()==='ready'&&!${KZ}.state.inventory.loading)()`,20000);
    assert.equal(await page.evaluate(`document.querySelector('${chip}').classList.contains('has-new')`),false);
    check('new content: reload starts quiet with a fresh session baseline',true);
  } finally {
    await control({ reset: true, remove: ['arrival/new.png'] });
    await page.evaluate(`(async()=>{const s=${KZ};await s.actions.hosts.patch('another',{pinned:false,autoRefresh:false});await s.actions.hosts.select('fake');})()`);
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
};
