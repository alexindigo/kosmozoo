const assert = require('node:assert/strict');
const fs = require('node:fs');
const { CDP, collectPageErrors } = require('./cdp.cjs');
const { addParameter } = require('./variation-add-helpers.cjs');

// Individual trusted key events, not a whole-value Input.insertText. Native
// field identity, focus and selection must survive both widget safety edges.
module.exports = async ({ cdp, KZ }) => {
  const evidence = [], failures = [];
  const row = '[data-param-key="9.steps"]';
  await cdp.evaluate(`(async()=>{await fetch('/api/collections/fake/entries/flux-basic.png/bytes');return ${KZ}.handles.invoke('variations.open',{id:'fake:flux-basic.png'})})()`);
  await addParameter(cdp, '9.steps');
  await cdp.evaluate(`(()=>{window.__numericKeys=[];document.addEventListener('keydown',e=>{if(/^\\d$/.test(e.key)||e.key==='Backspace')window.__numericKeys.push({key:e.key,trusted:e.isTrusted})})})()`);
  const digit = async key => {
    await cdp.send('Input.dispatchKeyEvent', { type:'keyDown', key, code:'Digit'+key, text:key, unmodifiedText:key, windowsVirtualKeyCode:48+Number(key), nativeVirtualKeyCode:48+Number(key) });
    await cdp.send('Input.dispatchKeyEvent', { type:'keyUp', key, code:'Digit'+key, windowsVirtualKeyCode:48+Number(key), nativeVirtualKeyCode:48+Number(key) });
  };
  for (const field of ['Step', 'From', 'To', 'Value']) {
    if (field === 'Value') await cdp.clickAt(row+' .mode-switch button[title="Value"]');
    const selector = row + (field==='Step' ? ' .vz-row-inc-input' : field==='Value' ? ' .vz-range-fields input' : ` .vz-range-fields label:nth-child(${field==='From'?1:2}) input`);
    await cdp.clickAt(selector);
    await cdp.evaluate(`(()=>{window.__numericField=document.querySelector(${JSON.stringify(selector)});window.__numericField.select()})()`);
    let expected = '';
    const observe = async key => {
      const state = await cdp.evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});return {same:input===window.__numericField,active:document.activeElement===input,connected:window.__numericField.isConnected,raw:input.value,start:input.selectionStart,end:input.selectionEnd,sliders:document.querySelectorAll('${row} [role=slider]').length}})()`);
      const item = { field, key, expected, ...state }; evidence.push(item);
      const safe = BigInt(expected) <= 9007199254740991n;
      if (!state.same || !state.active || !state.connected || state.raw !== expected || state.start !== expected.length || state.end !== expected.length || (state.sliders>0)!==safe) failures.push(item);
    };
    for (const key of '900719925474099234') { await digit(key); expected += key; await observe(key); }
    for (let i=0;i<3;i++) { await cdp.keyTrusted('Backspace',{vk:8}); expected=expected.slice(0,-1); await observe('Backspace'); }
    // Isolate each field even on the red tree: the failed case may still hold
    // unsafe text because its native input lost focus before Backspace.
    await cdp.clickAt(selector); await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`); await digit('1');
  }
  const keys = await cdp.evaluate('window.__numericKeys');
  fs.writeFileSync(process.env.E2E_EVIDENCE+'/numeric-focus.json',JSON.stringify({evidence,failures,keys},null,2));
  console.log('NUMERIC_FOCUS',JSON.stringify({observations:evidence.length,trustedKeys:keys.length,allTrusted:keys.every(key=>key.trusted),failures}));
  assert(keys.length===evidence.length+4 && keys.every(key=>key.trusted));
  assert.deepEqual(failures,[]);
  console.log('PASS Step/From/To/Value: same native node, active element, exact caret/raw after every digit and Backspace across safe/unsafe/safe boundaries');
};

if (require.main === module) (async()=>{
  const cdp=await CDP.launch(19454,{windowSize:'1600,1000'}),errors=await collectPageErrors(cdp);
  try { await cdp.goto(process.env.E2E_ENGINE); await cdp.poll('!!document.querySelector(".card")'); await module.exports({cdp,KZ:'(await import("/store/instance.js")).appStore'}); assert.deepEqual(errors,[]); }
  finally { await cdp.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
