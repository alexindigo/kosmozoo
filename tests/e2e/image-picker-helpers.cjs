// Drive the real acquisition surface; no synthetic mode/select compatibility.
exports.pickInput = async (cdp, name, row = '.vz-image-set') => {
  await cdp.clickAt(row + ' .vz-input-trigger');
  await cdp.poll("!!document.querySelector('.vz-input-search')");
  await cdp.evaluate("document.querySelector('.vz-input-search').select()");
  await cdp.send('Input.insertText', { text: name });
  const option = '.vz-input-option[data-input-name=' + JSON.stringify(name) + ']';
  await cdp.poll(`!!document.querySelector(${JSON.stringify(option)})`);
  await cdp.clickAt(option);
  await cdp.keyTrusted('Escape', { vk: 27 });
  await cdp.poll("!document.querySelector('.vz-input-search')");
};
