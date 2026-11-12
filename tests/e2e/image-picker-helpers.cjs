// Drive the real acquisition surface; no synthetic mode/select compatibility.
exports.waitForInputPicker = cdp => cdp.poll("!!document.querySelector('.vz-input-popover.is-placed:popover-open:not([inert])')");
exports.openImageAdd = async (cdp, row = '.vz-image-set') => {
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(row + ' .vz-image-plus')}).getAttribute('aria-expanded')==='true'`))
    await cdp.clickAt(row + ' .vz-image-plus');
};
exports.openImageFolder = async (cdp, row = '.vz-image-set') => {
  await exports.openImageAdd(cdp, row);
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(row + ' .vz-folder-trigger')}).getAttribute('aria-expanded')==='true'`))
    await cdp.clickAt(row + ' .vz-folder-trigger');
};
exports.pickInput = async (cdp, name, row = '.vz-image-set') => {
  await exports.openImageAdd(cdp, row);
  await cdp.clickAt(row + ' .vz-input-trigger');
  await exports.waitForInputPicker(cdp);
  await cdp.poll("document.activeElement.matches('.vz-input-search') && getComputedStyle(document.querySelector('.vz-input-popover')).opacity === '1'");
  await cdp.evaluate("document.querySelector('.vz-input-search').select()");
  await cdp.send('Input.insertText', { text: name });
  const option = '.vz-input-option[data-input-name=' + JSON.stringify(name) + ']';
  await cdp.poll(`!!document.querySelector(${JSON.stringify(option)})`);
  await cdp.clickAt(option);
  await cdp.keyTrusted('Escape', { vk: 27 });
  await cdp.poll("!document.querySelector('.vz-input-search')");
};

// Native selected previews are viewport-owned. A field/acquisition interaction
// may have scrolled their sheet away; reveal the consumer before checking pixels.
exports.waitForSelectedPreviews = async cdp => {
  await cdp.evaluate("document.querySelector('.vz-image-grid').scrollIntoView({block:'center'})");
  await cdp.poll("[...document.querySelectorAll('.vz-image-tile img')].every(img=>img.complete&&img.naturalWidth>0)");
};

// Focus can settle before native scrolling reaches the virtualizer. Observe
// public row geometry against the existing idle policy, not an instantaneous
// option count or a private virtualizer/debug port.
exports.waitForIdleInputWindow = async (cdp, expectedName) => {
  const snapshot = `(async()=>{
    const {lookaheadBand,lookaheadRange}=await import('/features/variations/lookahead.js');
    const list=document.querySelector('.vz-input-list'),window=document.querySelector('.vz-input-window');
    const rows=[...document.querySelectorAll('.vz-input-row')],active=document.activeElement;
    const box=list.getBoundingClientRect(),target=active.getBoundingClientRect();
    const focus=active.dataset.inputName===${JSON.stringify(expectedName)};
    const visible=target.left>=box.left-1&&target.right<=box.right+1&&target.top>=box.top-1&&target.bottom<=box.bottom+1;
    const offsets=rows.map(row=>new DOMMatrixReadOnly(getComputedStyle(row).transform).m42).sort((a,b)=>a-b);
    const step=Math.min(...offsets.slice(1).map((offset,index)=>offset-offsets[index]));
    const columns=Math.max(...rows.map(row=>row.querySelectorAll('.vz-input-option').length));
    if(!Number.isFinite(step)||step<=0)return {ready:false,focus,visible};
    const gap=step-rows[0].getBoundingClientRect().height;
    const count=Math.round((window.getBoundingClientRect().height+gap)/step);
    const range={startIndex:Math.floor(list.scrollTop/step),endIndex:Math.min(count-1,Math.ceil((list.scrollTop+list.clientHeight)/step)-1),count};
    const expected=lookaheadRange(range,lookaheadBand(null,performance.now(),step,columns),columns);
    const actual=offsets.map(offset=>Math.round(offset/step));
    return {ready:JSON.stringify(actual)===JSON.stringify(expected),focus,visible,actual,expected,range,columns,step,scrollTop:list.scrollTop,mounted:document.querySelectorAll('.vz-input-option').length};
  })()`;
  try {
    const settled=await cdp.poll(`(async()=>{const state=await ${snapshot};if(!state.focus)throw new Error('Picker focus changed: '+JSON.stringify(state));return state.ready&&state.visible?state:null})()`,3000);
    console.log('SETTLED_INPUT_WINDOW',JSON.stringify(settled));
  } catch(error) {
    error.message+=' '+JSON.stringify(await cdp.evaluate(snapshot));throw error;
  }
};
