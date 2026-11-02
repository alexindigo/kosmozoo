// One visual contract for every toolbar/docked button, including image-only
// difference controls. Probe presentation states without firing their actions.
module.exports = async ({ page, KZ, check, capture, control }) => {
  const video = 'viewer-buttons.webm';
  const invoke = (command, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}))()`);
  const problems = [];
  let buttons = 0;
  const inspect = async () => {
    const count = await page.evaluate(`(() => {
      window.__viewerButtons = [...document.querySelectorAll('#diffBar button, #diffMedia button, #diffClose')];
      return window.__viewerButtons.length;
    })()`);
    const style = index => page.evaluate(`(() => {
      const b = window.__viewerButtons[${index}], s = getComputedStyle(b);
      return { color: s.color, background: s.backgroundColor };
    })()`);
    const hover = async index => {
      const p = await page.evaluate(`(() => { const r = window.__viewerButtons[${index}].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await page.mouse('mouseMoved', p.x, p.y);
      try { await page.poll(`window.__viewerButtons[${index}].matches(':hover')`); }
      catch (error) {
        throw new Error(`hover ${index}: ${JSON.stringify(await page.evaluate(`(() => { const b = window.__viewerButtons[${index}], r = b.getBoundingClientRect(); return { button: b.outerHTML, connected: b.isConnected, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, hit: document.elementFromPoint(${p.x}, ${p.y})?.outerHTML.slice(0, 300), viewport: [innerWidth, innerHeight] }; })()`))}`);
      }
    };
    const reference = await page.evaluate(`window.__viewerButtons.findIndex(b => b.closest('#diffModes'))`);
    if (reference < 0 || count < 10) throw new Error('viewer button coverage missing');
    const samples = [];
    for (let i = 0; i < count; i++) {
      const saved = await page.evaluate(`(() => {
        const b = window.__viewerButtons[${i}], saved = { cls: b.className, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled };
        b.disabled = false; b.classList.remove('on'); b.setAttribute('aria-pressed', 'false');
        return saved;
      })()`);
      try {
        await page.mouse('mouseMoved', 1, 1);
        await page.poll(`!window.__viewerButtons[${i}].matches(':hover')`);
        const base = await style(i);
        await hover(i);
        const hovered = await style(i);
        await page.evaluate(`window.__viewerButtons[${i}].classList.add('on')`);
        const onHovered = await style(i);
        await page.mouse('mouseMoved', 1, 1);
        await page.poll(`!window.__viewerButtons[${i}].matches(':hover')`);
        const on = await style(i);
        await page.evaluate(`(() => { const b = window.__viewerButtons[${i}]; b.classList.remove('on'); b.setAttribute('aria-pressed', 'true'); })()`);
        const pressed = await style(i);
        const shape = await page.evaluate(`(() => { const b = window.__viewerButtons[${i}], s = getComputedStyle(b); return { height: s.height, radius: s.borderRadius, shared: b.classList.contains('viewer-btn'), name: b.title }; })()`);
        samples.push({ base, hovered, on, onHovered, pressed, shape });
      } finally {
        await page.evaluate(`(() => { const b = window.__viewerButtons[${i}], saved = ${JSON.stringify(saved)};
          b.className = saved.cls; b.disabled = saved.disabled;
          if (saved.pressed === null) b.removeAttribute('aria-pressed'); else b.setAttribute('aria-pressed', saved.pressed);
        })()`);
      }
    }
    const ref = samples[reference];
    for (const s of samples) {
      for (const state of ['base', 'hovered', 'on', 'onHovered', 'pressed']) {
        if (JSON.stringify(s[state]) !== JSON.stringify(ref[state])) problems.push(`${s.shape.name}: ${state} ${JSON.stringify(s[state])} != ${JSON.stringify(ref[state])}`);
      }
      if (!s.shape.shared || s.shape.height !== '26px' || s.shape.radius !== '999px') problems.push(`${s.shape.name}: shape ${JSON.stringify(s.shape)}`);
    }
    // The reference must itself retain the approved token contract; comparing
    // every button to a uniformly broken reference would otherwise pass.
    const tokens = await page.evaluate(`(() => { const p = document.createElement('span'); document.body.append(p);
      const color = token => { p.style.color = 'var(' + token + ')'; return getComputedStyle(p).color; };
      const out = { dim: color('--foreground-dim'), foreground: color('--foreground'), secondary: color('--secondary'), black: color('--black') }; p.remove(); return out;
    })()`);
    if (ref.base.color !== tokens.dim || ref.base.background !== 'rgba(0, 0, 0, 0)' || ref.hovered.color !== tokens.foreground || ref.hovered.background !== ref.base.background || ref.on.color !== tokens.black || ref.on.background !== tokens.secondary || JSON.stringify(ref.onHovered) !== JSON.stringify(ref.on) || JSON.stringify(ref.pressed) !== JSON.stringify(ref.on)) problems.push(`mode switcher token contract: ${JSON.stringify({ ref, tokens })}`);
    buttons += count;
  };
  try {
    await control({ publish: [{ name: video, fixture: 'media/workflow.webm', mtime: 2100000100 }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`(async () => { const s = ${KZ}; s.actions.diff.close(); s.actions.ui.setFilter(''); s.actions.folders.select(''); await s.actions.hosts.select('fake'); await s.actions.ui.refresh(); })()`);
    await invoke('workbench.openPair', { left: { source: 'fake', file: video }, right: { source: 'fake', file: 'flux-basic.png' } });
    await invoke('workbench.mode', { mode: 'two-up' });
    await page.poll(`document.querySelector('.dz-a video')?.readyState >= 2 && document.querySelector('#diffMedia .media-loop')`);
    await inspect();
    // Image-only buttons belong to the same contract, though they cannot be
    // rendered in a video comparison (Difference is intentionally unavailable).
    await invoke('workbench.openPair', { left: { source: 'fake', file: 'flux-basic.png' }, right: { source: 'fake', file: 'flux-lora.png' } });
    await invoke('workbench.mode', { mode: 'difference' });
    await page.poll(`document.querySelector('.dz-threshold') && document.querySelector('.dz-mask-op') && document.querySelector('.dz-a img')?.naturalWidth > 0 && !document.querySelector('#diffMedia button')`);
    await inspect();
    await invoke('workbench.openPair', { left: { source: 'fake', file: video }, right: { source: 'fake', file: 'flux-basic.png' } });
    await page.poll(`document.querySelector('.dz-a video')?.readyState >= 2 && document.querySelector('#diffMedia .media-loop')`);
    await page.clickAt('#diffMedia .media-loop');
    await page.poll(`document.querySelector('#diffMedia .media-loop').getAttribute('aria-pressed') === 'true'`);
    const p = await page.evaluate(`(() => { const r = document.querySelector('#diffMedia .media-mute').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.mouse('mouseMoved', p.x, p.y);
    await page.poll(`document.querySelector('#diffMedia .media-mute').matches(':hover')`);
    await capture(page, 'viewer-buttons');
    check('every viewer toolbar/video button shares mode-switcher base, hover and on styles', problems.length === 0, `${buttons} buttons × 5 states; ${problems.join('; ')}`);
  } finally {
    await invoke('workbench.close');
    await page.evaluate(`delete window.__viewerButtons`);
    await control({ remove: [video] });
    await page.evaluate(`(async () => ${KZ}.actions.ui.refresh())()`);
  }
};
