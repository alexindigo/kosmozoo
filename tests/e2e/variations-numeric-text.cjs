// Raw numeric text must govern both the visible plan and the terminal prompts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { freshRecipe } = require('./recipe-helpers.cjs');
module.exports = async ({ cdp, check, KZ, FAKE }) => {
  const denoise = '[data-param-key="9.denoise"]', steps = '[data-param-key="9.steps"]';
  const invoke = (id, args = {}) => cdp.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  const field = async (selector, text) => {
    await cdp.clickAt(selector);
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await cdp.send('Input.insertText', { text });
    await cdp.keyTrusted('Tab', { vk: 9 });
    await cdp.poll(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`);
  };
  const jobs = async () => (await (await fetch(FAKE + '/__test/enqueues')).json());
  const close = async () => {
    if (!await cdp.evaluate("!!document.querySelector('.vz-panel')")) return;
    await cdp.clickAt('.vz-close');
    if (await cdp.evaluate("!!document.querySelector('.vz-discard')")) await cdp.clickAt('.vz-discard-confirm');
    await cdp.poll("!document.querySelector('.vz-panel')");
  };
  const invalid = async (row, label) => {
    const state = await cdp.evaluate(`(()=>{const row=document.querySelector(${JSON.stringify(row)});return {
      header:row.querySelector('.vz-parameter-current').textContent,
      count:document.querySelector('.vz-count').textContent,
      sidebar:document.querySelector('.vz-right').innerText,
      messages:document.querySelector('.vz-messages').textContent,
      runDisabled:document.querySelector('.vz-run').disabled}})()`);
    console.log('numeric invalid state:', JSON.stringify(state));
    // Keep collecting consumer evidence on the baseline even when its UI is stale.
    const before = (await jobs()).length;
    const result = await invoke('variations.run');
    const received = (await jobs()).slice(before);
    console.log('numeric invalid Run:', JSON.stringify({ result, received }));
    check(`${label}: header/sidebar invalid; Run rejects with zero prompts`,
      state.header === '— values' && state.count === '—' && state.sidebar.includes('Check the recipe') &&
      state.messages.includes(label) && !state.runDisabled && result.status === 'invalid' && received.length === 0);
  };
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  try {
    await cdp.evaluate("fetch('/api/collections/fake/entries/flux-basic.png/bytes').then(r=>r.arrayBuffer()).then(()=>true)");
    await invoke('variations.open', { id: 'fake:flux-basic.png' });
    await cdp.poll(`!!document.querySelector('${denoise} .vz-numeric-editor')`);
    await freshRecipe(cdp);
    await fetch(FAKE + '/__test/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ captureEnqueue: true }) });
    await field(`${denoise} .vz-range-field:first-child input`, '');
    if (process.env.E2E_BLANK_NUMBER_SHOT) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.E2E_BLANK_NUMBER_SHOT, Buffer.from(shot.data, 'base64'));
    }
    await invalid(denoise, 'From');
    await field(`${denoise} .vz-range-field:first-child input`, '0.9');
    await cdp.poll("document.querySelector('.vz-count').textContent==='2'");
    assert.equal(await cdp.evaluate(`document.querySelector('${denoise} .vz-parameter-current').textContent`), '3 values');
    let before = (await jobs()).length;
    assert.equal((await invoke('variations.run')).adopted, true);
    let received = (await jobs()).slice(before);
    assert.deepEqual(received.map(job => job.prompt['9'].inputs.denoise), [.9, .95]);
    check('From: valid re-entry restores counts and prompts exactly match visible bounds/Step', true);
    // A fresh recipe prevents an accepted run's close timer or result from
    // masking the readiness message in the second scenario.
    await freshRecipe(cdp);
    await cdp.clickAt(`${denoise} .checkbox`);
    await cdp.clickAt(`${steps} .checkbox`);
    await cdp.clickAt(`${steps} .mode-switch button[title="Value"]`);
    await field(`${steps} .vz-value-field input`, '21');
    await field(`${steps} .vz-value-field input`, '');
    await invalid(steps, 'Value');
    await field(`${steps} .vz-value-field input`, '22');
    await cdp.poll("document.querySelector('.vz-count').textContent==='1'");
    assert.equal(await cdp.evaluate(`document.querySelector('${steps} .vz-parameter-current').textContent`), '1 value');
    before = (await jobs()).length;
    assert.equal((await invoke('variations.run')).adopted, true);
    received = (await jobs()).slice(before);
    assert.deepEqual(received.map(job => job.prompt['9'].inputs.steps), [22]);
    check('Value: valid re-entry restores counts and only visible 22 reaches the fake engine', true);
  } finally { await close(); await cdp.send('Emulation.clearDeviceMetricsOverride'); }
};
