// Copying a card's file name over plain HTTP from another computer, where the
// browser offers no Clipboard API. E2E_INSECURE_ENGINE is the same engine at a
// non-loopback address; E2E_ENGINE is its secure loopback address, used only to
// read the clipboard back.
const assert = require('node:assert/strict');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE, INSECURE = process.env.E2E_INSECURE_ENGINE;
const KZ = `(await import('/store/instance.js')).appStore`;
const name = 'flux-basic.png';

(async () => {
  assert(ENGINE && INSECURE, 'clipboard-insecure needs E2E_ENGINE and E2E_INSECURE_ENGINE');
  const page = await CDP.launch(9398, { windowSize: '1440,1000' }), errors = await collectPageErrors(page);
  const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
  try {
    await page.goto(ENGINE + '/');
    await page.send('Browser.grantPermissions', { origin: ENGINE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Page.bringToFront');
    await page.evaluate(`navigator.clipboard.writeText('awaiting-copy')`);

    await page.goto(INSECURE + '/#fake#' + name);
    assert.deepEqual(await page.evaluate(`({secure:window.isSecureContext,api:!!navigator.clipboard})`), { secure: false, api: false }, 'a plain-HTTP network origin has no Clipboard API');
    await page.poll(`(async()=>${KZ}.state.images.some(image=>image.filename===${JSON.stringify(name)}))()`, 30000);
    await invoke('feed.filter', { value: name });
    const selector = `.card[data-name=${JSON.stringify(name)}] .copyable`;
    await page.poll(`!!document.querySelector(${JSON.stringify(selector)})`, 30000);
    const expected = await page.evaluate(`(async()=>{const s=${KZ};return s.state.referenceName(s.state.images.find(image=>image.filename===${JSON.stringify(name)}))})()`);
    const before = await page.evaluate(`(async()=>${KZ}.state.chips.length)()`);
    await page.clickAt(selector);
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).classList.contains('copied')`, 5000);
    assert.equal(await page.evaluate(`document.querySelectorAll('.clipboard-buffer').length`), 0, 'the copy buffer is removed');
    assert.equal(await page.evaluate(`(async()=>${KZ}.state.chips.filter(chip=>chip.kind==='error').length)()`), 0, 'no copy error');
    assert(await page.evaluate(`(async()=>${KZ}.state.chips.length)()`) <= before + 1);

    await page.goto(ENGINE + '/');
    await page.send('Page.bringToFront');
    await page.poll(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(expected)})()`, 10000);

    // The secure origin keeps using the Clipboard API.
    await page.evaluate(`navigator.clipboard.writeText('awaiting-secure-copy')`);
    await page.goto(ENGINE + '/#fake#' + name);
    await page.poll(`(async()=>${KZ}.state.images.some(image=>image.filename===${JSON.stringify(name)}))()`, 30000);
    await invoke('feed.filter', { value: name });
    await page.poll(`!!document.querySelector(${JSON.stringify(selector)})`, 30000);
    assert.equal(await page.evaluate(`window.isSecureContext&&!!navigator.clipboard`), true);
    await page.clickAt(selector);
    await page.poll(`document.querySelector(${JSON.stringify(selector)}).classList.contains('copied')`, 5000);
    await page.poll(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(expected)})()`, 10000);
    assert.deepEqual(errors, []);
    console.log(`clipboard-insecure: ok (${expected})`);
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
