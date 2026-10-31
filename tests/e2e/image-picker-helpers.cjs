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
