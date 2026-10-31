// The actual viewer and numeric editor consume one mode-switch appearance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { workPath } = require('./paths.cjs');
const ENGINE = process.env.E2E_ENGINE ?? 'http://127.0.0.1:18260';
const KZ = '(await import("/store/instance.js")).appStore';

(async () => {
  const page = await CDP.launch(9362, { windowSize: '1600,1000' });
  const errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async () => ${KZ}.handles.invoke(${JSON.stringify(id)}, ${JSON.stringify(args)}))()`);
  const inspect = async selector => {
    await page.keyTrusted('Tab', { vk: 9 });
    return page.evaluate(`new Promise(resolve => requestAnimationFrame(() => {
      const group = document.querySelector(${JSON.stringify(selector)}), active = group.querySelector('[aria-pressed="true"]');
      active.focus();
      const style = getComputedStyle(group), button = getComputedStyle(active);
      resolve({ height: group.getBoundingClientRect().height, radius: style.borderRadius, background: style.backgroundColor,
        buttonHeight: active.getBoundingClientRect().height, buttonRadius: button.borderRadius, activeBackground: button.backgroundColor,
        focus: [button.outlineStyle, button.outlineWidth, button.outlineColor, button.outlineOffset],
        focused: active.matches(':focus-visible'), groupContract: group.matches('.viewer-group.mode-switch[role="group"][aria-label]'),
        buttonContract: [...group.querySelectorAll('button')].every(button => button.matches('.viewer-btn[type="button"][aria-pressed]') && button.classList.contains('on') === (button.getAttribute('aria-pressed') === 'true')),
        activeCount: group.querySelectorAll('[aria-pressed="true"]').length });
    }))`);
  };
  try {
    await page.goto(ENGINE + '/#fake#flux-controlnet.png');
    await page.poll('!!document.querySelector(".card")');
    await invoke('workbench.openPair', { left: { source: 'fake', file: 'flux-basic.png' }, right: { source: 'fake', file: 'flux-lora.png' } });
    await page.poll('!!document.querySelector("#diffModes .on")');
    const viewer = await inspect('#diffModes');
    await invoke('workbench.close');
    await page.evaluate("fetch('/api/collections/fake/entries/flux-controlnet.png/bytes').then(r => r.arrayBuffer()).then(() => true)");
    await invoke('variations.open', { id: 'fake:flux-controlnet.png' });
    const row = '[data-param-key="9.denoise"]';
    await page.poll(`!!document.querySelector('${row} .mode-switch')`);
    const range = await inspect(`${row} .mode-switch`);
    await page.clickAt(`${row} .mode-switch button:last-child`);
    await page.poll(`!!document.querySelector('${row} .vz-value-field input')`);
    const value = await inspect(`${row} .mode-switch`);
    await page.clickAt(`${row} .mode-switch button:first-child`);
    await page.poll(`document.querySelectorAll('${row} [role="slider"]').length === 2`);
    const restored = await inspect(`${row} .mode-switch`);
    const records = { viewer, range, value, restored, errors };
    fs.mkdirSync(workPath('artifacts'), { recursive: true });
    fs.writeFileSync(workPath('artifacts/mode-switch.json'), JSON.stringify(records, null, 2));
    console.log(JSON.stringify(records));
    for (const result of [viewer, range, value, restored]) {
      assert(result.groupContract && result.buttonContract && result.focused);
      assert.equal(result.activeCount, 1);
      assert.equal(result.focus[1], '2px');
    }
    assert.deepEqual(range, viewer);
    assert.deepEqual(value, viewer);
    assert.deepEqual(restored, viewer);
    assert.deepEqual(errors, []);
    console.log('PASS shared mode-switch height, radius, active background, focus ring, class contract and actual Range/Value transitions');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
