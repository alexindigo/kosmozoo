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
      fill: !!svg.querySelector('.source-progress-fill'), track: !!svg.querySelector('.source-progress-track'),
      count: svg.parentElement.querySelector('.source-queue-count')?.textContent ?? null,
      chipTitle: svg.parentElement.title, chipLabel: svg.parentElement.getAttribute('aria-label') };
  })()`);
  const geometry = () => page.evaluate(`(() => {
    const svg = document.querySelector('${selector}'), row = svg.parentElement, text = row.querySelector('.source-name');
    const rect = svg.getBoundingClientRect(), label = text.getBoundingClientRect();
    const count = row.querySelector('.source-queue-count'), cr = count?.getBoundingClientRect();
    const circles = [...svg.querySelectorAll('circle')].map(c => {
      const point = new DOMPoint(c.cx.baseVal.value, c.cy.baseVal.value).matrixTransform(c.getScreenCTM());
      return { x: point.x, y: point.y, radius: c.r.baseVal.value };
    });
    return { width: rect.width, height: rect.height, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      textY: label.y + label.height / 2, gap: label.left - rect.right, circles,
      chipWidth: row.getBoundingClientRect().width, countY: cr && cr.y + cr.height / 2,
      countGap: cr && rect.left - cr.right, numeric: count && getComputedStyle(count).fontVariantNumeric };
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
    assert.equal((await read()).count, null);
    check('workflow: idle has no outer arc or track', !(await read()).dash);
    await control({ running: [id], prompts: { [id]: { graph: data.graph, outputs: data.outputs } } });
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'running'`, 15000);
    await control({ messages: [state, step] });
    await page.poll(`document.querySelector('${selector}')?.dataset.workflowFraction === '0.6875'`);
    const known = await read();
    assert.equal(known.inner, '0.4375'); assert.equal(known.dash, '0.6875 1');
    assert.equal(known.unavailable, false); assert.equal(known.animation, 'none');
    assert.equal(known.label, 'workflow: workflow about 3 of 5 steps · current step 14/32 (live) · 1 in queue (1 running, 0 waiting)');
    assert.equal(known.title, known.label);
    assert.equal(known.count, '1');
    assert.equal(known.chipTitle, `Select workflow. ${known.label}`); assert.equal(known.chipLabel, known.chipTitle);
    check('workflow: recorded 14/32 reaches distinct inner sector and 3.4375/5 outer arc with approximate/live wording', true, JSON.stringify(known));
    for (const width of [1400, 900]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const g = await geometry();
      assert.equal(g.width, 24); assert.equal(g.height, 24); assert.equal(g.gap, 5);
      assert(Math.abs(g.y - g.textY) < .5);
      assert(Math.abs(g.y - g.countY) < .5); assert.equal(g.countGap, 5); assert.equal(g.numeric, 'tabular-nums');
      await control({ pending: Array.from({ length: 11 }, (_, i) => `waiting-${i}`) });
      await page.poll(`document.querySelector('${selector}').parentElement.querySelector('.source-queue-count')?.textContent === '12'`, 15000);
      const dozen = await geometry();
      assert(Math.abs(g.chipWidth - dozen.chipWidth) < .01, JSON.stringify({ one: g, dozen })); assert(Math.abs(dozen.y - dozen.countY) < .5);
      assert((await read()).label.endsWith('12 in queue (1 running, 11 waiting)'));
      await control({ pending: [] });
      await page.poll(`document.querySelector('${selector}').parentElement.querySelector('.source-queue-count')?.textContent === '1'`, 15000);
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
    assert.equal(lost.count, null); assert(!lost.chipTitle.includes('in queue'));
    check('workflow: delivery loss withholds both cached measures and queue count', true);
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await page.poll(`document.querySelector('${selector}')?.dataset.workflowFraction === '0.6875'`);
    await control({ closeSockets: true });
    await page.poll(`document.querySelector('${selector} .source-progress-workflow.unavailable') !== null`);
    const unavailable = await read();
    assert.equal(unavailable.count, '1');
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
    assert.equal(idle.count, null);
    check('workflow: authoritative idle removes both arcs without stale progress', true);
    await control({ pending: Array.from({ length: 12 }, (_, i) => `pending-${i}`) });
    await page.poll(`document.querySelector('${selector}').parentElement.querySelector('.source-queue-count')?.textContent === '12'`, 15000);
    assert.equal((await read()).state, 'idle'); assert.equal((await read()).track, false);
    check('queue count: pending-only queue shows 12 without a running arc', (await read()).label.endsWith('12 in queue (0 running, 12 waiting)'));
    await control({ failures: { queue: 503 } });
    await page.poll(`document.querySelector('${selector}')?.dataset.state === 'disconnected'`, 15000);
    assert.equal((await read()).count, null); assert(!(await read()).chipLabel.includes('in queue'));
    check('queue count: upstream failure hides cached pending jobs and their label', true);
    await control({ failures: {}, pending: Array.from({ length: 1000 }, (_, i) => `large-${i}`) });
    await page.poll(`document.querySelector('${selector}').parentElement.querySelector('.source-queue-count')?.textContent === '999+'`, 15000);
    assert((await read()).label.endsWith('1000 in queue (0 running, 1000 waiting)'));
    check('queue count: large queue caps only the visible text at 999+', true);
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await page.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))`);
    await page.evaluate(`(async () => { const s = ${KZ}; if (s.state.hosts.workflow) await s.actions.hosts.remove('workflow'); })()`);
    await control({ reset: true });
  }
};
