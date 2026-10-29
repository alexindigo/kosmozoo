// Recorded stock ComfyUI -> native socket -> engine stream -> rendered instrument.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { workPath } = require('./paths.cjs');
module.exports = async ({ page, FAKE, KZ, check, capture, control }) => {
  const fixture = JSON.parse(fs.readFileSync(workPath('tests/fixtures/workflow-progress.json'), 'utf8'));
  const data = fixture.cases['broadcast-batch'];
  const state = data.messages.find(m => m.type === 'progress_state' && m.data.nodes['5']?.value === 14);
  const step = data.messages.find(m => m.type === 'progress' && m.data.value === 14);
  const id = state.data.prompt_id;
  const selector = '.pinned-source[data-source="workflow"] .source-progress';
  const read = () => page.evaluate(`(() => {
    const svg = document.querySelector('${selector}'), arc = svg.querySelector('.source-progress-workflow');
    return { state: svg.dataset.state, inner: svg.dataset.fraction, outer: svg.dataset.workflowFraction,
      label: svg.getAttribute('aria-label'), title: svg.querySelector('title').textContent,
      dash: arc?.getAttribute('stroke-dasharray'), unavailable: arc?.classList.contains('unavailable'),
      animation: arc && getComputedStyle(arc).animationName,
      duration: arc && getComputedStyle(arc).animationDuration,
      easing: arc && getComputedStyle(arc).animationTimingFunction,
      colour: arc && getComputedStyle(arc).stroke,
      fill: !!svg.querySelector('.source-progress-fill'), track: !!svg.querySelector('.source-progress-track') };
  })()`);
  const geometry = () => page.evaluate(`(() => {
    const svg = document.querySelector('${selector}'), row = svg.parentElement, text = row.querySelector('span');
    const rect = svg.getBoundingClientRect(), label = text.getBoundingClientRect();
    const circles = [...svg.querySelectorAll('circle')].map(c => {
      const point = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(c.getScreenCTM());
      return { x: point.x, y: point.y, radius: c.r.baseVal.value };
    });
    return { width: rect.width, height: rect.height, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      textY: label.y + label.height / 2, gap: label.left - rect.right, circles };
  })()`);
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await control({ reset: true, objectInfoByHost: { '127.0.0.3': fixture.objectInfo } });
    // A fresh address has no earlier test's cached object_info catalogue.
    await page.evaluate(`(async () => {
      const s = ${KZ}; await s.actions.hosts.add('workflow', '127.0.0.3:${new URL(FAKE).port}');
      await s.actions.hosts.patch('workflow', { pinned: true, autoRefresh: false });
    })()`);
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'idle'`, 15000);
    assert.equal((await read()).track, false);
    check('workflow: idle has no outer arc or track', !(await read()).dash);
    await control({ running: [id], prompts: { [id]: { graph: data.graph, outputs: data.outputs } } });
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'running'`, 15000);
    await control({ messages: [state, step] });
    await page.poll(`document.querySelector('${selector}')?.dataset.workflowFraction === '0.6875'`);
    const known = await read();
    assert.equal(known.inner, '0.4375'); assert.equal(known.dash, '0.6875 1');
    assert.equal(known.unavailable, false); assert.equal(known.animation, 'none');
    assert.equal(known.label, 'workflow: workflow about 3 of 5 steps · current step 14/32 (live)');
    assert.equal(known.title, known.label);
    check('workflow: recorded 14/32 reaches distinct inner sector and 3.4375/5 outer arc with approximate/live wording', true, JSON.stringify(known));
    for (const width of [1400, 900]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const g = await geometry();
      assert.equal(g.width, 24); assert.equal(g.height, 24); assert.equal(g.gap, 5);
      assert(Math.abs(g.y - g.textY) < .5);
      for (const c of g.circles) { assert(Math.abs(c.x - g.x) < .01); assert(Math.abs(c.y - g.y) < .01); }
      assert(g.circles.some(c => c.radius === 14) && g.circles.some(c => c.radius === 9));
      check(`workflow: concentric circles and source-label centreline at ${width}px`, true, JSON.stringify(g));
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await capture(page, 'workflow-recorded-exact');
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))`);
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'disconnected'`);
    const lost = await read(); assert.equal(lost.fill, false); assert.equal(lost.track, false); assert.equal(lost.dash, undefined);
    assert(lost.label.includes('delivery disconnected; cached upstream running'));
    check('workflow: delivery loss withholds both cached measures', true);
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await page.poll(`document.querySelector('${selector}')?.dataset.workflowFraction === '0.6875'`);
    await control({ closeSockets: true });
    await page.poll(`document.querySelector('${selector} .source-progress-workflow.unavailable') !== null`);
    const unavailable = await read();
    assert.equal(unavailable.state, 'running'); assert.equal(unavailable.dash, '0.5 1');
    assert.equal(unavailable.duration, '2.5s'); assert.equal(unavailable.easing, 'linear');
    assert(!unavailable.label.includes('another ComfyUI tab'));
    const before = await page.evaluate(`getComputedStyle(document.querySelector('${selector} .unavailable')).transform`);
    await page.poll(`getComputedStyle(document.querySelector('${selector} .unavailable')).transform !== ${JSON.stringify(before)}`);
    const muted = await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--foreground-dim').trim()`);
    assert(muted); assert.notEqual(unavailable.colour, known.colour);
    check('workflow: upstream socket loss leaves running state and a muted rotating half arc with generic reason', true, JSON.stringify(unavailable));
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal((await read()).animation, 'none');
    check('workflow: reduced motion freezes unavailable arc', true);
    await capture(page, 'workflow-recorded-unavailable-reduced');
    const other = 'workflow-other-client';
    await control({ running: [other], prompts: { [other]: { graph: data.graph, outputs: data.outputs, clientId: 'other-tab' } }, logs: [{ t: 1, m: '0/30\r' }] });
    await page.poll(`document.querySelector('${selector}')?.getAttribute('aria-label').includes('another ComfyUI tab')`, 15000);
    await control({ appendLogs: [{ t: 2, m: '12/30\r' }] });
    await page.poll(`document.querySelector('${selector}')?.dataset.fraction === '0.4'`, 15000);
    const foreign = await read(); assert(foreign.label.includes('current step 12/30 (from log)'));
    assert.equal(foreign.outer, ''); assert.equal(foreign.dash, '0.5 1');
    check('workflow: other-client reason and log-derived current step share the single tooltip/aria label', true, foreign.label);
    await control({ running: [] });
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'idle'`, 15000);
    const idle = await read(); assert.equal(idle.fill, false); assert.equal(idle.track, false); assert.equal(idle.dash, undefined);
    check('workflow: authoritative idle removes both arcs without stale progress', true);
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await page.evaluate(`(async () => { const s = ${KZ}; if (s.state.hosts.workflow) await s.actions.hosts.remove('workflow'); })()`);
    await control({ reset: true });
  }
};
