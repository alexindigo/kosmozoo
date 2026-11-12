const assert = require('node:assert/strict');
const { waitForIdleInputWindow } = require('./image-picker-helpers.cjs');

// Exercise the test driver's real geometry poll with deliberately delayed
// visibility, independently of the timing of any particular native scroll.
module.exports = async ({ cdp, check }) => {
  const mount = async mode => {
    await cdp.evaluate(`(()=>{
      const host=document.createElement('div');host.id='picker-idle-contract';host.popover='manual';
      host.style.cssText='position:fixed;inset:0 auto auto 0;margin:0;padding:0;border:0;width:100px;height:40px';
      host.innerHTML='<div class="vz-input-list" style="position:relative;width:100px;height:40px;overflow:hidden"><div class="vz-input-window" style="position:relative;height:400px;width:100px"></div></div>';
      const window=host.querySelector('.vz-input-window');
      for(let i=0;i<17;i++){
        const row=document.createElement('div');row.className='vz-input-row';
        row.style.cssText='position:absolute;top:0;left:0;width:100px;height:20px;transform:translateY('+i*20+'px)';
        const button=document.createElement('button');button.className='vz-input-option';button.dataset.inputName='fixture-'+i;
        button.style.cssText='position:relative;top:'+(i===0?60:0)+'px;width:80px;height:20px;aspect-ratio:auto;padding:0;border:0';
        row.append(button);window.append(row);
      }
      document.body.append(host);host.showPopover();const button=host.querySelector('button');button.focus({preventScroll:true});
      if(${JSON.stringify(mode)}==='settle')setTimeout(()=>{button.style.top='0px'},200);
      if(${JSON.stringify(mode)}==='lost')setTimeout(()=>button.blur(),100);
    })()`);
  };
  const unmount = () => cdp.evaluate("document.getElementById('picker-idle-contract')?.remove()");
  try {
    await mount('settle');
    await waitForIdleInputWindow(cdp, 'fixture-0');
    await unmount();
    await mount('lost');
    await assert.rejects(waitForIdleInputWindow(cdp, 'fixture-0'), /Picker focus changed/);
    await unmount();
    await mount('hidden');
    await assert.rejects(waitForIdleInputWindow(cdp, 'fixture-0'), /poll timeout/);
    check('picker settlement waits for visibility but still rejects lost focus and timeout', true);
  } finally { await unmount(); }
};
