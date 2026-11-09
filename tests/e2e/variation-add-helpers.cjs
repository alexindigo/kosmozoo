// Explicit test setup: add only the parameters used by the scenario.
async function addParameter(cdp, id) {
  const catalogue = `[data-catalogue-id="${id}"]`;
  await cdp.poll(`!!document.querySelector(${JSON.stringify(catalogue)})`);
  if (!await cdp.evaluate(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`)) {
    await cdp.evaluate(`document.querySelector('.vz-field-filter').value`);
    await cdp.clickAt(`${catalogue} button`);
  }
  await cdp.poll(`document.querySelector(${JSON.stringify(catalogue)}).classList.contains('vz-catalogue-hidden')`);
}
async function toggleParameter(cdp, id) {
  const selector = `[data-param-key="${id}"] .vz-parameter-heading > input, [data-image-id="${id}"] .vz-parameter-heading > input, [data-enum-id="${id}"] .vz-parameter-heading > input, [data-text-id="${id}"] .vz-parameter-heading > input, [data-candidate-id="${id}"] .vz-parameter-heading > input`;
  if (await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) await cdp.clickAt(selector);
  else await addParameter(cdp, id);
}
module.exports = { addParameter, toggleParameter };
