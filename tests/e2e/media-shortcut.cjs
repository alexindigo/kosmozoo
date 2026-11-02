// A declined media binding preserves the browser's native Space behavior.
const assert = require('node:assert/strict');
const { CDP, collectPageErrors } = require('./cdp.cjs');
(async () => {
  const page = await CDP.launch(Number(process.env.CDP_PORT || 19433));
  try {
    // Native page scrolling is a character-key default; rawKeyDown alone
    // (the widget helper) omits Chromium's keypress/character phase.
    const space = async () => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    };
    const errors = await collectPageErrors(page);
    await page.goto(process.env.E2E_ENGINE + '/');
    await page.poll("!!document.querySelector('.card')");
    await page.evaluate("document.querySelector('#hostBtn').focus()");
    await space();
    await page.poll("document.querySelector('#hostBtn').getAttribute('aria-expanded')==='true'");
    await space();
    await page.poll("document.querySelector('#hostDrop').hidden");
    await page.evaluate("(()=>{const col=document.querySelector('#candidatesCol');col.tabIndex=0;col.scrollTop=0;col.focus()})()");
    await space();
    await page.poll("document.querySelector('#candidatesCol').scrollTop>50");
    assert.deepEqual(errors, []);
    console.log('PASS: targetless Space activates a focused native button and scrolls the feed');
  } finally { await page.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
