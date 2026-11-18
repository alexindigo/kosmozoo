// Copying a card's file name over plain HTTP from another computer, where the
// browser offers no Clipboard API. E2E_INSECURE_ENGINE is the same engine at a
// non-loopback address; E2E_ENGINE is its secure loopback address, used only to
// read the clipboard back and to check the Clipboard API path.
//
// Standalone spec, not part of tests/e2e/run.sh: it needs the engine bound to a
// non-loopback address. Run it like run-on.cjs, with the engine on 0.0.0.0, e.g.
// E2E_ENGINE=http://127.0.0.1:19490 E2E_INSECURE_ENGINE=http://<host-ip>:19490.
const assert = require('node:assert/strict');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const ENGINE = process.env.E2E_ENGINE, INSECURE = process.env.E2E_INSECURE_ENGINE;
const KZ = `(await import('/store/instance.js')).appStore`;
const name = 'flux-basic.png';
const selector = `.card[data-name=${JSON.stringify(name)}] .copyable`;

(async () => {
  assert(ENGINE && INSECURE, 'clipboard-insecure needs E2E_ENGINE and E2E_INSECURE_ENGINE');
  const page = await CDP.launch(9398, { windowSize: '1440,1000' });
  try {
    const errors = await collectPageErrors(page);
    const invoke = (id, args = {}) => page.evaluate(`(async()=>${KZ}.handles.invoke(${JSON.stringify(id)},${JSON.stringify(args)}))()`);
    const copyErrors = () => page.evaluate(`(async()=>${KZ}.state.chips.filter(chip=>chip.kind==='error'&&chip.msg.startsWith("Couldn't copy")).map(chip=>chip.slot))()`);
    const openCard = async origin => {
      await page.goto(origin + '/#fake#' + name);
      await page.poll(`(async()=>${KZ}.state.images.some(image=>image.filename===${JSON.stringify(name)}))()`, 30000);
      await invoke('feed.filter', { value: name });
      await page.poll(`!!document.querySelector(${JSON.stringify(selector)})`, 30000);
    };
    // The 800 ms flash is recorded by the page itself, so a slow driver cannot miss it.
    const clickAndSeeFlash = async () => {
      await page.evaluate(`(()=>{window.__copied=false;const el=document.querySelector(${JSON.stringify(selector)});new MutationObserver(()=>{if(el.classList.contains('copied'))window.__copied=true}).observe(el,{attributes:true,attributeFilter:['class']});return true})()`);
      await page.clickAt(selector);
      await page.poll(`window.__copied===true`, 5000);
    };

    await page.goto(ENGINE + '/');
    await page.send('Browser.grantPermissions', { origin: ENGINE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    await page.send('Page.bringToFront');
    await page.evaluate(`navigator.clipboard.writeText('awaiting-copy')`);

    await openCard(INSECURE);
    assert.deepEqual(await page.evaluate(`({secure:window.isSecureContext,api:!!navigator.clipboard})`), { secure: false, api: false }, 'a plain-HTTP network origin has no Clipboard API');
    const expected = await page.evaluate(`(async()=>{const s=${KZ};return s.state.referenceName(s.state.images.find(image=>image.filename===${JSON.stringify(name)}))})()`);
    const errorsBefore = await copyErrors();
    await clickAndSeeFlash();
    assert.equal(await page.evaluate(`document.querySelectorAll('.clipboard-buffer').length`), 0, 'the copy buffer is removed');
    assert.deepEqual(await copyErrors(), errorsBefore, 'no new copy error');

    // A keyboard-made backward selection survives a copy with its direction.
    const selection = `(()=>{const s=getSelection();return {anchor:s.anchorNode?.textContent,anchorOffset:s.anchorOffset,focus:s.focusNode?.textContent,focusOffset:s.focusOffset}})()`;
    const before = await page.evaluate(`(()=>{const t=document.querySelector(${JSON.stringify(selector)}).firstChild??document.querySelector(${JSON.stringify(selector)});const node=t.nodeType===3?t:t.firstChild;getSelection().setBaseAndExtent(node,6,node,2);return true})()`)
      && await page.evaluate(selection);
    const viaKeyboard = await page.send('Runtime.evaluate', { expression: `(async()=>${KZ}.handles.invoke('entry.copyReference',{id:${JSON.stringify(`fake:${name}`)}}))()`, awaitPromise: true, returnByValue: true, userGesture: true });
    assert.equal(viaKeyboard.result.value, true, 'copy through the command reports success');
    assert.deepEqual(await page.evaluate(selection), before, 'selection anchor, focus and direction are restored');

    await page.goto(ENGINE + '/');
    await page.send('Page.bringToFront');
    await page.poll(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(expected)})()`, 10000);

    // The secure origin keeps using the Clipboard API.
    await page.evaluate(`navigator.clipboard.writeText('awaiting-secure-copy')`);
    await openCard(ENGINE);
    assert.equal(await page.evaluate(`window.isSecureContext&&!!navigator.clipboard`), true);
    await clickAndSeeFlash();
    await page.poll(`(async()=>await navigator.clipboard.readText()===${JSON.stringify(expected)})()`, 10000);
    assert.deepEqual(errors, []);
    console.log(`clipboard-insecure: ok (${expected})`);
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
