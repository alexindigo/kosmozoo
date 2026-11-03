const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const KZ = '(await import("/store/instance.js")).appStore';
(async () => {
  const page = await CDP.launch(9367, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const problems = [], records = [];
  const inspect = async (value) => {
    await page.poll(`(async () => !${KZ}.state.inventory.loading && !!document.querySelector('#outputFolder'))()`);
    const result = await page.evaluate(`(() => {
      const select = document.querySelector('#outputFolder'), face = select.parentElement.querySelector('.select-face');
      const label = face?.querySelector('.single-line-text'), slot = face?.querySelector('.select-icon-slot');
      const icon = slot?.querySelector('svg'), b = slot?.getBoundingClientRect(), g = icon?.getBoundingClientRect();
      const outer = select.getBoundingClientRect(), style = label && getComputedStyle(label);
      return { value: select.value, title: select.title, aria: select.getAttribute('aria-label'), text: face?.textContent.trim(),
        chevron: !!select.parentElement.querySelector('.chevron-slot'), width: outer.width, height: outer.height,
        gaps: g && [g.left - outer.left, outer.bottom - g.bottom, g.top - outer.top],
        centered: b && g && [g.left-b.left,b.right-g.right,g.top-b.top,b.bottom-g.bottom],
        label: label && { text: label.textContent, width: label.clientWidth, scroll: label.scrollWidth, whiteSpace: style.whiteSpace, overflow: style.textOverflow } };
    })()`);
    records.push(result);
    const title = value || 'Output root (all subfolders)';
    if (result.value !== value || result.title !== title || result.aria !== title) problems.push('full selected path: ' + JSON.stringify(result));
    if (!result.centered || Math.max(...result.centered) - Math.min(...result.centered) > 1 || Math.max(...result.gaps) - Math.min(...result.gaps) > 1) problems.push('unequal folder icon gaps: ' + JSON.stringify(result));
    if (!value && (result.text !== '' || result.chevron || Math.abs(result.width-result.height)>1)) problems.push('default must be a square icon-only face: ' + JSON.stringify(result));
    if (value && (result.text !== value.split('/').at(-1) || !result.chevron || result.label?.whiteSpace !== 'nowrap' || result.label?.overflow !== 'ellipsis' || result.label?.scroll <= result.label?.width)) problems.push('nested leaf must truncate on one line: ' + JSON.stringify(result));
  };
  const capture = async (state) => {
    await page.evaluate('document.activeElement?.blur()');
    for (const focus of [false, true]) {
      if (focus) {
        await page.keyTrusted('Tab', { code: 'Tab', vk: 9 });
        await page.evaluate("document.querySelector('#outputFolder').focus()");
      }
      await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const name = `folder-face-${state}-${focus ? 'focused' : 'unfocused'}`;
      const image = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(workPath(`artifacts/${name}.png`), Buffer.from(image.data, 'base64'));
      const rect = await page.evaluate("(() => { const r=document.querySelector('#outputFolder').getBoundingClientRect();return {x:r.x-4,y:r.y-4,width:r.width+8,height:r.height+8,scale:2}; })()");
      const crop = await page.send('Page.captureScreenshot', { format: 'png', clip: rect });
      fs.writeFileSync(workPath(`artifacts/${name}-2x.png`), Buffer.from(crop.data, 'base64'));
    }
  };
  try {
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    await page.goto(ENGINE + '/?folder=#fake');
    await inspect(''); await capture('default');
    const nested = 'folder-face/this-is-a-very-long-nested-folder-name';
    await page.goto(ENGINE + '/?folder=' + encodeURIComponent(nested) + '#fake');
    await inspect(nested); await capture('nested');
    await page.evaluate("document.querySelector('#outputFolder').focus()");
    await page.keyTrusted('Home', { code: 'Home', vk: 36 });
    await page.keyTrusted('Enter', { code: 'Enter', vk: 13 });
    await page.poll(`(async () => ${KZ}.state.selectedFolder() === '' && document.querySelector('#outputFolder').value === '')()`);
    if (errors.length) problems.push('page errors: ' + JSON.stringify(errors));
    fs.writeFileSync(workPath('artifacts/folder-face.json'), JSON.stringify({ records, problems, errors }, null, 2));
    problems.forEach(p => console.error('FAIL ' + p));
    console.log(`folder face: ${records.length} states, native keyboard selection, ${problems.length} failures`);
    if (problems.length) process.exitCode = 1;
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
