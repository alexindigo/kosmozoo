// Explicit test setup: add only the parameters used by the scenario.
async function addParameter(cdp, id) {
  const catalogue = `[data-catalogue-id="${id}"]`;
  await cdp.poll(`!!document.querySelector(${JSON.stringify(catalogue)})`);
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`)) {
    await cdp.evaluate(`document.querySelector('.vz-field-filter').value`);
    await cdp.clickAt(`${catalogue} .vz-catalogue-add`);
  }
  await cdp.poll(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`);
}
async function toggleParameter(cdp, id) {
  const selector = `[data-param-key="${id}"] .vz-parameter-remove, [data-image-id="${id}"] .vz-parameter-remove, [data-enum-id="${id}"] .vz-parameter-remove, [data-text-id="${id}"] .vz-parameter-remove, [data-candidate-id="${id}"] .vz-parameter-remove`;
  if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) await cdp.clickAt(selector);
  else await addParameter(cdp, id);
}
// Explicit opt-in for acquisition/empty-set scenarios. Exercise the ordinary
// removable reference through the same native button a user presses.
async function removeRecordedImage(cdp, id) {
  const row = `[data-image-id="${id}"]`, tile = `${row} [data-image-kind="reference"]`;
  await cdp.poll(`!!document.querySelector(${JSON.stringify(tile)})`);
  await cdp.clickAt(`${tile} .vz-image-remove button`);
  await cdp.poll(`!document.querySelector(${JSON.stringify(tile)})`);
}
module.exports = { addParameter, toggleParameter, removeRecordedImage };
